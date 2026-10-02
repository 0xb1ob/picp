import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import type { ParentStatus } from "./cp-bridge.ts";
import { EscalationStore } from "./escalation.ts";
import { FleetStore } from "./fleet.ts";
import { isActive, MandateStore } from "./mandate.ts";
import { parentSendFile, ParentSendOutbox } from "./parent-outbox.ts";
import type { WorkerProcess } from "./worker-process.ts";

export const parentContextFile = (home: string) => join(home, LAYOUT.sessions, "cp-parent-context.json");
export const standingOrdersFile = (home: string) => join(home, LAYOUT.data, "standing-orders.md");

const DEFAULT_STANDING_ORDERS = `# Standing orders

## Relays
- Relays start with [project]. Operator questions use plain words, options and a recommendation.

## Worker briefs
- While editing, run npm run test:one -- tests/<x>.test.ts and npm run typecheck; never run the full npm test locally (CI is the gate). Push after every commit.
- A CI-speed timeout raise is acceptable; keep the 5000 ms floor.

## Review and merge
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

export async function autoParentContext(home: string, missionEnd: string | undefined, control: {
	settled: () => void;
	status: () => Promise<ParentStatus>;
	rotate: () => Promise<unknown>;
	compact: () => Promise<unknown>;
}): Promise<void> {
	const active = new MandateStore(home).list().filter((m) => m.status === "active");
	if (missionEnd && parentContextStatus(home).lastMissionEnd !== missionEnd && active.every((m) => m.id === missionEnd)) {
		control.settled();
		await control.rotate();
		return;
	}
	const stats = await control.status();
	const threshold = parentSettings(home).compact_at_tokens;
	if (threshold && stats.contextTokens !== null && stats.contextTokens !== undefined && stats.contextTokens >= threshold) {
		control.settled();
		await control.compact();
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

export function standingOrdersDigest(home: string): string | undefined {
	const file = standingOrdersFile(home);
	mkdirSync(join(home, LAYOUT.data), { recursive: true });
	try { writeFileSync(file, DEFAULT_STANDING_ORDERS, { flag: "wx" }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const body = readFileSync(file, "utf8").trim();
	if (!body) return undefined;
	return `Standing orders (${file}; local preferences, not authorization; AGENTS.md and docs/contracts.md win on conflict):\n\n${body}`;
}
