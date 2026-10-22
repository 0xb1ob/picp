import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CP_BRIDGE_EXTENSION, MockProvider, createAgentDir, createScratchHome, startRpc } from "../harness/index.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { execFileSync } from "node:child_process";
import { OperatorRelayAcks, OperatorRelayOutbox, operatorRelayAcksFile, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { REPO_ROOT, waitFor } from "../harness/index.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";

const instructions = "Operator delegated cp-b7m6 under the standing mandate. The draft PR awaits review on its pushed head; no merge is authorized yet. Preserve the open decision, held work and next review step. Latest handoff: /home/ubuntu/reports/handoffs/operator.md.";

test("S24 compact: invalid instructions refuse before writing, and a small context never queues", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s24-validation", [
		{ kind: "tool_calls", calls: ["  ", "Use /handoffs/a.md", "Current work. ".repeat(20), instructions].map((text) => ({ name: "self_compact", args: { instructions: text } })) },
		{ kind: "text", text: "Validation complete." },
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "validate", message: "Validate all four compaction instructions." });
	await rpc.waitFor((r) => r.type === "agent_settled", 60_000);
	const input = JSON.stringify(provider.requests("s24-validation")[1]?.body);
	assert.match(input, /refused: empty instructions/);
	assert.match(input, /instructions must be at least 200 characters/);
	assert.match(input, /instructions must mention a handoff file path/);
	assert.match(input, /self_compact not queued: context is at .* under the 200000 threshold/);
	const directory = join(home.path, LAYOUT.state, "operator");
	assert.deepEqual(existsSync(directory) ? readdirSync(directory).filter((name) => name.startsWith("compact-")) : [], []);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 0);
	assert.equal(provider.remaining("s24-validation"), 0);
});


test("S24 compact: queued handoff survives tool replies and reaches one summarizer after settlement", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const settings = join(home.path, LAYOUT.data, "operator.json");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
	const model = provider.addScript("s24-queued", [
		{ kind: "tool_calls", calls: [1, 2].map(() => ({ name: "self_compact", args: { instructions } })) },
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => {
			writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
			return { command: "true" };
		} }] },
		{ kind: "text", text: "S24 tool-result reply completed." },
		{ kind: "text", text: "S24 summary." },
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "queue", message: "Queue compaction and finish the reply." });
	await rpc.waitFor((r) => r.type === "extension_ui_request" && r.message === "self_compact completed", 60_000);
	const records = rpc.records();
	const reply = records.findIndex((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 tool-result reply completed."));
	assert.ok(reply >= 0);
	assert.ok(records.findIndex((r) => r.type === "compaction_start") > reply);
	assert.equal(records.filter((r) => r.type === "compaction_start").length, 1);
	const toolResult = JSON.stringify(provider.requests("s24-queued")[1]?.body);
	assert.match(toolResult, /queued for agent settlement/);
	assert.match(toolResult, /compaction already queued or running/);
	const directory = join(home.path, LAYOUT.state, "operator");
	const files = readdirSync(directory).filter((name) => /^compact-.*\.md$/.test(name));
	assert.equal(files.length, 1);
	const handoff = join(directory, files[0]!);
	assert.ok(readFileSync(handoff, "utf8").includes(instructions));
	assert.ok(readFileSync(handoff, "utf8").includes(handoff));
	const summarizer = JSON.stringify(provider.requests("s24-queued").at(-1)?.body);
	assert.ok(summarizer.includes(instructions));
	assert.ok(summarizer.includes(handoff));
	assert.doesNotMatch(summarizer, /Latest operator handoff directory:/);
	assert.equal(provider.remaining("s24-queued"), 0);
});


