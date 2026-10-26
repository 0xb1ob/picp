/**
 * Behavior 22 (P22): Web Push end to end. A real pi parent with this package's command-post extension holds the
 * parent lock and runs the push sweep on its own timer; `bin/cp-view` serves the push routes; `npm run push:init`
 * configures a home. The push service is a stand-in behind tests/harness/fake-fetch.ts; devices decrypt what it got.
 */
import assert from "node:assert/strict";
import { createServer as httpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CheckpointStore } from "../../src/checkpoint.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { EscalationStore, type RaiseEscalationInput, raiseMissionEnd } from "../../src/escalation.ts";
import { OperatorAsks } from "../../src/operator-asks.ts";
import { acquireParentLock } from "../../src/parent-lock.ts";
import { initPush } from "../../src/push/keys.ts";
import { PUSH_RULE } from "../../src/push/sweep.ts";
import { tunnelRuntimeFile } from "../../src/service/daemon-tunnel-files.ts";
import { devicesFile } from "../../src/viewer/device-files.ts";
import { DeviceStore } from "../../src/viewer/device-store.ts";
import { pushDeliveriesFile, subscriptionFile, subscriptionId, vapidKeyFile } from "../../src/viewer/push-files.ts";
import { createAgentDir, createScratchHome, type PiChild, REPO_ROOT, startPiChild } from "../harness/index.ts";
import { startViewer } from "../harness/dashboard.ts";
import { type TestDevice, testDevice } from "../harness/push.ts";

