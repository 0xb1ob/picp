import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import type { ParentStatus } from "./cp-bridge.ts";
import { EscalationStore } from "./escalation.ts";
import { FleetStore } from "./fleet.ts";
import { isActive, MandateStore } from "./mandate.ts";
import { parentSendFile, ParentSendOutbox } from "./parent-outbox.ts";
import { daemonPaths } from "./service/daemon-files.ts";
import type { WorkerProcess } from "./worker-process.ts";

export const parentContextFile = (home: string) => join(home, LAYOUT.sessions, "cp-parent-context.json");
export const standingOrdersFile = (home: string) => join(home, LAYOUT.data, "standing-orders.md");

const DEFAULT_STANDING_ORDERS = `# Standing orders

## Relays
- Relays start with [project]. Operator questions use plain words, options and a recommendation.

## Worker briefs
- While editing, run npm run test:one -- tests/<x>.test.ts and npm run typecheck; never run the full npm test locally (CI is the gate). Push after every commit.
- A CI-speed timeout raise is acceptable; keep the 5000 ms floor.

## Planning
- A bead with state transitions or merge gating goes planner-first.

## Review and merge
- Start review only on a green pushed head, and merge only that reviewed head. This holds for updated and conflict-resolved heads too.
- Merge when CI is green and review has passed; check verdicts at their due time.
- If server-side rebase fails, have the worker make a plain merge of origin/main and push.
- A cp_decide quote must be one complete operator sentence, verbatim, ending with punctuation.
`;

export function parentContextStatus(home: string): {
	contextTokens?: number | null;
	lastCompactAt?: string;
	lastRotateAt?: string;
	lastMissionEnd?: string;
	lastTurnCostUsd?: number;
	totalCostUsd?: number;
} {
	try { return JSON.parse(readFileSync(parentContextFile(home), "utf8")); } catch { return {}; }
}

export const DEFAULT_PARENT_COMPACT_TOKENS = 200000;

/** Absent parent.json → the default; an explicit file with a bad value stays `{}` (disabled, doctor warns). */
export function parentSettings(home: string): { compact_at_tokens?: number } {
	let value: unknown;
	try { value = JSON.parse(readFileSync(join(home, LAYOUT.data, "parent.json"), "utf8")); } catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { compact_at_tokens: DEFAULT_PARENT_COMPACT_TOKENS } : {};
	}
	const limit = (value as { compact_at_tokens?: unknown } | null)?.compact_at_tokens;
	return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? { compact_at_tokens: limit } : {};
}

export function parentCompactInstructions(home: string): string {
	const escalations = new EscalationStore({ home }).open().map((item) => item.id);
	const held = new FleetStore({ home }).list({ phase: "held", delivery: "pr" }).map((job) => job.job_id);
	const now = new Date().toISOString();
	const mandates = new MandateStore(home).list().filter((item) => isActive(item, now)).map((item) => item.id);
	const sends = new ParentSendOutbox({ file: parentSendFile(join(home, LAYOUT.sessions, "cp-parent.jsonl")) })
		.list().filter((entry) => ["queued", "injected", "landed"].includes(entry.state)).map((entry) => entry.id);
	return [
		"Keep open escalations, holds, standing operator instructions, in-flight PRs and next actions.",
		`Open escalation ids: ${escalations.join(", ") || "(none)"}`,
		`Held PR jobs: ${held.join(", ") || "(none)"}`,
		`Active mandate ids: ${mandates.join(", ") || "(none)"}`,
		`Bridge sends not yet settled: ${sends.join(", ") || "(none)"}`,
	].join("\n");
}

export function missionEndOf(result: unknown): string | undefined {
	const details = (result as { details?: { action?: { kind?: string }; mandate?: { id?: string }; others?: Array<{ action?: { kind?: string }; mandate?: { id?: string } }> } } | undefined)?.details;
	return [details, ...(details?.others ?? [])].find((item) => item?.action?.kind === "mission_end")?.mandate?.id;
}

