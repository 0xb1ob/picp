/**
 * Native Claude follow-ups (N3c): the durable session record that makes a native job resumable, the admission every
 * resume passes before a claude process starts, the busy-send queue, and teardown's scratch removal.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isScriptFleetRecord, type JobKind, type Usage } from "../contracts.ts";
import { assertDispatchOpen, assertNotDraining } from "../drain.ts";
import { checkBudget } from "../failures.ts";
import { FleetStore } from "../fleet.ts";
import { projectDenial } from "../mandate-defaults.ts";
import { rebuildStatus } from "../run-artifacts.ts";
import type { NativeDriver } from "../worker-driver.ts";
import { nativeAvailability } from "../native-availability.ts";
import { assertNativeSelection, NativeDriverError, nativeModelId } from "./claude.ts";

export const NATIVE_SESSION_FILE = "native-claude";
export const NATIVE_FOLLOWUPS_FILE = "native-followups.jsonl";
export const NATIVE_SCRATCH_PREFIX = "cp-claude-native-";

const REVIVED = "picp revived this job: your previous native run ended without an accepted report (a crash, a stop or a restart). ";

/** The revive prompt per kind: the resumed session is told why it was resumed and what still ends the job. */
export function nativeRevivePrompt(kind: JobKind): string {
	return REVIVED + (kind === "research"
		? "Continue the research from where the session stopped and call report_result once when you are done."
		: "Continue the implementation from where the session stopped: commit, git_push, open the draft PR with pr_create if it is not open, then call report_result once with head_sha.");
}

/** Why a recorded session must not resume in `worktree`: it started elsewhere (an awaiting_merge re-lease). */
export function nativeSessionMoved(session: NativeSession, worktree: string): string | undefined {
	if (session.cwd === undefined || resolve(session.cwd) === resolve(worktree)) return undefined;
	return `the native session started in ${session.cwd} and the worktree is now ${worktree}; the Claude CLI keys sessions by cwd, so its resume is refused and the job continues on a fresh session`;
}

export const NATIVE_ACK = {
	resumed:
		"resuming: one new native claude process resumes this job's session with the message as its next prompt (run event " +
		"native_run, or the worker's named failure on its observed exit); nothing was steered",
	queued:
		"queued until the current turn ends: a resume after it delivers the message under the same admission and gates " +
		"(run event native_followup_delivered), or native_followup_refused names why not; nothing was steered",
} as const;

// `input` includes cache read and write; the split is optional so a pre-N4a record still parses.
const LedgerSchema = Type.Record(Type.String(), Type.Object({
	input: Type.Integer({ minimum: 0 }), output: Type.Integer({ minimum: 0 }),
	cache_read: Type.Optional(Type.Integer({ minimum: 0 })), cache_write: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false }));

