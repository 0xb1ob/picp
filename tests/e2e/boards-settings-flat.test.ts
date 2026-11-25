/**
 * Settings → Boards on a flat home (`~/.pi-command-post`, its own runtime root, not `<home>/.pi-command-post`): the
 * session writes `<home>/data/daemon.json` and the viewer reloads that same file. `configureLayout` is process-global,
 * so the flat layout gets this file's process to itself, as the bridge configures it for a flat home.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { configureLayout, LAYOUT } from "../../src/contracts.ts";
import { settingsPorts } from "../../src/settings-control.ts";
import { readControlRecord } from "../../src/viewer/control-files.ts";
import { freePort, operatorSession, startViewer } from "../harness/dashboard.ts";
import { createScratchHome, REPO_ROOT } from "../harness/index.ts";
import { call } from "../harness/remote.ts";

const scratch = createScratchHome({ flat: true });
configureLayout("multi", scratch.path);
process.on("exit", () => scratch.cleanup());

test("BS-flat: on a flat home a save moves the listener to what the session wrote at <home>/data/daemon.json",
	{ timeout: 120_000 }, async (t) => {
		const home = scratch.path;
		const data = join(home, LAYOUT.data), stateDir = join(home, LAYOUT.state);
		assert.equal(data, join(home, "data"), "the flat layout: the home is its own runtime root");
		mkdirSync(data, { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		const viewer = await startViewer(t, { home });
		const file = join(data, "daemon.json");
		const base = {
			schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app: REPO_ROOT, home,
			path: "/usr/bin:/bin", port: viewer.port,
		};
		writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
		await operatorSession(t, stateDir, () => true, settingsPorts({ target: () => ({ home, mode: "multi" }), env: {} }));
		const csrf = (readControlRecord(stateDir) as { record: { csrf: string } }).record.csrf;
		const revision = ((await viewer.get("/api/settings")).body.snapshot as { revision: string }).revision;
		const bp = await freePort();
		const reply = await viewer.get("/api/settings/apply", {
			method: "POST", body: JSON.stringify({ changes: { "boards.port": bp }, request_id: "req-boards-flat" }),
			headers: {
				origin: viewer.origin, "content-type": "application/json", "sec-fetch-site": "same-origin",
				"if-match": `"${revision}"`, "x-cp-control-token": csrf,
			},
		});
		assert.equal(reply.status, 200, JSON.stringify(reply.body));
		const written = JSON.parse(readFileSync(file, "utf8")) as { boards_port?: number };
		assert.equal(written.boards_port, bp, "the session's file");
		const listening = { state: "listening", host: "127.0.0.1", port: bp, index: false };
		assert.deepEqual(reply.body.boards, listening, "the viewer reloaded that same file");
		assert.equal((await call(bp, "/")).status, 404, "the boards listener answers on the saved port");
		assert.equal(existsSync(join(home, ".pi-command-post")), false, "nothing nested under a flat home");
	});
