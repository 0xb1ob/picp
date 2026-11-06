/**
 * One automatic rerun per job + head of an infra-only, or (PR integration only) known-flake, CI failure; the claim
 * in `state/ci-reruns.json` is written before `gh run rerun`. Everything else resolves as before.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_RERUNS_MAX, type CiFlakeEntry, type CiRerunEntry, type CiRerunsFile, isoTimestamp, LAYOUT, validateCiFlakesFile, validateCiRerunsFile } from "./contracts.ts";
import { readDrain } from "./drain.ts";
import { atomicWriteJson } from "./json-store.ts";
import { type ActionsJob, ACTIONS_CI_TIMEOUT_MS, readActionsJobs, statusRunner } from "./actions-ci.ts";
import { type CiRun, GREEN_CONCLUSIONS, shaMatches } from "./merge-ask.ts";
import type { CommandRunner } from "./merges.ts";

/** A first failed step with this whole name is setup, not the change under test. */
export const INFRA_SETUP_STEP = /^(set up job|checkout|set up [\w .-]+|install[\w .-]*|npm ci|pnpm install|yarn install|(restore )?cache[\w .-]*)$/i;
/** Any failed step naming tests, a build, lint or eval is never infra, whatever else it says. */
export const TEST_STEP = /\b(test|tests|suite|typecheck|lint|eval|build)\b/i;
/** The checked-in known-flake registry, relative to the package root. */
export const CI_FLAKES_FILE = "defaults/ci-flakes.json";

export class CiRerunError extends Error {}

export interface InfraVerdict {
	infra: boolean;
	/** The first failed step that decided it (when one was found). */
	step?: string;
	reason: string;
}

const conclusionOf = (value: string | null) => (value ?? "").toLowerCase();

/** Infra iff every failed job's first failed step is a setup step and no failed step is a test step. */
export function classifyInfraFailure(jobs: readonly Pick<ActionsJob, "name" | "conclusion" | "steps">[]): InfraVerdict {
	const conclusion = (value: string | null) => (value ?? "").toLowerCase();
	const stopped = jobs.find((job) => ["cancelled", "timed_out"].includes(conclusion(job.conclusion)));
	if (stopped) return { infra: false, reason: `job ${stopped.name} was ${conclusion(stopped.conclusion)} — never rerun automatically` };
	const failed = jobs.filter((job) => conclusion(job.conclusion) === "failure");
	if (failed.length === 0) return { infra: false, reason: "no job concluded failure" };
	let first: string | undefined;
	for (const job of failed) {
		const failedSteps = job.steps.filter((step) => conclusion(step.conclusion) === "failure").map((step) => step.name.trim());
		const head = failedSteps[0];
		if (!head) return { infra: false, reason: `job ${job.name} failed with no failed step to read` };
		const test = failedSteps.find((name) => TEST_STEP.test(name));
		if (test) return { infra: false, step: test, reason: `job ${job.name} failed in "${test}" — a test/build failure is the implementer's` };
		if (!INFRA_SETUP_STEP.test(head)) return { infra: false, step: head, reason: `job ${job.name} first failed in "${head}", which is not a setup step` };
		first ??= head;
	}
	return { infra: true, ...(first ? { step: first } : {}), reason: `every failed job first failed in a setup step ("${first}")` };
}

/** A cancelled/timed-out job, or a failed job with no failed step; a failed test step always wins (fail-fast cancels). */
export function cancellationSignature(jobs: readonly Pick<ActionsJob, "conclusion" | "steps">[]): boolean {
	const failure = (value: string | null) => (value ?? "").toLowerCase() === "failure";
	const failed = jobs.filter((job) => failure(job.conclusion)).map((job) => job.steps.filter((step) => failure(step.conclusion)));
	if (failed.some((steps) => steps.some((step) => TEST_STEP.test(step.name)))) return false;
	return jobs.some((job) => ["cancelled", "timed_out"].includes((job.conclusion ?? "").toLowerCase())) || failed.some((steps) => steps.length === 0);
}

/** One entry of the node spec reporter's "✖ failing tests:" block. */
interface ListedFailure {
	file: string;
	name: string;
	body: string;
}

