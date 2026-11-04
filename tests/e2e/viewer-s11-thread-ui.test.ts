/**
 * Full match S11: the operator chat's thread tabs, `#` picker and thread rail through `bin/cp-view` on a scratch home,
 * its real dashboard-control owner and the served app in its linkedom tab. Membership is the registry's recorded binds
 * only: untagged history shows under All messages and No thread, never inferred into a named thread.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { namedThreadsFile } from "../../src/viewer/named-threads-view.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { browserShims, dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const A = "th-aaaaaaaaaaaaaaaa", B = "th-bbbbbbbbbbbbbbbb";
const AT = "2026-11-04T12:00:00.000Z";
const TEXTS = ["ALPHA-ASK", "ALPHA-REPLY", "BETA-ASK", "BETA-REPLY", "OLD-ASK", "OLD-REPLY"];

/** One pi session: an Alpha turn, a Beta turn and an unbound older turn; asks and working jobs in A, B and none. */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
	const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const msg = (id: string, role: string, text: string, minutes: number) => ({ type: "message", id, parentId: null, timestamp: iso(minutes), message: { role, content: [{ type: "text", text }] } });
	const chat = join(home, "pi-sessions", "chat.jsonl");
	put(chat, jsonl([{ type: "session", version: 3, id: "s11-session", timestamp: iso(60), cwd: "/" }, msg("u0000001", "user", "OLD-ASK", 50), msg("r0000001", "assistant", "OLD-REPLY", 49),
		msg("u0000002", "user", "ALPHA-ASK", 40), msg("r0000002", "assistant", "ALPHA-REPLY", 39), msg("u0000003", "user", "BETA-ASK", 30), msg("r0000003", "assistant", "BETA-REPLY", 29)]));
	put(operatorSessionsFile(join(stateDir, "sessions")), jsonl([{ at: iso(60), session_file: chat }]));
	const create = (n: number, thread_id: string, name: string) => ({ v: 1, type: "create", at: AT, request_id: `dc-20261104120000-0000000${n}`, thread_id, name, peer: null });
	const bind = (kind: string, id: string, thread_id: string, session_id?: string) => ({ v: 1, type: "bind", at: AT, key: { kind, id, ...(session_id ? { session_id } : {}) }, thread_id });
	put(namedThreadsFile(stateDir), jsonl([create(1, A, "Alpha"), create(2, B, "Beta"), bind("message", "u0000002", A, "s11-session"), bind("message", "u0000003", B, "s11-session"),
		bind("ask", "ask-aaaa", A), bind("job", "cp-ja", A), bind("job", "cp-jb", B)]));
	const ask = (id: string, question: string) => ({ type: "open", id, created_at: iso(20), project: "picp", question, options: [{ label: "Keep", consequence: "Stays" }], recommendation: "Keep", source_escalation: "es-open", job_ids: [] });
	put(join(stateDir, "operator", "asks.jsonl"), jsonl([ask("ask-aaaa", "ALPHA-DECISION?"), ask("ask-0000", "UNTAGGED-DECISION?")]));
	const jobs = ["cp-ja", "cp-jb", "cp-jn"];
	put(join(home, ".pi-command-post", "jobs.json"), { jobs: jobs.map((id) => ({ id, title: `Title ${id}`, status: "in_progress", labels: ["project:picp", "kind:ship"], blocked_by: [] })) });
	put(join(home, LAYOUT.fleetFile), { jobs: jobs.map((job_id) => ({ job_id, project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) })) });
	for (const id of jobs) put(join(stateDir, "runs", id, "status.json"), { phase: "working" });
}

