/**
 * Watch `origin/main`'s own CI; a red main pauses `cp_integrate` (pi-command-post-k52).
 *
 * #325 merged and main went red with nobody told: the CI watch (`src/ci-watch.ts`)
 * covers held PR heads only. This module is the missing half, per the settled spec
 * (operator/tasks/k52-main-ci-watch.md):
 *
 * - **Set** on the first red CI conclusion for the current tip, where the tip is
 *   `git rev-parse origin/main` after `git fetch origin main` — never `runs[0]`.
 * - **Clear** only on a green conclusion for that same tip; green on an older sha
 *   never clears.
 * - **Exception while red:** a PR whose pushed head contains `origin/main` and whose
 *   own CI is green on that head still merges (the fix-forward).
 * - **Per project; fail open, but log.** A missing or unreadable `state/main-ci.json`
 *   never blocks a merge, and the tick never overwrites an unreadable file.
 *
 * cp-oc0m: only **this machine's own runs in mandated projects** count —
 * - the tick watches only projects an **active** mandate names (`isActive`:
 *   status active, unexpired); any other project gets no git/gh command at all;
 * - a run counts only when its `triggering_actor` is this machine's gh login
 *   (`gh api user --jq .login`, once per process); `event: dynamic` runs
 *   (Dependabot Updates) and every other user's or bot's run are ignored;
 * - a row records the `login` it was latched for; `cp_integrate` enforces only an
 *   own row in a mandated project, and an unreadable login fails open (logged).
 *
 * A row in `state/main-ci.json` exists iff that project's main is latched red. The
 * CI-watch tick (`surfaceCi`) is the only writer; `cp_integrate` only reads. Wakes
 * are transition-only: one on red, one on green again, one when a foreign or
 * pre-cp-oc0m row is released.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, isoTimestamp, LAYOUT, type Mandate, SCHEMA_VERSION, validate } from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import { isActive } from "./mandate-accounting.ts";
import { type CiRun, type CommandRunner, evaluateMergeAskCi, MERGE_ASK_QUERY_TIMEOUT_MS, parseCiRuns, readCiForHead, runCommand, shaMatches } from "./merge-ask.ts";

const MainCiEntrySchema = Type.Object(
	{
		project: Type.String({ minLength: 1, maxLength: 200 }),
		red_since_sha: Type.String({ pattern: "^[0-9a-f]{7,64}$" }),
		red_since_at: IsoTimestampSchema,
		workflow: Type.Optional(Type.String({ maxLength: 200 })),
		failing: Type.Optional(Type.String({ maxLength: 300 })),
		/** cp-oc0m: the gh login whose own run latched this row; absent on rows written before. */
		login: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	},
	{ additionalProperties: false },
);
export type MainCiEntry = Static<typeof MainCiEntrySchema>;
const MainCiFileSchema = Type.Object(
	{ schema_version: Type.Integer({ minimum: 1 }), updated_at: IsoTimestampSchema, projects: Type.Array(MainCiEntrySchema) },
	{ additionalProperties: false },
);
export type MainCiFile = Static<typeof MainCiFileSchema>;

export class MainCiError extends Error {}

export function mainCiFile(home: string): string {
	return join(canonicalDir(home), LAYOUT.state, "main-ci.json");
}

/** `state/main-ci.json`: one row per project whose main is latched red. */
export class MainCiStore {
	readonly file: string;
	readonly #now: () => Date;

	constructor(options: { home: string; now?: () => Date }) {
		this.file = mainCiFile(options.home);
		this.#now = options.now ?? (() => new Date());
	}

