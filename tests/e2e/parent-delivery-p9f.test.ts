/** P9f: the parent delivery state machine behind CpBridge — wake and send ladders, spans, relays, resume nudges. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { type BridgeRelay, CpBridge, RELAUNCH_FAIL_CAP } from "../../src/cp-bridge.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { frameBatch, frameResume, ParentSendOutbox, parentSendFile, sharedReplyPointer } from "../../src/parent-outbox.ts";
import { OUTER_RETRY_DELAYS_MS } from "../../src/provider-retry.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type ScriptStep, waitFor } from "../harness/index.ts";

type Row = Record<string, unknown>;
const RESUME = /previous turn failed/;
const envSnapshots = new WeakMap<TestContext, NodeJS.ProcessEnv>();

async function fixture(t: TestContext, steps: ScriptStep[], name: string, settings: Record<string, unknown> = {}) {
	const home = createScratchHome();
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	const provider = await MockProvider.start();
	const model = provider.addScript(name, steps, { onExhausted: "repeat" });
	const agent = createAgentDir({ provider, settings: { compaction: { enabled: false }, retry: { enabled: false }, ...settings } });
	// One snapshot per test: a second fixture in the same test must not capture the first one's agent env.
	const previous = envSnapshots.get(t) ?? envSnapshots.set(t, { ...process.env }).get(t)!;
	Object.assign(process.env, agent.env);
	const bridges: CpBridge[] = [];
	const relays: BridgeRelay[] = [];
	const sleeps: Array<{ ms: number; release: () => void }> = [];
	t.after(async () => {
		for (const sleep of sleeps) sleep.release();
		for (const bridge of bridges) await bridge.stop();
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		agent.cleanup(); await provider.stop(); home.cleanup();
	});
	const session = join(home.path, LAYOUT.sessions, "cp-parent.jsonl");
	const sends = parentSendFile(session);
	const requests = () => provider.requests(name);
	const lastUser = (n: number) => {
		const messages = (requests()[n]?.body as { messages?: Array<{ role: string }> }).messages ?? [];
		return JSON.stringify(messages.filter((message) => message.role === "user").at(-1));
	};
	return {
		home: home.path, provider, relays, sleeps, session, sends, requests, lastUser,
		/** Starts a bridge; `gated` holds each ladder sleep until the test releases it, else sleeps are instant. */
		start: async (opts: { gated?: boolean; listener?: (relay: BridgeRelay) => void } = {}) => {
			const bridge = new CpBridge();
			bridges.push(bridge);
			bridge.onRelay(opts.listener ?? ((relay) => { relays.push(relay); }));
			const outerRetrySleep = (ms: number) => opts.gated
				? new Promise<void>((resolve) => sleeps.push({ ms, release: resolve }))
				: (sleeps.push({ ms, release: () => undefined }), Promise.resolve());
			await bridge.start({ home: home.path, mode: "multi", model, cwd: home.path, commandPostExtension: COMMAND_POST_EXTENSION, outerRetrySleep });
			return bridge;
		},
		journal: (): Row[] => {
			try {
				return readFileSync(join(home.path, LAYOUT.state, "bridge-retry.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
			} catch { return []; }
		},
		entries: () => (JSON.parse(readFileSync(sends, "utf8")) as { entries: Row[] }).entries,
		/** A settled worker's envelope: the parent's startup intake wakes it, a turn no send owns. */
		settled: async (id: string) => {
			await new FleetStore({ home: home.path }).add({ job_id: id, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "waiting",
				branch: id, worktree: join(home.path, "wt"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE, worker: { pid: 2147483600, session_id: "s",
					session_file: join(home.path, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/model", started_at: isoTimestamp() } } as FleetRecord);
			mkdirSync(join(home.path, paths.runDir(id)), { recursive: true });
			writeFileSync(join(home.path, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1,
				envelope: { job_id: id, kind: "ship", status: "done", summary: `${id} done`, branch: id } }));
		},
	};
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errors = (relays: BridgeRelay[]) => relays.filter((relay) => relay.kind === "error");

test("P9f-delivery-wake: a wake turn that ends on a transient error is nudged on the send ladder, then relays once when exhausted", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "error", status: 503, message: "P9F wake unavailable", repeat: 20 }], "p9f-wake");
	await f.settled("cp-wake");
	await f.start();
	await waitFor(() => f.journal(), (rows) => rows.some((row) => row.event === "outer_retry_exhausted"), { timeoutMs: 30_000, what: "the wake ladder spent" });
	await waitFor(() => errors(f.relays), (rows) => rows.length > 0, { timeoutMs: 10_000, what: "the error relay" });
	await pause(500);
	const rows = f.journal();
	assert.deepEqual(rows.map((row) => [row.event, row.wake, row.attempt ?? row.attempts]),
		[...OUTER_RETRY_DELAYS_MS.map((_, i) => ["outer_retry_attempt", true, i + 1]), ["outer_retry_exhausted", true, OUTER_RETRY_DELAYS_MS.length]]);
	assert.deepEqual(f.sleeps.map((sleep) => sleep.ms), [...OUTER_RETRY_DELAYS_MS], "same backoff as sends");
	assert.equal(f.requests().length, 1 + OUTER_RETRY_DELAYS_MS.length, "one resume per rung, none past the cap");
	for (let n = 1; n < f.requests().length; n++) {
		assert.match(f.lastUser(n), RESUME);
		assert.doesNotMatch(f.lastUser(n), /\[cp-send/, "a nudge carries no send marker");
	}
	assert.equal(errors(f.relays).length, 1, "spent: the error is relayed once");
	assert.match(errors(f.relays)[0]!.text, /P9F wake unavailable/);
});

test("P9f-delivery-wake-paths: a never-retried error relays at once, a recovered wake relays nothing, a clean turn cancels a pending nudge", { timeout: 180_000 }, async (t) => {
	const fatal = await fixture(t, [{ kind: "error", status: 401, message: "P9F unauthorized" }], "p9f-fatal");
	await fatal.settled("cp-fatal");
	await fatal.start();
	await waitFor(() => errors(fatal.relays), (rows) => rows.length > 0, { timeoutMs: 30_000, what: "the auth error relayed" });
	await pause(500);
	assert.match(errors(fatal.relays)[0]!.text, /P9F unauthorized/);
	assert.deepEqual([fatal.journal(), fatal.requests().length, errors(fatal.relays).length], [[], 1, 1], "never nudged, never journaled, relayed once");

	const recovered = await fixture(t, [{ kind: "error", status: 503, message: "P9F blip" }, { kind: "text", text: "P9F wake recovered." }], "p9f-recover");
	await recovered.settled("cp-recover");
	await recovered.start();
	await waitFor(() => recovered.requests().length, (n) => n === 2, { timeoutMs: 30_000, what: "the nudged retry" });
	await pause(1_500);
	assert.deepEqual(recovered.journal().map((row) => [row.event, row.attempt]), [["outer_retry_attempt", 1]]);
	assert.deepEqual(errors(recovered.relays), [], "the relay waits on the ladder and a recovery leaves nothing to relay");

	const cancel = await fixture(t, [{ kind: "error", status: 503, message: "P9F blip" }, { kind: "text", text: "P9F operator answer." }], "p9f-cancel");
	await cancel.settled("cp-cancel");
	const bridge = await cancel.start({ gated: true });
	await waitFor(() => cancel.sleeps.length, (n) => n === 1, { timeoutMs: 30_000, what: "the wake nudge pending" });
	assert.equal((await bridge.send("P9F operator", 60_000)).reply, "P9F operator answer.");
	await pause(1_000); // the reply resolves at turn_end; the cancel lands at agent_settled
	cancel.sleeps[0]!.release();
	await pause(1_500);
	assert.equal(cancel.requests().length, 2, "no stale nudge after a clean turn");
	assert.deepEqual(errors(cancel.relays), []);
});

test("P9f-delivery-span: a send answered only by tool calls takes the next finished answer with its own commentary; a later error fails both", { timeout: 180_000 }, async (t) => {
	const sleepy = (text?: string): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2" } }], ...(text ? { text } : {}) });
	const f = await fixture(t, [
		sleepy("Checking A now."), { kind: "text", text: "Answer B." },
		sleepy(), { kind: "text", text: "Answer D." },
		sleepy(), { kind: "error", status: 400, message: "usage limit reached" },
	], "p9f-span");
	const bridge = await f.start();
	const round = async (a: string, b: string, at: number) => {
		const first = bridge.send(a, 60_000);
		await waitFor(() => f.requests().length, (n) => n === at, { timeoutMs: 20_000, what: `${a} in flight` });
		const second = await bridge.send(b, 60_000);
		return [await first, second];
	};
	const [a, b] = await round("P9F A", "P9F B", 1);
	assert.equal(a!.reply, "Checking A now.\nAnswer B.", "A keeps its commentary and shares the finished answer");
	assert.equal(b!.reply, sharedReplyPointer(a!.send_id!), "one answer, one copy: B points at A");
	const [c, d] = await round("P9F C", "P9F D", 3);
	assert.deepEqual([c!.level, c!.reply, d!.reply], ["owner_observed", "Answer D.", sharedReplyPointer(c!.send_id!)], "never settled empty by the tool turn");
	const [e, g] = await round("P9F E", "P9F G", 5);
	assert.deepEqual([e!.level, g!.level], ["turn_failed", "turn_failed"], "no answer finished: each gets the run's error");
	assert.match(g!.error ?? "", /usage limit reached/);
	assert.deepEqual(f.journal(), [], "a non-transient error never enters the outer ladder");
	assert.deepEqual(f.sleeps, []);
});

test("P9f-delivery-relay: a relay that throws is journaled, never stops the rest, and lands on the next pass", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "P9F idle." }], "p9f-relay");
	const box = new ParentSendOutbox({ file: f.sends });
	mkdirSync(join(f.home, LAYOUT.sessions), { recursive: true });
	const [bad, good] = ["P9F bad", "P9F good"].map((text) => box.enqueue(text));
	box.markInjected([bad!.id, good!.id]);
	box.markLanded([bad!.id, good!.id]);
	box.settle(bad!.id, { reply: "bad reply" });
	box.settle(good!.id, { reply: "good reply" });
	let throws = 0;
	const first = await f.start({ listener: (relay) => {
		if (relay.sendId === bad!.id) { throws += 1; throw new Error(`P9F emit boom ${throws}`); }
		f.relays.push(relay);
	} });
	await pause(1_500);
	assert.deepEqual(f.relays.filter((relay) => relay.kind === "send").map((relay) => relay.sendId), [good!.id], "the failing entry never aborts the one behind it");
	assert.equal(throws, 1, "one relay pass at start");
	assert.deepEqual(f.journal().map((row) => [row.event, row.send_id]), [["relay_failed", bad!.id]], "journaled, never swallowed");
	const byId = () => new Map(f.entries().map((entry) => [entry.id, entry]));
	assert.equal(byId().get(bad!.id)?.relayed_at, undefined, "left due, so the next pass retries it");
	assert.ok(byId().get(good!.id)?.relayed_at);
	await first.stop();
	await f.start();
	await waitFor(() => f.relays.filter((relay) => relay.sendId === bad!.id), (rows) => rows.length > 0, { timeoutMs: 20_000, what: "the retried relay" });
	await pause(500);
	assert.equal(f.relays.filter((relay) => relay.sendId === bad!.id).length, 1, "exactly one relay once it lands");
	assert.equal(f.relays.filter((relay) => relay.sendId === good!.id).length, 1, "the landed one is never relayed again");
	assert.ok(byId().get(bad!.id)?.relayed_at);
});

