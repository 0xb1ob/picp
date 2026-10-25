import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { controlRequest } from "../../src/viewer/control-api.ts";
import { controlConfigFile, controlJournalFile, readControlRecord } from "../../src/viewer/control-files.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild, waitFor } from "../harness/index.ts";

test("S26: real dashboard restart refuses disabled control, missing session, pending parent sends and active session work", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s26-dashboard-refusals", [
		{ kind: "text", text: "Persist this session." },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 10" } }] },
		{ kind: "text", text: "Work completed." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	const marker = join(home.path, "relaunch.json");
	const child = startPiChild({ cwd: home.path, model, sessionDir: join(home.path, "sessions"), extensions: [CP_BRIDGE_EXTENSION], env: { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi", CP_OPERATOR_RELAUNCH_FILE: marker } });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("Persist the session.");
	await child.waitForSettled(20_000);
	const stateDir = join(home.path, LAYOUT.state);
	const found = await waitFor(() => readControlRecord(stateDir), (row) => row.state === "ok", { timeoutMs: 20_000, what: "dashboard control" });
	assert.ok(found.state === "ok");
	const record = found.record;
	const status = async () => {
		const reply = await controlRequest(record, "status", {});
		assert.equal(reply.ok, true);
		return (reply as { result: { restart: { supported: boolean; blockers: string[]; reason: string | null } } }).result.restart;
	};
	const refused = async (reason: RegExp, code = 409) => {
		const reply = await controlRequest(record, "restart", {});
		assert.equal(reply.ok, false, JSON.stringify(reply));
		assert.equal((reply as { status: number }).status, code);
		assert.match((reply as { error: string }).error, reason);
		assert.equal(existsSync(marker), false, "a refusal never prepares a relaunch");
	};
	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled":false}');
	await refused(/^dashboard control is off/, 403);
	// P9f (#533 low): a malformed config is refused as off, naming why; an empty object is on.
	const configs = [['{"enabled": "no"}', /enabled/], ['{"enabled": false, "origin": "x"}', /unknown key origin/], ["not json", /is unreadable/], ["[]", /is not a JSON object/]] as const;
	for (const [text, why] of configs) {
		writeFileSync(controlConfigFile(stateDir), text);
		await refused(new RegExp(`^dashboard control is off \\(.*${why.source}`), 403);
	}
	writeFileSync(controlConfigFile(stateDir), "{}");
	assert.deepEqual(await status(), { supported: true, blockers: [], reason: null });
	writeFileSync(controlConfigFile(stateDir), '{"enabled":true}');
	assert.deepEqual(await status(), { supported: true, blockers: [], reason: null });
	const session = String((await child.getState()).sessionFile);
	const saved = readFileSync(session, "utf8");
	rmSync(session);
	await refused(/is not on disk; nothing to resume$/);
	writeFileSync(session, saved);
	const sends = new ParentSendOutbox({ file: parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl")) });
	const pending = sends.enqueue("A legacy parent send awaiting its observed outcome");
	// P9f: a newer writer's unknown optional fields; the restart preflight's tolerant read still names the pending send.
	const newer = JSON.parse(readFileSync(sends.file, "utf8")) as { entries: Array<Record<string, unknown>>; future_top?: number };
	newer.future_top = 1;
	newer.entries[0]!.future_optional = "later";
	writeFileSync(sends.file, JSON.stringify(newer));
	await refused(new RegExp(`cp_parent send ${pending.id} pending`));
	newer.entries[0]!.state = "nope";
	writeFileSync(sends.file, JSON.stringify(newer));
	await refused(/parent send outbox unreadable: .*violates the parent send contract/);
	rmSync(sends.file);
	await child.prompt("Begin the busy turn.");
	await child.waitFor((row) => row.type === "tool_execution_start" && row.toolName === "bash", 20_000);
	assert.deepEqual(await status(), { supported: true, blockers: ["the session is busy with a turn"], reason: "not now: the session is busy with a turn" });
	await refused(/^not now: the session is busy with a turn$/);
	child.send({ type: "follow_up", id: "s26-queued", message: "A queued follow-up." });
	const queued = await child.waitFor((row) => row.type === "response" && row.id === "s26-queued", 10_000);
	assert.equal(queued.success, true, JSON.stringify(queued));
	assert.ok((await status()).blockers.includes("messages are queued for the session"));
	await refused(/messages are queued for the session/);
	const sending = controlRequest(record, "send", { kind: "message", text: "A dashboard steer.", deliver: "steer" });
	assert.equal((await sending).ok, true);
	assert.ok((await status()).blockers.some((text) => /dashboard request.*injected but not seen/.test(text)));
	await refused(/dashboard request.*injected but not seen/);
	const asks = join(stateDir, "operator", "asks.jsonl");
	mkdirSync(dirname(asks), { recursive: true });
	writeFileSync(asks, `${JSON.stringify({ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: isoTimestamp(), recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] })}\n`);
	const answering = controlRequest(record, "send", { kind: "answer", ask_id: "ask-abcd", label: "Keep", deliver: "steer" });
	assert.equal((await answering).ok, true);
	assert.ok((await status()).blockers.some((text) => /ask ask-abcd answered.*not recorded/.test(text)));
	await refused(/ask ask-abcd answered.*not recorded/);
	assert.equal((await child.getState()).isStreaming, true, "all refusals leave the busy session running");
	const requests = readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.type === "request" && row.kind === "restart");
	assert.equal(requests.length, 7 + configs.length + 1, "every refusal starts with a journaled request");
});
