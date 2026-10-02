/**
 * /cp-awaiting lists open items. Answering is cp_decide (see tests/e2e/decide.test.ts).
 */
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { createAgentDir } from "../harness/agent-dir.ts";
import { MockProvider } from "../harness/mock-provider.ts";
import { startRpc } from "../harness/rpc.ts";
import { createScratchHome } from "../harness/state.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = resolve(REPO_ROOT, "extensions/command-post/index.ts");

test("/cp-awaiting with no open items reports none, over the real extension", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	rpc.send({ id: "run", type: "prompt", message: "/cp-awaiting" });
	const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(response.success, true);
});

test(
	"agent_settled never auto-opens in RPC mode: the turn completes, the checkpoint stays untouched",
	{ timeout: 90_000 },
	async (t) => {
		const home = createScratchHome();
		const checkpoints = new CheckpointStore(home.path);
		checkpoints.request({ jobId: "cp-ship", question: "ship it?" });

		const provider = await MockProvider.start();
		const model = provider.addScript("autoopen-rpc", [{ kind: "text", text: "hello there" }]);
		const agentDir = createAgentDir({ provider });

		const rpc = startRpc({
			cwd: REPO_ROOT,
			args: ["--no-session", "--no-context-files", "-e", EXTENSION, "--model", model],
			env: { CP_HOME: home.path, ...agentDir.env },
		});
		t.after(async () => {
			await rpc.close();
			agentDir.cleanup();
			home.cleanup();
			await provider.stop();
		});

		rpc.send({ id: "run", type: "prompt", message: "hi" });
		const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run", 60_000);
		assert.equal(response.success, true, `prompt failed: ${JSON.stringify(response)}`);

		const awaitingSelects = rpc
			.records()
			.filter(
				(r) =>
					r.type === "extension_ui_request" &&
					r.method === "select" &&
					String(r.title ?? "").startsWith("Awaiting you"),
			);
		assert.deepEqual(awaitingSelects, [], "RPC mode must never auto-open the Awaiting-you dialog");
		assert.equal(checkpoints.get("cp-ship")?.decision, "pending", "nothing answered the checkpoint on its own");
	},
);
