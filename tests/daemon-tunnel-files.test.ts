/**
 * Remote dashboard PR 2: the node-only tunnel layout the daemon inner, the pairing-alert sender and the push sweep
 * share — the remote-feature switch and the fail-closed origin binding.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { readTunnelBinding, remoteFeatureConfigured, tunnelConfigFile, tunnelRuntimeFile } from "../src/service/daemon-tunnel-files.ts";
import { devicesFile } from "../src/viewer/device-files.ts";
import { createScratchHome } from "./harness/index.ts";

function scratch(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const dataDir = join(home.path, LAYOUT.data), stateDir = join(home.path, LAYOUT.state);
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	return { dataDir, stateDir };
}

test("the remote feature is on with paired devices (alerts outlive down) or a tunnel config, and off on a plain home", (t) => {
	const { dataDir } = scratch(t);
	assert.equal(remoteFeatureConfigured(dataDir), false);
	writeFileSync(tunnelConfigFile(dataDir), "{}");
	assert.equal(remoteFeatureConfigured(dataDir), true);
	rmSync(tunnelConfigFile(dataDir));
	writeFileSync(devicesFile(dataDir), "{}");
	assert.equal(remoteFeatureConfigured(dataDir), true, "the same devices.json the viewer's store writes");
});

test("the binding: none published is null, the last published origin and generation whatever the state, anything malformed refused", (t) => {
	const { stateDir } = scratch(t);
	assert.deepEqual(readTunnelBinding(stateDir), { ok: true, binding: null });
	const write = (value: unknown) => writeFileSync(tunnelRuntimeFile(stateDir), typeof value === "string" ? value : JSON.stringify(value));
	write({ schema_version: 1, generation: 3, origin: "https://abc.trycloudflare.com", state: "stopped" });
	assert.deepEqual(readTunnelBinding(stateDir), { ok: true, binding: { origin: "https://abc.trycloudflare.com", generation: 3 } });
	write({ schema_version: 1, generation: 0, origin: null });
	assert.deepEqual(readTunnelBinding(stateDir), { ok: true, binding: null }, "starting, no origin yet");
	for (const bad of ["{torn", { schema_version: 2, generation: 1, origin: null }, { schema_version: 1, generation: -1, origin: null }, { schema_version: 1, generation: 1.5, origin: null }, { schema_version: 1, generation: 1, origin: "http://abc.trycloudflare.com" }, { schema_version: 1, generation: 1 }, []]) {
		write(bad);
		assert.equal(readTunnelBinding(stateDir).ok, false, JSON.stringify(bad));
	}
});
