/**
 * Behavior 23 (Memory and guidance), P23: session memory and its curation through a real parent pi on a scratch home —
 * the session-start scaffold and digest, /memory and cp_memory capture, promote, reject, retire and audit — with a mock
 * LLM and the parent's clock pinned by tests/harness/process-clock.ts. Every outcome is read from the tool result or disk.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { LAYOUT } from "../../src/contracts.ts";
import {
	COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type MockToolCall, type PiChild, type RecordedRequest, REPO_ROOT,
	type RpcRecord, type ScriptStep, startPiChild,
} from "../harness/index.ts";

type End = RpcRecord & { toolCallId: string; isError?: boolean; result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } };
const CLOCK = pathToFileURL(join(REPO_ROOT, "tests/harness/process-clock.ts")).href;
const AT = Date.parse("2026-08-27T12:00:00Z");
const DAY = 86_400_000;
const EVIDENCE = "cp-t26; PR #39; src/memory.ts";
const said = (end: End | undefined): string => end?.result?.content?.map((part) => part.text ?? "").join("\n") ?? JSON.stringify(end);
const details = (end: End | undefined): Record<string, unknown> => end?.result?.details ?? {};
const call = (id: string, args: Record<string, unknown>): MockToolCall => ({ id, name: "cp_memory", args });

/** A scratch home whose parents run on a clock pinned to 2026-08-27 noon UTC plus `day` days. */
async function memoryHome(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const clock = join(agent.path, "clock-offset");
	const parents: PiChild[] = [];
	t.after(async () => { for (const child of parents) await child.close(); agent.cleanup(); await provider.stop(); home.cleanup(); });
	const day = (n: number) => writeFileSync(clock, String(AT + n * DAY - Date.now()));
	day(0);
	let serial = 0;
	const path = (relative: string) => join(home.path, relative);
	return {
		home: home.path, day, path,
		read: (relative: string) => (existsSync(path(relative)) ? readFileSync(path(relative), "utf8") : undefined),
		put(relative: string, text: string) {
			mkdirSync(dirname(path(relative)), { recursive: true });
			writeFileSync(path(relative), text);
		},
		/** A parent pi on this home; each `tools` call is one operator prompt whose model makes `calls` one at a time. */
		parent(extraArgs: string[] = []) {
			const steps: ScriptStep[] = [];
			const script = `p23-memory-${++serial}`;
			const model = provider.addScript(script, steps);
			agent.writeModels(provider);
			const child = startPiChild({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION], extraArgs,
				env: { ...agent.env, CP_HOME: home.path, CP_TEST_CLOCK_FILE: clock, NODE_OPTIONS: `--import ${CLOCK}` } });
			parents.push(child);
			const after = (from: number, match: (r: RpcRecord) => boolean) => child.waitFor((r) => child.records().indexOf(r) >= from && match(r), 120_000);
			return {
				child,
				requests: (): readonly RecordedRequest[] => provider.requests(script),
				async tools(calls: MockToolCall[]): Promise<Map<string, End>> {
					steps.push(...calls.map((one): ScriptStep => ({ kind: "tool_calls", calls: [one] })), { kind: "text", text: "P23 parent settled." });
					const from = child.records().length;
					await child.prompt("Curate session memory.");
					await after(from, (r) => r.type === "agent_settled");
					const ends = child.records().slice(from).filter((r) => r.type === "tool_execution_end") as End[];
					return new Map(ends.map((end) => [end.toolCallId, end]));
				},
				/** Send a slash command and return the first notify after it that `match` accepts. */
				async command(message: string, match: (r: RpcRecord) => boolean = () => true): Promise<RpcRecord> {
					const from = child.records().length;
					await child.prompt(message);
					return after(from, (r) => r.type === "extension_ui_request" && r.method === "notify" && match(r));
				},
			};
		},
	};
}

/** The cp-memory digest a parent put into a model request's context, or undefined. */
function digestIn(request: RecordedRequest | undefined): string | undefined {
	for (const message of request?.body.messages ?? []) {
		const content = message.content;
		const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => String((part as { text?: unknown }).text ?? "")).join("") : "";
		if (text.includes("machine-local):") || text.includes("pending candidate(s) — cp_memory curate)")) return text;
	}
	return undefined;
}

