import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { EscalationStore, type RaiseEscalationInput, raiseMissionEnd } from "../src/escalation.ts";
import { OperatorAsks } from "../src/operator-asks.ts";
import { PushDeliveryStore } from "../src/push/deliveries.ts";
import { initPush } from "../src/push/keys.ts";
import { PUSH_RULE, runPushSweep } from "../src/push/sweep.ts";
import type { PushFetch, PushRequestInit } from "../src/push/webpush.ts";
import type { ViewerState } from "../src/viewer/sessions.ts";
import { decisions } from "../src/viewer/overview-decisions.ts";
import { pushDeliveriesFile, subscriptionFile, subscriptionId } from "../src/viewer/push-files.ts";
import { createScratchHome } from "./harness/index.ts";
import { type TestDevice, testDevice } from "./harness/push.ts";
import { LAYOUT } from "../src/contracts.ts";

const OPTIONS = [
	{ id: "approve", label: "Approve", consequence: "go", cost: "none" },
	{ id: "decline", label: "Decline", consequence: "stop", cost: "none" },
];
const raiseInput = (question: string, extra: Partial<RaiseEscalationInput> = {}): RaiseEscalationInput => ({
	job_ids: ["cp-demo1"],
	kind: "plan_approval",
	question,
	options: OPTIONS,
	recommended: "approve",
	...extra,
});

function bench(t: import("node:test").TestContext, configured = true) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const stateDir = join(home, LAYOUT.state);
	const dataDir = join(home, LAYOUT.data);
	mkdirSync(stateDir, { recursive: true });
	if (configured) initPush({ dataDir, origin: "https://cp.example.com" });
	const escalations = new EscalationStore({ home });
	const awaiting = new AwaitingStore({ home });
	const asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl"));
	const finalFix = new CheckpointStore(home, { kind: "final_fix" });
	let clock = new Date("2026-09-27T00:00:00Z");
	const calls: Array<{ url: string; init: PushRequestInit }> = [];
	let respond: (url: string) => number | Error = () => 201;
	const fetch: PushFetch = async (url, init) => {
		calls.push({ url, init });
		const answer = respond(url);
		if (answer instanceof Error) throw answer;
		return { status: answer, text: async () => "" };
	};
	const lines: string[] = [];
	const devices: TestDevice[] = [];
	const subscribe = (endpoint: string): TestDevice => {
		const device = testDevice(endpoint);
		const id = subscriptionId(endpoint);
		mkdirSync(join(dataDir, "push", "subscriptions"), { recursive: true });
		writeFileSync(subscriptionFile(dataDir, id), JSON.stringify({ schema_version: 1, id, endpoint, keys: device.keys, created_at: "2026-09-27T00:00:00Z" }));
		devices.push(device);
		return device;
	};
	const sweep = () =>
		runPushSweep({
			stateDir,
			openEscalations: () => escalations.open(),
			openAwaiting: () => awaiting.list("open"),
			pendingFinalFix: () => finalFix.listPending(),
			projectsOf: () => ["demo"],
			fetch,
			now: () => clock,
			log: (line) => lines.push(line),
		});
	const advance = (seconds: number) => {
		clock = new Date(clock.getTime() + seconds * 1000);
	};
	const ledger = () => new PushDeliveryStore(stateDir).read();
	/** Decrypted payloads, one per call, for a bench with one subscribed device. */
	const payloads = (): unknown[] => calls.map((call) => JSON.parse(devices[0]!.decrypt(Buffer.from(call.init.body))));
	return { home, stateDir, dataDir, escalations, awaiting, asks, finalFix, calls, lines, devices, subscribe, sweep, advance, ledger, payloads, respondWith: (fn: typeof respond) => (respond = fn) };
}

const FCM = "https://fcm.googleapis.com/fcm/send/device-a";
const MOZ = "https://updates.push.services.mozilla.com/wpush/v2/device-b";

test("unconfigured: no ledger, no fetch", async (t) => {
	const b = bench(t, false);
	b.subscribe(FCM);
	await b.escalations.raise(raiseInput("Approve the plan?"));
	const report = await b.sweep();
	assert.equal(report.configured, false);
	assert.equal(existsSync(pushDeliveriesFile(b.stateDir)), false);
	assert.equal(b.calls.length, 0);
});

