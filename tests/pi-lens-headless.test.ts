/**
 * cp-worker-skills: the implementer's pi-lens trial is only safe if pi-lens can
 * never hold a headless edit hostage to `/lens-allow-edit` — a slash command a
 * worker has no operator to type. The only thing that command exempts is the
 * read guard (pi-lens `dist/index.js`: "One-time exemptions via
 * /lens-allow-edit"), and the worker passes `--no-read-guard`
 * (`PACKAGE_FLAGS["pi-lens"]`), which pi-lens resolves as a CLI value that wins
 * over its config files. It also pins `PI_LENS_HOME` (`packageEnv`), since
 * pi-lens otherwise logs into `<cwd>/.pi-lens-probe-home` under tmp and agent
 * worktrees, leaving an untracked dir that refuses the worker's teardown.
 *
 * This drives a real pi child with the REAL installed pi-lens and the exact
 * flags a worker gets: the model edits a file it never read, and the edit must
 * land. Skipped when this home has no pi-lens (CI), so it proves the installed
 * version, which is the one a worker would load.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/profiles.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { activePackagesForRole, resolveWorkerPackages } from "../src/worker-packages.ts";
import { WorkerProcess } from "../src/worker-process.ts";
import { createAgentDir, createScratchRepo, MockProvider, WORKER_REPORTER_EXTENSION, type RecordedRequest, type ScriptStep } from "./harness/index.ts";

/** Edit a file with no prior read; `withReadGuard` drops the worker flag (the control). */
async function editWithoutRead(t: { after: (fn: () => Promise<void>) => void }, withReadGuard: boolean) {
	const lens = await installedLens();
	assert.ok(lens, "caller checked pi-lens is installed");
	const active = activePackagesForRole({ "pi-lens": lens }, "implementer");
	const provider = await MockProvider.start();
	const repo = createScratchRepo({ name: `lens-${withReadGuard ? "guard" : "safe"}` });
	writeFileSync(join(repo.path, "target.ts"), "const value = \"before\";\n", "utf8");
	const name = `lens-edit-${withReadGuard ? "guard" : "safe"}`;
	const model = provider.addScript(name, [
		{
			kind: "tool_calls",
			calls: [{ name: "edit", args: { path: "target.ts", edits: [{ oldText: "before", newText: "after" }] } }],
		},
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: repo.path,
		model,
		tools: ["read", "edit"],
		extensions: [...active.extensions],
		env: { ...process.env, ...agentDir.env, ...(withReadGuard ? {} : active.env) },
		extraArgs: ["--no-context-files", "--no-session", ...(withReadGuard ? [] : (active.flags ?? []))],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});
	await worker.getState(90_000);
	await worker.send("Edit target.ts.");
	await worker.waitForSettled(120_000);
	const toolResult = JSON.stringify(provider.requests(name).at(-1)?.body.messages?.at(-1) ?? {});
	const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo.path, encoding: "utf8" }).stdout;
	return { content: readFileSync(join(repo.path, "target.ts"), "utf8"), toolResult, status };
}

async function installedLens() {
	// getAgentDir() honours PI_CODING_AGENT_DIR, exactly like the parent's own resolution.
	return (await resolveWorkerPackages(getAgentDir()))["pi-lens"];
}

function toolResult(messages: readonly Record<string, unknown>[], name: string): Record<string, unknown> {
	const calls = messages.flatMap((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
		return message.tool_calls.flatMap((call) => {
			const item = call as { id?: string; function?: { name?: string } };
			return item.function?.name === name && item.id ? [{ id: item.id }] : [];
		});
	});
	for (const call of calls) {
		const response = messages.find((message) => message.role === "tool" && message.tool_call_id === call.id);
		if (typeof response?.content !== "string") continue;
		const content = response.content;
		const separator = content.indexOf("\n\n");
		try {
			return JSON.parse(separator < 0 ? content : content.slice(0, separator)) as Record<string, unknown>;
		} catch {
			const success = response.isError !== true && /\n\nresult ok\nusage tokens=/.test(content);
			return { tool: name, ok: success, content };
		}
	}
	throw new Error(`no result for tool call ${name}`);
}