test("S24 compact: live operator settings honor positive integer triggers and default every invalid value", { timeout: 110_000 }, async (t) => {
	for (const [index, value] of [500, 0, -1, 1.5, "500", null, Number.MAX_SAFE_INTEGER + 1, "not JSON"].entries()) {
		for (const tokens of [500, 200000]) {
			const home = createScratchHome();
			const provider = await MockProvider.start();
			const settings = join(home.path, LAYOUT.data, "operator.json");
			mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
			writeFileSync(settings, value === "not JSON" ? value : JSON.stringify({ compact_at_tokens: value }));
			const queued = value === 500 || tokens === 200000;
			const script = `s24-setting-${index}-${tokens}`;
			const model = provider.addScript(script, [
				{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }], usage: { prompt_tokens: tokens, completion_tokens: 1 } },
				{ kind: "tool_calls", calls: [{ name: "bash", args: () => {
					writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
					return { command: "true" };
				} }] },
				{ kind: "text", text: "Settings checked." },
				...(queued ? [{ kind: "text" as const, text: "Settings summary." }] : []),
			]);
			const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
			const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
				args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
			t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
			rpc.send({ type: "prompt", id: "setting", message: "Check the configured trigger." });
			await rpc.waitFor((r) => queued ? r.type === "extension_ui_request" && r.message === "self_compact completed" : r.type === "agent_settled", 30_000);
			const input = JSON.stringify(provider.requests(script)[1]?.body);
			assert.match(input, queued ? /queued for agent settlement/ : /not queued/, `value ${JSON.stringify(value)}, tokens ${tokens}`);
			assert.equal(provider.remaining(script), 0);
			await rpc.close();
			agent.cleanup();
			await provider.stop();
			home.cleanup();
		}
	}
});


test("S24 compact: a failed self compact is visible and automatic retries stop after three failures", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "operator.json"), JSON.stringify({ compact_at_tokens: 1 }));
	const failure = { kind: "error" as const, status: 400, message: "S24 compact offline" };
	const model = provider.addScript("s24-failures", [
		{ kind: "text", text: "S24 threshold crossing." },
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		{ kind: "text", text: "S24 request answered." },
		failure,
		{ kind: "text", text: "S24 retry one." }, failure,
		{ kind: "text", text: "S24 retry two." }, failure,
		{ kind: "text", text: "S24 retries exhausted." },
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "start", message: "Cross the configured threshold." });
	await rpc.waitFor((r) => r.type === "extension_ui_request" && /self_compact failed:.*S24 compact offline/.test(String(r.message)), 30_000);
	for (let retry = 1; retry <= 2; retry++) {
		rpc.send({ type: "prompt", id: `retry-${retry}`, message: `S24 retry ${retry}.` });
		await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes(retry === 1 ? "automatic compaction at" : "stopped after 3 failures") && String(r.message).includes("failed"), 30_000);
	}
	const before = rpc.records().filter((r) => r.type === "compaction_start").length;
	assert.equal(before, 3);
	rpc.send({ type: "prompt", id: "exhausted", message: "S24 no further retries." });
	await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 retries exhausted."), 30_000);
	await rpc.waitFor((r) => r.type === "response" && r.id === "exhausted", 30_000);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, before);
	assert.equal(provider.remaining("s24-failures"), 0);
});


test("S24 compact: provider rejection compacts once per streak and stops at three per process", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const rejection = { kind: "error" as const, status: 400, message: "tool_addition requires inline-tools", type: "invalid_request_error" };
	const model = provider.addScript("s24-streaks", [
		{ kind: "text", text: "S24 initial context." },
		...[1, 2, 3].flatMap((cycle) => [rejection, { kind: "text" as const, text: `S24 summary ${cycle}.` }, rejection, { kind: "text" as const, text: `S24 good ${cycle}.` }]),
		rejection,
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "initial", message: "Seed compactable work." });
	await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const notices = () => rpc.records().filter((r) => r.type === "extension_ui_request" && String(r.message).includes("not compacting again"));
	for (const cycle of [1, 2, 3]) {
		rpc.send({ type: "prompt", id: `reject-${cycle}`, message: `S24 reject ${cycle}.` });
		await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("not compacting again") && notices().length >= cycle, 30_000);
		assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, cycle);
		rpc.send({ type: "prompt", id: `good-${cycle}`, message: `S24 end streak ${cycle}.` });
		await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes(`S24 good ${cycle}.`), 30_000);
	}
	rpc.send({ type: "prompt", id: "capped", message: "S24 fourth streak." });
	await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("3 provider-rejection compactions already ran"), 30_000);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 3);
	assert.equal(notices().length, 4);
	assert.match(JSON.stringify(provider.requests("s24-streaks")), /Context was compacted after the provider rejected 1 turn/);
	assert.doesNotMatch(JSON.stringify(provider.requests("s24-streaks")), /operator-compact-request/);
	assert.equal(provider.remaining("s24-streaks"), 0);
});