test("first sweep baselines what is open; a new human-only escalation is pushed once per device, encrypted, and never again", async (t) => {
	const b = bench(t);
	const [a, m] = [b.subscribe(FCM), b.subscribe(MOZ)];
	const risky = { kind: "service_health" as const };
	const before = await b.escalations.raise(raiseInput("Approve the old plan?", risky));
	const baseline = await b.sweep();
	assert.equal(baseline.baseline, 1);
	assert.equal(b.calls.length, 0);
	assert.deepEqual(b.ledger()?.items.map((item) => [item.id, item.status, item.last_error]), [[before.id, "skipped", "open before push was enabled"]]);

	const long = `Approve   the\nnew plan at $1.20 ${"x".repeat(200)}?`;
	const raised = await b.escalations.raise(raiseInput(long, { ...risky, mandate_id: "md-abc123", evidence_paths: ["state/artifacts/secret.md"] }));
	const report = await b.sweep();
	assert.equal(report.sent, 1);
	assert.equal(b.calls.length, 2);
	assert.deepEqual(b.calls.map((call) => call.url).sort(), [FCM, MOZ].sort());
	for (const call of b.calls) {
		assert.equal(call.init.headers["Content-Encoding"], "aes128gcm");
		assert.match(call.init.headers.Authorization ?? "", /^vapid t=.+, k=.+$/);
		const device = call.url === FCM ? a : m;
		const payload = JSON.parse(device.decrypt(Buffer.from(call.init.body)));
		assert.deepEqual(Object.keys(payload), ["project", "kind", "headline"]);
		assert.equal(payload.project, "demo");
		assert.equal(payload.kind, "decision needed: service health");
		assert.equal(payload.headline.length, 100);
		assert.match(payload.headline, /^Approve the new plan at \$1\.20 x+…$/);
	}
	assert.deepEqual(b.ledger()?.items.find((item) => item.id === raised.id), {
		id: raised.id, source: "escalation", kind: "service_health", status: "sent", attempts: 1, delivered: 2, created_at: "2026-09-27T00:00:00Z", settled_at: "2026-09-27T00:00:00Z",
	});
	assert.doesNotMatch(readFileSync(pushDeliveriesFile(b.stateDir), "utf8"), /Approve|secret\.md|fcm\.googleapis/);

	// Later sweeps and a refreshed raise (same id, new numbers) send nothing.
	b.advance(60);
	const inode = statSync(pushDeliveriesFile(b.stateDir)).ino;
	await b.sweep();
	assert.equal(statSync(pushDeliveriesFile(b.stateDir)).ino, inode, "an idle sweep writes nothing");
	const refreshed = await b.escalations.raise(raiseInput(long.replace("1.20", "3.45"), { ...risky, mandate_id: "md-abc123" }));
	assert.equal(refreshed.id, raised.id);
	await b.sweep();
	assert.equal(b.calls.length, 2);
	assert.deepEqual(b.lines, []);
});

