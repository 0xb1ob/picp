/**
 * cp-gb3w: one UI for every Awaiting-you surface.
 *
 * The routing decision (overlay where it can render, the plain prompts with a
 * stated reason where it cannot) is a function, per surface, so it is asserted
 * here rather than eyeballed on a terminal. The invariants the change must not
 * weaken are asserted alongside it: only a verdict row is a verdict, typed text
 * on an authorization is a note and never one, a skip writes nothing, and this
 * module can write nothing at all.
 *
 * A green suite is **not** evidence that the overlay renders (AGENTS.md,
 * cur-20260901-5). It is evidence that the choice between the two UIs, and
 * everything that hangs off that choice, is the documented one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { commandPostSource } from "./harness/pi-child.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyPromptWorking,
	askCheckpointUnderLatch,
	autoOpenDecision,
	AWAITING_SURFACE_LABEL,
	type AwaitingSurface,
	canAutoOpenOverlay,
	checkpointQuestion,
	HumanPrompt,
	overlayTimeoutMs,
	promptBusyNotice,
	SingleRunLatch,
	endedByOperator,
	interpretCheckpointAnswer,
	overlayFallbackNotice,
	routeAwaitingUi,
	snoozeCandidates,
	surfaceBusyNotice,
} from "../src/awaiting-ui.ts";
import { canAutoOpenDialog } from "../src/awaiting.ts";
import { AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS, AWAITING_DIALOG_TIMEOUT_MS } from "../src/contracts.ts";
import {
	QUESTIONNAIRE_MAX_HEADER_LENGTH,
	QUESTIONNAIRE_MAX_LABEL_LENGTH,
	QUESTIONNAIRE_MAX_OPTIONS,
	QUESTIONNAIRE_MIN_OPTIONS,
	QUESTIONNAIRE_RESERVED_LABELS,
} from "../src/awaiting-questionnaire.ts";
import type { ResolvedAwaitingItem } from "../src/awaiting.ts";
import {
	askCheckpointDecision,
	askQuestionnaire,
	ASK_TOOL_NAME,
	type AskToolDefinition,
	type AskToolLoad,
	type AskToolParams,
	type AskToolQuestionnaireResult,
	overlayDeadlineContext,
	OVERLAY_CANCELLED_RESULT,
	OVERLAY_NO_CLOSE_HANDLE_NOTICE,
} from "../extensions/command-post/questionnaire.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SURFACES: AwaitingSurface[] = ["decide", "auto_open", "checkpoint"];

function item(overrides: Partial<ResolvedAwaitingItem> = {}): ResolvedAwaitingItem {
	return {
		id: "aw-1",
		type: "approval",
		decision: "Ship cp-x, drop it, or open a follow-up?",
		why: "research finished with no PR",
		blocks: "the whole pipeline",
		options: ["ship", "drop", "follow-up"],
		opened_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. The routing decision, per surface
// ---------------------------------------------------------------------------

test("every surface takes the overlay in a real TUI", () => {
	for (const surface of SURFACES) {
		assert.deepEqual(routeAwaitingUi(surface, { mode: "tui", hasUI: true }), { ui: "overlay" }, surface);
	}
});

test("every surface degrades to the plain prompts, with a reason, where the overlay cannot render", () => {
	const contexts = [
		{ name: "rpc re-entry", env: { mode: "rpc", hasUI: true }, match: /not a TUI \(mode: rpc\)/ },
		{ name: "pi -p", env: { mode: "print", hasUI: false }, match: /no UI is attached/ },
		{ name: "json", env: { mode: "json", hasUI: false }, match: /no UI is attached/ },
		{ name: "headless tui", env: { mode: "tui", hasUI: false }, match: /no UI is attached/ },
	];
	for (const surface of SURFACES) {
		for (const context of contexts) {
			const route = routeAwaitingUi(surface, context.env);
			assert.equal(route.ui, "plain", `${surface}/${context.name}`);
			assert.match(route.ui === "plain" ? route.reason : "", context.match);
			// Degrade, never fail: the reason is a sentence, not an error.
			assert.ok((route.ui === "plain" ? route.reason : "").length > 0);
		}
	}
});

test("CP_HEADLESS never opens the overlay, even in a TUI", () => {
	for (const surface of SURFACES) {
		const route = routeAwaitingUi(surface, { mode: "tui", hasUI: true }, { CP_HEADLESS: "1" });
		assert.equal(route.ui, "plain", surface);
		assert.match(route.ui === "plain" ? route.reason : "", /CP_HEADLESS/);
	}
	assert.equal(canAutoOpenOverlay({ mode: "tui", hasUI: true }, { CP_HEADLESS: "1" }), false);
});

test("the fallback notice names the surface, the reason and the fallback", () => {
	for (const surface of SURFACES) {
		const notice = overlayFallbackNotice(surface, "not installed anywhere");
		assert.ok(notice.startsWith(AWAITING_SURFACE_LABEL[surface]), surface);
		assert.match(notice, /questionnaire overlay is unavailable/);
		assert.match(notice, /not installed anywhere/);
		assert.match(notice, /plain dialogs/);
	}
	// A reasonless failure still says something rather than trailing off.
	assert.match(overlayFallbackNotice("decide", ""), /no reason given/);
});

// ---------------------------------------------------------------------------
// 2. The checkpoint ask, as one overlay question
// ---------------------------------------------------------------------------

test("a checkpoint question fits the package's schema, for every kind", () => {
	const asks = [
		{ job_id: "cp-a" },
		{ job_id: "cp-a", kind: "diff" },
		{ job_id: "cp-a", kind: "merge", scope: "0123456789abcdef" },
	];
	for (const ask of asks) {
		const question = checkpointQuestion(ask);
		assert.ok(question.question.includes("cp-a"));
		assert.ok(question.header.length <= QUESTIONNAIRE_MAX_HEADER_LENGTH);
		assert.ok(question.options.length >= QUESTIONNAIRE_MIN_OPTIONS);
		assert.ok(question.options.length <= QUESTIONNAIRE_MAX_OPTIONS);
		for (const option of question.options) {
			assert.ok(option.label.length <= QUESTIONNAIRE_MAX_LABEL_LENGTH);
			assert.ok(!QUESTIONNAIRE_RESERVED_LABELS.has(option.label), option.label);
			assert.ok(option.description.length > 0, "every row says what it means");
		}
	}
	assert.match(checkpointQuestion({ job_id: "cp-a", kind: "merge", scope: "0123456789ab" }).question, /merge 0123456789ab/);
});

test("only a verdict row is a verdict: text, not-now, Esc and an untouched tab are not", () => {
	assert.deepEqual(interpretCheckpointAnswer({ kind: "option", label: "approve" }), { approved: true });
	assert.deepEqual(interpretCheckpointAnswer({ kind: "option", label: "decline" }), { approved: false });
	assert.equal(interpretCheckpointAnswer({ kind: "option", label: "not now" }), undefined);
	assert.equal(interpretCheckpointAnswer({ kind: "none" }), undefined);
	assert.equal(interpretCheckpointAnswer(undefined), undefined);
	// Free text on an authorization is a note, never a verdict — even when it
	// reads like one. The checkpoint stays pending and reappears in Awaiting you.
	for (const text of ["approve", "yes", "ship it", "approve — the gate passed"]) {
		const outcome = interpretCheckpointAnswer({ kind: "custom", text });
		assert.deepEqual(outcome, { note: text }, text);
		assert.ok(!(outcome && "approved" in outcome));
	}
	assert.equal(interpretCheckpointAnswer({ kind: "custom", text: "   " }), undefined);
});

// ---------------------------------------------------------------------------
// 3. "Do not nag" is one rule for both runs
// ---------------------------------------------------------------------------

test("an answered row is never snoozed; a touched one is, and so is the whole batch the operator ended", () => {
	const offered = [item(), item({ id: "aw-2" }), item({ id: "aw-3" })];
	const answeredOnly = snoozeCandidates({
		steps: [
			{ kind: "answered", id: "aw-1", value: "ship" },
			{ kind: "skipped", id: "aw-2" },
		],
		offered,
		endedByOperator: false,
	});
	assert.deepEqual(answeredOnly.map((entry) => entry.id), ["aw-2"]);

	const ended = snoozeCandidates({
		steps: [{ kind: "answered", id: "aw-1", value: "ship" }],
		offered,
		endedByOperator: true,
	});
	assert.deepEqual(ended.map((entry) => entry.id), ["aw-2", "aw-3"]);

	// Reading the plan is a step, not an answer and not a dismissal.
	const viewed = snoozeCandidates({ steps: [{ kind: "viewed", id: "aw-1" }], offered, endedByOperator: false });
	assert.deepEqual(viewed, []);
});

test("both loops agree on what ending a run means, and the plain loop's behaviour is unchanged", () => {
	for (const reason of ["done", "dismissed", "exhausted", "cancelled"]) assert.equal(endedByOperator(reason), true, reason);
	for (const reason of ["empty", "unavailable", "error"]) assert.equal(endedByOperator(reason), false, reason);

	// `cancelled` is new here — it is the questionnaire's Esc. It must be inert on
	// the plain path, which is only true because `driveAwaitingDialog` cannot
	// return it: read its own reason union rather than trusting the claim.
	const dialogSource = readFileSync(resolve(HERE, "../src/awaiting-dialog.ts"), "utf8");
	const union = dialogSource.split("export type AwaitingDialogReason =")[1]?.split(";")[0] ?? "";
	const plainReasons = [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((match) => match[1] as string);
	assert.deepEqual(plainReasons.sort(), ["dismissed", "done", "empty", "error", "exhausted"]);
	assert.ok(!plainReasons.includes("cancelled"), "the plain dialog can never report cancelled");
	// For every reason the plain loop *can* report, the shared rule is exactly the
	// rule the inline code had before cp-gb3w.
	const previousRule = (reason: string) => reason === "done" || reason === "dismissed" || reason === "exhausted";
	for (const reason of plainReasons) assert.equal(endedByOperator(reason), previousRule(reason), reason);
});

// ---------------------------------------------------------------------------
// 3b. The unattended surface cannot reach the deadline-less overlay
// ---------------------------------------------------------------------------

test("the auto-open reaches the overlay only where an interactive TUI is proven", () => {
	// The overlay carries no deadline and no external cancel, so the property the
	// timeout-bearing prompts used to hold on this path is now this gate. Both
	// halves must hold, and neither may be satisfiable alone.
	const nonHuman = [
		{ name: "rpc client", env: { mode: "rpc", hasUI: true } },
		{ name: "rpc, no ui", env: { mode: "rpc", hasUI: false } },
		{ name: "pi -p", env: { mode: "print", hasUI: false } },
		{ name: "json", env: { mode: "json", hasUI: false } },
		{ name: "headless tui", env: { mode: "tui", hasUI: false } },
		// A worker never loads this extension at all; if one ever did, it is one of
		// the shapes above — `--mode rpc` with no human attached.
		{ name: "worker (rpc)", env: { mode: "rpc", hasUI: true } },
	];
	for (const context of nonHuman) {
		assert.equal(canAutoOpenOverlay(context.env), false, context.name);
		// Whichever half is false, the outcome is the same: no deadline-less overlay.
		assert.ok(
			!canAutoOpenDialog(context.env) || routeAwaitingUi("auto_open", context.env).ui === "plain",
			context.name,
		);
	}
	assert.equal(canAutoOpenOverlay({ mode: "tui", hasUI: true }), true);
	// The conjunction is not weaker than either half, for every shape either can see.
	for (const mode of ["tui", "rpc", "print", "json", "unknown"]) {
		for (const hasUI of [true, false]) {
			const env = { mode, hasUI };
			assert.equal(
				canAutoOpenOverlay(env),
				canAutoOpenDialog(env) && routeAwaitingUi("auto_open", env).ui === "overlay",
				`${mode}/${hasUI}`,
			);
			if (canAutoOpenOverlay(env)) assert.equal(canAutoOpenDialog(env), true, `${mode}/${hasUI}`);
		}
	}
});

/**
 * The gate must be the condition that *runs*, not one that is only asserted:
 * review 1's fix proved a function nobody called. This reads the settle hook
 * itself, whitespace-insensitively, and fails if the call site is deleted.
 */
