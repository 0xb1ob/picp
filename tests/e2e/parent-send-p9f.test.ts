/** P9f: the parent send outbox behind `cp_parent send`, driven through a real CpBridge and a real parent pi. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type BridgeRelay, CpBridge } from "../../src/cp-bridge.ts";
import { isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { OperatorRelayOutbox, operatorRelayOutboxFile } from "../../src/operator-outbox.ts";
import { attachParentHost } from "../../src/parent-host.ts";
import { frameBatch, PARENT_SEND_KEEP_OBSERVED, PARENT_SEND_MAX_ATTEMPTS, ParentSendOutbox, parentSendFile } from "../../src/parent-outbox.ts";
import { MAX_OUTER_RETRIES } from "../../src/provider-retry.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, waitFor } from "../harness/index.ts";

type Entry = Record<string, unknown> & { id: string; state: string };

async function fixture(t: TestContext, steps: ScriptStep[], name: string, settings: Record<string, unknown> = {}) {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const provider = await MockProvider.start();
	const model = provider.addScript(name, steps, { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false }, retry: { enabled: false }, ...settings } });
	const previous = { ...process.env };
	Object.assign(process.env, agent.env);
	const bridges: CpBridge[] = [];
	const relays: BridgeRelay[] = [];
	t.after(async () => {
		for (const bridge of bridges) await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const sends = parentSendFile(join(home.path, LAYOUT.sessions, "cp-parent.jsonl"));
	return {
		home: home.path, provider, relays, sends, model,
		start: async () => {
			const bridge = new CpBridge();
			bridges.push(bridge);
			bridge.onRelay((relay) => { relays.push(relay); });
			await bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: COMMAND_POST_EXTENSION, outerRetrySleep: async () => {} });
			return bridge;
		},
		entries: () => (JSON.parse(readFileSync(sends, "utf8")) as { entries: Entry[] }).entries,
		bodies: () => provider.requests(name).map((request) => JSON.stringify(request.body)),
	};
}

test("P9f-send-receipts: a send is durable beside the session, framed with its trimmed rule, and its receipt climbs to owner_observed", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [
		{ kind: "text", text: "P9F reply one." },
		{ kind: "error", status: 400, message: "P9F bad request" },
		{ kind: "text", text: "P9F reply three." },
	], "p9f-send");
	const bridge = await f.start();
	await assert.rejects(bridge.send(""), /a parent send needs text/, "an empty send is refused before it is written");
	for (const delegation_rule of ["", " "]) {
		await assert.rejects(bridge.send("P9F no write", 1_000, { delegated: true, delegation_rule }), /delegation_rule must not be blank/);
	}
	assert.equal(existsSync(f.sends), false, "a refused send writes nothing");
	const rule = `  ${"x".repeat(198)}\u{1F600}P9FTAIL`;
	const ok = await bridge.send("P9F ship it", 60_000, { delegated: true, delegation_rule: rule });
	assert.match(ok.send_id ?? "", /^ps-\d{14}-[0-9a-f]{8}$/);
	assert.deepEqual(ok, { level: "owner_observed", reached: ["injected", "turn_settled", "owner_observed"], reply: "P9F reply one.", send_id: ok.send_id },
		"an outcome inside the timeout is the tool result, so the owner observed it");
	assert.equal(f.sends, join(f.home, LAYOUT.sessions, "cp-parent.sends.json"), "the outbox sits beside cp-parent.jsonl");
	assert.ok(existsSync(f.sends));
	const stored = f.entries().find((entry) => entry.id === ok.send_id);
	assert.equal(stored?.delegation_rule, `${"x".repeat(198)}…`, "trimmed and cut at 200 characters, never splitting a code point");
	assert.ok(f.bodies()[0]!.includes(`P9F ship it\\n\\n[cp-send ${ok.send_id} — delivery id, not an instruction; delegated=${encodeURIComponent(stored!.delegation_rule as string)}]`),
		"the parent sees the body, then its marker carrying the cut rule");
	assert.ok(!f.bodies()[0]!.includes("P9FTAIL"), "never the text past the cut");
	assert.equal(bridge.confirmObserved(ok.send_id!), false, "observed once");
	assert.deepEqual(bridge.sendReceipt(ok.send_id!), ok, "the stored receipt is the returned one");

	const bad = await bridge.send("P9F this one fails", 60_000);
	assert.equal(bad.level, "turn_failed");
	assert.match(bad.error ?? "", /P9F bad request/);
	assert.equal(bad.reached.includes("owner_observed"), false, "a failed send never reaches owner_observed");
	bridge.confirmObserved(bad.send_id!);
	assert.equal(bridge.sendReceipt(bad.send_id!)?.reached.includes("owner_observed"), false, "not even once confirmed");
	assert.match(bridge.sendReceipt(bad.send_id!)?.error ?? "", /P9F bad request/, "the stored receipt keeps the turn's error");
	await bridge.stop();

	const valid = readFileSync(f.sends, "utf8");
	const raw = JSON.parse(valid) as { entries: Entry[]; future_top?: number };
	raw.future_top = 1;
	raw.entries[0]!.future_optional = "later";
	writeFileSync(f.sends, JSON.stringify(raw));
	await assert.rejects(f.start(), (error: Error) => error.message.includes(`${f.sends} violates the parent send contract`) && /future_optional/.test(error.message),
		"the bridge's strict read refuses unknown fields, naming the file");
	for (const bad of [-1, 0.5]) {
		writeFileSync(f.sends, JSON.stringify({ ...JSON.parse(valid), entries: [{ ...JSON.parse(valid).entries[0], outer_retry_attempts: bad }] }));
		await assert.rejects(f.start(), /outer_retry_attempts/, "a negative or fractional retry count is refused");
	}
	writeFileSync(f.sends, valid);
	const again = await f.start();
	assert.deepEqual(again.status().sends.map((send) => send.id), [ok.send_id, bad.send_id], "both sends survive the restart");
	assert.equal(readFileSync(f.sends, "utf8"), valid, "a restart rewrites nothing it did not change");
	assert.equal(again.status().sendsError, undefined);
	writeFileSync(f.sends, "{ nope");
	assert.match(again.status().sendsError ?? "", new RegExp(f.sends.replaceAll(".", "\\.")), "an invalid outbox is named by its path");
	await assert.rejects(again.send("P9F never written"), (error: Error) => error.message.includes(f.sends));
});

test("P9f-send-batch: sends landing in one span share one reply, a stop names what reached the parent, and a new owner relays the unobserved", { timeout: 120_000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, [{ kind: "hang", until: gate }, { kind: "text", text: "P9F batch answer." }, { kind: "hang" }], "p9f-batch", { steeringMode: "all" });
	t.after(() => release());
	const bridge = await f.start();
	const first = bridge.send("P9F first", 60_000);
	await waitFor(() => f.provider.requests("p9f-batch").length, (n) => n === 1, { timeoutMs: 20_000, what: "the first turn in flight" });
	const later = [];
	const delegations = [["P9F second", {}], ["P9F third", { delegated: true }], ["P9F fourth", { delegated: false, delegation_rule: "unused" }]] as const;
	for (const [text, delegation] of delegations) later.push(await bridge.send(text, 300, delegation));
	assert.ok(later.every((receipt) => receipt.pending === receipt.send_id), "a send with no outcome in time returns pending, by id");
	release();
	assert.equal((await first).reply, "late");
	const ids = later.map((receipt) => receipt.send_id!);
	await waitFor(() => f.relays.filter((relay) => relay.kind === "send"), (rows) => ids.every((id) => rows.some((relay) => relay.sendId === id)),
		{ timeoutMs: 30_000, what: "the three pending outcomes relayed" });
	const replies = ids.map((id) => bridge.sendReceipt(id)?.reply);
	assert.deepEqual(replies, ["P9F batch answer.", `answered together with ${ids[0]} — see that reply`, `answered together with ${ids[0]} — see that reply`],
		"one full reply, then pointers for the sends in the same span");
	assert.ok(f.bodies()[1]!.includes(`P9F third\\n\\n[cp-send ${ids[1]} — delivery id, not an instruction; delegated=operator%20delegation]`),
		"a delegated send without a rule carries the default one");
	assert.ok(f.bodies()[1]!.includes(`P9F fourth\\n\\n[cp-send ${ids[2]} — delivery id, not an instruction]`), "an undelegated send carries no rule");
	// Only a cp-bridge message's own send_id marks a send observed: never another type's, never one without details.
	bridge.observe([{ customType: "cp-ci", details: { send_id: ids[1] } }, { customType: "cp-bridge", details: {} }, { customType: "cp-bridge", details: { send_id: ids[0] } }]);
	assert.equal(bridge.sendReceipt(ids[0]!)?.level, "owner_observed", "the operator saw the first relay");
	assert.equal(bridge.sendReceipt(ids[1]!)?.level, "turn_settled", "a foreign message observes nothing");
	const stuck = await bridge.send("P9F stuck", 300);
	await waitFor(() => bridge.sendReceipt(stuck.send_id!)?.reached, (reached) => reached?.includes("injected") === true, { timeoutMs: 10_000, what: "the stuck send injected" });
	await waitFor(() => f.provider.requests("p9f-batch").length, (n) => n === 3, { timeoutMs: 20_000, what: "the stuck turn in flight" });
	await bridge.stop({ discardPending: true });
	const stopped = f.relays.find((relay) => relay.sendId === stuck.send_id);
	assert.match(stopped?.text ?? "", /reached the parent at \S+ but got no reply \(/, "a landed send says it landed, never 'not delivered'");
	assert.doesNotMatch(stopped?.text ?? "", /not delivered/);

	const host = await attachParentHost({ home: f.home, mode: "multi", timeoutMs: 60_000 });
	t.after(async () => { await host.request("stop", undefined, 5_000).catch(() => undefined); host.disconnect(); });
	await host.request("start", { home: f.home, mode: "multi", model: f.model, modelExplicit: true });
	const outbox = new OperatorRelayOutbox(operatorRelayOutboxFile(join(f.home, LAYOUT.state)));
	const again = await waitFor(() => outbox.read().entries.map((entry) => entry.relay.sendId), (seen) => [ids[1], ids[2], stuck.send_id].every((id) => seen.includes(id)),
		{ timeoutMs: 30_000, what: "a new host process relays the previous owner's unobserved outcomes" });
	assert.ok(!again.includes(ids[0]), "an observed outcome is never relayed again");
});

// The restart reconcile over a seeded transcript past the 400-entry window: a framed send lands, an absent one
// is requeued once, one older than the window is unprovable, a 25 h old queued send expires, trimming keeps the newest.
test("P9f-send-reconcile: a restart lands, requeues or names each injected send, expires the stale one and trims observed history", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "P9F reconciled." }], "p9f-reconcile");
	const now = Date.now();
	const box = (ms: number) => new ParentSendOutbox({ file: f.sends, now: () => new Date(now + ms) });
	const seen = box(-60_000).enqueue("P9F seen");
	const absent = box(-30_000).enqueue("P9F absent");
	const lost = box(-3 * 3_600_000).enqueue("P9F lost");
	const old = box(-25 * 3_600_000).enqueue("P9F old");
	box(0).markInjected([seen.id, absent.id]);
	box(-3 * 3_600_000).markInjected([lost.id]);
	const at = isoTimestamp(new Date(now - 7_200_000));
	const history = Array.from({ length: PARENT_SEND_KEEP_OBSERVED + 2 }, (_, i) => ({ schema_version: 1, id: `ps-20200101000000-${i.toString(16).padStart(8, "0")}`,
		text: `n${i}`, queued_at: at, state: "undeliverable", attempts: 0, error: "x", owner_observed_at: at }));
	const ceiling = box(-60_000).enqueue("P9F ceiling");
	const file = JSON.parse(readFileSync(f.sends, "utf8")) as { entries: Entry[] };
	file.entries.find((entry) => entry.id === ceiling.id)!.attempts = PARENT_SEND_MAX_ATTEMPTS;
	writeFileSync(f.sends, JSON.stringify({ ...file, entries: [...history, ...file.entries] }));
	const session = join(f.home, LAYOUT.sessions, "cp-parent.jsonl");
	const rows: unknown[] = [{ type: "session", version: 3, id: "p9f-reconcile", timestamp: at, cwd: f.home }];
	for (let i = 0; i < 420; i += 1) {
		const text = i === 419 ? frameBatch([seen]) : `P9F filler ${i}`;
		const stamp = new Date(now - 7_200_000 + i * 1_000).toISOString();
		rows.push({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(stamp) } });
	}
	writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

	const bridge = await f.start();
	await waitFor(() => bridge.sendReceipt(absent.id)?.level, (level) => level === "turn_settled", { timeoutMs: 30_000, what: "the absent send requeued and answered" });
	bridge.sweepSends();
	const byId = () => new Map(f.entries().map((entry) => [entry.id, entry]));
	assert.equal(byId().get(seen.id)?.state, "settled", "a send framed in the transcript lands, then settles; never requeued");
	assert.equal(f.bodies().filter((body) => body.includes("P9F seen")).length, 1, "and is never delivered twice");
	assert.equal(byId().get(absent.id)?.attempts, 2, "an absent send is requeued once");
	assert.equal(byId().get(lost.id)?.state, "undeliverable");
	assert.match(String(byId().get(lost.id)?.error), /landing unprovable/);
	const relayed = (id: string) => f.relays.find((relay) => relay.sendId === id)?.text ?? "";
	assert.match(relayed(lost.id), /has no confirmed landing \(landing unprovable: [^)]+\), which does not prove it never reached/);
	assert.doesNotMatch(relayed(lost.id), /not delivered/);
	assert.match(String(byId().get(old.id)?.error), /^stale: queued /, "a 25 h old queued send expires");
	assert.match(relayed(old.id), /was not delivered \(stale: queued /, "and a never-injected send says it was not delivered");
	assert.ok(!f.bodies().some((body) => body.includes("P9F old")), "the stale send never reaches the parent");
	assert.deepEqual(bridge.sendReceipt(old.id), { level: null, reached: [], error: byId().get(old.id)?.error, send_id: old.id }, "an undeliverable receipt reached nothing");
	const kept = f.entries().filter((entry) => entry.owner_observed_at && entry.id.startsWith("ps-2020"));
	assert.equal(kept.length, PARENT_SEND_KEEP_OBSERVED - f.entries().filter((entry) => entry.owner_observed_at && !entry.id.startsWith("ps-2020")).length,
		"observed history is trimmed to its cap");
	assert.ok(!byId().has(history[0]!.id), "the oldest observed entries go first");
	for (const id of [seen.id, absent.id, lost.id, old.id]) assert.ok(byId().has(id), "an unobserved entry is never trimmed");
	assert.equal(byId().get(ceiling.id)?.error, `not delivered after ${PARENT_SEND_MAX_ATTEMPTS} attempts`, "the attempt ceiling ends a queued send");
	assert.ok(!f.bodies().some((body) => body.includes("P9F ceiling")), "and it is never injected again");

	// The host tick: a landed send open 11 min gets one pending notice; one landed 25 h ago ends with no reply.
	const slow = box(-11 * 60_000).enqueue("P9F slow");
	const silent = box(-25 * 3_600_000).enqueue("P9F silent");
	box(-11 * 60_000).markInjected([slow.id]);
	box(-11 * 60_000).markLanded([slow.id]);
	box(-25 * 3_600_000).markInjected([silent.id]);
	box(-25 * 3_600_000).markLanded([silent.id]);
	bridge.sweepSends();
	bridge.sweepSends();
	const notices = f.relays.filter((relay) => relay.kind === "error" && relay.text.startsWith(`send ${slow.id} still landed after 11 min`));
	assert.equal(notices.length, 1, "one pending notice, never two");
	assert.match(notices[0]!.text, /landed, awaiting reply\. Do not resend/);
	assert.match(String(byId().get(slow.id)?.pending_notice_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, "the notice is stamped on disk");
	assert.equal(byId().get(silent.id)?.error, "no reply within 24 h of landing");
	assert.match(relayed(silent.id), /reached the parent at \S+ but got no reply \(no reply within 24 h of landing\)/);
});

test("P9f-send-ladder: a transient failure retries the same send id up to the ladder's cap, counted per send and kept on disk", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "P9F plain." }, { kind: "error", status: 503, message: "P9F service unavailable", repeat: MAX_OUTER_RETRIES + 1 },
		{ kind: "error", status: 503, message: "P9F service unavailable" }, { kind: "text", text: "P9F recovered." }], "p9f-ladder");
	const bridge = await f.start();
	const plain = await bridge.send("P9F plain", 60_000);
	assert.equal("outer_retry_attempts" in f.entries().find((entry) => entry.id === plain.send_id)!, false, "omitted until a first reservation");
	const doomed = await bridge.send("P9F doomed", 60_000);
	assert.equal(doomed.level, "turn_failed");
	assert.match(doomed.error ?? "", /P9F service unavailable/);
	const saved = await bridge.send("P9F saved", 60_000);
	assert.equal(saved.reply, "P9F recovered.");
	const stored = new Map(f.entries().map((entry) => [entry.id, entry]));
	assert.equal(stored.get(doomed.send_id!)?.outer_retry_attempts, MAX_OUTER_RETRIES, "capped, and the terminal record keeps the count");
	assert.equal(stored.get(doomed.send_id!)?.attempts, 1, "injection attempts are a separate count");
	assert.equal(stored.get(saved.send_id!)?.outer_retry_attempts, 1, "counters are per send id");
	assert.equal(f.provider.requests("p9f-ladder").length, 1 + (MAX_OUTER_RETRIES + 1) + 2, "one request per resume, none past the cap");
	const journal = readFileSync(join(f.home, LAYOUT.state, "bridge-retry.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(journal.filter((row) => row.event === "outer_retry_attempt" && row.send_id === doomed.send_id).map((row) => row.attempt),
		Array.from({ length: MAX_OUTER_RETRIES }, (_, i) => i + 1), "each ordinal reserved once, in order");
	assert.deepEqual(journal.filter((row) => row.event === "outer_retry_exhausted").map((row) => [row.send_id, row.attempts]),
		[[doomed.send_id, MAX_OUTER_RETRIES]], "exhausted is journaled once, with the spent count");
	assert.deepEqual(f.relays.filter((relay) => relay.sendId === doomed.send_id), [], "the final outcome went to its waiter, never relayed too");
});