test("S24 compact: skipped and failed summarizers spend the rejection streak once", { timeout: 90_000 }, async (t) => {
	for (const benign of [false, true]) {
		await t.test(benign ? "benign skip" : "failed summarizer", async (t) => {
		const home = createScratchHome();
		const provider = await MockProvider.start();
		const rejection = { kind: "error" as const, status: 400, message: "tool_addition requires inline-tools", type: "invalid_request_error" };
		const model = provider.addScript("s24-streak-once", [
			...(!benign ? [{ kind: "text" as const, text: "S24 initial context." }] : []),
			rejection,
			...(!benign ? [{ kind: "error" as const, status: 400, message: "S24 summarizer offline" }] : []),
			rejection,
		]);
		const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
			args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
		t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
		if (!benign) {
			rpc.send({ type: "prompt", id: "initial", message: "Seed compactable work." });
			await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
		}
		rpc.send({ type: "prompt", id: "reject", message: "S24 rejected turn." });
		await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes(benign ? "skipped: Nothing to compact" : "not retried in this failure streak"), 30_000);
		const before = rpc.records().filter((r) => r.type === "compaction_start").length;
		rpc.send({ type: "prompt", id: "repeat", message: "S24 another rejected turn." });
		await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("this failure streak already compacted"), 30_000);
		assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, before);
		assert.doesNotMatch(JSON.stringify(provider.requests("s24-streak-once")), /Context was compacted after the provider rejected/);
		assert.equal(provider.remaining("s24-streak-once"), 0);
		});
	}
});


test("S24 compact: held relays remain unacked for health, then enter context once after compaction", { timeout: 90_000 }, async (t) => {
	for (const cancelled of [false, true]) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const settings = join(home.path, LAYOUT.data, "operator.json");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
	const model = provider.addScript("s24-relays", [
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => {
			writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
			return { command: "true" };
		} }] },
		{ kind: "text", text: "S24 waiting for compact." },
		{ kind: "hang", ms: 30000 },
		{ kind: "text", text: "S24 relay answered." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "compact", message: "Compact before answering pending relays." });
	await rpc.waitFor((r) => r.type === "compaction_start", 30_000);
	const state = join(home.path, LAYOUT.state);
	const id = new OperatorRelayOutbox(operatorRelayOutboxFile(state), () => new Date(Date.now() - 601000))
		.enqueue({ kind: "wake", stale: false, text: "S24 held relay", receipt: { level: null, reached: [] }, paths: [] }, "s24-legacy-host");
	// The public relay poll is every 15 seconds; keep the summarizer busy across its first poll.
	await new Promise((resolve) => setTimeout(resolve, 16000));
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	assert.equal(acks.fold().acked.has(id), false);
	assert.equal(acks.fold().emits.has(id), false);
	execFileSync(process.execPath, [join(REPO_ROOT, "src/service/health.ts")], { env: { ...process.env, ...agent.env, CP_HOME: home.path }, stdio: "pipe" });
	const health = JSON.parse(readFileSync(join(state, "health.json"), "utf8"));
	assert.equal(health.checks.relay.status, "fail");
	assert.equal(health.checks.relay.key, `relay:${id}`);
	if (cancelled) {
		rpc.send({ type: "abort", id: "cancel" });
		const reply = await rpc.waitFor((r) => r.type === "response" && r.id === "cancel", 10_000);
		assert.equal(reply.success, true, JSON.stringify(reply));
	}
	await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes(cancelled ? "self_compact failed" : "self_compact completed"), 30_000);
	await waitFor(() => acks.fold().acked.has(id), Boolean, { timeoutMs: 10_000, what: "relay ack after compaction" });
	rpc.send({ type: "prompt", id: "later", message: "S24 check for replay." });
	await rpc.waitFor((r) => r.type === "response" && r.id === "later", 10_000);
	const lines = readFileSync(operatorRelayAcksFile(state), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.filter((line) => line.type === "emit" && line.id === id).length, 1);
	assert.equal(lines.filter((line) => line.type === "ack" && line.id === id).length, 1);
	await rpc.close();
	}
});


