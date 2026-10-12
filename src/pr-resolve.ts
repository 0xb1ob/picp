/**
 * Resolve a `delivery:pr` envelope's PR from git and gh — never from the worker's word
 * (pi-command-post-fbn).
 *
 * The defect this exists to make impossible: a worker typo'd the owner in
 * `report_result.pr_url` (`0xb1b0` for `0xb1ob`). Intake stored it as the job's `pr`
 * receipt, and every downstream reader of that url — the CI watch's REST read,
 * `cp_integrate`, `cp_merged`, the status block — keys on the *stored receipt*. PR #338
 * sat green and unmerged for 27 minutes because the watch was asking GitHub about a repo
 * that does not exist. So the one place to get the url right is intake.
 *
 * Three outcomes, and "I could not ask" is never a pass:
 *
 *  - `verified`   — exactly one PR is on the job branch of the project's origin repo
 *                   (`gh pr list --head <branch> --state all`). That url is canonical;
 *                   when it differs from the worker's, the correction is named.
 *  - `unverified` — gh could not be asked, or there is no GitHub origin remote to aim it
 *                   at. The worker's url survives only because its `owner/repo` matched
 *                   the origin remote; it is marked, never silently treated as checked.
 *  - `refused`    — no PR on the branch, more than one, or an `owner/repo` that
 *                   contradicts the origin remote. The refusal names the branch and the
 *                   expected `owner/repo` (and every url found, when there were several).
 */

import { parsePrUrl } from "./ci-watch.ts";
import { parseChangeRequestUrl } from "./forge-url.ts";
import type { ForgeObserver } from "./forges/adapter.ts";
import { type CommandRunner, MERGE_ASK_QUERY_TIMEOUT_MS, runCommand } from "./merge-ask.ts";

/** One row of `gh pr list --json url,number,headRefOid`. */
export interface GhPrRow {
	url: string;
	number?: number;
	head_sha?: string;
}

/**
 * The one place this query is spelled out. `--state all` on purpose: a PR that was merged
 * or closed is still *this job's* PR, and a stale typo'd url must never be the reason a
 * second one is opened.
 */
export function ghPrListArgs(branch: string, ownerRepo?: string): string[] {
	return [
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		"all",
		"--json",
		"url,number,headRefOid",
		...(ownerRepo ? ["--repo", ownerRepo] : []),
	];
}

