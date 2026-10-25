import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DEFAULT_ORIGIN, type Delivery, EMPTY_USAGE, type FleetRecord, isoTimestamp, type JobKind, LAYOUT, MINIMAL_PLAN_SUMMARY, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, readFleet, readRunEvents, startRpc, waitFor } from "../harness/index.ts";

const DEAD_PID = 2147483600;

async function fixture(t: TestContext) {
	const home = createScratchHome();
	const agent = createAgentDir();
	const store = new FleetStore({ home: home.path });
	t.after(() => { agent.cleanup(); home.cleanup(); });
	const add = (id: string, kind: JobKind, delivery: Delivery, extra: Partial<FleetRecord> = {}) => store.add({ job_id: id, project: "demo", kind, delivery,
		origin: DEFAULT_ORIGIN, phase: "waiting", branch: id, worktree: join(home.path, "wt"), dispatched_at: isoTimestamp(), usage: EMPTY_USAGE,
		worker: { pid: DEAD_PID, session_id: "s", session_file: join(home.path, "s.jsonl"), profile: kind === "research" ? "planner" : "implementer",
			role: kind === "research" ? "planner" : "implementer", model: "mock/model", started_at: isoTimestamp() }, ...extra } as FleetRecord);
	const envelope = (id: string, body: Record<string, unknown>) => {
		mkdirSync(join(home.path, paths.runDir(id)), { recursive: true });
		writeFileSync(join(home.path, paths.envelopeFile(id)), JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: id, received_at: isoTimestamp(), attempt: 1,
			envelope: { job_id: id, ...body } }));
	};
	const start = async (env: Record<string, string> = {}) => {
		const rpc = startRpc({ cwd: home.path, env: { ...agent.env, CP_HOME: home.path, ...env }, args: ["--no-extensions", "-e", COMMAND_POST_EXTENSION, "--no-session"] });
		t.after(() => rpc.close().then(() => undefined));
		rpc.send({ type: "get_state", id: "ready" });
		await rpc.waitFor((r) => r.type === "response" && r.id === "ready", 30_000);
		return rpc;
	};
	const wakes = async (rpc: Awaited<ReturnType<typeof start>>) => {
		const id = `messages-${Math.random()}`;
		rpc.send({ type: "get_messages", id });
		const response = await rpc.waitFor((r) => r.type === "response" && r.id === id);
		return (response.data as { messages: Array<{ customType?: string }> }).messages.filter((m) => m.customType === "cp-envelope").map((m) => JSON.stringify(m));
	};
	const job = (id: string) => readFleet(home.path).jobs.find((j) => j.job_id === id);
	return { home: home.path, add, envelope, start, wakes, job };
}