for (const role of ["implementer", "planner", "gate-reviewer"] as const) {
	test(`${role}: real dispatch tools produce anchored edits or read-only outlines`, { timeout: 300_000 }, async (t) => {
		const detected = await resolveWorkerPackages(getAgentDir());
		const required = role === "implementer" ? ["pi-lens", "pi-hashline-edit-pro", "@dietrichgebert/ponytail"] : ["pi-lens"];
		const missing = required.filter((name) => !detected[name]);
		if (missing.length) {
			t.skip(`worker packages not installed/configured: ${missing.join(", ")}`);
			return;
		}
		const provider = await MockProvider.start();
		const repo = createScratchRepo({ name: `tools-${role}` });
		writeFileSync(join(repo.path, "target.ts"), 'export function greeting() { return "before"; }\n');
		const forbidden = role === "implementer" ? ["edit"] : ["replace", "write", "edit"];
		let readResult = "";
		const steps: ScriptStep[] = [
			{ kind: "tool_calls", calls: [{ name: "read", args: { path: "target.ts" } }] },
		];
		if (role === "implementer") steps.push({ kind: "tool_calls", calls: [{ name: "replace", args: (request: RecordedRequest) => {
			readResult = String(toolResult(request.body.messages ?? [], "read").content);
			// Use the anchor the real read served, never a guessed or precomputed anchor.
			const anchor = /([A-Za-z]{4})\u2502export function greeting/.exec(readResult)?.[1] ?? "MISSING";
			return { remove_from: anchor, remove_to: anchor, replacement_lines: ['export function greeting() { return "after"; }'] };
		} }] });
		const structuralTool = role === "implementer" ? "ast_grep_search" : "ast_grep_outline";
		steps.push(
			{ kind: "tool_calls", calls: [{ name: structuralTool, args: role === "implementer"
				? { pattern: "function $NAME($$$ARGS) { $$$BODY }", lang: "typescript", paths: ["target.ts"] }
				: { paths: ["target.ts"] } }] },
			...forbidden.map((name): ScriptStep => ({ kind: "tool_calls", calls: [{ name, args: { path: "forbidden.txt", content: "unsafe" } }] })),
			{ kind: "text", text: "done" },
		);
		const model = provider.addScript(role, steps);
		const agentDir = createAgentDir({ provider });
		const manager = new WorkerManager({ home: agentDir.path, workerReporterPath: WORKER_REPORTER_EXTENSION, optionalPackages: detected });
		t.after(async () => { await manager.shutdownAll(); agentDir.cleanup(); repo.cleanup(); await provider.stop(); });
		await manager.ready();
		const { worker } = manager.spawn({
			identity: { jobId: `tools-${role}`, kind: role === "implementer" ? "ship" : "research", delivery: "local", runDir: agentDir.path, worktree: repo.path },
			profile: loadProfile(join(import.meta.dirname, "../profiles"), role), model,
			parentEnv: { ...process.env, ...agentDir.env },
			extraEnv: { XDG_CONFIG_HOME: join(agentDir.path, "config") },
			extraArgs: ["--no-context-files", "--no-session"],
		});
		await worker.getState(90_000);
		await worker.send("Exercise the configured tools on target.ts.");
		await worker.waitForSettled(120_000);
		const requests = provider.requests(role);
		const messages = requests.at(-1)?.body.messages ?? [];
		for (const name of forbidden) {
			for (const request of requests) assert.equal(request.body.tools?.some((tool) => (tool.function as { name?: string })?.name === name), false, `${name} must not be offered`);
			assert.match(String(toolResult(messages, name).content), /not found|not available|unknown tool/i, `${name} must be refused`);
		}
		const structural = toolResult(messages, structuralTool);
		if (role === "implementer") {
			assertSuccessfulToolResult(structural, structuralTool);
			assert.match(String(structural.content), /target\.ts:\d+:.*function greeting/s, "search must return a real match");
			assert.match(readResult, /[A-Za-z]{4}\u2502export function greeting/);
		} else {
			const outline = structural.outline as Array<{ path: string; items: Array<{ name: string; symbolType: string }> }>;
			assert.ok(Array.isArray(outline), JSON.stringify(structural));
			assert.ok(outline.some((file) => file.path.endsWith("target.ts") && file.items.some((item) => item.name === "greeting" && item.symbolType === "function")), "outline must identify the actual function");
		}
		assert.equal(readFileSync(join(repo.path, "target.ts"), "utf8"), `export function greeting() { return "${role === "implementer" ? "after" : "before"}"; }\n`);
		assert.equal(existsSync(join(repo.path, "forbidden.txt")), false);
	});
}

function assertSuccessfulToolResult(result: Record<string, unknown>, name: string): Record<string, unknown> {
	assert.equal(result.tool, name, JSON.stringify(result));
	assert.equal(result.ok, true, `${name} result was not successful: ${JSON.stringify(result)}`);
	return result;
}

test("failed pi-lens tool results cannot satisfy success assertions", () => {
	assert.throws(() => assertSuccessfulToolResult({ tool: "ast_grep_search", ok: false, error: "failed" }, "ast_grep_search"), /result was not successful/);
});

