/** Retained (V2): the viewer import boundary is a static source scan, and `runGit`'s refusals and `maxBytes` cap
 * take arguments no route passes (`gitView` sends only its own GIT_VIEWS and a validated sha). */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "../src/viewer/git-read.ts";
import { createScratchHome, git, REPO_ROOT } from "./harness/index.ts";

const VIEWER = join(REPO_ROOT, "src", "viewer");
// operator.ts, doctor-check.ts and model-list.ts (the cp-install `pi --list-models` parser, reused rather than
// copied) may import outside the viewer.
const standalone = () => readdirSync(VIEWER).filter((name) => name.endsWith(".ts") && name !== "operator.ts" && name !== "doctor-check.ts" && name !== "model-list.ts");

test("viewer request/projection modules stay dependency-free and read-only; only the startup builder writes assets, push-subscriptions.ts writes device subscriptions, control-audit.ts appends the dashboard audit journal, uploads.ts stores composer images, threads-api.ts appends thread done lines, device-store.ts writes data/devices.json, device-control.ts owns the device CLI socket", () => {
	const writers = new Set(["build.ts", "push-subscriptions.ts", "control-audit.ts", "uploads.ts", "device-store.ts", "device-control.ts"]);
	for (const name of standalone()) {
		const text = readFileSync(join(VIEWER, name), "utf8");
		for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)) {
			if (match[1]) continue;
			if (name === "build.ts" && match[2] === "esbuild") continue;
			assert.match(match[2] ?? "", /^node:|^\.\/|^\.\.\/home\.ts$|^\.\.\/grant-order\.ts$|^\.\.\/forge-url\.ts$|^\.\.\/service\/daemon-tunnel-files\.ts$|^\.\.\/push\/test-push\.ts$/, `${name} imports ${match[2]}`);
			if (match[2] === "../grant-order.ts") assert.equal(name, "overview-jobs.ts", "only the shared dependency-free comparator crosses the viewer boundary");
			// #328: the test-notification send (VAPID, journal) lives in src/push; only the test route reaches it.
			if (match[2] === "../push/test-push.ts") assert.equal(name, "push-api.ts", "only the push test route sends a push");
			if (match[2] === "../forge-url.ts") assert.doesNotMatch(readFileSync(join(VIEWER, "..", "forge-url.ts"), "utf8"), /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m, "forge-url.ts may cross the viewer boundary only while it imports nothing");
			// PR 2d: the remote runtime reads the tunnel's node-only config/runtime schema, shared with the daemon; nothing else does.
			if (match[2] === "../service/daemon-tunnel-files.ts") assert.equal(name, "remote-runtime.ts", "only the remote runtime reads the tunnel schema");
			if (name === "push-subscriptions.ts") assert.match(match[2] ?? "", /^node:|^\.\/push-files\.ts$/, `${name} imports ${match[2]}`);
			if (name === "control-audit.ts") assert.match(match[2] ?? "", /^node:|^\.\/control-files\.ts$/, `${name} imports ${match[2]}`);
			// PR 2: a revoke removes the device's own push subscriptions through the subscription writer, nothing else from it.
			if (name === "device-store.ts") assert.match(match[2] ?? "", /^node:|^\.\/(?:control-audit|control-files|device-files|push-subscriptions)\.ts$/, `${name} imports ${match[2]}`);
			// The CLI's owner socket (PR 1c) writes only its own record and socket; the store work goes through the routes' store.
			if (name === "device-control.ts") assert.match(match[2] ?? "", /^node:|^\.\/(?:device-files|devices-api|overview-health)\.ts$/, `${name} imports ${match[2]}`);
		}
		for (const match of text.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)) {
			assert.match(match[1] ?? "", /^node:|^\.\/|^\.\.\/home\.ts$/, `${name} dynamically imports ${match[1]}`);
		}
		if (!writers.has(name)) assert.doesNotMatch(text, /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync|createWriteStream|\bwriteSync\(|\b(?:writeFile|appendFile|mkdir|rename|unlink)\s*\(/, name);
		// The dashboard-control writer: only the three write routes (control, image upload, thread done) and the device
		// store (its secret-free device events) import it, nothing else in the viewer.
		if (name !== "control-api.ts" && name !== "operator-upload-api.ts" && name !== "threads-api.ts" && name !== "device-store.ts") assert.doesNotMatch(text, /from "\.\/control-audit\.ts"/, `${name} imports the audit writer`);
		// data/devices.json has one writer: only the device routes, the remote gate and the remote runtime (which composes
		// them) reach the store (devices-api.ts for its type), never another module.
		if (!["device-store.ts", "devices-api.ts", "pair-api.ts", "remote-server.ts", "remote-runtime.ts"].includes(name)) assert.doesNotMatch(text, /from "\.\/device-store\.ts"/, `${name} imports the device store writer`);
		if (name === "devices-api.ts") assert.match(text, /^import type \{[^}]*\} from "\.\/device-store\.ts";$/m, "devices-api.ts takes the store as a type only");
		// The image store is written only through uploads.ts, and only the upload route stores (the message route and the GET only read).
		if (name !== "operator-upload-api.ts" && name !== "uploads.ts") assert.doesNotMatch(text, /\bwriteUpload\b/, `${name} stores an upload`);
		if (name === "control-api.ts" || name === "control-files.ts") assert.doesNotMatch(text, /parent-host|OperatorAsks|operator-asks/, `${name} reaches the parent or the ask journal`);
	}
	// cp-7bsr PR2: the Settings routes are covered by the loop above (dependency-free, write-free, no audit writer); pin that they are in it.
	assert.ok(standalone().includes("settings-api.ts"), "settings-api.ts is a standalone viewer module");
	assert.doesNotMatch(readFileSync(join(VIEWER, "settings-api.ts"), "utf8"), /from "\.\/(?!control-api|control-files|control-inbox|api-types|model-list)[^"]*"/, "settings-api.ts imports only the control modules, api-types and the model list");
	assert.doesNotMatch(readFileSync(join(VIEWER, "push-subscriptions.ts"), "utf8"), /appendFileSync|createWriteStream|unlinkSync|\bappendFile\s*\(/);
	const audit = readFileSync(join(VIEWER, "control-audit.ts"), "utf8");
	assert.doesNotMatch(audit, /writeFileSync|renameSync|rmSync|unlinkSync|truncate/, "the audit writer only appends");
	assert.match(audit, /openSync\(file, "a", 0o600\)/, "and opens for append, owner-only");
	assert.match(readFileSync(join(VIEWER, "control-api.ts"), "utf8"), /from "\.\/control-audit\.ts"/);
	const uploads = readFileSync(join(VIEWER, "uploads.ts"), "utf8");
	assert.doesNotMatch(uploads, /from "\.\/(?!control-files)[^"]*"/, "the image store imports nothing of the viewer but control-files");
	assert.match(uploads, /O_EXCL/, "an upload is created, never overwritten");
});

function repoFor(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const repo = join(home.path, "demo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main", "--quiet");
	for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
	git(repo, "commit", "--allow-empty", "-m", "base", "--quiet");
	return { repo };
}

test("git-read: refuses non-allowlisted subcommands and --output without spawning, and caps output", async (t) => {
	const { repo } = repoFor(t);
	const out = join(repo, "..", "leak.txt");
	assert.deepEqual(await runGit(repo, ["diff", `--output=${out}`]), { ok: false, stdout: "", truncated: false, reason: "refused" });
	assert.equal((await runGit(repo, ["config", "x"])).reason, "refused");
	assert.equal((await runGit(repo, ["log", "--ext-diff"])).reason, "refused");
	assert.equal(existsSync(out), false);
	const capped = await runGit(repo, ["log", "--format=%H"], { maxBytes: 1 });
	assert.deepEqual([capped.ok, capped.truncated, capped.stdout.length], [true, true, 1]);
});