test("P9f-delivery-restart: the ladder's budget survives a death mid-sleep, and a reservation that cannot be written fails the send", { timeout: 180_000 }, async (t) => {
	const f = await fixture(t, [
		{ kind: "error", status: 503, message: "P9F down" }, { kind: "error", status: 503, message: "P9F down" }, { kind: "text", text: "P9F back." },
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: "sleep 2" } }] }, { kind: "error", status: 503, message: "P9F down" },
	], "p9f-restart");
	const first = await f.start({ gated: true });
	const send = await first.send("P9F task", 300);
	await waitFor(() => f.sleeps.length, (n) => n === 1, { timeoutMs: 30_000, what: "the first rung asleep" });
	const id = send.send_id!;
	assert.equal(f.entries().find((entry) => entry.id === id)?.outer_retry_attempts, 1, "reserved before the sleep");
	await first.stop();
	f.sleeps[0]!.release();
	await pause(500);
	assert.equal(f.requests().length, 1, "an obsolete timer sends nothing");
	const second = await f.start({ gated: true });
	await waitFor(() => f.sleeps.length, (n) => n === 2, { timeoutMs: 30_000, what: "the second rung asleep" });
	assert.equal(f.sleeps[1]!.ms, OUTER_RETRY_DELAYS_MS[1], "a restarted delivery continues at the next ordinal and delay");
	assert.match(f.lastUser(1), /— resume\]/, "the restart nudges the landed send, never its body");
	f.sleeps[1]!.release();
	await waitFor(() => f.journal(), (rows) => rows.some((row) => row.event === "outer_retry_succeeded"), { timeoutMs: 30_000, what: "the recovery" });
	assert.match(f.lastUser(2), RESUME);
	const stored = f.entries().find((entry) => entry.id === id);
	assert.deepEqual([stored?.state, stored?.reply, stored?.attempts, stored?.outer_retry_attempts], ["settled", "P9F back.", 1, 2]);
	assert.deepEqual(f.journal().filter((row) => row.send_id === id).map((row) => [row.event, row.attempt ?? row.afterAttempts]),
		[["outer_retry_attempt", 1], ["outer_retry_attempt", 2], ["outer_retry_succeeded", 2]]);

	const reserve = second.send("P9F reserve", 60_000);
	await waitFor(() => f.requests().length, (n) => n === 4, { timeoutMs: 20_000, what: "the reserve send's tool call running" });
	const reserveId = f.entries().find((entry) => entry.text === "P9F reserve")!.id;
	writeFileSync(f.sends, "not json");
	await assert.rejects(reserve, (error: Error) => error.message.includes(f.sends), "the unreadable outbox is named by its path");
	assert.deepEqual(f.journal().filter((row) => row.send_id === reserveId).map((row) => row.event), ["outer_retry_reservation_failed"], "named, never silent");
	await pause(500);
	assert.deepEqual([f.sleeps.length, f.requests().length], [2, 5], "no rung scheduled, no retry sent");
});

