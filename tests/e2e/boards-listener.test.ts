/**
 * The opt-in boards-only listener through a real `bin/cp-view`: with CP_BOARDS_PORT set, a second port serves only the
 * published boards (BOARD_CSP, the dashboard's confinement) and 404s every dashboard route; unset, nothing changes.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { BOARD_CSP } from "../../src/viewer/boards.ts";
import { CONTROL_MESSAGE_PATH } from "../../src/viewer/control-api.ts";
import { OPERATOR_UPLOAD_PATH } from "../../src/viewer/operator-upload-api.ts";
import { PUSH_SUBSCRIPTION_PATH } from "../../src/viewer/push-api.ts";
import { REFUSED_BOARD_PATHS, seedBoards } from "../harness/boards.ts";
import { freePort, startViewer, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { call } from "../harness/remote.ts";

function seeded(t: TestContext) {
	const scratch = createScratchHome();
	const boards = seedBoards(scratch.path);
	writeFileSync(join(boards.make("tricky", { title: '<b>&"x', description: "<script>alert(1)</script>", created_at: "2026-09-02T00:00:00Z" }), "index.html"), "tricky");
	t.after(() => { scratch.cleanup(); rmSync(boards.outside, { recursive: true, force: true }); });
	return scratch.path;
}

/** A viewer with the boards listener on a free loopback port; resolves once that port serves board.css. */
async function withBoards(t: TestContext, env: Record<string, string> = {}) {
	const home = seeded(t);
	const bp = await freePort();
	const viewer = await startViewer(t, { home, env: { CP_BOARDS_PORT: String(bp), CP_BOARDS_HOST: "127.0.0.1", ...env } });
	// The second port must really bind on CI: a listen error fails here at once, named, and nothing is ever skipped.
	await until(() => {
		const failed = /cp-view: boards listener on \S+ failed: .*/.exec(viewer.output());
		if (failed) throw new Error(`the boards listener could not bind ${bp}: ${failed[0]}`);
		return call(bp, "/boards/board.css").catch(() => ({ status: 0 }));
	}, (reply) => reply.status === 200, `boards listener on ${bp}\n${viewer.output()}`);
	return { viewer, bp };
}

test("BL-serve: a board file, board.css and the bare-slug redirect are served on the boards port under BOARD_CSP", async (t) => {
	const { viewer, bp } = await withBoards(t);
	const page = await call(bp, "/boards/alpha/");
	assert.equal(page.status, 200);
	assert.equal(page.headers["content-security-policy"], BOARD_CSP);
	assert.match(page.text, /<h1>Alpha<\/h1>/);
	assert.equal((await call(bp, "/boards/alpha/img/a.png")).headers["content-type"], "image/png");
	assert.equal((await call(bp, "/boards/board.css")).headers["content-security-policy"], BOARD_CSP);
	const redirect = await call(bp, "/boards/alpha");
	assert.deepEqual([redirect.status, redirect.headers.location], [308, "/boards/alpha/"]);
	assert.equal((await call(bp, "/boards/alpha/", { method: "HEAD" })).status, 200);
	assert.equal((await call(bp, "/boards/alpha/", { headers: { host: "boards.example.test" } })).status, 200, "any Host: public static content");
	assert.match(viewer.output(), new RegExp(`cp-view: boards http://127\\.0\\.0\\.1:${bp}/boards/<slug>/ \\(boards only: public .*index off\\)`));
});

