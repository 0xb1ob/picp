/**
 * `cp_dispatch pr` (picp-d0p): bind a ship/delivery:pr job to an existing PR.
 *
 * Dispatch normally cuts `<job-id>` from `origin/<base>`. A bound job instead checks out
 * the PR's head branch, so every reader keyed on `FleetRecord.branch` (intake, CI watch,
 * review, cp_integrate, cp_merged) follows the PR. Everything here refuses before a lease
 * except `checkoutBoundBranch`, which runs in the leased worktree and never deletes a ref:
 * a diverged local branch is kept on a `refs/cp-salvage/` ref before it is reset.
 */
import { type FleetRecord, isoTimestamp, SALVAGE_REF_PREFIX } from "./contracts.ts";
import { parsePrUrl } from "./ci-watch.ts";
import { DispatchError, type GitRunner } from "./dispatch.ts";
import { lastLine } from "./job-branch-cleanup.ts";
import { githubRepoFromCloneUrl } from "./mandate.ts";
import { type CommandRunner, MERGE_ASK_QUERY_TIMEOUT_MS, runCommand } from "./merge-ask.ts";

/** What dispatch needs to know about the bound PR, read from gh, never from the caller. */
export interface BoundPrFacts {
	number: number;
	url: string;
	draft: boolean;
	/** The PR's head branch: becomes the job's branch. */
	head: string;
	/** `headRefOid`: the worktree must land exactly here. */
	headSha: string;
	base: string;
}

/** The one input a binder gets: the operator's ref, and where/against what to read it. */
export interface BindPrInput {
	ref: string;
	project: string;
	/** gh's cwd: the canonical clone. */
	clone: string;
	/** The project's default base; a PR on any other base is refused. */
	base: string;
}

export const GH_PR_BIND_FIELDS = ["number", "url", "state", "isDraft", "isCrossRepository", "headRefName", "headRefOid", "baseRefName"] as const;

/** `169`, `#169`, or a PR url of `ownerRepo` (case-insensitive). */
export function parsePrRef(input: string, ownerRepo: string): { number: number } | { error: string } {
	const text = input.trim();
	const bare = /^#?(\d+)$/.exec(text);
	if (bare) return Number(bare[1]) > 0 ? { number: Number(bare[1]) } : { error: `pr ${input} is not a PR number` };
	const url = parsePrUrl(text);
	if (!url) return { error: `pr ${input} is neither a PR number nor a GitHub pull request url` };
	if (`${url.owner}/${url.repo}`.toLowerCase() !== ownerRepo.toLowerCase()) {
		return { error: `pr ${input} names ${url.owner}/${url.repo}, but the project's origin remote is ${ownerRepo} — bind a PR of this project` };
	}
	return { number: url.number };
}

/**
 * Read the PR from gh and refuse every case a bound job cannot finish safely. Fails closed:
 * no GitHub origin, an unreadable gh, or an unparseable answer is a refusal, never a guess.
 */
export async function readBoundPr(input: BindPrInput & { ownerRepo: string | undefined; exec?: CommandRunner; timeoutMs?: number }): Promise<BoundPrFacts> {
	const refuse = (why: string, fix: string): never => {
		throw new DispatchError(`cannot bind pr ${input.ref}: ${why} — ${fix}`);
	};
	if (!input.ownerRepo) return refuse(`project ${input.project} has no GitHub origin remote, so the PR cannot be read`, "dispatch without pr");
	const parsed = parsePrRef(input.ref, input.ownerRepo);
	if ("error" in parsed) return refuse(parsed.error, "pass the PR number or its url in this repo");
	let stdout: string;
	try {
		stdout = await (input.exec ?? runCommand)("gh", ["pr", "view", String(parsed.number), "--repo", input.ownerRepo, "--json", GH_PR_BIND_FIELDS.join(",")], {
			cwd: input.clone,
			timeoutMs: input.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
		});
	} catch (error) {
		return refuse(`gh could not read ${input.ownerRepo}#${parsed.number} (${lastLine(error instanceof Error ? error.message : String(error))})`, "fix gh access and dispatch again");
	}
	let row: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(stdout);
		if (value && typeof value === "object" && !Array.isArray(value)) row = value as Record<string, unknown>;
	} catch {
		// an unparseable answer is refused below
	}
	const str = (key: string): string => (typeof row[key] === "string" ? (row[key] as string).trim() : "");
	const [url, state, head, headSha, base] = [str("url"), str("state"), str("headRefName"), str("headRefOid"), str("baseRefName")];
	if (!url || !state || !head || !headSha || !base) return refuse(`gh's answer for ${input.ownerRepo}#${parsed.number} is not a readable PR`, "check `gh pr view` and dispatch again");
	if (state !== "OPEN") return refuse(`${url} is ${state}`, "a merged or closed PR is not finishable; open a new job without pr");
	if (row.isCrossRepository !== false) {
		return refuse(`${url} comes from a fork (isCrossRepository)`, "push the fork branch to origin under a new name and dispatch without pr, or have a human finish it");
	}
	if (base !== input.base) return refuse(`${url} targets ${base}, not the project's default base ${input.base}`, "stacked PRs are not bound; retarget it to the default base or have a human finish it");
	return { number: parsed.number, url, draft: row.isDraft === true, head, headSha, base };
}

