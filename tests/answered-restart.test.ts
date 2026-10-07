/**
 * pi-command-post-u9q, at the production boundary: a **real pi parent session**
 * started on a home whose answered outbox still holds the previous parent's
 * in-flight reservation.
 *
 * `tests/answered.test.ts` proves the rule inside `AnsweredOutbox`. This file
 * proves the thing the operator actually experienced, one layer out: the
 * extension's own `session_start` drain, in a pi process, with the wake-up
 * travelling over the real transport and the arrival observer confirming it.
 * Hermetic throughout — a `MockProvider` script and a throwaway
 * `PI_CODING_AGENT_DIR`, so no operator credentials, no other extensions and no
 * real model are ever involved.
 *
 * ## Who owns the "working…" row (the second half of the report)
 *
 * The parent TUI's busy indicator is **pi's**, not this package's. It is a
 * status indicator owned by pi's interactive mode
 * (`dist/modes/interactive/interactive-mode.js`): it is shown on `turn_start`
 * when `workingVisible` is set, re-shown while `session.isStreaming`, and
 * cleared on `agent_end`. The command post *does* call `ctx.ui.setWorkingVisible`
 * on the coalesced `ui_prompt_start` / `ui_prompt_end` span (hide while an
 * extension prompt is up, restore when it ends). It still does not call
 * `setWorkingMessage` / `setWorkingIndicator` / `ctx.ui.setStatus`. This
 * boundary test's session never opens a prompt, so no `setWorking*` UI request
 * is issued and the outbox still must not paint a turn. It reads `ctx.isIdle()`
 * in exactly one place (deferring an answer card until the parent is not
 * streaming), which is a read and never a write.
 *
 * So the answered outbox can never *make* a parent look busy, and there is no
 * indicator here to reconcile. What it could do — and did — is the opposite:
 * leave a parent **idle** when the operator had just answered a decision,
 * because the dead session's reservation suppressed the wake-up until the retry
 * window expired. A parent with nothing to do and an answer waiting is exactly
 * what "it looked stuck" describes.
 *
 * The inherited answer must arrive even when no parent turn is needed.
 * These tests assert at the boundary:
 *
 *  1. the wake-up is emitted by the first drain of the new session, well inside
 *     `ANSWERED_DELIVERY_RETRY_SECONDS` (the assertion is the timeout: a
 *     regression makes this wait 120s and fail);
 *  2. arrival is stamped `delivered`; no_mandate stays quiet, while a dispatch
 *     recommendation still triggers a real parent turn;
 *  3. no `setWorking*` / `setStatus` UI request is ever issued by this
 *     extension, before or after that turn settles, so nothing here can leave a
 *     parent *showing* work it is not doing.
 *
 * `node --test tests/answered-restart.test.ts`
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AnsweredOutbox } from "../src/answered.ts";
import { MandateStore } from "../src/mandate.ts";
import { createScratchLedger } from "./harness/index.ts";
import { type AnsweredDecision, LAYOUT, SCHEMA_VERSION, validateAnsweredOutboxFile } from "../src/contracts.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	MockProvider,
	startPiChild,
	waitFor,
} from "./harness/index.ts";

/** The merge authorization from the incident, answered and never delivered. */
const ANSWER: AnsweredDecision = {
	schema_version: SCHEMA_VERSION,
	id: "aw-checkpoint-cp-ship.merge-f7b8769f0606",
	type: "authorization",
	job_id: "cp-ship",
	decision: "Merge PR #44 for cp-ship?",
	answer: "approve",
	answered_by: "operator command",
	answered_at: "2026-09-06T15:37:49Z",
};

/** Who the dead parent was. Any owner that is not this process's will do. */
const DEAD_SESSION = "4242.deadbeef";

/**
 * The outbox the dead parent left on disk: the answer is durable and pending,
 * and its emission is reserved by a process that no longer exists. `sent_at` is
 * *now*, because the whole point is that the window has not expired.
 *
 * `owner` is a parameter because both shapes are real and both must replay: the
 * record a post-fix parent leaves (owned by its dead process) and the record a
 * pre-upgrade parent left (no owner at all). The unowned one is also what makes
 * this test's pre-fix failure honest — that file validates against the old
 * schema too, so a regression fails here by *waiting out the window*, which is
 * the incident, and not by refusing to read a field it does not know.
 */
function outboxLeftByADeadParent(home: string, options: { owner?: string } = {}): void {
	const file = join(home, LAYOUT.answeredFile);
	const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			schema_version: SCHEMA_VERSION,
			updated_at: stamp,
			pending: [ANSWER],
			sends: [{ id: ANSWER.id, sent_at: stamp, attempts: 1, ...(options.owner ? { owner: options.owner } : {}) }],
			delivered: [],
		}),
	);
}

/** The UI methods that would paint a parent as busy. None of them are ours. */
const WORKING_INDICATOR_METHODS = ["setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setStatus"];