const settle = () => new Promise((done) => setTimeout(done, 50));
const field = (tab: Tab) => tab.$(".operator-composer textarea") as unknown as HTMLTextAreaElement;
const shown = (tab: Tab) => TEXTS.filter((text) => tab.$(".session-entries")!.textContent!.includes(text));
const scope = (tab: Tab) => [shown(tab), tab.$(".session-strip-count")?.textContent, tab.$(".session-pinned")?.textContent?.match(/[A-Z]+-DECISION\?/g) ?? []];
async function go(tab: Tab, thread: string) {
	tab.go(thread ? `${CHAT}&thread=${thread}` : CHAT);
	await until(() => tab.$(".session-heading-id strong")?.textContent, (s) => s === (thread === A ? "# Alpha" : thread === B ? "# Beta" : thread ? "# No thread" : "Operator"), `heading for ${thread || "All"}`);
	await settle();
}
async function type(tab: Tab, value: string) {
	tab.type(field(tab) as unknown as Element, value);
	await settle();
}
const sent = (tab: Tab) => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message").map((r) => JSON.parse(r.body!) as Record<string, unknown>);

test("S11-thread-ui: tabs and # scope rows, asks, jobs and drafts; No thread sends an explicit null; All shows everything", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	await operatorSession(t, d.stateDir);
	const storage = new Map<string, string>();
	const tab = await openTab(t, d.port, CHAT, storage, undefined, {}, true);
	browserShims(t, tab);
	await tab.waitText(/BETA-REPLY/);
	await tab.find(".thread-row", (a) => a.textContent!.includes("Beta"));
	await tab.find(".operator-composer-hash");
	const all = scope(tab), context = tab.$(".session-heading-state")!.textContent;
	assert.deepEqual(all, [TEXTS, "3 working", ["ALPHA-DECISION?", "UNTAGGED-DECISION?"]], "All messages: every loaded message, ask and job");
	assert.deepEqual(tab.$$(".thread-row").map((a) => a.textContent!.replace(/\d+ new$/, "")), ["#All messages", "#Alpha", "#Beta", "#No thread"]);

	await go(tab, A);
	assert.deepEqual(scope(tab), [["ALPHA-ASK", "ALPHA-REPLY"], "1 working", ["ALPHA-DECISION?"]], "Alpha: its recorded turn, ask and job only");
	await type(tab, "DRAFT-A");
	await go(tab, B);
	assert.deepEqual(scope(tab), [["BETA-ASK", "BETA-REPLY"], "1 working", []], "Beta: no ask is inferred into it");
	assert.equal(field(tab).value, "", "Beta does not reuse Alpha's draft");
	await type(tab, "DRAFT-B");
	// The `#` picker moves the selection as a tab does; it never sends.
	tab.click(tab.$(".operator-composer-hash")!);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.includes("Alpha")));
	await settle();
	tab.go(tab.window.location.hash);
	await until(() => field(tab)?.value, (v) => v === "DRAFT-A", "Alpha's own draft back");
	assert.deepEqual(tab.$$(".thread-tab a").map((a) => a.textContent), ["Operator · All messages", "# Alpha", "# Beta"], "each visited thread keeps a tab");

	await go(tab, "none");
	assert.deepEqual(scope(tab), [["OLD-ASK", "OLD-REPLY"], "1 working", ["UNTAGGED-DECISION?"]], "No thread: untagged history, never inferred");
	await type(tab, "TO-NO-THREAD");
	tab.click(tab.$(".operator-composer-send")!);
	await until(() => sent(tab).length, (c) => c === 1, "the No thread send");
	assert.ok(Object.hasOwn(sent(tab)[0]!, "thread_id") && sent(tab)[0]!.thread_id === null, "No thread sends an explicit null");

	await go(tab, A);
	tab.click(tab.$(".operator-composer-send")!);
	await until(() => sent(tab).length, (c) => c === 2, "the Alpha send");
	assert.deepEqual([sent(tab)[1]!.text, sent(tab)[1]!.thread_id], ["DRAFT-A", A], "Alpha's draft sends to Alpha");

	await go(tab, "");
	assert.deepEqual([scope(tab), tab.$(".session-heading-state")!.textContent], [all, context], "All messages again: every loaded message, the same model and context");
});
