/**
 * Settings → Boards through a real `bin/cp-view` and the operator session's real settings ports: the four boards keys
 * read from `data/daemon.json` and `data/viewer.json`, written exactly, refused by name with no write, and applied live
 * (the boards listener starts, stops or moves; the dashboard listener and its pid stay).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { seedBoards } from "../harness/boards.ts";
import { freePort, operatorSession, startViewer, until } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { call, type Init } from "../harness/remote.ts";

const REQUEST_ID = "req-boards-1";
const OWNERS = ["daemon.json", "viewer.json", "settings-audit.jsonl"];
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const installText = (config: object) => `${JSON.stringify(config, null, 2)}\n`;
const refused = (port: number) => fetch(`http://127.0.0.1:${port}/boards/board.css`)
	.then(() => "open", (error: { cause?: { code?: string } }) => error.cause?.code ?? "error");
type Field = { key: string; value: unknown; source: string };
type Status = { snapshot: { revision: string; fields: Field[] }; boards_listener: unknown };

/** Every data/ file but the two owners and the settings audit log (appended by design), with its bytes' hash. */
function others(data: string): string[] {
	return readdirSync(data, { recursive: true, encoding: "utf8" })
		.filter((name) => statSync(join(data, name)).isFile() && !OWNERS.includes(name))
		.map((name) => `${name} ${sha(join(data, name))}`).sort();
}

/** Waits until `port` serves board.css; a listen failure in the viewer's output fails at once, named, never skipped. */
async function serving(viewer: { output(): string }, port: number, host = "127.0.0.1") {
	await until(async () => {
		const failed = /cp-view: boards listener on \S+ failed: .*/.exec(viewer.output());
		if (failed) throw new Error(`the boards listener could not bind ${port}: ${failed[0]}`);
		return fetch(`http://${host}:${port}/boards/board.css`).then((reply) => reply.status, () => 0);
	}, (status) => status === 200, `boards listener on ${host}:${port}\n${viewer.output()}`);
}

/** A cp-install home (daemon.json at 0600 in cp-install's text) whose viewer runs boards on `bp` and a live session. */
async function rig(t: TestContext) {
	const scratch = createScratchHome();
	const boards = seedBoards(scratch.path);
	t.after(() => { scratch.cleanup(); rmSync(boards.outside, { recursive: true, force: true }); });
	const home = scratch.path;
	const data = join(home, LAYOUT.data), stateDir = join(home, LAYOUT.state);
	mkdirSync(data, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const bp = await freePort();
	const viewer = await startViewer(t, { home, env: { CP_BOARDS_PORT: String(bp), CP_BOARDS_HOST: "127.0.0.1" } });
	await serving(viewer, bp);
	const base = {
		schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app: REPO_ROOT, home,
		path: "/usr/bin:/bin", port: viewer.port, worker_memory_max: "4G",
	};
	const daemonFile = join(data, "daemon.json"), viewerFile = join(data, "viewer.json");
	writeFileSync(daemonFile, installText({ ...base, boards_port: bp, boards_host: "127.0.0.1" }), { mode: 0o600 });
	chmodSync(daemonFile, 0o600);
	const links = { public_url: "https://dash.example.test/", boards_public_url: "https://boards.example.test/" };
	writeFileSync(viewerFile, JSON.stringify(links));
	writeFileSync(join(data, "gate.json"), JSON.stringify({ schema_version: 1, review_timeout_ms: 60_000 }));
	await operatorSession(t, stateDir, () => true, settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }));
	const csrf = (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf;
	const settings = async () => (await viewer.get("/api/settings")).body as Status;
	const init = (body: unknown, revision: string, token: string | null = csrf): Init => ({
		method: "POST", body: JSON.stringify(body),
		headers: {
			origin: viewer.origin, "content-type": "application/json", "sec-fetch-site": "same-origin",
			"if-match": `"${revision}"`, ...(token ? { "x-cp-control-token": token } : {}),
		},
	});
	const apply = async (changes: Record<string, unknown>, token?: string | null) => {
		const revision = (await settings()).snapshot.revision;
		return viewer.get("/api/settings/apply", init({ changes, request_id: REQUEST_ID }, revision, token));
	};
	return { home, data, viewer, bp, base, daemonFile, viewerFile, settings, init, apply };
}

test("BS-get: GET /api/settings reads the four boards keys from both files and the live listener",
	{ timeout: 120_000 }, async (t) => {
		const r = await rig(t);
		const status = await r.settings();
		const field = (key: string) => status.snapshot.fields.find((row) => row.key === key);
		const keys = ["boards.port", "boards.host", "boards.index", "boards.public_url"];
		assert.deepEqual(keys.map((key) => [key, field(key)?.value, field(key)?.source]), [
			["boards.port", r.bp, "file"], ["boards.host", "127.0.0.1", "file"], ["boards.index", false, "code"],
			["boards.public_url", "https://boards.example.test/", "file"],
		]);
		assert.deepEqual(status.boards_listener, { state: "listening", host: "127.0.0.1", port: r.bp, index: false });
	});