/** Tolerant of gh's field drift: a row without a url is not a fact. `undefined` is unparseable. */
export function parseGhPrList(stdout: string): GhPrRow[] | undefined {
	const text = stdout.trim();
	if (text.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const rows: GhPrRow[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const url = typeof row.url === "string" ? row.url.trim() : "";
		if (url.length === 0) continue;
		rows.push({
			url,
			...(typeof row.number === "number" ? { number: row.number } : {}),
			...(typeof row.headRefOid === "string" ? { head_sha: row.headRefOid } : {}),
		});
	}
	return rows;
}

export type PrResolution =
	/** Exactly one PR on the branch. `correction` is set when it differed from the worker's url. */
	| { status: "verified"; url: string; number?: number; correction?: string }
	/** gh (or the origin remote) could not be asked; the url is kept and marked. */
	| { status: "unverified"; url: string; message: string }
	/** The envelope must not be accepted with this url. */
	| { status: "refused"; reason: string };

export interface PrResolveInput {
	/** The job's own branch: the one the dispatch cut, not the worker's own claim. */
	branch: string;
	/** gh's cwd — the job's worktree, whose origin is the project's remote. */
	cwd: string;
	/** The worker's `pr_url`, when the envelope carried one. */
	given?: string;
	/** `cp_dispatch pr` bound this job to that PR: resolve it by number (`gh pr view`), never by `--head` listing. */
	bound?: { number: number; url: string };
}

export interface PrResolveOptions {
	/**
	 * `owner/repo` from the project's origin remote (`githubRepoFromCloneUrl`). Absent
	 * means the origin remote is missing or is not a GitHub remote, so there is nothing to
	 * check the worker's url against — and nothing to aim gh at.
	 */
	ownerRepo?: string;
	/** Injected in tests; `runCommand` in production. */
	exec?: CommandRunner;
	timeoutMs?: number;
	/**
	 * Forge PR 3: the project's GitLab observer (src/forge-runtime.ts). Present means a
	 * GitLab project: the supplied MR url is read and checked, never a branch listing,
	 * and neither `gh` nor `ownerRepo` is consulted.
	 */
	gitlab?: ForgeObserver;
}

function unverified(url: string, why: string): PrResolution {
	return { status: "unverified", url, message: `pr_url unverified: ${url} — ${why}` };
}

/**
 * The worker's url is unverified either way; the only question is whether it is even
 * allowed to survive. A mismatch with the origin remote is a refusal, because the correct
 * `owner/repo` is known and the worker's url is known not to be this project's.
 */
function fallback(input: PrResolveInput, ownerRepo: string, given: string | undefined, why: string): PrResolution {
	const expected = `the expected owner/repo is ${ownerRepo} (the origin remote)`;
	if (!given) {
		return {
			status: "refused",
			reason: `gh could not be asked (${why}) and the envelope carried no pr_url to check; open the PR on branch "${input.branch}" in ${ownerRepo} and report its url`,
		};
	}
	const target = parsePrUrl(given);
	const actual = target ? `${target.owner}/${target.repo}` : undefined;
	if (!actual) {
		return {
			status: "refused",
			reason: `pr_url ${given} is not a GitHub pull request url and gh could not be asked (${why}); ${expected}, on branch "${input.branch}"`,
		};
	}
	if (actual.toLowerCase() !== ownerRepo.toLowerCase()) {
		return {
			status: "refused",
			reason: `pr_url ${given} names ${actual}, but the origin remote is ${ownerRepo} — ${expected}; gh could not be asked to confirm it (${why})`,
		};
	}
	return unverified(given, `gh could not be asked (${why}), so the PR itself was not read; ${given} names ${actual}, the origin remote's repo`);
}

export async function resolvePr(input: PrResolveInput, options: PrResolveOptions = {}): Promise<PrResolution> {
	if (options.gitlab) return resolveGitlab(input, options.gitlab);
	const ownerRepo = options.ownerRepo?.trim() || undefined;
	const given = input.given?.trim() || undefined;
	if (!ownerRepo) {
		if (!given) {
			return {
				status: "refused",
				reason: `no origin remote could be read for this project and the envelope carried no pr_url; report the PR url on branch "${input.branch}"`,
			};
		}
		return unverified(given, "the origin remote could not be read as a GitHub repo, so gh was not asked and nothing was checked");
	}

	const exec = options.exec ?? runCommand;
	if (input.bound) return resolveBound(input, input.bound, ownerRepo, given, exec, options.timeoutMs);
	let stdout: string;
	try {
		stdout = await exec("gh", ghPrListArgs(input.branch, ownerRepo), {
			cwd: input.cwd,
			timeoutMs: options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
		});
	} catch (error) {
		return fallback(input, ownerRepo, given, error instanceof Error ? error.message : String(error));
	}
	const rows = parseGhPrList(stdout);
	if (!rows) {
		return fallback(input, ownerRepo, given, "gh returned output that is not a PR list");
	}
	if (rows.length === 0) {
		return {
			status: "refused",
			reason: `no PR is on branch "${input.branch}" in ${ownerRepo} — open the PR and report again; the expected owner/repo is ${ownerRepo}`,
		};
	}
	if (rows.length > 1) {
		const urls = rows.map((row) => row.url).join(", ");
		return {
			status: "refused",
			reason: `${rows.length} PRs are on branch "${input.branch}" in ${ownerRepo}: ${urls} — exactly one PR must be this job's delivery; close the others or name the right one`,
		};
	}
	const row = rows[0] as GhPrRow;
	return {
		status: "verified",
		url: row.url,
		...(row.number !== undefined ? { number: row.number } : {}),
		...(given && given !== row.url ? { correction: `pr_url corrected: ${given} -> ${row.url}` } : {}),
	};
}

/**
 * picp-d0p: a job `cp_dispatch pr` bound to an existing PR. Its branch may carry several
 * historical PRs, so the PR is read by number and must still be on the job's branch; a
 * worker url naming another PR or repo is refused.
 */
async function resolveBound(
	input: PrResolveInput,
	bound: { number: number; url: string },
	ownerRepo: string,
	given: string | undefined,
	exec: CommandRunner,
	timeoutMs: number | undefined,
): Promise<PrResolution> {
	const target = given ? parsePrUrl(given) : undefined;
	if (target && (target.number !== bound.number || `${target.owner}/${target.repo}`.toLowerCase() !== ownerRepo.toLowerCase())) {
		return { status: "refused", reason: `pr_url ${given} is not the bound PR ${bound.url} (${ownerRepo}#${bound.number}) — report the bound PR's url` };
	}
	let stdout: string;
	try {
		stdout = await exec("gh", ["pr", "view", String(bound.number), "--repo", ownerRepo, "--json", "url,number,headRefName"], {
			cwd: input.cwd,
			timeoutMs: timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS,
		});
	} catch (error) {
		return fallback(input, ownerRepo, given, error instanceof Error ? error.message : String(error));
	}
	let row: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(stdout.trim());
		row = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		row = undefined;
	}
	const url = typeof row?.url === "string" ? row.url.trim() : "";
	if (!row || url.length === 0) return fallback(input, ownerRepo, given, "gh returned output that is not a PR");
	if (row.headRefName !== input.branch) {
		return {
			status: "refused",
			reason: `bound PR ${url} is on branch "${String(row.headRefName)}", not this job's branch "${input.branch}" — the PR's head moved; re-dispatch or have a human finish it`,
		};
	}
	return {
		status: "verified",
		url,
		number: bound.number,
		...(given && given !== url ? { correction: `pr_url corrected: ${given} -> ${url}` } : {}),
	};
}

