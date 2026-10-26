/**
 * Behavior 18 (P18): what cp_status_block, /status and the fleet widget tell the operator about jobs, through a real
 * pi parent with the command-post extension and a mock model. Fleet, ledger, run status and CI facts are seeded on disk.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { FleetStore } from "../../src/fleet.ts";
import { initialStatus } from "../../src/run-artifacts.ts";
import { MAX_CELL_CHARS, MAX_LABEL_CHARS } from "../../src/status-block.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, createScratchLedger, MockProvider, type PiChild, type ScriptStep, startPiChild, waitFor } from "../harness/index.ts";

const HEAD = "d48a81dfeedfacecafe0000000000000000ab12";
const SHORT = HEAD.slice(0, 7);
const ago = (minutes: number) => isoTimestamp(new Date(Date.now() - minutes * 60_000));

type Over = Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<FleetRecord["worker"]> };
function record({ worker, ...rest }: Over): FleetRecord {
	return {
		project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "waiting", worktree: `/nonexistent/${rest.job_id}`, branch: rest.job_id,
		dispatched_at: ago(4), usage: { ...EMPTY_USAGE }, ...rest,
		worker: { pid: 2 ** 22 + 1, session_id: `s-${rest.job_id}`, session_file: `/nonexistent/${rest.job_id}.jsonl`, profile: "implementer", role: "implementer",
			model: "anthropic/claude-sonnet-5", started_at: ago(4), ...worker },
	} as FleetRecord;
}

function put(home: string, rel: string, value: unknown): void {
	mkdirSync(dirname(join(home, rel)), { recursive: true });
	writeFileSync(join(home, rel), JSON.stringify(value));
}

/** A live job: this test process's pid, and a run status that says what its worker is doing. */
function live(home: string, over: Over, phase = "working"): FleetRecord {
	put(home, paths.statusFile(over.job_id), { ...initialStatus(over.job_id, {}, ago(4)), phase, usage: over.usage ?? EMPTY_USAGE });
	return record({ ...over, worker: { pid: process.pid } });
}

async function parent(t: TestContext, home: string, steps: ScriptStep[]): Promise<PiChild> {
	const provider = await MockProvider.start();
	const model = provider.addScript("p18-status", steps);
	const agentDir = createAgentDir({ provider });
	const child = startPiChild({ cwd: home, model, env: { ...agentDir.env, CP_HOME: home }, extensions: [COMMAND_POST_EXTENSION] });
	t.after(async () => {
		await child.close();
		agentDir.cleanup();
		await provider.stop();
	});
	return child;
}

const block = (args: Record<string, unknown>): ScriptStep => ({ kind: "tool_calls", calls: [{ name: "cp_status_block", args }] });
const DONE: ScriptStep = { kind: "text", text: "Status rendered." };
/** One prompt; resolves once `blocks` cp_status_block results have landed and the turn settled. */
async function turn(child: PiChild, blocks: number): Promise<void> {
	await child.prompt("Render the status block.");
	await waitFor(() => results(child).length, (n) => n >= blocks, { timeoutMs: 90_000, what: `${blocks} status blocks` });
	await child.waitForSettled(120_000);
}
const results = (child: PiChild) => child.eventsOfType("tool_execution_end").filter((end) => end.toolName === "cp_status_block")
	.map((end) => ({ error: end.isError === true, text: (end.result as { content: { text: string }[] }).content[0]!.text }));
const section = (text: string, heading: string) => text.split(`${heading}:\n`)[1]?.split("\n\n")[0]?.split("\n") ?? [];