test("BS-set: a save writes exactly its keys in cp-install's text and moves the listener live; the dashboard stays",
	{ timeout: 120_000 }, async (t) => {
		const r = await rig(t);
		const untouched = others(r.data), viewerBytes = sha(r.viewerFile);
		const bp2 = await freePort();
		const moved = await r.apply({ "boards.port": bp2, "boards.index": true });
		assert.equal(moved.status, 200, JSON.stringify(moved.body));
		assert.equal(moved.body.state, "applied");
		assert.deepEqual(moved.body.boards, { state: "listening", host: "127.0.0.1", port: bp2, index: true });
		const want = installText({ ...r.base, boards_port: bp2, boards_host: "127.0.0.1", boards_index: true });
		assert.equal(readFileSync(r.daemonFile, "utf8"), want, "cp-install's own text");
		assert.equal(statSync(r.daemonFile).mode & 0o777, 0o600);
		assert.equal(sha(r.viewerFile), viewerBytes, "viewer.json keeps its bytes");
		assert.deepEqual(others(r.data), untouched, "every other data/ file keeps its bytes");
		assert.equal((await call(bp2, "/boards/alpha/")).status, 200);
		assert.equal((await call(bp2, "/boards/")).status, 200, "the index switch is live");
		assert.equal(await refused(r.bp), "ECONNREFUSED", "the old boards port stops answering");
		// A6: the settings routes are 404 on a port the save itself opened, as every dashboard route is.
		const revision = (await r.settings()).snapshot.revision;
		const clear = r.init({ changes: { "boards.port": null }, request_id: REQUEST_ID }, revision);
		const restore = r.init({ section: "boards", request_id: REQUEST_ID }, revision);
		assert.equal((await call(bp2, "/api/settings")).status, 404);
		assert.equal((await call(bp2, "/api/settings/apply", clear)).status, 404);
		assert.equal((await call(bp2, "/api/settings/restore", restore)).status, 404);
		const port = (await r.settings()).snapshot.fields.find((row) => row.key === "boards.port")?.value;
		assert.equal(port, bp2, "nothing was written through the boards port");

		const daemonBytes = sha(r.daemonFile);
		const url = await r.apply({ "boards.public_url": "https://boards2.example.test/" });
		assert.equal(url.body.state, "applied", JSON.stringify(url.body));
		assert.equal(url.body.boards, undefined, "a link origin moves no listener");
		assert.deepEqual(JSON.parse(readFileSync(r.viewerFile, "utf8")), {
			public_url: "https://dash.example.test/", boards_public_url: "https://boards2.example.test/",
		});
		assert.equal(sha(r.daemonFile), daemonBytes, "daemon.json keeps its bytes");

		const host = await r.apply({ "boards.host": "127.0.0.2" });
		const where = { state: "listening", host: "127.0.0.2", port: bp2, index: true };
		assert.deepEqual(host.body.boards, where, JSON.stringify(host.body));
		assert.equal(JSON.parse(readFileSync(r.daemonFile, "utf8")).boards_host, "127.0.0.2");
		await serving(r.viewer, bp2, "127.0.0.2");
		assert.equal(await refused(bp2), "ECONNREFUSED", "the old address stops answering");

		assert.doesNotThrow(() => process.kill(r.viewer.pid, 0), "the same viewer process");
		assert.equal((await r.viewer.get("/api/identity")).status, 200, "the dashboard keeps serving");
		assert.equal(r.viewer.output().match(/cp-view: http:\/\//g)?.length, 1, "the dashboard listener never restarted");
	});

test("BS-off: clearing the port deletes boards_port, reports off, and the boards port stops answering",
	{ timeout: 120_000 }, async (t) => {
		const r = await rig(t);
		const off = await r.apply({ "boards.port": null });
		assert.equal(off.status, 200, JSON.stringify(off.body));
		const changes = (off.body.changes as Array<{ key: string; action: string }>).map((row) => [row.key, row.action]);
		assert.deepEqual(changes, [["boards.port", "delete"]]);
		assert.deepEqual(off.body.boards, { state: "off" });
		assert.equal(readFileSync(r.daemonFile, "utf8"), installText({ ...r.base, boards_host: "127.0.0.1" }));
		assert.equal(await refused(r.bp), "ECONNREFUSED");
		const status = await r.settings();
		assert.equal(status.snapshot.fields.find((row) => row.key === "boards.port")?.value, null);
		assert.deepEqual(status.boards_listener, { state: "off" });
		assert.equal((await r.viewer.get("/api/identity")).status, 200);
	});

test("BS-refuse: the dashboard port, a bad IP or URL, no token and a held port are refused by name, no write",
	{ timeout: 120_000 }, async (t) => {
		const r = await rig(t);
		const held: Server = await new Promise((done) => {
			const server = createServer().listen(0, "127.0.0.1", () => done(server));
		});
		t.after(() => new Promise<void>((done) => held.close(() => done())));
		const busy = (held.address() as { port: number }).port;
		const before = [sha(r.daemonFile), sha(r.viewerFile)];
		const badUrl = "https://u:p@boards.example.test/?q=1";
		for (const [label, changes, token, status, named] of [
			["the dashboard's port", { "boards.port": r.viewer.port }, undefined, 400,
				new RegExp(`boards\\.port: ${r.viewer.port} is the dashboard port`)],
			["a bad IP", { "boards.host": "example.com" }, undefined, 400, /boards\.host .*must be an IP address/],
			["a bad URL", { "boards.public_url": badUrl }, undefined, 400,
				/boards\.public_url .*no user name, password, query or fragment/],
			["no control token", { "boards.port": 8767 }, null, 403, /control token missing or stale/],
			["a held port", { "boards.port": busy }, undefined, 409,
				new RegExp(`boards\\.port ${busy} on 127\\.0\\.0\\.1 is in use .*\\(EADDRINUSE\\)`)],
		] as Array<[string, Record<string, unknown>, null | undefined, number, RegExp]>) {
			const reply = await r.apply(changes, token);
			assert.equal(reply.status, status, `${label}: ${JSON.stringify(reply.body)}`);
			assert.match([reply.body.error, ...((reply.body.errors as string[] | undefined) ?? [])].join("\n"), named, label);
			assert.deepEqual([sha(r.daemonFile), sha(r.viewerFile)], before, `${label}: nothing written`);
			assert.equal((await call(r.bp, "/boards/board.css")).status, 200, `${label}: the listener stays on its port`);
		}
	});