const ORIGIN = "https://cp.example.com";
const FCM = "https://fcm.googleapis.com/fcm/send/device-a";
const MOZ = "https://updates.push.services.mozilla.com/wpush/v2/device-b";
const TUNNEL = "https://cp.example.test";
const HOOKS = ["time-scale.ts", "process-clock.ts", "fake-fetch.ts"].map((file) => `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness", file)).href}`).join(" ");
/** The parent's clock and timers run this much faster, so its 15 s push tick fires every second. */
const SCALE = 15;
const ASK = { project: "alpha", options: [{ label: "Approve", consequence: "go" }], recommendation: "Approve" };
const OPTIONS = [{ id: "approve", label: "Approve", consequence: "go", cost: "none" }, { id: "decline", label: "Decline", consequence: "stop", cost: "none" }];
const HEALTH = "cp-daemon health check \"update\" failing since 2026-09-27T00:00:00Z (key rollback_failed:abc)";
type Item = { id: string; source: string; kind: string; status: string; attempts: number; delivered: number; last_error?: string; next_attempt_at?: string; settled_at?: string; created_at: string; accepted?: Array<{ subscription: string; at: string }> };
type Post = { host: string; slug: string; headers: IncomingHttpHeaders; body: Buffer; at: number };
type Finding = { check: string; severity: string; what: string; detail?: string; fix?: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 60_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${JSON.stringify(last)}`);
}

/** A scratch home, a stand-in push service and (after `start`) a real parent whose clock `advance` moves. */
async function rig(t: TestContext, { configured = true, scale = SCALE } = {}) {
	const scratch = createScratchHome();
	const home = scratch.path, stateDir = join(home, LAYOUT.state), dataDir = join(home, LAYOUT.data);
	mkdirSync(stateDir, { recursive: true });
	const clock = join(home, "clock-offset-ms"), zero = Date.now();
	writeFileSync(clock, "0");
	const parentNow = () => zero + (Date.now() - zero) * scale + Number(readFileSync(clock, "utf8"));
	const posts: Post[] = [];
	let answer: (slug: string) => number = () => 201;
	const service = httpServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const [, host = "", ...rest] = String(req.url).split("/");
			const code = answer(rest.at(-1)!);
			posts.push({ host, slug: rest.at(-1)!, headers: req.headers, body: Buffer.concat(chunks), at: parentNow() });
			res.writeHead(code).end(code === 599 ? "fetch failed" : "");
		});
	});
	await new Promise<void>((done) => service.listen(0, "127.0.0.1", done));
	const agent = createAgentDir();
	let child: PiChild | undefined;
	t.after(async () => {
		await child?.close();
		service.close();
		agent.cleanup();
		scratch.cleanup();
	});
	if (configured) initPush({ dataDir, origin: ORIGIN });
	const asks = new OperatorAsks(join(stateDir, "operator", "asks.jsonl"));
	const devices = new Map<string, TestDevice>();
	const ledger = (): { items: Item[] } | undefined => {
		try {
			return JSON.parse(readFileSync(pushDeliveriesFile(stateDir), "utf8"));
		} catch {
			return undefined;
		}
	};
	return {
		home, stateDir, dataDir, posts, asks, ledger,
		answer: (fn: typeof answer) => (answer = fn),
		advance: (seconds: number) => writeFileSync(clock, String(Number(readFileSync(clock, "utf8")) + seconds * 1000)),
		/** A stored subscription file as the viewer writes one; written directly, so an off-allowlist one can exist too. */
		subscribe: (endpoint: string, owner?: { device_id: string; origin: string }) => {
			const device = testDevice(endpoint), id = subscriptionId(endpoint);
			devices.set(endpoint.split("/").pop()!, device);
			mkdirSync(join(dataDir, "push", "subscriptions"), { recursive: true });
			writeFileSync(subscriptionFile(dataDir, id), JSON.stringify({ schema_version: 1, id, endpoint, keys: device.keys, created_at: "2026-09-27T00:00:00Z", ...owner }));
			return device;
		},
		start: async () => {
			child = startPiChild({
				cwd: home,
				extensions: [join(REPO_ROOT, "extensions/command-post/index.ts")],
				env: {
					...agent.env, CP_HOME: home, CP_MODE: "multi", HOME: join(home, "user"), NODE_OPTIONS: HOOKS, CP_TEST_CLOCK_FILE: clock,
					CP_TEST_TIME_SCALE: String(scale), CP_TEST_TIME_ZERO: String(zero), CP_TEST_FETCH_BASE: `http://127.0.0.1:${(service.address() as AddressInfo).port}`,
				},
			});
			return child;
		},
		stderr: () => child?.stderr() ?? "",
		notes: () => (child?.records() ?? []).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message)),
		/** `/doctor --json`'s push findings, as the operator's session gets them. */
		doctor: async () => {
			const from = child!.records().length;
			child!.send({ id: `d${from}`, type: "prompt", message: "/doctor --json" });
			const hit = await child!.waitFor((r) => child!.records().indexOf(r) >= from && r.type === "extension_ui_request" && r.method === "notify" && String(r.message).trimStart().startsWith("{"), 120_000);
			return (JSON.parse(String(hit.message)) as { findings: Finding[] }).findings.filter((finding) => finding.check === "push");
		},
		item: (id: string) => ledger()?.items.find((item) => item.id === id),
		/** Waits for `id`'s record to satisfy `ok`: the parent's sweep has run over it. */
		settled: (id: string, ok: (item: Item) => boolean = (item) => item.status !== "pending", what = id) =>
			until(() => ledger()?.items.find((item) => item.id === id), (item) => item !== undefined && ok(item), what) as Promise<Item>,
		/** Decrypted payloads since the last call, as [slug, payload]. */
		sent: () => posts.splice(0).map((post) => [post.slug, JSON.parse(devices.get(post.slug)!.decrypt(post.body))] as const),
	};
}

