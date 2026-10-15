/**
 * Merge receipts — the mechanism behind "confirm the PR merged" (cp-vk1).
 *
 * The defect this exists to close: teardown's ship gate could only ask git
 * whether the branch's content was already in the base, and that question has
 * no true answer for a squash- or rebase-merged PR — both rewrite the commit,
 * so the branch tip is never an ancestor of the base and a two-dot tree diff is
 * only empty while the base has not moved on. This repo squash-merges
 * everything, so a landed job with a deleted head branch was refused with a
 * fix ("or confirm the PR merged") that named no mechanism at all. The only
 * exit was `force`, which by contract records that **nothing was proven** — a
 * weaker claim than the evidence supported, written into the audit trail.
 *
 * So: when the parent merges, it records what the forge says.
 *
 *  - The forge is the observer, not the caller (`gh pr view`, or the GitLab MR
 *    API through src/forge-runtime.ts): a receipt is only written for a change
 *    request the forge itself reports merged, with a landing commit and a head
 *    oid. An assertion by a human or a model is not enough,
 *    because the whole point is that the gate can then *read evidence* instead
 *    of taking a claim.
 *  - The receipt records the **head oid that was merged**, so the gate can tell
 *    "this branch landed" from "this branch landed and then someone committed
 *    more on it" — the second is still unpushed work and is still refused.
 *  - With no forge to ask, teardown's git landing proof (src/landing-proof.ts)
 *    can still pass on content found in the base — it writes no receipt here.
 *    `force` survives untouched as the last resort, and still claims nothing.
 *
 * Nothing here is a second writer of anything: the receipt is a new file, and
 * the one existing record it touches is the job's `pr` receipt status, moved
 * from `open` to `merged` — the status `src/supersede.ts` already documents as
 * "set by whoever observes the merge", and which nothing set until now.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FleetRecord,
	isoTimestamp,
	type MergeAuthority,
	type MergeReceipt,
	MergeReceiptSchema,
	type MergeStrategy,
	paths,
	type Receipt,
	SCHEMA_VERSION,
	validate,
} from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { changeRequestObserver } from "./forge-runtime.ts";
import { parseChangeRequestUrl } from "./forge-url.ts";
import type { ChangeRequestObservation, ForgeObserver } from "./forges/adapter.ts";
import { haveCommit, remoteTip } from "./landing-proof.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { RunRegistry } from "./runs.ts";

export class MergeError extends Error {}

export type CommandRunner = (
	cwd: string,
	bin: string,
	args: readonly string[],
	/**
	 * Written to the child's stdin and closed. Only `git patch-id` needs it (it
	 * reads a diff and nothing else), and it is a parameter rather than a shell
	 * pipe because nothing in this system builds a command line for a shell.
	 */
	options?: { stdin?: string; timeoutMs?: number },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

/** The `gh pr view --json` fields, now owned by the GitHub observer; re-exported for existing callers. */
export { GH_PR_FIELDS } from "./forges/github.ts";

export interface MergeStoreOptions {
	home: string;
	fleet: FleetStore;
	runs?: RunRegistry;
	/** Injected so tests never shell out to a real `gh`. */
	run?: CommandRunner;
	/** The forge observer for a PR/MR ref; defaults to the job project's forge (src/forge-runtime.ts), gh when unresolvable. */
	observer?: (ref: string, cwd: string) => ForgeObserver;
	now?: () => Date;
}

export interface RecordMergeRequest {
	jobId: string;
	/** PR url or number. Defaults to the `pr` receipt the envelope filed. */
	pr?: string;
	/** How it was merged, when the caller knows; recorded, never trusted as proof. */
	strategy?: MergeStrategy;
	/** Where to run `gh`. Defaults to the job's worktree, then its project clone. */
	cwd?: string;
	by?: string;
	/**
	 * Which rule permitted this merge (cp-e0c). Absent means this call did not
	 * observe a permission decision (e.g. `cp_merged`, invoked after the fact) —
	 * that absence is itself the honest fact, and it is never invented here.
	 */
	authority?: MergeAuthority;
}