/** The gh `--log-failed` text after its `<job>\t<step>\t` prefix, with the leading timestamp dropped. */
function logText(stamped: string): string {
	const space = stamped.indexOf(" ");
	const stamp = space < 0 ? stamped : stamped.slice(0, space);
	if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(stamp)) return stamped;
	return space < 0 ? "" : stamped.slice(space + 1);
}

/** `tests/x.test.ts:421:1` → `tests/x.test.ts`. */
function locationFile(at: string): string {
	const parts = at.trim().split(":");
	while (parts.length > 1 && /^\d+$/.test(parts.at(-1) ?? "")) parts.pop();
	return parts.join(":");
}

/** `✖ name (12.3ms)` → `name`. */
function testName(text: string): string {
	const name = text.trim();
	const open = name.lastIndexOf(" (");
	return open > 0 && name.endsWith("ms)") ? name.slice(0, open) : name;
}

interface JobFailures {
	failures: ListedFailure[];
	/** A `test at` line with no name line after it (a truncated log). */
	cut: boolean;
	/** The sum of the reporter's `ℹ fail N` lines; undefined when the log has none. */
	failCount?: number;
}

/** Each job's listed failures and reported fail count, from gh `--log-failed` output. */
function listedFailures(log: string): Map<string, JobFailures> {
	const jobs = new Map<string, JobFailures & { open: boolean }>();
	for (const line of log.split("\n")) {
		const [job, , ...rest] = line.replace(/\r$/, "").split("\t");
		if (!job || rest.length === 0) continue;
		const text = logText(rest.join("\t"));
		const state = jobs.get(job.trim()) ?? { failures: [], cut: false, open: false };
		jobs.set(job.trim(), state);
		const count = /^ℹ fail (\d+)$/.exec(text.trim())?.[1];
		if (count !== undefined) {
			state.failCount = (state.failCount ?? 0) + Number(count);
			continue;
		}
		if (text.trim() === "✖ failing tests:") {
			state.open = true;
			continue;
		}
		if (!state.open) continue;
		const last = state.failures.at(-1);
		if (text.startsWith("test at ")) {
			if (last && !last.name) state.cut = true;
			state.failures.push({ file: locationFile(text.slice("test at ".length)), name: "", body: "" });
		} else if (last && !last.name) {
			if (text.startsWith("✖ ")) last.name = testName(text.slice(2));
			else if (text.trim()) state.cut = true;
		} else if (last) last.body += `${text}\n`;
	}
	for (const state of jobs.values()) if (state.failures.some((failure) => !failure.name)) state.cut = true;
	return new Map([...jobs].map(([job, { open: _open, ...found }]) => [job, found]));
}

type FlakeTest = Extract<CiFlakeEntry, { file: string }>;
type FlakeStep = Extract<CiFlakeEntry, { job: string }>;

function covers(entry: FlakeTest, failure: ListedFailure): boolean {
	const file = failure.file === entry.file || failure.file.endsWith(`/${entry.file}`);
	return file && failure.name === entry.test && (entry.text === undefined || failure.body.includes(entry.text));
}

/** The project's registry entries; an absent file is empty, an invalid one throws (the flake path refuses). */
function readCiFlakes(file: string, project: string): CiFlakeEntry[] {
	if (!existsSync(file)) return [];
	const result = validateCiFlakesFile(JSON.parse(readFileSync(file, "utf8")));
	if (!result.ok) throw new CiRerunError(`refusing an invalid ${file}: ${result.errors[0] ?? "invalid"}`);
	return result.value.entries.filter((entry) => entry.project === project);
}

type FlakeVerdict = { ok: true; step: string } | { ok: false; reason: string };

/**
 * Known flake iff no job stopped, every failed gate job matches a step entry, and every listed failure of every
 * other failed job matches a test entry, read by `gh run view <id> -R <repo> --attempt <attempt> --log-failed`.
 */
