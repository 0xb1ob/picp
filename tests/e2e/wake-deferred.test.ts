import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts.ts";
import { AwaitingStore } from "../../src/awaiting.ts";
import { CiWatchStore } from "../../src/ci-watch.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { IntegrationHolds } from "../../src/integration-hold.ts";
import { FleetStore } from "../../src/fleet.ts";
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, MockProvider, startPiChild, waitFor } from "../harness/index.ts";
import { JOB, seedHeldHome, writeReviewPass } from "../harness/held-home.ts";

const userMessages = (request: { body: unknown }) => JSON.stringify(
	(request.body as { messages: Array<{ role: string }> }).messages.filter((message) => message.role === "user"));
for (const [mode, name] of [
	["race", "wake S19: CI and review races preserve decisions, recover from unreadable CI and announce late gates: race"],
	["failure", "wake S19: CI and review races preserve decisions, recover from unreadable CI and announce late gates: failure"],
	["late", "wake S19: CI and review races preserve decisions, recover from unreadable CI and announce late gates: late"],
] as const) {
test(name, { timeout: 300_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "none" });
	writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}\n');
	const store = new AwaitingStore({ home: held.home.path });
	if (mode === "late") for (const suffix of ["second", "third"]) await held.store.declareGated({ type: "approval",
		decision: `Ship cp-held (PR 58), ${suffix}?`, subject: `s19-${suffix}`, why: "late CI recheck", blocks: "delivery", job_id: JOB });
	writeReviewPass(held.home.path, mode === "late" ? held.headSha : "a".repeat(40));
	new IntegrationHolds(held.home.path).hold(JOB, "S19 observes delivery before integration");
	const outbox = new DurableWakeupOutbox({ home: held.home.path });
	outbox.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "Previously relayed recovery", keys: [JOB] });
	outbox.confirmDelivered([`recovery:${JOB}`]);
	const provider = await MockProvider.start();
	const deliveries: Array<{ at: number; states: string[] }> = [];
	const capture = (request: { body: unknown }) => {
		if (userMessages(request).includes("CI/PR OBSERVED")) deliveries.push({ at: Date.now(), states: store.read().items.filter((item) => item.job_id === JOB).map((item) => item.state) });
		return { action: "list" };
	};
	const reviewer = provider.addScript("s19-race-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: JOB, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["Current diff reviewed"],
	} }] }]);
	const observe = { kind: "tool_calls" as const, calls: [{ name: "cp_project", args: capture }] };
	const model = provider.addScript("s19-race-parent", mode === "late" ? [observe, { kind: "text", text: "CI observed." }] : [
		{ kind: "tool_calls", calls: [{ name: "cp_review", args: { job_id: JOB, model: reviewer } }] },
		{ kind: "text", text: "Review started." }, observe, { kind: "text", text: "Wake observed." }, observe, { kind: "text", text: "Wake acknowledged." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	// Keep the slow gate inside one CI poll.
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: mode === "late" ? "60" : "1" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.repo.cleanup(); held.home.cleanup(); });
	const queries = () => existsSync(`${held.ghLog}.states`) ? readFileSync(`${held.ghLog}.states`, "utf8").trim().split("\n")
		.filter(Boolean).map((line) => JSON.parse(line) as { state: string; at: number }) : [];
	await waitFor(() => new CiWatchStore({ home: held.home.path }).job(JOB)?.last_checked_at, Boolean,
		{ timeoutMs: 30_000, what: "initial running-CI observation finishes" });
	const before = queries().length;
	// late: three 24 s gate reads outlast the 60 s recheck bound, yet each fits the 30 s Actions CI budget.
	writeFileSync(held.stateFile, mode === "late" ? "green:24000\n" : "green:12000\n");
	await waitFor(queries, (calls) => calls.slice(before).some((call) => call.state === "green"),
		{ timeoutMs: mode === "late" ? 70_000 : 10_000, what: "watch captures green before subsequent gate faults" });
	if (mode === "failure") writeFileSync(held.stateFile, "broken:12000\n");
	if (mode !== "late") {
		await child.prompt("Review this held diff and handle its actual wake-ups.");
		await waitFor(queries, (calls) => calls.length >= before + 3,
			{ timeoutMs: 30_000, what: "CI-triggered and review-triggered rechecks both enter their queries" });
		const gates = queries().slice(before + 1, before + 3);
		assert.ok(gates[1]!.at - gates[0]!.at < 12_000, "both rechecks must be in flight together");
		await held.store.declare({ type: "design", decision: "Keep the neighboring decision?", why: "concurrent writer", blocks: "neighbor", job_id: "cp-neighbor" });
	}
	const requests = () => provider.requests("s19-race-parent");
	await waitFor(() => deliveries, (entries) => entries.length > 0,
		{ timeoutMs: 140_000, what: "real CI observation reaches parent without a status render" });
	if (mode === "race") assert.deepEqual(deliveries[0]!.states, ["open"],
		"the CI wake must reach its consumer after the raced gate completes");
	const context = JSON.stringify(requests()[0]!.body);
	assert.match(context, /unknown CI state may become readable with no event at all/);
	assert.doesNotMatch(context, /Always end a cp-ci wake-up turn with cp_status_block|Always end a turn carrying a passing cp_review verdict/);
	if (mode === "failure") {
		assert.equal(store.list("deferred").length, 1, "failed racers must keep the same deferred decision");
		assert.match(store.list("deferred")[0]!.deferred_reason ?? "", /CI state unavailable.*Actions CI read transport/);
		assert.equal(store.list("open").filter((item) => item.job_id === JOB).length, 0);
		assert.equal(child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("deferred rows not re-gated")).length, 0,
			"a fail-closed CI probe does not report a failed recheck");
		writeFileSync(held.stateFile, "green2\n");
	}
	if (mode === "late") {
		assert.ok(deliveries[0]!.at - queries()[before + 1]!.at >= 59_000,
			"the slow CI gate must spend its real deadline before delivering the wake");
		assert.deepEqual(deliveries[0]!.states, ["deferred", "deferred", "deferred"], "bounded CI delivery must precede the slow gate's writes");
		assert.equal(store.list("open").length, 0, "the timeout must open nothing");
		const warnings = child.records().filter((record) => record.type === "extension_ui_request" && String(record.message).includes("deferred rows not re-gated"));
		assert.equal(warnings.length, 1, "one expired CI recheck produces one operator warning");
		assert.match(String(warnings[0]!.message), /did not finish within 60000ms/);
		assert.ok(String(warnings[0]!.message).length <= 320 && !String(warnings[0]!.message).includes("\n"));
	}
	await waitFor(() => store.list("open").filter((item) => item.job_id === JOB), (items) => items.length === (mode === "late" ? 3 : 1),
		{ timeoutMs: 40_000, what: "actual evidence eventually opens the original deferred decisions" });
	await new Promise((done) => setTimeout(done, 1_500));
	const notices = child.records().filter((record) => record.type === "extension_ui_request" && /decisions? (?:is|are) now ready/.test(String(record.message)));
	assert.equal(notices.length, 1, "one decision promotion must produce one notice across both events and repeated ticks");
	const items = store.read().items;
	assert.equal(items.filter((item) => item.id === held.declared.item.id).length, 1, "original identity survives the race");
	assert.equal(new Set(items.map((item) => item.id)).size, items.length, "the real store remains sound");
	if (mode !== "late") assert.equal(items.filter((item) => item.job_id === "cp-neighbor" && item.state === "open").length, 1,
		"the concurrent unrelated writer must survive both rechecks");
	if (mode !== "late") assert.ok(requests().some((request) => userMessages(request).includes("diff review attempt 2: pass")),
		"the racing review verdict must reach the real parent");
	assert.equal(items.length, mode === "late" ? 3 : 2);
	assert.ok(items.filter((item) => item.job_id === JOB).every((item) => item.deferred_reason === undefined));
});
}