test("the settle hook is gated on canAutoOpenOverlay before any dialog opens", () => {
	const source = commandPostSource();
	const handler = source.split('pi.on("agent_settled"')[1]?.split("pi.registerCommand")[0] ?? "";
	const code = handler.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
	assert.match(code, /if \( ?!canAutoOpenOverlay\(ctx\)[^;]*\) return;/, "the hook calls the gate it claims to");
	assert.ok(
		code.indexOf("canAutoOpenOverlay(ctx)") < code.indexOf("runAwaitingDialog"),
		"and it is checked before the dialog runs",
	);
	// It is a production call site, not only a test import.
	assert.ok(source.includes("canAutoOpenOverlay,"), "imported for real");
	// And the rest of the hook's decision is the tested function, not a shape.
	assert.match(code, /if \( ?!autoOpenDecision\(\{ env: ctx, latchBusy: awaitingLatch\.busy || humanPrompt\.open, items \}\)\.open ?\) return;/);
});

test("the settle decision itself: a human surface, a free latch, something open", () => {
	const items = [item()];
	assert.deepEqual(autoOpenDecision({ env: { mode: "tui", hasUI: true }, latchBusy: false, items }), {
		open: true,
		reason: "open",
	});
	for (const env of [{ mode: "rpc", hasUI: true }, { mode: "print", hasUI: false }, { mode: "tui", hasUI: false }]) {
		assert.deepEqual(autoOpenDecision({ env, latchBusy: false, items }), {
			open: false,
			reason: "no_human_surface",
		});
	}
	assert.deepEqual(autoOpenDecision({ env: { mode: "tui", hasUI: true }, latchBusy: true, items }), {
		open: false,
		reason: "busy",
	});
	assert.deepEqual(autoOpenDecision({ env: { mode: "tui", hasUI: true }, latchBusy: false, items: [] }), {
		open: false,
		reason: "nothing_open",
	});
	// A batch that is entirely snoozed is "do not nag", not a new prompt.
	assert.equal(
		autoOpenDecision({
			env: { mode: "tui", hasUI: true },
			latchBusy: false,
			items: [item({ snoozed: true })],
		}).reason,
		"nothing_open",
	);
});