/** The default binder: `owner/repo` from the project's origin remote, then `readBoundPr`. */
export function bindFromOrigin(originUrl: (project: string) => string | undefined) {
	return (input: BindPrInput): Promise<BoundPrFacts> => {
		const origin = originUrl(input.project);
		return readBoundPr({ ...input, ownerRepo: origin ? githubRepoFromCloneUrl(origin) : undefined });
	};
}

/** Only one non-done job may hold a branch: a held, waiting or failed holder still owns it. */
export function assertBranchFree(jobs: readonly FleetRecord[], jobId: string, head: string): void {
	const holder = jobs.find((job) => job.job_id !== jobId && job.phase !== "done" && job.branch === head);
	if (holder) {
		throw new DispatchError(
			`cannot bind ${jobId} to branch ${head}: job ${holder.job_id} (${holder.phase}) holds it — promote that job (cp_send ${holder.job_id}) or cp_teardown it first`,
		);
	}
}

/**
 * Put the leased worktree on the PR head at exactly `headSha`, losing nothing: an absent
 * local branch is created tracking origin; a local branch behind origin is fast-forwarded;
 * a diverged one is kept at `refs/cp-salvage/<job>/<utc>` and then reset to origin.
 */
export async function checkoutBoundBranch(input: { git: GitRunner; worktree: string; jobId: string; head: string; headSha: string; now: Date }): Promise<{ salvaged?: string }> {
	const { git, worktree, head } = input;
	const run = async (args: string[], what: string) => {
		const result = await git(worktree, args);
		if (result.status !== 0) throw new DispatchError(`cannot check out bound branch ${head} in ${worktree}: ${what} failed (${lastLine(result.stderr)})`);
		return result.stdout.trim();
	};
	const self = await run(["rev-parse", "--show-toplevel"], "rev-parse --show-toplevel");
	let path = "";
	for (const line of (await run(["worktree", "list", "--porcelain"], "worktree list")).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${head}` && path !== self) {
			throw new DispatchError(`cannot bind branch ${head}: it is checked out in another worktree (${path}) — finish or cp_teardown the job that leased it`);
		}
	}
	await run(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${head}`], `origin/${head} lookup (fetch first)`);
	const local = await git(worktree, ["rev-parse", "--verify", "--quiet", `refs/heads/${head}`]);
	let salvaged: string | undefined;
	if (local.status !== 0) {
		await run(["switch", "--track", "-c", head, `origin/${head}`], `switch --track -c ${head}`);
	} else if ((await git(worktree, ["merge-base", "--is-ancestor", `refs/heads/${head}`, `refs/remotes/origin/${head}`])).status === 0) {
		await run(["switch", head], `switch ${head}`);
		await run(["merge", "--ff-only", `origin/${head}`], `merge --ff-only origin/${head}`);
	} else {
		// `:` is not legal in a ref name, so the timestamp is dashed (as integrate's #salvageRef).
		salvaged = `${SALVAGE_REF_PREFIX}${input.jobId}/${isoTimestamp(input.now).replaceAll(":", "-")}`;
		await run(["update-ref", salvaged, local.stdout.trim()], `keeping the diverged local ${head} at ${salvaged}`);
		await run(["switch", "-C", head, `origin/${head}`], `switch -C ${head}`);
	}
	const at = await run(["rev-parse", "HEAD"], "rev-parse HEAD");
	if (at !== input.headSha) {
		throw new DispatchError(`bound branch ${head} is at ${at.slice(0, 12)}, not the PR head ${input.headSha.slice(0, 12)} — the PR moved while dispatching; dispatch again`);
	}
	return salvaged ? { salvaged } : {};
}

/** One brief/original-task paragraph; it overrides the ship checklist's rebase and lease-push steps. */
export function boundPrNote(facts: BoundPrFacts): string {
	return (
		`Bound to ${facts.url} (${facts.draft ? "draft" : "open"}), head ${facts.head} at ${facts.headSha.slice(0, 12)}, base ${facts.base}: ` +
		`push to ${facts.head}, do not open a PR, report ${facts.url} as pr_url; the reviewed diff is this whole PR vs ${facts.base}, commits made before this job included. ` +
		`This branch is not yours (it may be an outside contributor's), so this overrides the checklist's rebase and --force-with-lease steps: ` +
		`update the branch by merging origin/${facts.base} into it, never by rebase; push fast-forward only (plain git push, never --force or --force-with-lease); ` +
		`never rewrite or drop existing commits.`
	);
}