test("implementer gets structural pi-lens tools without unavailable LSP navigation", { timeout: 300_000 }, async (t) => {
	const lens = await installedLens();
	if (!lens) {
		t.skip("pi-lens is not installed in this home");
		return;
	}
	const active = activePackagesForRole({ "pi-lens": lens }, "implementer");
	const profile = loadProfile(join(import.meta.dirname, "../profiles"), "implementer");
	const manager = new WorkerManager({
		home: "/unused",
		workerReporterPath: join(import.meta.dirname, "../extensions/worker-reporter.ts"),
		optionalPackages: { "pi-lens": lens },
	});
	const plan = manager.plan({
		identity: { jobId: "lens-tools", kind: "ship", delivery: "local", runDir: process.cwd(), worktree: process.cwd() },
		profile,
		model: "mock/lens-tools",
	});
	const names = ["pi_lens_activate_tools", "lens_diagnostics", "ast_grep_search", "ast_grep_outline"];
	for (const name of names) assert.ok(plan.tools.includes(name), `${name} is allowed by the real implementer plan`);
	assert.equal(plan.tools.includes("lsp_navigation"), false);
	assert.equal(active.skills.some((path) => path.endsWith("pi-lens-lsp-navigation")), false);
	assert.equal(plan.tools.includes("ast_grep_replace"), false);
	assert.equal(plan.tools.includes("lens_diagnostic_mark"), false);

	const provider = await MockProvider.start();
	const model = provider.addScript("lens-tools", [
		{ kind: "tool_calls", calls: [{ name: "read", args: { path: "src/worker-packages.ts", limit: 20 } }] },
		{ kind: "tool_calls", calls: [{ name: "ast_grep_search", args: { pattern: "Object.freeze($$$ARGS)", lang: "typescript", paths: ["src/worker-packages.ts"] } }] },
		{ kind: "tool_calls", calls: [{ name: "lsp_navigation", args: { operation: "documentSymbol", path: "src/worker-packages.ts" } }] },
		{ kind: "text", text: "done" },
	]);
	const agentDir = createAgentDir({ provider });
	const worker = WorkerProcess.spawn({
		cwd: process.cwd(),
		model,
		tools: plan.tools,
		extensions: [...active.extensions],
		env: { ...process.env, ...agentDir.env, ...active.env },
		extraArgs: ["--no-context-files", "--no-session", ...(active.flags ?? [])],
	});
	t.after(async () => {
		await worker.shutdown();
		agentDir.cleanup();
		await provider.stop();
	});
	await worker.getState(90_000);
	await worker.send("Read src/worker-packages.ts, find PACKAGE_TOOLS structurally, and verify LSP navigation is unavailable.");
	await worker.waitForSettled(120_000);
	const requests = provider.requests("lens-tools");
	assert.ok(requests.length > 0);
	for (const request of requests) {
		assert.equal(request.body.tools?.some((tool) => (tool.function as { name?: string })?.name === "lsp_navigation"), false, "unavailable navigation must not be advertised");
	}
	const messages = requests.at(-1)?.body.messages ?? [];
	const search = assertSuccessfulToolResult(toolResult(messages, "ast_grep_search"), "ast_grep_search");
	assert.match(String(search.content), /src\/worker-packages\.ts:\d+:.*Object\.freeze/s, `ast_grep_search returned no matches: ${JSON.stringify(search)}`);
	assert.match(String(toolResult(messages, "lsp_navigation").content), /not found|not available|unknown tool/i, "navigation must be refused, not report empty success");
});

test("pi-lens with the worker's flags lets a headless edit through with no prior read", { timeout: 300_000 }, async (t) => {
	if (!(await installedLens())) {
		t.skip("pi-lens is not installed in this home");
		return;
	}
	const { content, toolResult, status } = await editWithoutRead(t, false);
	// pi-lens logs to `<cwd>/.pi-lens-probe-home` under tmp unless PI_LENS_HOME is
	// pinned (`packageEnv`); a dirty tree would refuse the worker's teardown.
	assert.deepEqual(status.trim().split("\n"), ["?? target.ts"], "pi-lens leaves nothing in the worktree");
	assert.match(content, /"after"/, `the edit must land; tool result: ${toolResult}`);
	assert.doesNotMatch(toolResult, /lens-allow-edit/);
});

test("control: without --no-read-guard the same edit is blocked, so the test above is not vacuous", { timeout: 300_000 }, async (t) => {
	if (!(await installedLens())) {
		t.skip("pi-lens is not installed in this home");
		return;
	}
	const { content, toolResult } = await editWithoutRead(t, true);
	assert.match(content, /"before"/, `the read guard must block an unread edit; tool result: ${toolResult}`);
	assert.match(toolResult, /Edit without read/, "blocked by the read guard, not by something else");
});
