import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initPush, normalizeOrigin, PushConfigError, readVapidKeys } from "../src/push/keys.ts";
import { generateVapidKeyPair } from "../src/push/webpush.ts";
import { pushConfigFile, readPushConfig, vapidKeyFile } from "../src/viewer/push-files.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	return { home: home.path, dataDir: join(home.path, LAYOUT.data) };
}

test("normalizeOrigin takes an https origin only", () => {
	assert.equal(normalizeOrigin("https://cp.example.com/"), "https://cp.example.com");
	assert.equal(normalizeOrigin("https://CP.example.com:8443"), "https://cp.example.com:8443");
	for (const bad of ["http://cp.example.com", "https://cp.example.com/path", "https://cp.example.com/?q=1", "https://cp.example.com/#x", "https://u:p@cp.example.com", "cp.example.com"]) {
		assert.throws(() => normalizeOrigin(bad), PushConfigError, bad);
	}
});

test("initPush writes a 0600 key and a public config once, keeps keys on re-run and on a new origin", (t) => {
	const { dataDir } = scratch(t);
	const first = initPush({ dataDir, origin: "https://cp.example.com", now: new Date("2026-09-27T00:00:00Z") });
	assert.deepEqual({ created: first.created, configWritten: first.configWritten, originChanged: first.originChanged }, { created: true, configWritten: true, originChanged: false });
	assert.equal(statSync(vapidKeyFile(dataDir)).mode & 0o777, 0o600);
	const key = readFileSync(vapidKeyFile(dataDir), "utf8");
	const config = JSON.parse(readFileSync(pushConfigFile(dataDir), "utf8"));
	assert.deepEqual(Object.keys(config).sort(), ["created_at", "origin", "public_key", "schema_version", "subject"]);
	assert.equal(config.origin, "https://cp.example.com");
	assert.equal(config.subject, "https://cp.example.com");
	assert.doesNotMatch(JSON.stringify(config), new RegExp(JSON.parse(key).d));

	const again = initPush({ dataDir, origin: "https://cp.example.com/" });
	assert.deepEqual({ created: again.created, configWritten: again.configWritten }, { created: false, configWritten: false });
	assert.equal(readFileSync(vapidKeyFile(dataDir), "utf8"), key, "a re-run leaves the key byte-identical");

	const moved = initPush({ dataDir, origin: "https://other.example.com", subject: "mailto:ops@example.com" });
	assert.deepEqual({ created: moved.created, originChanged: moved.originChanged }, { created: false, originChanged: true });
	assert.equal(readFileSync(vapidKeyFile(dataDir), "utf8"), key);
	const rewritten = JSON.parse(readFileSync(pushConfigFile(dataDir), "utf8"));
	assert.deepEqual([rewritten.origin, rewritten.subject, rewritten.public_key, rewritten.created_at], ["https://other.example.com", "mailto:ops@example.com", config.public_key, config.created_at]);
	assert.throws(() => initPush({ dataDir, origin: "https://cp.example.com", subject: "ops" }), /subject must be/);
});

test("readVapidKeys round-trips, is undefined unconfigured, and refuses a missing, corrupt or mismatched key without quoting it", (t) => {
	const { dataDir } = scratch(t);
	assert.equal(readVapidKeys(dataDir), undefined);
	initPush({ dataDir, origin: "https://cp.example.com" });
	const keys = readVapidKeys(dataDir);
	assert.equal(keys?.origin, "https://cp.example.com");
	assert.equal(keys?.publicKey.toString("base64url"), readPushConfig(dataDir)?.public_key);
	assert.equal(readPushConfig(dataDir) && "d" in readPushConfig(dataDir)!, false);

	const secret = "SECRETSECRETSECRET";
	writeFileSync(vapidKeyFile(dataDir), `{"kty":"EC","crv":"P-256","d":"${secret}"`);
	assert.throws(() => readVapidKeys(dataDir), (error: Error) => error instanceof PushConfigError && !error.message.includes(secret));
	writeFileSync(vapidKeyFile(dataDir), JSON.stringify(generateVapidKeyPair().privateJwk));
	assert.throws(() => readVapidKeys(dataDir), /does not match the public key/);
	writeFileSync(vapidKeyFile(dataDir), JSON.stringify({ kty: "EC", crv: "P-256", d: secret, x: "a", y: "b" }));
	assert.throws(() => readVapidKeys(dataDir), (error: Error) => error instanceof PushConfigError && !error.message.includes(secret));
});

test("npm run push:init configures a home, prints no key material, and refuses http", (t) => {
	const { home, dataDir } = scratch(t);
	const run = (...args: string[]) => spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "push-init.ts"), "--home", home, ...args], { encoding: "utf8" });
	const ok = run("--origin", "https://x.example.com");
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stdout, /^web push configured for https:\/\/x\.example\.com \(keys in .*push, never printed\)\n$/);
	const jwk = JSON.parse(readFileSync(vapidKeyFile(dataDir), "utf8"));
	const publicKey = readPushConfig(dataDir)!.public_key;
	for (const secret of [jwk.d, publicKey, jwk.x]) assert.ok(!`${ok.stdout}${ok.stderr}`.includes(secret));
	assert.match(run("--origin", "https://x.example.com").stdout, /already configured/);
	const refused = run("--origin", "http://x.example.com");
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /must be https:/);
	assert.equal(run().status, 2);
	assert.ok(existsSync(pushConfigFile(dataDir)));
});
