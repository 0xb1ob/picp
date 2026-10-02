/**
 * cur.5.1: parent under `pi --mode rpc` — CI watch and deferred-row release
 * with no TUI; a mid-turn wake-up is queued, never dropped.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../../src/awaiting.ts";
import {
	DEFAULT_ORIGIN,
	DiffVerdictSchema,
	EMPTY_USAGE,
	isoTimestamp,
	LAYOUT,
	paths,
	SCHEMA_VERSION,
	validate,
	type DiffVerdict,
	type FleetRecord,
} from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { createMergeAskProbe } from "../../src/merge-ask.ts";
import { ProjectRegistry } from "../../src/projects.ts";
import {
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	REPO_ROOT,
	startPiChild,
	startRpc,
	waitFor,
} from "../harness/index.ts";

const JOB = "cp-held";
const PR = "https://github.com/example/demo/pull/58";

function writeReviewPass(home: string, headSha: string): void {
	const verdict = {
		schema_version: SCHEMA_VERSION,
		job_id: JOB,
		attempt: 1,
		verdict: "pass",
		cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff does what the brief asked"],
		decided_at: "2026-09-05T10:30:21Z",
		head_sha: headSha,
		diff_stat: { files: 1, truncated: false },
	};
	const checked = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(checked.ok, checked.ok ? "" : checked.errors.join("; "));
	const file = join(home, paths.reviewFile(JOB, 1));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(verdict)}\n`);
}

function writeFakeGh(bin: string, headSha: string, stateFile: string): void {
	mkdirSync(bin, { recursive: true });
	const gh = join(bin, "gh");
	writeFileSync(
		gh,
		`#!/usr/bin/env node
const { readFileSync } = require("fs");
const head = ${JSON.stringify(headSha)};
const args = process.argv.slice(2);
if (args[0] === "api") {
  process.stdout.write(JSON.stringify({
    number: 58,
    html_url: ${JSON.stringify(PR)},
    state: "open",
    merged: false,
    head: { sha: head, ref: "cp-held" },
  }));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "list") {
  const state = readFileSync(${JSON.stringify(stateFile)}, "utf8").trim();
  const run = state === "green"
    ? { conclusion: "success", status: "completed", headSha: head, workflowName: "ci" }
    : { conclusion: null, status: "in_progress", headSha: head, workflowName: "ci" };
  process.stdout.write(JSON.stringify([run]));
  process.exit(0);
}
process.stderr.write("unexpected gh " + args.join(" ") + "\\n");
process.exit(1);
`,
	);
	chmodSync(gh, 0o755);
}

async function seedHeldHome(options: { ciState: "green" | "in_progress" }) {
	const home = createScratchHome();
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n" } });
	repo.git("checkout", "-b", "cp-held");
	repo.write("held.txt", "held\n");
	const headSha = repo.commitAll("held work");
	repo.git("push", "--quiet", "-u", "origin", "cp-held");

	const registry = new ProjectRegistry({ home: home.path });
	await registry.register({ name: "demo", clone_url: repo.remote!, delivery: "pr" });
	const clone = join(home.path, LAYOUT.projects, "demo");
	execFileSync("git", ["clone", "--quiet", repo.remote!, clone]);

	const fleet = new FleetStore({ home: home.path });
	const record: FleetRecord = {
		job_id: JOB,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		worker: {
			pid: process.pid,
			session_id: "sess-held",
			session_file: "/nonexistent/sess-held.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "mock/mock-model",
			started_at: isoTimestamp(),
		},
		worktree: "/tmp/worktrees/demo-held",
		branch: JOB,
		dispatched_at: isoTimestamp(),
		reported_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		receipts: [{ kind: "pr", status: "open", title: "PR for cp-held", url: PR }],
	};
	await fleet.add(record);
	writeReviewPass(home.path, headSha);

	const store = new AwaitingStore({
		home: home.path,
		mergeAsk: createMergeAskProbe({
			head: async () => ({ sha: headSha }),
			runs: async () =>
				options.ciState === "green"
					? [{ status: "completed", conclusion: "success", headSha, workflowName: "ci" }]
					: [{ status: "in_progress", conclusion: null, headSha, workflowName: "ci" }],
			reviewedHeads: () => [headSha],
		}),
	});
	const declared = await store.declareGated({
		type: "approval",
		decision: "Ship cp-held (PR 58), drop it, or open a follow-up?",
		why: "the change is verified",
		blocks: "cp-held delivery",
		job_id: JOB,
	});

	const bin = join(home.path, "bin");
	const stateFile = join(home.path, "gh-state");
	writeFileSync(stateFile, `${options.ciState}\n`);
	writeFakeGh(bin, headSha, stateFile);

	return { home, repo, headSha, declared, bin, stateFile };
}

test("/doctor under rpc names the mode and running timers", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", COMMAND_POST_EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});
	rpc.send({ id: "doc", type: "prompt", message: "/doctor" });
	const notify = await rpc.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			r.message.includes("session: rpc"),
		60_000,
	);
	assert.match(String(notify.message), /headless/);
	assert.match(String(notify.message), /ci-watch on/);
});

test(
	"rpc: CI green on a held PR wakes the parent and opens the deferred merge row",
	{ timeout: 120_000 },
	async (t) => {
		const held = await seedHeldHome({ ciState: "in_progress" });
		t.after(() => {
			held.home.cleanup();
			held.repo.cleanup();
		});
		assert.equal(held.declared.item.state, "deferred");

		const provider = await MockProvider.start();
		const model = provider.addScript("headless-ci", [{ kind: "text", text: "acknowledged" }], {
			onExhausted: "repeat",
		});
		const agentDir = createAgentDir({ provider });
		const child = startPiChild({
			cwd: held.home.path,
			model,
			env: {
				...agentDir.env,
				CP_HOME: held.home.path,
				PATH: `${held.bin}:${process.env.PATH ?? ""}`,
				CP_CI_WATCH_SECONDS: "1",
			},
			extensions: [COMMAND_POST_EXTENSION],
		});
		t.after(async () => {
			await child.close();
			agentDir.cleanup();
			await provider.stop();
		});

		writeFileSync(held.stateFile, "green\n");
		const notice = await child.waitFor(
			(r) =>
				r.type === "extension_ui_request" &&
				r.method === "notify" &&
				typeof r.message === "string" &&
				(r.message.includes("CI/PR OBSERVED") || r.message.includes("decision is now ready")),
			90_000,
		);
		assert.match(String(notice.message), /cp-held|CI\/PR OBSERVED|now ready/);

		await waitFor(
			() => new AwaitingStore({ home: held.home.path }).list("open"),
			(open) => open.some((item) => item.job_id === JOB),
			{ timeoutMs: 30_000, what: "deferred merge row to open" },
		);
	},
);

test("rpc: a wake-up arriving mid-turn is delivered after the turn", { timeout: 120_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress" });
	t.after(() => {
		held.home.cleanup();
		held.repo.cleanup();
	});

	const provider = await MockProvider.start();
	const model = provider.addScript(
		"headless-midturn",
		[
			{ kind: "hang", ms: 4000 },
			{ kind: "text", text: "first turn done" },
		],
		{ onExhausted: "repeat" },
	);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({
		cwd: held.home.path,
		model,
		env: {
			...agentDir.env,
			CP_HOME: held.home.path,
			PATH: `${held.bin}:${process.env.PATH ?? ""}`,
			CP_CI_WATCH_SECONDS: "1",
		},
		extensions: [COMMAND_POST_EXTENSION],
	});
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
	});

	child.send({ id: "cmds", type: "get_commands" });
	await child.waitFor((r) => r.type === "response" && r.id === "cmds", 30_000);

	const first = child.prompt("hold the floor");
	await child.waitFor((r) => r.type === "message_start", 30_000);
	writeFileSync(held.stateFile, "green\n");
	const notice = await child.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			r.message.includes("CI/PR OBSERVED"),
		30_000,
	);
	assert.match(String(notice.message), /CI\/PR OBSERVED/);
	const firstResponse = await first;
	assert.equal(firstResponse.success, true);
	await child.waitFor((r) => r.type === "agent_settled", 30_000);
	const settledAfterFirst = child.eventsOfType("agent_settled").length;
	await waitFor(
		() => provider.requests("headless-midturn").length,
		(n) => n >= 2,
		{ timeoutMs: 60_000, what: "queued wake-up turn after the in-flight one" },
	);
	assert.ok(
		child.eventsOfType("agent_settled").length >= settledAfterFirst,
		"wake-up must not drop the in-flight turn",
	);
});
