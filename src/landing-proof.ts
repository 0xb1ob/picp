/**
 * Git-only landing proof (forge PR 2): did this job's final content land in
 * the base's reachable history — without asking any forge?
 *
 * The answer is about content, never about a merge request: a `landed` result
 * proves every path the job changed exists, exactly as HEAD has it, at one
 * commit reachable from the base tip origin advertises. It does not say a PR or
 * MR merged, so it never writes a merge receipt and never names a forge state.
 *
 * Order (cheapest first): ancestry of HEAD to the advertised base tip; whole
 * tree equality with that tip; then the historical path-tree search — the
 * single merge base of HEAD and the tip, HEAD's complete changed-path set since
 * it, and the first commit on the ancestry path fork..tip whose blobs, modes,
 * deletions and gitlinks equal HEAD's on ALL of those paths at once. Separate
 * witnesses for separate paths are never combined.
 *
 * Fail closed: the base sha comes from `git ls-remote` (a remote-tracking ref
 * never authorizes a pass); a missing object is fetched by exact sha with no
 * ref destination, and nothing else — no checkout, reset, commit, index write,
 * push or ref update. A command failure, shallow or ambiguous history, or a
 * budget hit is `unknown` (lease kept, missing proof named); a complete search
 * that found nothing is `not_proven`.
 */

/** `timeoutMs`: kill the child on expiry and answer status null; the proof also stops waiting on its own timer. */
export type GitRun = (cwd: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<{ status: number | null; stdout: string; stderr: string }>;

/** Named bounds; tests inject smaller ones. Engineering limits, not measured promises. */
export const LANDING_LIMITS = {
	candidates: 1024,
	paths: 512,
	outputBytes: 16 * 1024 * 1024,
	commandMs: 10_000,
	fetchMs: 30_000,
};
export type LandingLimits = typeof LANDING_LIMITS;

export type LandingMethod = "ancestry" | "tree" | "path_tree";

export interface LandingEvidence {
	method: LandingMethod;
	/** The exact job HEAD the proof is about. */
	head: string;
	base_branch: string;
	/** The base tip origin advertised (`git ls-remote`), pinned for the whole proof. */
	base_sha: string;
	/** The reachable base commit that carries HEAD's content. */
	witness: string;
	fork?: string;
	paths?: number;
	candidates?: number;
	observed_at: string;
}

export type LandingProof =
	| { result: "landed"; evidence: LandingEvidence }
	| { result: "not_proven"; detail: string }
	| { result: "unknown"; detail: string };

export interface LandingOptions {
	limits?: Partial<LandingLimits>;
	/** Milliseconds, for the budgets; injected so tests never sleep. */
	clock?: () => number;
	now?: () => Date;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIFF = ["--no-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"];

/**
 * What origin says a branch's tip is: `sha` when it exists there, no sha when
 * origin answered without it, `ok: false` when origin could not be asked —
 * never treated as absence, never replaced by a remote-tracking ref.
 */
export async function remoteTip(git: GitRun, cwd: string, branch: string, remote = "origin"): Promise<{ ok: true; sha?: string } | { ok: false; error: string }> {
	const result = await git(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
	if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout).trim().split("\n")[0] || "git ls-remote failed" };
	const line = result.stdout
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.endsWith(`refs/heads/${branch}`));
	const sha = line?.split(/\s+/)[0];
	return sha ? { ok: true, sha } : { ok: true };
}

/** Make sure `sha` is a local commit: fetch exactly that object (no ref written) when it is not. */
export async function haveCommit(git: GitRun, cwd: string, sha: string): Promise<boolean> {
	const present = async () => (await git(cwd, ["cat-file", "-e", `${sha}^{commit}`])).status === 0;
	if (await present()) return true;
	const fetched = await git(cwd, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", sha]);
	return fetched.status === 0 && (await present());
}

class Unknown extends Error {}

/** One git call bounded by `ms`: the runner is asked to kill its child, and a runner that never answers still ends here. */
function timed(git: GitRun, ms: number): GitRun {
	return (cwd, args) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<{ status: null; stdout: string; stderr: string }>((resolve) => {
			timer = setTimeout(() => resolve({ status: null, stdout: "", stderr: `timed out after ${ms} ms` }), ms);
		});
		return Promise.race([git(cwd, args, { timeoutMs: ms }), expired]).finally(() => clearTimeout(timer));
	};
}