test("P9f-delivery-resume: a restart nudges each landed, unanswered send once, never a settled one or one already nudged", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "text", text: "P9F resumed." }], "p9f-resume");
	const box = new ParentSendOutbox({ file: f.sends });
	mkdirSync(join(f.home, LAYOUT.sessions), { recursive: true });
	const [done, fresh, answered] = ["P9F done", "P9F fresh", "P9F answered"].map((text) => box.enqueue(text));
	box.markInjected([done!.id, fresh!.id, answered!.id]);
	box.markLanded([done!.id, fresh!.id, answered!.id]);
	box.settle(answered!.id, { reply: "already answered" });
	const at = isoTimestamp(new Date(Date.now() - 60_000));
	const user = (i: number, text: string) => ({ type: "message", id: `m${i}`, parentId: i ? `m${i - 1}` : null, timestamp: at,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at) } });
	const rows = [{ type: "session", version: 3, id: "p9f-resume", timestamp: at, cwd: f.home }, user(0, frameBatch([fresh!])), user(1, frameResume([done!.id]))];
	writeFileSync(f.session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const first = await f.start();
	await waitFor(() => f.entries().find((entry) => entry.id === fresh!.id)?.state, (state) => state === "settled", { timeoutMs: 30_000, what: "the nudged send answered" });
	assert.equal(f.requests().length, 1, "one nudge for the whole restart");
	const nudge = f.lastUser(0);
	assert.match(nudge, /— resume\]/);
	assert.ok(nudge.includes(fresh!.id), "a landed send with only its delivery marker is nudged");
	assert.ok(!nudge.includes(done!.id), "a resume line already in the transcript is not repeated");
	assert.ok(!nudge.includes(answered!.id), "a settled send already has its answer");
	await first.stop();
	renameSync(f.session, `${f.session}.old`);
	await f.start();
	await waitFor(() => f.requests().length, (n) => n === 2, { timeoutMs: 30_000, what: "the nudge over an empty transcript" });
	assert.ok(f.lastUser(1).includes(done!.id), "an empty transcript still nudges once");
	assert.ok(![fresh!.id, answered!.id].some((id) => f.lastUser(1).includes(id)));
});

