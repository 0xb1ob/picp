/** cp-er76: the gateway admin key at rest — path, validation, the 0600 rule, and the capacity.json gate. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { layoutForHome } from "../src/contracts.ts";
import { gatewayKeyFile, parentGatewayKey, readGatewayKey, renderGatewayKeyFile, validGatewayKey } from "../src/gateway-key.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-gateway-key-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeKey(file: string, key: string, mode = 0o600): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, renderGatewayKeyFile(key));
	chmodSync(file, mode);
}

test("gatewayKeyFile: XDG_CONFIG_HOME, else HOME/.config, else undefined", () => {
	assert.equal(gatewayKeyFile({ XDG_CONFIG_HOME: "/x", HOME: "/h" }), "/x/pi-command-post/gateway.env");
	assert.equal(gatewayKeyFile({ HOME: "/h" }), "/h/.config/pi-command-post/gateway.env");
	assert.equal(gatewayKeyFile({}), undefined);
});

test("validGatewayKey: printable ASCII without whitespace, quotes or backslash, 1-4096 chars; the reason never quotes the key", () => {
	assert.equal(validGatewayKey("k3y-VALUE_=+/"), undefined);
	for (const bad of ["", "k3y V", "k3y\tV", 'k3y"V', "k3y'V", "k3y\\V", "ключ", "x".repeat(4097)]) {
		const reason = validGatewayKey(bad);
		assert.ok(reason, JSON.stringify(bad));
		if (bad.length > 1) assert.ok(!reason.includes(bad), "never echoes the key");
	}
});

test("readGatewayKey: the rendered key back; a 0644 file is refused naming chmod 600, without the key; absent is neither", (t) => {
	const file = join(scratch(t), "pi-command-post/gateway.env");
	assert.deepEqual(readGatewayKey(file), {});
	writeKey(file, "k3y-VALUE");
	assert.deepEqual(readGatewayKey(file), { key: "k3y-VALUE" });
	chmodSync(file, 0o644);
	const loose = readGatewayKey(file);
	assert.equal(loose.key, undefined);
	assert.match(loose.problem ?? "", /chmod 600/);
	assert.ok(!(loose.problem ?? "").includes("k3y-VALUE"));
	chmodSync(file, 0o600);
	writeFileSync(file, "# nothing\n");
	assert.match(readGatewayKey(file).problem ?? "", /no CP_GATEWAY_ADMIN_KEY= line/);
});

test("parentGatewayKey: only for a home with data/capacity.json", (t) => {
	const dir = scratch(t);
	const home = join(dir, "home");
	const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config") };
	writeKey(gatewayKeyFile(env)!, "k3y-VALUE");
	assert.equal(parentGatewayKey(home, "multi", env), undefined, "no capacity.json: another home keeps quota off");
	const data = join(home, layoutForHome("multi", home).data);
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "capacity.json"), "{}");
	assert.equal(parentGatewayKey(home, "multi", env), "k3y-VALUE");
});
