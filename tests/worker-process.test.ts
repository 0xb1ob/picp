/**
 * T3 acceptance: WorkerProcess drives a real pi child end-to-end
 * (prompt -> events -> settled -> shutdown), plus the transport invariants:
 * LF framing, id correlation, observed close, dialog auto-cancel.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { WORKER_FORBIDDEN_FLAGS } from "../src/contracts.ts";
import { dialogOptions } from "../src/questions.ts";
import {
	buildWorkerArgs,
	consumeJsonLines,
	DEFAULT_SHUTDOWN_GRACE_MS,
	TRANSCRIPT_MAX_ENTRIES,
	type WorkerDialogRequest,
	WorkerError,
	type WorkerEvent,
	WorkerProcess,
} from "../src/worker-process.ts";
import { createAgentDir, createScratchRepo, MockProvider } from "./harness/index.ts";

test("buildWorkerArgs applies the trust policy and refuses forbidden flags", () => {
	const args = buildWorkerArgs({
		cwd: "/tmp",
		model: "mock/script-a",
		tools: ["read", "bash"],
		extensions: ["/pkg/extensions/worker-reporter/index.ts"],
		thinking: "medium",
		sessionDir: "/sessions",
	});
	assert.deepEqual(args.slice(0, 5), ["--mode", "rpc", "--no-approve", "--no-extensions", "--no-skills"]);
	assert.ok(args.includes("--session-dir"));
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,bash"]);
	assert.deepEqual(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2), [
		"-e",
		"/pkg/extensions/worker-reporter/index.ts",
	]);
	assert.ok(args.includes("--thinking"));

	// Reviving a held worker is explicit; it never becomes --continue.
	const revived = buildWorkerArgs({ cwd: "/tmp", model: "m", sessionFile: "/s/a.jsonl", sessionDir: "/sessions" });
	assert.ok(revived.includes("--session"));
	assert.ok(!revived.includes("--session-dir"));

	for (const flag of WORKER_FORBIDDEN_FLAGS) {
		assert.throws(
			() => buildWorkerArgs({ cwd: "/tmp", model: "m", extraArgs: [flag] }),
			/forbidden worker flag/,
			`extraArgs must not smuggle ${flag}`,
		);
	}
});

test("prompt -> events -> settled -> graceful shutdown against a real pi child", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "worker" });
	const model = provider.addScript("worker-e2e", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: "printf 'worker-ok' > out.txt && echo done" } }],
			usage: { prompt_tokens: 111, completion_tokens: 22 },
		},
		{ kind: "text", text: "Finished the job." },
	]);
	const agentDir = createAgentDir({ provider });

	const events: WorkerEvent[] = [];
	const protocolErrors: string[] = [];
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["bash"],
		env: agentDir.env,
		extraArgs: ["--no-context-files", "--no-session"],
		onEvent: (event) => events.push(event),
		onProtocolError: (line) => protocolErrors.push(line),
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	// Readiness is proven by a real response, not a sleep.
	const state = await worker.getState(30_000);
	assert.equal(state.isStreaming, false);
	assert.ok(typeof worker.pid === "number");
	assert.equal(worker.alive, true);

	const receipt = await worker.send("Do the job.");
	assert.equal(receipt.receipt, "delivered", JSON.stringify(receipt));
	assert.equal(receipt.disposition, "started");

	await worker.waitForSettled(60_000);
	assert.equal(worker.busy, false, "busy must clear on agent_settled");
	assert.equal(worker.settledCount, 1);

	assert.equal(readFileSync(join(repo.path, "out.txt"), "utf8"), "worker-ok");
	const types = events.map((event) => event.type);
	for (const expected of ["agent_start", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
		assert.ok(types.includes(expected), `missing ${expected} in ${types.join(",")}`);
	}
	const toolEvent = events.find((event) => event.type === "tool_execution_start");
	assert.equal(toolEvent?.toolName, "bash");
	assert.deepEqual(protocolErrors, []);
	assert.equal(provider.remaining("worker-e2e"), 0);

	// Graceful shutdown: stdin close is enough; the exit is observed.
	const exit = await worker.shutdown();
	assert.equal(exit.code, 0, `expected clean exit, got ${JSON.stringify(exit)}\n${worker.stderrTail()}`);
	assert.equal(worker.alive, false);
	assert.deepEqual(await worker.closed, exit, "closed resolves with the same observed exit");

	// Post-mortem sends fail loudly instead of hanging.
	await assert.rejects(worker.getState(), WorkerError);
});

test("busy worker takes steer and follow_up as queued receipts", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "steer" });
	// Long-running first turn: sleep gives us a window where the worker is busy.
	const model = provider.addScript("steer-case", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] },
		{ kind: "text", text: "acknowledged" },
		{ kind: "text", text: "and the queued message too" },
		{ kind: "text", text: "and the follow-up" },
		{ kind: "text", text: "and the idle follow-up" },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["bash"],
		env: agentDir.env,
		extraArgs: ["--no-context-files", "--no-session"],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await worker.getState(30_000);
	await worker.prompt("start the slow job");
	await worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(worker.busy, true);

	const steered = await worker.send("also do this", "steer");
	assert.equal(steered.receipt, "queued", JSON.stringify(steered));
	assert.equal(steered.disposition, "queued");
	const followed = await worker.send("then this", "prompt", "followUp");
	assert.equal(followed.receipt, "queued", JSON.stringify(followed));
	assert.equal(followed.disposition, "queued");

	// A bare prompt while streaming is rejected by pi -> receipt "failed", not a lie.
	const bare = await worker.send("bare prompt while busy");
	assert.equal(bare.receipt, "failed");
	assert.match(bare.error ?? "", /streaming|behavior|reject/i);

	await worker.waitForSettled(60_000);
	assert.equal(worker.busy, false);

	// Idle: the same prompt+followUp starts a run instead of queueing.
	const idle = await worker.send("idle follow-up", "prompt", "followUp");
	assert.equal(idle.receipt, "delivered", JSON.stringify(idle));
	assert.equal(idle.disposition, "started");
	await worker.waitForSettled(60_000);
});

test("busy worker: a prompt+steer reaches the model before an earlier queued prompt+followUp", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "steer-order" });
	const script = "steer-order";
	const model = provider.addScript(script, [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2 && echo slept" } }] },
		{ kind: "text", text: "first answer" },
		{ kind: "text", text: "second answer" },
		{ kind: "text", text: "spare answer" },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["bash"],
		env: agentDir.env,
		extraArgs: ["--no-context-files", "--no-session"],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await worker.getState(30_000);
	await worker.prompt("start the slow job");
	await worker.waitForEvent((event) => event.type === "tool_execution_start", 30_000);
	assert.equal(worker.busy, true);

	const wake = await worker.send("wake one", "prompt", "followUp");
	assert.equal(wake.receipt, "queued", JSON.stringify(wake));
	const operator = await worker.send("operator now", "prompt", "steer");
	assert.equal(operator.receipt, "queued", JSON.stringify(operator));

	await worker.waitForSettled(60_000);
	const bodies = provider.requests(script).map((request) => JSON.stringify(request.body));
	const firstWith = (text: string) => bodies.findIndex((body) => body.includes(text));
	assert.ok(firstWith("operator now") >= 0, "the steered prompt reached the model");
	assert.ok(firstWith("wake one") >= 0, "the queued follow-up reached the model");
	assert.ok(firstWith("operator now") < firstWith("wake one"), "steer overtakes the earlier follow-up");
});

test(
	"send(): the receipt is pi's disposition, never the busy flag",
	{ timeout: 30_000 },
	async (t) => {
		// A scripted worker that emits `agent_start` with no matching
		// `agent_settled` (busy reads true throughout) and answers each input with
		// a disposition chosen by the message text — no reliance on real pi timing.
		const fakeWorker = resolve(import.meta.dirname, "fixtures", "fake-busy-worker.mjs");
		const worker = WorkerProcess.spawn({
			cwd: process.cwd(),
			model: "mock/does-not-matter",
			piBin: fakeWorker,
		});
		t.after(async () => {
			await worker.shutdown();
		});

		await worker.getState(10_000);
		assert.equal(worker.busy, true, "agent_start with no matching agent_settled must leave the worker busy");

		const cases: Array<[Parameters<WorkerProcess["send"]>, string, string | undefined]> = [
			[["go"], "delivered", "started"],
			[["go", "prompt", "followUp"], "queued", "queued"],
			[["DISPOSITION=handled", "steer"], "delivered", "handled"],
			// pi < 0.99.1 sends no disposition: the fallback is derived from the command.
			[["DISPOSITION=none"], "delivered", undefined],
			[["DISPOSITION=none", "follow_up"], "queued", undefined],
			[["DISPOSITION=none", "prompt", "followUp"], "queued", undefined],
		];
		for (const [args, receipt, disposition] of cases) {
			const result = await worker.send(...args);
			assert.equal(result.receipt, receipt, `${JSON.stringify(args)} → ${JSON.stringify(result)}`);
			assert.equal(result.disposition, disposition, JSON.stringify(args));
			assert.equal(worker.busy, true);
		}
	},
);

test("observed close: kill -9 resolves the closed promise with the signal", { timeout: 60_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "killed" });
	const model = provider.addScript("killed", [{ kind: "text", text: "hi" }]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		env: agentDir.env,
		extraArgs: ["--no-context-files", "--no-session"],
	});
	t.after(async () => {
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await worker.getState(30_000);
	const exit = await worker.kill("SIGKILL");
	assert.equal(worker.alive, false);
	assert.ok(exit.signal === "SIGKILL" || exit.code !== 0, `expected violent exit, got ${JSON.stringify(exit)}`);
	// Nothing infers death: the promise resolved because close was observed.
	assert.equal((await worker.closed).at, exit.at);
});

test("dialog requests from a worker extension are auto-cancelled, never blocking", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "dialog" });
	// An extension that asks a question the moment a prompt arrives.
	repo.write(
		"ask.ts",
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const answer = await ctx.ui.confirm("Proceed?", "worker asks the void");
		ctx.ui.notify("confirm-result:" + String(answer), "info");
	});
}
`,
	);
	const model = provider.addScript("dialog", [{ kind: "text", text: "no dialogs for me" }]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		env: agentDir.env,
		extensions: [join(repo.path, "ask.ts")],
		extraArgs: ["--no-context-files", "--no-session"],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await worker.getState(30_000);
	// waitForEvent has no replay buffer: register before the trigger.
	const notified = worker.waitForEvent(
		(event) => event.type === "extension_ui_request" && event.method === "notify",
		30_000,
	);
	await worker.prompt("go");
	const notify = await notified;
	assert.equal(notify.message, "confirm-result:false", "cancelled dialog must resolve as false, not hang");
	// cp-xbxz: the auto-cancel goes through the same public `answerDialog` a
	// console uses, so it is tracked and then cleared — never leaked as pending.
	assert.deepEqual(worker.pendingDialogs(), [], "an auto-cancelled dialog is answered, not left in flight");
	await worker.waitForSettled(30_000);
});

test("a relayed dialog is answered by the relay, and a broken relay still cancels", { timeout: 120_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "relay" });
	repo.write(
		"ask.ts",
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const answer = await ctx.ui.select("Postgres or SQLite?", ["Postgres", "SQLite"]);
		ctx.ui.notify("select-result:" + String(answer), "info");
	});
}
`,
	);
	// The model must exist before the agent dir is written: models.json is a
	// snapshot, not a live view.
	const model = provider.addScript("relay", [{ kind: "text", text: "asked" }]);
	const agentDir = createAgentDir({ provider });

	// 1. A relay that answers: the worker receives the operator's actual choice.
	const seen: string[] = [];
	const answered = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		env: agentDir.env,
		extensions: [join(repo.path, "ask.ts")],
		extraArgs: ["--no-context-files", "--no-session"],
		async onDialog(request) {
			seen.push(`${request.method}:${request.title ?? ""}`);
			return { value: "SQLite" };
		},
	});
	// 2. A relay that throws: the transport must still unblock the worker.
	const broken = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		env: agentDir.env,
		extensions: [join(repo.path, "ask.ts")],
		extraArgs: ["--no-context-files", "--no-session"],
		async onDialog() {
			throw new Error("the operator's terminal fell over");
		},
	});
	t.after(async () => {
		await Promise.all([answered.shutdown(), broken.shutdown()]);
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await Promise.all([answered.getState(30_000), broken.getState(30_000)]);
	const answeredNotify = answered.waitForEvent(
		(event) => event.type === "extension_ui_request" && event.method === "notify",
		30_000,
	);
	const brokenNotify = broken.waitForEvent(
		(event) => event.type === "extension_ui_request" && event.method === "notify",
		30_000,
	);
	await Promise.all([answered.prompt("go"), broken.prompt("go")]);

	assert.equal((await answeredNotify).message, "select-result:SQLite", "the relay's answer reaches the worker");
	assert.deepEqual(seen, ["select:Postgres or SQLite?"], "the relay sees the question, once");
	assert.equal(
		(await brokenNotify).message,
		"select-result:undefined",
		"a relay that throws must fall back to cancel: a worker blocked on a dialog nobody will answer is the one outcome the transport must not produce",
	);
});

test("LF framing: unicode separators are payload, partial lines are buffered", () => {
	// U+2028/U+2029 are legal inside JSON strings; node:readline would split here.
	const hostile = JSON.stringify({ type: "message_end", text: "a\u2028b\u2029c" });
	const first = consumeJsonLines(`${hostile}\n{"type":"agent_`);
	assert.deepEqual(first.lines, [hostile]);
	assert.equal(first.rest, '{"type":"agent_');
	assert.equal((JSON.parse(first.lines[0] ?? "{}") as { text: string }).text, "a\u2028b\u2029c");

	// The buffered remainder completes on the next chunk.
	const second = consumeJsonLines(`${first.rest}settled"}\n`);
	assert.deepEqual(second.lines, ['{"type":"agent_settled"}']);
	assert.equal(second.rest, "");

	// CRLF tolerance and blank-line skipping.
	const third = consumeJsonLines('{"type":"a"}\r\n\n{"type":"b"}\n');
	assert.deepEqual(third.lines, ['{"type":"a"}', '{"type":"b"}']);
});

// ---------------------------------------------------------------------------
// cp-xbxz: an in-flight dialog is state, and observed death must reach it
// ---------------------------------------------------------------------------

test(
	"cp-xbxz: a dialog in flight when the child dies resolves worker-gone, and answerDialog then lies to nobody",
	{ timeout: 120_000 },
	async (t) => {
		const provider = await MockProvider.start();
		const repo = createScratchRepo({ name: "dialog-death" });
		repo.write(
			"ask.ts",
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		await ctx.ui.select("Postgres or SQLite?", ["Postgres", "SQLite"]);
	});
}
`,
		);
		const model = provider.addScript("dialog-death", [{ kind: "text", text: "never gets here" }]);
		const agentDir = createAgentDir({ provider });

		let settleRelay: (outcome: string) => void = () => {};
		const relayOutcome = new Promise<string>((resolve) => {
			settleRelay = resolve;
		});
		const signals: (AbortSignal | undefined)[] = [];
		const worker = WorkerProcess.spawn({
			cwd: repo.path,
			model,
			env: agentDir.env,
			extensions: [join(repo.path, "ask.ts")],
			extraArgs: ["--no-context-files", "--no-session"],
			// A relay that behaves like the real one: it waits for a human, and the
			// only thing that can end that wait early is the worker's own death.
			onDialog(request) {
				signals.push(request.signal);
				return new Promise((resolve) => {
					request.signal?.addEventListener(
						"abort",
						() => {
							settleRelay("worker-gone");
							resolve({ cancelled: true });
						},
						{ once: true },
					);
				});
			},
		});
		t.after(async () => {
			await worker.shutdown();
			agentDir.cleanup();
			repo.cleanup();
			await provider.stop();
		});

		await worker.getState(30_000);
		const requested = worker.waitForEvent(
			(event) => event.type === "extension_ui_request" && event.method === "select",
			30_000,
		);
		// The prompt's own response does not arrive while a dialog is open — the
		// run is blocked on it, which is exactly the state under test.
		const prompted = worker.prompt("go").catch(() => undefined);
		await requested;

		// The dialog is tracked while it is in flight — that is the whole fix.
		const pending = worker.pendingDialogs();
		assert.equal(pending.length, 1, `expected one in-flight dialog, got ${JSON.stringify(pending)}`);
		const dialogId = pending[0]?.id as string;
		assert.ok(dialogId.length > 0);
		assert.ok(signals[0] instanceof AbortSignal, "the relay is handed a signal it can pass to ctx.ui.*");
		assert.equal(signals[0]?.aborted, false);

		const startedAt = Date.now();
		await worker.kill("SIGKILL");
		assert.equal(await relayOutcome, "worker-gone", "the relay path must resolve, not hang on a dead worker");
		const elapsed = Date.now() - startedAt;
		assert.ok(
			elapsed < DEFAULT_SHUTDOWN_GRACE_MS,
			`worker-gone must arrive within the shutdown grace, took ${elapsed}ms`,
		);
		assert.equal(signals[0]?.aborted, true, "the operator's dialog is dismissed by the same signal");

		// And no fabricated answer is possible afterwards: the boolean is the fact.
		assert.equal(worker.answerDialog(dialogId, { value: "SQLite" }), false, "a dead worker cannot be answered");
		assert.equal(worker.answerDialog("no-such-dialog", { value: "x" }), false, "an unknown id is not answerable");
		assert.deepEqual(worker.pendingDialogs(), [], "a dialog nobody can answer is not left pending");
		await prompted;
	},
);

test(
	"cp-xbxz: a held dialog answered later reaches the worker, its transcript and the model",
	{ timeout: 120_000 },
	async (t) => {
		const provider = await MockProvider.start();
		const repo = createScratchRepo({ name: "held-dialog" });
		// The console's shape: ask, then inject the answer as a session message, so
		// the answer is in the transcript and in what the model is sent.
		repo.write(
			"hold.ts",
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const answer = await ctx.ui.input("Which database?", "");
		return {
			message: {
				customType: "cp-console",
				content: "operator said: " + String(answer),
				display: true,
			},
		};
	});
}
`,
		);
		const model = provider.addScript("held-dialog", [{ kind: "text", text: "Noted the operator's choice." }]);
		const agentDir = createAgentDir({ provider });
		const sessionDir = join(repo.path, "sessions");

		let release: () => void = () => {};
		const worker = WorkerProcess.spawn({
			cwd: repo.path,
			model,
			env: agentDir.env,
			extensions: [join(repo.path, "hold.ts")],
			sessionDir,
			extraArgs: ["--no-context-files"],
			// Held: the relay never decides. The console answers it later, out of band.
			onDialog() {
				return new Promise((resolve) => {
					release = () => resolve({ cancelled: true });
				});
			},
		});
		t.after(async () => {
			release();
			await worker.shutdown();
			agentDir.cleanup();
			repo.cleanup();
			await provider.stop();
		});

		await worker.getState(30_000);
		const requested = worker.waitForEvent(
			(event) => event.type === "extension_ui_request" && event.method === "input",
			30_000,
		);
		const prompted = worker.prompt("Pick the store for the cache.").catch(() => undefined);
		await requested;
		const dialogId = worker.pendingDialogs()[0]?.id as string;
		assert.ok(dialogId, "the held dialog is visible to the console");

		// Held for a while, exactly as an operator who stepped away would hold it.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		assert.equal(worker.answerDialog(dialogId, { value: "SQLite" }), true, "a live worker takes the answer");
		assert.equal(worker.answerDialog(dialogId, { value: "Postgres" }), false, "and takes it exactly once");
		assert.deepEqual(worker.pendingDialogs(), []);

		await worker.waitForSettled(60_000);
		await prompted;

		const transcript = await worker.getEntries(undefined, 30_000);
		assert.ok(transcript.entries.length > 0, "get_entries returns the session");
		assert.equal(transcript.dropped, 0);
		assert.ok(typeof transcript.leafId === "string" && transcript.leafId.length > 0, "leafId is a durable cursor");

		const rendered = JSON.stringify(transcript.entries);
		assert.ok(rendered.includes("Pick the store for the cache."), "the brief is in the session");
		assert.ok(rendered.includes("Noted the operator's choice."), "the assistant turn is in the session");
		assert.ok(rendered.includes("operator said: SQLite"), "the answer is in the worker's transcript");

		// And the model was actually sent it — the answer reached the run, not just a file.
		const sent = JSON.stringify(provider.requests("held-dialog").map((request) => request.body.messages));
		assert.ok(sent.includes("operator said: SQLite"), "the scripted model reads the operator's answer back");

		// The cursor works: nothing new since the leaf.
		const since = await worker.getEntries(transcript.leafId as string, 30_000);
		assert.deepEqual(since.entries, [], "an entry id is a cursor, not a filter");
	},
);

test("cp-xbxz: getEntries caps the window and keeps the tail", async (t) => {
	// A fixture child, because the cap is about the transport's arithmetic and
	// not about pi: 500 real entries would be a slow way to assert a slice.
	const fakeWorker = resolve(import.meta.dirname, "fixtures", "fake-entries-worker.mjs");
	const worker = WorkerProcess.spawn({ cwd: process.cwd(), model: "mock/irrelevant", piBin: fakeWorker });
	t.after(async () => {
		await worker.shutdown();
	});

	const transcript = await worker.getEntries(undefined, 10_000);
	assert.equal(transcript.entries.length, TRANSCRIPT_MAX_ENTRIES);
	assert.equal(transcript.dropped, 100);
	assert.equal(transcript.leafId, "e-499");
	assert.equal(transcript.entries[0]?.id, "e-100", "the tail is kept: a console that scrolled wants the recent end");
	assert.equal(transcript.entries.at(-1)?.id, "e-499");

	// An unknown cursor is pi's `success: false`, surfaced as an error rather
	// than as an empty transcript a console would render as "nothing happened".
	await assert.rejects(worker.getEntries("nope", 10_000), WorkerError);
});

test(
	"cp-xbxz: a dialog that arrives when no answer can be written is aborted, not left tracked",
	{ timeout: 30_000 },
	async (t) => {
		// The reachable half of the \"nobody can answer this\" branch: `shutdown()`
		// ends stdin while the child is still mid-turn, and the child then opens a
		// dialog. A fixture, because the ordering has to be deterministic — with a
		// real child the OS decides whether the last stdout chunk or the close wins.
		const fakeWorker = resolve(import.meta.dirname, "fixtures", "fake-late-dialog-worker.mjs");
		let seen: WorkerDialogRequest | undefined;
		let sawDialog: () => void = () => {};
		const dialogged = new Promise<void>((resolve_) => {
			sawDialog = resolve_;
		});
		const worker = WorkerProcess.spawn({
			cwd: process.cwd(),
			model: "mock/irrelevant",
			piBin: fakeWorker,
			async onDialog(request) {
				seen = request;
				sawDialog();
				return { cancelled: true };
			},
		});
		t.after(async () => {
			await worker.shutdown();
		});

		await worker.getState(10_000);
		// Ends stdin, then waits out the grace period: the fixture asks its question
		// inside that window.
		const exit = await worker.shutdown(3_000);
		await dialogged;

		assert.ok(seen, "the question still reaches the relay: a question that arrived gets journaled");
		assert.equal(
			seen?.signal?.aborted,
			true,
			"and it arrives already aborted, so the relay closes it worker_exited without asking a human",
		);
		assert.deepEqual(worker.pendingDialogs(), [], "an unanswerable dialog is not left tracked forever");
		assert.equal(
			worker.answerDialog("late-dialog-1", { value: "SQLite" }),
			false,
			"and it cannot be answered: the response has nowhere to go",
		);
		assert.ok(exit.code !== undefined);
	},
);

test(
	"cp-xbxz: pi itself honours the dialog signal — an aborted dialog resolves without any response",
	{ timeout: 90_000 },
	async (t) => {
		// The project's TUI rule (cur-20260901-5) says code reading is not evidence
		// about a UI. This is the closest thing to real evidence that does not need
		// a human at a terminal: a REAL pi child, the real `ctx.ui.select` path, and
		// the real `{ signal }` option — with nobody ever answering the dialog. If
		// pi ignored or rejected the option the select would sit there until its own
		// timeout and this test would time out instead of passing.
		const provider = await MockProvider.start();
		const repo = createScratchRepo({ name: "signal-honoured" });
		repo.write(
			"ask.ts",
			`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 500);
		const answer = await ctx.ui.select("Postgres or SQLite?", ["Postgres", "SQLite"], {
			signal: controller.signal,
			timeout: 600_000,
		});
		ctx.ui.notify("aborted-result:" + String(answer), "info");
	});
}
`,
		);
		const model = provider.addScript("signal-honoured", [{ kind: "text", text: "asked" }]);
		const agentDir = createAgentDir({ provider });
		const worker = WorkerProcess.spawn({
			cwd: repo.path,
			model,
			env: agentDir.env,
			extensions: [join(repo.path, "ask.ts")],
			extraArgs: ["--no-context-files", "--no-session"],
			// Nobody answers, ever: the abort is the only thing that can end it.
			autoCancelDialogs: false,
		});
		t.after(async () => {
			await worker.shutdown();
			agentDir.cleanup();
			repo.cleanup();
			await provider.stop();
		});

		await worker.getState(30_000);
		const notified = worker.waitForEvent(
			(event) =>
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				typeof event.message === "string" &&
				(event.message as string).startsWith("aborted-result:"),
			30_000,
		);
		const prompted = worker.prompt("go").catch(() => undefined);
		const notify = await notified;
		assert.equal(
			notify.message,
			"aborted-result:undefined",
			"pi resolves a signalled dialog as `undefined` the moment it is aborted, with no response from us",
		);
		await worker.waitForSettled(30_000);
		await prompted;
	},
);

test("cp-xbxz: dialogOptions forwards the worker's signal, and omits the key when there is none", () => {
	// This is what the extension's asker passes to `ctx.ui.select`/`ctx.ui.input`
	// (extensions/command-post/index.ts), so the forwarding is asserted rather
	// than described.
	const controller = new AbortController();
	const withSignal = dialogOptions({
		job_id: "cp-x",
		role: "planner",
		method: "select",
		question: "Postgres or SQLite?",
		timeout_ms: 1_234,
		signal: controller.signal,
	});
	assert.equal(withSignal.timeout, 1_234, "T31's deadline is untouched");
	assert.equal(withSignal.signal, controller.signal, "the very signal the transport aborts on observed death");

	// No signal (a caller with no transport behind it): the key is absent, so a
	// pi build that rejected unknown option keys would never see one.
	const plain = dialogOptions({
		job_id: "cp-x",
		role: "planner",
		method: "input",
		question: "Which module owns token refresh?",
		timeout_ms: 5_000,
	});
	assert.deepEqual(plain, { timeout: 5_000 });
	assert.ok(!Object.hasOwn(plain, "signal"));
});

test("decoder: a message_update is a delta, never a cumulative message snapshot", { timeout: 10_000 }, async () => {
	// Replays tests/fixtures/pi-rpc/delta-turn.jsonl through the real decoder:
	// agent_start, one message_update delta, agent_settled, then child close.
	const fixture = resolve(import.meta.dirname, "fixtures", "pi-rpc", "delta-turn.jsonl");
	const events: WorkerEvent[] = [];
	const worker = WorkerProcess.spawn({
		cwd: process.cwd(),
		model: "mock/does-not-matter",
		piBin: process.execPath,
		argv: ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", fixture],
		onEvent: (event) => events.push(event),
	});
	await worker.closed;

	assert.deepEqual(
		events.map((event) => event.type),
		["agent_start", "message_update", "agent_settled"],
	);
	const update = events[1] as WorkerEvent;
	assert.ok(!Object.hasOwn(update, "message"), "a delta carries no cumulative message; the decoder must not invent one");
	assert.deepEqual(update.assistantMessageEvent, { type: "text_delta", contentIndex: 0, delta: "partial" });
	assert.equal(worker.busy, false);
	assert.equal(worker.settledCount, 1);
});

test("a request to a worker that closed its stdin rejects; the EPIPE is never an uncaught error", { timeout: 10_000 }, async () => {
	// CI run 37755884836: a fake parent going away mid-write surfaced `write EPIPE` as an uncaught
	// stdin 'error' event, failing whichever test was running. The write callback owns that failure.
	let ready!: () => void;
	const started = new Promise<void>((resolve) => (ready = resolve));
	const worker = WorkerProcess.spawn({
		cwd: process.cwd(),
		model: "mock/does-not-matter",
		piBin: process.execPath,
		argv: ["-e", "require('node:fs').closeSync(0); process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n'); setInterval(() => {}, 1000)"],
		onEvent: (event) => event.type === "agent_start" && ready(),
	});
	try {
		await started;
		await assert.rejects(worker.request("get_state", {}, 5_000), /failed to write get_state to worker: .*EPIPE|stdin is closed/);
		await new Promise((resolve) => setTimeout(resolve, 50));
	} finally {
		process.kill(worker.pid as number);
		await worker.closed;
	}
});
