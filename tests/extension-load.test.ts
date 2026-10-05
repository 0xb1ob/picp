/**
 * Acceptance test for PLAN.md T1: `pi -e extensions/command-post/index.ts`
 * loads and `/cp-version` works.
 *
 * Runs a real pi process in RPC mode (no model call, no tokens): registration
 * is asserted via `get_commands`, execution via the `extension_ui_request`
 * notify emitted by the command handler.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LAYOUT, VERDICT_MESSAGE_TYPE } from "../src/contracts.ts";
import { WAKEUP_CUSTOM_TYPES } from "../src/wakeups.ts";
import { readPackageIdentity } from "../extensions/command-post/index.ts";
import { type RpcRecord, startRpc } from "./harness/rpc.ts";
import { createScratchHome } from "./harness/state.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = resolve(REPO_ROOT, "extensions/command-post/index.ts");

interface CommandsResponse extends RpcRecord {
	success?: boolean;
	data?: { commands?: Array<{ name: string; description?: string; source: string }> };
}

test("pi loads the command-post extension and /cp-version reports identity", { timeout: 60_000 }, async (t) => {
	// A scratch home: `session_start` scaffolds whatever home it is pointed at
	// (T30), and a test must not scaffold the operator's checkout as a side
	// effect of asserting that an extension loads.
	const home = createScratchHome();
	// Spec 2026-09-04 PR 1: the rename sweep runs at session start, after the
	// parent lock and before anything reads state/.
	mkdirSync(join(home.path, LAYOUT.state), { recursive: true });
	writeFileSync(
		join(home.path, LAYOUT.fleetFile),
		JSON.stringify({ schema_version: 1, updated_at: "2026-09-01T00:00:00Z", jobs: [{ br_id: "cp-legacy" }] }),
	);
	const rpc = startRpc({
		cwd: REPO_ROOT,
		args: ["--no-session", "-e", EXTENSION],
		env: { CP_HOME: home.path },
	});
	t.after(async () => {
		await rpc.close();
		home.cleanup();
	});

	rpc.send({ id: "cmds", type: "get_commands" });
	const response = (await rpc.waitFor((r) => r.type === "response" && r.id === "cmds")) as CommandsResponse;
	assert.equal(response.success, true, `get_commands failed: ${JSON.stringify(response)}`);

	const commands = response.data?.commands ?? [];
	const cpVersion = commands.find((command) => command.name === "cp-version");
	assert.ok(cpVersion, `cp-version not registered; got: ${commands.map((c) => c.name).join(",")}`);
	assert.equal(cpVersion.source, "extension");
	assert.equal(commands.some((command) => command.name === "cp-attach" || command.name === "cp-next"), false);
	// cp-u3o4: the Q&A path's deterministic door. It is the operator's, so it must
	// exist as a command in a real pi process, not just as a function in a test.
	const cpAsk = commands.find((command) => command.name === "cp-ask");
	assert.ok(cpAsk, `cp-ask not registered; got: ${commands.map((c) => c.name).join(",")}`);
	assert.equal(cpAsk.source, "extension");
	// spec 2026-09-04: the ledger's operator surface.
	const cpJobs = commands.find((command) => command.name === "cp-jobs");
	assert.ok(cpJobs, `cp-jobs not registered; got: ${commands.map((c) => c.name).join(",")}`);
	// cp-8knh: single-project mode was removed, and /cp-mode with it.
	assert.equal(commands.some((command) => command.name === "cp-mode"), false, "/cp-mode is not registered");

	rpc.send({ id: "run", type: "prompt", message: "/cp-version" });
	const identity = readPackageIdentity();
	// Match the version line specifically: session_start's scaffold notification
	// is also a notify, and arrives first on a fresh home.
	const notify = await rpc.waitFor(
		(r) =>
			r.type === "extension_ui_request" &&
			r.method === "notify" &&
			typeof r.message === "string" &&
			(r.message as string).startsWith(`${identity.name} ${identity.version}`),
	);
	const [line, homeLine, commitLine] = String(notify.message).split("\n");
	assert.equal(line, `${identity.name} ${identity.version} (root: ${identity.root})`);
	// T30 + spec 2026-09-04: /cp-version says which mode and home it resolved, and why.
	assert.match(String(homeLine), new RegExp(`^multi-project mode, home ${home.path} \\(source: CP_HOME`));
	// cp-kz20: the loaded commit against the checkout's HEAD, through the version view's bounded git read.
	assert.match(String(commitLine), /^commit [0-9a-f]{7} · deployed [0-9a-f]{7} \(current\) · upstream /);

	const promptResponse = await rpc.waitFor((r) => r.type === "response" && r.id === "run");
	assert.equal(promptResponse.success, true);

	const swept = readFileSync(join(home.path, LAYOUT.fleetFile), "utf8");
	assert.ok(swept.includes('"job_id"'), `fleet.json was not swept: ${swept}`);
	assert.ok(!swept.includes('"br_id"'));
	assert.ok(existsSync(join(home.path, LAYOUT.migrationsDir, "2026-09-job-id.done")), "the sweep marker was not written");
});

test("the sixth wake-up type is registered under the name the contract fixes", () => {
	// The `action` parameter itself is asserted where pi actually reports the
	// tool schema to a model (tests/review-tool.test.ts): this RPC surface has no
	// `get_tools`, so anything here would be a string match on source.
	assert.equal(WAKEUP_CUSTOM_TYPES.verdict, VERDICT_MESSAGE_TYPE);
	assert.equal(VERDICT_MESSAGE_TYPE, "cp-verdict");
});