test("P22-push-send: the parent's first sweep baselines open asks; a new ask is pushed once per device, encrypted", async (t) => {
	const s = await rig(t);
	s.subscribe(FCM);
	s.subscribe(MOZ);
	const before = s.asks.open({ ...ASK, question: "Approve the old plan?" });
	await s.start();
	const baseline = await s.settled(before.id);
	assert.deepEqual([baseline.status, baseline.last_error], ["skipped", "open before push was enabled"]);
	const long = `Approve   the\nnew plan at $1.20 ${"x".repeat(200)}?`;
	const raised = s.asks.open({ ...ASK, question: long, job_ids: ["cp-demo1"] });
	const sent = await s.settled(raised.id);
	assert.equal(s.posts.length, 2, `${JSON.stringify(sent)}\n${s.stderr()}`);
	for (const post of s.posts) {
		assert.equal(post.headers["content-encoding"], "aes128gcm");
		assert.match(String(post.headers.authorization), /^vapid t=.+, k=.+$/);
	}
	const payloads = s.sent();
	assert.deepEqual(payloads.map(([slug]) => slug).sort(), ["device-a", "device-b"]);
	for (const [, payload] of payloads) {
		assert.deepEqual(Object.keys(payload), ["project", "kind", "headline"]);
		assert.deepEqual([payload.project, payload.kind, payload.headline.length], ["alpha", "decision needed", 100]);
		assert.match(payload.headline, /^Approve the new plan at \$1\.20 x+…$/);
	}
	assert.deepEqual([sent.status, sent.source, sent.kind, sent.attempts, sent.delivered], ["sent", "ask", "operator_ask", 1, 2]);
	assert.deepEqual(sent.accepted?.map((row) => row.subscription), [FCM, MOZ].map(subscriptionId).sort());
	assert.doesNotMatch(readFileSync(pushDeliveriesFile(s.stateDir), "utf8"), /Approve|alpha|fcm\.googleapis/);
});

