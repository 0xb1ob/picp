/**
 * Native Claude follow-ups (N3c): the durable session record that makes a native job resumable, the admission every
 * resume passes before a claude process starts, the busy-send queue, and teardown's scratch removal.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isScriptFleetRecord, type Usage } from "../contracts.ts";
import { assertDispatchOpen } from "../drain.ts";
import { checkBudget } from "../failures.ts";
import { FleetStore } from "../fleet.ts";
import { projectDenial } from "../mandate-defaults.ts";
import { rebuildStatus } from "../run-artifacts.ts";
import type { NativeDriver } from "../worker-driver.ts";
import { assertNativeSelection, NativeDriverError } from "./claude.ts";

export const NATIVE_SESSION_FILE = "native-claude";
export const NATIVE_FOLLOWUPS_FILE = "native-followups.jsonl";
export const NATIVE_SCRATCH_PREFIX = "cp-claude-native-";

/** The revive prompt: the resumed session is told why it was resumed and what still ends the job. */
export const NATIVE_REVIVE_PROMPT =
	"picp revived this job: your previous native run ended without an accepted report (a crash, a stop or a restart). " +
	"Continue the research from where the session stopped and call report_result once when you are done.";

export const NATIVE_ACK = {
	resumed:
		"resuming: one new native claude process resumes this job's session with the message as its next prompt (run event " +
		"native_run, or the worker's named failure on its observed exit); nothing was steered",
	queued:
		"queued until the current turn ends: a resume after it delivers the message under the same admission and gates " +
		"(run event native_followup_delivered), or native_followup_refused names why not; nothing was steered",
} as const;

const LedgerSchema = Type.Record(Type.String(), Type.Object({ input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }));