/** Check one call's result: `ok` must not be an error, `refused` must be one; either way it matches `pattern`. */
function assertEnd(ends: Map<string, End>, id: string, outcome: "ok" | "refused", pattern: RegExp): End {
	const end = ends.get(id);
	assert.ok(end, `${id}: no tool result`);
	assert.equal(end.isError === true, outcome === "refused", `${id}: ${said(end)}`);
	assert.match(said(end), pattern, id);
	return end;
}

const learnings = (entries: readonly string[], header: string) => `${header}\n${entries.join("\n")}\n`;
const stagingFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".tmp"));

test("P23-memory-start: session start scaffolds memory once, and its digest carries the learnings with their decay, budget and malformed candidates", { timeout: 300_000 }, async (t) => {
	const h = await memoryHome(t);
	const fresh = h.parent();
	const clean = await fresh.tools([call("status", { action: "status" })]);
	assert.deepEqual([details(clean.get("status")).candidates, details(clean.get("status")).malformed_candidates], [0, []], "a clean file reports nothing malformed");
	for (const file of [LAYOUT.learningsFile, LAYOUT.candidatesFile, LAYOUT.archiveFile]) assert.ok(existsSync(h.path(file)), `${file} scaffolded`);
	const header = h.read(LAYOUT.learningsFile) ?? "";
	assert.match(header, /Budget: max ~60 lines/);
	assert.match(header, /<!--P-->/);
	assert.match(h.read(LAYOUT.candidatesFile) ?? "", /append-only/);
	assert.match(h.read(LAYOUT.archiveFile) ?? "", /Never delete/);
	assert.equal(digestIn(fresh.requests()[0]), undefined, "a fresh home does not announce that it has no memory");
	await fresh.child.close();

	// Tiers and decay on 2026-08-27: perishable stales at 7 days, aging at 30; pinned and untiered never decay.
	const entries = [
		"- 2026-01-01 treehouse pool lives on the external disk here; evidence: cp-t11. <!--P-->",
		"- 2026-08-20 perishable, 7 days old; evidence: b. <!--p:2026-08-20-->",
		"- 2026-08-25 perishable, 2 days old; evidence: c. <!--p:2026-08-25-->",
		"- 2026-07-28 aging, 30 days old; evidence: d. <!--a:2026-07-28-->",
		"- 2026-08-10 aging, 17 days old; evidence: e. <!--a:2026-08-10-->",
		"- 2026-08-01 aging with an impossible window date; evidence: g. <!--a:2026-99-99-->",
		"- 2026-01-01 untiered and ancient; evidence: f.",
		"not an entry at all",
		"- 2026-08-27 a truncated tail with no tier and no ev",
	];
	h.put(LAYOUT.learningsFile, learnings(entries, header));
	h.put(LAYOUT.candidatesFile, ["# Candidates", "", "<!-- append-only; /memory capture writes here -->", "2026-08-27 a well-formed candidate",
		"- 2026-08-27 written as a list item", "no date at all", "2026-8-7 sloppy date", "", "<!-- a multi-line", "     comment is not a candidate -->",
		"## a heading is not a candidate", ""].join("\n"));
	const seeded = h.read(LAYOUT.learningsFile);
	const tiered = h.parent();
	const reads = await tiered.tools([call("status", { action: "status" }), call("curate", { action: "curate" })]);
	assert.equal(h.read(LAYOUT.learningsFile), seeded, "the scaffold keeps an existing file byte-identical");
	const digest = digestIn(tiered.requests()[0]) ?? "";
	assert.match(digest, /data\/learnings\.md \(8 entries, machine-local\)/);
	assert.match(digest, /treehouse pool lives on the external disk/);
	assert.match(digest, /2 entries past their decay window/);
	assert.match(digest, /\(1 pending candidate\(s\) — cp_memory curate\)/);
	assert.ok(!digest.includes("Budget: max"), "the contract header never enters the session");
	const status = details(reads.get("status"));
	assert.deepEqual(status.tiers, { pinned: 1, aging: 3, perishable: 2, untiered: 2 });
	assert.equal(status.candidates, 1, "only the contract-shaped candidate counts");
	assert.deepEqual(status.malformed_candidates, ["- 2026-08-27 written as a list item", "no date at all", "2026-8-7 sloppy date"]);
	const statusText = said(reads.get("status"));
	assert.match(statusText, /untiered \(contract wants/);
	assert.match(statusText, /a truncated tail with no tier/);
	assert.match(statusText, /candidates that will never be promoted \(want `YYYY-MM-DD <lesson>`\)/);
	assert.match(statusText, /- 2026-08-27 written as a list item/);
	assert.doesNotMatch(statusText, /nothing to curate/, "a file with invisible lines is not curated");
	assert.deepEqual(details(reads.get("curate")).stale, [entries[1], entries[3]], "exactly the two entries at their window; a date that is no date never decays");
	await tiered.child.close();

	// Over budget: the digest loads the budget's worth and says what it left out; status names the overflow.
	h.put(LAYOUT.learningsFile, learnings(Array.from({ length: 65 }, (_, i) => `- 2026-08-01 lesson ${i}; do it; evidence: e. <!--P-->`), header));
	h.put(LAYOUT.candidatesFile, ["# Candidates", ...Array.from({ length: 40 }, (_, i) => `bad ${i}`)].join("\n"));
	const over = h.parent();
	const full = await over.tools([call("status", { action: "status" })]);
	const lines = (digestIn(over.requests()[0]) ?? "").split("\n");
	assert.equal(lines.length, 62, "header, the 60-line budget, and the truncation notice");
	assert.match(lines.at(-1) ?? "", /5 entries beyond the 60-line budget were not loaded/);
	assert.match(said(full.get("status")), /OVER BUDGET/);
	assert.match(said(full.get("status")), /pinned entries are not dropped for space/);
	assert.equal((details(full.get("status")).malformed_candidates as unknown[]).length, 10);
	assert.match(said(full.get("status")), /… more; open the file/);
});

test("P23-memory-capture: /memory and cp_memory capture append one dated candidate line, never touch learnings, and refuse what is not one line", { timeout: 240_000 }, async (t) => {
	const h = await memoryHome(t);
	const parent = h.parent(["--skill", join(REPO_ROOT, "skills/cp-memory/SKILL.md")]);
	parent.child.send({ id: "cmds", type: "get_commands" });
	const listed = (await parent.child.waitFor((r) => r.type === "response" && r.id === "cmds")) as { data?: { commands?: Array<{ name: string; source: string }> } };
	const commands = listed.data?.commands ?? [];
	assert.ok(commands.some((command) => command.name === "skill:cp-memory" && command.source === "skill"), commands.map((command) => command.name).join(","));
	assert.ok(commands.some((command) => command.name === "memory"), "/memory is registered");

	const quiet = await parent.tools([call("curate", { action: "curate" })]);
	assert.match(said(quiet.get("curate")), /nothing to curate/);
	h.put(LAYOUT.learningsFile, `${h.read(LAYOUT.learningsFile)}\n- 2026-08-01 keep me; evidence: a. <!--P-->\n`);
	const kept = h.read(LAYOUT.learningsFile);
	rmSync(h.path(LAYOUT.archiveFile));

	const captured = await parent.command("/memory capture rpc-captured lesson", (r) => String(r.message).startsWith("captured in"));
	assert.match(String(captured.message), /data\/candidates\.md \(1 candidate\(s\)\): 2026-08-27 rpc-captured lesson/);
	assert.match(h.read(LAYOUT.archiveFile) ?? "", /Never delete/, "capture scaffolds a missing memory file on demand");
	const status = await parent.command("/memory status", (r) => String(r.message).startsWith("MEMORY"));
	assert.match(String(status.message), /1\/60 learning line\(s\).*1 candidate\(s\)/s);
	assert.match(String(status.message), /CURATION .* 1 pending candidate\(s\)/s);
	const plan = await parent.command("/memory curate", (r) => String(r.message).startsWith("CURATION"));
	assert.match(String(plan.message), /rpc-captured lesson/, "the pending candidate is the pass's worklist");
	const audit = await parent.command("/memory audit", (r) => String(r.message).startsWith("AUDIT"));
	assert.match(String(audit.message), /no curation decisions recorded yet/);
	const empty = await parent.command("/memory capture ", (r) => r.notifyType === "error");
	assert.match(String(empty.message), /needs a one-line lesson.*usage: \/memory capture <one-line lesson>/s);
	assert.doesNotMatch(h.read(LAYOUT.candidatesFile) ?? "", /^\d{4}-\d{2}-\d{2} *$/m, "an empty capture appends no dateless or blank line");

	const before = h.read(LAYOUT.candidatesFile) ?? "";
	const ends = await parent.tools([
		call("first", { action: "capture", lesson: "treehouse leases fail on the external disk when it is unmounted" }),
		call("dated", { action: "capture", lesson: "2026-10-11 lesson text" }),
		call("blank", { action: "capture", lesson: "   " }),
		call("two-lines", { action: "capture", lesson: "line one\nline two" }),
		call("essay", { action: "capture", lesson: "x".repeat(301) }),
	]);
	assertEnd(ends, "first", "ok", /^captured in \.pi-command-post\/data\/candidates\.md \(2 candidate\(s\)\): 2026-08-27 treehouse leases fail on the external disk when it is unmounted — 2 pending/);
	assertEnd(ends, "dated", "ok", /\(3 candidate\(s\)\): 2026-08-27 lesson text — /);
	assertEnd(ends, "blank", "refused", /cp_memory capture needs a one-line lesson/);
	assertEnd(ends, "two-lines", "refused", /one line/);
	assertEnd(ends, "essay", "refused", /at most 300 chars/);
	const after = h.read(LAYOUT.candidatesFile) ?? "";
	assert.ok(after.startsWith(before), "capture only ever adds to the end");
	assert.equal(after.slice(before.length), "2026-08-27 treehouse leases fail on the external disk when it is unmounted\n2026-08-27 lesson text\n");
	assert.equal(h.read(LAYOUT.learningsFile), kept, "capture is not promotion");
	assert.deepEqual(stagingFiles(dirname(h.path(LAYOUT.learningsFile))), [], "a completed write leaves no .tmp behind");
});

test("P23-curation-promote: cp_memory promote writes one dated, evidenced, decaying line by append only, bounded per day and refused for duplicates, undecided or invented candidates; the audit traces it", { timeout: 240_000 }, async (t) => {
	const h = await memoryHome(t);
	const parent = h.parent();
	await parent.tools([]);
	h.put(LAYOUT.learningsFile, learnings(["- 2026-08-01 pinned by the operator; evidence: a. <!--P-->", "- 2026-08-02 an untiered line somebody wrote by hand; evidence: b.",
		"a stray note that is not an entry at all"], h.read(LAYOUT.learningsFile) ?? ""));
	const seeded = h.read(LAYOUT.learningsFile) ?? "";
	const c1 = "2026-08-27 treehouse leases fail when the external disk is unmounted";
	const refused = await parent.tools([
		call("c1", { action: "capture", lesson: "treehouse leases fail when the external disk is unmounted" }),
		call("no-evidence", { action: "promote", candidate: c1, lesson: "a lesson", evidence: "  " }),
		call("vague", { action: "promote", candidate: c1, lesson: "a lesson", evidence: "it seemed true at the time" }),
		call("pinned", { action: "promote", candidate: c1, lesson: "keep this forever", evidence: EVIDENCE, tier: "pinned" }),
	]);
	assertEnd(refused, "no-evidence", "refused", /needs evidence/);
	assertEnd(refused, "vague", "refused", /checkable source/);
	assertEnd(refused, "pinned", "refused", /tier/);
	assert.equal(h.read(LAYOUT.learningsFile), seeded, "a refused promotion writes nothing");
	assert.equal(h.read(LAYOUT.curationLog), undefined, "…and journals nothing");

	const line1 = "- 2026-08-27 treehouse leases fail when the external disk is unmounted; remount before dispatching; evidence: cp-t26; PR #39; src/memory.ts. <!--a:2026-08-27-->";
	const day1 = await parent.tools([
		call("p1", { action: "promote", candidate: c1, lesson: "treehouse leases fail when the external disk is unmounted; remount before dispatching", evidence: EVIDENCE }),
		call("c2", { action: "capture", lesson: "workaround while cp-x is open" }),
		call("no-expiry", { action: "promote", candidate: "2026-08-27 workaround while cp-x is open", lesson: "use the workaround", evidence: EVIDENCE, tier: "perishable" }),
		call("perishable", { action: "promote", candidate: "2026-08-27 workaround while cp-x is open", lesson: "use the workaround", evidence: EVIDENCE, tier: "perishable", expires: "cp-x closes" }),
		call("c3", { action: "capture", lesson: "the pool lives on the external disk" }),
		call("p3", { action: "promote", candidate: "2026-08-27 the pool lives on the external disk", lesson: "the pool lives on the external disk", evidence: "https://github.com/o/r/pull/39" }),
		call("c4", { action: "capture", lesson: "the pool lives on the external disk (again)" }),
		call("fourth", { action: "promote", candidate: "2026-08-27 the pool lives on the external disk (again)", lesson: "a fourth lesson today", evidence: "merged 2026-08-27" }),
		call("c5", { action: "capture", lesson: "a lesson to reject" }),
		call("r5", { action: "reject", candidate: "2026-08-27 a lesson to reject", cause: "noise", reason: "one-off, not a pattern" }),
	]);
	const p1 = details(assertEnd(day1, "p1", "ok", /^promoted \(cur-20260827-1\) into data\/learnings\.md — 3\/60 lines, 2 promotion\(s\) left today:\n/));
	assert.equal(p1.line, line1, "a promotion composes its date, its evidence and an aging tier");
	assertEnd(day1, "no-expiry", "refused", /expiry condition/);
	const perishable = String(details(assertEnd(day1, "perishable", "ok", /1 promotion\(s\) left today/)).line);
	assert.match(perishable, /; expires: cp-x closes; evidence: .*<!--p:2026-08-27-->$/);
	const p3 = String(details(assertEnd(day1, "p3", "ok", /0 promotion\(s\) left today/)).line);
	assertEnd(day1, "fourth", "refused", /promotions already landed today/);
	assertEnd(day1, "r5", "ok", /^rejected as noise \(cur-20260827-4\); it can never be promoted: 2026-08-27 a lesson to reject$/);
	const written = h.read(LAYOUT.learningsFile) ?? "";
	assert.ok(written.startsWith(seeded), "every existing line survives byte-identically");
	assert.equal(written.slice(seeded.length), `${line1}\n${perishable}\n${p3}\n`, "…and the only difference is the appended lines");

	h.day(1);
	const day2 = await parent.tools([
		call("duplicate", { action: "promote", candidate: "2026-08-27 the pool lives on the external disk (again)", lesson: "the pool lives on the external disk", evidence: EVIDENCE }),
		call("obvious", { action: "promote", candidate: "2026-08-27 the pool lives on the external disk (again)", lesson: "the pool is mounted", evidence: "obvious" }),
		call("tomorrow", { action: "promote", candidate: "2026-08-27 the pool lives on the external disk (again)", lesson: "the pool is mounted at /mnt/ext", evidence: "merged 2026-08-27" }),
		call("invented", { action: "promote", candidate: "2026-08-27 invented on the spot", lesson: "x", evidence: EVIDENCE }),
		call("again", { action: "promote", candidate: c1, lesson: "treehouse leases fail; remount", evidence: EVIDENCE }),
		call("reject-promoted", { action: "reject", candidate: c1, cause: "noise", reason: "changed my mind" }),
		call("retire", { action: "retire", line: line1, reason: "made false by merged code", evidence: "PR #39 merged 2026-08-28", now: "AGENTS.md §Memory" }),
		call("audit", { action: "audit" }),
		call("trace", { action: "audit", line: line1 }),
	]);
	assertEnd(day2, "duplicate", "refused", /already in \.pi-command-post\/data\/learnings\.md/);
	assertEnd(day2, "obvious", "refused", /checkable source/);
	assertEnd(day2, "tomorrow", "ok", /^promoted \(cur-20260828-1\) .* 2 promotion\(s\) left today/);
	assertEnd(day2, "invented", "refused", /no such candidate/);
	assertEnd(day2, "again", "refused", /already promoted/);
	assert.ok(said(day2.get("reject-promoted")).includes(`cp_memory retire line: ${line1}`), said(day2.get("reject-promoted")));
	assertEnd(day2, "retire", "ok", /^retired \(cur-20260828-2\) to data\/archive\.md/);
	const audit = said(day2.get("audit"));
	assert.match(audit, /cur-20260827-1 2026-08-27 promote: - 2026-08-27 treehouse leases/);
	assert.match(audit, /cur-20260827-4 2026-08-27 reject\/noise: 2026-08-27 a lesson to reject/);
	assert.match(audit, /cur-20260828-2 2026-08-28 retire: - 2026-08-27 treehouse leases/);
	assert.deepEqual((details(day2.get("trace")).records as Array<{ id: string; action: string }>).map((record) => [record.id, record.action]),
		[["cur-20260827-1", "promote"], ["cur-20260828-2", "retire"]], "a line in the digest is one lookup from its decisions");
	const log = (h.read(LAYOUT.curationLog) ?? "").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	assert.deepEqual(log.map((record) => record.action), ["promote", "promote", "promote", "reject", "promote", "retire"]);
	assert.deepEqual([log[0]?.line, log[0]?.candidate, log[0]?.evidence, log[5]?.now], [line1, c1, EVIDENCE, "AGENTS.md §Memory"]);
});

test("P23-curation-reject: a rejection needs its cause and evidence, is decided once, never rewrites candidates and leaves the worklist; long lessons decide by their text", { timeout: 240_000 }, async (t) => {
	const h = await memoryHome(t);
	const parent = h.parent();
	await parent.tools([]);
	h.put(LAYOUT.learningsFile, learnings(["- 2026-07-01 a lesson that has decayed; evidence: e. <!--a:2026-07-01-->", "- 2026-08-26 a fresh lesson; evidence: e. <!--a:2026-08-26-->"],
		h.read(LAYOUT.learningsFile) ?? ""));
	h.put(LAYOUT.curationLog, "{not json\n\n");
	const before = h.read(LAYOUT.candidatesFile) ?? "";
	const pass = await parent.tools([
		call("a", { action: "capture", lesson: "candidate one, worth promoting" }),
		call("b", { action: "capture", lesson: "candidate two, superseded the same day" }),
		call("c", { action: "capture", lesson: "candidate three, still pending" }),
		call("plan", { action: "curate" }),
		call("promote", { action: "promote", candidate: "2026-08-27 candidate one, worth promoting", lesson: "candidate one, worth promoting; act on it", evidence: EVIDENCE }),
		call("reject", { action: "reject", candidate: "2026-08-27 candidate two, superseded the same day", cause: "superseded", reason: "merged the same day", evidence: "PR #39" }),
		call("plan-after", { action: "curate" }),
		call("promote-rejected", { action: "promote", candidate: "2026-08-27 candidate two, superseded the same day", lesson: "rebase twice", evidence: EVIDENCE }),
		call("reject-again", { action: "reject", candidate: "2026-08-27 candidate two, superseded the same day", cause: "noise", reason: "changed my mind" }),
	]);
	const plan = details(pass.get("plan"));
	assert.deepEqual([(plan.pending as unknown[]).length, (plan.stale as unknown[]).length, plan.promotions_remaining, plan.retirements_remaining, plan.budget_remaining],
		[3, 1, 3, 10, 58]);
	assert.match(said(pass.get("plan")), /3 pending candidate\(s\) · 1 stale learning\(s\)/);
	assert.match(said(pass.get("plan")), /candidate three, still pending/);
	assertEnd(pass, "promote", "ok", /2 promotion\(s\) left today/);
	assertEnd(pass, "reject", "ok", /^rejected as superseded \(cur-20260827-2\)/);
	const after = details(pass.get("plan-after"));
	assert.deepEqual([after.pending, after.promotions_remaining], [["2026-08-27 candidate three, still pending"], 2], "a decided candidate leaves the worklist");
	assertEnd(pass, "promote-rejected", "refused", /rejected as superseded .* never promoted/s);
	assertEnd(pass, "reject-again", "refused", /already rejected .* decided once/);
	assert.equal((h.read(LAYOUT.candidatesFile) ?? "").slice(before.length),
		"2026-08-27 candidate one, worth promoting\n2026-08-27 candidate two, superseded the same day\n2026-08-27 candidate three, still pending\n",
		"candidates.md is append-only: the disposition lives in the journal");
	assert.match(h.read(LAYOUT.curationLog) ?? "", /^\{not json\n/, "a mangled journal line is skipped, not fatal, and not rewritten");

	const causes = await parent.tools([
		call("d", { action: "capture", lesson: "a claim that merged code made false" }),
		call("e", { action: "capture", lesson: "a claim the next run disproved" }),
		call("f", { action: "capture", lesson: "a claim that belongs in AGENTS.md" }),
		call("superseded", { action: "reject", candidate: "2026-08-27 a claim that merged code made false", cause: "superseded", reason: "code landed" }),
		call("disproven", { action: "reject", candidate: "2026-08-27 a claim the next run disproved", cause: "disproven", reason: "it did not reproduce", evidence: "trust me" }),
		call("generalizes", { action: "reject", candidate: "2026-08-27 a claim that belongs in AGENTS.md", cause: "generalizes", reason: "contract edit, not a learning" }),
		call("no-cause", { action: "reject", candidate: "2026-08-27 a claim the next run disproved", reason: "no cause given" }),
	]);
	assertEnd(causes, "superseded", "refused", /needs evidence/);
	assertEnd(causes, "disproven", "refused", /checkable source/);
	assertEnd(causes, "generalizes", "ok", /^rejected as generalizes/);
	assertEnd(causes, "no-cause", "refused", /needs a cause — one of superseded, disproven, generalizes, noise/);

	// Lessons at and just under the 300-char capture cap, two of them hand-written, decide by their lesson text.
	const [l298, l299] = ["a".repeat(298), "b".repeat(299)];
	h.put(LAYOUT.candidatesFile, `${h.read(LAYOUT.candidatesFile)}2026-08-27 ${l298}\n2026-08-27 ${l299}\n`);
	const long = await parent.tools([
		call("cap", { action: "capture", lesson: "c".repeat(300) }),
		call("r300", { action: "reject", candidate: "c".repeat(300), cause: "noise", reason: "not useful" }),
		call("r298", { action: "reject", candidate: l298, cause: "noise", reason: "not useful" }),
		call("r299", { action: "reject", candidate: l299, cause: "noise", reason: "not useful" }),
		call("cap-y", { action: "capture", lesson: "y".repeat(300) }),
		call("p-lesson", { action: "promote", candidate: "y".repeat(300), lesson: "y".repeat(300), evidence: EVIDENCE }),
		call("cap-z", { action: "capture", lesson: "z".repeat(300) }),
		call("p-line", { action: "promote", candidate: `2026-08-27 ${"z".repeat(300)}`, lesson: "z".repeat(300), evidence: EVIDENCE }),
		call("plan", { action: "curate" }),
	]);
	assert.equal(String(details(long.get("cap")).line).length, 311, "the full line is the date plus the 300-char lesson");
	assert.deepEqual(["r300", "r298", "r299"].map((id) => details(long.get(id)).candidate), [`2026-08-27 ${"c".repeat(300)}`, `2026-08-27 ${l298}`, `2026-08-27 ${l299}`]);
	assert.ok(String(details(assertEnd(long, "p-lesson", "ok", /^promoted/)).line).length > 300, "a learning line past 300 chars is allowed");
	assertEnd(long, "p-line", "ok", /0 promotion\(s\) left today/);
	assert.deepEqual(details(long.get("plan")).pending, ["2026-08-27 candidate three, still pending", "2026-08-27 a claim that merged code made false",
		"2026-08-27 a claim the next run disproved"], "every long candidate was decided");
});

test("P23-curation-retire: retirement moves a line to the archive with provenance, needs reason, evidence and the exact line, is bounded per day, and frees one budget slot", { timeout: 240_000 }, async (t) => {
	const h = await memoryHome(t);
	const parent = h.parent();
	await parent.tools([]);
	const stale = Array.from({ length: 11 }, (_, i) => `- 2026-07-01 stale lesson ${i}; evidence: e. <!--a:2026-07-01-->`);
	const pinned = Array.from({ length: 49 }, (_, i) => `- 2026-08-01 existing lesson ${i}; evidence: e. <!--P-->`);
	h.put(LAYOUT.learningsFile, learnings([...stale, ...pinned], h.read(LAYOUT.learningsFile) ?? ""));
	const full = h.read(LAYOUT.learningsFile);
	const archived = h.read(LAYOUT.archiveFile) ?? "";
	const refused = await parent.tools([
		call("cap", { action: "capture", lesson: "one more thing that will not fit" }),
		call("over", { action: "promote", candidate: "2026-08-27 one more thing that will not fit", lesson: "one more thing", evidence: EVIDENCE }),
		call("no-reason", { action: "retire", line: stale[0], reason: " ", evidence: "PR #39" }),
		call("no-evidence", { action: "retire", line: stale[0], reason: "stale", evidence: "  " }),
		call("inexact", { action: "retire", line: "- 2026-07-01 stale lesson 0", reason: "stale", evidence: "PR #39" }),
	]);
	assertEnd(refused, "over", "refused", /at budget \(60\/60\)/);
	assertEnd(refused, "no-reason", "refused", /reason is required/);
	assertEnd(refused, "no-evidence", "refused", /needs evidence/);
	assertEnd(refused, "inexact", "refused", /match the line exactly/);
	assert.equal(h.read(LAYOUT.learningsFile), full, "the file did not grow past its ceiling, and a refused retirement changes nothing");

	const pass = await parent.tools([
		call("r0", { action: "retire", line: stale[0], reason: "made false by merged code", evidence: "PR #39", now: "docs/contracts.md §Memory" }),
		call("slot", { action: "promote", candidate: "2026-08-27 one more thing that will not fit", lesson: "one more thing", evidence: EVIDENCE }),
		...stale.slice(1, 10).map((line, i) => call(`r${i + 1}`, { action: "retire", line, reason: "decayed with no reinforcement", evidence: "2026-08-27" })),
		call("r10", { action: "retire", line: stale[10], reason: "decayed with no reinforcement", evidence: "2026-08-27" }),
	]);
	assertEnd(pass, "r0", "ok", /^retired \(cur-20260827-1\) to data\/archive\.md — 59 learning line\(s\) left, 9 retirement\(s\) left today:\n/);
	assertEnd(pass, "slot", "ok", /— 60\/60 lines/);
	assertEnd(pass, "r10", "refused", /retirements already landed today/);
	const archive = h.read(LAYOUT.archiveFile) ?? "";
	assert.ok(archive.startsWith(archived), "the archive only ever grows");
	assert.ok(archive.includes("stale lesson 0"), "nothing is deleted; it is in the archive");
	assert.match(archive, /\(from \.pi-command-post\/data\/learnings\.md, <!--a:2026-07-01-->, archived 2026-08-27\)/);
	assert.match(archive, /Reason: made false by merged code \(cur-20260827-1; evidence: PR #39\)/);
	assert.match(archive, /Now: docs\/contracts\.md §Memory/);
	const kept = h.read(LAYOUT.learningsFile) ?? "";
	assert.deepEqual(stale.map((line) => kept.includes(line)), [...Array(10).fill(false), true], "ten retired, the last survived the bound");
	assert.ok(pinned.every((line) => kept.includes(line)) && /Budget: max ~60 lines/.test(kept), "the other entries and the header survive the rewrite");
	assert.deepEqual(stagingFiles(dirname(h.path(LAYOUT.learningsFile))), [], "a completed write leaves no .tmp behind");
	for (const file of [LAYOUT.learningsFile, LAYOUT.candidatesFile, LAYOUT.archiveFile, LAYOUT.curationLog]) assert.ok(existsSync(h.path(file)), `${file} under the scratch home`);
});