test("P22-push-only-asks: escalations, wakes, merge rows, final fixes and closed asks never push; the ask card for each does", async (t) => {
	const s = await rig(t);
	s.subscribe(FCM);
	const baseline = s.asks.open({ ...ASK, question: "Baseline?" });
	await s.start();
	await s.settled(baseline.id);
	const escalations = new EscalationStore({ home: s.home });
	const awaiting = new AwaitingStore({ home: s.home });
	const raise = (question: string, kind: string, extra: Partial<RaiseEscalationInput> = {}) =>
		escalations.raise({ job_ids: ["cp-demo1"], kind: kind as RaiseEscalationInput["kind"], question, options: OPTIONS, recommended: "approve", ...extra });
	const plan = await raise("Approve the plan?", "plan_approval");
	const risk = await raise("Risky?", "risk_high_irreversible");
	for (const [question, kind] of [["Which colour?", "product_ambiguity"], ["Conflict?", "conflicting_acceptance"], ["Budget?", "budget_exhausted"], ["Merge refused?", "merge_refused"]]) await raise(question!, kind!);
	const health = () => raise(HEALTH, "service_health", { job_ids: ["cp-service-health"], recommended: "ack", options: [{ id: "ack", label: "Acknowledged", consequence: "closes", cost: "none" }] });
	const down = await health();
	assert.equal((await health()).id, down.id, "a re-tick refreshes the same record");
	const ended = await raiseMissionEnd(escalations, { jobIds: ["cp-demo1"], mandateId: "md-abc123", summary: "landed 2, dropped 1, cost $1.50" });
	await escalations.answer(ended.id, { answer: "extend", by: "operator-delegated" });
	await raiseMissionEnd(escalations, { jobIds: ["cp-demo1", "cp-demo2"], mandateId: "md-abc123", summary: "landed 3, dropped 1, cost $2.00" });
	await awaiting.declareGated({ type: "approval", subject: "merge-pending pr https://github.com/o/r/pull/9", decision: "merge pending: repo refuses", why: "w", blocks: "b", job_id: "cp-demo1" });
	await awaiting.declareGated({ type: "approval", decision: "Which base branch?", why: "w", blocks: "b", job_id: "cp-demo3" });
	const deferring = new AwaitingStore({ home: s.home, mergeAsk: async () => ({ action: "defer", ci: "in_progress", reason: "CI running" }) });
	await deferring.declareGated({ type: "approval", decision: "Merge PR #13 for cp-demo2?", why: "w", blocks: "b", job_id: "cp-demo2" });
	await awaiting.declare({ type: "approval", decision: "Merge PR #12 for cp-demo1?", why: "w", blocks: "b", job_id: "cp-demo1" });
	new CheckpointStore(s.home, { kind: "final_fix" }).request({ jobId: "cp-demo3", scope: "abcdef123456", prUrl: "https://github.com/o/r/pull/3", question: "One final fix?", evidence: [] });
	const answered = s.asks.open({ ...ASK, question: "Answered?" });
	const withdrawn = s.asks.open({ ...ASK, question: "Withdrawn?" });
	s.asks.answer(answered.id, "Approve");
	s.asks.withdraw(withdrawn.id, "no longer needed");
	const viewer = await startViewer(t, { home: s.home });
	const open = (await viewer.get("/api/awaiting")).body as { items: Array<{ id: string }>; parent_questions: Array<{ id: string }> };
	assert.deepEqual(open.items.map((item) => item.id), [baseline.id], "Awaiting you holds only the open ask card");
	assert.ok(open.parent_questions.some((question) => question.id === down.id), "the unpushed service_health escalation stays on the dashboard");
	// Each ask the main session opens for one of them is a real card: it pushes, once.
	const cards = [
		s.asks.open({ ...ASK, question: "Approve the plan for cp-demo1?", source_escalation: plan.id }),
		s.asks.open({ ...ASK, question: "Accept the risk?", source_escalation: risk.id }),
		s.asks.open({ ...ASK, question: "The updater failed; roll back by hand?", source_escalation: down.id }),
		s.asks.open({ ...ASK, question: "Merge PR #12 for cp-demo1?", job_ids: ["cp-demo1"] }),
		s.asks.open({ ...ASK, question: "One final fix for cp-demo3?", job_ids: ["cp-demo3"] }),
	];
	for (const card of cards) await s.settled(card.id);
	assert.deepEqual(s.sent().map(([, payload]) => payload.headline).sort(), cards.map((card) => card.question).sort());
	const items = s.ledger()!.items;
	assert.deepEqual(items.map((item) => item.id).sort(), [baseline.id, ...cards.map((card) => card.id)].sort(), "no escalation, mission end, merge row, final fix or closed ask is a push candidate");
	for (const card of cards) assert.deepEqual([s.item(card.id)?.source, s.item(card.id)?.status], ["ask", "sent"]);
	assert.doesNotMatch(readFileSync(pushDeliveriesFile(s.stateDir), "utf8"), /md-abc123/, "nothing in the ledger names the mandate");
	// The recovery (a withdrawn service_health) pushes nothing; the next ask proves the sweep saw it.
	await escalations.withdraw(down.id);
	const canary = s.asks.open({ ...ASK, question: "Canary?" });
	await s.settled(canary.id);
	assert.deepEqual(s.sent().map(([, payload]) => payload.headline), ["Canary?"]);
});

