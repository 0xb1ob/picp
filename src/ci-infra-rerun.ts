/**
 * One automatic rerun of an infra-only CI failure (unload-parent PR2).
 *
 * A red head whose every failed job died in a setup step — checkout, toolchain,
 * `npm ci`, the treehouse install that 403'd — says nothing about the change, and
 * used to cost a parent turn and an implementer promote. `Integrator.advance`
 * calls `maybeRerunInfra` where it would otherwise resolve a failed head: when
 * the failure is infra-only and this job + head has never been rerun, the claim
 * is written to `state/ci-reruns.json` **first**, then `gh run rerun <id>
 * --failed` runs, and the step waits for the new attempt (a new `run_identity`,
 * so the watcher's fact re-triggers the continuation).
 *
 * Everything else goes to the parent unchanged (`ciFailedMessage` resolve): a
 * test/build step failure, attempt ≥ 2, a cancelled or timed-out run, a run with
 * no id, an existing claim, a drain, an unreadable claim file or jobs listing.
 * Nothing here merges, waits on CI or loops: one `gh run view` per failed run,
 * one `gh run rerun` per failed run, once per job + head, ever.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_RERUNS_MAX, type CiRerunEntry, type CiRerunsFile, isoTimestamp, LAYOUT, validateCiRerunsFile } from "./contracts.ts";
import { readDrain } from "./drain.ts";
import { atomicWriteJson } from "./json-store.ts";
import { type CiRun, GREEN_CONCLUSIONS, shaMatches } from "./merge-ask.ts";
import type { CommandRunner } from "./merges.ts";

/** A first failed step with this whole name is setup, not the change under test. */
export const INFRA_SETUP_STEP = /^(set up job|checkout|set up [\w .-]+|install[\w .-]*|npm ci|pnpm install|yarn install|(restore )?cache[\w .-]*)$/i;
/** Any failed step naming tests, a build, lint or eval is never infra, whatever else it says. */
export const TEST_STEP = /\b(test|tests|suite|typecheck|lint|eval|build)\b/i;

export class CiRerunError extends Error {}

export interface InfraVerdict {
	infra: boolean;
	/** The first failed step that decided it (when one was found). */
	step?: string;
	reason: string;
}

interface ViewStep {
	name?: unknown;
	conclusion?: unknown;
}
interface ViewJob {
	name?: unknown;
	conclusion?: unknown;
	steps?: unknown;
}

/** `gh run view <id> --json jobs` → infra iff every failed job's first failed step is a setup step and no failed step is a test step. */
export function classifyInfraFailure(viewJson: string): InfraVerdict {
	let jobs: ViewJob[];
	try {
		const parsed = JSON.parse(viewJson) as { jobs?: unknown };
		if (!Array.isArray(parsed?.jobs)) return { infra: false, reason: "gh run view returned no jobs list" };
		jobs = parsed.jobs as ViewJob[];
	} catch (error) {
		return { infra: false, reason: `gh run view output is not JSON (${(error as Error).message})` };
	}
	const conclusion = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : "");
	const stopped = jobs.find((job) => ["cancelled", "timed_out"].includes(conclusion(job.conclusion)));
	if (stopped) return { infra: false, reason: `job ${String(stopped.name)} was ${conclusion(stopped.conclusion)} — never rerun automatically` };
	const failed = jobs.filter((job) => conclusion(job.conclusion) === "failure");
	if (failed.length === 0) return { infra: false, reason: "no job concluded failure" };
	let first: string | undefined;
	for (const job of failed) {
		const steps = (Array.isArray(job.steps) ? job.steps : []) as ViewStep[];
		const failedSteps = steps.filter((step) => conclusion(step.conclusion) === "failure").map((step) => String(step.name ?? "").trim());
		const head = failedSteps[0];
		if (!head) return { infra: false, reason: `job ${String(job.name)} failed with no failed step to read` };
		const test = failedSteps.find((name) => TEST_STEP.test(name));
		if (test) return { infra: false, step: test, reason: `job ${String(job.name)} failed in "${test}" — a test/build failure is the implementer's` };
		if (!INFRA_SETUP_STEP.test(head)) return { infra: false, step: head, reason: `job ${String(job.name)} first failed in "${head}", which is not a setup step` };
		first ??= head;
	}
	return { infra: true, ...(first ? { step: first } : {}), reason: `every failed job first failed in a setup step ("${first}")` };
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

	claimed(jobId: string, head: string): CiRerunEntry | undefined {
		return this.read().entries.find((entry) => entry.job_id === jobId && shaMatches(entry.head_sha, head));
	}

	claim(entries: readonly CiRerunEntry[]): void {
		const file = this.read();
		const next: CiRerunsFile = { schema_version: 1, entries: [...file.entries, ...entries].slice(-CI_RERUNS_MAX) };
		const result = validateCiRerunsFile(next);
		if (!result.ok) throw new CiRerunError(`refusing to write an invalid ${this.file}:\n  ${result.errors.join("\n  ")}`);
		atomicWriteJson(this.file, next);
	}
}