/** `<runDir>/native-claude`, one JSON line. The session id grants nothing: it is only a resume key. */
export const NativeSessionSchema = Type.Object(
	{
		driver: Type.Literal("claude"),
		scratch_dir: Type.String({ minLength: 1 }),
		session_id: Type.Optional(Type.String({ minLength: 1 })),
		/** The worktree the session started in; the CLI keys sessions by cwd. Absent on a pre-N4f record. */
		cwd: Type.Optional(Type.String({ minLength: 1 })),
		/** The dispatch base (`CP_BASE_BRANCH`) at the session's first turn, so a revive keeps it (N4i). */
		base: Type.Optional(Type.String({ minLength: 1 })),
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

/** A revived native job's base: its bound PR's base, then the recorded dispatch base, then the project base. */
export function nativeReviveBase(prBase: string | undefined, sessionFile: string | undefined, projectBase: () => string | undefined): string | undefined {
	let recorded: string | undefined;
	try {
		recorded = sessionFile ? readNativeSession(sessionFile).base : undefined;
	} catch {
		recorded = undefined; // nativeReviveRefusal already refuses an unreadable record by name.
	}
	return prBase ?? recorded ?? projectBase();
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
export function queuedFollowUps(runDir: string, file = join(runDir, NATIVE_FOLLOWUPS_FILE)): string[] {
	if (!existsSync(file)) return [];
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => String((JSON.parse(line) as { message: unknown }).message));
	} catch (error) {
		throw new NativeDriverError(`the native follow-up queue ${file} is unreadable (${(error as Error).message})`);
	}
}

const claimedFile = (runDir: string): string => join(runDir, `${NATIVE_FOLLOWUPS_FILE}.claimed`);

/**
 * Atomically claims the queue for one delivery: renames it aside, so a send queued after this lands in a fresh queue
 * for the next turn end. A claim left by a crash is kept ahead of it. Then `settleClaim` or `returnClaim`.
 */
export function claimFollowUps(runDir: string): string[] {
	const file = join(runDir, NATIVE_FOLLOWUPS_FILE), claimed = claimedFile(runDir);
	if (existsSync(file) && existsSync(claimed)) {
		writeFileSync(claimed, readFileSync(file, "utf8"), { flag: "a", mode: 0o600 });
		rmSync(file);
	} else if (existsSync(file)) renameSync(file, claimed);
	return queuedFollowUps(runDir, claimed);
}

/** The claimed follow-ups were delivered: drop exactly them. */
export const settleClaim = (runDir: string): void => rmSync(claimedFile(runDir), { force: true });

/** Delivery was refused: the claimed follow-ups go back ahead of any queued since, none lost or duplicated. */
export function returnClaim(runDir: string): void {
	const file = join(runDir, NATIVE_FOLLOWUPS_FILE), claimed = claimedFile(runDir);
	if (!existsSync(claimed)) return;
	if (existsSync(file)) writeFileSync(claimed, readFileSync(file, "utf8"), { flag: "a", mode: 0o600 });
	renameSync(claimed, file);
}

/**
 * A native resume's admission before any claude process starts: drain and update hold, trust, per-job budget (plus
 * `pending`, unrecorded turn usage), the N3b selection. `ownPrompt` (picp's settle nudge) skips only the update hold.
 */
export async function assertNativeResume(input: { home: string; jobId: string; what: string; pending?: Usage; env?: NodeJS.ProcessEnv; ownPrompt?: boolean }): Promise<void> {
	const jobs = new FleetStore({ home: input.home }).read().jobs;
	const record = jobs.find((job) => job.job_id === input.jobId);
	const refuse = (why: string): never => {
		throw new NativeDriverError(`refused: ${input.what} of native ${input.jobId}: ${why}`);
	};
	if (!record || isScriptFleetRecord(record) || !record.worker.driver) return refuse("no native fleet record");
	// The update hold stops fresh work; a nudge finishes held work, so it passes the hold, never a drain.
	(input.ownPrompt ? assertNotDraining : assertDispatchOpen)(input.home, `${input.what} of native ${input.jobId}`);
	try {
		nativeModelId(record.worker.model);
	} catch (error) {
		refuse((error as Error).message);
	}
	const denied = projectDenial(input.home, record.project);
	if (denied) refuse(denied);
	if (record.budget) {
		const used = rebuildStatus(input.home, input.jobId).usage;
		const total = input.pending ? Object.fromEntries(Object.entries(used).map(([key, value]) => [key, value + input.pending![key as keyof Usage]])) as Usage : used;
		const check = checkBudget(total, record.budget);
		if (check.state === "exceeded") refuse(`the per-job budget is spent (${check.tokens.used}/${check.tokens.limit} billable tokens, $${check.cost.used.toFixed(4)}/$${check.cost.limit.toFixed(2)})`);
	}
	await assertNativeSelection({ home: input.home, jobId: input.jobId, driver: record.worker.driver as NativeDriver, kind: record.kind, role: record.worker.role, delivery: record.delivery, jobs, ...(input.env ? { env: input.env } : {}) });
	// S2: a rejected window refuses the resume; queued sends stay queued and never move to pi.
	const window = (await nativeAvailability(input.home, record.worker.model, { windowsOnly: true, ...(input.env ? { env: input.env } : {}) })).blocked;
	if (window) refuse(`the subscription window is spent (${window.why})`);
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
	kind: JobKind,
): Promise<string | undefined> {
	const sent = await worker.send(nativeRevivePrompt(kind), "prompt");
	record({ receipt: sent.receipt, ...(sent.disposition ? { disposition: sent.disposition } : {}), native_revive: true, ...(sent.error ? { error: sent.error } : {}) });
	return sent.receipt === "failed" ? `the native worker refused the revive prompt (${sent.error ?? "no error text"})` : undefined;
}

/** Why a native job takes no pi-only follow-up door (a named stop's bounded recovery, a mid-turn steer). */
export function nativeDoorRefusal(jobId: string, door: "bounded recovery" | "steer"): string {
	const why = {
		"bounded recovery": "a turn limit, spent window, auth failure or lockdown is a named stop a human decides; the operator " +
			"revives it with cp_revive",
		steer: "the native driver takes no mid-turn steer; send with mode auto or follow_up to queue it until the turn ends",
	}[door];
	return `${jobId} runs on the native claude driver: ${door} is refused (${why}). Nothing was sent or spawned.`;
}