export interface RecordMergeResult {
	receipt: MergeReceipt;
	/** True when this call wrote the receipt; false when it already existed. */
	recorded: boolean;
	/** True when the job's `pr` receipt moved from `open` to `merged`. */
	receipt_status_updated: boolean;
}

/**
 * Read a job's merge receipt, or `undefined` when there is none.
 *
 * Total on purpose: an unreadable or contract-violating file is **no receipt**,
 * never an exception thrown out of a gate whose whole contract is to keep
 * everything and name the fix. The same discipline `Teardown.#latestReview`
 * uses for a torn verdict.
 */
export function readMergeReceipt(home: string, jobId: string): MergeReceipt | undefined {
	let file: string;
	try {
		file = join(home, paths.mergeFile(jobId));
	} catch {
		return undefined;
	}
	if (!existsSync(file)) return undefined;
	try {
		const parsed = validate<MergeReceipt>(MergeReceiptSchema, JSON.parse(readFileSync(file, "utf8")));
		return parsed.ok ? parsed.value : undefined;
	} catch {
		return undefined;
	}
}

export class MergeStore {
	readonly #options: MergeStoreOptions;

	constructor(options: MergeStoreOptions) {
		this.#options = options;
	}

	file(jobId: string): string {
		return join(this.#options.home, paths.mergeFile(jobId));
	}

	get(jobId: string): MergeReceipt | undefined {
		return readMergeReceipt(this.#options.home, jobId);
	}

	/**
	 * Observe a merge and record it. Fail-closed at every step: an unmerged PR,
	 * an unreachable `gh`, a PR whose head branch is not this job's branch, and a
	 * merged PR with no merge commit all refuse and write nothing.
	 */
	async record(request: RecordMergeRequest): Promise<RecordMergeResult> {
		const { fleet } = this.#options;
		const jobId = request.jobId;
		const record = fleet.get(jobId);
		if (!record) {
			throw new MergeError(`no fleet record for ${jobId} — a merge receipt is a fact about a job this home dispatched`);
		}

		const existing = this.get(jobId);
		if (existing) {
			if (existing.job_id !== jobId || existing.head_branch !== record.branch) {
				throw new MergeError(`${jobId}: the stored merge receipt names ${existing.job_id} on ${existing.head_branch}, not this job's ${record.branch} — it discharges nothing here`);
			}
			// A crash between the receipt write and the fleet patch is repaired here, with no second event.
			return { receipt: existing, recorded: false, receipt_status_updated: await this.#markReceiptMerged(jobId, existing) };
		}

		const pr = request.pr?.trim() || prUrlFromReceipts(record.receipts);
		if (!pr) {
			throw new MergeError(
				`${jobId} carries no PR receipt, so there is no PR to confirm — pass the PR url or number explicitly ` +
					"(cp_merged job_id=<id> pr=<url>).",
			);
		}

		const cwd = request.cwd ?? this.#defaultCwd(record.worktree, record.project);
		const run: CommandRunner = (dir, bin, args) => this.#run(dir, bin, args);
		const observer = (this.#options.observer ?? ((ref, at) => changeRequestObserver(this.#options.home, record.project, ref, { run, cwd: at })))(pr, cwd);
		const read = await observer.readChangeRequest(pr);
		if (!read.ok) {
			throw new MergeError(
				`${jobId}: could not read PR ${pr} in ${cwd} (${read.reason}: ${read.detail}). Nothing is recorded. ` +
					`cp_teardown ${jobId} can still pass on git evidence when the work is in the base's history; only if neither can prove it, cp_teardown ${jobId} force — which proves nothing, and records that.`,
			);
		}
		return this.#write(record, read.observation, request, cwd);
	}

	/**
	 * Record a merge from an observation a home-owned forge read already made (the awaiting_merge batch watch), with
	 * the same validation as `record`. No git runs: a parked job's recorded worktree may be another job's by now.
	 */
	async recordObserved(jobId: string, view: ChangeRequestObservation, by: string): Promise<RecordMergeResult> {
		const record = this.#options.fleet.get(jobId);
		if (!record) throw new MergeError(`no fleet record for ${jobId} — a merge receipt is a fact about a job this home dispatched`);
		const existing = this.get(jobId);
		if (existing) {
			if (existing.job_id !== jobId || existing.head_branch !== record.branch) {
				throw new MergeError(`${jobId}: the stored merge receipt names ${existing.job_id} on ${existing.head_branch}, not this job's ${record.branch} — it discharges nothing here`);
			}
			return { receipt: existing, recorded: false, receipt_status_updated: await this.#markReceiptMerged(jobId, existing) };
		}
		return this.#write(record, view, { jobId, by }, undefined);
	}

	/** Validate an observation and write its receipt; `cwd` undefined skips every git read. */
	async #write(record: FleetRecord, view: ChangeRequestObservation, request: RecordMergeRequest, cwd: string | undefined): Promise<RecordMergeResult> {
		const jobId = record.job_id;
		const label = view.provider === "gitlab" ? "GitLab" : "gh";

		if (view.state !== "merged") {
			throw new MergeError(
				`${jobId}: ${label} reports ${view.url} as ${view.state}, not MERGED — nothing is recorded. ` +
					"A merge receipt is an observation, never a claim.",
			);
		}
		const headSha = view.head_sha?.trim();
		if (!headSha) {
			throw new MergeError(`${jobId}: ${label} reports ${view.url} with no head commit — nothing is recorded.`);
		}
		// GitLab names no merge or squash commit for a fast-forward: the head itself landed, if git sees it on the target.
		const mergeCommit = view.merge_commit_sha ?? view.squash_commit_sha ??
			(view.provider === "gitlab" && view.target_branch && cwd !== undefined && (await this.#reachable(cwd, headSha, view.target_branch)) ? headSha : undefined);
		if (!mergeCommit) {
			throw new MergeError(
				`${jobId}: ${label} reports ${view.url} merged but names no merge commit — nothing is recorded. ` +
					`Re-run once the forge reports one; cp_teardown ${jobId} may still pass on git evidence that the content is in the base.`,
			);
		}
		const headBranch = view.source_branch?.trim() || record.branch;
		if (headBranch !== record.branch) {
			throw new MergeError(
				`${jobId}: PR ${view.url} merged branch ${headBranch}, but this job's branch is ${record.branch} — ` +
					"that PR is not this job's delivery, so nothing is recorded.",
			);
		}

		const onRemote = cwd === undefined ? undefined : await this.#branchOnRemote(cwd, headBranch);
		const strategy = request.strategy ?? (view.provider === "gitlab" ? (view.squash_commit_sha ? "squash" : "unknown") : undefined);
		const project = parseChangeRequestUrl(view.url);
		const receipt: MergeReceipt = {
			schema_version: SCHEMA_VERSION,
			job_id: jobId,
			pr_url: view.url,
			pr_number: view.number,
			merge_commit_sha: mergeCommit,
			head_sha: headSha,
			head_branch: headBranch,
			...(record.bound_pr ? { bound: true as const } : {}),
			...(onRemote === undefined ? {} : { head_branch_deleted: !onRemote }),
			...(view.target_branch ? { base_branch: view.target_branch } : {}),
			...(strategy ? { strategy } : {}),
			...(view.merged_at ? { merged_at: Number.isNaN(Date.parse(view.merged_at)) ? view.merged_at : isoTimestamp(new Date(view.merged_at)) } : {}),
			recorded_at: isoTimestamp(this.#now()),
			recorded_by: request.by?.trim() || (view.provider === "gitlab" ? "gitlab api" : "gh pr view"),
			...(request.authority ? { authority: request.authority } : {}),
			...(project ? { forge: { provider: view.provider, project_url: `${project.origin}/${project.path}` } } : {}),
		};
		const parsed = validate<MergeReceipt>(MergeReceiptSchema, receipt);
		if (!parsed.ok) {
			throw new MergeError(`refusing to write an invalid merge receipt for ${jobId}:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(jobId), parsed.value);

		this.#options.runs?.open(jobId).cp("merge_recorded", {
			job_id: jobId,
			pr_url: parsed.value.pr_url,
			merge_commit_sha: parsed.value.merge_commit_sha,
			head_sha: parsed.value.head_sha,
			head_branch_deleted: parsed.value.head_branch_deleted ?? null,
			provider: parsed.value.forge?.provider ?? "github",
		});
		// Journaled with the receipt, before the fleet patch: a crash here is repaired by the next call, not re-announced.
		const statusUpdated = await this.#markReceiptMerged(jobId, parsed.value);
		return { receipt: parsed.value, recorded: true, receipt_status_updated: statusUpdated };
	}

	/** `open` → `merged` on the job's own PR receipt, so Shipped can be honest. */
	async #markReceiptMerged(jobId: string, receipt: MergeReceipt): Promise<boolean> {
		const record = this.#options.fleet.get(jobId);
		if (!record) return false;
		const receipts: Receipt[] = [...(record.receipts ?? [])];
		const index = receipts.findIndex((entry) => entry.kind === "pr");
		const merged: Receipt = {
			kind: "pr",
			status: "merged",
			title: receipts[index]?.title ?? `PR for ${jobId}`,
			url: receipts[index]?.url ?? receipt.pr_url,
		};
		if (index >= 0) {
			if (receipts[index]?.status === "merged") return false;
			receipts[index] = merged;
		} else {
			receipts.push(merged);
		}
		await this.#options.fleet.patch(jobId, { receipts });
		return true;
	}

	/** Fast-forward evidence: origin's `target` tip has `head` in its history (the tip object fetched by sha if missing). */
	async #reachable(cwd: string, head: string, target: string): Promise<boolean> {
		const git = (dir: string, args: readonly string[]) => this.#run(dir, "git", args);
		const tip = await remoteTip(git, cwd, target);
		if (!tip.ok || !tip.sha || !(await haveCommit(git, cwd, tip.sha))) return false;
		return (await git(cwd, ["merge-base", "--is-ancestor", head, tip.sha])).status === 0;
	}

	/**
	 * Is the head branch still on the remote? `undefined` when the remote could
	 * not be asked — a receipt is still written in that case, because the merge
	 * itself was observed; only this one bookkeeping field is left off.
	 */
	async #branchOnRemote(cwd: string, branch: string): Promise<boolean | undefined> {
		const result = await this.#run(cwd, "git", ["ls-remote", "--heads", "origin", branch]);
		if (result.status !== 0) return undefined;
		return result.stdout.trim().length > 0;
	}

	#defaultCwd(worktree: string, project: string): string {
		if (worktree && existsSync(worktree)) return worktree;
		const clone = join(this.#options.home, paths.projectDir(project));
		if (existsSync(clone)) return clone;
		return this.#options.home;
	}

	#now(): Date {
		return (this.#options.now ?? (() => new Date()))();
	}

	async #run(cwd: string, bin: string, args: readonly string[]) {
		const custom = this.#options.run;
		if (custom) return custom(cwd, bin, args);
		return defaultRun(cwd, bin, args);
	}
}

function prUrlFromReceipts(receipts: readonly Receipt[] | undefined): string | undefined {
	return (receipts ?? []).find((receipt) => receipt.kind === "pr" && receipt.url)?.url;
}

function defaultRun(cwd: string, bin: string, args: readonly string[]) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise) => {
		execFile(bin, [...args], { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			const status =
				error && typeof (error as { code?: unknown }).code === "number"
					? (error as unknown as { code: number }).code
					: error
						? 1
						: 0;
			resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** One operator line. A receipt is evidence, so it names what was observed. */
export function formatMerge(result: RecordMergeResult): string {
	const { receipt } = result;
	const verb = result.recorded ? "merge recorded" : "merge already recorded";
	const deleted = receipt.head_branch_deleted === true ? ", head branch deleted" : "";
	return (
		`${receipt.job_id} ${verb}: ${receipt.pr_url} merged as ${receipt.merge_commit_sha.slice(0, 12)} ` +
		`(head ${receipt.head_sha.slice(0, 12)}${deleted}). cp_teardown ${receipt.job_id} can now pass without force.`
	);
}