test("P22-push-retry: retryable answers back off 30/60/120/240 s and fail after 5, one log line each; answered before a retry is skipped", async (t) => {
	const s = await rig(t);
	s.subscribe(FCM);
	await s.start();
	await until(() => s.ledger(), Boolean, "the baseline");
	const outcomes = [500, 429, 599, 503, 500];
	s.answer(() => outcomes.shift() ?? 201);
	const raised = s.asks.open({ ...ASK, question: "Down?" });
	for (const [index, wait] of [30, 60, 120, 240].entries()) {
		const record = await s.settled(raised.id, (item) => item.attempts === index + 1, `attempt ${index + 1}`);
		assert.equal(record.status, "pending");
		const tried = s.posts.at(-1)!.at;
		assert.ok(Math.abs(Date.parse(record.next_attempt_at!) - tried - wait * 1000) < 2_000, `backs off ${wait}s: ${record.next_attempt_at}`);
		s.advance(wait);
		await s.settled(raised.id, (item) => item.attempts === index + 2, `attempt ${index + 2}`);
		assert.ok(s.posts.at(-1)!.at >= Date.parse(record.next_attempt_at!), `not before ${wait}s`);
	}
	const failed = await s.settled(raised.id);
	assert.deepEqual([failed.status, failed.attempts, s.posts.length], ["failed", 5, 5]);
	assert.match(failed.last_error ?? "", /retry: HTTP 500/);
	const lines = s.stderr().split("\n").filter((line) => line.includes(`push ${raised.id} →`));
	assert.equal(lines.length, 5, lines.join("\n"));
	for (const line of lines) {
		assert.match(line, new RegExp(`^pi-command-post: push ${raised.id} → ${subscriptionId(FCM).slice(0, 8)}: retry \\(`));
		assert.doesNotMatch(line, /fcm\.googleapis|device-a/);
	}
	// Answered while its retry waits: skipped at the next attempt, without a fetch.
	s.answer(() => 500);
	const answered = s.asks.open({ ...ASK, question: "Answered meanwhile?" });
	await s.settled(answered.id, (item) => item.attempts === 1);
	s.asks.answer(answered.id, "Approve");
	s.advance(3600);
	const skipped = await s.settled(answered.id, (item) => item.status !== "pending");
	assert.deepEqual([skipped.status, skipped.last_error, skipped.attempts], ["skipped", "no longer open before delivery", 1]);
	assert.equal(s.posts.length, 6, "the failed ask is never tried again, the answered one once");
});

test("P22-push-gone: 404/410 remove the subscription, 403 fails at once, an off-allowlist endpoint is never fetched; no backlog", async (t) => {
	const s = await rig(t);
	await s.start();
	await until(() => s.ledger(), Boolean, "the baseline");
	const lonely = s.asks.open({ ...ASK, question: "Nobody subscribed?" });
	assert.deepEqual([(await s.settled(lonely.id)).status, s.item(lonely.id)?.last_error], ["skipped", "no subscribed device"]);
	const urls = ["https://fcm.googleapis.com/fcm/send/gone-404", "https://fcm.googleapis.com/fcm/send/gone-410", "https://fcm.googleapis.com/fcm/send/forbidden", "https://evil.example/push/steal"];
	for (const url of urls) s.subscribe(url);
	s.answer((slug) => (slug.endsWith("404") ? 404 : slug.endsWith("410") ? 410 : 403));
	const raised = s.asks.open({ ...ASK, question: "Risky?" });
	const record = await s.settled(raised.id);
	assert.deepEqual(s.posts.map((post) => post.slug).sort(), ["forbidden", "gone-404", "gone-410"], "a later subscriber gets no backlog");
	for (const url of urls.slice(0, 2)) assert.equal(existsSync(subscriptionFile(s.dataDir, subscriptionId(url))), false);
	assert.equal(existsSync(subscriptionFile(s.dataDir, subscriptionId(urls[3]!))), true);
	assert.deepEqual([record.status, record.attempts], ["failed", 1]);
	assert.match(record.last_error ?? "", /rejected: endpoint is not on the push-service allowlist/);
	assert.match(record.last_error ?? "", /rejected: HTTP 403/);
	assert.equal(s.stderr().split("\n").filter((line) => line.includes(`push ${raised.id} →`)).length, 4);
	s.advance(3600);
	const canary = s.asks.open({ ...ASK, question: "Canary?" });
	await s.settled(canary.id);
	assert.deepEqual(s.posts.map((post) => post.slug).sort(), ["forbidden", "forbidden", "gone-404", "gone-410"], "the failed ask is never retried");
	// A corrupt ask file is reported and changes nothing.
	const before = readFileSync(pushDeliveriesFile(s.stateDir), "utf8");
	writeFileSync(join(s.stateDir, "operator", "asks.jsonl"), "{not json\n");
	const report = await until(() => s.stderr(), (text) => text.includes("push sweep cannot read the ask records"), "the corrupt-asks line");
	assert.match(report, /^pi-command-post: push sweep cannot read the ask records/m);
	assert.equal(readFileSync(pushDeliveriesFile(s.stateDir), "utf8"), before);
	assert.equal(s.posts.length, 4);
});

