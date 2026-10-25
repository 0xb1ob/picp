/**
 * cp-9c5 end to end: `/cp-plan` over real RPC, print and JSON sessions never shows the artifact body, and in a real
 * TUI on a pty (tests/harness/tui.ts) it opens the pager, which pages, searches and closes by key.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { LAYOUT, paths, PLAN_VIEW_IDLE_TIMEOUT_MS, SCHEMA_VERSION } from "../../src/contracts.ts";
import { atomicWriteJson } from "../../src/json-store.ts";
import { createScratchHome } from "../harness/state.ts";
import { startRpc } from "../harness/rpc.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, waitFor } from "../harness/index.ts";
import { csiU, startTui } from "../harness/tui.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION = resolve(REPO_ROOT, "extensions/command-post/index.ts");
const SENTINEL = "CP9C5-SENTINEL-DO-NOT-LEAK";

function writeArtifact(home: string, jobId: string, text: string): void {
	mkdirSync(join(home, paths.artifactDir(jobId)), { recursive: true });
	writeFileSync(join(home, paths.artifactFile(jobId)), text);
}

/** Every `*.jsonl` under `dir`, scanned recursively for `needle`. */
function scanForSentinel(dir: string, needle: string): string[] {
	const hits: string[] = [];
	if (!existsSync(dir)) return hits;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) hits.push(...scanForSentinel(path, needle));
		else if (entry.isFile() && readFileSync(path, "utf8").includes(needle)) hits.push(path);
	}
	return hits;
}

test(
	"/cp-plan over RPC never puts the artifact body on stdout, and degrades to a path+size notify",
	{ timeout: 60_000 },
	async (t) => {
		const home = createScratchHome();
		writeArtifact(home.path, "cp-research-1", `# Plan\n\n${SENTINEL}\n`.repeat(200));
		const sessionDir = mkdtempSync(join(tmpdir(), "cp-plan-session-"));

		const rpc = startRpc({
			cwd: REPO_ROOT,
			args: ["--session-dir", sessionDir, "--no-context-files", "-e", EXTENSION],
			env: { CP_HOME: home.path },
		});
		t.after(async () => {
			await rpc.close();
			home.cleanup();
			rmSync(sessionDir, { recursive: true, force: true });
		});

		rpc.send({ id: "run", type: "prompt", message: "/cp-plan cp-research-1" });
		const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
		assert.equal(response.success, true, `/cp-plan failed: ${JSON.stringify(response)}`);

		// The degradation: RPC has hasUI:true but mode:"rpc", so openPlanViewer
		// must notify a path and byte count, never open the pager.
		const notify = rpc
			.records()
			.find((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message ?? "").includes("cp-research-1"));
		assert.ok(notify, `no notify record named the plan: ${JSON.stringify(rpc.records().map((r) => r.type))}`);
		assert.ok(String(notify?.message ?? "").includes(paths.artifactFile("cp-research-1")), "notify must name the path");

		// No leak, stdout: no record anywhere contains the sentinel.
		const leakedRecords = rpc.records().filter((r) => JSON.stringify(r).includes(SENTINEL));
		assert.deepEqual(leakedRecords, [], "the artifact body leaked into an RPC record");

		// No leak, session file: every *.jsonl under --session-dir is clean.
		const leakedFiles = scanForSentinel(sessionDir, SENTINEL);
		assert.deepEqual(leakedFiles, [], "the artifact body leaked into the session file");
	},
);

test("/cp-plan names the expected path for an unknown job — no throw, no stack trace", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "--no-context-files", "-e", EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	rpc.send({ id: "run", type: "prompt", message: "/cp-plan cp-nonexistent" });
	const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(response.success, true, `/cp-plan failed: ${JSON.stringify(response)}`);

	const error = rpc.records().find((r) => r.type === "extension_ui_request" && r.method === "notify" && r.notifyType === "error");
	assert.ok(error, `no error notify: ${JSON.stringify(rpc.records())}`);
	assert.match(String(error?.message ?? ""), /no artifact for cp-nonexistent/);
	assert.equal(rpc.stderr().includes("Error:"), false, "a stack trace reached stderr");
});

test("/watch appends a plan pointer (path + size) when an artifact exists, and no body", { timeout: 60_000 }, async (t) => {
	const home = createScratchHome();
	writeArtifact(home.path, "cp-research-2", `${SENTINEL}\n`);
	mkdirSync(join(home.path, LAYOUT.runs, "cp-research-2"), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.runs, "cp-research-2/events.jsonl"), "");

	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "--no-context-files", "-e", EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	rpc.send({ id: "run", type: "prompt", message: "/watch cp-research-2" });
	const response = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(response.success, true, `/watch failed: ${JSON.stringify(response)}`);

	const rendered = rpc.records().find((r) => r.type === "extension_ui_request" && String(r.message ?? "").includes("plan: /cp-plan"));
	assert.ok(rendered, `no plan pointer in /watch output: ${JSON.stringify(rpc.records())}`);
	assert.ok(!JSON.stringify(rpc.records()).includes(SENTINEL), "the artifact body leaked via /watch");
});

