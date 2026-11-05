/** Settings `models.operator`/`operator_thinking` switch this live operator session in place at its next idle point. */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layoutForHome, type Mode, type ThinkingLevel } from "../../src/contracts.ts";
import type { OperatorCompactControl } from "../../src/operator-compact.ts";
import { appendModelApply, fileSettings, type ModelApplyOutcome, type ModelApplyTrack, type ModelSettings, planModelApply, relayOnce } from "../../src/session-model-apply.ts";

const STATUS = "settings-apply";

/**
 * `session_start` seeds from the LIVE model and thinking, so a saved value that differs applies at every start (resume and
 * Restart clean included); `agent_settled` and `check` (the Settings write hook) apply later changes. Never restarts.
 */
export function registerOperatorModelApply(pi: ExtensionAPI, target: () => { home: string; mode: Mode }, compaction: OperatorCompactControl): { check: () => void } {
	let ctx: ExtensionContext | undefined;
	let track: ModelApplyTrack | undefined;
	let chain = Promise.resolve();
	const status = (line: string | undefined) => {
		if (ctx?.hasUI) ctx.ui.setStatus(STATUS, line);
		else if (line) process.stderr.write(`${line}\n`);
	};
	const say = (text: string) => { if (track) relayOnce(track, text, (line) => status(`${STATUS}: ${line}`)); };
	const live = (): ModelSettings => ({ model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, thinking: pi.getThinkingLevel() as ThinkingLevel });
	const run = async (): Promise<void> => {
		if (!ctx || !track) return;
		const { home, mode } = target();
		let desired: ModelSettings;
		try { desired = fileSettings(join(home, layoutForHome(mode, home).data, "operator.json")); }
		catch (error) { return say(`operator Settings model apply skipped: data/operator.json unreadable (${(error as Error).message})`); }
		track.relayed = undefined;
		const row = (state: ModelApplyOutcome, values: ModelSettings, reason?: string) => {
			const failed = appendModelApply(home, { session: "operator", state, model: values.model ?? null, thinking: values.thinking ?? null, ...(reason ? { reason } : {}) });
			if (failed) say(`operator model apply journal failed: ${failed}`);
		};
		const plan = planModelApply({ seen: track.seen, desired, settled: ctx.isIdle() && !compaction.compacting(), queued: track.queued });
		if (plan === "none") return;
		if (plan === "queue") { track.queued = true; return row("queued", desired); }
		if (plan === "cancel") { track.queued = false; return row("cancelled", desired, "changed back before it applied"); }
		const previous = track.seen, kept = live();
		// A failure still moves `seen`, so the same failure never loops; the next Settings change retries.
		track.seen = desired;
		track.queued = false;
		const modelChanged = desired.model !== undefined && desired.model !== previous.model && desired.model !== kept.model;
		try {
			if (modelChanged) {
				const slash = desired.model!.indexOf("/");
				const model = ctx.modelRegistry.find(desired.model!.slice(0, slash), desired.model!.slice(slash + 1));
				if (!model) throw new Error(`${desired.model} is not in pi's model registry`);
				if (!(await pi.setModel(model))) throw new Error(`no auth configured for ${desired.model}`);
			}
			// pi resets thinking to its default on a model switch: re-send the saved level, else the one in force.
			const level = desired.thinking ?? (modelChanged ? kept.thinking : undefined);
			if (level && (modelChanged || desired.thinking !== previous.thinking)) pi.setThinkingLevel(level);
			status(undefined);
			row("applied", { model: live().model, thinking: desired.thinking });
		} catch (error) {
			const reason = `${(error as Error).message}; ${live().model ?? "the old model"} still runs`;
			row("failed", desired, reason);
			say(`operator Settings model apply failed: ${reason}`);
		}
	};
	const check = (): void => compaction.whenIdle(() => {
		chain = chain.then(run).catch((error: Error) => say(`operator Settings model apply failed: ${error.message}`));
	});
	pi.on("session_start", (_event, started) => {
		ctx = started;
		try {
			const { home, mode } = target();
			const file = fileSettings(join(home, layoutForHome(mode, home).data, "operator.json")), actual = live();
			// Only the keys the file sets are compared: an unset key never moves the session.
			track = { seen: { model: file.model && actual.model, thinking: file.thinking && actual.thinking }, queued: false };
		} catch {
			track = { seen: { model: undefined, thinking: undefined }, queued: false }; // `run` says why the file is unreadable
		}
		check();
	});
	pi.on("agent_settled", (_event, settled) => { ctx = settled ?? ctx; check(); });
	return { check };
}
