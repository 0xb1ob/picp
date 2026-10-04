import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initPush } from "../src/push/keys.ts";
import { pushFindings } from "../src/push/status.ts";
import { PUSH_RULE } from "../src/push/sweep.ts";
import { pushDeliveriesFile, subscriptionFile, subscriptionId, vapidKeyFile } from "../src/viewer/push-files.ts";
import { createScratchHome } from "./harness/index.ts";
import { testDevice } from "./harness/push.ts";
import { LAYOUT } from "../src/contracts.ts";

const NOW = new Date("2026-09-27T12:00:00Z");
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/secret-device";

function scratch(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	return { home: home.path, stateDir, dataDir: join(home.path, LAYOUT.data) };
}

const record = (extra: Record<string, unknown>) => ({ id: "es-abc123", source: "escalation", kind: "plan_approval", attempts: 1, delivered: 0, created_at: "2026-09-27T11:00:00Z", ...extra });

test("pushFindings says nothing on an unconfigured home, so the doctor golden is unchanged", (t) => {
	const { home } = scratch(t);
	assert.deepEqual(pushFindings(home, NOW), []);
});

test("pushFindings: ok with a device count, warnings for key trouble and recent undelivered pushes, never an endpoint", (t) => {
	const { home, stateDir, dataDir } = scratch(t);
	initPush({ dataDir, origin: "https://cp.example.com" });
	const id = subscriptionId(ENDPOINT);
	mkdirSync(join(dataDir, "push", "subscriptions"), { recursive: true });
	writeFileSync(subscriptionFile(dataDir, id), JSON.stringify({ schema_version: 1, id, endpoint: ENDPOINT, keys: testDevice(ENDPOINT).keys, created_at: "2026-09-27T00:00:00Z" }));
	assert.deepEqual(pushFindings(home, NOW), [
		{ check: "push", severity: "ok", what: "web push for https://cp.example.com: 1 subscribed device(s)" },
		{ check: "push", severity: "ok", what: PUSH_RULE },
	]);
	assert.match(PUSH_RULE, /must act/);
	assert.doesNotMatch(PUSH_RULE, /mandate complete|risk|budget|merge refused/);

	writeFileSync(pushDeliveriesFile(stateDir), JSON.stringify({ schema_version: 1, baseline_at: "2026-09-26T00:00:00Z", items: [
		record({ id: "es-old", status: "failed", settled_at: "2026-09-25T00:00:00Z", last_error: "stale" }),
		record({ id: "es-new", status: "failed", settled_at: "2026-09-27T11:30:00Z", last_error: "abcd1234 rejected: HTTP 403" }),
		record({ id: "es-retry", status: "pending", attempts: 2, next_attempt_at: "2026-09-27T12:01:00Z", last_error: "abcd1234 retry: HTTP 500" }),
		record({ id: "es-sent", status: "sent", delivered: 1, settled_at: "2026-09-27T11:59:00Z" }),
	] }));
	const undelivered = pushFindings(home, NOW).find((finding) => finding.severity === "warn");
	assert.match(undelivered?.what ?? "", /^2 push\(es\) undelivered in the last 24 h \(last: abcd1234 rejected: HTTP 403\)$/);
	assert.match(undelivered?.fix ?? "", /reachable at https:\/\/cp\.example\.com.*at most 5 attempts/);

	writeFileSync(pushDeliveriesFile(stateDir), "{broken");
	assert.ok(pushFindings(home, NOW).some((finding) => /ledger is unreadable/.test(finding.what)));
	rmSync(pushDeliveriesFile(stateDir));

	chmodSync(vapidKeyFile(dataDir), 0o644);
	assert.ok(pushFindings(home, NOW).some((finding) => finding.severity === "warn" && finding.fix === `chmod 600 ${vapidKeyFile(dataDir)}`));
	rmSync(vapidKeyFile(dataDir));
	const missing = pushFindings(home, NOW);
	assert.ok(missing.some((finding) => /signing key is missing/.test(finding.what) && /push:init -- --origin https:\/\/cp\.example\.com/.test(finding.fix ?? "")));
	for (const finding of missing) {
		assert.doesNotMatch(JSON.stringify(finding), /secret-device|tailscale/i);
		if (finding.severity !== "ok") assert.ok(finding.fix, "every warning names its fix");
		assert.ok(finding.what.length <= 200);
	}
});
