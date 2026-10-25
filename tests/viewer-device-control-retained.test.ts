/**
 * Retained (P12c): from tests/viewer-device-control.test.ts, the owner's own stop. cp-view registers no signal handler,
 * so no entry point calls the remote runtime's stop(); a killed viewer leaves its socket for the stale-owner path.
 */
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { deviceControlRecordFile, deviceControlRequest, deviceControlSocket, startDeviceControl } from "../src/viewer/device-control.ts";
import { DeviceStore } from "../src/viewer/device-store.ts";
import { createScratchHome } from "./harness/index.ts";
import { REMOTE_ORIGIN } from "./harness/remote.ts";

test("stop removes only its own socket and record; the client then names the missing record", async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	const store = new DeviceStore(join(home.path, LAYOUT.data), stateDir);
	const routes = { store, binding: () => ({ origin: REMOTE_ORIGIN, generation: 1 }) };
	const first = await startDeviceControl(stateDir, routes, () => {});
	assert.equal(first.state, "listening", JSON.stringify(first));
	const second = await startDeviceControl(stateDir, routes, () => {});
	assert.equal(second.state, "refused");
	assert.ok((await deviceControlRequest(stateDir, "status")).ok, "a refused starter removes nothing");
	(first as Extract<typeof first, { state: "listening" }>).stop();
	assert.throws(() => statSync(deviceControlSocket(stateDir)), /ENOENT/);
	assert.throws(() => statSync(deviceControlRecordFile(stateDir)), /ENOENT/);
	assert.deepEqual(await deviceControlRequest(stateDir, "status"), { ok: false, status: 503, error: `no device control record at ${deviceControlRecordFile(stateDir)}: is the viewer running?` });
});
