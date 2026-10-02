/**
 * cp-9c5 end to end: `/cp-plan` over a real `pi --mode rpc` session with a
 * real research artifact on disk.
 *
 * The point of this file is not to drive the interactive pager (no pty
 * harness exists in this repo — see tests/e2e/awaiting.test.ts's own note on
 * the same limitation) but to prove, over the wire, the thing this whole job
 * exists to guarantee: **the artifact body never appears anywhere outside a
 * real TUI** — not on stdout, not in any RPC record, and not in the session
 * file `--session-dir` persists to disk.
 *
 * `node --test tests/e2e/plan-view.test.ts`
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { createScratchHome } from "../harness/state.ts";
import { startRpc } from "../harness/rpc.ts";

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