	/** A missing file is ok and empty; anything unparsable or off-schema is `ok: false`. */
	read(): { ok: true; file: MainCiFile } | { ok: false; error: string } {
		if (!existsSync(this.file)) return { ok: true, file: { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), projects: [] } };
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			return { ok: false, error: `state/main-ci.json unreadable (${(error as Error).message.slice(0, 200)})` };
		}
		const parsed = validate<MainCiFile>(MainCiFileSchema, raw);
		if (!parsed.ok) return { ok: false, error: `state/main-ci.json unreadable (schema: ${parsed.errors.join("; ").slice(0, 200)})` };
		return { ok: true, file: parsed.value };
	}

	/** The latch row, or `undefined` when not latched or the file is unreadable. */
	entry(project: string): MainCiEntry | undefined {
		const read = this.read();
		return read.ok ? read.file.projects.find((row) => row.project === project) : undefined;
	}

	/** Set the latch. A no-op when already set for the same login: `red_since_*` never resets. A row for another (or no) login is replaced. */
	setRed(project: string, sha: string, extra: { workflow?: string; failing?: string; login?: string } = {}): void {
		const rows = this.#rows();
		const existing = rows.find((row) => row.project === project);
		if (existing && sameLogin(existing.login, extra.login)) return;
		const row: MainCiEntry = {
			project,
			red_since_sha: sha.trim().toLowerCase(),
			red_since_at: isoTimestamp(this.#now()),
			...(extra.workflow ? { workflow: extra.workflow.slice(0, 200) } : {}),
			...(extra.failing ? { failing: extra.failing.slice(0, 300) } : {}),
			...(extra.login ? { login: extra.login } : {}),
		};
		this.#write([...rows.filter((entry) => entry.project !== project), row]);
	}

	/** Clear the latch. A no-op when it was not set. */
	clear(project: string): void {
		const rows = this.#rows();
		if (!rows.some((row) => row.project === project)) return;
		this.#write(rows.filter((row) => row.project !== project));
	}

	/** Never overwrite an unreadable file: that would drop other projects' rows and re-fire their wakes. */
	#rows(): MainCiEntry[] {
		const read = this.read();
		if (!read.ok) throw new MainCiError(`${read.error}; not overwritten — fix or delete ${this.file}`);
		return read.file.projects;
	}

	#write(projects: MainCiEntry[]): void {
		const parsed = validate<MainCiFile>(MainCiFileSchema, { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(this.#now()), projects });
		if (!parsed.ok) throw new MainCiError(`refusing to write an invalid main-ci.json: ${parsed.errors.join("; ")}`);
		atomicWriteJson(this.file, parsed.value);
	}
}

/** One red or green transition for one project. */
export interface MainCiObservation {
	project: string;
	event: "main_ci_failed" | "main_ci_green" | "main_ci_released";
	sha: string;
	reason: string;
	workflow?: string;
	failing?: string;
}

/** Case-insensitive; two absent logins are the same (a pre-cp-oc0m row set twice). */
function sameLogin(a: string | undefined, b: string | undefined): boolean {
	return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

/** A main-branch run from the REST endpoint: a `CiRun` plus what decides whether it counts. */
export type MainRun = CiRun & { event?: string; triggeringActor?: string };

const MAIN_RUNS_JQ = "[.workflow_runs[] | {status, conclusion, headSha: .head_sha, workflowName: .name, databaseId: .id, attempt: .run_attempt, event, triggeringActor: .triggering_actor.login}]";

/** One GET for the tip's runs: `gh run list --json` has no triggering actor. `execFile` passes no shell, so nothing needs quoting. */
export function mainRunsArgs(tip: string): string[] {
	return ["api", `repos/{owner}/{repo}/actions/runs?branch=main&head_sha=${tip}&per_page=100`, "--jq", MAIN_RUNS_JQ];
}

/** `parseCiRuns`' tolerance, plus `event` / `triggeringActor` when they are strings. Invalid JSON throws. */
export function parseMainRuns(stdout: string): MainRun[] {
	const text = stdout.trim();
	if (text.length === 0) return [];
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	return parsed.flatMap((entry: unknown): MainRun[] => {
		const [run] = parseCiRuns(JSON.stringify([entry]));
		if (!run) return [];
		const row = entry as Record<string, unknown>;
		return [{ ...run, ...(typeof row.event === "string" ? { event: row.event } : {}), ...(typeof row.triggeringActor === "string" ? { triggeringActor: row.triggeringActor } : {}) }];
	});
}

/** The runs that count: not `dynamic` (Dependabot Updates), triggered by this login (case-insensitive). */
export function countedMainRuns(runs: readonly MainRun[], login: string): MainRun[] {
	return runs.filter((run) => run.event !== "dynamic" && run.triggeringActor !== undefined && sameLogin(run.triggeringActor, login));
}

/** The projects some active mandate (`isActive`: status active, unexpired) names. Paused, revoked or expired grants watch nothing. */
export function mandatedProjects(projects: Iterable<string>, mandates: readonly Mandate[], now: string): string[] {
	const covered = new Set(mandates.filter((mandate) => isActive(mandate, now)).flatMap((mandate) => mandate.projects));
	return [...projects].filter((project) => covered.has(project));
}

const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/;

/** `gh api user --jq .login`, once: cached on success, retried on the next call after a failure. */
export function memoLogin(exec: CommandRunner, cwd: string, timeoutMs = MERGE_ASK_QUERY_TIMEOUT_MS): () => Promise<string> {
	let cached: Promise<string> | undefined;
	const read = async (): Promise<string> => {
		let out: string;
		try {
			out = (await exec("gh", ["api", "user", "--jq", ".login"], { cwd, timeoutMs })).trim();
		} catch (error) {
			throw new MainCiError(`gh api user --jq .login unreadable: ${(error as Error).message.slice(0, 200)}`);
		}
		if (!LOGIN_RE.test(out)) throw new MainCiError(`gh api user --jq .login unreadable: answered ${JSON.stringify(out.slice(0, 80))}, not a login`);
		return out;
	};
	return () => {
		cached ??= read().catch((error: unknown) => {
			cached = undefined;
			throw error;
		});
		return cached;
	};
}

/** Whether a project's latch is enforced: an active mandate names it and the login is readable. */
export type MainCiScope = { enforce: true; login: string } | { enforce: false; reason: string };

/** Fails open: an unreadable mandate store or login is `enforce: false` with the reason. */
export async function resolveMainCiScope(options: { project: string; mandates: () => readonly Mandate[]; now: string; login: () => Promise<string> }): Promise<MainCiScope> {
	try {
		if (mandatedProjects([options.project], options.mandates(), options.now).length === 0) return { enforce: false, reason: `no active mandate covers ${options.project}` };
		return { enforce: true, login: await options.login() };
	} catch (error) {
		return { enforce: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Classify CI for the fetched tip only. Red fires on the first completed non-green
 * run on the tip, even while another workflow on it still runs; green needs every
 * run on the tip completed green. Runs on any other sha are ignored.
 */
export function classifyMainTip(tip: string, runs: readonly CiRun[]): { status: "red" | "green" | "unknown"; reason: string; workflow?: string; failingRunId?: number } {
	const head = { sha: tip };
	const tipRuns = runs.filter((run) => shaMatches(run.headSha, tip));
	const completed = tipRuns.filter((run) => run.status === "completed");
	const red = evaluateMergeAskCi({ branch: "main", head, runs: completed });
	if (red.ci === "failed") {
		const failing = completed.find((run) => evaluateMergeAskCi({ branch: "main", head, runs: [run] }).ci === "failed");
		return {
			status: "red",
			reason: red.reason,
			...(failing?.workflowName ? { workflow: failing.workflowName } : {}),
			...(failing?.databaseId !== undefined ? { failingRunId: failing.databaseId } : {}),
		};
	}
	const all = evaluateMergeAskCi({ branch: "main", head, runs: tipRuns });
	return { status: all.ci === "green" ? "green" : "unknown", reason: all.reason };
}

/** `git fetch origin main`, then `git rev-parse origin/main`; throws a named message on any failure. */
export async function readMainTip(cwd: string, exec: CommandRunner, timeoutMs: number): Promise<string> {
	await exec("git", ["fetch", "origin", "main"], { cwd, timeoutMs });
	const tip = (await exec("git", ["rev-parse", "origin/main"], { cwd, timeoutMs })).trim().toLowerCase();
	if (!/^[0-9a-f]{7,64}$/.test(tip)) throw new MainCiError(`git rev-parse origin/main answered ${JSON.stringify(tip.slice(0, 80))}, not a sha`);
	return tip;
}

/** `gh run view <id> --json jobs`: the failing job's name. Best-effort. */
async function failingJobName(cwd: string, runId: number, exec: CommandRunner, timeoutMs: number): Promise<string | undefined> {
	try {
		const parsed = JSON.parse((await exec("gh", ["run", "view", String(runId), "--json", "jobs"], { cwd, timeoutMs })).trim() || "{}") as { jobs?: Array<{ name?: string; conclusion?: string | null }> };
		return (parsed.jobs ?? []).find((job) => job.conclusion && job.conclusion.toLowerCase() !== "success")?.name?.trim() || undefined;
	} catch {
		return undefined; // Degrades to the workflow name; the wake still fires.
	}
}

/** `gh run view <id> --log-failed`: the first failing-test line. A heuristic over log text, best-effort. */
const FAILING_LINE_RE = /(AssertionError|FAIL\b|not ok\b|✖|Error:)/i;
async function failingTestLine(cwd: string, runId: number, exec: CommandRunner, timeoutMs: number): Promise<string | undefined> {
	try {
		const line = (await exec("gh", ["run", "view", String(runId), "--log-failed"], { cwd, timeoutMs })).split("\n").find((row) => FAILING_LINE_RE.test(row));
		if (!line) return undefined;
		// gh's log-failed lines are `<job>\t<step>\t<timestamp> <message>`; keep the message.
		const message = (line.split("\t").pop() ?? line).replace(/^\S+\s+/, "").trim();
		return message.length > 0 ? message.slice(0, 200) : undefined;
	} catch {
		return undefined; // Falls back to the job name.
	}
}

/**
 * One reading for one project, counting only `countedMainRuns` for `login`.
 * Returns an observation only on a transition (absent or foreign → own red,
 * own red → green on the tip, a foreign or login-less row → released); every
 * other reading leaves the latch untouched. Unreadable state, git or gh throws — the caller logs it.
 */
export async function checkMainCi(options: { project: string; cwd: string; store: MainCiStore; login: string; exec?: CommandRunner; timeoutMs?: number }): Promise<MainCiObservation | undefined> {
	const { project, cwd, store, login } = options;
	const exec = options.exec ?? runCommand;
	const timeoutMs = options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS;
	const read = store.read();
	if (!read.ok) throw new MainCiError(`${read.error}; not overwritten`);
	const row = read.file.projects.find((entry) => entry.project === project);
	const own = row !== undefined && row.login !== undefined && sameLogin(row.login, login);
	const tip = await readMainTip(cwd, exec, timeoutMs);
	let runs: MainRun[];
	try {
		runs = parseMainRuns(await exec("gh", mainRunsArgs(tip), { cwd, timeoutMs }));
	} catch (error) {
		throw new MainCiError(`gh api …/actions/runs unreadable: ${(error as Error).message.slice(0, 200)}`);
	}
	const classified = classifyMainTip(tip, countedMainRuns(runs, login));
	if (classified.status === "red" && !own) {
		const id = classified.failingRunId;
		const failing = id === undefined ? undefined : ((await failingTestLine(cwd, id, exec, timeoutMs)) ?? (await failingJobName(cwd, id, exec, timeoutMs)));
		const extra = { ...(classified.workflow ? { workflow: classified.workflow } : {}), ...(failing ? { failing } : {}) };
		store.setRed(project, tip, { ...extra, login });
		return { project, event: "main_ci_failed", sha: tip, reason: classified.reason, ...extra };
	}
	if (classified.status === "green" && own) {
		store.clear(project);
		return { project, event: "main_ci_green", sha: tip, reason: classified.reason };
	}
	if (row && !own) {
		store.clear(project);
		const reason = row.login ? `latched for ${row.login}, this machine is ${login}` : "latched before main CI counted only this machine's own runs";
		return { project, event: "main_ci_released", sha: row.red_since_sha, reason };
	}
	return undefined;
}

/** The operator-facing notice for a main-branch transition. */
export function formatMainCiNotice(observation: MainCiObservation): string {
	const sha = observation.sha.slice(0, 12);
	if (observation.event === "main_ci_green") {
		return `MAIN IS GREEN AGAIN — ${observation.project}: CI passed on ${sha}. Call cp_integrate for held ${observation.project} PRs.`;
	}
	if (observation.event === "main_ci_released") {
		return `MAIN CI LATCH RELEASED — ${observation.project}: red since ${sha} no longer counts (${observation.reason}). Call cp_integrate for held ${observation.project} PRs.`;
	}
	return (
		`MAIN IS RED — ${observation.project}: CI failed on ${sha}${observation.workflow ? ` (${observation.workflow})` : ""}` +
		`${observation.failing ? ` — failing: ${observation.failing}` : ""} — ${observation.reason}\n` +
		`  cp_integrate returns wait for every ${observation.project} PR except one based on the current main with green CI.`
	);
}

/**
 * The main half of the CI-watch tick: every project an active mandate names, with a
 * clone, in sequence. No mandated project → no command at all (not even the login).
 * An unreadable login skips the whole half: one `onError(undefined, …)`, nothing
 * written, nothing enforced. A failure for one project never stops the rest and is
 * never dropped: it goes to `onError`. `send` returning false (a wake not sent) is logged too.
 */
export async function runMainCiTick(options: {
	home: string;
	projects: Iterable<string>;
	pathOf: (project: string) => string;
	mandates: () => readonly Mandate[];
	login: () => Promise<string>;
	now?: () => string;
	exec?: CommandRunner;
	onError: (project: string | undefined, message: string) => void;
	notify: (observation: MainCiObservation, text: string) => void;
	send: (observation: MainCiObservation, text: string) => boolean;
}): Promise<MainCiObservation[]> {
	let projects: string[];
	let login: string;
	try {
		projects = mandatedProjects(options.projects, options.mandates(), (options.now ?? isoTimestamp)());
		if (projects.length === 0) return [];
		login = await options.login();
	} catch (error) {
		options.onError(undefined, `${error instanceof Error ? error.message : String(error)}; main CI watch skipped, latches not enforced`);
		return [];
	}
	const store = new MainCiStore({ home: options.home });
	const observations: MainCiObservation[] = [];
	for (const project of projects) {
		try {
			const cwd = options.pathOf(project);
			if (!existsSync(cwd)) continue;
			const observation = await checkMainCi({ project, cwd, store, login, ...(options.exec ? { exec: options.exec } : {}) });
			if (!observation) continue;
			observations.push(observation);
			const text = formatMainCiNotice(observation);
			options.notify(observation, text);
			if (!options.send(observation, text)) options.onError(project, `main CI wake not sent: ${observation.event} on ${observation.sha.slice(0, 12)}`);
		} catch (error) {
			options.onError(project, error instanceof Error ? error.message : String(error));
		}
	}
	return observations;
}

/**
 * `cp_integrate`'s gate. `hold` set → return `wait` with it; `fact` → record it.
 * Latched red holds unless `origin/main` (freshly fetched by `ancestry`) is an
 * ancestor of the pushed branch AND CI is green on the pushed head. An unreadable
 * latch file fails open, with a fact. cp-oc0m: only a row whose `login` is the current
 * login, in a project with an active mandate (`scope`), is enforced; any other row,
 * or an unreadable login, is a `not blocking` fact. The review and permission gates still run after.
 */
export async function mainRedHold(options: {
	home: string;
	project: string;
	branch: string;
	head: string;
	ancestry: () => Promise<boolean | undefined>;
	runs: () => Promise<{ status: number | null; stdout: string }>;
	scope: () => Promise<MainCiScope>;
}): Promise<{ hold?: string; fact?: string }> {
	const read = new MainCiStore({ home: options.home }).read();
	if (!read.ok) return { fact: `main-ci: ${read.error} — not blocking` };
	const row = read.file.projects.find((entry) => entry.project === options.project);
	if (!row) return {};
	const sha = row.red_since_sha.slice(0, 12);
	const scope = await options.scope();
	if (!scope.enforce) return { fact: `main-ci: red since ${sha} not enforced — ${scope.reason}; not blocking` };
	if (row.login === undefined || !sameLogin(row.login, scope.login)) return { fact: `main-ci: red since ${sha} latched ${row.login ? `for ${row.login}` : "before own-run filtering"}, not ${scope.login}; not blocking` };
	const hold = { hold: `main is red since ${sha}: ${row.failing ?? row.workflow ?? "CI failed"}; rebase onto origin/main and pass CI to merge` };
	if ((await options.ancestry()) !== true) return hold;
	const runs = await options.runs();
	if (runs.status !== 0) return hold;
	let parsed: CiRun[];
	try {
		parsed = parseCiRuns(runs.stdout);
	} catch {
		return hold;
	}
	if (readCiForHead({ branch: options.branch, headSha: options.head, runs: parsed }).ci !== "green") return hold;
	return { fact: `main red since ${sha}; fix-forward: head contains origin/main and CI green` };
}
