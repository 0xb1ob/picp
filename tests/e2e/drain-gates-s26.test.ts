import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, startPiChild } from "../harness/index.ts";
import { drainFile } from "../../src/drain.ts";
import { JOB, seedHeldHome } from "../harness/held-home.ts";

const calls = [
	{ name: "cp_next", args: {} },
	{ name: "cp_dispatch", args: { job_id: "cp-any", task: "work" } },
	{ name: "cp_integrate", args: { job_id: JOB } },
	{ name: "cp_review", args: { job_id: JOB } },
	{ name: "cp_gate", args: { job_id: JOB } },
];

test("S26: real tools refuse starts while drain state exists or is malformed", { timeout: 90_000 }, async (t) => {
	for (const call of [...calls, { name: "cp_dispatch", args: { job_id: "cp-any", task: "malformed" } }]) {
		await t.test(`${call.name} ${"task" in call.args ? call.args.task : ""}`, async () => {
			const s = await seedHeldHome({ ciState: "in_progress" });
			const provider = await MockProvider.start();
			const agent = createAgentDir({ provider });
			const model = provider.addScript("s26-gate", [{ kind: "tool_calls", calls: [call] }, { kind: "text", text: "gate checked" }], { onExhausted: "repeat" });
			agent.writeModels(provider);
			const child = startPiChild({ cwd: s.home.path, model, env: { ...agent.env, CP_HOME: s.home.path, PATH: `${s.bin}:${process.env.PATH}` }, extensions: [COMMAND_POST_EXTENSION] });
			try {
				await child.prompt("/cp-drain 30");
				await child.waitFor((r) => r.type === "extension_ui_request" && String(r.message).startsWith("DRAIN:"), 20_000);
				const malformed = "task" in call.args && call.args.task === "malformed";
				if (malformed) writeFileSync(drainFile(s.home.path), "{broken");
				await child.prompt(`Check ${call.name}.`);
				const result = await child.waitFor((r) => r.type === "tool_execution_end" && r.toolName === call.name, 20_000);
				assert.match(JSON.stringify(result.result), malformed ? /not a drain record/ : /draining/, call.name);
			} finally { await child.close(); agent.cleanup(); await provider.stop(); s.repo.cleanup(); s.home.cleanup(); }
		});
	}
});