// ---------------------------------------------------------------------------
// 3c. The unattended overlay has a deadline; the surfaces a human asked for do not
// ---------------------------------------------------------------------------

test("only the auto-open carries a deadline, and it is the one the plain dialog had", () => {
	assert.equal(overlayTimeoutMs("auto_open"), AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS);
	assert.equal(AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS, AWAITING_DIALOG_TIMEOUT_MS, "same number as before, not longer");
	// Seconds, not minutes-as-an-afterthought and certainly not days.
	assert.ok(AWAITING_AUTO_OPEN_OVERLAY_TIMEOUT_MS <= 60 * 60 * 1000, "an unattended surface is bounded in seconds");
	assert.equal(overlayTimeoutMs("decide"), undefined, "a human typed /cp-decide");
	assert.equal(overlayTimeoutMs("checkpoint"), undefined, "a human is being asked");
});

test("index.ts passes the deadline through, per surface, rather than hard-coding one", () => {
	const source = commandPostSource();
	const code = source.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
	assert.match(code, /timeoutMs: overlayTimeoutMs\(surface\)/);
});

test("the latch always releases: a body that throws, times out or returns early", async () => {
	const latch = new SingleRunLatch();
	assert.equal(latch.busy, false);
	assert.equal(latch.holder, undefined);

	// A second run while one is in flight is refused, and refusing does not
	// disturb the first (this is what stops an auto-open stacking on a manual run).
	let release: (() => void) | undefined;
	const inFlight = latch.run("decide", async () => {
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return "first";
	});
	assert.equal(latch.busy, true);
	// pi-command-post-p18: refused, and the refusal names who is on screen.
	assert.equal(latch.holder, "decide");
	assert.deepEqual(await latch.run("checkpoint", async () => "second"), { ran: false, holder: "decide" });
	assert.deepEqual(await latch.run("auto_open", async () => "second"), { ran: false, holder: "decide" });
	release?.();
	assert.deepEqual(await inFlight, { ran: true, value: "first" });
	assert.equal(latch.busy, false, "released after a normal run");
	assert.equal(latch.holder, undefined, "and the holder is cleared");

	// An attached-but-absent operator: the body ends on its deadline rather than
	// on an answer. The latch is free again, so the next settle can open.
	await latch.run("auto_open", async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
	});
	assert.equal(latch.busy, false, "released after a timed-out run");

	await assert.rejects(latch.run("checkpoint", async () => {
		throw new Error("boom");
	}));
	assert.equal(latch.busy, false, "released after a throwing run");
	assert.equal(latch.holder, undefined, "and the holder is cleared after a throw");
	assert.deepEqual(await latch.run("decide", async () => "again"), { ran: true, value: "again" });
});