async function tuiBench(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript(`p11b-plan-${t.name.slice(0, 10).replace(/\W/g, "")}`, [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); home.cleanup(); });
	const env = { ...agent.env, CP_HOME: home.path, CP_MODE: "multi" };
	const args = ["--no-session", "--no-extensions", "--no-context-files", "-e", COMMAND_POST_EXTENSION, "--model", model];
	return { home: home.path, env, provider, args };
}

function writeGate(home: string, researchId: string, attempt: number, raw: boolean, body: unknown): void {
	mkdirSync(join(home, paths.runDir(researchId)), { recursive: true });
	writeFileSync(join(home, raw ? paths.gateFileRaw(researchId, attempt) : paths.gateFile(researchId, attempt)), JSON.stringify(body));
}

const has = (...needles: string[]) => (drawn: string) => needles.every((needle) => drawn.includes(needle));

// P11b-plan-tui: /cp-plan in a real TUI on a Kitty-protocol pty pages, searches and closes by key, resolves ship ids
// and gate attempts, caps a huge file, and keeps every line inside a 100-column terminal.
test("P11b-plan-tui: /cp-plan pages, searches and closes in a real Kitty TUI, resolving ship ids and gate attempts", { timeout: 240_000 }, async (t) => {
	const b = await tuiBench(t);
	const doc = Array.from({ length: 500 }, (_, i) => (i === 300 ? "- **Unknowns** 300" : i === 400 ? "- unknowns 400" : `- line ${i}`));
	doc[7] = `- ${SENTINEL}`;
	writeArtifact(b.home, "cp-research-1", `${doc.join("\n")}\n`);
	writeArtifact(b.home, "cp-short", "- only line\n");
	writeArtifact(b.home, "cp-blank", "\n");
	writeArtifact(b.home, "cp-research-2", "- planned via the checkpoint\n");
	writeArtifact(b.home, "cp-research-3", "- planned via the pipeline link\n");
	writeArtifact(b.home, "cp-big", `${"x".repeat(999)}\n\n`.repeat(2500));
	new CheckpointStore(b.home).request({ jobId: "cp-ship-2", question: "ship cp-ship-2?", researchId: "cp-research-2" });
	const at = "2026-10-01T00:00:00Z";
	atomicWriteJson(join(b.home, paths.pipelineFile("cp-research-3")), {
		schema_version: SCHEMA_VERSION, research_id: "cp-research-3", ship_id: "cp-ship-3", project: "demo", delivery: "local",
		state: "awaiting_authorization", created_at: at, updated_at: at,
	});
	writeGate(b.home, "cp-r", 1, false, { verdict: "revise", cause: "quality", attempt: 1, reasons: ["capped attempt one"] });
	writeGate(b.home, "cp-r", 2, false, { verdict: "pass", attempt: 2, reasons: ["CAPPED-NOT-SHOWN"] });
	writeGate(b.home, "cp-r", 2, true, { verdict: "pass", cause: "quality", attempt: 2, reasons: ["dropped further"], mystery_field: `m${"y".repeat(200)}` });
	writeGate(b.home, "cp-s", 1, false, "not an object");

	const tui = startTui(t, b.home, b.env, b.args, { kitty: true, columns: 100 });
	await waitFor(tui.screen, has("───"), { timeoutMs: 60_000, what: "the TUI editor" });
	const open = (args: string, ...needles: string[]) => tui.run(`/cp-plan ${args} `, has(...needles), `/cp-plan ${args}`);
	const key = (keys: string, ...needles: string[]) => tui.press(keys, has(...needles), JSON.stringify(keys));

	const first = await open("cp-research-1", "cp-research-1 — plan · 5.3 KB · line 1-54/500 (top)", "- line 0", "j/k scroll · PgDn/PgUp");
	assert.doesNotMatch(first, /- line 54\b|truncated/, "one viewport of an uncapped document, never the whole of it");
	await key("\x1b[6~", "line 54-107/500 (11%)", "- line 53");
	await key(csiU(100), "line 81-134/500");
	await key(csiU(117), "line 54-107/500");
	await key(csiU(106), "line 55-108/500");
	await key(csiU(107), "line 54-107/500");
	await key(csiU(103, 2), "line 447-500/500 (bot)", "- line 499");
	await key(csiU(106));
	await key(csiU(107), "line 446-499/500");
	await key(csiU(103), "line 1-54/500 (top)");
	await key(csiU(107));
	await key(csiU(106), "line 2-55/500");
	await key(csiU(47), "search: █");
	await key([..."UNKNOWNS"].map((c) => csiU(c.codePointAt(0) as number)).join(""), "search: UNKNOWNS█ (2 matches)");
	await key("\r", "line 301-354/500", "Unknowns 300");
	await key(csiU(110), "line 401-454/500", "unknowns 400");
	await key(csiU(110), "line 301-354/500");
	await key(csiU(110, 2), "line 401-454/500");
	await key(csiU(110, 2), "line 301-354/500");
	await key("\r");
	await key(csiU(106), "line 302-355/500");
	await key(csiU(47), "search: █");
	await key(csiU(122), "search: z█ (0 matches)");
	await key(csiU(27), "j/k scroll · PgDn/PgUp");
	await key(csiU(120));
	await key(csiU(106), "line 303-356/500");
	await key(csiU(113));

	await open("cp-short", "cp-short — plan · 12 B · line 1/1 (all)");
	await key(csiU(27));
	await open("cp-blank", "cp-blank — plan · 1 B · line 0/0 (empty)");
	await key(csiU(113));
	await open("cp-ship-2", "cp-research-2 — plan", "planned via the checkpoint");
	await key("\x03");
	await open("cp-ship-3", "cp-research-3 — plan", "planned via the pipeline link");
	await key(csiU(113));
	const big = await open("cp-big", "cp-big — plan · 2.4 MB", "truncated, see full");
	assert.match(big, /x{90}/);
	await key(csiU(113));
	const gate = await open("cp-r --gate 2", "Gate decision — cp-r", "Verdict: pass", "Reasons", "dropped further", "Additional fields", "mystery_field");
	assert.doesNotMatch(gate, /CAPPED-NOT-SHOWN/, "the raw decision wins over the capped one");
	await key(csiU(113));
	await open("cp-r --gate 1", "Verdict: revise", "capped attempt one");
	await key(csiU(113));
	await open("cp-r --gate", "Attempt: 2", "dropped further");
	await key(csiU(113));
	await open("cp-s --gate", "Gate decision — cp-s");
	await key(csiU(113));
	await open("cp-nope --gate", "cp-nope plan: no gate decision (any attempt) for cp-nope");
	await open("cp-missing", "cp-missing plan: no artifact for cp-missing");
	await open("../etc/passwd", 'plan: unsafe job id "../etc/passwd"');
	assert.doesNotMatch(tui.screen(), /exceeds terminal width|pi-tui-crash/);

	// A legacy (non-Kitty) 60x8 terminal: raw key bytes, and the viewport floor of 4 body rows.
	const tiny = startTui(t, b.home, b.env, b.args, { lines: 8, columns: 60 });
	await waitFor(tiny.screen, has("───"), { timeoutMs: 60_000, what: "the tiny TUI editor" });
	const tinyFirst = await tiny.run("/cp-plan cp-research-1 ", has("line 1-4/500 (top)", "- line 3"), "tiny viewer");
	assert.doesNotMatch(tinyFirst, /- line [4-9]\b/, "rows()+2 lines: exactly 4 body rows under the floor");
	await tiny.press("G", has("line 497-500/500 (bot)"), "legacy G");
	await tiny.press("g", has("line 1-4/500 (top)"), "legacy g");
	await tiny.press("d", has("line 3-6/500"), "legacy d");
	await tiny.press("q", () => true, "legacy q");
	await tiny.run("/cp-plan cp-short ", has("line 1/1 (all)"), "tiny viewer reopened after q");
	assert.doesNotMatch(tiny.screen(), /exceeds terminal width|pi-tui-crash/);

	// Print and JSON modes have no TUI: the body never reaches stdout or stderr, and no tool exposes the viewer.
	for (const mode of [["-p"], ["--mode", "json"]]) {
		const run = spawnSync("pi", [...mode, ...b.args, "/cp-plan cp-research-1"], { cwd: b.home, env: { ...process.env, ...b.env }, encoding: "utf8", timeout: 60_000 });
		assert.equal(run.status, 0, run.stderr);
		assert.doesNotMatch(run.stdout + run.stderr, new RegExp(SENTINEL), `${mode[0]} leaked the body`);
	}
	await tui.run("hello ", has("Ready."), "a model turn");
	const tools = b.provider.requests().flatMap((r) => r.body.tools ?? []).map((tool) => String((tool.function as { name?: string } | undefined)?.name ?? tool.name));
	assert.ok(tools.includes("cp_pipeline") && !tools.some((name) => /plan/i.test(name)), tools.join(","));
});

// P11b-plan-idle: an untouched pager closes itself after PLAN_VIEW_IDLE_TIMEOUT_MS. Typed into a pager still open,
// "/cp-plan cp-short" would start a search instead of opening the short plan.
test("P11b-plan-idle: an idle /cp-plan pager closes itself and hands the editor back", { timeout: PLAN_VIEW_IDLE_TIMEOUT_MS + 180_000 }, async (t) => {
	const b = await tuiBench(t);
	writeArtifact(b.home, "cp-research-1", "- the long-lived plan\n".repeat(200));
	writeArtifact(b.home, "cp-short", "- only line\n");
	const tui = startTui(t, b.home, b.env, b.args, { kitty: true });
	await waitFor(tui.screen, has("───"), { timeoutMs: 60_000, what: "the TUI editor" });
	await tui.run("/cp-plan cp-research-1 ", has("line 1-54/200 (top)"), "the pager");
	await new Promise((done) => setTimeout(done, PLAN_VIEW_IDLE_TIMEOUT_MS + 5_000));
	await tui.run("/cp-plan cp-short ", has("cp-short — plan · 12 B · line 1/1 (all)"), "the editor after the idle close");
});