async function classifyFlake(input: InfraRerunInput, run: { id: number; attempt: number }, jobs: readonly ActionsJob[], entries: readonly CiFlakeEntry[], repo: string): Promise<FlakeVerdict> {
	const stopped = jobs.find((job) => ["cancelled", "timed_out"].includes(conclusionOf(job.conclusion)));
	if (stopped) return { ok: false, reason: `job ${stopped.name} was ${conclusionOf(stopped.conclusion)}` };
	const tests = entries.filter((entry): entry is FlakeTest => "file" in entry);
	const steps = entries.filter((entry): entry is FlakeStep => "job" in entry);
	const failedSteps = (job: ActionsJob) => job.steps.filter((step) => conclusionOf(step.conclusion) === "failure").map((step) => step.name.trim());
	const gate = (job: ActionsJob) => failedSteps(job).length > 0 && steps.some((entry) => entry.job === job.name.trim() && failedSteps(job).every((name) => name === entry.step));
	const failed = jobs.filter((job) => conclusionOf(job.conclusion) === "failure" && !gate(job));
	if (failed.length === 0) return { ok: false, reason: "no failed job lists a failing test (a gate job alone never qualifies)" };
	const args = ["run", "view", String(run.id), "-R", repo, "--attempt", String(run.attempt), "--log-failed"];
	const read = await input.run(input.cwd, "gh", args, { timeoutMs: ACTIONS_CI_TIMEOUT_MS });
	if (read.status !== 0) return { ok: false, reason: `gh ${args.join(" ")} failed: ${firstLine(read.stderr || read.stdout) || `exit ${read.status}`}` };
	const listed = listedFailures(read.stdout);
	const names = new Set<string>();
	for (const job of failed) {
		const stepped = failedSteps(job);
		if (stepped.length !== 1 || !TEST_STEP.test(stepped[0] ?? "")) return { ok: false, reason: `job ${job.name} failed in ${stepped.map((name) => `"${name}"`).join(", ") || "no step"}, not in its one test-suite step alone` };
		const found = listed.get(job.name.trim());
		if (!found || found.cut || found.failures.length === 0) return { ok: false, reason: `job ${job.name}'s failed log has no complete "✖ failing tests:" block (empty, expired or cut logs never match)` };
		if (found.failCount !== found.failures.length) {
			const reported = found.failCount === undefined ? "no ℹ fail count" : `ℹ fail ${found.failCount}`;
			return { ok: false, reason: `job ${job.name}'s log lists ${found.failures.length} failing test(s) but reports ${reported} (a partial log never matches)` };
		}
		const unknown = found.failures.find((failure) => !tests.some((entry) => covers(entry, failure)));
		if (unknown) return { ok: false, reason: `job ${job.name} failed "${unknown.name}" (${unknown.file}), which no entry covers` };
		for (const failure of found.failures) names.add(failure.name);
	}
	return { ok: true, step: `known flake: ${[...names].join("; ")}`.slice(0, 200) };
}

/** `state/ci-reruns.json`: the claims, written before any `gh run rerun`. */
export class CiRerunStore {
	readonly file: string;

	constructor(home: string) {
		this.file = join(home, LAYOUT.ciRerunsFile);
	}

	/** Absent reads as empty; a corrupt file throws naming the path (the caller fails closed: no rerun). */
	read(): CiRerunsFile {
		if (!existsSync(this.file)) return { schema_version: 1, entries: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch (error) {
			throw new CiRerunError(`refusing to read an unparseable ${this.file}: ${(error as Error).message}`);
		}
		const result = validateCiRerunsFile(parsed);
		if (!result.ok) throw new CiRerunError(`refusing to read an invalid ${this.file}:\n  ${result.errors.join("\n  ")}`);
		return result.value;
	}

	claims(jobId: string, head: string): CiRerunEntry[] {
		return this.read().entries.filter((entry) => entry.job_id === jobId && shaMatches(entry.head_sha, head));
	}

	claim(entries: readonly CiRerunEntry[]): void {
		const file = this.read();
		this.#write({ schema_version: 1, entries: [...file.entries, ...entries].slice(-CI_RERUNS_MAX) });
	}

	/** Records an outcome on this job + head's `uncertain` claims for the given runs; other claims never change. */
	settle(jobId: string, head: string, outcomes: ReadonlyMap<number, "accepted" | "refused">): void {
		const file = this.read();
		const mine = (entry: CiRerunEntry) => entry.job_id === jobId && shaMatches(entry.head_sha, head) && entry.outcome === "uncertain";
		const entries = file.entries.map((entry) => {
			const outcome = mine(entry) ? outcomes.get(entry.run_id) : undefined;
			return outcome ? { ...entry, outcome } : entry;
		});
		this.#write({ schema_version: 1, entries });
	}

	#write(next: CiRerunsFile): void {
		const result = validateCiRerunsFile(next);
		if (!result.ok) throw new CiRerunError(`refusing to write an invalid ${this.file}:\n  ${result.errors.join("\n  ")}`);
		atomicWriteJson(this.file, next);
	}
}

