import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerProcess } from "../../src/worker-process.ts";
import { createAgentDir, createScratchRepo, MockProvider, WORKER_REPORTER_EXTENSION } from "../harness/index.ts";

const BLOCK = "worker-compaction-policy-block";
const largeReply = { kind: "text" as const, text: "Continue the work. ".repeat(7000), usage: { prompt_tokens: 190000 } };

for (const [blocked, errors] of [
	[true, ["This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.", "content_filter", "400 content_policy_violation", "Request rejected due to usage policies", "Request blocked by safety policy"]],
	[false, ["503 service unavailable", "429 rate limit", "400 invalid tool order", "Summarization failed: generation hit the token cap", "connection terminated", "Request rejected by rate limit policy", "Request blocked by retry policy"]],
] as const) {
	for (const [index, error] of errors.entries()) {
		test(`S25 worker: ${blocked ? "policy blocks persist" : "other failures retry"} ${index}`, { timeout: 90_000 }, async (t) => {
			const provider = await MockProvider.start();
			const repo = createScratchRepo({ name: "s25-policy", withRemote: false });
			const name = `s25-${blocked}-${index}`;
			const failure = { kind: "error" as const, status: 400, message: error, type: "invalid_request_error" };
			const model = provider.addScript(name, [largeReply, failure, largeReply, ...(blocked ? [] : [failure]), largeReply, ...(blocked ? [] : [failure])], { onExhausted: "repeat" });
			const agent = createAgentDir({ provider, settings: { retry: { enabled: false } } });
			const options = {
				cwd: repo.path, model, tools: ["report_result"], extensions: [WORKER_REPORTER_EXTENSION],
				sessionDir: join(agent.path, "sessions"), extraArgs: ["--no-context-files"],
				env: { ...agent.env, CP_JOB_ID: "cp-s25-policy", CP_KIND: "ship", CP_DELIVERY: "pr", CP_ROLE: "implementer", CP_RUN_DIR: join(agent.path, "run"), CP_WORKTREE: repo.path },
			};
			let worker = WorkerProcess.spawn(options);
			t.after(async () => { await worker.shutdown(); agent.cleanup(); repo.cleanup(); await provider.stop(); });
			const prompt = async () => {
				const settled = worker.waitForSettled(60_000);
				await worker.prompt("Continue the job.");
				await settled;
			};
			await worker.getState();
			await prompt();
			assert.equal(provider.requests(name).length, 2, "first turn attempts summarization");
			await prompt();
			assert.equal(provider.requests(name).length, blocked ? 3 : 4, "policy alone suppresses the next summarizer");
			const sessionFile = (await worker.getState()).sessionFile!;
			await worker.shutdown();
			worker = WorkerProcess.spawn({ ...options, sessionFile });
			await worker.getState();
			await prompt();
			assert.equal(provider.requests(name).length, blocked ? 4 : 6, "revival preserves policy and retry behavior");
			const entries = (await worker.getEntries()).entries.filter((entry) => entry.type === "custom" && entry.customType === BLOCK);
			assert.equal(entries.length, blocked ? 1 : 0, "one durable marker only for policy failures");
			assert.equal(readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.includes(BLOCK)).length, blocked ? 1 : 0);
			assert.equal(provider.remaining(name), 0);
		});
	}
}