export async function liveParentStatus(
	proc: WorkerProcess | undefined, ready: boolean, timeout: number | undefined,
	status: () => ParentStatus, record: (update: Record<string, unknown>) => void,
): Promise<ParentStatus> {
	if (!proc?.alive || !ready) return status();
	const response = await proc.request("get_session_stats", {}, timeout);
	if (response.success === false) throw new Error(`get_session_stats rejected: ${response.error ?? "unknown error"}`);
	const usage = response.data as { contextUsage?: { tokens?: number | null }; cost?: number } | undefined;
	const homeStatus = status();
	const cost = usage?.cost;
	const lastTurnCostUsd = typeof cost === "number" && typeof homeStatus.totalCostUsd === "number" && cost > homeStatus.totalCostUsd ? cost - homeStatus.totalCostUsd : undefined;
	record({ contextTokens: usage?.contextUsage?.tokens ?? null, ...(cost !== undefined ? { totalCostUsd: cost } : {}), ...(lastTurnCostUsd !== undefined ? { lastTurnCostUsd } : {}) });
	return { ...status(), contextTokens: usage?.contextUsage?.tokens ?? null };
}

/** The fields of an assistant message the effective-context rule reads (pi `AssistantMessage`, structurally). */
export interface AssistantLike {
	role?: string;
	stopReason?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
	content?: unknown;
}

const usageTokens = (usage: AssistantLike["usage"]): number =>
	usage ? usage.totalTokens || (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;

/** pi's `getLastAssistantUsage`: the newest assistant with usable usage (no error/aborted/zero usage), entries or messages; none past a compaction. */
export function lastValidAssistant(items: readonly unknown[] | undefined): AssistantLike | undefined {
	for (let index = (items?.length ?? 0) - 1; index >= 0; index--) {
		const item = items![index] as (AssistantLike & { type?: string; message?: AssistantLike }) | null;
		if (item?.type === "compaction") return undefined;
		const message = item?.type === "message" ? item.message : item;
		if (message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && usageTokens(message.usage) > 0) return message;
	}
	return undefined;
}

function storedChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<{ text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown }>) {
		for (const value of [block?.text, block?.thinking, block?.name]) if (typeof value === "string") chars += value.length;
		if (block?.arguments !== undefined) chars += JSON.stringify(block.arguments).length;
	}
	return chars;
}

/**
 * N6: a `length` stop's billed `output` was discarded (only ~its stored content is kept),
 * so it is not context. One rule for the bridge, the parent's hold and the threshold cancel.
 */
export function effectiveContextTokens(tokens: number | null | undefined, last?: AssistantLike): number | null {
	if (tokens === null || tokens === undefined) return null;
	const output = last?.stopReason === "length" ? last.usage?.output ?? 0 : 0;
	return output > 0 ? Math.max(0, tokens - output) + Math.ceil(storedChars(last!.content) / 4) : tokens;
}

/** One `state/daemon.log` line (`cp-daemon log` shows it). Never throws: a failed write goes to stderr. */
export function parentContextLog(home: string, source: string, line: string): void {
	const text = `${new Date().toISOString()} ${source}[${process.pid}]: parent context ${line}\n`;
	try {
		const file = daemonPaths(home).log;
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, text, { mode: 0o600 });
	} catch (error) {
		process.stderr.write(`daemon.log unwritable (${(error as Error).message}): ${text}`);
	}
}

/** One automatic-control pass. `event` absent: below the threshold or unknown, nothing done. */
export interface ParentContextOutcome {
	rotated?: string;
	rotateFailed?: string;
	event?: "compacted" | "refused" | "failed" | "timed_out" | "skipped_length_stop";
	raw?: number;
	effective?: number;
	threshold?: number;
	error?: string;
	ms?: number;
	before?: number;
	after?: number;
}

const COMPACT_TIMEOUT = /^timeout after \d+ms waiting for response to compact/;

