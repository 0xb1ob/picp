import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerProcess, type WorkerEvent } from "../src/worker-process.ts";
import { createAgentDir, createScratchHome, createScratchRepo, MockProvider, WORKER_REPORTER_EXTENSION } from "./harness/index.ts";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerWorkerCompactionGuard } from "../extensions/worker-reporter/compaction.ts";

const POLICY_ERROR = "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.";
const BLOCK_ENTRY = "worker-compaction-policy-block";
const largeReply = { kind: "text" as const, text: "Continue the work. ".repeat(7000), usage: { prompt_tokens: 190000 } };

function guardFixture() {
	const manager = SessionManager.inMemory();
	const ctx = { sessionManager: manager } as unknown as ExtensionContext;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	registerWorkerCompactionGuard({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		appendEntry: (customType: string, data: unknown) => manager.appendCustomEntry(customType, data),
	} as unknown as ExtensionAPI);
	return {
		manager,
		before: (reason = "threshold") => handlers.get("session_before_compact")!({ branchEntries: manager.getBranch(), reason }, ctx),
		failed: (errorMessage?: string, aborted = false) => handlers.get("session_compact_failed")!({ errorMessage, aborted, reason: "threshold", willRetry: false, fromExtension: false }, ctx),
	};
}

test("policy blocks cancel all summarizer paths once; a fresh session or independent worker is unblocked", () => {
	const f = guardFixture();
	assert.equal(f.before(), undefined);
	f.failed(`Auto-compaction failed: Summarization failed: ${POLICY_ERROR}`);
	for (const reason of ["threshold", "overflow", "manual"]) assert.deepEqual(f.before(reason), { cancel: true });
	f.failed(POLICY_ERROR);
	assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === BLOCK_ENTRY).length, 1);
	assert.equal(guardFixture().before(), undefined, "another worker is unaffected");
	f.manager.newSession();
	assert.equal(f.before(), undefined, "a fresh transcript has no policy-block marker");
});

test("other failures and aborted compactions retain pi's retry behavior", () => {
	const f = guardFixture();
	for (const error of [undefined, "503 service unavailable", "429 rate limit", "400 invalid tool order", "Summarization failed: generation hit the token cap", "connection terminated", "Request rejected by rate limit policy", "Request blocked by retry policy"]) {
		f.failed(error);
		assert.equal(f.before(), undefined, error);
	}
	f.failed(POLICY_ERROR, true);
	assert.equal(f.before(), undefined, "an abort is not a policy failure");
	assert.equal(f.manager.getBranch().length, 0, "no new session errors for other failures");
	for (const error of ["Summarization failed: content_filter", "400 content_policy_violation", "Request rejected due to usage policies", "Request blocked by safety policy"]) {
		f.manager.newSession();
		f.failed(error);
		assert.deepEqual(f.before(), { cancel: true }, error);
	}
});

async function prompt(worker: WorkerProcess) {
	const settled = worker.waitForSettled(60000);
	await worker.prompt("Continue the job.");
	await settled;
}

test("picp-jan: a policy-blocked summarizer is called once, even on later turns and worker revival", { timeout: 90000 }, async () => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "compact-policy", withRemote: false });
	const home = createScratchHome();
	const model = provider.addScript("compact-policy", [
		largeReply,
		{ kind: "error", status: 400, message: POLICY_ERROR, type: "invalid_request_error" },
		largeReply, largeReply, largeReply,
	], { onExhausted: "repeat" });
	const agentDir = createAgentDir({ provider });
	const options = {
		cwd: repo.path, model, tools: ["report_result"], extensions: [WORKER_REPORTER_EXTENSION],
		sessionDir: join(home.path, "sessions"), extraArgs: ["--no-context-files"],
		env: {
			...agentDir.env,
			CP_JOB_ID: "cp-compact-policy", CP_KIND: "ship", CP_DELIVERY: "pr", CP_ROLE: "implementer",
			CP_RUN_DIR: join(home.path, "run"), CP_WORKTREE: repo.path,
		},
	};
	let worker = WorkerProcess.spawn(options);
	const events: WorkerEvent[] = [];
	worker.onEvent((event) => events.push(event));
	try {
		await worker.getState();
		await prompt(worker);
		assert.equal(provider.requests("compact-policy").length, 2, "the first turn attempts summarization");
		assert.ok(events.some((event) => event.type === "compaction_end" && String(event.errorMessage).includes(POLICY_ERROR)));
		await prompt(worker);
		assert.equal(provider.requests("compact-policy").length, 3, "the next turn makes no summarizer request");
		await prompt(worker);
		assert.equal(provider.requests("compact-policy").length, 4);
		const sessionFile = (await worker.getState()).sessionFile;
		assert.ok(sessionFile);
		await worker.shutdown();
		worker = WorkerProcess.spawn({ ...options, sessionFile });
		await worker.getState();
		await prompt(worker);
		assert.equal(provider.requests("compact-policy").length, 5, "revival preserves the guard");
		assert.equal(provider.remaining("compact-policy"), 0);
		const entries = (await worker.getEntries()).entries.filter((entry) => entry.type === "custom" && entry.customType === BLOCK_ENTRY);
		assert.equal(entries.length, 1, "one session error, including after revival");
		assert.match(JSON.stringify(entries[0]), /Terms of Service/);
		const persisted = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.includes(BLOCK_ENTRY));
		assert.equal(persisted.length, 1, "the guard and error are durable JSONL data");
	} finally {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		home.cleanup();
		await provider.stop();
	}
});
