/**
 * awaiting_merge PR3: stacked PRs. An edge (child PR based on a tracked parent's branch) is recorded when observed,
 * before GitHub can retarget it; a parent merge queues one merge-and-retarget action per child for the parent.
 * Nothing here runs git or the forge: the action is executed by the child's own authorized ship loop.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isoTimestamp, LAYOUT, type StackAction, type StackEdge, type StackFollowupsFile, validateStackFollowupsFile } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";

export class StackFollowupsError extends Error {}

/** One tracked PR as observed: its job, branch, observed base and repository. */
export interface TrackedPr { job_id: string; repo: string; branch: string; base: string }

export function readStackFollowups(home: string): StackFollowupsFile {
	const file = join(home, LAYOUT.stackFollowupsFile);
	if (!existsSync(file)) return { schema_version: 1, updated_at: isoTimestamp(new Date(0)), edges: [], actions: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new StackFollowupsError(`${file} is not readable JSON: ${(error as Error).message}`);
	}
	const parsed = validateStackFollowupsFile(raw);
	if (!parsed.ok) throw new StackFollowupsError(`${file} is not a valid stack-followups file: ${parsed.errors.join("; ")}`);
	return parsed.value;
}

/** Pending merge-and-retarget actions, oldest first: what the parent owes a stacked child. */
export function pendingStackActions(home: string): StackAction[] {
	return readStackFollowups(home).actions.filter((action) => action.status === "pending");
}

export class StackFollowups {
	readonly #home: string;
	readonly #now: () => Date;

	constructor(options: { home: string; now?: () => Date }) {
		this.#home = options.home;
		this.#now = options.now ?? (() => new Date());
	}

	/**
	 * Record a child→parent edge for every tracked PR whose base is another tracked job's branch in the same repo.
	 * Edges are kept after a retarget: the relation is history GitHub may erase. Returns the edges added.
	 */
	recordEdges(prs: readonly TrackedPr[]): StackEdge[] {
		const at = isoTimestamp(this.#now());
		const added: StackEdge[] = [];
		this.#mutate((file) => {
			for (const child of prs) {
				const parent = prs.find((candidate) => candidate.job_id !== child.job_id && candidate.repo === child.repo && candidate.branch === child.base);
				if (!parent || file.edges.some((edge) => edge.parent_job === parent.job_id && edge.child_job === child.job_id)) continue;
				const edge: StackEdge = { parent_job: parent.job_id, child_job: child.job_id, repo: child.repo, parent_branch: parent.branch, child_branch: child.branch, observed_at: at };
				file.edges.push(edge);
				added.push(edge);
			}
		});
		return added;
	}

	/** On a parent merge: one pending action per recorded child, keyed by merge sha (a replay adds nothing). */
	queueForMerge(parentJob: string, mergeSha: string, targetBase: string): StackAction[] {
		const at = isoTimestamp(this.#now());
		const queued: StackAction[] = [];
		this.#mutate((file) => {
			for (const edge of file.edges.filter((candidate) => candidate.parent_job === parentJob)) {
				const id = `${parentJob}:${edge.child_job}:${mergeSha}`;
				const existing = file.actions.find((action) => action.id === id);
				if (existing) {
					if (existing.status === "pending") queued.push(existing);
					continue;
				}
				const action: StackAction = {
					id, parent_job: parentJob, child_job: edge.child_job, repo: edge.repo, child_branch: edge.child_branch,
					previous_base: edge.parent_branch, target_base: targetBase, merge_sha: mergeSha, queued_at: at, status: "pending",
				};
				file.actions.push(action);
				queued.push(action);
			}
		});
		return queued;
	}

	/** Acknowledge (`done`) or dispose of a pending action; settling a settled one is refused, never re-stamped. */
	settle(id: string, status: "done" | "disposed"): StackAction {
		let settled: StackAction | undefined;
		this.#mutate((file) => {
			const action = file.actions.find((candidate) => candidate.id === id);
			if (!action) throw new StackFollowupsError(`no stack action ${id}`);
			if (action.status !== "pending") throw new StackFollowupsError(`stack action ${id} is already ${action.status}`);
			action.status = status;
			action.settled_at = isoTimestamp(this.#now());
			settled = action;
		});
		return settled!;
	}

	#mutate(change: (file: StackFollowupsFile) => void): void {
		const file = structuredClone(readStackFollowups(this.#home));
		const before = JSON.stringify(file);
		change(file);
		if (JSON.stringify(file) === before) return;
		file.updated_at = isoTimestamp(this.#now());
		const parsed = validateStackFollowupsFile(file);
		if (!parsed.ok) throw new StackFollowupsError(`refusing to write an invalid stack-followups file: ${parsed.errors.join("; ")}`);
		const path = join(this.#home, LAYOUT.stackFollowupsFile);
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteJson(path, parsed.value);
	}
}
