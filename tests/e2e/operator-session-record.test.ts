/** Behavior 11, P9c: the operator session record (cp-sessions-operator-transcript-9giu) — what a real cp-bridge
 * operator appends on cp_parent start/send and what the viewer's "you" transcript then lists. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { createViewer, type ViewerOptions } from "../../src/viewer/server.ts";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";
import { stopParentHosts } from "../harness/parent-hosts.ts";

test("P9-session-log: cp_parent records only absolute .jsonl operator files, once each, and the viewer lists them newest first past junk", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const parentModel = provider.addScript("p9-record-parent", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = agent.path;
	saveOperatorTarget({ home: home.path, mode: "multi", hostPid: 0, parentPid: 0 });
	if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous;
	t.after(async () => { await stopParentHosts(home.path); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const state = join(home.path, LAYOUT.state);
	const record = operatorSessionsFile(join(state, "sessions"));
	const lines = () => readFileSync(record, "utf8").split("\n").filter(Boolean);

	let operators = 0;
	/** One operator session whose process sees `sessionFile` as PI_SESSION_FILE; it runs `actions` as cp_parent calls. */
	const operator = async (sessionFile: string | undefined, actions: Array<"start" | "send">) => {
		const model = provider.addScript(`p9-record-operator-${++operators}`, [
			...actions.map((action) => ({ kind: "tool_calls" as const, calls: [{ name: "cp_parent", args: action === "start" ? { action, home: home.path, mode: "multi", model: parentModel } : { action, text: "Say ready." } }] })),
			{ kind: "text", text: "Done." },
		]);
		agent.writeModels(provider);
		const env = { ...agent.env, PI_HOME: agent.path, CP_HOME: home.path, CP_MODE: "multi", ...(sessionFile ? { PI_SESSION_FILE: sessionFile } : {}) };
		const child = startPiChild({ cwd: home.path, model, env, extensions: [CP_BRIDGE_EXTENSION] });
		try {
			await child.prompt("Drive the parent.");
			await child.waitFor((r) => r.type === "agent_settled", 60_000);
			const results = child.records().filter((r) => r.type === "tool_execution_end" && r.toolName === "cp_parent");
			assert.equal(results.length, actions.length, JSON.stringify(results));
			for (const result of results) assert.ok(!result.isError, `a record write never fails cp_parent: ${JSON.stringify(result.result)}`);
		} finally { await child.close(); }
	};

	const server = createViewer({ home: home.path, stateDir: state, host: "127.0.0.1", port: 0, requireTailnet: true, log: () => {}, operatorStart: { tmux: null, herdr: null } } satisfies ViewerOptions);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => server.close());
	const you = async (session?: string) => {
		const port = (server.address() as AddressInfo).port;
		const response = await fetch(`http://127.0.0.1:${port}/api/sessions?view=you&transcript=1${session ? `&session=${session}` : ""}`);
		assert.equal(response.status, 200);
		return await response.json() as { operator_sessions: Array<{ id: string; at: string }>; operator_session: string | null; entries: unknown[] };
	};

	assert.deepEqual((await you()).operator_sessions, [], "no record yet is an empty list, never a crash");
	await operator(undefined, ["start"]);
	await operator("relative.jsonl", ["start"]);
	await operator("/home/op/notes.txt", ["start"]);
	assert.equal(existsSync(record), false, "only an absolute .jsonl path is recorded");

	const one = join(home.path, "operator", "one.jsonl");
	const two = join(home.path, "operator", "two.jsonl");
	await operator(one, ["start", "send"]);
	assert.equal(lines().length, 1, "the file already recorded newest is not appended twice");
	await operator(two, ["start"]);
	const listed = (await you()).operator_sessions;
	assert.deepEqual(listed.map((row) => row.id), ["two.jsonl", "one.jsonl"], "newest first, id is the basename the viewer links by");
	assert.deepEqual(lines().map((line) => JSON.parse(line).at), [listed[1]!.at, listed[0]!.at]);

	// A hand-edited or half-written line is skipped; the good rows still read, and reading never rewrites the record.
	const three = join(home.path, "operator", "three.jsonl");
	appendFileSync(record, `not json\n{"at":"2026-09-28T00:00:00Z","session_file":"/etc/passwd"}\n{"at":"2000-01-01T00:00:00Z","session_file":"${three}"}\n{"session_file":"${three}"}\n`);
	const view = await you();
	assert.deepEqual(view.operator_sessions.map((row) => row.id), ["two.jsonl", "one.jsonl", "three.jsonl"], "a rejected line and a time-less line are skipped, not fatal");
	assert.equal(view.operator_session, "two.jsonl");
	mkdirSync(dirname(three), { recursive: true });
	writeFileSync(three, `${JSON.stringify({ type: "session", version: 3, id: "s3", timestamp: "2000-01-01T00:00:00.000Z", cwd: home.path })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2000-01-01T00:00:01.000Z", message: { role: "user", content: "hello from three", timestamp: 946684801000 } })}\n`);
	const opened = await you("three.jsonl");
	assert.equal(opened.operator_session, "three.jsonl");
	assert.ok(JSON.stringify(opened.entries).includes("hello from three"), `every row carries the path the transcript reads: ${JSON.stringify(opened.entries)}`);
	assert.equal(lines().length, 6, "the reader never rewrites the record");
});