/**
 * Forge PR 3: a GitLab project's MR, from the url the worker reported (or the bound
 * reference), read by its IID through the project's observer. Verified only when the
 * forge itself names this project and this job's branch; a forge that cannot be asked
 * leaves a same-project url explicitly unverified. v1 never searches branches for an MR.
 */
async function resolveGitlab(input: PrResolveInput, observer: ForgeObserver): Promise<PrResolution> {
	const given = input.given?.trim() || input.bound?.url.trim() || undefined;
	if (!given) {
		return { status: "refused", reason: `a GitLab project's MR is never searched for: open the merge request from branch "${input.branch}" and report its url as pr_url` };
	}
	if (parseChangeRequestUrl(given)?.kind !== "gitlab") {
		return { status: "refused", reason: `pr_url ${given} is not a GitLab merge request url (https://<host>/<namespace>/-/merge_requests/<iid>), and this project lives on GitLab` };
	}
	const read = await observer.readChangeRequest(given);
	if (!read.ok) {
		// The observer refuses another project's url as "mismatch" before asking; these two mean the url is this project's but the answer was not usable.
		if (read.reason === "unavailable" || read.reason === "invalid") return unverified(given, `GitLab gave no usable answer (${read.detail}), so the MR itself was not read; ${given} names this project`);
		return { status: "refused", reason: `pr_url ${given} is not this project's merge request (${read.reason}: ${read.detail}); report the MR from branch "${input.branch}"` };
	}
	const mr = read.observation;
	if (mr.source_branch !== input.branch) {
		return { status: "refused", reason: `MR ${mr.url} is from branch "${mr.source_branch ?? "unknown"}", not this job's branch "${input.branch}" — report the MR opened from "${input.branch}"` };
	}
	return { status: "verified", url: mr.url, number: mr.number, ...(given !== mr.url ? { correction: `pr_url corrected: ${given} -> ${mr.url}` } : {}) };
}