/** Never rejects: every failure is an outcome the caller logs. A failed mission-end rotate falls through to the threshold check. */
export async function autoParentContext(home: string, missionEnd: string | undefined, lastAssistant: AssistantLike | undefined, control: {
	/** Why the parent cannot compact now, or undefined when it can. */
	unsettled: () => string | undefined;
	status: () => Promise<ParentStatus>;
	rotate: () => Promise<unknown>;
	compact: () => Promise<{ tokensBefore?: number; estimatedTokensAfter?: number }>;
}): Promise<ParentContextOutcome> {
	const outcome: ParentContextOutcome = {};
	const active = new MandateStore(home).list().filter((m) => m.status === "active");
	if (missionEnd && parentContextStatus(home).lastMissionEnd !== missionEnd && active.every((m) => m.id === missionEnd)) {
		try {
			await control.rotate();
			return { rotated: missionEnd };
		} catch (error) { outcome.rotateFailed = (error as Error).message; }
	}
	let raw: number | null | undefined;
	try { raw = (await control.status()).contextTokens; } catch (error) { return { ...outcome, event: "failed", error: (error as Error).message }; }
	const threshold = parentSettings(home).compact_at_tokens;
	if (!threshold || raw === null || raw === undefined || raw < threshold) return outcome;
	const effective = effectiveContextTokens(raw, lastAssistant)!;
	Object.assign(outcome, { raw, effective, threshold });
	if (effective < threshold) return { ...outcome, event: "skipped_length_stop" };
	const refused = control.unsettled();
	if (refused) return { ...outcome, event: "refused", error: refused };
	const started = Date.now();
	try {
		const result = await control.compact();
		return { ...outcome, event: "compacted", ms: Date.now() - started, ...(result.tokensBefore !== undefined ? { before: result.tokensBefore } : {}), ...(result.estimatedTokensAfter !== undefined ? { after: result.estimatedTokensAfter } : {}) };
	} catch (error) {
		const message = (error as Error).message;
		return { ...outcome, event: COMPACT_TIMEOUT.test(message) ? "timed_out" : "failed", error: message, ms: Date.now() - started };
	}
}

export function parentBridgeStatus(
	home: string | undefined,
	state: Pick<ParentStatus, "alive" | "pid" | "sessionFile" | "lastReplyAt" | "model" | "sends">,
	pathsFor: (home: string, jobs: readonly string[], evidence: readonly string[]) => string[],
): ParentStatus {
	let openEscalations: ParentStatus["openEscalations"] = [];
	let escalationsError: string | undefined;
	const paths: string[] = [];
	if (home) {
		try {
			openEscalations = new EscalationStore({ home }).open().map((item) => ({
				id: item.id, job_ids: item.job_ids, kind: item.kind,
				question: item.question, evidence_paths: item.evidence_paths, status: item.status,
			}));
			for (const item of openEscalations) paths.push(...pathsFor(home, item.job_ids, item.evidence_paths));
		} catch (error) { escalationsError = (error as Error).message; }
	}
	let standingOrders: ParentStatus["standingOrders"];
	if (home) {
		const path = standingOrdersFile(home);
		try { standingOrders = { path, modifiedAt: statSync(path).mtime.toISOString() }; } catch { /* optional */ }
	}
	return {
		...(home ? parentContextStatus(home) : {}),
		...(home && parentSettings(home).compact_at_tokens ? { compactAtTokens: parentSettings(home).compact_at_tokens } : {}),
		...(standingOrders ? { standingOrders } : {}),
		...state,
		openEscalations,
		paths: [...new Set(paths)],
		...(escalationsError ? { escalationsError } : {}),
	};
}

export function deliverStandingOrders(
	send: (message: { customType: string; content: string; display: boolean }, options: { triggerTurn: false }) => void,
	home: string,
): boolean {
	const content = standingOrdersDigest(home);
	if (!content) return false;
	send({ customType: "cp-standing-orders", content, display: false }, { triggerTurn: false });
	return true;
}

const DIGEST_TYPES = ["cp-memory", "cp-standing-orders"] as const;

/**
 * picp-99l: a resumed parent session re-ran `session_start` and appended the same
 * cp-memory + cp-standing-orders pair again. True when the latest pair since the last
 * compaction already equals `messages`; a compaction (or a changed digest) means send.
 */
export function digestsInContext(
	branch: readonly { type: string; customType?: string; content?: unknown }[],
	messages: readonly { customType: string; content: string }[],
): boolean {
	const latest = new Map<string, unknown>();
	for (let index = branch.length - 1; index >= 0 && branch[index]!.type !== "compaction"; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom_message" && entry.customType && !latest.has(entry.customType)) latest.set(entry.customType, entry.content);
	}
	return messages.length > 0 && DIGEST_TYPES.every((type) => latest.get(type) === messages.find((message) => message.customType === type)?.content);
}

export function standingOrdersDigest(home: string): string | undefined {
	const file = standingOrdersFile(home);
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	try { writeFileSync(file, DEFAULT_STANDING_ORDERS, { flag: "wx" }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const body = readFileSync(file, "utf8").trim();
	if (!body) return undefined;
	return `Standing orders (${file}; local preferences, not authorization; AGENTS.md and docs/contracts.md win on conflict):\n\n${body}`;
}