/**
 * pi-command-post-p18: the defect was two *different* owners each reaching
 * `ctx.ui.custom`. The latch is now the thing that makes "one operator-facing
 * overlay at a time" a property rather than a coincidence of timing, so the
 * checkpoint ask takes it too — and when it loses, it asks nothing and writes
 * nothing.
 */
test("a checkpoint ask under the latch: refused while another surface is on screen", async () => {
	for (const holder of ["decide", "auto_open"] as const) {
		const latch = new SingleRunLatch();
		let release: (() => void) | undefined;
		const inFlight = latch.run(holder, async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		});

		const notices: string[] = [];
		let asked = 0;
		const verdict = await askCheckpointUnderLatch(
			latch,
			async () => {
				asked += 1;
				return { approved: true };
			},
			{ notify: (text) => notices.push(text) },
		);

		assert.equal(verdict, undefined, `${holder}: "not now", never a decline`);
		assert.equal(asked, 0, `${holder}: no second overlay was opened`);
		assert.deepEqual(notices, [surfaceBusyNotice(holder, "checkpoint")], `${holder}: told once, naming the surface`);
		assert.match(notices[0] ?? "", /nothing was asked and nothing was written/);
		assert.ok((notices[0] ?? "").includes(AWAITING_SURFACE_LABEL[holder]), `${holder}: the holder is named`);

		release?.();
		await inFlight;
		assert.equal(latch.busy, false, `${holder}: the first surface is undisturbed`);
	}
});

test("a checkpoint ask under a free latch asks exactly once and returns the verdict", async () => {
	const latch = new SingleRunLatch();
	const notices: string[] = [];
	let asked = 0;
	const verdict = await askCheckpointUnderLatch(
		latch,
		async () => {
			asked += 1;
			assert.equal(latch.holder, "checkpoint", "it holds the latch while it asks");
			return { approved: false };
		},
		{ notify: (text) => notices.push(text) },
	);
	assert.deepEqual(verdict, { approved: false });
	assert.equal(asked, 1);
	assert.deepEqual(notices, [], "nothing to say when nothing was refused");
	assert.equal(latch.busy, false, "released");

	// "Not now" from the ask itself is still "not now", and still releases.
	assert.equal(await askCheckpointUnderLatch(latch, async () => undefined), undefined);
	assert.equal(latch.busy, false);
	// No notify port (headless) is not a failure: the row and the marker carry it.
	const busy = new SingleRunLatch();
	let release: (() => void) | undefined;
	const held = busy.run("decide", () => new Promise<void>((resolve) => (release = resolve)));
	assert.equal(await askCheckpointUnderLatch(busy, async () => ({ approved: true })), undefined);
	release?.();
	await held;
});

test("HumanPrompt start then end clears open", () => {
	const prompt = new HumanPrompt();
	assert.equal(prompt.open, false);
	prompt.start();
	assert.equal(prompt.open, true);
	prompt.end();
	assert.equal(prompt.open, false);
});

test("applyPromptWorking records setWorkingVisible(false) then (true) and pairs the flag", () => {
	const prompt = new HumanPrompt();
	const calls: boolean[] = [];
	const ui = { setWorkingVisible: (visible: boolean) => calls.push(visible) };
	applyPromptWorking(ui, prompt, "start");
	assert.equal(prompt.open, true);
	assert.deepEqual(calls, [false]);
	applyPromptWorking(ui, prompt, "end");
	assert.equal(prompt.open, false);
	assert.deepEqual(calls, [false, true]);
});

test("promptBusyNotice names the surface and that nothing was asked", () => {
	const notice = promptBusyNotice("checkpoint");
	assert.match(notice, /authorization/);
	assert.match(notice, /a prompt is already on screen/);
	assert.match(notice, /nothing was asked and nothing was written/);
	assert.match(promptBusyNotice("decide"), /\/cp-decide/);
});

test("SingleRunLatch / AwaitingSurface still have exactly three surfaces and no pager holder", () => {
	const source = readFileSync(resolve(HERE, "../src/awaiting-ui.ts"), "utf8");
	assert.match(source, /export type AwaitingSurface = "decide" \| "auto_open" \| "checkpoint";/);
	assert.ok(!/"plan"/.test(source), "no plan surface on the latch");
	assert.ok(!/"pager"/.test(source), "no pager surface on the latch");
});