test("P9f-intake-policy: a restart takes each settled envelope once, by delivery, and never carries an artifact body", { timeout: 120_000 }, async (t) => {
	const f = await fixture(t);
	const head = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";
	const outside = join(f.home, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "answer.md"), "# Answer\n\nP9F_ANSWER_BODY lives in src/routing.ts.\n");
	writeFileSync(join(outside, "report.md"), "# Findings\n\nP9F_REPORT_BODY the parent must never read.\n");
	writeFileSync(join(outside, "planq.md"), "P9F_PLANQ_BODY\n");
	const question = { question: "Which store?", why: "Schema depends on it.", options: ["Postgres", "SQLite"], recommended: "SQLite", assume_if_unanswered: "SQLite" };
	await f.add("cp-pr", "ship", "pr");
	f.envelope("cp-pr", { kind: "ship", status: "done", summary: "Pushed the fix; silent about CI.", branch: "cp-pr", pr_url: "https://github.com/o/r/pull/11",
		head_sha: head, base_sha: "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a" });
	await f.add("cp-local", "ship", "local");
	f.envelope("cp-local", { kind: "ship", status: "done", summary: "Fixed it locally.", branch: "cp-local" });
	await f.add("cp-question", "research", "answer");
	f.envelope("cp-question", { kind: "research", status: "done", summary: "Configured in src/routing.ts.", artifact_path: join(outside, "answer.md") });
	await f.add("cp-research", "research", "pipeline");
	f.envelope("cp-research", { kind: "research", status: "done", summary: "Three call sites; details in the artifact.", artifact_path: join(outside, "report.md"),
		plan_summary: MINIMAL_PLAN_SUMMARY, self_assessment: { confidence: "high", scope: "M", blocking_unknowns: false, destructive_scope: false } });
	await f.add("cp-blocked", "ship", "local");
	f.envelope("cp-blocked", { kind: "ship", status: "blocked", summary: "Cannot proceed.", blockers: ["migration needs owner sign-off"] });
	await f.add("cp-planq", "research", "pipeline");
	f.envelope("cp-planq", { kind: "research", status: "blocked", summary: "Need a store decision.", artifact_path: join(outside, "planq.md"),
		blockers: [question, { ...question, question: "Which TTL?" }] });
	await f.add("cp-round", "research", "local", { planner_blocked_rounds: 2 });
	f.envelope("cp-round", { kind: "research", status: "blocked", summary: "Still blocked.", blockers: [question] });
	await f.add("cp-quiet", "ship", "pr", { worker: { pid: process.pid, session_id: "s", session_file: join(f.home, "s.jsonl"), profile: "implementer",
		role: "implementer", model: "mock/model", started_at: isoTimestamp() } });

	const rpc = await f.start();
	const reported = ["cp-pr", "cp-local", "cp-question", "cp-research", "cp-blocked", "cp-planq", "cp-round"];
	await waitFor(() => reported.every((id) => f.job(id)?.reported_at || f.job(id)?.planner_blocked_rounds), (done) => done, { timeoutMs: 30_000, what: "every settled envelope taken" });
	const wakes = await f.wakes(rpc);
	assert.equal(wakes.length, reported.length, "one wake per settled envelope");
	const wake = (id: string) => wakes.find((text) => text.includes(`${id} reported`)) ?? "";

	assert.equal(f.job("cp-pr")?.phase, "held");
	assert.match(wake("cp-pr"), /cp-pr reported done \(ship\/pr\) → hold/);
	assert.match(wake("cp-pr"), /PR: https:\/\/github\.com\/o\/r\/pull\/11/);
	assert.equal(f.job("cp-pr")?.receipts?.find((r) => r.kind === "pr")?.url, "https://github.com/o/r/pull/11");
	const ci = f.job("cp-pr")?.receipts?.find((r) => r.kind === "ci");
	assert.deepEqual([ci?.status, ci?.title], ["unverified", `head ${head}`], "silence about CI is accepted; the parent verifies the pushed head itself");
	assert.equal(f.job("cp-local")?.phase, "held", "held means the envelope is in");
	assert.match(wake("cp-local"), /cp-local reported done \(ship\/local\) → teardown/);

	assert.match(wake("cp-question"), /cp-question reported done \(research\/answer\) → teardown/, "only pr holds; an answer needs no PR");
	for (const id of ["cp-question", "cp-research"]) {
		assert.ok(existsSync(join(f.home, paths.artifactFile(id))), `${id}: the artifact is moved into the store`);
		assert.equal(f.job(id)?.receipts?.find((r) => r.kind === "artifact")?.status, "stored");
	}
	assert.match(wake("cp-research"), /details in the artifact/, "the headline travels");
	const fleetText = readFileSync(join(f.home, LAYOUT.fleetFile), "utf8");
	for (const body of ["P9F_ANSWER_BODY", "P9F_REPORT_BODY", "P9F_PLANQ_BODY"]) {
		assert.ok(!wakes.some((text) => text.includes(body)) && !fleetText.includes(body), `${body} never enters the parent's world`);
	}

	assert.match(wake("cp-blocked"), /blockers: migration needs owner sign-off/);
	assert.deepEqual([f.job("cp-planq")?.phase, f.job("cp-planq")?.planner_blocked_rounds], ["waiting", 1], "a blocked planner waits for an answer");
	for (const text of [/Which store\?/, /SQLite/, /Which TTL\?/]) assert.match(wake("cp-planq"), text);
	assert.ok(!wake("cp-planq").includes(join(outside, "planq.md")), "the artifact path is not the headline");
	assert.equal(f.job("cp-round")?.phase, "waiting");
	assert.match(wake("cp-round"), /do not answer these blockers/, "the third round escalates");
	assert.match(wake("cp-round"), /es-[0-9a-z]+/);
	assert.match(wake("cp-round"), /Which store\?/);
	assert.deepEqual([f.job("cp-quiet")?.phase, f.job("cp-quiet")?.reported_at], ["waiting", undefined], "nothing on disk yet is not an error");

	rpc.endInput(); await rpc.close();
	const stamps = () => reported.map((id) => [id, f.job(id)?.reported_at, f.job(id)?.receipts, f.job(id)?.planner_blocked_rounds]);
	const before = stamps();
	const again = await f.start();
	assert.deepEqual(await f.wakes(again), [], "a second start reports nothing again");
	assert.deepEqual(stamps(), before, "and restamps nothing");
	for (const id of reported) assert.equal(readRunEvents(f.home, id).filter((event) => event.type === "envelope_received").length, 1, id);
	again.endInput(); await again.close();
});