test("BL-404: every dashboard route, method and the index are 404 on the boards port, with no cookie; the dashboard port is unchanged", async (t) => {
	const { viewer, bp } = await withBoards(t);
	const refused: Array<[string, string]> = [["GET", "/"], ["GET", "/api/dashboard"], ["GET", "/api/stream?view=overview"], ["POST", CONTROL_MESSAGE_PATH],
		["GET", "/api/report/cp-1"], ["GET", "/boards/"], ["GET", "/api/identity"], ["GET", "/healthz"], ["GET", "/sw.js"], ["GET", "/assets/viewer/app.js"],
		["GET", "/api/devices"], ["GET", "/pair"], ["POST", "/api/pair/claim"], ["GET", "/api/push"], ["POST", PUSH_SUBSCRIPTION_PATH],
		["POST", OPERATOR_UPLOAD_PATH], ["POST", "/boards/alpha/"], ["DELETE", "/boards/alpha/"],
		["GET", "/api/sessions?view=you&transcript=1"], ["GET", "/api/settings"], ["POST", "/api/settings/apply"],
		["POST", "/api/settings/restore"], ["GET", "/api/settings/models"]];
	for (const [method, path] of refused) {
		const reply = await call(bp, path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
		assert.equal(reply.status, 404, `${method} ${path}`);
		assert.equal(reply.headers["set-cookie"], undefined, `${method} ${path} sets no cookie`);
		assert.equal(reply.headers["content-security-policy"], BOARD_CSP, `${method} ${path}`);
	}
	assert.equal((await viewer.get("/api/identity")).status, 200);
	assert.equal((await viewer.get("/boards/alpha/")).status, 200, "the dashboard still serves boards");
	const index = await viewer.get("/boards/");
	assert.deepEqual([index.status, index.headers.location], [302, "/#reports"]);
});

test("BL-confine: traversal, encoded slashes and symlink escapes stay 404 on the boards port (the dashboard's refusal list)", async (t) => {
	const { bp } = await withBoards(t);
	for (const path of REFUSED_BOARD_PATHS) {
		const reply = await call(bp, path);
		assert.equal(reply.status, 404, path);
		assert.equal(reply.headers["content-security-policy"], BOARD_CSP, path);
		assert.doesNotMatch(reply.text, /secret|elsewhere|jsonout/, path);
	}
});

test("BL-index: CP_BOARDS_INDEX=1 serves an escaped list of boards, newest first, under BOARD_CSP", async (t) => {
	const { viewer, bp } = await withBoards(t, { CP_BOARDS_INDEX: "1" });
	const index = await call(bp, "/boards/");
	assert.equal(index.status, 200);
	assert.equal(index.headers["content-security-policy"], BOARD_CSP);
	assert.ok(index.text.indexOf('href="/boards/beta/"') < index.text.indexOf('href="/boards/tricky/"'), "newest first");
	assert.ok(index.text.indexOf('href="/boards/tricky/"') < index.text.indexOf('href="/boards/alpha/"'), "newest first");
	assert.match(index.text, /&lt;b&gt;&amp;&quot;x/);
	assert.doesNotMatch(index.text, /<script/);
	assert.doesNotMatch(index.text, /escape|jsonout|linked|cp-1/, "skipped boards and job ids are not listed");
	assert.match(viewer.output(), /index on\)/);
});

test("BL-off: with CP_BOARDS_PORT unset there is no boards listener line and the dashboard serves boards as before", async (t) => {
	const viewer = await startViewer(t, { home: seeded(t) });
	assert.equal((await viewer.get("/boards/alpha/")).status, 200);
	assert.doesNotMatch(viewer.output(), /cp-view: boards /);
});

test("BL-clash: CP_BOARDS_PORT equal to the dashboard port is logged and skipped; the dashboard keeps serving", async (t) => {
	const home = seeded(t);
	const port = await freePort();
	const child: ChildProcess = spawn(join(REPO_ROOT, "bin/cp-view"), ["--home", home, "--host", "127.0.0.1", "--port", String(port)],
		{ env: { ...process.env, HOME: home, CP_HOME: home, CP_BOARDS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout!.on("data", (chunk) => (output += chunk));
	child.stderr!.on("data", (chunk) => (output += chunk));
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
	await until(() => call(port, "/api/identity").catch(() => ({ status: 0 })), (reply) => reply.status === 200, `cp-view on ${port}\n${output}`, 60_000);
	assert.equal((await call(port, "/boards/alpha/")).status, 200);
	assert.match(output, new RegExp(`boards listener not started: CP_BOARDS_PORT ${port} is the dashboard port`));
});

test("BL-bad-env: a non-IP CP_BOARDS_HOST or a bad CP_BOARDS_PORT refuses before any listen", (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	for (const [env, named] of [[{ CP_BOARDS_PORT: "8767", CP_BOARDS_HOST: "example.com" }, /CP_BOARDS_HOST must be an IP address/],
		[{ CP_BOARDS_PORT: "70000" }, /CP_BOARDS_PORT must be 1-65535/], [{ CP_BOARDS_PORT: "8767", CP_BOARDS_INDEX: "yes" }, /CP_BOARDS_INDEX must be 0 or 1/]] as const) {
		const run = spawnSync(join(REPO_ROOT, "bin/cp-view"), ["--home", scratch.path, "--host", "127.0.0.1", "--port", "1"],
			{ encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: scratch.path, CP_HOME: scratch.path, ...env } });
		assert.notEqual(run.status, 0, JSON.stringify(env));
		assert.match(run.stderr, named);
		assert.doesNotMatch(run.stdout, /cp-view: (built|http)/, "nothing was built or served");
	}
});
