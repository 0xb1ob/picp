/**
 * awaiting_merge PR3: one home-wide, non-overlapping sweep over every parked PR — batched GraphQL (~25 PRs a query),
 * rate-limit aware, one page per connection per sweep — then each observation goes through `applyExit`. Cursors
 * advance only after the apply succeeded. Dormant here: the timer that calls `sweep` is wired later (PR6).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AwaitingMergeWatchFile, type FleetRecord, isoTimestamp, LAYOUT, type ParkedPrWatch, validateAwaitingMergeWatchFile } from "./contracts.ts";
import { applyExit, type ExitOutcome, type ExitPorts, type HumanEvent, type PrSnapshot } from "./awaiting-merge-exits.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { StackFollowups } from "./stack-followups.ts";

export const WATCH_BATCH_SIZE = 25;
const PAGE = 50;
/** Below this many points left, the sweep stops and waits for the reset. */
const RATE_FLOOR = 200;
const BACKOFF_MAX_MS = 60 * 60_000;

/** Runs one GraphQL query; resolves with the parsed body (partial `errors` included) or rejects when there is none. */
export type GraphqlRunner = (query: string) => Promise<unknown>;

export const ghGraphql: GraphqlRunner = (query) =>
	new Promise((resolve, reject) => {
		execFile("gh", ["api", "graphql", "-f", `query=${query}`], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			// gh exits non-zero on partial GraphQL errors but still prints the body: keep the PRs that did answer.
			try {
				resolve(JSON.parse(stdout.toString()));
			} catch {
				reject(new Error(`gh api graphql failed: ${(stderr.toString() || error?.message || "no output").trim().slice(0, 300)}`));
			}
		});
	});

export interface SweepResult {
	skipped?: string;
	observed: number;
	outcomes: ExitOutcome[];
	errors: string[];
	/** Jobs with another page still unread on some connection: the next sweep continues from the cursor. */
	catching_up: string[];
	backoff_until?: string;
}

export interface WatchOptions extends ExitPorts {
	home: string;
	stackEdges?: Pick<StackFollowups, "recordEdges">;
	runner?: GraphqlRunner;
	/** Logins of this home's own accounts: their comments are CP activity, never a human event. */
	cpLogins?: readonly string[];
	batchSize?: number;
}