test("S24 compact: manual summarizers receive the latest handoff and read failures preserve the fallback", { timeout: 110_000 }, async (t) => {
	for (const keepRecentTokens of [1, 200]) {
		for (const broken of [false, true]) {
			const home = createScratchHome();
			const provider = await MockProvider.start();
			const directory = join(home.path, LAYOUT.state, "operator");
			mkdirSync(directory, { recursive: true });
			mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
			writeFileSync(join(home.path, LAYOUT.data, "operator.json"), JSON.stringify({ handoffs_dir: "/configured/s24-handoffs" }));
			writeFileSync(join(directory, "compact-2026-09-25T00:00:00.000Z.md"), "S24 OLD HANDOFF");
			const latest = join(directory, "compact-2026-09-26T00:00:00.000Z.md");
			if (broken) mkdirSync(latest); else writeFileSync(latest, instructions);
			const script = `s24-enrich-${keepRecentTokens}-${broken}`;
			const model = provider.addScript(script, [
				{ kind: "text", text: "S24 first reply." },
				{ kind: "text", text: "S24 latest reply." },
				{ kind: "text", text: "S24 preserved summary." },
			], { onExhausted: "repeat" });
			const unknownModel = provider.addScript("s24-unknown", [{ kind: "hang", ms: 30000 }], { onExhausted: "repeat" });
			const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens } } });
			const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
				args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
			t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
			for (const turn of [1, 2]) {
				rpc.send({ type: "prompt", id: `turn-${turn}`, message: `S24 work ${turn}. ` .repeat(1000) });
				await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes(turn === 1 ? "S24 first reply." : "S24 latest reply."), 30_000);
			}
			rpc.send({ type: "compact", id: "manual", customInstructions: "Preserve review details." });
			const result = await rpc.waitFor((r) => r.type === "response" && r.id === "manual", 30_000);
			assert.equal(result.success, true, JSON.stringify(result));
			const input = JSON.stringify(provider.requests(script).slice(2).map((request) => request.body));
			assert.match(input, /standing mandate/);
			assert.ok(input.includes("/configured/s24-handoffs"));
			assert.doesNotMatch(input, /S24 OLD HANDOFF/);
			if (broken) {
				assert.ok(rpc.records().some((r) => r.type === "extension_ui_request" && String(r.message).includes("handoff enrichment failed")));
			} else {
				assert.ok(input.includes(instructions));
				assert.ok(input.includes(latest));
			}
			assert.equal(provider.remaining(script), 0);
			if (keepRecentTokens === 1 && !broken) {
				writeFileSync(join(home.path, LAYOUT.data, "operator.json"), JSON.stringify({ compact_at_tokens: 1 }));
				const [providerId, modelId] = unknownModel.split("/");
				rpc.send({ type: "set_model", id: "unknown-model", provider: providerId, modelId });
				const switched = await rpc.waitFor((r) => r.type === "response" && r.id === "unknown-model", 10_000);
				assert.equal(switched.success, true, JSON.stringify(switched));
				rpc.send({ type: "prompt", id: "unknown", message: "S24 abort before any post-compact usage arrives." });
				await waitFor(() => provider.requests("s24-unknown").length, (n) => n === 1, { timeoutMs: 10_000, what: "unknown usage request in flight" });
				rpc.send({ type: "abort", id: "abort-unknown" });
				await rpc.waitFor((r) => r.type === "response" && r.id === "abort-unknown", 10_000);
				assert.equal(rpc.records().filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "operator-compact-request").length, 0);
			}
			await rpc.close();
		}
	}
});


