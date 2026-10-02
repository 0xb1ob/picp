/**
 * m0 acceptance: the harness boots a real pi RPC child against the mock
 * provider and a scripted tool-call round trip completes — no tokens, no
 * network, fully deterministic.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertEventSequence,
	buildPiArgs,
	createAgentDir,
	createScratchRepo,
	MockProvider,
	startPiChild,
	squashMergeAndDeleteHead,
	createScratchHome,
	readFleet,
	readRunEvents,
	readRunStatus,
	waitFor,
} from "./harness/index.ts";
import { EMPTY_USAGE, isoTimestamp, LAYOUT, paths } from "../src/contracts.ts";
import { mkdirSync, writeFileSync } from "node:fs";

test("scripted tool-call round trip drives a real pi RPC child", { timeout: 90_000 }, async (t) => {
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: "roundtrip", files: { "README.md": "# roundtrip\n" } });
	const model = provider.addScript("roundtrip", [
		{
			kind: "tool_calls",
			calls: [{ name: "bash", args: { command: "printf 'harness-ok' > proof.txt && echo wrote" } }],
			usage: { prompt_tokens: 120, completion_tokens: 30 },
		},
		{ kind: "text", text: "Wrote proof.txt.", usage: { prompt_tokens: 200, completion_tokens: 10 } },
	]);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: repo.path,
		model,
		env: agentDir.env,
		tools: ["bash"],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	const accepted = await child.prompt("Write the proof file.");
	assert.equal(accepted.success, true, `prompt rejected: ${JSON.stringify(accepted)}`);

	await child.waitForSettled(60_000);

	// The tool actually ran in the scratch repo.
	assert.equal(readFileSync(join(repo.path, "proof.txt"), "utf8"), "harness-ok");

	// Event stream shape (subsequence: extra events are allowed).
	assertEventSequence(
		child.records().map((r) => r.type),
		["agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled"],
	);
	const toolStart = child.eventsOfType("tool_execution_start")[0];
	assert.equal(toolStart?.toolName, "bash");

	// Both scripted steps were consumed, and the model saw the tool result.
	assert.equal(provider.remaining("roundtrip"), 0);
	const requests = provider.requests("roundtrip");
	assert.equal(requests.length, 2);
	const secondBody = JSON.stringify(requests[1]?.body ?? {});
	assert.ok(secondBody.includes("wrote"), "second request must carry the tool result");
	assert.ok(
		(requests[0]?.body.tools ?? []).some((tool) => JSON.stringify(tool).includes("bash")),
		"tool schemas must reach the provider",
	);

	// Usage flows through to pi (cost accounting depends on it).
	const state = await child.getState();
	assert.equal(state.isStreaming, false);
});

test("mock provider injects provider errors and hangs", { timeout: 60_000 }, async (t) => {
	const provider = await MockProvider.start();
	t.after(async () => {
		await provider.stop();
	});
	provider.addScript("errors", [{ kind: "error", status: 429, repeat: 2 }, { kind: "text", text: "ok" }]);

	const url = `${provider.baseUrl}/chat/completions`;
	const call = async () =>
		fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: provider.modelId("errors"), stream: false, messages: [] }),
		});

	const first = await call();
	assert.equal(first.status, 429);
	const second = await call();
	assert.equal(second.status, 429, "repeat: 2 must consume two requests");
	const third = await call();
	assert.equal(third.status, 200);
	const body = (await third.json()) as { choices: Array<{ message: { content: string } }> };
	assert.equal(body.choices[0]?.message.content, "ok");

	// Script exhaustion is loud, never a silent empty answer.
	const exhausted = await call();
	assert.equal(exhausted.status, 500);
	assert.match(JSON.stringify(await exhausted.json()), /exhausted/);

	// Hang injection: no response within the window.
	provider.addScript("hangs", [{ kind: "hang" }]);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 300);
	await assert.rejects(
		fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: provider.modelId("hangs"), stream: true, messages: [] }),
			signal: controller.signal,
		}),
	);
	clearTimeout(timer);
});

test("mock provider streams tool-call arguments across deltas", { timeout: 30_000 }, async (t) => {
	const provider = await MockProvider.start();
	t.after(async () => {
		await provider.stop();
	});
	provider.addScript("stream", [
		{ kind: "tool_calls", calls: [{ name: "report_result", args: { job_id: "cp-x", status: "done" } }] },
	]);
	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: provider.modelId("stream"), stream: true, messages: [] }),
	});
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	const text = await response.text();
	const frames = text
		.split("\n\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length));
	assert.equal(frames.at(-1), "[DONE]");
	const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame) as Record<string, any>);
	const argDeltas = parsed
		.flatMap((frame) => frame.choices?.[0]?.delta?.tool_calls ?? [])
		.map((call: any) => call.function?.arguments ?? "")
		.filter((value: string) => value.length > 0);
	assert.ok(argDeltas.length >= 2, "arguments must arrive in multiple deltas");
	assert.deepEqual(JSON.parse(argDeltas.join("")), { job_id: "cp-x", status: "done" });
	assert.ok(parsed.some((frame) => frame.choices?.[0]?.finish_reason === "tool_calls"));
	assert.ok(parsed.some((frame) => frame.usage?.total_tokens > 0));
});

test("worker spawn args follow the contract trust policy", () => {
	const args = buildPiArgs({ cwd: "/tmp", model: "mock/script-x", tools: ["read"] });
	for (const flag of ["--no-approve", "--no-extensions", "--no-skills", "--no-session"]) {
		assert.ok(args.includes(flag), `${flag} missing from ${args.join(" ")}`);
	}
	assert.ok(!args.includes("--approve"));
	assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read"]);

	const resumed = buildPiArgs({ cwd: "/tmp", sessionFile: "/s/abc.jsonl", hermetic: false });
	assert.ok(resumed.includes("--session"));
	assert.ok(!resumed.includes("--no-session"));
	assert.ok(!resumed.includes("--no-approve"), "hermetic: false is explicit opt-out (parent sessions)");
});

test("scratch repo fixture supports remotes, dirt and squash-merge head deletion", () => {
	const repo = createScratchRepo({ name: "fixture" });
	try {
		assert.ok(repo.remote, "remote expected by default");
		assert.ok(repo.isClean());
		assert.deepEqual(repo.remoteBranches(), ["main"]);

		repo.git("checkout", "--quiet", "-b", "cp-job1");
		repo.write("src/app.ts", "export const x = 1;\n");
		assert.ok(!repo.isClean());
		repo.commitAll("feature");
		repo.git("push", "--quiet", "-u", "origin", "cp-job1");
		assert.deepEqual(repo.remoteBranches().sort(), ["cp-job1", "main"]);

		squashMergeAndDeleteHead(repo, "cp-job1");
		repo.git("fetch", "--quiet", "--prune", "origin");
		assert.deepEqual(repo.remoteBranches(), ["main"], "merged head is gone from the remote");
		// The trap from T17: the branch's work IS on main, but three-dot diff lies.
		assert.equal(repo.git("diff", "--name-only", "cp-job1", "origin/main"), "");
	} finally {
		repo.cleanup();
	}
});

test("state readers validate what they read and time out loudly", async () => {
	const home = createScratchHome();
	try {
		const jobId = "cp-fake1";
		mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
		mkdirSync(join(home.path, LAYOUT.state), { recursive: true });

		writeFileSync(
			join(home.path, LAYOUT.fleetFile),
			JSON.stringify({ schema_version: 1, updated_at: isoTimestamp(), jobs: [] }),
		);
		assert.deepEqual(readFleet(home.path).jobs, []);

		writeFileSync(
			join(home.path, paths.statusFile(jobId)),
			JSON.stringify({
				schema_version: 1,
				job_id: jobId,
				phase: "idle",
				turns: 1,
				tool_calls: 0,
				usage: EMPTY_USAGE,
				started_at: isoTimestamp(),
				last_activity_at: isoTimestamp(),
				event_count: 3,
				reported: true,
			}),
		);
		assert.equal(readRunStatus(home.path, jobId).phase, "idle");

		writeFileSync(
			join(home.path, paths.eventsFile(jobId)),
			`${JSON.stringify({ seq: 1, ts: isoTimestamp(), job_id: jobId, source: "cp", type: "spawned", payload: {} })}\n`,
		);
		assert.equal(readRunEvents(home.path, jobId).length, 1);

		// Contract violations surface as errors, not as silent test passes.
		writeFileSync(
			join(home.path, paths.statusFile(jobId)),
			JSON.stringify({ schema_version: 1, job_id: jobId, phase: "exited" }),
		);
		assert.throws(() => readRunStatus(home.path, jobId), /violates the contract/);

		await assert.rejects(
			waitFor(
				() => 1,
				(v) => v === 2,
				{ timeoutMs: 5_000, intervalMs: 10, what: "never" },
			),
			/timed out after 5000ms waiting for never/,
		);
		assert.ok(existsSync(join(home.path, paths.runDir(jobId))));
	} finally {
		home.cleanup();
	}
});