export function readWatchFile(home: string): AwaitingMergeWatchFile {
	const file = join(home, LAYOUT.awaitingMergeWatchFile);
	if (!existsSync(file)) return { schema_version: 1, updated_at: isoTimestamp(new Date(0)), prs: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not readable JSON: ${(error as Error).message}`);
	}
	const parsed = validateAwaitingMergeWatchFile(raw);
	if (!parsed.ok) throw new Error(`${file} is not a valid awaiting-merge watch file: ${parsed.errors.join("; ")}`);
	return parsed.value;
}

interface Target { record: FleetRecord; owner: string; name: string; number: number; branch: string; prior?: ParkedPrWatch }

export class AwaitingMergeWatch {
	readonly #options: WatchOptions;
	#running = false;
	#failures = 0;

	constructor(options: WatchOptions) {
		this.#options = options;
	}

	async sweep(): Promise<SweepResult> {
		const empty: SweepResult = { observed: 0, outcomes: [], errors: [], catching_up: [] };
		if (this.#running) return { ...empty, skipped: "a sweep is already running" };
		this.#running = true;
		try {
			return await this.#sweep(empty);
		} finally {
			this.#running = false;
		}
	}

	async #sweep(result: SweepResult): Promise<SweepResult> {
		const now = this.#now();
		const file = readWatchFile(this.#options.home);
		if (file.backoff_until && Date.parse(file.backoff_until) > now.getTime()) return { ...result, skipped: `backing off until ${file.backoff_until}`, backoff_until: file.backoff_until };
		const jobs = this.#options.fleet.read().jobs;
		const parked = jobs.filter((job) => job.phase === "awaiting_merge" && job.awaiting_merge);
		const live = jobs.filter((job) => job.phase !== "awaiting_merge" && job.phase !== "done");
		// A re-park starts a new cycle: its cursors start over, and jobs no longer parked drop out.
		file.prs = file.prs.filter((pr) => parked.some((job) => job.job_id === pr.job_id && job.awaiting_merge!.cycle === pr.cycle));
		const targets: Target[] = [];
		for (const record of parked) {
			const [owner, name] = record.awaiting_merge!.repo.split("/");
			const number = Number(/\/pull\/(\d+)$/.exec(record.awaiting_merge!.pr_url)?.[1]);
			if (!owner || !name || !Number.isInteger(number)) {
				result.errors.push(`${record.job_id}: ${record.awaiting_merge!.pr_url} is not a GitHub pull request url`);
				continue;
			}
			targets.push({ record, owner, name, number, branch: record.awaiting_merge!.branch, prior: file.prs.find((pr) => pr.job_id === record.job_id) });
		}
		const size = this.#options.batchSize ?? WATCH_BATCH_SIZE;
		const observedBases: { job_id: string; repo: string; branch: string; base: string }[] = [];
		for (let start = 0; start < targets.length; start += size) {
			const batch = targets.slice(start, start + size);
			let body: { data?: Record<string, unknown>; errors?: { message?: string; path?: string[] }[] };
			try {
				body = (await (this.#options.runner ?? ghGraphql)(batchQuery(batch))) as typeof body;
				const answered = batch.some((_, index) => (body.data?.[`p${index}`] as { pullRequest?: unknown } | null | undefined)?.pullRequest);
				// Nothing answered and no error names a PR (bad credentials, a schema error): the runner failed, not the PRs.
				if (!answered && (body.errors?.length ? body.errors.every((error) => !error.path?.length) : !body.data)) {
					const why = body.errors?.map((error) => error.message).join("; ") || (body as { message?: string }).message || "no data in the answer";
					throw new Error(`GitHub GraphQL refused the batch: ${why}`);
				}
			} catch (error) {
				this.#failures += 1;
				file.backoff_until = isoTimestamp(new Date(now.getTime() + Math.min(60_000 * 2 ** (this.#failures - 1), BACKOFF_MAX_MS)));
				file.last_error = (error as Error).message.slice(0, 500);
				result.errors.push(file.last_error);
				break;
			}
			this.#failures = 0;
			for (const [index, target] of batch.entries()) {
				const node = body.data?.[`p${index}`] as { pullRequest?: RawPr | null; stacked?: { nodes?: { headRefName: string }[] } } | null | undefined;
				const pr = node?.pullRequest;
				if (!pr) {
					const why = body.errors?.find((error) => error.path?.[0] === `p${index}`)?.message ?? "no pull request in the answer";
					result.errors.push(`${target.record.job_id}: ${why}; its last observation stands`);
					continue;
				}
				result.observed += 1;
				const parkedRecord = target.record.awaiting_merge!;
				const read = normalize(pr, parkedRecord.handed_at, this.#options.cpLogins ?? []);
				observedBases.push({ job_id: target.record.job_id, repo: parkedRecord.repo, branch: parkedRecord.branch, base: read.snap.base });
				// Open PRs based on this parked branch: a live job among them is a stacked child the merge must queue.
				for (const head of (node?.stacked?.nodes ?? []).map((child) => child.headRefName)) {
					const child = live.find((job) => job.project === target.record.project && job.branch === head);
					if (child) observedBases.push({ job_id: child.job_id, repo: parkedRecord.repo, branch: child.branch, base: parkedRecord.branch });
				}
				let outcome: ExitOutcome;
				try {
					outcome = await applyExit(this.#options, target.record.job_id, parkedRecord.cycle, read.snap);
					result.outcomes.push(outcome);
				} catch (error) {
					result.errors.push(`${target.record.job_id}: ${(error as Error).message.split("\n")[0]}; cursors kept, the next sweep re-reads it`);
					continue;
				}
				const prior = target.prior?.cursors ?? {};
				// A skipped apply saw this page's events without acting on them: re-read them next sweep.
				const skipped = outcome.applied === "skipped";
				if (read.catching_up && !skipped) result.catching_up.push(target.record.job_id);
				const entry: ParkedPrWatch = {
					job_id: target.record.job_id, cycle: parkedRecord.cycle, pr_url: parkedRecord.pr_url, state: read.snap.state,
					head_sha: read.snap.head_sha, base: read.snap.base, ...(read.snap.merge_sha && read.snap.state === "merged" ? { merge_sha: read.snap.merge_sha } : {}),
					approvals: read.approvals, approvals_required: null,
					cursors: skipped ? prior : { ...prior, ...read.cursors },
					...(read.last_human ?? target.prior?.last_human_activity_at ? { last_human_activity_at: read.last_human ?? target.prior!.last_human_activity_at! } : {}),
					observed_at: isoTimestamp(now),
				};
				file.prs = [...file.prs.filter((item) => item.job_id !== entry.job_id), entry];
			}
			const rate = body.data?.rateLimit as { remaining?: number; resetAt?: string } | undefined;
			if (rate?.remaining !== undefined && rate.remaining < RATE_FLOOR && rate.resetAt) {
				file.backoff_until = isoTimestamp(new Date(rate.resetAt));
				result.errors.push(`GitHub rate limit at ${rate.remaining} points: the watch waits until ${file.backoff_until}`);
				break;
			}
		}
		this.#options.stackEdges?.recordEdges(observedBases);
		if (file.backoff_until && Date.parse(file.backoff_until) <= now.getTime()) delete file.backoff_until;
		if (!result.errors.length) delete file.last_error;
		file.last_sweep_at = isoTimestamp(now);
		this.#write(file, now);
		return { ...result, ...(file.backoff_until ? { backoff_until: file.backoff_until } : {}) };
	}

	#write(file: AwaitingMergeWatchFile, now: Date): void {
		const parsed = validateAwaitingMergeWatchFile({ ...file, updated_at: isoTimestamp(now) });
		if (!parsed.ok) throw new Error(`refusing to write an invalid awaiting-merge watch file: ${parsed.errors.join("; ")}`);
		const path = join(this.#options.home, LAYOUT.awaitingMergeWatchFile);
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteJson(path, parsed.value);
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}
}

interface Author { login?: string; __typename?: string }
interface Page<T> { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }
interface RawPr {
	url: string;
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefOid: string;
	headRefName: string;
	baseRefName: string;
	mergedAt: string | null;
	mergeCommit: { oid: string } | null;
	latestOpinionatedReviews: { nodes: { state: string; author: Author | null }[] };
	comments: Page<{ id: string; createdAt: string; author: Author | null }>;
	reviews: Page<{ id: string; state: string; body: string; createdAt: string; author: Author | null; comments: { totalCount: number } }>;
}

/** One aliased `repository.pullRequest` (plus open PRs based on its branch) per target and `rateLimit`; strings are JSON-quoted. */
export function batchQuery(batch: readonly (Pick<Target, "owner" | "name" | "number" | "prior"> & { branch?: string })[]): string {
	const after = (cursor: string | undefined) => (cursor ? `, after: ${JSON.stringify(cursor)}` : "");
	const author = "author { login __typename }";
	const prs = batch.map((target, index) =>
		`p${index}: repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(target.name)}) { pullRequest(number: ${target.number}) {` +
		" url number state headRefOid headRefName baseRefName mergedAt mergeCommit { oid }" +
		` latestOpinionatedReviews(first: ${PAGE}) { nodes { state ${author} } }` +
		` comments(first: ${PAGE}${after(target.prior?.cursors.comments)}) { pageInfo { hasNextPage endCursor } nodes { id createdAt ${author} } }` +
		` reviews(first: ${PAGE}${after(target.prior?.cursors.reviews)}) { pageInfo { hasNextPage endCursor } nodes { id state body createdAt ${author} comments { totalCount } } }` +
		" }" +
		(target.branch ? ` stacked: pullRequests(baseRefName: ${JSON.stringify(target.branch)}, states: OPEN, first: ${PAGE}) { nodes { headRefName } }` : "") +
		" }");
	return `query { rateLimit { remaining resetAt cost } ${prs.join(" ")} }`;
}

/** Human = a GitHub `User` that is not one of this home's logins; bots, apps and CP's own accounts never count. */
export function normalize(pr: RawPr, handedAt: string, cpLogins: readonly string[]) {
	const human = (author: Author | null) => author?.__typename === "User" && !cpLogins.includes(author.login ?? "");
	const fresh = (at: string) => Date.parse(at) > Date.parse(handedAt);
	const events: HumanEvent[] = [
		...pr.comments.nodes.filter((node) => human(node.author) && fresh(node.createdAt)).map((node) => ({ kind: "human_comment" as const, id: node.id, at: node.createdAt })),
		...pr.reviews.nodes
			.filter((node) => human(node.author) && fresh(node.createdAt) && node.state !== "PENDING")
			.flatMap((node): HumanEvent[] => node.state === "CHANGES_REQUESTED" ? [{ kind: "changes_requested", id: node.id, at: node.createdAt }]
				: node.body.trim() || node.comments.totalCount > 0 ? [{ kind: "human_comment", id: node.id, at: node.createdAt }] : []),
	].sort((a, b) => a.at.localeCompare(b.at));
	const snap: PrSnapshot = {
		url: pr.url, number: pr.number, state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
		head_sha: pr.headRefOid, base: pr.baseRefName, head_branch: pr.headRefName,
		...(pr.mergeCommit ? { merge_sha: pr.mergeCommit.oid } : {}), ...(pr.mergedAt ? { merged_at: pr.mergedAt } : {}), events,
	};
	return {
		snap,
		approvals: new Set(pr.latestOpinionatedReviews.nodes.filter((node) => node.state === "APPROVED").map((node) => node.author?.login ?? "")).size,
		cursors: {
			...(pr.comments.pageInfo.endCursor ? { comments: pr.comments.pageInfo.endCursor } : {}),
			...(pr.reviews.pageInfo.endCursor ? { reviews: pr.reviews.pageInfo.endCursor } : {}),
		},
		catching_up: pr.comments.pageInfo.hasNextPage || pr.reviews.pageInfo.hasNextPage,
		last_human: events.at(-1)?.at,
	};
}