test("decision overlay is not a live production path", () => {
	const source = commandPostSource();
	assert.ok(source.includes('name: "cp_decide"'));
	assert.ok(!source.includes('registerCommand("cp-decide"'));
	assert.ok(!source.includes('registerCommand("cp-authorize"'));
	assert.match(source, /Overlay retired/);
});

// ---------------------------------------------------------------------------
// 4. The adapter honours the route, per surface
// ---------------------------------------------------------------------------

function harness(result: AskToolQuestionnaireResult, options: { mode?: string; hasUI?: boolean } = {}) {
	const asked: AskToolParams[] = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: { select: async () => undefined, input: async () => undefined, notify: () => undefined },
	} as unknown as ExtensionContext;
	const tool: AskToolDefinition = {
		name: ASK_TOOL_NAME,
		execute: async (_id, params) => {
			asked.push(params);
			return { details: result };
		},
	};
	return { asked, ctx, deps: { loadTool: async () => ({ tool, source: "test" }) } };
}

test("the auto-open and the checkpoint ask reach the same overlay /cp-decide does", async () => {
	for (const surface of SURFACES) {
		const h = harness({
			answers: [{ questionIndex: 0, question: "q", kind: "option", answer: "approve" }],
			cancelled: false,
		});
		const outcome = await askQuestionnaire(h.ctx, [checkpointQuestion({ job_id: "cp-a" })], {
			...h.deps,
			surface,
		});
		assert.equal(h.asked.length, 1, `${surface}: one overlay call`);
		assert.deepEqual(outcome, { kind: "answers", answers: [{ kind: "option", label: "approve" }] });
	}
});

test("outside a TUI every surface is told the overlay is unavailable, and nothing is asked", async () => {
	for (const surface of SURFACES) {
		for (const env of [{ mode: "rpc" }, { hasUI: false }, { mode: "print", hasUI: false }]) {
			const h = harness({ answers: [], cancelled: false }, env);
			const outcome = await askQuestionnaire(h.ctx, [checkpointQuestion({ job_id: "cp-a" })], {
				...h.deps,
				surface,
			});
			assert.equal(outcome.kind, "unavailable", surface);
			assert.ok((outcome.kind === "unavailable" ? outcome.reason : "").length > 0);
			assert.equal(h.asked.length, 0, "the overlay is never asked where it cannot render");
		}
	}
});

// ---------------------------------------------------------------------------
// 4a. The deadline on the unattended overlay: it closes, and it writes nothing
// ---------------------------------------------------------------------------

/**
 * A fake overlay that behaves like the package: it renders through
 * `ctx.ui.custom` and resolves only when its `done` callback is called. With
 * `answerAfterMs` it answers on its own; otherwise nobody ever does, which is
 * the attached-but-absent operator.
 */
function hangingOverlayHarness(options: { answerAfterMs?: number } = {}) {
	const closed: unknown[] = [];
	let customCalled = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: (factory: (...args: unknown[]) => unknown) =>
				new Promise((resolve) => {
					customCalled += 1;
					const done = (result: unknown) => {
						closed.push(result);
						resolve(result);
					};
					factory(undefined, undefined, undefined, done);
					if (options.answerAfterMs !== undefined) {
						setTimeout(
							() => done({ answers: [{ questionIndex: 0, question: "q", kind: "option", answer: "approve" }], cancelled: false }),
							options.answerAfterMs,
						);
					}
				}),
			select: async () => undefined,
			input: async () => undefined,
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
	// The "package": it only knows how to render through the context it is given.
	const tool: AskToolDefinition = {
		name: ASK_TOOL_NAME,
		execute: async (_id, _params, _signal, _onUpdate, toolCtx) => {
			const details = await (toolCtx as unknown as { ui: { custom: (f: unknown) => Promise<unknown> } }).ui.custom(
				() => undefined,
			);
			return { details };
		},
	};
	return { closed, ctx, deps: { loadTool: async () => ({ tool, source: "test" }) }, customCalled: () => customCalled };
}

test("the unattended overlay closes on its deadline, as a skip that writes nothing", async () => {
	const h = hangingOverlayHarness();
	const notes: string[] = [];
	const started = Date.now();
	const outcome = await askQuestionnaire(h.ctx, [checkpointQuestion({ job_id: "cp-a" })], {
		...h.deps,
		surface: "auto_open",
		timeoutMs: 20,
		notify: (text) => notes.push(text),
	});
	// It really closed, so there is nothing to warn about.
	assert.deepEqual(notes, []);
	// A cancel, which `driveAwaitingQuestionnaire` records as a skip on every tab:
	// no writer is reached, the items stay open, and they reappear.
	assert.deepEqual(outcome, { kind: "cancelled" });
	assert.ok(Date.now() - started < 5_000, "the caller is released on the deadline, not on a human");
	// The overlay is closed on screen, with the same result Esc produces.
	assert.deepEqual(h.closed, [{ answers: [], cancelled: true }]);
});

test("without a deadline the overlay is never closed under the operator", async () => {
	const h = hangingOverlayHarness({ answerAfterMs: 5 });
	const outcome = await askQuestionnaire(h.ctx, [checkpointQuestion({ job_id: "cp-a" })], {
		...h.deps,
		surface: "decide",
	});
	assert.deepEqual(outcome, { kind: "answers", answers: [{ kind: "option", label: "approve" }] });
	// Only the operator's own answer closed it; nothing here forced a cancel.
	assert.equal(h.closed.length, 1);
	assert.equal((h.closed[0] as { cancelled: boolean }).cancelled, false);
});

