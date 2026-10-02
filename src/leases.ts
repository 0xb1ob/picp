/**
 * Worktree leases — a thin, fail-closed wrapper around `treehouse`.
 *
 * Ported policy (command-post `cmdp lease` / `cmdp teardown`):
 *
 *  - `treehouse get --lease` runs **from the canonical clone**; the printed
 *    path is the lease, and it is a *value that gets passed around*, never a
 *    path someone retypes. `acquire()` returns a `Lease`, `release()` takes
 *    one back. There is no string overload on purpose.
 *  - `treehouse return --force` runs **from outside the worktree** (the home),
 *    and is refused when the command post home or the process cwd lives inside
 *    the worktree being returned.
 *  - **No silent `git worktree add`.** Missing treehouse is a hard error: a
 *    hand-rolled worktree would sit outside the pool, outside the lease state,
 *    and outside every safety check that follows.
 *
 * Improvement over the port, enabled by modern treehouse: `--json` gives a
 * `lease_id`, and `return --if-lease-id` uses it, so a teardown can never
 * return a worktree that somebody else has since leased. When treehouse is too
 * old to print JSON we degrade to the path-only behaviour and say so.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ENV_TREEHOUSE_ROOT, isInside } from "./contracts.ts";
import { canonicalDir } from "./json-store.ts";

export class LeaseError extends Error {}

export const DEFAULT_TREEHOUSE_TIMEOUT_MS = 120_000;

/**
 * A held worktree. Only `acquire()` and `leaseFromRecord()` may produce one —
 * that is the path binding rule in type form.
 */
export interface Lease {
	/**
	 * The worktree path **exactly as treehouse printed it**. It is treehouse's
	 * key for this worktree, so it is never rewritten, normalized or retyped —
	 * comparisons canonicalize a copy instead.
	 */
	path: string;
	/** treehouse lease identity, when treehouse reported one. */
	lease_id?: string;
	lease_holder?: string;
	leased_at?: string;
	/** The canonical clone this lease came from. */
	clone: string;
	project?: string;
}

export interface LeaseManagerOptions {
	/** Command post home; `return` runs from here (never from the worktree). */
	home: string;
	treehouseBin?: string;
	gitBin?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	/**
	 * The treehouse pool root this home leases from (`CP_TREEHOUSE_ROOT`), passed
	 * as `--root` on every treehouse invocation.
	 *
	 * **Unset is not a default value, it is the absence of a flag**: the argv
	 * contains no `--root` at all, so treehouse resolves the pool exactly as it
	 * always has (its config, then `TREEHOUSE_ROOT`, then `~/.treehouse`). That
	 * is the backwards-compatibility contract for a single-home machine, pinned
	 * by a test.
	 *
	 * It exists because the pool is keyed by clone-dir basename plus a hash of
	 * the origin URL, so two homes that clone one remote into `projects/<name>`
	 * draw slots from ONE pool and can be handed each other's worktrees
	 * (cp-b8el Experiment B; `#verify` then fails closed and returns the lease).
	 * Must be absolute: treehouse resolves a relative `--root` from the *repo*
	 * root, which would give every clone its own pool instead of the home one.
	 */
	poolRoot?: string;
	/** Injected in tests; production execs the real binaries. */
	runner?: (bin: string, args: readonly string[], cwd: string) => Promise<ExecResult>;
	/** Injected in tests: how we decide the process cwd for the outside check. */
	cwd?: () => string;
}

export interface ExecResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface AcquireOptions {
	/** Recorded as the treehouse lease holder (we use the job id). */
	holder?: string;
	project?: string;
}

/**
 * Rebuild a lease value from persisted fleet state. This is the ONLY other way
 * to obtain a `Lease`, and it exists because a parent restart must still be
 * able to return what a previous parent leased.
 */
export function leaseFromRecord(record: {
	worktree: string;
	clone?: string;
	lease_id?: string;
	project?: string;
}): Lease {
	if (!isAbsolute(record.worktree)) {
		throw new LeaseError(`lease path must be absolute, got ${JSON.stringify(record.worktree)}`);
	}
	return {
		path: record.worktree,
		clone: record.clone ?? "",
		...(record.lease_id ? { lease_id: record.lease_id } : {}),
		...(record.project ? { project: record.project } : {}),
	};
}

/**
 * `CP_TREEHOUSE_ROOT` as `LeaseManagerOptions` — spread it, do not read it.
 *
 * It returns an **empty object** when the variable is unset or empty, so the
 * key is omitted from the options rather than present-and-undefined: `exactly
 * one` of "this home has its own pool" and "treehouse decides, as always" can
 * be true, and an explicit `poolRoot: undefined` reads like a decision nobody
 * made. An empty string is the same fact as unset (an operator exporting an
 * empty var has configured nothing).
 */