test("P9f-intake-board: a board envelope publishes its site at the viewer's address, and bad boards are refused with a reason", { timeout: 150_000 }, async (t) => {
	const f = await fixture(t);
	const board = async (id: string, defect?: "json" | "date" | "link" | "traverse" | "fifo") => {
		await f.add(id, "research", "board");
		const source = join(f.home, paths.artifactDir(id));
		mkdirSync(join(source, "site"), { recursive: true });
		writeFileSync(join(source, "board.json"), defect === "json" ? "{bad"
			: JSON.stringify({ title: "Status", description: "Current jobs", job_ids: [id], created_at: defect === "date" ? "yesterday" : isoTimestamp() }));
		writeFileSync(join(source, "site/index.html"), "<h1>Status</h1>");
		if (defect === "link") {
			writeFileSync(join(f.home, "outside.html"), "secret");
			symlinkSync(join(f.home, "outside.html"), join(source, "site/escape.html"));
		}
		if (defect === "fifo") execFileSync("mkfifo", [join(source, "site/pipe")]);
		f.envelope(id, { kind: "research", status: "done", summary: "Status board published.",
			artifact_path: defect === "traverse" ? join(source, "..", "board.json") : join(source, "board.json") });
	};
	const published = (id: string) => existsSync(join(f.home, LAYOUT.state, "boards", id));
	const bad = { "cp-json": /malformed JSON/, "cp-date": /created_at/, cp_bad: /board slug/, "cp-link": /resolves outside/, "cp-traverse": /artifact_path must be/,
		"cp-fifo": /not a regular file or directory/ } as const;
	await board("cp-board");
	for (const id of Object.keys(bad)) await board(id, id === "cp_bad" ? undefined : id.slice(3) as "json");
	const configured = await f.start({ CP_VIEWER_HOST: "127.0.0.2", CP_VIEWER_PORT: "9911" });
	await waitFor(() => f.job("cp-board")?.phase, (phase) => phase === "held", { timeoutMs: 30_000, what: "the board accepted" });
	const url = "http://127.0.0.2:9911/boards/cp-board/";
	assert.deepEqual(f.job("cp-board")?.receipts?.find((r) => r.kind === "board"), { kind: "board", status: "published", title: "board for cp-board", url },
		"the board url survives as a durable receipt, not only the one-time wake text");
	assert.match((await f.wakes(configured)).join("\n"), /board: http:\/\/127\.0\.0\.2:9911\/boards\/cp-board\//);
	assert.match((await f.wakes(configured)).join("\n"), /cp-board reported done \(research\/board\) → teardown/);
	assert.equal(readFileSync(join(f.home, LAYOUT.state, "boards/cp-board/site/index.html"), "utf8"), "<h1>Status</h1>");
	await waitFor(() => JSON.stringify(configured.records()), (evidence) => Object.values(bad).every((reason) => reason.test(evidence)),
		{ timeoutMs: 30_000, what: "every bad board refused with its reason" });
	for (const id of Object.keys(bad)) {
		assert.equal(f.job(id)?.reported_at, undefined, `${id} is refused`);
		assert.equal(published(id), false, `${id} publishes nothing`);
	}
	configured.endInput(); await configured.close();

	// No configured viewer: the url is the tailnet address the viewer binds, and with no tailnet the board is refused.
	const bin = join(f.home, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "tailscale"), "#!/bin/sh\necho 100.64.9.9\n");
	chmodSync(join(bin, "tailscale"), 0o755);
	await board("cp-tailnet");
	const tailnet = await f.start({ PATH: `${bin}:${process.env.PATH ?? ""}` });
	await waitFor(() => f.job("cp-tailnet")?.receipts?.find((r) => r.kind === "board")?.url, (found) => found !== undefined, { timeoutMs: 30_000, what: "the tailnet board" });
	assert.equal(f.job("cp-tailnet")?.receipts?.find((r) => r.kind === "board")?.url, "http://100.64.9.9:8766/boards/cp-tailnet/", "never the loopback default");
	tailnet.endInput(); await tailnet.close();
	writeFileSync(join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
	await board("cp-no-tailnet");
	const none = await f.start({ PATH: `${bin}:${process.env.PATH ?? ""}` });
	await waitFor(() => JSON.stringify(none.records()), (evidence) => /cp-no-tailnet[\s\S]*require-tailnet/.test(evidence), { timeoutMs: 30_000, what: "the no-tailnet refusal" });
	assert.equal(f.job("cp-no-tailnet")?.reported_at, undefined, "never silently defaulted");
	none.endInput(); await none.close();
});