test(
	"u9q: a real parent session delivers the inherited answer at once, and paints no working state of its own",
	{ timeout: 180_000 },
	async (t) => {
		const home = createScratchHome();
		// Unowned on purpose: the shape a parent running the *old* build left behind,
		// which the old schema also accepts. So this test fails pre-fix by waiting
		// out the retry window — the incident itself — rather than by a schema
		// refusal, and it covers the upgrade case at the boundary as well.
		outboxLeftByADeadParent(home.path);

		const provider = await MockProvider.start();
		// Any accidental model turn is observable through this provider.
		const model = provider.addScript("u9q-restart-boundary", [{ kind: "text", text: "acknowledged" }], {
			onExhausted: "repeat",
		});
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: home.path,
			model,
			env: { ...agentDir.env, CP_HOME: home.path },
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
			home.cleanup();
		});

		// 1. The first drain of the new session is `session_start`, and it emits.
		//    The bound is the assertion: the dead session's reservation had 120
		//    seconds left on it, so a regression cannot pass this inside 60.
		const notice = await child.waitFor(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				typeof record.message === "string" &&
				record.message.includes("DECISION ANSWERED"),
			60_000,
		);
		assert.match(notice.message as string, /aw-checkpoint-cp-ship\.merge-f7b8769f0606/);
		assert.match(notice.message as string, /approved means dispatch it/, "an authorization still says what it is");

		// A no_mandate acknowledgement enters context and confirms without a model turn.
		child.send({ id: "quiet-context", type: "get_messages" });
		const messages = await child.waitFor((record) => record.type === "response" && record.id === "quiet-context");
		assert.match(JSON.stringify(messages), /cp-answered/);
		assert.equal(provider.requests("u9q-restart-boundary").length, 0);
		assert.equal(child.eventsOfType("agent_start").length, 0);
		await waitFor(
			() => new AnsweredOutbox({ home: home.path }).delivered(ANSWER.id),
			(delivered) => delivered,
			{ timeoutMs: 30_000, what: "the answered decision to be stamped delivered" },
		);
		const outbox = new AnsweredOutbox({ home: home.path });
		assert.deepEqual(outbox.pending(), [], "nothing is owed once arrival was observed");
		assert.deepEqual(outbox.sends(), [], "and the dead session's reservation dies with the entry it described");
		const stored = validateAnsweredOutboxFile(JSON.parse(readFileSync(join(home.path, LAYOUT.answeredFile), "utf8")));
		assert.equal(stored.ok, true, "the file the live parent wrote is a valid outbox");

		// 3. Ownership of the busy row, asserted rather than described: this
		//    extension never writes one, in any of its four surfaces, at any point
		//    in the session. pi's own indicator follows `turn_start`/`agent_end`,
		//    which is the parent's actual LLM state and nothing this file can fake.
		const ours = child
			.records()
			.filter((record) => record.type === "extension_ui_request")
			.map((record) => record.method);
		for (const method of WORKING_INDICATOR_METHODS) {
			assert.equal(
				ours.includes(method),
				false,
				`the command post issued ${method}: the parent's working state is pi's, derived from its own turn, ` +
					`and an inherited send reservation must never paint it (methods seen: ${[...new Set(ours)].join(",")})`,
			);
		}
		// It does keep painting the fleet widget, which is the surface it owns —
		// so "no working indicator" is a fact about which methods it calls, not an
		// artefact of an extension that never spoke to the UI at all.
		assert.ok(ours.includes("setWidget"), `expected the fleet widget; methods seen: ${[...new Set(ours)].join(",")}`);
	},
);

test(
	"an inherited answer still triggers a parent turn when cpNext recommends dispatch",
	{ timeout: 180_000 },
	async (t) => {
		// The going-forward shape: the emission names the process that made it, and
		// that process is gone. Same wiring, same first drain, same immediacy.
		const home = createScratchHome();
		outboxLeftByADeadParent(home.path, { owner: DEAD_SESSION });
		const scratch = createScratchLedger({ home: home.path, knownProjects: ["demo"] });
		await scratch.ledger.create({ project: "demo", title: "Ready work", kind: "ship", delivery: "pr" });
		new MandateStore(home.path).issue({ projects: ["demo"], objective: "Dispatch ready work", expiry: "2099-01-01T00:00:00Z", spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 5 });

		const provider = await MockProvider.start();
		const model = provider.addScript("u9q-restart-boundary-owned", [{ kind: "text", text: "acknowledged" }], {
			onExhausted: "repeat",
		});
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: home.path,
			model,
			env: { ...agentDir.env, CP_HOME: home.path },
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
			home.cleanup();
		});

		const notice = await child.waitFor(
			(record) =>
				record.type === "extension_ui_request" &&
				record.method === "notify" &&
				typeof record.message === "string" &&
				record.message.includes("DECISION ANSWERED"),
			60_000,
		);
		assert.match(notice.message as string, /aw-checkpoint-cp-ship\.merge-f7b8769f0606/);
		await child.waitForSettled(120_000);
		assert.ok(provider.requests("u9q-restart-boundary-owned").length > 0, "a dispatch recommendation still wakes the parent");
		await waitFor(() => new AnsweredOutbox({ home: home.path }).delivered(ANSWER.id), (delivered) => delivered, { timeoutMs: 30_000, what: "actionable answer confirmed" });
	},
);