test("open merge asks still push; wakes, delegated kinds, deferred and merge-pending rows do not", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep(); // baseline, empty
	await b.escalations.raise(raiseInput("Which colour?", { kind: "product_ambiguity" }));
	await b.escalations.raise(raiseInput("Conflict?", { kind: "conflicting_acceptance" }));
	await b.awaiting.declareGated({ type: "approval", subject: "merge-pending pr https://github.com/o/r/pull/9", decision: "merge pending: repo refuses", why: "w", blocks: "b", job_id: "cp-demo1" });
	const deferring = new AwaitingStore({ home: b.home, mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI running" }) });
	await deferring.declareGated({ type: "approval", decision: "Merge PR #13 for cp-demo2?", why: "w", blocks: "b", job_id: "cp-demo2" });
	await b.awaiting.declareGated({ type: "approval", decision: "Which base branch?", why: "w", blocks: "b", job_id: "cp-demo3" });
	await b.sweep();
	assert.equal(b.calls.length, 0);

	const ask = await b.awaiting.declare({ type: "approval", decision: "Merge PR #12 for cp-demo1?", why: "w", blocks: "b", job_id: "cp-demo1" });
	await b.sweep();
	await b.sweep();
	assert.equal(b.calls.length, 1);
	const payload = JSON.parse(b.devices[0]!.decrypt(Buffer.from(b.calls[0]!.init.body)));
	assert.deepEqual(payload, { project: "demo", kind: "decision needed: merge ask", headline: "Merge PR #12 for cp-demo1?" });
	assert.equal(b.ledger()?.items.find((item) => item.id === ask.id)?.source, "merge_ask");
});

test("retryable failures back off 30/60/120/240 s and fail after 5 attempts, one log line each", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const raised = await b.escalations.raise(raiseInput("Down?", { kind: "service_health" }));
	const outcomes: Array<number | Error> = [500, 429, new TypeError("fetch failed"), 503, 500];
	b.respondWith(() => outcomes.shift() ?? 201);
	const record = () => b.ledger()?.items.find((item) => item.id === raised.id);
	await b.sweep();
	for (const wait of [30, 60, 120, 240]) {
		assert.equal(record()?.status, "pending");
		b.advance(wait - 1);
		const calls = b.calls.length;
		await b.sweep();
		assert.equal(b.calls.length, calls, `not before ${wait}s`);
		b.advance(1);
		await b.sweep();
	}
	assert.equal(b.calls.length, 5);
	assert.equal(record()?.status, "failed");
	assert.equal(record()?.attempts, 5);
	assert.match(record()?.last_error ?? "", /retry: HTTP 500/);
	assert.equal(b.lines.length, 5);
	for (const line of b.lines) {
		assert.match(line, new RegExp(`^push ${raised.id} → ${subscriptionId(FCM).slice(0, 8)}: retry \\(`));
		assert.doesNotMatch(line, /fcm\.googleapis|device-a/);
	}
	b.advance(3600);
	await b.sweep();
	assert.equal(b.calls.length, 5);
});

test("answered before the next attempt is skipped without a fetch", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const raised = await b.escalations.raise(raiseInput("Down?", { kind: "service_health" }));
	b.respondWith(() => 500);
	await b.sweep();
	await b.escalations.answer(raised.id, { answer: "approve", by: "operator" });
	b.advance(30);
	await b.sweep();
	assert.equal(b.calls.length, 1);
	const record = b.ledger()?.items.find((item) => item.id === raised.id);
	assert.deepEqual([record?.status, record?.last_error], ["skipped", "no longer open before delivery"]);
});

test("404 and 410 delete the subscription; 403 fails without retry; an off-allowlist endpoint is never fetched", async (t) => {
	const b = bench(t);
	b.subscribe("https://fcm.googleapis.com/fcm/send/gone-404");
	b.subscribe("https://fcm.googleapis.com/fcm/send/gone-410");
	b.subscribe("https://fcm.googleapis.com/fcm/send/forbidden");
	b.subscribe("https://evil.example/push/steal");
	await b.sweep();
	b.respondWith((url) => (url.endsWith("404") ? 404 : url.endsWith("410") ? 410 : 403));
	const raised = await b.escalations.raise(raiseInput("Risky?", { kind: "service_health" }));
	await b.sweep();
	assert.deepEqual(b.calls.map((call) => call.url.split("/").pop()).sort(), ["forbidden", "gone-404", "gone-410"]);
	for (const url of ["https://fcm.googleapis.com/fcm/send/gone-404", "https://fcm.googleapis.com/fcm/send/gone-410"]) {
		assert.equal(existsSync(subscriptionFile(b.dataDir, subscriptionId(url))), false);
	}
	assert.equal(existsSync(subscriptionFile(b.dataDir, subscriptionId("https://evil.example/push/steal"))), true);
	const record = b.ledger()?.items.find((item) => item.id === raised.id);
	assert.equal(record?.status, "failed");
	assert.equal(record?.attempts, 1);
	assert.match(record?.last_error ?? "", /rejected: endpoint is not on the push-service allowlist/);
	assert.match(record?.last_error ?? "", /rejected: HTTP 403/);
	assert.equal(b.lines.length, 4);
	b.advance(3600);
	await b.sweep();
	assert.equal(b.calls.length, 3);
});