export function resolvePoolRoot(env: NodeJS.ProcessEnv = process.env): { poolRoot?: string } {
	const raw = env[ENV_TREEHOUSE_ROOT];
	const value = typeof raw === "string" ? raw.trim() : "";
	return value.length > 0 ? { poolRoot: value } : {};
}

export class LeaseManager {
	readonly home: string;
	readonly #options: LeaseManagerOptions;

	constructor(options: LeaseManagerOptions) {
		this.home = canonicalDir(options.home);
		if (options.poolRoot !== undefined && !isAbsolute(options.poolRoot)) {
			throw new LeaseError(
				`${ENV_TREEHOUSE_ROOT} must be an absolute path, got ${JSON.stringify(options.poolRoot)}: treehouse resolves a relative --root from the repo root, so every clone would get its own pool instead of this home's`,
			);
		}
		this.#options = options;
	}

	get treehouseBin(): string {
		return this.#options.treehouseBin ?? "treehouse";
	}

	/** The pool root this manager leases from, or `undefined` for treehouse's own. */
	get poolRoot(): string | undefined {
		return this.#options.poolRoot;
	}

	/**
	 * Acquire a worktree for `clonePath` (which must already be the verified
	 * canonical clone — T10 owns that check).
	 *
	 * Post-conditions, all fail-closed: the printed path exists, is a
	 * directory, is a git worktree of *this* clone, and is not the clone
	 * itself. A lease that fails them is returned immediately rather than
	 * handed to a worker.
	 */
	async acquire(clonePath: string, options: AcquireOptions = {}): Promise<Lease> {
		const clone = canonicalDir(clonePath);
		if (!isDirectory(clone)) {
			throw new LeaseError(`cannot lease from ${clone}: not a directory (register and clone the project first)`);
		}
		const args = ["get", "--lease", "--json"];
		if (options.holder) args.push("--lease-holder", options.holder);
		const result = await this.#treehouse(args, clone);
		if (result.status !== 0) {
			throw new LeaseError(
				`treehouse get --lease failed in ${clone} (exit ${result.status ?? "null"}): ${firstLine(result.stderr) || firstLine(result.stdout) || "no output"} — register the canonical clone and retry`,
			);
		}
		const parsed = parseLeaseOutput(result.stdout);
		if (!parsed.path) {
			throw new LeaseError(
				`treehouse get --lease printed no path in ${clone} — expected the absolute worktree on stdout`,
			);
		}
		if (!isDirectory(parsed.path)) {
			throw new LeaseError(
				`treehouse get --lease printed ${parsed.path}, which is not a directory — check the clone registration`,
			);
		}
		const lease: Lease = {
			path: parsed.path,
			clone,
			...(parsed.lease_id ? { lease_id: parsed.lease_id } : {}),
			...(parsed.lease_holder ? { lease_holder: parsed.lease_holder } : {}),
			...(parsed.leased_at ? { leased_at: parsed.leased_at } : {}),
			...(options.project ? { project: options.project } : {}),
		};

		const problem = await this.#verify(lease);
		if (problem) {
			// Never hand out a lease we cannot vouch for; give it straight back.
			await this.release(lease, { ignoreErrors: true });
			throw new LeaseError(problem);
		}
		return lease;
	}

	/**
	 * Return a lease. Runs `treehouse return --force` from the home, refuses to
	 * run from inside the worktree, and — when we know the lease identity —
	 * refuses to return a worktree that has since been leased by somebody else.
	 */
	async release(lease: Lease, options: { ignoreErrors?: boolean } = {}): Promise<void> {
		this.#assertOutside(lease.path);
		const args = ["return", "--force"];
		if (lease.lease_id) args.push("--if-lease-id", lease.lease_id);
		// Verbatim: treehouse looks this worktree up by the path it handed out.
		args.push(lease.path);
		const result = await this.#treehouse(args, this.home);
		if (result.status !== 0 && !options.ignoreErrors) {
			throw new LeaseError(
				`treehouse return --force failed for ${lease.path} (exit ${result.status ?? "null"}): ${firstLine(result.stderr) || firstLine(result.stdout) || "no output"} — the lease may still be held; retry from ${this.home}`,
			);
		}
	}

	/** Is this path still a worktree of that clone? (cheap teardown pre-check) */
	async belongsTo(worktree: string, clone: string): Promise<boolean> {
		const wt = canonicalDir(worktree);
		const cloneCommon = await this.#gitCommonDir(canonicalDir(clone));
		const wtCommon = await this.#gitCommonDir(wt);
		return cloneCommon !== undefined && wtCommon !== undefined && cloneCommon === wtCommon;
	}

	// -- internals ----------------------------------------------------------

