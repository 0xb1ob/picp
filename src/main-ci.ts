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
 * A row in `state/main-ci.json` exists iff that project's main is latched red. The
 * CI-watch tick (`surfaceCi`) is the only writer; `cp_integrate` only reads. Wakes
 * are transition-only: one on red, one on green again.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { IsoTimestampSchema, isoTimestamp, LAYOUT, SCHEMA_VERSION, validate } from "./contracts.ts";
import { atomicWriteJson, canonicalDir } from "./json-store.ts";
import { type CiRun, type CommandRunner, evaluateMergeAskCi, ghCiRuns, MERGE_ASK_QUERY_TIMEOUT_MS, parseCiRuns, readCiForHead, runCommand, shaMatches } from "./merge-ask.ts";

const MainCiEntrySchema = Type.Object(
	{
		project: Type.String({ minLength: 1, maxLength: 200 }),
		red_since_sha: Type.String({ pattern: "^[0-9a-f]{7,64}$" }),
		red_since_at: IsoTimestampSchema,
		workflow: Type.Optional(Type.String({ maxLength: 200 })),
		failing: Type.Optional(Type.String({ maxLength: 300 })),
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

	/** Set the latch. A no-op when already set: `red_since_*` never resets. */
	setRed(project: string, sha: string, extra: { workflow?: string; failing?: string } = {}): void {
		const rows = this.#rows();
		if (rows.some((row) => row.project === project)) return;
		const row: MainCiEntry = {
			project,
			red_since_sha: sha.trim().toLowerCase(),
			red_since_at: isoTimestamp(this.#now()),
			...(extra.workflow ? { workflow: extra.workflow.slice(0, 200) } : {}),
			...(extra.failing ? { failing: extra.failing.slice(0, 300) } : {}),
		};
		this.#write([...rows, row]);
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
	event: "main_ci_failed" | "main_ci_green";
	sha: string;
	reason: string;
	workflow?: string;
	failing?: string;
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
 * One reading for one project. Returns an observation only on a transition
 * (absent → red, red → green on the tip); every other reading leaves the latch
 * untouched. Unreadable state, git or gh throws — the caller logs it.
 */
export async function checkMainCi(options: { project: string; cwd: string; store: MainCiStore; exec?: CommandRunner; timeoutMs?: number }): Promise<MainCiObservation | undefined> {
	const { project, cwd, store } = options;
	const exec = options.exec ?? runCommand;
	const timeoutMs = options.timeoutMs ?? MERGE_ASK_QUERY_TIMEOUT_MS;
	const read = store.read();
	if (!read.ok) throw new MainCiError(`${read.error}; not overwritten`);
	const latched = read.file.projects.some((row) => row.project === project);
	const tip = await readMainTip(cwd, exec, timeoutMs);
	let runs: CiRun[];
	try {
		runs = await ghCiRuns({ cwd, exec, timeoutMs })("main");
	} catch (error) {
		throw new MainCiError(`gh run list --branch main unreadable: ${(error as Error).message.slice(0, 200)}`);
	}
	const classified = classifyMainTip(tip, runs);
	if (classified.status === "red" && !latched) {
		const id = classified.failingRunId;
		const failing = id === undefined ? undefined : ((await failingTestLine(cwd, id, exec, timeoutMs)) ?? (await failingJobName(cwd, id, exec, timeoutMs)));
		const extra = { ...(classified.workflow ? { workflow: classified.workflow } : {}), ...(failing ? { failing } : {}) };
		store.setRed(project, tip, extra);
		return { project, event: "main_ci_failed", sha: tip, reason: classified.reason, ...extra };
	}
	if (classified.status === "green" && latched) {
		store.clear(project);
		return { project, event: "main_ci_green", sha: tip, reason: classified.reason };
	}
	return undefined;
}

/** The operator-facing notice for a main-branch transition. */
export function formatMainCiNotice(observation: MainCiObservation): string {
	const sha = observation.sha.slice(0, 12);
	if (observation.event === "main_ci_green") {
		return `MAIN IS GREEN AGAIN — ${observation.project}: CI passed on ${sha}. Call cp_integrate for held ${observation.project} PRs.`;
	}
	return (
		`MAIN IS RED — ${observation.project}: CI failed on ${sha}${observation.workflow ? ` (${observation.workflow})` : ""}` +
		`${observation.failing ? ` — failing: ${observation.failing}` : ""} — ${observation.reason}\n` +
		`  cp_integrate returns wait for every ${observation.project} PR except one based on the current main with green CI.`
	);
}

/**
 * The main half of the CI-watch tick: every registered project with a clone, in
 * sequence. A failure for one project never stops the rest and is never dropped:
 * it goes to `onError`. `send` returning false (a wake not sent) is logged too.
 */
export async function runMainCiTick(options: {
	home: string;
	projects: Iterable<string>;
	pathOf: (project: string) => string;
	exec?: CommandRunner;
	onError: (project: string, message: string) => void;
	notify: (observation: MainCiObservation, text: string) => void;
	send: (observation: MainCiObservation, text: string) => boolean;
}): Promise<MainCiObservation[]> {
	const store = new MainCiStore({ home: options.home });
	const observations: MainCiObservation[] = [];
	for (const project of options.projects) {
		try {
			const cwd = options.pathOf(project);
			if (!existsSync(cwd)) continue;
			const observation = await checkMainCi({ project, cwd, store, ...(options.exec ? { exec: options.exec } : {}) });
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
 * latch file fails open, with a fact. The review and permission gates still run after.
 */
export async function mainRedHold(options: {
	home: string;
	project: string;
	branch: string;
	head: string;
	ancestry: () => Promise<boolean | undefined>;
	runs: () => Promise<{ status: number | null; stdout: string }>;
}): Promise<{ hold?: string; fact?: string }> {
	const read = new MainCiStore({ home: options.home }).read();
	if (!read.ok) return { fact: `main-ci: ${read.error} — not blocking` };
	const row = read.file.projects.find((entry) => entry.project === options.project);
	if (!row) return {};
	const sha = row.red_since_sha.slice(0, 12);
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