export interface InfraRerunInput {
	jobId: string;
	head: string;
	/** The Actions runs on the head, as integrate read them. */
	runs: readonly CiRun[];
	cwd: string;
	run: CommandRunner;
	/** The job's project and PR, for the known-flake registry and its `-R` log read; absent means infra only. */
	project?: string;
	prUrl?: string;
}

export interface InfraRerunOutcome {
	/** True when at least one `gh run rerun` was accepted: the step waits for the new attempt. */
	rerun: boolean;
	/** True when an accepted rerun's new attempt is not observed yet: wait, never resolve. */
	wait?: boolean;
	/** One fact line for the integration record. */
	fact: string;
}

export interface InfraRerunPorts {
	home: string;
	store: CiRerunStore;
	/** The known-flake registry; only PR integration passes it (main CI stays infra-only). */
	flakesFile?: string;
	now?: () => Date;
}

/** Undefined when the project has no entries (infra only); a string names why the flake path refuses. */
function flakePolicy(input: InfraRerunInput & InfraRerunPorts): { entries: CiFlakeEntry[]; repo: string } | string | undefined {
	if (!input.flakesFile || !input.project) return undefined;
	let entries: CiFlakeEntry[];
	try {
		entries = readCiFlakes(input.flakesFile, input.project);
	} catch (error) {
		return firstLine((error as Error).message);
	}
	if (entries.length === 0) return undefined;
	const repo = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(input.prUrl ?? "")?.[1];
	return repo ? { entries, repo } : "no GitHub repository to read the failed log from";
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim().slice(0, 200);
}

/**
 * Undefined when the head has no failed run (nothing to say); otherwise one fact, and
 * `rerun: true` only when the claim was written and gh accepted a rerun.
 */