test("with no subscribed device a new item is skipped, so a later subscriber gets no backlog", async (t) => {
	const b = bench(t);
	await b.sweep();
	const raised = await b.escalations.raise(raiseInput("Down?", { kind: "service_health" }));
	await b.sweep();
	b.subscribe(FCM);
	await b.sweep();
	assert.equal(b.calls.length, 0);
	const record = b.ledger()?.items.find((item) => item.id === raised.id);
	assert.deepEqual([record?.status, record?.last_error], ["skipped", "no subscribed device"]);
});

test("a corrupt escalations file is reported and changes nothing", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const before = readFileSync(pushDeliveriesFile(b.stateDir), "utf8");
	writeFileSync(join(b.stateDir, "escalations.json"), "{not json");
	const report = await b.sweep();
	assert.match(report.error ?? "", /cannot read the ask records/);
	assert.equal(readFileSync(pushDeliveriesFile(b.stateDir), "utf8"), before);
	assert.equal(b.calls.length, 0);
	assert.equal(b.lines.length, 1);
});

const ASK = { project: "alpha", options: [{ label: "Approve", consequence: "go" }], recommendation: "Approve" };

test("a mission end never pushes, answered or not, and nothing in the ledger names the mandate", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const first = await raiseMissionEnd(b.escalations, { jobIds: ["cp-demo1"], mandateId: "md-abc123", summary: "landed 2, dropped 1, cost $1.50" });
	await b.sweep();
	await b.escalations.answer(first.id, { answer: "extend", by: "operator-delegated" });
	await raiseMissionEnd(b.escalations, { jobIds: ["cp-demo1", "cp-demo2"], mandateId: "md-abc123", summary: "landed 3, dropped 1, cost $2.00" });
	await b.sweep();
	assert.equal(b.calls.length, 0);
	assert.deepEqual(b.ledger()?.items, []);
});

test("a delegated-decidable plan approval pushes only through an operator ask, once", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const plan = await b.escalations.raise(raiseInput("Approve the plan?"));
	await b.sweep();
	assert.equal(b.calls.length, 0);
	const ask = b.asks.open({ ...ASK, question: "Approve the plan for cp-demo1?", source_escalation: plan.id });
	await b.sweep();
	await b.sweep();
	assert.deepEqual(b.payloads(), [{ project: "alpha", kind: "decision needed", headline: "Approve the plan for cp-demo1?" }]);
	assert.equal(b.ledger()?.items.find((item) => item.id === ask.id)?.source, "ask");
});

test("risk:high never pushes on its own; the ask the main session opens for it pushes once", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const risk = await b.escalations.raise(raiseInput("Risky?", { kind: "risk_high_irreversible" }));
	await b.sweep();
	assert.equal(b.calls.length, 0);
	const ask = b.asks.open({ ...ASK, question: "Accept the risk?", source_escalation: risk.id });
	await b.sweep();
	await b.sweep();
	assert.deepEqual(b.payloads(), [{ project: "alpha", kind: "decision needed", headline: "Accept the risk?" }]);
	assert.equal(b.ledger()?.items.find((item) => item.id === ask.id)?.source, "ask");
});

test("budget and merge refused never push; every push that does lands on a destination only the operator can act on", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	// Open, delegable (the main session decides them, or opens an ask): none of these pushes.
	const delegated = [
		await b.escalations.raise(raiseInput("Budget?", { kind: "budget_exhausted" })),
		await b.escalations.raise(raiseInput("Merge refused?", { kind: "merge_refused" })),
		await b.escalations.raise(raiseInput("Risky?", { kind: "risk_high_irreversible" })),
		await raiseMissionEnd(b.escalations, { jobIds: ["cp-demo1"], mandateId: "md-abc123", summary: "landed 1, dropped 0, cost $1.00" }),
	];
	// Operator-only: an ask card, a final fix (operator quote), a merge ask, and the no-session downtime alert.
	const ask = b.asks.open({ ...ASK, question: "Which base?" });
	b.finalFix.request({ jobId: "cp-demo1", scope: "abcdef123456", prUrl: "https://github.com/o/r/pull/1", question: "One final fix?", evidence: [] });
	const merge = await b.awaiting.declare({ type: "approval", decision: "Merge PR #12 for cp-demo1?", why: "w", blocks: "b", job_id: "cp-demo1" });
	const down = await b.escalations.raise(raiseInput("Down?", { kind: "service_health", job_ids: ["cp-service-health"] }));
	await b.sweep();
	assert.equal(b.calls.length, 4);
	const pushed = b.ledger()?.items ?? [];
	assert.equal(pushed.some((item) => delegated.some((raised) => raised.id === item.id)), false);
	const dashboard = decisions({ stateDir: b.stateDir } as ViewerState, Date.now());
	const destination: Record<string, boolean> = {
		ask: dashboard.awaiting.items.some((item) => item.id === ask.id),
		merge_ask: b.awaiting.list("open").some((item) => item.id === merge.id),
		checkpoint: b.finalFix.listPending().some((item) => item.job_id === "cp-demo1"),
		escalation: dashboard.parent_questions.some((item) => item.id === down.id),
	};
	assert.deepEqual(pushed.map((item) => item.source).sort(), Object.keys(destination).sort());
	assert.deepEqual(Object.values(destination), [true, true, true, true]);
});