test("P9f-delivery-cap: failed turns count toward the relaunch cap when their outcome is pending, then the bridge stops", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t, [{ kind: "error", status: 400, message: "P9F model gone", repeat: 10 }], "p9f-cap");
	const bridge = await f.start();
	for (let n = 0; n < RELAUNCH_FAIL_CAP; n++) {
		const pending = await bridge.send(`P9F cap ${n}`, 1);
		assert.equal(pending.pending, pending.send_id, "the tool result returns before the turn settles");
		await waitFor(() => f.relays.filter((relay) => relay.kind === "relaunch" || relay.sendId === pending.send_id), (rows) => rows.length > 0,
			{ timeoutMs: 20_000, what: `send ${n} failed` });
	}
	const stop = await waitFor(() => f.relays.filter((relay) => relay.kind === "relaunch"), (rows) => rows.length > 0, { timeoutMs: 20_000, what: "the cap" });
	assert.match(stop[0]!.text, new RegExp(`parent model failed ${RELAUNCH_FAIL_CAP} turns in a row \\(most recent: [^)]*P9F model gone`));
	assert.equal(f.relays.filter((relay) => relay.kind === "send").length, RELAUNCH_FAIL_CAP, "each pending failure is relayed by id");

	// The stopped bridge still sweeps its outbox: a queued send with no parent gets one notice, an old one expires.
	await waitFor(() => bridge.status().alive, (alive) => !alive, { timeoutMs: 20_000, what: "the bridge stopped" });
	const box = (ms: number) => new ParentSendOutbox({ file: f.sends, now: () => new Date(Date.now() + ms) });
	const slow = box(-11 * 60_000).enqueue("P9F slow");
	const old = box(-25 * 3_600_000).enqueue("P9F old");
	bridge.sweepSends();
	bridge.sweepSends();
	const notices = f.relays.filter((relay) => relay.kind === "error" && relay.text.includes(`send ${slow.id} still queued after 11 min: parent not running`));
	assert.equal(notices.length, 1, "one notice, persisted, never two");
	assert.ok(f.entries().find((entry) => entry.id === slow.id)?.pending_notice_at);
	assert.equal(f.entries().find((entry) => entry.id === old.id)?.state, "undeliverable");
	assert.match(f.relays.find((relay) => relay.sendId === old.id)?.text ?? "", /was not delivered \(stale: queued/);
});
