/**
 * Behavior 10 (P11): a Q&A answer reaches the operator through a real pi parent (command-post extension, mock model).
 * cp_ask dispatches a real read-only worker that writes the answer and reports; the consumers are the parent's
 * answer-card drain (intake, session_start, widget tick), its RPC notice, the outbox file and the job's run log.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { AnswerCardOutbox } from "../../src/answer-delivery.ts";
import { CommandPost } from "../../src/command-post.ts";
import { ANSWER_CARD_DEFER_SECONDS, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION, validateAnswerCardOutboxFile } from "../../src/contracts.ts";
import { initJobsDocument, Ledger, readJobsDocument } from "../../src/ledger.ts";
import {
	buildPiArgs,
	COMMAND_POST_EXTENSION,
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	enableTreehouse,
	MockProvider,
	type PiChild,
	readFleet,
	readRunEvents,
	REPO_ROOT,
	type RpcRecord,
	type ScriptStep,
	startPiChild,
	startRpc,
	treehouseAvailable,
	waitFor,
} from "../harness/index.ts";

const SKIP = treehouseAvailable() ? false : "P11 needs treehouse on PATH";
const MARKER = "SECRET-BODY-MARKER-ONLY-IN-THE-ARTIFACT";
const ANSWER = `# Where is the config read?\n\nsrc/config.ts, at startup.\n${MARKER}\n`;
const HEADLINE = "The config is read from src/config.ts at startup.";
const QUESTION = "Where is the config read?";

type Home = ReturnType<typeof createScratchHome>;

const notices = (pi: { records(): readonly RpcRecord[] }, jobId: string) =>
	pi.records().filter((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).startsWith(`answer for ${jobId}:`));
const indexOf = (pi: PiChild, record: RpcRecord | undefined) => (record ? pi.records().indexOf(record) : -1);
const toolEnd = (pi: PiChild, id: string) => pi.records().find((r) => r.type === "tool_execution_end" && r.toolCallId === id);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jobIds = (home: string) => readJobsDocument(home).jobs.map((job) => job.id);
const outbox = (home: string) => new AnswerCardOutbox({ home }).read();

/** A registered `demo` clone with a treehouse pool, on a fresh ledger. */
async function project(t: TestContext, home: Home): Promise<void> {
	initJobsDocument(home.path, "cp");
	const repo = createScratchRepo({ name: "demo", files: { "README.md": "# demo\n", "src/config.ts": "export const config = {};\n" } });
	const seed = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	await seed.registry.register({ name: "demo", clone_url: repo.remote as string, delivery: "local" });
	const clone = seed.registry.pathOf("demo");
	await seed.shutdown();
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	const pool = enableTreehouse(clone, { maxTrees: 3 });
	mkdirSync(join(home.path, LAYOUT.data), { recursive: true });
	writeFileSync(join(home.path, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*"], rubric: [] }));
	t.after(() => { pool.cleanup(); repo.cleanup(); });
}

/** The read-only worker: writes its answer at the predeclared path, then reports through report_result. */
function answerWorker(home: string, nth: number): ScriptStep[] {
	const job = () => jobIds(home)[nth] as string;
	return [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ANSWER}EOF` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: job(), kind: "research", status: "done", summary: HEADLINE, artifact_path: join(home, paths.artifactFile(job())) }) }] },
		{ kind: "text", text: "Reported." },
		// A promotion reopens the slot: the second report is a new envelope generation.
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: job(), kind: "research", status: "done", summary: HEADLINE, artifact_path: join(home, paths.artifactFile(job())) }) }] },
		{ kind: "text", text: "Reported again." },
	];
}

test("P11-answer: an answer queued mid-turn and torn down seconds later reaches the operator once, as a pointer; a blocked answer mints none", { skip: SKIP, timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	await project(t, home);
	const cards = join(home.path, LAYOUT.answerCardsFile);
	const queued = join(home.path, "queued-cards.json");
	const first = () => jobIds(home.path)[0] as string;
	const provider = await MockProvider.start();
	const worker = provider.addScript("p11-answer-worker", answerWorker(home.path, 0), { onExhausted: "repeat" });
	const blocked = provider.addScript("p11-blocked-worker", [
		{ kind: "tool_calls", calls: [{ name: "bash", args: { command: `cat > "$CP_ARTIFACT_PATH" <<'EOF'\n${ANSWER}EOF` } }] },
		{ kind: "tool_calls", calls: [{ name: "report_result", args: () => ({ job_id: jobIds(home.path)[1], kind: "research", status: "blocked", summary: "The question is a plan, not an answer.", blockers: ["needs a research job"], artifact_path: join(home.path, paths.artifactFile(jobIds(home.path)[1] as string)) }) }] },
		{ kind: "text", text: "Blocked." },
	], { onExhausted: "repeat" });
	// The parent waits inside one turn until intake has queued the card, promotes the worker into a second report,
	// then tears the job down: the cp-n9jh order, twice over.
	const waitCard = (generation: number, copy = "") =>
		`for i in $(seq 300); do grep -q '"${first()}#${generation}"' "${cards}" 2>/dev/null ${copy}&& break; sleep 0.2; done; sleep 2`;
	const parent = provider.addScript("p11-answer-parent", [
		{ kind: "tool_calls", calls: [{ id: "ask", name: "cp_ask", args: { project: "demo", question: QUESTION, model: worker } }] },
		{ kind: "tool_calls", calls: [{ id: "wait", name: "bash", args: () => ({ command: waitCard(1, `&& cp "${cards}" "${queued}" `) }) }] },
		{ kind: "tool_calls", calls: [{ id: "promote", name: "cp_send", args: () => ({ job_id: first(), message: "Tighten the answer and report again." }) }] },
		{ kind: "tool_calls", calls: [{ id: "wait-again", name: "bash", args: () => ({ command: waitCard(2) }) }] },
		{ kind: "tool_calls", calls: [{ id: "teardown", name: "cp_teardown", args: () => ({ job_id: first() }) }] },
		{ kind: "text", text: "Answered and torn down." },
	], { onExhausted: "repeat" });
	const restarted = provider.addScript("p11-answer-restarted", [
		{ kind: "tool_calls", calls: [{ id: "ask-blocked", name: "cp_ask", args: { project: "demo", question: "Plan the whole migration?", model: blocked } }] },
		{ kind: "tool_calls", calls: [{ id: "wait-blocked", name: "bash", args: () => ({ command: `for i in $(seq 900); do [ -f "${join(home.path, paths.envelopeFile(jobIds(home.path)[1] as string))}" ] && break; sleep 0.2; done; sleep 2` }) }] },
		{ kind: "tool_calls", calls: [{ id: "teardown-blocked", name: "cp_teardown", args: () => ({ job_id: jobIds(home.path)[1] }) }] },
		{ kind: "text", text: "It is blocked." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); });
	const open = (model: string) => {
		const pi = startPiChild({ cwd: home.path, model, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
		t.after(() => pi.close().then(() => undefined));
		return pi;
	};

	const pi = open(parent);
	await pi.getState(30_000);
	await pi.prompt(`Ask demo: ${QUESTION}`);
	await pi.waitForSettled(180_000);
	const job = first();
	for (const id of ["ask", "wait", "promote", "wait-again", "teardown"]) assert.notEqual(toolEnd(pi, id)?.isError, true, JSON.stringify(toolEnd(pi, id)));
	assert.equal(readFleet(home.path).jobs.find((record) => record.job_id === job)?.phase, "done", "torn down inside the turn");

	const [notice, second] = await waitFor(() => notices(pi, job), (shown) => shown.length === 2, { timeoutMs: 20_000, what: "one notice per envelope generation" });
	assert.ok(indexOf(pi, notice) > indexOf(pi, toolEnd(pi, "teardown")), "the card waited out the turn and survived the teardown");
	assert.equal(String(second?.message), String(notice?.message), "the promoted report's card points at the same stored answer");
	const stored = join(home.path, paths.artifactFile(job));
	assert.equal(String(notice?.message), `answer for ${job}: ${stored} (${Buffer.byteLength(ANSWER)} B) — open it yourself; the card needs a terminal`);
	assert.equal(readFileSync(stored, "utf8"), ANSWER, "intake stored the answer the card points at");

	// The outbox as it stood mid-turn, copied by the parent's own wait: one pending pointer and headline, no body.
	const raw = readFileSync(queued, "utf8");
	assert.ok(!raw.includes(MARKER), "the outbox never holds the body");
	const parsed = validateAnswerCardOutboxFile(JSON.parse(raw));
	assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
	assert.deepEqual(parsed.ok && parsed.value.pending.map((card) => [card.id, card.path, card.bytes, card.summary]), [[`${job}#1`, stored, Buffer.byteLength(ANSWER), HEADLINE]]);
	assert.ok(!readFileSync(cards, "utf8").includes(MARKER));
	assert.deepEqual(outbox(home.path).pending, []);
	assert.deepEqual(outbox(home.path).delivered.map((entry) => [entry.id, entry.channel]), [[`${job}#1`, "notice"], [`${job}#2`, "notice"]]);
	const events = readRunEvents(home.path, job);
	assert.deepEqual(events.filter((event) => event.type === "answer_card_queued").map((event) => (event.payload as { generation?: number }).generation), [1, 2]);
	const delivered = events.filter((event) => event.type === "answer_card_delivered");
	assert.deepEqual(delivered.map((event) => (event.payload as { channel?: string }).channel), ["notice", "notice"]);
	// The worker's own tool calls are logged as it made them; the card's events carry the pointer only.
	assert.ok(!JSON.stringify(events.filter((event) => event.type.startsWith("answer_card"))).includes(MARKER), "card events never hold the body");

	await sleep(6_000);
	assert.equal(notices(pi, job).length, 2, "a later widget tick shows nothing again");
	await pi.close();

	// A restarted parent drains at session_start and on its tick; the delivered card is history.
	const again = open(restarted);
	await again.getState(30_000);
	await sleep(6_000);
	assert.equal(notices(again, job).length, 0, "a delivered card is never resurrected");
	await again.prompt("Ask demo for a plan.");
	await again.waitForSettled(180_000);
	const plan = jobIds(home.path)[1] as string;
	assert.notEqual(toolEnd(again, "ask-blocked")?.isError, true, JSON.stringify(toolEnd(again, "ask-blocked")));
	await waitFor(() => readFleet(home.path).jobs.find((record) => record.job_id === plan)?.reported_at, Boolean, { timeoutMs: 30_000, what: "the blocked envelope" });
	assert.equal(readFleet(home.path).jobs.find((record) => record.job_id === plan)?.receipts?.some((receipt) => receipt.kind === "artifact"), true, "the blocked report names an artifact");
	await sleep(6_000);
	assert.equal(notices(again, plan).length, 0, "a blocked Q&A job owes a blocker, not a card");
	assert.deepEqual([...outbox(home.path).pending, ...outbox(home.path).delivered].map((entry) => entry.id), [`${job}#1`, `${job}#2`]);
	// cp-n9jh's premise: the envelope wake-up, checked after the same-turn teardown, is superseded, never delivered.
	assert.notEqual(toolEnd(again, "teardown-blocked")?.isError, true, JSON.stringify(toolEnd(again, "teardown-blocked")));
	const stale = await waitFor(() => readRunEvents(home.path, plan).filter((event) => event.type === "wakeup_suppressed"),
		(found) => found.length > 0, { timeoutMs: 20_000, what: "the envelope wake-up suppressed after teardown" });
	assert.match(String((stale[0]?.payload as { reason?: string }).reason), new RegExp(`${plan} is already done: the delivery landed`));
	const told = provider.requests("p11-answer-restarted").filter((request) => JSON.stringify(request.body).includes(`${plan} reported blocked`));
	assert.deepEqual(told, [], "the parent model is never told to act on a torn-down job");
});

test("P11-headless: a surface-less re-entry delivers only scheduled answers; the operator's session takes the rest, idle first but never past the defer window", { timeout: 240_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	initJobsDocument(home.path, "cp");
	const ledger = new Ledger({ home: home.path });
	const job = async (title: string, labels: string[] = []) => (await ledger.create({ title, project: "demo", kind: "research", delivery: "answer", labels })).id;
	const plain = await job("Question");
	const scheduled = await job("Digest", ["schedule:sch-aaaaaa"]);
	const overdue = await job("Long-waiting question");
	const fresh = await job("Fresh question");
	const queue = (jobId: string, queuedAt?: Date) => {
		mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
		const path = join(home.path, paths.artifactFile(jobId));
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, ANSWER);
		const cards = new AnswerCardOutbox({ home: home.path, ...(queuedAt ? { now: () => queuedAt } : {}) });
		assert.equal(cards.enqueue({ job_id: jobId, project: "demo", generation: 1, summary: HEADLINE, path, bytes: Buffer.byteLength(ANSWER), reported_at: isoTimestamp() }), true);
	};
	queue(plain);
	queue(scheduled);
	const provider = await MockProvider.start();
	const headless = provider.addScript("p11-headless", [{ kind: "text", text: "Nothing to do." }], { onExhausted: "repeat" });
	const operator = provider.addScript("p11-operator", [
		{ kind: "tool_calls", calls: [{ id: "busy", name: "bash", args: { command: "sleep 9" } }] },
		{ kind: "text", text: "Done waiting." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); });
	const env = { ...agent.env, CP_HOME: home.path };

	// A print-mode re-entry has no operator surface: it may not consume the answer the operator's terminal owes.
	const print = startRpc({ cwd: home.path, mode: "json", env, args: buildPiArgs({ cwd: home.path, model: headless, extensions: [COMMAND_POST_EXTENSION], extraArgs: ["--print", "status?"] }) });
	t.after(() => print.close().then(() => undefined));
	print.endInput();
	await print.waitFor((r) => r.type === "agent_end", 60_000);
	await print.close();
	assert.deepEqual(outbox(home.path).pending.map((card) => card.job_id), [plain], "the plain answer is still owed");
	assert.deepEqual(outbox(home.path).delivered.map((entry) => [entry.job_id, entry.channel]), [[scheduled, "schedules_page"]], "a scheduled answer needs no operator surface");
	const scheduledEvents = readRunEvents(home.path, scheduled).filter((event) => event.type === "answer_card_delivered");
	assert.deepEqual(scheduledEvents.map((event) => (event.payload as { channel?: string }).channel), ["schedules_page"]);
	assert.equal(validateAnswerCardOutboxFile(JSON.parse(readFileSync(join(home.path, LAYOUT.answerCardsFile), "utf8"))).ok, true, "the outbox accepts the schedules_page channel");

	const pi = startPiChild({ cwd: home.path, model: operator, env, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => pi.close().then(() => undefined));
	await waitFor(() => notices(pi, plain), (shown) => shown.length === 1, { timeoutMs: 30_000, what: "the owed answer at session_start" });
	assert.equal(notices(pi, scheduled).length, 0, "a scheduled answer never reaches the operator transcript");
	assert.deepEqual(outbox(home.path).delivered.map((entry) => [entry.job_id, entry.channel]), [[scheduled, "schedules_page"], [plain, "notice"]]);

	// Mid-turn, a card queued past the defer window is released by the tick; a fresh one waits for idle.
	await pi.prompt("Wait a while.");
	await pi.waitFor((r) => r.type === "tool_execution_start" && r.toolCallId === "busy", 30_000);
	queue(overdue, new Date(Date.now() - (ANSWER_CARD_DEFER_SECONDS + 10) * 1000));
	queue(fresh);
	await pi.waitForSettled(60_000);
	const busyEnd = indexOf(pi, toolEnd(pi, "busy"));
	assert.ok(busyEnd > 0);
	assert.ok(indexOf(pi, notices(pi, overdue)[0]) > 0 && indexOf(pi, notices(pi, overdue)[0]) < busyEnd, "an overdue card is delivered mid-turn");
	const [late] = await waitFor(() => notices(pi, fresh), (shown) => shown.length > 0, { timeoutMs: 20_000, what: "the fresh card once idle" });
	assert.ok(indexOf(pi, late) > busyEnd, "a fresh card waits for the session to be idle");
	assert.deepEqual(outbox(home.path).pending, []);
});

const toolText = (pi: PiChild, id: string) => JSON.stringify((toolEnd(pi, id) as { result?: unknown } | undefined)?.result ?? null);
const toolJson = (pi: PiChild, id: string) =>
	JSON.parse(((toolEnd(pi, id) as { result?: { content?: { text?: string }[] } } | undefined)?.result?.content?.[0]?.text) ?? "null") as Record<string, unknown>;

test("P11-artifact: cp_artifact predeclares, files and exports a job's report by reference, failing closed; /watch points at it", { timeout: 120_000 }, async (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	for (const job of ["cp-known", "cp-refused"]) mkdirSync(join(home.path, paths.runDir(job)), { recursive: true });
	writeFileSync(join(home.path, paths.runDir("cp-known"), "events.jsonl"), "");
	// The parent runs in a subdirectory, so relative files must resolve against its cwd, not the home.
	const cwd = join(home.path, "work");
	mkdirSync(join(cwd, "dir"), { recursive: true });
	writeFileSync(join(cwd, "notes.md"), `# findings\n${MARKER}\n`);
	writeFileSync(join(cwd, "empty.md"), "");
	const stored = join(home.path, paths.artifactFile("cp-known"));
	const call = (id: string, args: Record<string, unknown>): ScriptStep => ({ kind: "tool_calls", calls: [{ id, name: "cp_artifact", args }] });
	const provider = await MockProvider.start();
	const parent = provider.addScript("p11-artifact-parent", [
		call("path", { action: "path", job_id: "cp-fresh" }),
		call("path-again", { action: "path", job_id: "cp-fresh" }),
		call("path-unsafe", { action: "path", job_id: "../escape" }),
		call("add-stranger", { action: "add", job_id: "cp-stranger", file: "notes.md" }),
		call("add-missing", { action: "add", job_id: "cp-refused", file: "nope.md" }),
		call("add-dir", { action: "add", job_id: "cp-refused", file: "dir" }),
		call("add-empty", { action: "add", job_id: "cp-refused", file: "empty.md" }),
		call("add", { action: "add", job_id: "cp-known", file: "notes.md" }),
		call("add-self", { action: "add", job_id: "cp-known", file: stored }),
		call("get", { action: "get", job_id: "cp-known", out: "handoff/task.md" }),
		call("get-no-out", { action: "get", job_id: "cp-known" }),
		call("get-blank", { action: "get", job_id: "cp-known", out: "  " }),
		call("get-missing", { action: "get", job_id: "cp-missing", out: "out.md" }),
		call("get-store", { action: "get", job_id: "cp-known", out: join(home.path, paths.artifactDir("cp-other"), "copy.md") }),
		call("get-dir", { action: "get", job_id: "cp-known", out: "dir" }),
		{ kind: "text", text: "Filed." },
	], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); });
	const pi = startPiChild({ cwd, model: parent, env: { ...agent.env, CP_HOME: home.path }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(() => pi.close().then(() => undefined));
	await pi.getState(30_000);
	await pi.prompt("File the report.");
	await pi.waitForSettled(60_000);

	const fresh = join(home.path, paths.artifactFile("cp-fresh"));
	assert.deepEqual(toolJson(pi, "path"), { job_id: "cp-fresh", path: fresh });
	assert.deepEqual(toolJson(pi, "path-again"), { job_id: "cp-fresh", path: fresh }, "predeclaring twice is a re-dispatch");
	assert.ok(existsSync(join(home.path, paths.artifactDir("cp-fresh"))), "path creates the directory");
	const refused = (id: string, pattern: RegExp) => {
		assert.equal(toolEnd(pi, id)?.isError, true, `${id} must fail closed: ${toolText(pi, id)}`);
		assert.match(toolText(pi, id), pattern, id);
	};
	refused("path-unsafe", /unsafe job id/);
	refused("add-stranger", /unknown job cp-stranger/);
	refused("add-missing", /does not exist/);
	refused("add-dir", /is not a file/);
	refused("add-empty", /is empty/);
	assert.equal(existsSync(join(home.path, paths.artifactFile("cp-refused"))), false, "a refused add stores nothing");

	const added = toolJson(pi, "add");
	assert.deepEqual([added.copied, added.path, added.source, added.bytes], [true, stored, join(cwd, "notes.md"), Buffer.byteLength(`# findings\n${MARKER}\n`)]);
	assert.match(String(added.modified_at), /Z$/);
	assert.equal(readFileSync(stored, "utf8"), `# findings\n${MARKER}\n`, "add files the report by copy");
	assert.deepEqual([toolJson(pi, "add-self").copied, toolJson(pi, "add-self").bytes], [false, added.bytes], "the predeclared path is not self-copied");

	const out = join(cwd, "handoff/task.md");
	assert.deepEqual(toolJson(pi, "get"), { job_id: "cp-known", out, bytes: added.bytes, source: stored });
	assert.equal(readFileSync(out, "utf8"), `# findings\n${MARKER}\n`);
	refused("get-no-out", /needs `out`/);
	refused("get-blank", /an output file is required/);
	refused("get-missing", /no artifact for cp-missing/);
	refused("get-store", /artifact store/);
	refused("get-dir", /is a directory/);
	assert.equal(JSON.stringify(pi.records()).includes(MARKER), false, "no tool result or record carries the body");
	assert.equal(provider.requests("p11-artifact-parent").some((request) => JSON.stringify(request.body).includes(MARKER)), false, "the parent model never sees it");

	// /watch stats the stored report (path and size) without reading it; a job with no report gets no pointer.
	const watch = async (job: string) => {
		pi.send({ id: `watch-${job}`, type: "prompt", message: `/watch ${job}` });
		await pi.waitFor((r) => r.type === "response" && r.id === `watch-${job}`, 30_000);
		return pi.records().filter((r) => r.type === "extension_ui_request" && String(r.message ?? "").includes(job)).map((r) => String(r.message)).join("\n");
	};
	assert.ok((await watch("cp-known")).includes(`plan: /cp-plan cp-known (${added.bytes} bytes, ${stored})`));
	assert.equal((await watch("cp-refused")).includes("plan: /cp-plan"), false);
});
