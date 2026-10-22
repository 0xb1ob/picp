import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths, type FleetRecord } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { initialStatus } from "../../src/run-artifacts.ts";
import { CiWatchStore } from "../../src/ci-watch.ts";
import { AnsweredOutbox } from "../../src/answered.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, startPiChild } from "../harness/index.ts";
import { waitFor } from "../harness/index.ts";

const issued = "2026-08-31T12:45:43Z";
const head = "a".repeat(40);
type Notice = { kind: string; job?: string; body: string; stamp?: Record<string, unknown>; details?: Record<string, unknown> };

async function carried(t: TestContext, records: Array<Partial<FleetRecord> & { job_id: string }>, notices: Notice[],
	seed?: (home: string) => string | void) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("s22-context", [{ kind: "text", text: "S22 context received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	chmodSync(agent.path, 0o700);
	const session = join(home.path, "legacy.jsonl");
	let child: ReturnType<typeof startPiChild> | undefined;
	t.after(async () => { await child?.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const fleet = new FleetStore({ home: home.path });
	for (const record of records) {
		await fleet.add({ project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN,
			phase: "waiting", branch: record.job_id, worktree: home.path, dispatched_at: issued, usage: EMPTY_USAGE,
			worker: { pid: process.pid, session_id: "legacy", session_file: session, profile: "implementer",
				role: "implementer", model, started_at: issued }, ...record });
		mkdirSync(join(home.path, paths.runDir(record.job_id)), { recursive: true });
	}
	const timestamp = isoTimestamp();
	let parentId: string | null = null;
	const rows: unknown[] = [{ type: "session", version: 3, id: "s22-session", timestamp, cwd: home.path }];
	for (const [index, notice] of notices.entries()) {
		const id = `s22-${index}`;
		rows.push({ type: "message", id, parentId, timestamp, message: {
			role: "custom", customType: `cp-${notice.kind}`, content: notice.body, display: true, timestamp: index + 1,
			details: { cp_wakeup: { kind: notice.kind, issued_at: issued, ...(notice.job ? { job_id: notice.job } : {}),
				...notice.stamp }, ...notice.details },
		} });
		parentId = id;
	}
	writeFileSync(session, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const fixture = seed?.(home.path);
	child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION, ...(fixture ? [fixture] : [])], sessionFile: session });
	await child.prompt("Inspect the S22 carried notices.");
	await child.waitForSettled(60_000);
	assert.equal(provider.remaining("s22-context"), 0);
	const text = JSON.stringify(provider.requests("s22-context").flatMap((request) =>
		(request.body.messages as Array<{ role: string }>).filter((m) => m.role !== "system")));
	assert.doesNotMatch(text, /STALE WAKE-UP|REPLAYED WAKE-UP|S22_BROKEN_/);
	return text;
}

test("S22: envelope generations and terminal phases filter carried reports before the provider", { timeout: 110_000 }, async (t) => {
	const text = await carried(t, [
		{ job_id: "cp-promoted", phase: "waiting", supersessions: 1 },
		{ job_id: "cp-archived", phase: "waiting" },
		{ job_id: "cp-done", phase: "done", reported_at: issued },
		{ job_id: "cp-done-empty", phase: "done" },
		{ job_id: "cp-done-idle", phase: "done" },
		{ job_id: "cp-live", reported_at: issued },
		{ job_id: "cp-next", supersessions: 1, reported_at: issued },
		{ job_id: "cp-unreported", phase: "waiting" },
		{ job_id: "cp-script", phase: "failed", executor: "script", reported_at: issued, worker: undefined,
			script_path: "scripts/legacy.sh", script_process: { pid: process.pid, started_at: issued },
			failure: { class: "script_exit", message: "legacy script failed", at: issued } } as unknown as FleetRecord,
		{ job_id: "cp-model", phase: "failed", reported_at: issued,
			failure: { class: "model_call_failed", message: "legacy model failed", at: issued } },
		{ job_id: "cp-script-done", phase: "done", executor: "script", reported_at: issued, worker: undefined,
			script_path: "scripts/legacy.sh", script_process: { pid: process.pid, started_at: issued } } as unknown as FleetRecord,
	], [
		{ kind: "envelope", job: "cp-promoted", body: "S22_PROMOTED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-archived", body: "S22_ARCHIVED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-done", body: "S22_CLOSED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-live", body: "S22_CURRENT_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-next", body: "S22_OLD_GENERATION", stamp: { generation: 1, reported_at: issued } },
		{ kind: "envelope", job: "cp-next", body: "S22_NEXT_REPORT", stamp: { generation: 2, reported_at: issued } },
		{ kind: "envelope", job: "cp-unreported", body: "S22_FABRICATED_REPORT", stamp: { generation: 1, reported_at: issued } },
		{ kind: "unreported", job: "cp-live", body: "S22_OBSOLETE_SETTLE", stamp: { generation: 1 } },
		{ kind: "wedged", job: "cp-done-empty", body: "S22_CLOSED_WEDGE" },
		{ kind: "unreported", job: "cp-done-idle", body: "S22_CLOSED_SETTLE" },
		{ kind: "envelope", job: "cp-script", body: "S22_SCRIPT_FAILURE", stamp: { reported_at: issued } },
		{ kind: "envelope", job: "cp-model", body: "S22_MODEL_FAILURE", stamp: { reported_at: issued } },
		{ kind: "envelope", job: "cp-script-done", body: "S22_SCRIPT_CLOSED", stamp: { reported_at: issued } },
	], (home) => {
		writeFileSync(join(home, paths.statusFile("cp-done-empty")), JSON.stringify({
			...initialStatus("cp-done-empty", { pid: process.pid }), phase: "working",
			current_tool: { name: "bash", tool_call_id: "closed-call", started_at: issued },
		}));
	});
	assert.deepEqual(["PROMOTED_REPORT", "ARCHIVED_REPORT", "CLOSED_REPORT", "OLD_GENERATION", "FABRICATED_REPORT", "OBSOLETE_SETTLE",
		"CLOSED_WEDGE", "CLOSED_SETTLE", "MODEL_FAILURE", "SCRIPT_CLOSED"].filter((body) => text.includes(`S22_${body}`)), []);
	assert.deepEqual(["CURRENT_REPORT", "NEXT_REPORT", "SCRIPT_FAILURE"].filter((body) => text.includes(`S22_${body}`)),
		["CURRENT_REPORT", "NEXT_REPORT", "SCRIPT_FAILURE"]);
	assert.doesNotMatch(text, /S22_ARCHIVED_REPORT|S22_CLOSED_REPORT/);
});

test("S22: CI replay identity preserves new jobs heads events and mixed batches", { timeout: 110_000 }, async (t) => {
	const ci = (job: string, sha: string, event: string) => ({ key: `${job}|${sha}|${event}`, job_id: job, head_sha: sha, event });
	const green = ci("cp-ci", head, "ci_green");
	const text = await carried(t, [{ job_id: "cp-ci" }, { job_id: "cp-other" }, { job_id: "cp-terminal", phase: "done" }], [
		{ kind: "ci", job: "cp-ci", body: "S22_CI_FIRST", stamp: { keys: [head] }, details: { ci: [green] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_DUPLICATE", stamp: { keys: [head] }, details: { ci: [green] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NO_DETAILS_ONE", stamp: { keys: [head] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NO_DETAILS_TWO", stamp: { keys: [head] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_NEW_HEAD", stamp: { keys: ["b".repeat(40)] }, details: { ci: [ci("cp-ci", "b".repeat(40), "ci_green")] } },
		{ kind: "ci", job: "cp-other", body: "S22_CI_OTHER_JOB", stamp: { keys: [head] }, details: { ci: [ci("cp-other", head, "ci_green")] } },
		{ kind: "ci", job: "cp-ci", body: "S22_CI_MERGED", stamp: { keys: [head] }, details: { ci: [ci("cp-ci", head, "pr_merged")] } },
		{ kind: "ci", body: "S22_CI_MIXED", details: { ci: [green, ci("cp-other", head, "ci_failed")] } },
		{ kind: "ci", job: "cp-terminal", body: "S22_TERMINAL_FIRST", stamp: { keys: [head] }, details: { ci: [ci("cp-terminal", head, "ci_green")] } },
		{ kind: "ci", job: "cp-terminal", body: "S22_TERMINAL_COPY", stamp: { keys: [head] }, details: { ci: [ci("cp-terminal", head, "ci_green")] } },
	]);
	const expected = ["CI_FIRST", "CI_NO_DETAILS_ONE", "CI_NO_DETAILS_TWO", "CI_NEW_HEAD", "CI_OTHER_JOB", "CI_MERGED", "CI_MIXED"];
	assert.deepEqual(expected.filter((body) => text.includes(`S22_${body}`)), expected);
	for (const body of ["CI_DUPLICATE", "TERMINAL_FIRST", "TERMINAL_COPY"]) assert.ok(!text.includes(`S22_${body}`), body);
});


test("S22: answer replay preserves coalesced unseen decisions and text-only legacy identities", { timeout: 110_000 }, async (t) => {
	const decision = "aw-checkpoint-cp-answer";
	const text = await carried(t, [{ job_id: "cp-answer", phase: "done" }], [
		{ kind: "answered", job: "cp-answer", body: "S22_ANSWER_FIRST", stamp: { keys: [decision], issued_at: "2000-01-01T00:00:00Z" } },
		{ kind: "answered", job: "cp-answer", body: "S22_ANSWER_COPY", stamp: { keys: [decision] } },
		{ kind: "answered", body: "S22_ANSWER_MIXED", stamp: { keys: [decision, "aw-unseen"] } },
		{ kind: "answered", body: "DECISION ANSWERED — S22_TEXT_FIRST\n  aw-legacy: approved" },
		{ kind: "answered", body: "DECISION ANSWERED — S22_TEXT_COPY\n  aw-legacy: approved" },
		{ kind: "answered", job: "cp-missing", body: "S22_ANSWER_MISSING", stamp: { keys: ["aw-missing"] } },
		{ kind: "answered", body: "S22_ANSWER_FUTURE", stamp: { keys: ["aw-future"], issued_at: "2999-01-01T00:00:00Z" } },
	]);
	for (const body of ["ANSWER_FIRST", "ANSWER_MIXED", "TEXT_FIRST", "ANSWER_MISSING", "ANSWER_FUTURE"]) assert.ok(text.includes(`S22_${body}`), body);
	for (const body of ["ANSWER_COPY", "TEXT_COPY"]) assert.ok(!text.includes(`S22_${body}`), body);
});


test("S22: carried wedges and settles use the persisted run phase and open call", { timeout: 110_000 }, async (t) => {
	const variants = ["working", "next", "idle", "reported", "unknown", "dead"];
	const records = variants.map((v) => ({ job_id: `cp-${v}`, ...(v === "reported" ? { reported_at: issued } : {}) }));
	const notices = variants.flatMap((v) => [
		{ kind: "wedged", job: `cp-${v}`, body: `S22_WEDGE_${v}`, stamp: { keys: [`cp-${v}#9`] } },
		{ kind: "unreported", job: `cp-${v}`, body: `S22_SETTLE_${v}`, stamp: { generation: 1 } },
	]);
	const text = await carried(t, records, notices, (home) => {
		for (const v of variants.filter((v) => v !== "unknown")) {
			const status = { ...initialStatus(`cp-${v}`, { pid: v === "dead" ? 2147483647 : process.pid }),
				phase: v === "idle" ? "idle" : "working", tool_calls: v === "next" ? 10 : 9,
				current_tool: { name: "bash", tool_call_id: "call-9", started_at: isoTimestamp() } };
			writeFileSync(join(home, paths.statusFile(`cp-${v}`)), JSON.stringify(status));
		}
		const fixture = join(home, "dead-reading.ts");
		writeFileSync(fixture, `import { readFileSync, writeFileSync } from "node:fs";
export default function(pi) { pi.on("input", () => {
 const file = ${JSON.stringify(join(home, ".pi-command-post/state/fleet.json"))};
 const fleet = JSON.parse(readFileSync(file, "utf8"));
 fleet.jobs.find((job) => job.job_id === "cp-dead").worker.pid = 2147483647;
 writeFileSync(file, JSON.stringify(fleet));
}); }`);
		return fixture;
	});
	assert.deepEqual(variants.filter((v) => text.includes(`S22_WEDGE_${v}`)), ["working"]);
	assert.deepEqual(variants.filter((v) => text.includes(`S22_SETTLE_${v}`)), ["idle", "unknown"]);
});


test("S22: observed CI heads suppress history while fleet reports cannot veto observations", { timeout: 110_000 }, async (t) => {
	const text = await carried(t, ["moved", "observed", "pruned"].map((v) => ({ job_id: `cp-${v}`, reported_at: issued })),
		["moved", "observed", "pruned"].map((v) => ({ kind: "ci", job: `cp-${v}`, body: `S22_HEAD_${v}`, stamp: { keys: [head] } })),
		(home) => {
			const watch = new CiWatchStore({ home });
			watch.record("cp-moved", { head_sha: "b".repeat(40) });
			watch.record("cp-observed", { head_sha: head });
			for (const v of ["moved", "observed", "pruned"]) writeFileSync(join(home, paths.envelopeFile(`cp-${v}`)),
				JSON.stringify({ received_at: new Date(Date.now() + 60_000).toISOString(), envelope: { head_sha: "c".repeat(40) } }));
			const fixture = join(home, "head-observations.ts");
			writeFileSync(fixture, `import { CiWatchStore } from ${JSON.stringify(join(process.cwd(), "src/ci-watch.ts"))};
export default function(pi) { pi.on("input", () => {
 const watch = new CiWatchStore({ home: ${JSON.stringify(home)} });
 watch.record("cp-moved", { head_sha: "${"b".repeat(40)}" });
 watch.record("cp-observed", { head_sha: "${head}" });
}); }`);
			return fixture;
		});
	const corrupt = await carried(t, [{ job_id: "cp-corrupt", reported_at: issued }], [
		{ kind: "ci", job: "cp-corrupt", body: "S22_CORRUPT_WATCH", stamp: { keys: [head] } },
	], (home) => {
		writeFileSync(new CiWatchStore({ home }).file, "{broken legacy watcher");
		writeFileSync(join(home, paths.envelopeFile("cp-corrupt")), JSON.stringify({ envelope: { head_sha: "c".repeat(40) } }));
	});
	assert.ok(!text.includes("S22_HEAD_moved"));
	const surviving = ["observed", "pruned"].filter((v) => text.includes(`S22_HEAD_${v}`));
	if (corrupt.includes("S22_CORRUPT_WATCH")) surviving.push("corrupt");
	assert.deepEqual(surviving, ["observed", "pruned", "corrupt"]);
});

test("S22: durable replay failures and legacy stamp parsing preserve only current facts", { timeout: 110_000 }, async (t) => {
	const text = await carried(t, [
		{ job_id: "cp-model-failed", phase: "failed", failure: { class: "model_call_failed", message: "legacy provider refused", at: issued } },
		{ job_id: "cp-bound", phase: "failed", failure: { class: "tool_call_cap_exceeded", message: "legacy cap", at: issued } },
		{ job_id: "cp-death", phase: "failed", failure: { class: "crash", message: "legacy worker exited", at: issued } },
	], [
		{ kind: "recovery", body: "S22_DURABLE_FIRST", details: { durable_id: "continuation:cp-land:1:done" } },
		{ kind: "recovery", body: "S22_DURABLE_COPY", details: { durable_id: "continuation:cp-land:1:done" } },
		{ kind: "recovery", body: "S22_DURABLE_OTHER", details: { durable_id: "continuation:cp-other:1:done" } },
		{ kind: "death", job: "cp-death", body: "S22_DEATH_FIRST", stamp: { keys: ["crash"] }, details: { durable_id: "death:cp-death:1" } },
		{ kind: "death", job: "cp-death", body: "S22_DEATH_COPY", stamp: { keys: ["crash"] }, details: { durable_id: "death:cp-death:1" } },
		{ kind: "unreported", job: "cp-model-failed", body: "S22_FAILURE_EXPLAINS", stamp: { keys: ["model_call_failed"] } },
		{ kind: "unreported", job: "cp-model-failed", body: "S22_FAILURE_OLD" },
		{ kind: "bound", job: "cp-bound", body: "S22_BOUND_EXPLAINS", stamp: { keys: ["tool_call_cap_exceeded"] } },
		{ kind: "bound", job: "cp-bound", body: "S22_BOUND_OLD", stamp: { keys: ["wall_clock_exceeded"] } },
		{ kind: "envelope", job: "cp-missing", body: "S22_INVALID_STAMP", stamp: { kind: "nope", issued_at: "x" } },
		{ kind: "envelope", job: "cp-missing", body: "S22_UNSTAMPED", details: { cp_wakeup: undefined } },
	]);
	const expected = ["DURABLE_FIRST", "DURABLE_OTHER", "DEATH_FIRST", "FAILURE_EXPLAINS", "BOUND_EXPLAINS", "INVALID_STAMP", "UNSTAMPED"];
	assert.ok(text.includes("Inspect the S22 carried notices."));
	assert.deepEqual(expected.filter((v) => text.includes(`S22_${v}`)), expected);
	assert.deepEqual(["DURABLE_COPY", "DEATH_COPY", "FAILURE_OLD", "BOUND_OLD"].filter((v) => text.includes(`S22_${v}`)), []);
});


test("S22: native answered delivery carries terminal notes missing jobs and coalesced arrival receipts", { timeout: 110_000 }, async (t) => {
	for (const jobs of [["cp-done"], ["cp-missing"], ["cp-one", "cp-two"]]) {
		let outbox: AnsweredOutbox;
		const text = await carried(t, [{ job_id: "cp-done", phase: "done" }], [], (home) => {
			outbox = new AnsweredOutbox({ home });
			for (const job_id of jobs) outbox.enqueue({ id: `aw-s22-${job_id}`, type: "approval", job_id,
				decision: `S22_NATIVE_${job_id}`, answer: "continue", answered_by: "operator dialog (tui)" });
			assert.equal(outbox.pending().length, jobs.length);
			for (const job of jobs) assert.equal(outbox.delivered(`aw-s22-${job}`), false);
		});
		for (const job of jobs) {
			assert.ok(text.includes(`S22_NATIVE_${job}`), job);
			assert.equal(outbox!.delivered(`aw-s22-${job}`), true);
		}
		if (jobs[0] === "cp-done") assert.match(text, /cp-done is already done/);
		if (jobs.length === 2) assert.match(text, /aw-s22-cp-one[\s\S]*aw-s22-cp-two/);
	}
});


test("S22: sending coalesced answers during a turn does not confirm their arrival", { timeout: 110_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	let release!: () => void;
	const until = new Promise<void>((resolve) => { release = resolve; });
	const model = provider.addScript("s22-arrival", [{ kind: "hang", until }, { kind: "text", text: "Answers received." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	chmodSync(agent.path, 0o700);
	const child = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path },
		extensions: [COMMAND_POST_EXTENSION], sessionDir: join(home.path, "sessions") });
	t.after(async () => { release(); await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	await child.prompt("S22 ordinary busy turn");
	await waitFor(() => provider.requests("s22-arrival"), (rows) => rows.length === 1, { timeoutMs: 15_000, what: "busy provider" });
	const box = new AnsweredOutbox({ home: home.path });
	for (const id of ["aw-s22-one", "aw-s22-two"]) box.enqueue({ id, type: "approval", decision: `S22_ARRIVAL_${id}`,
		answer: "continue", answered_by: "operator dialog (tui)" });
	await waitFor(() => box.read(), (state) => (state.sends?.length ?? 0) + state.delivered.length >= 2,
		{ timeoutMs: 30_000, what: "both answers offered" });
	assert.equal(box.pending().length, 2, "sending is not delivery");
	for (const id of ["aw-s22-one", "aw-s22-two"]) assert.equal(box.delivered(id), false);
	release();
	await child.waitForSettled(30_000);
	await child.prompt("Inspect the delivered S22 decisions.");
	await waitFor(() => provider.requests("s22-arrival"), (rows) => rows.some((row) => JSON.stringify(row.body.messages).includes("S22_ARRIVAL_aw-s22-two")),
		{ timeoutMs: 30_000, what: "coalesced answers reach provider" });
	const text = JSON.stringify(provider.requests("s22-arrival")[1]?.body.messages);
	for (const id of ["aw-s22-one", "aw-s22-two"]) {
		assert.ok(text.includes(`S22_ARRIVAL_${id}`));
		assert.equal(box.delivered(id), true);
	}
});


test("S22: promoted CI survives generations until an observed head moves and notes appear once", { timeout: 110_000 }, async (t) => {
	const variants = ["promoted", "green", "held", "moved", "pruned", "noted"];
	const note = (job: string) => `(${job} was promoted after this CI fact (now generation 2, phase waiting): it is still true of ${head.slice(0, 12)}, but the reopened worker may move the branch — wait for its report before cp_integrate ${job})`;
	const text = await carried(t, variants.map((v) => ({ job_id: `cp-${v}`, supersessions: 1,
		...(v === "held" ? { phase: "held" as const, reported_at: issued } : {}) })), variants.flatMap((v) => {
		const job = `cp-${v}`;
		const event = v === "green" ? "ci_green" : "ci_failed";
		const details = { ci: [{ key: `${job}|${head}|${event}`, event, job_id: job, head_sha: head }] };
		return [
			{ kind: "ci", job, body: `S22_PROMOTION_${v}${v === "noted" ? `\n${note(job)}` : ""}`, stamp: { generation: 1, keys: [head] }, details },
			{ kind: "ci", job, body: `S22_PROMOTION_COPY_${v}`, stamp: { generation: 1, keys: [head] }, details },
		];
	}), (home) => {
		const fixture = join(home, "promoted-heads.ts");
		writeFileSync(fixture, `import { CiWatchStore } from ${JSON.stringify(join(process.cwd(), "src/ci-watch.ts"))};
export default function(pi) { pi.on("input", () => {
 const watch = new CiWatchStore({ home: ${JSON.stringify(home)} });
 for (const v of ["promoted", "green", "held", "moved", "noted"]) watch.record("cp-" + v, { head_sha: v === "moved" ? "${"b".repeat(40)}" : "${head}" });
}); }`);
		return fixture;
	});
	const expected = ["promoted", "green", "held", "pruned", "noted"];
	assert.deepEqual(variants.filter((v) => text.includes(`S22_PROMOTION_${v}`)), expected);
	assert.doesNotMatch(text, /S22_PROMOTION_COPY_/);
	for (const v of ["promoted", "green", "pruned", "noted"]) assert.equal(text.split(note(`cp-${v}`)).length - 1, 1, v);
	assert.doesNotMatch(text, /cp-held was promoted after this CI fact/);
});