/** `<runDir>/native-claude`, one JSON line. The session id grants nothing: it is only a resume key. */
export const NativeSessionSchema = Type.Object(
	{
		driver: Type.Literal("claude"),
		scratch_dir: Type.String({ minLength: 1 }),
		session_id: Type.Optional(Type.String({ minLength: 1 })),
		/** The session's cumulative per-model tokens and cost at its last result; absent means a resume is unmeasured. */
		baseline: Type.Optional(Type.Object({ ledger: LedgerSchema, cost_usd: Type.Number({ minimum: 0 }) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);
export type NativeSession = Static<typeof NativeSessionSchema>;

/** Reads and validates the record; the scratch dir must be a picp-made temp dir, never an arbitrary path. */
export function readNativeSession(file: string): NativeSession {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new NativeDriverError(`the native session record ${file} is unreadable (${(error as Error).message})`);
	}
	if (!Value.Check(NativeSessionSchema, raw)) throw new NativeDriverError(`the native session record ${file} does not match its schema`);
	const dir = raw.scratch_dir;
	if (!isAbsolute(dir) || resolve(dir) !== dir || !/^cp-claude-native-[A-Za-z0-9]{6}$/.test(basename(dir))) {
		throw new NativeDriverError(`the native session record ${file} names a scratch dir picp did not make`);
	}
	return raw;
}

export function writeNativeSession(file: string, session: NativeSession): void {
	writeFileSync(`${file}.tmp`, `${JSON.stringify(session)}\n`, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
}

/** Teardown, after the worker's observed exit: removes the kept scratch dir; an invalid record keeps it. */
export function removeNativeScratch(sessionFile: string): { removed?: string; kept?: string } {
	if (!existsSync(sessionFile)) return {};
	try {
		const { scratch_dir } = readNativeSession(sessionFile);
		rmSync(scratch_dir, { recursive: true, force: true });
		return { removed: scratch_dir };
	} catch (error) {
		return { kept: (error as Error).message };
	}
}

export function enqueueFollowUp(runDir: string, message: string): void {
	writeFileSync(join(runDir, NATIVE_FOLLOWUPS_FILE), `${JSON.stringify({ message })}\n`, { flag: "a", mode: 0o600 });
}

/** The durable busy-send queue, oldest first; an unreadable queue throws a named error, never an empty one. */
export function queuedFollowUps(runDir: string): string[] {
	const file = join(runDir, NATIVE_FOLLOWUPS_FILE);
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => String((JSON.parse(line) as { message: unknown }).message));
	} catch (error) {
		throw new NativeDriverError(`the native follow-up queue ${file} is unreadable (${(error as Error).message})`);
	}
}

/** Drops the `count` oldest queued follow-ups only; a send queued since they were read stays queued. */
export function dropFollowUps(runDir: string, count: number): void {
	const file = join(runDir, NATIVE_FOLLOWUPS_FILE);
	const rest = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).slice(count) : [];
	if (rest.length === 0) rmSync(file, { force: true });
	else writeFileSync(file, `${rest.join("\n")}\n`, { mode: 0o600 });
}

/**
 * Every native resume's admission, in dispatch's order and before any claude process starts: the drain freeze and the
 * update hold, trust (a denied project), the per-job budget on the recorded running total (plus `pending`, usage a
 * turn reported that the run log has not yet recorded), then the N3b selection (switch, role, concurrency 1, floor).
 */
export async function assertNativeResume(input: { home: string; jobId: string; what: string; pending?: Usage; env?: NodeJS.ProcessEnv }): Promise<void> {
	const jobs = new FleetStore({ home: input.home }).read().jobs;
	const record = jobs.find((job) => job.job_id === input.jobId);
	const refuse = (why: string): never => {
		throw new NativeDriverError(`refused: ${input.what} of native ${input.jobId}: ${why}`);
	};
	if (!record || isScriptFleetRecord(record) || !record.worker.driver) return refuse("no native fleet record");
	assertDispatchOpen(input.home, `${input.what} of native ${input.jobId}`);
	const denied = projectDenial(input.home, record.project);
	if (denied) refuse(denied);
	if (record.budget) {
		const used = rebuildStatus(input.home, input.jobId).usage;
		const total = input.pending ? Object.fromEntries(Object.entries(used).map(([key, value]) => [key, value + input.pending![key as keyof Usage]])) as Usage : used;
		const check = checkBudget(total, record.budget);
		if (check.state === "exceeded") refuse(`the per-job budget is spent (${check.tokens.used}/${check.tokens.limit} billable tokens, $${check.cost.used.toFixed(4)}/$${check.cost.limit.toFixed(2)})`);
	}
	await assertNativeSelection({ home: input.home, jobId: input.jobId, driver: record.worker.driver as NativeDriver, kind: record.kind, role: record.worker.role, delivery: record.delivery, jobs, ...(input.env ? { env: input.env } : {}) });
}

/** cp_revive's native admission: a recorded session id to resume, then `assertNativeResume`; the refusal, or none. */
export async function nativeReviveRefusal(home: string, jobId: string, sessionFile: string): Promise<string | undefined> {
	try {
		if (readNativeSession(sessionFile).session_id === undefined) throw new Error(`${sessionFile} holds no session id`);
		await assertNativeResume({ home, jobId, what: "revive" });
		return undefined;
	} catch (error) {
		return `${(error as Error).message}. Nothing was spawned.`;
	}
}

/** After a native revive's spawn, picp's revive prompt starts the resumed run; returns why it was refused, or none. */
export async function sendNativeRevive(
	worker: { send(message: string, mode: "prompt"): Promise<{ receipt: string; disposition?: string; error?: string }> },
	record: (payload: Record<string, unknown>) => void,
): Promise<string | undefined> {
	const sent = await worker.send(NATIVE_REVIVE_PROMPT, "prompt");
	record({ receipt: sent.receipt, ...(sent.disposition ? { disposition: sent.disposition } : {}), native_revive: true, ...(sent.error ? { error: sent.error } : {}) });
	return sent.receipt === "failed" ? `the native worker refused the revive prompt (${sent.error ?? "no error text"})` : undefined;
}

/** Why a native job takes no pi-only follow-up door (cp_revive continue_failed, bounded recovery, a mid-turn steer). */
export function nativeDoorRefusal(jobId: string, door: "continue_failed" | "bounded recovery" | "steer"): string {
	const why = {
		continue_failed: "continue_failed takes over a pi transcript and a stale registered worker; a native job's plain cp_revive " +
			"already resumes its Claude session under the native admission, so a second door would only skip it",
		"bounded recovery": "automatic recovery never starts a native claude process; the operator revives it with cp_revive",
		steer: "the native driver takes no mid-turn steer; send with mode auto or follow_up to queue it until the turn ends",
	}[door];
	return `${jobId} runs on the native claude driver: ${door} is refused (${why}). Nothing was sent or spawned.`;
}