test("a deadline that is not reached leaves the answer intact", async () => {
	const h = hangingOverlayHarness({ answerAfterMs: 1 });
	const outcome = await askQuestionnaire(h.ctx, [checkpointQuestion({ job_id: "cp-a" })], {
		...h.deps,
		surface: "auto_open",
		timeoutMs: 10_000,
	});
	assert.deepEqual(outcome, { kind: "answers", answers: [{ kind: "option", label: "approve" }] });
});

test("a deadline that fires before the package renders refuses to render at all", async () => {
	// The slow half is the package itself (a slow load, a slow execute), so the
	// deadline expires while there is no `done` to call. Nothing may be left on
	// screen after the batch has already been reported as a skip.
	const realCustomCalls: unknown[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: (factory: unknown) => {
				realCustomCalls.push(factory);
				return new Promise(() => undefined); // renders forever
			},
			select: async () => undefined,
			input: async () => undefined,
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
	let packageSaw: unknown;
	const tool: AskToolDefinition = {
		name: ASK_TOOL_NAME,
		execute: async (_id, _params, _signal, _onUpdate, toolCtx) => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			packageSaw = await (toolCtx as unknown as { ui: { custom: (f: unknown) => Promise<unknown> } }).ui.custom(
				() => undefined,
			);
			return { details: packageSaw };
		},
	};
	const unhandled: unknown[] = [];
	const notes: string[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const outcome = await askQuestionnaire(ctx, [checkpointQuestion({ job_id: "cp-a" })], {
			loadTool: async () => ({ tool, source: "test" }),
			surface: "auto_open",
			timeoutMs: 5,
			notify: (text) => notes.push(text),
		});
		assert.deepEqual(outcome, { kind: "cancelled" });
		// Let the late execution settle, then look at what it did.
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.deepEqual(realCustomCalls, [], "no overlay is rendered after the deadline");
		assert.deepEqual(notes, [OVERLAY_NO_CLOSE_HANDLE_NOTICE], "a deadline that closed nothing says so");
		assert.deepEqual(packageSaw, OVERLAY_CANCELLED_RESULT, "the package is handed the same cancel Esc produces");
		assert.deepEqual(unhandled, [], "an abandoned execution never becomes an unhandled rejection");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("a late execution that rejects is abandoned, never unhandled", async () => {
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { custom: () => new Promise(() => undefined), select: async () => undefined, input: async () => undefined, notify: () => undefined },
	} as unknown as ExtensionContext;
	const tool: AskToolDefinition = {
		name: ASK_TOOL_NAME,
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			throw new Error("the package blew up after we gave up on it");
		},
	};
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const outcome = await askQuestionnaire(ctx, [checkpointQuestion({ job_id: "cp-a" })], {
			loadTool: async () => ({ tool, source: "test" }),
			surface: "auto_open",
			timeoutMs: 5,
		});
		assert.deepEqual(outcome, { kind: "cancelled" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

// ---------------------------------------------------------------------------
// 4a-ter. The deadline does not depend on the package's shape
// ---------------------------------------------------------------------------

/**
 * The wrapper assumes the package renders through `ctx.ui.custom` and that the
 * factory's 4th argument is `done`. If that ever stops being true, closing the
 * overlay becomes impossible — but **settling the ask must not**, or a deadline
 * that looks handled would do nothing at all. These cases are exactly that
 * assumption failing, in each of the ways it can.
 */
const SHAPE_CASES: { name: string; render(ui: Record<string, unknown>): Promise<unknown> }[] = [
	{
		name: "never calls ui.custom at all",
		render: () => new Promise(() => undefined),
	},
	{
		name: "calls ui.custom with a component, not a factory",
		render: (ui) => (ui.custom as (c: unknown) => Promise<unknown>)({ render: () => [] }),
	},
	{
		name: "calls ui.custom with a factory that gets no done callback",
		render: (ui) => (ui.custom as (f: unknown) => Promise<unknown>)(() => undefined),
	},
	{
		name: "renders through some other channel entirely",
		render: (ui) => (ui.somethingElse as () => Promise<unknown>)(),
	},
];

test("a deadline with no usable close handle still settles the ask, and says so", async () => {
	for (const shape of SHAPE_CASES) {
		const notes: { text: string; level: string }[] = [];
		const realUi: Record<string, unknown> = {
			// Deliberately *not* the assumed shape: the factory is never handed a
			// `done` (4th) argument, so nothing can be captured.
			custom: (factory: unknown) => {
				if (typeof factory === "function") (factory as (...a: unknown[]) => unknown)(undefined, undefined, undefined);
				return new Promise(() => undefined);
			},
			somethingElse: () => new Promise(() => undefined),
			select: async () => undefined,
			input: async () => undefined,
			notify: () => undefined,
		};
		const ctx = { mode: "tui", hasUI: true, ui: realUi } as unknown as ExtensionContext;
		const tool: AskToolDefinition = {
			name: ASK_TOOL_NAME,
			execute: async (_id, _params, _signal, _onUpdate, toolCtx) => {
				const details = await shape.render((toolCtx as unknown as { ui: Record<string, unknown> }).ui);
				return { details };
			},
		};

		// The latch is the parent's single-run guard: it must come back free.
		const latch = new SingleRunLatch();
		const started = Date.now();
		const result = await latch.run("auto_open", () =>
			askQuestionnaire(ctx, [checkpointQuestion({ job_id: "cp-a" })], {
				loadTool: async () => ({ tool, source: "test" }),
				surface: "auto_open",
				timeoutMs: 10,
				notify: (text, level) => notes.push({ text, level }),
			}),
		);

		// The ask settles — as a skip, which writes nothing anywhere.
		assert.deepEqual(result.ran && result.value, { kind: "cancelled" }, shape.name);
		assert.ok(Date.now() - started < 5_000, `${shape.name}: the continuation is released`);
		assert.equal(latch.busy, false, `${shape.name}: the latch is released`);
		// ...and the assumption failing is a signal, not silence.
		assert.deepEqual(notes, [{ text: OVERLAY_NO_CLOSE_HANDLE_NOTICE, level: "warning" }], shape.name);
		assert.match(notes[0]?.text ?? "", /Nothing was written and nothing was answered/);
	}
});

test("expire() reports what it managed to do, and never throws", () => {
	// No render at all: refused (a later render is turned away, see above).
	const quiet = overlayDeadlineContext({
		mode: "tui",
		hasUI: true,
		ui: { custom: () => new Promise(() => undefined) },
	} as unknown as ExtensionContext);
	assert.equal(quiet.expire(), "refused");

	// Rendered, but no `done` reached us: the assumption failed.
	const shapeless = overlayDeadlineContext({
		mode: "tui",
		hasUI: true,
		ui: {
			custom: (factory: unknown) => {
				(factory as (...a: unknown[]) => unknown)(undefined, undefined, undefined);
				return new Promise(() => undefined);
			},
		},
	} as unknown as ExtensionContext);
	void (shapeless.ctx.ui as unknown as { custom: (f: unknown) => unknown }).custom(() => undefined);
	assert.equal(shapeless.expire(), "no_handle");

	// A `done` that throws is reported, not propagated.
	const angry = overlayDeadlineContext({
		mode: "tui",
		hasUI: true,
		ui: {
			custom: (factory: unknown) => {
				(factory as (...a: unknown[]) => unknown)(undefined, undefined, undefined, () => {
					throw new Error("nope");
				});
				return new Promise(() => undefined);
			},
		},
	} as unknown as ExtensionContext);
	void (angry.ctx.ui as unknown as { custom: (f: unknown) => unknown }).custom(() => undefined);
	assert.equal(angry.expire(), "close_failed");
});

// ---------------------------------------------------------------------------
// 4a-bis. The proxy is faithful: only `custom` is intercepted
// ---------------------------------------------------------------------------

test("the deadline context forwards every other member, with the real ui as `this`", async () => {
	// `this`-sensitive on purpose: a method called with the proxy as its receiver
	// would push into the proxy's own view, and a private field would throw.
	class RealUi {
		#secret = "private ok";
		notified: string[] = [];
		selected: string[] = [];
		inputs: string[] = [];
		customCalls = 0;
		notify(text: string): string {
			this.notified.push(text);
			return this.#secret;
		}
		async select(title: string): Promise<string> {
			this.selected.push(title);
			return `picked ${title}`;
		}
		async input(title: string): Promise<string> {
			this.inputs.push(title);
			return `typed ${title}`;
		}
		custom(factory: (...args: unknown[]) => unknown): Promise<unknown> {
			this.customCalls += 1;
			return new Promise((resolve) => {
				factory(undefined, undefined, undefined, resolve);
			});
		}
	}
	const realUi = new RealUi();
	const realCtx = {
		mode: "tui",
		hasUI: true,
		cwd: "/somewhere",
		isProjectTrusted: () => true,
		ui: realUi,
	} as unknown as ExtensionContext;
	const { ctx, expire } = overlayDeadlineContext(realCtx);

	// Plain members read through unchanged.
	assert.equal(ctx.mode, "tui");
	assert.equal(ctx.hasUI, true);
	assert.equal(ctx.cwd, "/somewhere");
	assert.equal(ctx.isProjectTrusted(), true);
	assert.equal(ctx.ui, ctx.ui, "the ui view is stable");
	assert.equal(ctx.ui.notify, ctx.ui.notify, "a forwarded method has a stable identity");

	// Methods reach the real ui, and run with the real ui as `this` (the private
	// field would throw otherwise, and the arrays would not fill).
	assert.equal((ctx.ui as unknown as RealUi).notify("hello"), "private ok");
	assert.deepEqual(realUi.notified, ["hello"]);
	assert.equal(await (ctx.ui.select as (t: string) => Promise<string>)("a title"), "picked a title");
	assert.deepEqual(realUi.selected, ["a title"]);
	assert.equal(await (ctx.ui.input as (t: string) => Promise<string>)("type here"), "typed type here");
	assert.deepEqual(realUi.inputs, ["type here"]);

	// `custom` is the one interception: it still reaches the real ui, and the
	// captured `done` is what `expire()` closes with.
	const rendered = (ctx.ui as unknown as RealUi).custom(() => undefined);
	assert.equal(realUi.customCalls, 1);
	expire();
	assert.deepEqual(await rendered, OVERLAY_CANCELLED_RESULT);

	// After expiry the real `custom` is never called again — nothing can be left
	// orphaned on screen.
	assert.deepEqual(await (ctx.ui as unknown as RealUi).custom(() => undefined), OVERLAY_CANCELLED_RESULT);
	assert.equal(realUi.customCalls, 1, "refused, not rendered");
});

// ---------------------------------------------------------------------------
// 4b. The checkpoint surface, exercised end to end
// ---------------------------------------------------------------------------

function checkpointHarness(options: {
	mode?: string;
	hasUI?: boolean;
	result?: AskToolQuestionnaireResult;
	load?: AskToolLoad;
	select?: string | undefined;
}) {
	const asked: AskToolParams[] = [];
	const selected: { title: string; options: string[] }[] = [];
	const notes: { text: string; level: string }[] = [];
	const tool: AskToolDefinition = {
		name: ASK_TOOL_NAME,
		execute: async (_id, params) => {
			asked.push(params);
			return { details: options.result ?? { answers: [], cancelled: true } };
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			select: async (title: string, rows: string[]) => {
				selected.push({ title, options: rows });
				return options.select;
			},
			input: async () => undefined,
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
	const deps = {
		loadTool: async () => options.load ?? { tool, source: "test" },
		notify: (text: string, level: "info" | "warning" | "error") => {
			notes.push({ text, level });
		},
	};
	return { asked, ctx, deps, notes, selected };
}

function overlayAnswer(kind: "option" | "custom", answer: string): AskToolQuestionnaireResult {
	return { answers: [{ questionIndex: 0, question: "q", kind, answer }], cancelled: false };
}

test("the checkpoint overlay returns a verdict only for a verdict row", async () => {
	const approve = checkpointHarness({ result: overlayAnswer("option", "approve") });
	assert.deepEqual(await askCheckpointDecision(approve.ctx, { job_id: "cp-a" }, "operator dialog (tui)", approve.deps), {
		approved: true,
		by: "operator dialog (tui)",
	});
	assert.equal(approve.asked.length, 1, "asked through the overlay, not the plain select");
	assert.equal(approve.selected.length, 0);

	const decline = checkpointHarness({ result: overlayAnswer("option", "decline") });
	assert.deepEqual(await askCheckpointDecision(decline.ctx, { job_id: "cp-a" }, "by", decline.deps), {
		approved: false,
		by: "by",
	});
});

test("not now, an untouched tab and Esc all leave the checkpoint pending, and write nothing", async () => {
	const cases: { name: string; result: AskToolQuestionnaireResult }[] = [
		{ name: "not now", result: overlayAnswer("option", "not now") },
		{ name: "untouched tab", result: { answers: [], cancelled: false } },
		{ name: "esc", result: { answers: [], cancelled: true } },
	];
	for (const testCase of cases) {
		const h = checkpointHarness({ result: testCase.result });
		assert.equal(await askCheckpointDecision(h.ctx, { job_id: "cp-a" }, "by", h.deps), undefined, testCase.name);
		// Esc is never a decline, and never falls through to a second prompt.
		assert.equal(h.selected.length, 0, testCase.name);
	}
});

test("free text on the checkpoint overlay is a note, never a verdict", async () => {
	for (const text of ["approve", "looks good, ship it"]) {
		const h = checkpointHarness({ result: overlayAnswer("custom", text) });
		assert.equal(await askCheckpointDecision(h.ctx, { job_id: "cp-a" }, "by", h.deps), undefined, text);
		assert.match(h.notes[0]?.text ?? "", /not approve\/decline, so the checkpoint stays pending/);
		assert.equal(h.notes[0]?.level, "warning");
	}
});

test("an unavailable overlay degrades to the plain select, with the reason named", async () => {
	const h = checkpointHarness({ load: { reason: "not installed anywhere" }, select: "approve" });
	assert.deepEqual(await askCheckpointDecision(h.ctx, { job_id: "cp-a" }, "by", h.deps), { approved: true, by: "by" });
	assert.match(h.notes[0]?.text ?? "", /questionnaire overlay is unavailable — not installed anywhere/);
	assert.equal(h.selected.length, 1, "the operator is still asked");
	assert.deepEqual(h.selected[0]?.options, ["approve", "decline", "not now"]);
	assert.match(h.selected[0]?.title ?? "", /^cp-a: /);
});

test("outside a TUI the checkpoint ask is the plain select only, and stays answerable", async () => {
	for (const env of [{ mode: "rpc" }, { mode: "print", hasUI: false }]) {
		const h = checkpointHarness({ ...env, select: "decline" });
		assert.deepEqual(await askCheckpointDecision(h.ctx, { job_id: "cp-a" }, "by", h.deps), { approved: false, by: "by" });
		assert.equal(h.asked.length, 0, "the overlay is never reached where it cannot render");
		assert.equal(h.selected.length, 1);
	}
	// Dismissing the plain dialog is "not now", exactly as it always was.
	const dismissed = checkpointHarness({ mode: "rpc", select: undefined });
	assert.equal(await askCheckpointDecision(dismissed.ctx, { job_id: "cp-a" }, "by", dismissed.deps), undefined);
});

// ---------------------------------------------------------------------------
// 5. This module decides; it never writes
// ---------------------------------------------------------------------------

test("the routing module can write nothing: no pi, no fs, no store", () => {
	const source = readFileSync(resolve(HERE, "../src/awaiting-ui.ts"), "utf8");
	const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(imports)].sort(), ["./awaiting-dialog.ts", "./awaiting.ts", "./contracts.ts"]);
	for (const name of ["node:fs", "new CheckpointStore", "decideCheckpoint(", "answerDeclared(", "writeFile"]) {
		assert.ok(!source.includes(name), name);
	}
});