test("wake S19: a real CI event cannot open an unreviewed, superseded or unpushed head", { timeout: 180_000 }, async (t) => {
for (const mode of ["unreviewed", "wrong-head", "missing-head"] as const) await t.test(mode, { timeout: 60_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "none" });
	writeFileSync(join(held.home.path, LAYOUT.data, "wake-rules.json"), '{"enabled":false}\n');
	if (mode !== "unreviewed") writeReviewPass(held.home.path, held.headSha);
	new IntegrationHolds(held.home.path).hold(JOB, "S19 keeps CI evidence separate from integration");
	const outbox = new DurableWakeupOutbox({ home: held.home.path });
	outbox.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "Previously relayed recovery", keys: [JOB] });
	outbox.confirmDelivered([`recovery:${JOB}`]);
	const provider = await MockProvider.start();
	const model = provider.addScript("s19-ci-deferred", [{ kind: "text", text: "CI is evidence; the decision remains deferred." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "1" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.repo.cleanup(); held.home.cleanup(); });
	await waitFor(() => new CiWatchStore({ home: held.home.path }).job(JOB)?.last_checked_at, Boolean,
		{ timeoutMs: 30_000, what: "initial CI observation completes" });
	writeFileSync(held.stateFile, "green:12000\n");
	await waitFor(() => readFileSync(`${held.ghLog}.states`, "utf8"), (states) => states.includes('"state":"green"'),
		{ timeoutMs: 10_000, what: "watch captures a real green fact before the branch or runs change" });
	if (mode === "wrong-head") writeFileSync(held.stateFile, "wrong-head\n");
	if (mode === "missing-head") held.repo.git("push", "origin", ":cp-held");
	await waitFor(() => provider.requests("s19-ci-deferred"), (requests) => requests.some((request) => userMessages(request).includes("CI/PR OBSERVED")),
		{ timeoutMs: 40_000, what: "actual CI wake reaches the parent" });
	const store = new AwaitingStore({ home: held.home.path });
	assert.equal(store.list("open").length, 0, `${mode} must not open a merge decision`);
	assert.equal(store.list("deferred").length, 1);
	assert.equal(store.list("deferred")[0]!.id, held.declared.item.id);
	assert.match(store.list("deferred")[0]!.deferred_reason ?? "", mode === "unreviewed" ? /review/i : mode === "missing-head" ? /pushed|head|unavailable/i : /CI|run|unfinished/i);
	assert.equal(child.records().filter((record) => record.type === "extension_ui_request" && /decisions? (?:is|are) now ready/.test(String(record.message))).length, 0);
});
});