export async function readLandingProof(git: GitRun, worktree: string, head: string, base: string, options: LandingOptions = {}): Promise<LandingProof> {
	const limits = { ...LANDING_LIMITS, ...options.limits };
	const clock = options.clock ?? Date.now;
	const remote = timed(git, limits.fetchMs);
	let started = 0; // the local budget starts once the remote phase (ls-remote, fetch) is over
	let output = 0;
	const run = async (args: readonly string[], allowed: readonly number[] = [0]) => {
		const elapsed = clock() - started;
		if (elapsed > limits.commandMs) throw new Unknown(`the proof exceeded its ${limits.commandMs} ms budget`);
		const result = await timed(git, limits.commandMs - elapsed)(worktree, args);
		output += result.stdout.length;
		if (output > limits.outputBytes) throw new Unknown(`git output exceeded the ${limits.outputBytes}-byte budget`);
		if (result.status === null || !allowed.includes(result.status)) {
			throw new Unknown(`git ${args[0]} failed (${(result.stderr || result.stdout).trim().split("\n")[0]?.slice(0, 200) || `exit ${result.status}`})`);
		}
		return result;
	};
	try {
		const tip = await remoteTip(remote, worktree, base);
		if (!tip.ok) return { result: "unknown", detail: `origin could not be asked about ${base} (${tip.error})` };
		if (!tip.sha || !SHA.test(tip.sha)) return { result: "unknown", detail: `origin advertises no ${base} branch to compare with` };
		const baseSha = tip.sha;
		const fetchStarted = clock();
		if (!(await haveCommit(remote, worktree, baseSha))) return { result: "unknown", detail: `origin/${base} tip ${baseSha.slice(0, 12)} is not available locally and could not be fetched within ${limits.fetchMs} ms` };
		if (clock() - fetchStarted > limits.fetchMs) return { result: "unknown", detail: `fetching origin/${base} exceeded its ${limits.fetchMs} ms budget` };
		started = clock();
		const landed = (method: LandingMethod, witness: string, extra: Partial<LandingEvidence> = {}): LandingProof => ({
			result: "landed",
			evidence: { method, head, base_branch: base, base_sha: baseSha, witness, ...extra, observed_at: (options.now ?? (() => new Date()))().toISOString() },
		});

		if ((await run(["merge-base", "--is-ancestor", head, baseSha], [0, 1])).status === 0) return landed("ancestry", baseSha);
		if ((await run(["diff", "--name-only", "-z", ...DIFF, head, baseSha])).stdout.length === 0) return landed("tree", baseSha);

		if ((await run(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true") {
			return { result: "unknown", detail: "this clone is shallow, so the history since the fork is incomplete" };
		}
		const forks = (await run(["merge-base", "--all", head, baseSha], [0, 1])).stdout.split("\n").filter(Boolean);
		if (forks.length !== 1) return { result: "unknown", detail: forks.length === 0 ? `HEAD and origin/${base} share no history` : `HEAD and origin/${base} have ${forks.length} merge bases` };
		const fork = forks[0] as string;
		const paths = (await run(["diff", "--name-only", "-z", ...DIFF, fork, head])).stdout.split("\0").filter(Boolean);
		if (paths.length === 0) return { result: "unknown", detail: "HEAD changes nothing since its fork, so there is no content to find" };
		if (paths.length > limits.paths) return { result: "unknown", detail: `HEAD changes ${paths.length} paths, over the ${limits.paths}-path limit` };

		const listed = (await run(["rev-list", "--ancestry-path", `--max-count=${limits.candidates + 1}`, `${fork}..${baseSha}`])).stdout.split("\n").filter(Boolean);
		const truncated = listed.length > limits.candidates;
		const candidates = [baseSha, ...listed.filter((sha) => sha !== baseSha)].slice(0, limits.candidates);
		// shortcut: every path rides one argv; a job past ~1 MB of path names hits ARG_MAX and reads as unknown, which keeps the lease.
		const pathspecs = paths.map((path) => `:(literal)${path}`);
		for (const candidate of candidates) {
			if ((await run(["diff", "--quiet", ...DIFF, head, candidate, "--", ...pathspecs], [0, 1])).status !== 0) continue;
			if ((await run(["merge-base", "--is-ancestor", candidate, baseSha], [0, 1])).status !== 0) {
				return { result: "unknown", detail: `witness ${candidate.slice(0, 12)} is not reachable from origin/${base}` };
			}
			return landed("path_tree", candidate, { fork, paths: paths.length, candidates: candidates.indexOf(candidate) + 1 });
		}
		if (truncated) return { result: "unknown", detail: `no witness in the first ${limits.candidates} commits of origin/${base} since the fork (search limit)` };
		return { result: "not_proven", detail: `no commit of origin/${base} since the fork carries all ${paths.length} changed path(s) as HEAD has them` };
	} catch (error) {
		if (error instanceof Unknown) return { result: "unknown", detail: error.message };
		throw error;
	}
}