test("P22-push-devices: an owned subscription's device and tunnel generation are rechecked before each send or retry", async (t) => {
	const s = await rig(t);
	const store = new DeviceStore(s.dataDir, s.stateDir, { now: () => new Date() });
	const pair = (name: string) => {
		const issued = store.issueCode({ origin: TUNNEL, generation: 1, route: "cli-pair" });
		assert.ok(issued.ok);
		const claimed = store.claim({ origin: TUNNEL, generation: 1, code: issued.code, name });
		assert.ok(claimed.ok);
		return claimed.device.id;
	};
	const phone = pair("Phone"), tablet = pair("Tablet");
	s.subscribe(FCM);
	s.subscribe(MOZ, { device_id: phone, origin: TUNNEL });
	s.subscribe("https://fcm.googleapis.com/fcm/send/tablet", { device_id: tablet, origin: TUNNEL });
	s.subscribe("https://fcm.googleapis.com/fcm/send/old-origin", { device_id: tablet, origin: "https://old.trycloudflare.com" });
	await s.start();
	await until(() => s.ledger(), Boolean, "the baseline");
	const slugs = () => s.posts.splice(0).map((post) => post.slug).sort();
	s.answer(() => 500);
	const first = s.asks.open({ ...ASK, question: "First?" });
	await s.settled(first.id, (item) => item.attempts === 1);
	assert.deepEqual(slugs(), ["device-a", "device-b", "tablet"], "active devices on their own origin, plus the legacy one");
	assert.ok(store.revoke(phone).ok);
	s.answer(() => 201);
	s.advance(30);
	await s.settled(first.id);
	assert.deepEqual(slugs(), ["device-a", "tablet"], "the retry skips the device revoked since the first attempt");
	s.advance(31 * 24 * 3600);
	const second = s.asks.open({ ...ASK, question: "Second?" });
	await s.settled(second.id);
	assert.deepEqual(slugs(), ["device-a"], "an expired device gets no new push");
	writeFileSync(devicesFile(s.dataDir), "{ not json");
	const third = s.asks.open({ ...ASK, question: "Third?" });
	await s.settled(third.id);
	assert.deepEqual(slugs(), ["device-a"], "an unreadable device store fails closed for owned subscriptions only");
});

test("P22-push-tunnel: a newer quick-tunnel generation or an unreadable runtime gets an owned subscription no push; legacy ones go", async (t) => {
	const s = await rig(t);
	const store = new DeviceStore(s.dataDir, s.stateDir, { now: () => new Date() });
	const issued = store.issueCode({ origin: TUNNEL, generation: 1, route: "cli-pair" });
	assert.ok(issued.ok);
	const claimed = store.claim({ origin: TUNNEL, generation: 1, code: issued.code, name: "Phone" });
	assert.ok(claimed.ok);
	s.subscribe(FCM);
	s.subscribe(MOZ, { device_id: claimed.device.id, origin: TUNNEL });
	await s.start();
	await until(() => s.ledger(), Boolean, "the baseline");
	const cases: Array<[unknown, string[], string]> = [
		[{ schema_version: 1, generation: 1, origin: TUNNEL }, ["device-a", "device-b"], "its own generation"],
		[{ schema_version: 1, generation: 2, origin: "https://new.trycloudflare.com" }, ["device-a"], "a newer generation ends it"],
		["{torn", ["device-a"], "an unreadable runtime fails owned ones closed"],
	];
	for (const [value, expected, why] of cases) {
		writeFileSync(tunnelRuntimeFile(s.stateDir), typeof value === "string" ? value : JSON.stringify(value));
		const ask = s.asks.open({ ...ASK, question: `${why}?` });
		await s.settled(ask.id);
		assert.deepEqual(s.posts.splice(0).map((post) => post.slug).sort(), expected, why);
	}
});