test("wake S19: a native plan-gate verdict leaves the held merge gate and awaiting bytes untouched", { timeout: 90_000 }, async (t) => {
	const held = await seedHeldHome({ ciState: "in_progress", review: "none" });
	const foreign = "cp-s19-plan";
	const fleet = new FleetStore({ home: held.home.path });
	writeFileSync(new ArtifactStore({ home: held.home.path }).path(foreign), "# Plan\nKeep the held job separate from this research artifact.\n");
	new IntegrationHolds(held.home.path).hold(JOB, "S19 observes native foreign verdict delivery");
	const outbox = new DurableWakeupOutbox({ home: held.home.path });
	outbox.enqueue({ id: `recovery:${JOB}`, kind: "recovery", job_id: JOB, content: "Previously relayed recovery", keys: [JOB] });
	outbox.confirmDelivered([`recovery:${JOB}`]);
	const provider = await MockProvider.start();
	const reviewer = provider.addScript("s19-native-gate-reviewer", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: {
		job_id: foreign, verdict: "pass", flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["The research plan is complete"],
	} }] }]);
	const snapshots: Array<{ queries: number; bytes: string; context: string }> = [];
	const capture = (request: { body: unknown }) => snapshots.push({
		queries: readFileSync(held.ghLog, "utf8").split("\n").filter((line) => line.includes("/actions/runs?head_sha=")).length,
		bytes: readFileSync(held.store.file, "utf8"), context: userMessages(request),
	});
	const model = provider.addScript("s19-native-gate-parent", [
		{ kind: "tool_calls", calls: [{ name: "cp_gate", args: (request: { body: unknown }) => { capture(request); return { job_id: foreign, model: reviewer }; } }] },
		{ kind: "text", text: "Gate started." },
		{ kind: "tool_calls", calls: [{ name: "cp_project", args: (request: { body: unknown }) => { capture(request); return { action: "list" }; } }] },
		{ kind: "text", text: "Foreign verdict observed." },
	]);
	const agent = createAgentDir({ provider });
	const child = startPiChild({ cwd: held.home.path, model, env: { ...agent.env, CP_HOME: held.home.path,
		PATH: `${held.bin}:${process.env.PATH ?? ""}`, CP_CI_WATCH_SECONDS: "3600" }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => { await child.close(); agent.cleanup(); await provider.stop(); held.repo.cleanup(); held.home.cleanup(); });
	await waitFor(() => new CiWatchStore({ home: held.home.path }).job(JOB)?.last_checked_at, Boolean,
		{ timeoutMs: 30_000, what: "initial CI catch-up completes before the foreign verdict" });
	await fleet.add({ ...fleet.get(JOB)!, job_id: foreign, kind: "research", delivery: "answer", branch: foreign, receipts: [] });
	writeFileSync(held.stateFile, "green\n");
	await child.prompt("Gate the research artifact and acknowledge its actual verdict.");
	await waitFor(() => snapshots.length, (count) => count === 2,
		{ timeoutMs: 45_000, what: "native gate verdict reaches the parent model" });
	assert.match(snapshots[1]!.context, /gate attempt 1: pass/);
	assert.equal(snapshots[1]!.queries, snapshots[0]!.queries, "a native plan gate must not probe the held merge gate");
	assert.equal(snapshots[1]!.bytes, snapshots[0]!.bytes, "a native plan gate must not rewrite awaiting state");
	assert.equal(new AwaitingStore({ home: held.home.path }).list("deferred").length, 1);
});
