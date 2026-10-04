/**
 * cp-6fyl PR2: cp-health's record becomes one deduped, withdrawable `service_health` escalation. Synthetic ids only.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT, SERVICE_HEALTH_JOB_ID } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { escalationProjects } from "../src/project-report.ts";
import { SERVICE_ALERT_AFTER_SECONDS, serviceAlerts, syncServiceEscalations } from "../src/service-alerts.ts";
import type { CheckRecord, HealthRecord } from "../src/service/health.ts";
import { createScratchHome } from "./harness/index.ts";

const NOW = new Date("2026-10-02T16:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();
const failing = (key: string, secondsAgo: number): CheckRecord => ({ status: "fail", key, since: ago(secondsAgo), detail: "x", fails: 3, notified_key: null, notified_state: "ok", push_attempts: 0, checked_at: ago(0) });
const record = (checks: HealthRecord["checks"]): HealthRecord => ({ schema_version: 1, last_run_at: ago(0), checks });

test("rollback_failed alerts at once; any other check only after 15 min", () => {
	assert.deepEqual(serviceAlerts(record({ update: failing("rollback_failed:abc123", 0) }), NOW).map((a) => [a.check, a.key]), [["update", "rollback_failed:abc123"]]);
	assert.deepEqual(serviceAlerts(record({ disk: failing("low", SERVICE_ALERT_AFTER_SECONDS - 60) }), NOW), [], "disk failing 14 min: none");
	assert.deepEqual(serviceAlerts(record({ disk: failing("low", SERVICE_ALERT_AFTER_SECONDS) }), NOW).map((a) => a.check), ["disk"], "15 min: one");
	assert.deepEqual(serviceAlerts(record({ disk: { ...failing("low", 3600), status: "ok", key: null } }), NOW), [], "an ok check is no alert");
	assert.deepEqual(serviceAlerts(undefined, NOW), [], "no record, no alert");
});

function bench(t: import("node:test").TestContext) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const store = new EscalationStore({ home: scratch.path });
	return { store, stateDir: join(scratch.path, LAYOUT.state) };
}

test("two syncs make one open escalation; a changed detail is still one; recovery withdraws it", async (t) => {
	const b = bench(t);
	const alerts = serviceAlerts(record({ update: failing("rollback_failed:abc123", 0) }), NOW);
	const first = await syncServiceEscalations(b.store, alerts, b.stateDir);
	assert.equal(first.raised.length, 1);
	assert.deepEqual(await syncServiceEscalations(b.store, alerts, b.stateDir), { raised: [], withdrawn: [] }, "a re-tick never duplicates");
	const again = serviceAlerts(record({ update: { ...failing("rollback_failed:abc123", 0), detail: "a different detail" } }), new Date(NOW.getTime() + 300_000));
	assert.deepEqual(await syncServiceEscalations(b.store, again, b.stateDir), { raised: [], withdrawn: [] }, "live text never mints a second one");
	const [open] = b.store.open();
	assert.equal(b.store.open().length, 1);
	assert.equal(open?.kind, "service_health");
	assert.deepEqual(open?.job_ids, [SERVICE_HEALTH_JOB_ID]);
	assert.equal(open?.recommended, "ack");
	assert.match(open?.question ?? "", /^cp-daemon health check "update" failing since \S+ \(key rollback_failed:abc123\)$/);
	assert.deepEqual(escalationProjects(open!, () => undefined), ["command-post"], "its projects resolve to command-post");
	assert.deepEqual(await syncServiceEscalations(b.store, [], b.stateDir), { raised: [], withdrawn: [first.raised[0]!] });
	assert.equal(b.store.open().length, 0);
	assert.equal(b.store.get(first.raised[0]!)?.status, "withdrawn");
});

test("an acknowledged alert is not raised again for the same failure; a new key is a new alert", async (t) => {
	const b = bench(t);
	const alerts = serviceAlerts(record({ update: failing("rollback_failed:abc123", 0) }), NOW);
	const { raised } = await syncServiceEscalations(b.store, alerts, b.stateDir);
	await b.store.answer(raised[0]!, { answer: "ack", by: "operator" });
	assert.deepEqual(await syncServiceEscalations(b.store, alerts, b.stateDir), { raised: [], withdrawn: [] }, "answered: left alone");
	const next = serviceAlerts(record({ update: failing("rollback_failed:def456", 0) }), NOW);
	assert.equal((await syncServiceEscalations(b.store, next, b.stateDir)).raised.length, 1, "a new failure key raises a new one");
});