test("an answered or withdrawn operator ask does not push", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	const answered = b.asks.open({ ...ASK, question: "Answered?" });
	const withdrawn = b.asks.open({ ...ASK, question: "Withdrawn?" });
	b.asks.answer(answered.id, "Approve");
	b.asks.withdraw(withdrawn.id, "no longer needed");
	await b.sweep();
	assert.equal(b.calls.length, 0);
});

test("a pending final fix pushes as a decision needed", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep();
	b.finalFix.request({ jobId: "cp-demo1", scope: "abcdef123456", prUrl: "https://github.com/o/r/pull/1", question: "One final fix?", evidence: [] });
	await b.sweep();
	assert.deepEqual(b.payloads(), [{ project: "demo", kind: "decision needed: final fix", headline: "one final fix for cp-demo1 at capped head abcdef123456? (operator text only)" }]);
});

test("a ledger from before the rule change baselines what its sources hold now; nothing is replayed", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	writeFileSync(pushDeliveriesFile(b.stateDir), JSON.stringify({ schema_version: 1, baseline_at: "2026-09-26T00:00:00Z", items: [] }));
	const old = b.asks.open({ ...ASK, question: "Old ask?" });
	await raiseMissionEnd(b.escalations, { jobIds: ["cp-demo1"], mandateId: "md-old123", summary: "landed 1, dropped 0, cost $0.10" });
	await b.sweep();
	assert.equal(b.calls.length, 0);
	assert.equal(b.ledger()?.items.find((item) => item.id === old.id)?.last_error, "open before the push rule changed");
	b.asks.open({ ...ASK, question: "New ask?" });
	await b.sweep();
	assert.equal(b.calls.length, 1);
});

test("PUSH_RULE names the watchdog's pushes (cp-daemon P3), which never go through this sweep's ledger", () => {
	assert.match(PUSH_RULE, /; health \(cp-health, once per failure\/recovery\)$/);
	assert.ok(PUSH_RULE.length <= 200, "one /doctor line");
	assert.doesNotMatch(readFileSync(new URL("../src/service/health.ts", import.meta.url), "utf8"), /PushDeliveryStore|pushDeliveriesFile|subscriptionFile|rmSync|unlinkSync/, "the watchdog neither writes the ledger nor deletes a subscription");
});

test("an open service_health escalation is pushed once as a decision needed", async (t) => {
	const b = bench(t);
	b.subscribe(FCM);
	await b.sweep(); // the first sweep baselines
	const raised = await b.escalations.raise(raiseInput("cp-daemon health check \"update\" failing since 2026-09-27T00:00:00Z (key rollback_failed:abc)", { kind: "service_health", job_ids: ["cp-service-health"], recommended: "ack", options: [{ id: "ack", label: "Acknowledged", consequence: "closes", cost: "none" }] }));
	await b.sweep();
	await b.sweep();
	assert.equal(b.calls.length, 1, "once, however often it sweeps");
	assert.equal(b.ledger()?.items.find((item) => item.id === raised.id)?.source, "escalation");
	assert.equal((b.payloads()[0] as { kind: string }).kind, "decision needed: service health");
});
