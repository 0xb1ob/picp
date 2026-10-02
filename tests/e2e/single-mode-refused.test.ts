/**
 * Single-project mode was removed (cp-8knh): a real pi child with the
 * extension loaded refuses every door once — a launch inside a plain git
 * repository, `CP_MODE=single` — scaffolds nothing, answers /cp-version with
 * the refusal and blocks fleet tools with the reason.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchRepo,
	MockProvider,
	startPiChild,
	startRpc,
} from "../harness/index.ts";
import { LAYOUT } from "../../src/contracts.ts";

test("a plain git repository is refused once at startup, scaffolds nothing, and /cp-mode is gone", { timeout: 120_000 }, async (t) => {
	const repo = createScratchRepo({ name: "repo-refused" });
	t.after(() => repo.cleanup());
	const rpc = startRpc({
		cwd: repo.path,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		// No CP_HOME, no CP_MODE: the old repo-aware default picked single; now it refuses.
		env: { CP_HOME: "", CP_MODE: "" },
	});
	t.after(async () => {
		await rpc.close();
	});

	await rpc.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			/is a git repository, not a command-post home/.test(String(record.message)),
		60_000,
	);

	rpc.send({ id: "cmds", type: "get_commands" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as {
		data?: { commands?: Array<{ name: string }> };
	};
	const names = (response.data?.commands ?? []).map((c) => c.name);
	assert.ok(names.includes("cp-version"), names.join(","));
	assert.ok(!names.includes("cp-mode"), "/cp-mode is not registered");

	const refusals = rpc.records().filter((record) => /is a git repository, not a command-post home/.test(String(record.message ?? "")));
	assert.equal(refusals.length, 1, "reported once");
	assert.ok(!existsSync(join(repo.path, ".pi-command-post")), "nothing is scaffolded into the repository");
	assert.equal(repo.isClean(), true, "the repository's tracked tree is untouched");
});

test(
	"a refused mode ends startup once and never throws again: before_agent_start degrades instead of re-raising",
	{ timeout: 180_000 },
	async (t) => {
		// CP_MODE=single is refused (single-project mode was removed). It
		// must be reported once by session_start and then stay quiet: every later
		// prompt runs before_agent_start, which used to call currentRuntime()
		// uncaught and re-raise the same ModeError inside the hook.
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "cp-refused-")));
		const provider = await MockProvider.start();
		const model = provider.addScript("refused-mode", [{ kind: "text", text: "first" }]);
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: plain,
			model,
			env: { ...agentDir.env, CP_HOME: "", CP_MODE: "single" },
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
			rmSync(plain, { recursive: true, force: true });
		});

		// The prompt runs `before_agent_start` after startup was already refused.
		// The response is id-correlated, so a hook that re-raised the ModeError
		// surfaces here as a failed turn instead of a completed one.
		const turn = await child.prompt("one");
		assert.equal(turn.success, true, `the turn failed: ${JSON.stringify(turn)}`);
		await child.waitForSettled(120_000);

		const said = [
			...child.records().map((record) => String(record.message ?? "")),
			child.stderr(),
		].join("\n");
		assert.match(said, /single-project mode was removed/, "the refusal is reported");
		assert.equal(
			said.split("single-project mode was removed").length - 1,
			1,
			"reported once, not once per prompt",
		);

		// Nothing was scaffolded: startup ended before any path was written.
		assert.ok(!existsSync(join(plain, ".pi-command-post")));
		assert.ok(!existsSync(join(plain, LAYOUT.data)));
		assert.ok(!existsSync(join(plain, LAYOUT.state)));
	},
);

test("a refused mode: /cp-version reports the refusal instead of throwing", { timeout: 120_000 }, async (t) => {
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "cp-refused-cmd-")));
	const rpc = startRpc({
		cwd: plain,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: "", CP_MODE: "single" },
	});
	t.after(async () => {
		await rpc.close();
		rmSync(plain, { recursive: true, force: true });
	});

	// The startup refusal, exactly once.
	await rpc.waitFor(
		(record) =>
			record.type === "extension_ui_request" &&
			record.method === "notify" &&
			String(record.message).startsWith("pi-command-post: single-project mode was removed"),
		60_000,
	);

	rpc.send({ id: "run", type: "prompt", message: "/cp-version" });
	const version = await rpc.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			(r.message as string).startsWith("pi-command-post "),
	);
	// The command answers with the refusal in place of the mode line; it does not
	// raise the ModeError out of the handler.
	assert.match(String(version.message), /single-project mode was removed/);
	const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(response.success, true, `/cp-version failed: ${JSON.stringify(response)}`);

	const startupRefusals = rpc
		.records()
		.filter((record) => String(record.message ?? "").startsWith("pi-command-post: single-project mode was removed"));
	assert.equal(startupRefusals.length, 1, "the startup refusal is reported once, not once per surface");
});

test("a refused mode: a fleet-mutating cp_ tool is blocked with the reason, not thrown", { timeout: 180_000 }, async (t) => {
	const plain = realpathSync(mkdtempSync(join(tmpdir(), "cp-refused-tool-")));
	const provider = await MockProvider.start();
	const model = provider.addScript("refused-tool", [
		{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: "cp-nope" } }] },
		{ kind: "text", text: "understood" },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: plain,
		model,
		env: { ...agentDir.env, CP_HOME: "", CP_MODE: "single" },
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
		rmSync(plain, { recursive: true, force: true });
	});

	// `cp_teardown` is in FLEET_MUTATING_TOOLS, so it takes the tool_call hook's
	// path that used to read the parent lock through an uncaught currentRuntime().
	const turn = await child.prompt("tear it down");
	assert.equal(turn.success, true, `the turn failed: ${JSON.stringify(turn)}`);
	await child.waitForSettled(120_000);

	// The refusal must reach the *tool result*, not just the startup notify: the
	// hook used to throw here, and a thrown hook neither blocks nor explains.
	const calls = child.eventsOfType("tool_execution_end").filter((record) => record.toolName === "cp_teardown");
	assert.equal(calls.length, 1, `cp_teardown did not run: ${JSON.stringify(child.eventsOfType("tool_execution_end"))}`);
	const result = JSON.stringify(calls[0]);
	assert.match(result, /cp_teardown is unavailable in this session/, "the block names the tool");
	assert.match(result, /single-project mode was removed/, "the block names the refusal");
	assert.ok(!existsSync(join(plain, ".pi-command-post")), "a refused session writes nothing");
});