test("S24 compact: a relay handed to the automatic compact-request turn is never handed twice", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const settings = join(home.path, LAYOUT.data, "operator.json");
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
	const model = provider.addScript("s24-relay-order", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "true" } }] },
		{ kind: "hang", ms: 18000 },
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		{ kind: "hang", ms: 1000 },
		{ kind: "hang", ms: 6000 },
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		{ kind: "text", text: "S24 relay-order answered." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "auto", message: "S24 cross the threshold and preserve relays." });
	await waitFor(() => provider.requests("s24-relay-order").length, (n) => n >= 2, { timeoutMs: 10_000, what: "reply in flight" });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
	const state = join(home.path, LAYOUT.state);
	const id = new OperatorRelayOutbox(operatorRelayOutboxFile(state))
		.enqueue({ kind: "wake", stale: false, text: "S24 automatic ordering relay", receipt: { level: null, reached: [] }, paths: [] }, "s24-legacy-host");
	await waitFor(() => provider.requests("s24-relay-order").length, (n) => n >= 4, { timeoutMs: 30_000, what: "compact-request reply in flight" });
	const beforeCompact = new OperatorRelayAcks(operatorRelayAcksFile(state)).fold();
	assert.equal(beforeCompact.emits.has(id), true);
	assert.equal(beforeCompact.acked.has(id), false);
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
	await rpc.waitFor((r) => r.type === "extension_ui_request" && r.message === "self_compact completed", 30_000);
	const acks = new OperatorRelayAcks(operatorRelayAcksFile(state));
	await waitFor(() => acks.fold().acked.has(id), Boolean, { timeoutMs: 10_000, what: "ordering relay acknowledged" });
	await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 relay-order answered."), 30_000);
	assert.match(JSON.stringify(provider.requests("s24-relay-order")[6]?.body), /compaction already queued or running/);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 1);
	rpc.send({ type: "prompt", id: "later", message: "S24 later settle." });
	await rpc.waitFor((r) => r.type === "response" && r.id === "later", 10_000);
	const lines = readFileSync(operatorRelayAcksFile(state), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.filter((line) => line.type === "emit" && line.id === id).length, 1);
	assert.equal(lines.filter((line) => line.type === "ack" && line.id === id).length, 1);
});


test("S24 compact: rejection nudges name unanswered relays and a good answer clears them", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const rejection = { kind: "error" as const, status: 400, message: "tool_addition requires inline-tools", type: "invalid_request_error" };
	const model = provider.addScript("s24-nudge-relay", [
		{ kind: "text", text: "S24 seed conversation." },
		{ kind: "error", status: 529, message: "S24 unrelated overload" },
		{ kind: "error", status: 529, message: "S24 unrelated overload" },
		rejection, { kind: "text", text: "S24 summary one." }, { kind: "text", text: "S24 answered relay." },
		rejection, { kind: "text", text: "S24 summary two." }, { kind: "text", text: "S24 answered work." },
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 }, { PI_HOME: home.path });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "seed", message: "S24 ordinary work." });
	await rpc.waitFor((r) => r.type === "agent_settled", 30_000);
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(home.path, LAYOUT.state)));
	const ids = Array.from({ length: 25 }, (_, index) => outbox.enqueue({ kind: "wake", stale: false, text: `S24 unanswered relay ${index}`, receipt: { level: null, reached: [] }, paths: [] }, "s24-legacy-host"));
	await waitFor(() => rpc.records().filter((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 unrelated overload")).length,
		(n) => n === 2, { timeoutMs: 30_000, what: "both relay batches rejected without opening a streak" });
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 0);
	rpc.send({ type: "prompt", id: "reject-one", message: "S24 first tool-addition rejection." });
	await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 answered relay."), 30_000);
	const firstMessages = provider.requests("s24-nudge-relay").at(-1)?.body.messages as Array<{ content: unknown }>;
	assert.ok(JSON.stringify(firstMessages.at(-1)).includes(`never answered: ${ids.slice(-20).join(", ")}`));
	rpc.send({ type: "prompt", id: "reject-two", message: "S24 second tool-addition rejection." });
	await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 answered work."), 30_000);
	const messages = provider.requests("s24-nudge-relay").at(-1)?.body.messages as Array<{ content: unknown }>;
	const last = JSON.stringify(messages.at(-1));
	assert.match(last, /Continue the current work/);
	assert.doesNotMatch(last, /never answered:/);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 2);
	assert.equal(provider.remaining("s24-nudge-relay"), 0);
});