test("P22-push-legacy: a ledger from before the rule change baselines its sources; legacy records of removed kinds settle, never suppress", async (t) => {
	const s = await rig(t);
	s.subscribe(FCM);
	const escalations = new EscalationStore({ home: s.home });
	const raise = (question: string, kind: string, extra: Partial<RaiseEscalationInput> = {}) =>
		escalations.raise({ job_ids: ["cp-demo1"], kind: kind as RaiseEscalationInput["kind"], question, options: OPTIONS, recommended: "approve", ...extra });
	const risk = await raise("Risky?", "risk_high_irreversible");
	const budget = await raise("Budget?", "budget_exhausted");
	const refused = await raise("Merge refused?", "merge_refused");
	const down = await raise("Down?", "service_health", { job_ids: ["cp-service-health"] });
	await raiseMissionEnd(escalations, { jobIds: ["cp-demo1"], mandateId: "md-old123", summary: "landed 1, dropped 0, cost $0.10" });
	const old = s.asks.open({ ...ASK, question: "Old ask?" });
	const legacy = [
		{ id: "md-old123", source: "mandate", kind: "mission_end", status: "pending" },
		{ id: "es-aaaaaa", source: "escalation", kind: "risk_high_irreversible", status: "pending" },
		{ id: "aw-dddddd", source: "merge_ask", kind: "merge_ask", status: "pending" },
		{ id: "aw-checkpoint-cp-demo1.final-fix-abcdef123456", source: "checkpoint", kind: "final_fix", status: "pending" },
		{ id: risk.id, source: "escalation", kind: "risk_high_irreversible", status: "pending" },
		{ id: refused.id, source: "escalation", kind: "merge_refused", status: "pending" },
		{ id: budget.id, source: "escalation", kind: "budget_exhausted", status: "sent" },
		{ id: down.id, source: "escalation", kind: "service_health", status: "sent" },
	].map((item) => ({ ...item, attempts: item.status === "sent" ? 1 : 0, delivered: item.status === "sent" ? 1 : 0, created_at: "2026-09-26T00:00:00Z", ...(item.status === "sent" ? { settled_at: "2026-09-26T00:00:00Z" } : {}) }));
	writeFileSync(pushDeliveriesFile(s.stateDir), JSON.stringify({ schema_version: 1, baseline_at: "2026-09-26T00:00:00Z", items: legacy }));
	await s.start();
	assert.equal((await s.settled(old.id)).last_error, "open before the push rule changed");
	for (const item of legacy) {
		const now = await s.settled(item.id, (record) => record.status !== "pending");
		assert.deepEqual([now.status, now.last_error], item.status === "sent" ? ["sent", undefined] : ["skipped", "no longer open before delivery"], item.id);
	}
	const asks = [risk, budget, refused, down].map((raised, index) => s.asks.open({ ...ASK, question: `Real ask ${index}?`, source_escalation: raised.id }));
	for (const ask of asks) assert.equal((await s.settled(ask.id)).status, "sent");
	assert.deepEqual(s.sent().map(([, payload]) => payload.headline).sort(), ["Real ask 0?", "Real ask 1?", "Real ask 2?", "Real ask 3?"]);
});

