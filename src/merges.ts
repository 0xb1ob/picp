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
 * So: when the parent merges, it records what GitHub says.
 *
 *  - `gh pr view` is the observer, not the caller: a receipt is only written
 *    for a PR whose state GitHub itself reports as `MERGED`, with a merge
 *    commit and a head oid. An assertion by a human or a model is not enough,
 *    because the whole point is that the gate can then *read evidence* instead
 *    of taking a claim.
 *  - The receipt records the **head oid that was merged**, so the gate can tell
 *    "this branch landed" from "this branch landed and then someone committed
 *    more on it" — the second is still unpushed work and is still refused.
 *  - `force` survives untouched, for the genuinely unprovable case (the
 *    worktree is gone, `gh` is unavailable, the PR was merged somewhere this
 *    machine cannot see), and still claims no pass reason.
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
	options?: { stdin?: string },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

/** The `gh pr view --json` fields this module asks for, and nothing else. */
export const GH_PR_FIELDS = ["number", "url", "state", "mergedAt", "mergeCommit", "headRefName", "headRefOid", "baseRefName"] as const;

export interface MergeStoreOptions {
	home: string;
	fleet: FleetStore;
	runs?: RunRegistry;
	/** Injected so tests never shell out to a real `gh`. */
	run?: CommandRunner;
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
			return { receipt: existing, recorded: false, receipt_status_updated: false };
		}

		const pr = request.pr?.trim() || prUrlFromReceipts(record.receipts);
		if (!pr) {
			throw new MergeError(
				`${jobId} carries no PR receipt, so there is no PR to confirm — pass the PR url or number explicitly ` +
					"(cp_merged job_id=<id> pr=<url>).",
			);
		}

		const cwd = request.cwd ?? this.#defaultCwd(record.worktree, record.project);
		const view = await this.#viewPr(cwd, pr, jobId);

		if (view.state !== "MERGED") {
			throw new MergeError(
				`${jobId}: gh reports PR ${view.url ?? pr} as ${view.state ?? "unknown"}, not MERGED — nothing is recorded. ` +
					"A merge receipt is an observation, never a claim.",
			);
		}
		const mergeCommit = view.mergeCommit?.oid?.trim();
		if (!mergeCommit) {
			throw new MergeError(
				`${jobId}: gh reports PR ${view.url ?? pr} merged but names no merge commit — nothing is recorded. ` +
					`Re-run once GitHub reports one, or use cp_teardown ${jobId} force if it never will (force proves nothing, and says so).`,
			);
		}
		const headSha = view.headRefOid?.trim();
		if (!headSha) {
			throw new MergeError(`${jobId}: gh reports PR ${view.url ?? pr} with no head commit — nothing is recorded.`);
		}
		const headBranch = view.headRefName?.trim() || record.branch;
		if (headBranch !== record.branch) {
			throw new MergeError(
				`${jobId}: PR ${view.url ?? pr} merged branch ${headBranch}, but this job's branch is ${record.branch} — ` +
					"that PR is not this job's delivery, so nothing is recorded.",
			);
		}

		const onRemote = await this.#branchOnRemote(cwd, headBranch);
		const receipt: MergeReceipt = {
			schema_version: SCHEMA_VERSION,
			job_id: jobId,
			pr_url: view.url ?? pr,
			...(typeof view.number === "number" ? { pr_number: view.number } : {}),
			merge_commit_sha: mergeCommit,
			head_sha: headSha,
			head_branch: headBranch,
			...(onRemote === undefined ? {} : { head_branch_deleted: !onRemote }),
			...(view.baseRefName ? { base_branch: view.baseRefName } : {}),
			...(request.strategy ? { strategy: request.strategy } : {}),
			...(view.mergedAt ? { merged_at: view.mergedAt } : {}),
			recorded_at: isoTimestamp(this.#now()),
			recorded_by: request.by?.trim() || "gh pr view",
			...(request.authority ? { authority: request.authority } : {}),
		};
		const parsed = validate<MergeReceipt>(MergeReceiptSchema, receipt);
		if (!parsed.ok) {
			throw new MergeError(`refusing to write an invalid merge receipt for ${jobId}:\n  ${parsed.errors.join("\n  ")}`);
		}
		atomicWriteJson(this.file(jobId), parsed.value);

		const statusUpdated = await this.#markReceiptMerged(jobId, parsed.value);
		this.#options.runs?.open(jobId).cp("merge_recorded", {
			job_id: jobId,
			pr_url: parsed.value.pr_url,
			merge_commit_sha: parsed.value.merge_commit_sha,
			head_sha: parsed.value.head_sha,
			head_branch_deleted: parsed.value.head_branch_deleted ?? null,
		});
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

	async #viewPr(cwd: string, pr: string, jobId: string): Promise<GhPrView> {
		const result = await this.#run(cwd, "gh", ["pr", "view", pr, "--json", GH_PR_FIELDS.join(",")]);
		if (result.status !== 0) {
			const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "no output";
			throw new MergeError(
				`${jobId}: could not read PR ${pr} with gh in ${cwd} (${detail}). Nothing is recorded. ` +
					`If the merge cannot be observed from this machine, cp_teardown ${jobId} force is the honest exit — it proves nothing, and records that.`,
			);
		}
		try {
			return JSON.parse(result.stdout) as GhPrView;
		} catch {
			throw new MergeError(`${jobId}: gh returned output that is not JSON for PR ${pr} — nothing is recorded.`);
		}
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

interface GhPrView {
	number?: number;
	url?: string;
	state?: string;
	mergedAt?: string;
	mergeCommit?: { oid?: string } | null;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
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
