import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { layoutForHome, type Mode } from "./contracts.ts";
import { atomicWriteText } from "./json-store.ts";

const DEFAULT_THRESHOLD = 200000;
const WORK_FOCUS = "operator delegation and standing mandate, in-flight jobs and PRs with heads, open decisions, what's on hold, next steps, and the latest handoff paths";

const AUTO = "operator-auto-compact";
const MAX_AUTO_FAILURES = 3;

export type OperatorCompactControl = {
	/** Run now, or after the running compaction ends: a turn started mid-compaction loses it. */
	whenIdle(fn: () => void): void;
};

export function registerOperatorCompact(pi: ExtensionAPI, target: () => { home: string; mode: Mode }): OperatorCompactControl {
	let pending: string | undefined;
	let running: string | undefined;
	let lastCompactAt: string | undefined;
	let requested = false;
	let failures = 0;
	const deferred: Array<() => void> = [];
	const finish = () => {
		running = undefined;
		for (const fn of deferred.splice(0)) fn();
	};
	const paths = () => {
		const { home, mode } = target();
		const layout = layoutForHome(mode, home);
		return { directory: join(home, layout.state, "operator"), settings: join(home, layout.data, "operator.json") };
	};
	const handoffsDir = () => {
		const { settings, directory } = paths();
		try {
			const value = JSON.parse(readFileSync(settings, "utf8"))?.handoffs_dir;
			return typeof value === "string" && value.trim() ? value : directory;
		} catch { return directory; }
	};
	const threshold = () => {
		try {
			const value = JSON.parse(readFileSync(paths().settings, "utf8"))?.compact_at_tokens;
			return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD;
		} catch { return DEFAULT_THRESHOLD; }
	};
	const notify = (ctx: ExtensionContext, text: string, type: "info" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(text, type);
		else pi.sendMessage({ customType: "operator-compact", content: text, display: true }, { deliverAs: "nextTurn" });
	};
	const status = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("operator-context", `operator context: ${ctx.getContextUsage()?.tokens ?? "unknown"}/${threshold()}; last self-compact: ${lastCompactAt ?? "never"}`);
	};

	pi.registerTool({
		name: "self_compact",
		label: "Self compact",
		description: "Queue operator-session compaction after the agent run settles. Write instructions from the current work, at least 200 characters, naming a handoff file path. Include " + WORK_FOCUS + ".",
		parameters: Type.Object({ instructions: Type.String() }, { additionalProperties: false }),
		async execute(_id, params) {
			const instructions = params.instructions.trim();
			if (!instructions) throw new Error("self_compact refused: empty instructions");
			if (instructions.length < 200) throw new Error("self_compact refused: instructions must be at least 200 characters");
			if (!/(?:^|[\s`("'\[])(?:~\/|\/|\.{1,2}\/)?(?:[\w.-]+\/)+[\w.:-]+\.[\w-]+(?=$|[\s`"')\].,;:])/.test(instructions)) {
				throw new Error("self_compact refused: instructions must mention a handoff file path");
			}
			if (pending || running) throw new Error("self_compact refused: compaction already queued or running");
			const handoff = join(paths().directory, `compact-${new Date().toISOString()}.md`);
			const customInstructions = `${instructions}\n\nOperator compaction handoff: ${handoff}\n`;
			try { atomicWriteText(handoff, customInstructions); }
			catch (error) { throw new Error(`self_compact handoff write failed: ${handoff}: ${String(error)}`); }
			pending = customInstructions;
			return { content: [{ type: "text", text: `self_compact queued for agent settlement; handoff: ${handoff}` }], details: { queued: true, handoff } };
		},
	});

	pi.on("session_start", (_event, ctx) => status(ctx));
	const run = (ctx: ExtensionContext, customInstructions: string | undefined, label: string) => {
		running = customInstructions ?? AUTO;
		const onError = (error: Error) => {
			finish();
			failures++;
			const text = `${label} failed: ${error.message}; ${failures < MAX_AUTO_FAILURES ? "the next settle over the threshold compacts automatically" : `automatic compaction stopped after ${failures} failures, run /compact`}`;
			notify(ctx, text, "error");
			// A UI toast is gone after the next repaint; the session must record that context was not reduced.
			if (ctx.hasUI) pi.sendMessage({ customType: "operator-compact", content: text, display: true }, { deliverAs: "nextTurn" });
		};
		try {
			ctx.compact({
				...(customInstructions ? { customInstructions } : {}),
				onComplete: () => {
					finish();
					failures = 0;
					requested = false;
					lastCompactAt = new Date().toISOString();
					status(ctx);
					notify(ctx, `${label} completed`, "info");
				},
				onError,
			});
		} catch (error) { onError(error instanceof Error ? error : new Error(String(error))); }
	};

	pi.on("agent_settled", (_event, ctx) => {
		status(ctx);
		if (pending) {
			const customInstructions = pending;
			pending = undefined;
			run(ctx, customInstructions, "self_compact");
			return;
		}
		if (running) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens === null || tokens === undefined) return;
		const limit = threshold();
		if (tokens < limit) {
			requested = false;
			failures = 0;
			return;
		}
		if (requested) {
			// The request was ignored or its compaction failed: compact anyway, enriched with the latest handoff.
			if (failures < MAX_AUTO_FAILURES) run(ctx, undefined, `automatic compaction at ${tokens}/${limit} tokens`);
			return;
		}
		requested = true;
		pi.sendMessage({
			customType: "operator-compact-request", display: true,
			content: `Context is at ${tokens} tokens, over the ${limit} threshold. Write compaction instructions from the current work: ${WORK_FOCUS}. Then call self_compact. If this run settles without it, compaction runs automatically from the latest handoff.`,
		}, { deliverAs: "followUp", triggerTurn: true });
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (running && event.customInstructions === running) return;
		let instructions = `Compaction instructions: preserve the current work's ${WORK_FOCUS}. Resolve older handoff notes against the current conversation, not as new authorization. Latest operator handoff directory: ${handoffsDir()}`;
		try {
			const directory = paths().directory;
			let files: string[] = [];
			try { files = readdirSync(directory); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const latest = files.filter((name) => /^compact-.*\.md$/.test(name)).sort().at(-1);
			if (latest) {
				const file = join(directory, latest);
				instructions += `\n\nLatest operator handoff (${file}):\n${readFileSync(file, "utf8")}`;
			}
		} catch (error) { notify(ctx, `operator compaction handoff enrichment failed: ${String(error)}; using current conversation and ${handoffsDir()}`, "error"); }
		// Pi has no customInstructions override result here. Enrich the actual
		// prepared input, leaving its default summarizer, cut point and retries intact.
		event.preparation.messagesToSummarize.push({ role: "user", content: instructions, timestamp: Date.now() });
	});

	return { whenIdle: (fn) => { if (running) deferred.push(fn); else fn(); } };
}