test("P18-status-block: cp_status_block renders In progress, With the team, Blocked, Awaiting you and Shipped from disk plus caller judgment", { timeout: 180_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const fleet = new FleetStore({ home });
	const { ledger } = createScratchLedger({ home, knownProjects: ["demo"] });
	const create = async (title: string) => (await ledger.claim((await ledger.create({ project: "demo", title, kind: "ship", delivery: "pr" })).id, "cp-test")).id;
	const titled = await create("Add the retry ladder");
	const labelled = await create("A ledger title nobody reads");
	const done = (job_id: string, receipt: object, over: Partial<FleetRecord> = {}) => record({ job_id, phase: "done", closed_at: ago(1), reported_at: ago(1),
		worker: { exited_at: ago(1), exit_code: 0 }, receipts: [{ kind: "pr", status: "open", title: "p", ...receipt }] as FleetRecord["receipts"], ...over });
	const parking = (job_id: string, extra = {}) => record({ job_id, phase: "awaiting_merge", reported_at: ago(121), worker: { exited_at: ago(120), exit_code: 0 },
		awaiting_merge: { cycle: 1, pr_url: "https://github.com/acme/demo/pull/9", repo: "acme/demo", branch: job_id, head_sha: "d".repeat(40), base: "main",
			handed_at: ago(120), released_at: ago(120), frozen_seconds: 60, frozen_usage: { ...EMPTY_USAGE }, ...extra } } as Over);
	const LONG_WHY = "y".repeat(MAX_CELL_CHARS);
	const child = await parent(t, home, [
		block({ width: 200 }), DONE,
		block({ width: 200 }), DONE,
		block({ width: 200, labels: [{ job_id: "cp-long", label: "x".repeat(MAX_LABEL_CHARS + 1) }] }),
		block({ width: 200, awaiting: [{ type: "design", decision: "Postgres or sqlite?", why: "y".repeat(MAX_CELL_CHARS + 1), blocks: "b" }] }),
		block({
			width: 200,
			labels: [{ job_id: labelled, label: "dispatch tool" }, { job_id: "cp-long", label: "x".repeat(MAX_LABEL_CHARS) }],
			blocked: [{ job_id: "cp-dep", waiting_on: "cp-base to merge first" }],
			awaiting: [{ type: "design", decision: "Postgres or sqlite?", why: LONG_WHY, blocks: "cp-db" }, { type: "authorization", decision: "Ship the sweep?", why: "w", blocks: "b", job_id: "cp-x" }],
		}), DONE,
		block({ width: 200 }),
		block({ width: 20, labels: [{ job_id: "cp-parked", label: "a reasonably descriptive label" }] }), DONE,
	]);
	await turn(child, 1);
	await fleet.add(live(home, { job_id: titled, usage: { ...EMPTY_USAGE, total_tokens: 12_300, cost_usd: 0.42 }, routing: { scope: "M", risk: "high", thinking: "high", inferred: true } }));
	await turn(child, 2);
	for (const over of [{ job_id: labelled }, { job_id: "cp-legacy" }, { job_id: "cp-long" }, { job_id: "cp-dep" },
		{ job_id: "cp-explicit", routing: { scope: "S", risk: "low", thinking: "minimal", inferred: false } },
		{ job_id: "cp-defaulted", routing: { scope: "S", risk: "low", thinking: "medium", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } } },
		{ job_id: "cp-mixed", routing: { scope: "M", risk: "high", thinking: "high", inferred: true, provenance: { scope: "explicit", risk: "inferred" } } }] as Over[]) {
		await fleet.add(live(home, over));
	}
	await fleet.add(record({ job_id: "cp-dead", phase: "failed", failure: { class: "crash", message: "pid no longer exists", at: ago(2) }, worker: { exited_at: ago(2), exit_code: 1 } }));
	put(home, paths.statusFile("cp-dead"), { ...initialStatus("cp-dead", {}, ago(4)), phase: "exited", exited_at: ago(2), exit_code: 1 });
	await fleet.add(done("cp-shipped", { url: "https://github.com/acme/repo/pull/42" }));
	await fleet.add(done("cp-board", { kind: "board", status: "published", url: "http://100.64.0.1:8766/boards/cp-board/" }, { kind: "research", delivery: "board" }));
	await fleet.add(done("cp-forced", { url: "https://github.com/acme/repo/pull/7" }, { closed_reason: "forced", worker: { ...record({ job_id: "x" }).worker, exited_at: ago(1), exit_code: null } }));
	await fleet.add(done("cp-gated", { url: "https://github.com/acme/repo/pull/8" }, { closed_reason: "gated" }));
	await fleet.add(parking("cp-parked"));
	await fleet.add(parking("cp-pend", { pending: { kind: "changes_requested", event_id: "PRR_1", observed_at: ago(1) } }));
	await turn(child, 5);
	await turn(child, 7);
	const [empty, first, longLabel, longCell, full, again, narrow] = results(child);

	assert.equal(empty?.text, ["In progress: none", "", "Blocked: none", "", "Awaiting you: none", "", "Shipped: none"].join("\n"), "an empty home: four one-line sections");
	assert.match(first!.text, new RegExp(`- ${titled} — Add the retry ladder {2}\\(demo · claude-sonnet-5 · M\\?/high\\? · high · working \\(waiting\\) · 4m · 12\\.3k \\$0\\.42\\)`));
	assert.match(first!.text, /^Shipped: none$/m, "In progress filled, other sections still collapse to one line");
	assert.deepEqual([longLabel?.error, longCell?.error], [true, true], "an over-long label or cell is refused at the tool boundary");
	assert.ok(full && !full.error, JSON.stringify(full));
	const text = full.text;
	const row = (id: string) => text.split("\n").find((line) => line.startsWith(`  - ${id} `)) ?? `no row for ${id}`;
	assert.match(row(labelled), new RegExp(`^  - ${labelled} — dispatch tool `), "a caller label wins over the ledger title");
	assert.doesNotMatch(text, /A ledger title nobody reads/);
	assert.match(row("cp-legacy"), /^ {2}- cp-legacy — cp-legacy {2}\(demo · claude-sonnet-5 · — · — · working \(waiting\)/, "no title: the bare id; no routing: —");
	assert.match(row("cp-explicit"), /· S\/low · minimal · working \(waiting\)/);
	assert.match(row("cp-defaulted"), /· -\/- · medium ·/, "a defaulted axis is never shown as chosen");
	assert.match(row("cp-mixed"), /· M\/high\? · high ·/);
	assert.match(row("cp-dead"), /\(demo · claude-sonnet-5 · — · — · failed · /);
	assert.doesNotMatch(text, /failed \(failed\)/);
	assert.ok(row("cp-long").length <= MAX_LABEL_CHARS + 120, row("cp-long"));
	assert.match(text, /cp-dep — cp-dep {2}\(waiting on: cp-base to merge first\)/);
	assert.match(text, new RegExp(`\\[design\\] Postgres or sqlite\\? — why: y{20}.* — blocks: cp-db`));
	assert.match(text, /answer with cp_decide \(1 open\)/, "the refused authorization row is never counted open");
	assert.match(text, /Not asked — refused by the awaiting store \(1\); not stored, so cp_decide cannot offer them:/);
	assert.match(text, /cp-x — \[authorization\] Ship the sweep\?/);
	const shipped = text.split("\nShipped:\n")[1]!.split(/\n\n|\nShipped \(/)[0]!.split("\n");
	assert.ok(shipped.includes("  - cp-shipped — cp-shipped: https://github.com/acme/repo/pull/42"), shipped.join("\n"));
	assert.ok(shipped.includes("  - cp-board — cp-board: http://100.64.0.1:8766/boards/cp-board/"), "a research board receipt ships too");
	assert.ok(shipped.includes("  - cp-gated — cp-gated: https://github.com/acme/repo/pull/8"), "a gated teardown still ships");
	assert.ok(!shipped.some((line) => line.includes("cp-forced")), "a forced teardown's open PR is never Shipped");
	assert.match(text, /Shipped \(unverified, forced teardown\):\n {2}- cp-forced.*pull\/7.*forced teardown, PR not confirmed merged/s);
	assert.ok(!text.split("Shipped:")[0]!.includes("cp-shipped"), "a done job is never In progress");
	const team = section(text, "With the team · 1");
	assert.equal(team.length, 1, text);
	assert.match(team[0]!, /^ {2}- cp-parked .*head ddddddd · with the team 2h.*: https:\/\/github\.com\/acme\/demo\/pull\/9$/);
	assert.match(row("cp-pend"), /cp-pend/, "a parked job owing a CP step stays In progress");
	assert.ok(text.indexOf("With the team") < text.indexOf("Blocked:"));
	assert.doesNotMatch(text, /^ {2}\[demo\]$/m, "a single-project block carries no section headers");

	assert.match(again!.text, /Shipped: none new \(3 already reported\)/, "rows already shown this session collapse to a count");
	assert.ok(narrow && !narrow.error);
	assert.doesNotMatch(narrow.text, /a reasonably descriptive label/, "a narrow width drops the label first");
	assert.match(narrow.text, /^ {2}- cp-parked — .*https:\/\/github\.com\/acme\/demo\/pull\/9$/m, "and never the PR url");
});

test("P18-status-projects: a block spanning projects has one [project] section per project in every table", { timeout: 180_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const fleet = new FleetStore({ home });
	const shipped = (job_id: string, project: string) => record({ job_id, project, phase: "done", closed_at: ago(1), reported_at: ago(1), worker: { exited_at: ago(1), exit_code: 0 },
		receipts: [{ kind: "pr", status: "open", title: "p", url: `https://github.com/acme/${project}/pull/1` }] as FleetRecord["receipts"] });
	for (const r of [record({ job_id: "cp-a1", project: "demo-app" }), record({ job_id: "cp-b1", project: "atlas" }), record({ job_id: "cp-a2", project: "demo-app" }),
		shipped("cp-a3", "demo-app"), shipped("cp-b2", "atlas")]) await fleet.add(r);
	const child = await parent(t, home, [block({ width: 200,
		blocked: [{ job_id: "cp-b1", waiting_on: "CI" }, { job_id: "cp-a1", waiting_on: "a dependency" }],
		awaiting: [{ type: "design", decision: "Postgres or sqlite for b1?", why: "schema", blocks: "b1", job_id: "cp-b1" }, { type: "design", decision: "Redis or none for a2?", why: "cache", blocks: "a2", job_id: "cp-a2" }],
	}), DONE]);
	await turn(child, 1);
	const text = results(child)[0]!.text;
	const inProgress = section(text, "In progress");
	assert.deepEqual([inProgress[0], inProgress[3]], ["  [demo-app]", "  [atlas]"], text);
	assert.match(inProgress[1]!, /^ {4}- cp-a1 /);
	assert.match(inProgress[4]!, /^ {4}- cp-b1 /);
	assert.deepEqual(section(text, "Blocked").map((line) => line.trim().split(" ")[0]), ["[atlas]", "-", "[demo-app]", "-"]);
	const awaiting = section(text, "Awaiting you");
	assert.deepEqual([awaiting[0], awaiting[2]], ["  [atlas]", "  [demo-app]"]);
	const shippedLines = section(text, "Shipped");
	assert.equal(shippedLines[0], "  [demo-app]");
	assert.match(shippedLines[1]!, /cp-a3 .*https:\/\/github\.com\/acme\/demo-app\/pull\/1$/);
	assert.equal(shippedLines[2], "  [atlas]");
});

test("P18-status-waits: /status and the fleet widget say what a held PR waits on, read from ci-watch and the job's review", { timeout: 180_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const home = scratch.path;
	const fleet = new FleetStore({ home });
	const session = join(home, "held-session.jsonl");
	writeFileSync(session, "");
	await fleet.add(record({ job_id: "cp-held", phase: "held", reported_at: ago(2), worker: { session_file: session, exited_at: ago(2), exit_code: 0 } }));
	await fleet.add(live(home, { job_id: "cp-working" }));
	const child = await parent(t, home, []);
	const ci = (state?: string, extra = {}) => put(home, LAYOUT.ciWatchFile, { schema_version: SCHEMA_VERSION, updated_at: isoTimestamp(),
		jobs: state ? [{ job_id: "cp-held", head_sha: HEAD, announced: [], last_ci: state, ...extra }] : [] });
	const status = async () => {
		const before = child.records().length;
		await child.prompt("/status");
		const notes = await waitFor(() => child.records().slice(before).filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message)),
			(list) => list.some((m) => m.includes("DRAIN ") && m.includes("cp-held")), { timeoutMs: 20_000, what: "/status output" });
		return notes.find((m) => m.includes("DRAIN ") && m.includes("cp-held"))!;
	};
	const waits = async () => /waiting on: (.*)/.exec(await status())?.[1] ?? null;
	ci();
	const firstStatus = await status();
	assert.equal(/waiting on: (.*)/.exec(firstStatus)?.[1], "a pushed head on origin", firstStatus);
	for (const [state, phrase] of [["in_progress", `CI on ${SHORT}`], ["unknown", `CI on ${SHORT}`], ["superseded", `CI to start on ${SHORT}`],
		["failed", `a fix for red CI on ${SHORT}`], ["green", `review of green ${SHORT}`], ["unreviewed", `review of green ${SHORT}`],
		["no_ci", `review of ${SHORT} (no CI)`], ["a_state_from_the_future", `CI on ${SHORT}`], ["already_merged", null], ["job_gone", null]] as const) {
		ci(state);
		assert.equal(await waits(), phrase, state);
	}
	ci("failed");
	assert.equal((await status()).split("\n").filter((line) => line.includes("waiting on:")).length, 1, "the running job prints no wait line");
	const widget = await waitFor(() => child.records().filter((r) => r.type === "extension_ui_request" && r.method === "setWidget").map((r) => (r.widgetLines as string[] | undefined) ?? []).at(-1) ?? [],
		(lines) => lines.some((line) => line.includes("cp-held") && line.includes("waits:")), { timeoutMs: 30_000, what: "the widget's wait reason" });
	assert.ok(widget.find((line) => line.includes("cp-held"))!.includes(`waits: a fix for red CI on ${SHORT}`), "the whole sha, never clipped");
	assert.ok(!widget.find((line) => line.includes("cp-working"))?.includes("waits:"), "an active row says nothing");

	ci("green");
	put(home, paths.reviewFile("cp-held", 1), { schema_version: SCHEMA_VERSION, job_id: "cp-held", attempt: 1, verdict: "pass", cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["ok"], decided_at: isoTimestamp(), head_sha: HEAD, diff_stat: { files: 3, truncated: false } });
	assert.equal(await waits(), `merge of reviewed ${SHORT}`, "a passing review on that head moves it on to the merge");
	ci("no_ci");
	assert.equal(await waits(), `merge of reviewed ${SHORT}`);

	ci("in_progress");
	put(home, paths.pendingReviewFile("cp-held", "review", 2), { schema_version: SCHEMA_VERSION, job_id: "cp-held", surface: "review", attempt: 2,
		model: "anthropic/claude-sonnet-5", started_at: ago(1), deadline: isoTimestamp(new Date(Date.now() + 20 * 60_000)), handed_back: false });
	const reviewing = await status();
	assert.doesNotMatch(reviewing, /waiting on:/, "a reviewer in flight is not a wait reason");
	assert.match(reviewing, /review 2 running/);
});