	/** The worktree must be a linked worktree of this clone, and not the clone. */
	async #verify(lease: Lease): Promise<string | undefined> {
		if (canonicalDir(lease.path) === canonicalDir(lease.clone)) {
			return `treehouse handed back the clone itself (${lease.path}); a job needs a linked worktree, not the primary checkout`;
		}
		const cloneCommon = await this.#gitCommonDir(lease.clone);
		const wtCommon = await this.#gitCommonDir(lease.path);
		if (!wtCommon) return `${lease.path} is not a git worktree`;
		if (!cloneCommon) return `cannot resolve git-common-dir for ${lease.clone}`;
		if (wtCommon !== cloneCommon) {
			return `${lease.path} belongs to another repo (git-common-dir ${wtCommon}, expected ${cloneCommon})`;
		}
		return undefined;
	}

	async #gitCommonDir(cwd: string): Promise<string | undefined> {
		if (!isDirectory(cwd)) return undefined;
		const result = await this.#exec(this.#options.gitBin ?? "git", ["rev-parse", "--git-common-dir"], cwd);
		if (result.status !== 0) return undefined;
		const raw = result.stdout.trim();
		if (raw.length === 0) return undefined;
		return canonicalDir(isAbsolute(raw) ? raw : resolve(cwd, raw));
	}

	/**
	 * Teardown runs from outside. Returning a worktree while standing in it
	 * leaves the shell (and the home) on a deleted path.
	 */
	#assertOutside(worktree: string): void {
		// Canonicalize copies for the comparison only; the lease path itself stays
		// exactly as treehouse printed it.
		const wt = canonicalDir(worktree);
		const home = canonicalDir(this.home);
		if (home === wt || isInside(home, wt)) {
			throw new LeaseError(
				`refusing to return ${worktree}: the command post home ${home} is inside it — teardown must run from outside the worktree`,
			);
		}
		const cwd = canonicalDir((this.#options.cwd ?? (() => process.cwd()))());
		if (cwd === wt || isInside(cwd, wt)) {
			throw new LeaseError(
				`refusing to return ${worktree}: the current directory ${cwd} is inside it — teardown must run from outside the worktree`,
			);
		}
	}

	/**
	 * Every treehouse call goes through here, which is what makes the pool root
	 * a property of the manager rather than of a call site: `get` and `return`
	 * cannot disagree about which pool they are talking to, and a lease returned
	 * to the wrong pool is a leak.
	 */
	async #treehouse(args: readonly string[], cwd: string): Promise<ExecResult> {
		const poolRoot = this.#options.poolRoot;
		// `--root` is a treehouse-global flag, so it leads the argv. Unset means
		// the flag is absent entirely (see `poolRoot` on the options).
		return this.#exec(this.treehouseBin, poolRoot ? ["--root", poolRoot, ...args] : args, cwd, true);
	}

	async #exec(bin: string, args: readonly string[], cwd: string, isTreehouse = false): Promise<ExecResult> {
		const runner = this.#options.runner;
		if (runner) return runner(bin, args, cwd);
		if (!isDirectory(cwd)) {
			// ENOENT from exec is ambiguous (missing binary vs missing cwd); say which.
			throw new LeaseError(`cannot run ${bin} ${args[0] ?? ""}: working directory ${cwd} does not exist`);
		}
		return new Promise<ExecResult>((resolvePromise, reject) => {
			execFile(
				bin,
				[...args],
				{
					cwd,
					timeout: this.#options.timeoutMs ?? DEFAULT_TREEHOUSE_TIMEOUT_MS,
					env: this.#options.env ?? process.env,
					maxBuffer: 8 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(
							isTreehouse
								? new LeaseError(
										`${bin} not on PATH — leases require treehouse. There is no fallback: a hand-rolled "git worktree add" would sit outside the pool and outside the lease state.`,
									)
								: new LeaseError(`${bin} not on PATH`),
						);
						return;
					}
					const status =
						error && typeof (error as { code?: unknown }).code === "number"
							? (error as unknown as { code: number }).code
							: error
								? 1
								: 0;
					resolvePromise({ status, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				},
			);
		});
	}
}

export interface ParsedLeaseOutput {
	path?: string;
	lease_id?: string;
	lease_holder?: string;
	leased_at?: string;
}

/**
 * `treehouse get --lease --json` prints one JSON object on stdout (banners go
 * to stderr). Older treehouse prints only the path; we accept that and lose
 * the lease identity, which `release()` then cannot assert.
 */
export function parseLeaseOutput(stdout: string): ParsedLeaseOutput {
	const lines = stdout
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	for (const line of [...lines].reverse()) {
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as ParsedLeaseOutput;
			if (typeof parsed.path === "string" && parsed.path.length > 0) return parsed;
		} catch {
			// fall through to the path-only form
		}
	}
	const last = lines.at(-1);
	return last && isAbsolute(last) ? { path: last } : {};
}

function isDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function firstLine(text: string): string {
	return (
		text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.at(-1) ?? ""
	);
}