export interface InfraRerunInput {
	jobId: string;
	head: string;
	/** `gh run list` rows for the branch (newest first), as integrate parsed them. */
	runs: readonly CiRun[];
	cwd: string;
	run: CommandRunner;
}

export interface InfraRerunOutcome {
	/** True when at least one `gh run rerun` was accepted: the step waits for the new attempt. */
	rerun: boolean;
	/** One fact line for the integration record. */
	fact: string;
}

export interface InfraRerunPorts {
	home: string;
	store: CiRerunStore;
	now?: () => Date;
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
	const skip = (why: string): InfraRerunOutcome => ({ rerun: false, fact: `ci rerun: none — ${why}` });
	try {
		if (readDrain(input.home)) return skip("the home is draining");
	} catch {
		return skip("the drain record is unreadable (fail closed)");
	}
	const notFailure = failed.find((run) => (run.conclusion ?? "").toLowerCase() !== "failure");
	if (notFailure) return skip(`a run concluded ${notFailure.conclusion ?? "without a conclusion"}, which is never rerun automatically`);
	const unidentified = failed.find((run) => run.databaseId === undefined || run.attempt === undefined);
	if (unidentified) return skip("a failed run has no id or attempt to rerun by");
	const repeated = failed.find((run) => (run.attempt ?? 0) >= 2);
	if (repeated) return skip(`run ${repeated.databaseId} is on attempt ${repeated.attempt}: a second failure is the parent's`);
	let claimed: CiRerunEntry | undefined;
	try {
		claimed = input.store.claimed(input.jobId, input.head);
	} catch (error) {
		return skip(firstLine((error as Error).message));
	}
	if (claimed) return skip(`the one infra rerun for ${input.head.slice(0, 12)} was spent at ${claimed.at} (run ${claimed.run_id})`);
	const steps: Array<{ id: number; step: string }> = [];
	for (const run of failed) {
		const id = run.databaseId as number;
		const view = await input.run(input.cwd, "gh", ["run", "view", String(id), "--json", "jobs"]);
		if (view.status !== 0) return skip(`gh run view ${id} failed: ${firstLine(view.stderr || view.stdout)}`);
		const verdict = classifyInfraFailure(view.stdout);
		if (!verdict.infra) return skip(`run ${id}: ${verdict.reason}`);
		steps.push({ id, step: verdict.step ?? "setup" });
	}
	const at = isoTimestamp((input.now ?? (() => new Date()))());
	try {
		// Claim first: a crash or a gh fault after this line never earns a second rerun.
		input.store.claim(steps.map(({ id, step }) => ({ job_id: input.jobId, head_sha: input.head, run_id: id, step, at })));
	} catch (error) {
		return skip(`the claim could not be written: ${firstLine((error as Error).message)}`);
	}
	const accepted: number[] = [];
	const refused: string[] = [];
	for (const { id } of steps) {
		const rerun = await input.run(input.cwd, "gh", ["run", "rerun", String(id), "--failed"]);
		if (rerun.status === 0) accepted.push(id);
		else refused.push(`${id}: ${firstLine(rerun.stderr || rerun.stdout)}`);
	}
	const what = steps.map(({ id, step }) => `run ${id} ("${step}")`).join(", ");
	if (accepted.length === 0) return { rerun: false, fact: `ci rerun: claimed for infra-only ${what} but gh refused (${refused.join("; ")}) — the failure goes to the parent` };
	return { rerun: true, fact: `ci rerun: infra-only failure in ${what}; reran the failed jobs once (claim in ${LAYOUT.ciRerunsFile})${refused.length > 0 ? `; refused: ${refused.join("; ")}` : ""}` };
}