test("P22-push-doctor: unconfigured, the parent sends nothing and /doctor is silent; configured, /doctor names devices, the rule and each fault", async (t) => {
	const s = await rig(t, { configured: false, scale: 1 });
	s.subscribe("https://fcm.googleapis.com/fcm/send/secret-device");
	await new EscalationStore({ home: s.home }).raise({ job_ids: ["cp-demo1"], kind: "plan_approval", question: "Approve the plan?", options: OPTIONS, recommended: "approve" });
	s.asks.open({ ...ASK, question: "Unconfigured?" });
	await s.start();
	assert.deepEqual(await s.doctor(), [], "an unconfigured home is not a fault");
	assert.deepEqual([existsSync(pushDeliveriesFile(s.stateDir)), s.posts.length], [false, 0], "no ledger, no fetch");
	initPush({ dataDir: s.dataDir, origin: ORIGIN });
	assert.deepEqual(await s.doctor(), [
		{ check: "push", severity: "ok", what: `web push for ${ORIGIN}: 1 subscribed device(s)` },
		{ check: "push", severity: "ok", what: "pushes only when you must act: open ask cards (Awaiting you); nothing else, health and downtime stay on the dashboard" },
	]);
	await until(() => s.ledger(), Boolean, "the parent's first configured sweep");
	const failed = (id: string, settled_at: string, last_error: string) => ({ id, source: "ask", kind: "operator_ask", status: "failed", attempts: 5, delivered: 0, created_at: settled_at, settled_at, last_error });
	const recent = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
	writeFileSync(pushDeliveriesFile(s.stateDir), JSON.stringify({ ...s.ledger(), items: [
		failed("ask-0000000000a1", recent(50), "stale"), failed("ask-0000000000a2", recent(2), "abcd1234 retry: HTTP 500"), failed("ask-0000000000a3", recent(1), "abcd1234 rejected: HTTP 403"),
	] }));
	const undelivered = (await s.doctor()).find((finding) => finding.severity === "warn");
	assert.equal(undelivered?.what, "2 push(es) undelivered in the last 24 h (last: abcd1234 rejected: HTTP 403)");
	assert.match(undelivered?.fix ?? "", /reachable at https:\/\/cp\.example\.com.*at most 5 attempts/);
	writeFileSync(pushDeliveriesFile(s.stateDir), "{broken");
	assert.ok((await s.doctor()).some((finding) => /ledger is unreadable/.test(finding.what)));
	rmSync(pushDeliveriesFile(s.stateDir));
	chmodSync(vapidKeyFile(s.dataDir), 0o644);
	assert.ok((await s.doctor()).some((finding) => finding.severity === "warn" && finding.fix === `chmod 600 ${vapidKeyFile(s.dataDir)}`));
	rmSync(vapidKeyFile(s.dataDir));
	const missing = await s.doctor();
	assert.ok(missing.some((finding) => /signing key is missing/.test(finding.what) && /push:init -- --origin https:\/\/cp\.example\.com/.test(finding.fix ?? "")));
	for (const finding of missing) {
		assert.doesNotMatch(JSON.stringify(finding), /secret-device/);
		if (finding.severity !== "ok") assert.ok(finding.fix, "every warning names its fix");
		assert.ok(finding.what.length <= 200);
	}
});

test("P22-push-lock: a parent refused the home's lock runs no push sweep, though /doctor still reads push", async (t) => {
	const s = await rig(t);
	s.subscribe(FCM);
	const held = acquireParentLock({ home: s.home });
	assert.ok(held.ok);
	s.asks.open({ ...ASK, question: "Who sends this?" });
	await s.start();
	await until(() => s.notes(), (notes) => notes.some((note) => /^pi-command-post: .*parent/i.test(note)), "the lock refusal");
	assert.deepEqual(await s.doctor(), [{ check: "push", severity: "ok", what: `web push for ${ORIGIN}: 1 subscribed device(s)` }, { check: "push", severity: "ok", what: PUSH_RULE }]);
	assert.deepEqual([existsSync(pushDeliveriesFile(s.stateDir)), s.posts.length], [false, 0], "no ledger, no fetch without the lock");
	held.lock.release();
});