export async function maybeRerunInfra(input: InfraRerunInput & InfraRerunPorts): Promise<InfraRerunOutcome | undefined> {
	const failed = input.runs.filter((run) => shaMatches(run.headSha, input.head) && run.status === "completed" && !GREEN_CONCLUSIONS.has((run.conclusion ?? "").toLowerCase()));
	if (failed.length === 0) return undefined;
	const facts: string[] = [];
	const say = (text: string) => `ci rerun: ${[...facts, text].join("; ")}`;
	const skip = (why: string): InfraRerunOutcome => ({ rerun: false, fact: say(`none — ${why}`) });
	try {
		if (readDrain(input.home)) return skip("the home is draining");
	} catch {
		return skip("the drain record is unreadable (fail closed)");
	}
	// Infra claims keep the legacy shape and path; only known-flake claims carry an outcome to settle or wait on.
	let read: CiRerunEntry[] | string;
	try {
		read = input.store.claims(input.jobId, input.head);
	} catch (error) {
		read = firstLine((error as Error).message);
	}
	// An unreadable claim file is refused where it always was, after the run checks below.
	let claims = typeof read === "string" ? [] : read;
	const uncertain = claims.filter((entry) => entry.outcome === "uncertain");
	if (uncertain.length > 0) {
		const started = (entry: CiRerunEntry) => input.runs.some((run) => run.databaseId === entry.run_id && shaMatches(run.headSha, input.head) && (run.attempt ?? 0) > (entry.attempt ?? 1));
		const outcomes = new Map(uncertain.map((entry) => [entry.run_id, started(entry) ? ("accepted" as const) : ("refused" as const)]));
		try {
			input.store.settle(input.jobId, input.head, outcomes);
		} catch (error) {
			return skip(`an uncertain claim could not be settled: ${firstLine((error as Error).message)}`);
		}
		claims = claims.map((entry) => (entry.outcome === "uncertain" ? { ...entry, outcome: outcomes.get(entry.run_id) ?? "refused" } : entry));
		facts.push(`settled the uncertain claim on ${[...outcomes].map(([id, outcome]) => `run ${id} as ${outcome === "accepted" ? "rerun-started" : "not-started"}`).join(", ")}`);
	}
	const stale = claims.filter((entry) => entry.outcome === "accepted" && failed.some((run) => run.databaseId === entry.run_id && (run.attempt ?? 0) <= (entry.attempt ?? 1)));
	if (stale.length > 0) {
		const ids = stale.map((entry) => `run ${entry.run_id} attempt ${entry.attempt ?? 1}`).join(", ");
		return { rerun: false, wait: true, fact: say(`${ids} was rerun at ${stale[0]?.at}; its new attempt is not observed yet — waiting, no repair spent`) };
	}
	const notFailure = failed.find((run) => (run.conclusion ?? "").toLowerCase() !== "failure");
	if (notFailure) return skip(`a run concluded ${notFailure.conclusion ?? "without a conclusion"}, which is never rerun automatically`);
	const unidentified = failed.find((run) => run.databaseId === undefined || run.attempt === undefined);
	if (unidentified) return skip("a failed run has no id or attempt to rerun by");
	const repeated = failed.find((run) => (run.attempt ?? 0) >= 2);
	if (repeated) return skip(`run ${repeated.databaseId} is on attempt ${repeated.attempt}: a second failure is the parent's`);
	if (typeof read === "string") return skip(read);
	const claimed = claims[0];
	if (claimed) return skip(`the one ${claimed.outcome === undefined ? "infra" : "automatic"} rerun for ${input.head.slice(0, 12)} was spent at ${claimed.at} (run ${claimed.run_id})`);
	const policy = flakePolicy(input);
	const steps: Array<{ id: number; attempt: number; step: string; flake: boolean }> = [];
	for (const run of failed) {
		const id = run.databaseId as number;
		const attempt = run.attempt as number;
		let jobs: ActionsJob[];
		try {
			jobs = await readActionsJobs({ cwd: input.cwd, exec: statusRunner(input.run) }, { runId: id, attempt, sha: input.head });
		} catch (error) {
			return skip(`run ${id} jobs unreadable: ${firstLine((error as Error).message)}`);
		}
		const verdict = classifyInfraFailure(jobs);
		if (verdict.infra) {
			steps.push({ id, attempt, step: verdict.step ?? "setup", flake: false });
			continue;
		}
		if (policy === undefined) return skip(`run ${id}: ${verdict.reason}`);
		const flake = typeof policy === "string" ? { ok: false as const, reason: policy } : await classifyFlake(input, { id, attempt }, jobs, policy.entries, policy.repo);
		if (!flake.ok) return skip(`run ${id}: ${verdict.reason}; not a known flake: ${flake.reason}`);
		steps.push({ id, attempt, step: flake.step, flake: true });
	}
	const at = isoTimestamp((input.now ?? (() => new Date()))());
	try {
		// Claim first: a crash or a gh fault after this line never earns a second rerun.
		input.store.claim(steps.map(({ id, attempt, step, flake }) => ({ job_id: input.jobId, head_sha: input.head, run_id: id, step, at, ...(flake ? { attempt, outcome: "uncertain" as const } : {}) })));
	} catch (error) {
		return skip(`the claim could not be written: ${firstLine((error as Error).message)}`);
	}
	const accepted: number[] = [];
	const refused: string[] = [];
	const outcomes = new Map<number, "accepted" | "refused">();
	for (const { id } of steps) {
		const rerun = await input.run(input.cwd, "gh", ["run", "rerun", String(id), "--failed"]);
		outcomes.set(id, rerun.status === 0 ? "accepted" : "refused");
		if (rerun.status === 0) accepted.push(id);
		else refused.push(`${id}: ${firstLine(rerun.stderr || rerun.stdout)}`);
	}
	try {
		if (steps.some((entry) => entry.flake)) input.store.settle(input.jobId, input.head, outcomes);
	} catch (error) {
		facts.push(`outcome not recorded (${firstLine((error as Error).message)}); the next call settles the uncertain claim from the run's attempts`);
	}
	const kind = steps.every((entry) => entry.flake) ? "known-flake" : steps.some((entry) => entry.flake) ? "infra-only/known-flake" : "infra-only";
	const what = steps.map(({ id, step }) => `run ${id} ("${step}")`).join(", ");
	if (accepted.length === 0) return { rerun: false, fact: say(`claimed for ${kind} ${what} but gh refused (${refused.join("; ")}) — the failure goes to the parent`) };
	return { rerun: true, fact: say(`${kind} failure in ${what}; reran the failed jobs once (claim in ${LAYOUT.ciRerunsFile})${refused.length > 0 ? `; refused: ${refused.join("; ")}` : ""}`) };
}
