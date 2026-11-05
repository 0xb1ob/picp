/** A Settings model/thinking change switches a live session at its next idle point (`state/model-apply.jsonl`). */
import { join } from "node:path";
import { LAYOUT, type ThinkingLevel } from "./contracts.ts";
import { durableAppend } from "./json-store.ts";
import { parentModelSetting, parentThinkingSetting } from "./parent-context.ts";
import { CpBridgeError } from "./cp-bridge-error.ts";
import type { WorkerProcess } from "./worker-process.ts";

export type ModelApplySession = "parent" | "operator";
export type ModelApplyOutcome = "queued" | "applied" | "cancelled" | "failed";
/** One journal row; `model`/`thinking` name the values it is about (null when unset). */
export interface ModelApplyLine { v: 1; type: "model_apply"; at: string; session: ModelApplySession; state: ModelApplyOutcome; model: string | null; thinking: string | null; reason?: string }
export interface ModelSettings { model: string | undefined; thinking: ThinkingLevel | undefined }
/** `seen`: the file values at session start or at the last apply; `queued`: a `queued` row waits for its outcome. */
export interface ModelApplyTrack { seen: ModelSettings; queued: boolean }
export type ModelApplyPlan = "none" | "queue" | "cancel" | "apply";

export const modelApplyFile = (home: string): string => join(home, LAYOUT.state, "model-apply.jsonl");

/** Appends one 0600 row; returns the error text instead of throwing (a journal must never stop a switch). */
export function appendModelApply(home: string, row: Omit<ModelApplyLine, "v" | "type" | "at">): string | undefined {
	try {
		durableAppend(modelApplyFile(home), `${JSON.stringify({ v: 1, type: "model_apply", at: new Date().toISOString(), ...row } satisfies ModelApplyLine)}\n`, { mode: 0o600 });
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

/** What to do now: a change waits (`queue`) while busy, a revert to `seen` cancels it, a settled session applies. */
export function planModelApply(input: { seen: ModelSettings; desired: ModelSettings; settled: boolean; queued: boolean }): ModelApplyPlan {
	const changed = input.desired.model !== input.seen.model || input.desired.thinking !== input.seen.thinking;
	if (!changed) return input.queued ? "cancel" : "none";
	if (!input.settled) return input.queued ? "none" : "queue";
	return "apply";
}

export const parentFileSettings = (home: string): ModelSettings => ({ model: parentModelSetting(home), thinking: parentThinkingSetting(home) });

export interface ParentApplyPorts {
	/** Why the parent is not settled; `not_running` skips (a stopped parent takes the file at its next start). */
	unsettled: () => string | undefined;
	setModel: (model: string) => Promise<void>;
	setThinking: (level: ThinkingLevel) => Promise<void>;
	model: () => string | undefined;
	/** The live start options: an apply clears what it beats there ("newer action wins" over `cp_parent model`). */
	start: () => { modelExplicit?: boolean; thinking?: ThinkingLevel } | undefined;
	relayError: (text: string) => void;
}

/** `set_thinking_level` over the parent RPC; a refusal throws and the level in force stays. */
export async function requestThinking(proc: Pick<WorkerProcess, "request">, level: ThinkingLevel, timeoutMs?: number): Promise<void> {
	const response = await proc.request("set_thinking_level", { level }, timeoutMs);
	if (response.success === false) throw new CpBridgeError(`set_thinking_level ${level} rejected: ${response.error ?? "unknown error"}`);
}

/** One check of `data/parent.json` against `track`; switches the live parent in place when settled. Never rejects. */
export async function applyParentSettings(home: string, track: ModelApplyTrack, ports: ParentApplyPorts): Promise<void> {
	const unsettled = ports.unsettled();
	if (unsettled === "not_running") return;
	const desired = parentFileSettings(home);
	const plan = planModelApply({ seen: track.seen, desired, settled: !unsettled, queued: track.queued });
	const row = (state: ModelApplyOutcome, values: ModelSettings, reason?: string) => {
		const failed = appendModelApply(home, { session: "parent", state, model: values.model ?? null, thinking: values.thinking ?? null, ...(reason ? { reason } : {}) });
		if (failed) console.error(`parent model apply journal failed: ${failed}`);
	};
	if (plan === "none") return;
	if (plan === "queue") {
		track.queued = true;
		return row("queued", desired);
	}
	if (plan === "cancel") {
		track.queued = false;
		return row("cancelled", desired, "changed back before it applied");
	}
	const previous = track.seen, kept = ports.model();
	// A failure still moves `seen`, so the same failure never loops; the next Settings change retries.
	track.seen = desired;
	track.queued = false;
	const modelChanged = desired.model !== undefined && desired.model !== previous.model && desired.model !== kept;
	try {
		if (modelChanged) await ports.setModel(desired.model!);
		// pi resets thinking on a model switch: re-send the level in force.
		const level = desired.thinking ?? (modelChanged ? ports.start()?.thinking : undefined);
		if (level && (modelChanged || desired.thinking !== previous.thinking)) await ports.setThinking(level);
		const start = ports.start();
		if (start && desired.model !== undefined && desired.model !== previous.model) start.modelExplicit = false;
		if (start && desired.thinking !== undefined && desired.thinking !== previous.thinking) delete start.thinking;
		row("applied", { model: ports.model(), thinking: level ?? desired.thinking });
	} catch (error) {
		const reason = `${(error as Error).message}; ${ports.model() ?? kept ?? "the old model"} still runs`;
		row("failed", desired, reason);
		ports.relayError(`parent Settings model apply failed: ${reason}`);
	}
}

/** A fresh track at a (re)start; a switch still queued before it gets `cancelled`: the start rules applied instead. */
export function seedParentApply(home: string, previous: ModelApplyTrack | undefined): ModelApplyTrack {
	const seen = parentFileSettings(home);
	if (previous?.queued) appendModelApply(home, { session: "parent", state: "cancelled", model: seen.model ?? null, thinking: seen.thinking ?? null, reason: "parent restarted; start rules applied" });
	return { seen, queued: false };
}

/** Rotation applies the file model and thinking unless the start or a live `cp_parent model` made them explicit. */
export async function rotationSettings(home: string, explicit: { model: boolean; thinking: boolean }, kept: string | undefined, ports: Pick<ParentApplyPorts, "setModel" | "setThinking" | "relayError">): Promise<void> {
	const configured = explicit.model ? undefined : parentModelSetting(home);
	if (configured && configured !== kept) await ports.setModel(configured).catch((error: Error) => ports.relayError(`parent rotate kept ${kept}: ${error.message}`));
	const level = explicit.thinking ? undefined : parentThinkingSetting(home);
	if (level) await ports.setThinking(level).catch((error: Error) => ports.relayError(`parent rotate kept thinking: ${error.message}`));
}