test("S24 compact: an explicit queued compact spends the provider-rejection streak without a retry nudge", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.data, "operator.json"), JSON.stringify({ compact_at_tokens: 1 }));
	const provider = await MockProvider.start();
	const rejection = { kind: "error" as const, status: 400, message: "tool_addition requires inline-tools", type: "invalid_request_error" };
	const model = provider.addScript("s24-explicit-streak", [
		{ kind: "tool_calls", calls: [{ name: "self_compact", args: { instructions } }] },
		rejection, { kind: "text", text: "S24 explicit summary." }, { kind: "hang", ms: 30000 }, rejection,
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "explicit", message: "S24 queue the compact before the rejected reply." });
	await rpc.waitFor((r) => r.type === "extension_ui_request" && r.message === "self_compact completed", 30_000);
	rpc.send({ type: "prompt", id: "abortable", message: "S24 user input must not erase the failed streak." });
	await waitFor(() => provider.requests("s24-explicit-streak").length, (n) => n === 4, { timeoutMs: 10_000, what: "abortable streak turn" });
	rpc.send({ type: "abort", id: "abort-streak" });
	await rpc.waitFor((r) => r.type === "response" && r.id === "abort-streak", 10_000);
	await rpc.waitFor((r) => r.type === "extension_ui_request" && String(r.message).includes("this failure streak already compacted"), 10_000);
	rpc.send({ type: "prompt", id: "same-streak", message: "S24 same rejection streak." });
	await rpc.waitFor((r) => r.type === "agent_settled" && rpc.records().filter((row) => row.type === "agent_settled").length >= 3, 30_000);
	assert.equal(rpc.records().filter((r) => r.type === "compaction_start").length, 1);
	assert.doesNotMatch(JSON.stringify(provider.requests("s24-explicit-streak")), /Context was compacted after the provider rejected/);
	assert.equal(provider.remaining("s24-explicit-streak"), 0);
});


test("S24 compact: an ignored threshold request compacts automatically and a low settle rearms it", { timeout: 90_000 }, async (t) => {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const settings = join(home.path, LAYOUT.data, "operator.json");
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
	const provider = await MockProvider.start();
	const model = provider.addScript("s24-backstop", [
		{ kind: "text", text: "S24 crossed first." }, { kind: "text", text: "S24 ignored first request." }, { kind: "hang", ms: 1000 },
		{ kind: "text", text: "S24 first turn-prefix summary." },
		{ kind: "text", text: "S24 reset under threshold." },
		{ kind: "tool_calls", calls: [{ name: "bash", args: () => {
			writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1 }));
			return { command: "true" };
		} }] },
		{ kind: "text", text: "S24 crossed again." }, { kind: "text", text: "S24 ignored second request." }, { kind: "hang", ms: 1000 },
		{ kind: "text", text: "S24 second turn-prefix summary." },
	]);
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
	const rpc = startRpc({ cwd: home.path, env: { ...agent.env, PI_HOME: home.path, CP_HOME: home.path },
		args: ["--no-extensions", "-e", CP_BRIDGE_EXTENSION, "--no-session", "--model", model] });
	t.after(async () => { await rpc.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	rpc.send({ type: "prompt", id: "first", message: "S24 ignore the threshold request." });
	for (const cycle of [1, 2]) {
		await rpc.waitFor((r) => r.type === "compaction_start" && rpc.records().filter((row) => row.type === "compaction_start").length >= cycle, 30_000);
		writeFileSync(settings, JSON.stringify({ compact_at_tokens: 100_000_000 }));
		await rpc.waitFor((r) => r.type === "extension_ui_request" && /automatic compaction.*completed/.test(String(r.message)) &&
			rpc.records().filter((row) => row.type === "extension_ui_request" && /automatic compaction.*completed/.test(String(row.message))).length >= cycle, 30_000);
		if (cycle === 1) {
			rpc.send({ type: "prompt", id: "under", message: "S24 reset while the setting is high." });
			await rpc.waitFor((r) => r.type === "message_end" && JSON.stringify(r.message).includes("S24 reset under threshold."), 30_000);
			rpc.send({ type: "prompt", id: "again", message: "S24 cross again." });
		}
	}
	assert.equal(rpc.records().filter((r) => r.type === "message_start" && (r.message as { customType?: string })?.customType === "operator-compact-request").length, 2);
	assert.match(JSON.stringify(provider.requests("s24-backstop")), /standing mandate/);
	assert.equal(provider.remaining("s24-backstop"), 0);
});
