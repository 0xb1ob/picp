/**
 * The operator chat's sidebar project rows (they replaced the retired thread rail), through `bin/cp-view` on a scratch
 * home, its real dashboard-control owner and the served app in its linkedom tab (DOM and served CSS; no layout).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const LONG = "a-registered-project-name-long-enough-to-ellipsize-in-the-sidebar";
const ROWS = ".session-sidebar .project-row";

const say = (minutes: number, role: string, text: string) => `${JSON.stringify({ type: "message", timestamp: iso(minutes), message: { role, content: [{ type: "text", text }] } })}\n`;
/** A chat naming two of three registered projects (one long; atlas never); a garbage retired thread registry. */
function seed(stateDir: string, home: string) {
	const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
	const chat = join(home, "pi-sessions", "chat.jsonl");
	put(chat, say(10, "assistant", "REPLY-CARD") + say(9, "user", `[${LONG}] LONG-ASK`) + say(8, "user", "[picp] PICP-ASK"));
	put(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	put(join(dirname(stateDir), "data", "projects.json"), JSON.stringify({ projects: [{ name: "picp" }, { name: LONG }, { name: "atlas" }] }));
	for (const name of ["picp", LONG, "atlas"]) mkdirSync(join(dirname(stateDir), "projects", name), { recursive: true }); // header names
	put(join(stateDir, "operator", "named-threads.jsonl"), "{not json\n");
}
/** `seed`, plus an older session file whose only reply names no project. */
function seedOlder(stateDir: string, home: string) {
	seed(stateDir, home);
	const old = join(home, "pi-sessions", "old.jsonl");
	writeFileSync(old, say(40, "assistant", "OLD-REPLY"));
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), [{ at: iso(50), session_file: old }, { at: iso(20), session_file: join(home, "pi-sessions", "chat.jsonl") }].map((r) => `${JSON.stringify(r)}\n`).join(""));
}
const settle = () => new Promise((done) => setTimeout(done, 50));
const current = (tab: Tab) => tab.$(`${ROWS}[aria-current="page"]`)?.textContent;
const sent = (tab: Tab) => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message").map((r) => JSON.parse(r.body!) as Record<string, unknown>);

// Scenario: the chat filter offers All plus only the session's projects
//   Given registered picp, atlas and a long name, and a chat with messages headed [picp] and [long name]
//   When the operator opens the chat
//   Then the rows are All, the long name and picp (never atlas), and picking picp keeps only its messages
test("project-sidebar: registered rows select the hash's project; no thread chrome, request, shortcut, draft scope or send field", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	await operatorSession(t, d.stateDir);
	// Retired browser state: thread tabs, a seen cursor and a stored send carrying thread fields.
	const storage = new Map<string, string>([["cp-thread-tabs", JSON.stringify(["th-aaaaaaaaaaaaaaaa"])], ["cp-thread-seen:th-aaaaaaaaaaaaaaaa", iso(30)],
		["cp-operator-pending-sends", JSON.stringify({ items: [{ key: "k1", at: iso(5), id: null, reason: null, ask_id: null, state: "sending",
			body: { kind: "message", text: "OLD-SEND", thread_id: "th-aaaaaaaaaaaaaaaa", thread: "retired" } }], dismissed: [] })]]);
	const tab = await openTab(t, d.port, `${CHAT}&session=chat.jsonl`, storage, undefined, {}, true);
	await tab.waitText(/REPLY-CARD/);
	await tab.find(ROWS);
	assert.deepEqual([tab.$$(ROWS).map((a) => a.textContent), current(tab)], [["#All projects", `#${LONG}`, "#picp"], "#All projects"],
		"All first, then the session's registered names sorted; atlas has no loaded messages");
	assert.deepEqual([tab.$$(`${ROWS} .project-row-name`).at(1)?.textContent, tab.$$(ROWS).at(1)?.getAttribute("title")], [LONG, LONG], "a long name keeps its full title");
	assert.deepEqual([tab.$$('select[aria-label="Filter by project"], .session-filter-menu').length, tab.$$(".thread-row, .thread-tabs, .thread-new, .operator-composer-hash").length],
		[0, 0], "one filter control; no thread rail, tabs, New thread or # chip");
	assert.doesNotMatch(tab.text(), /New thread|All messages|No thread|Started from chat/);

	// Negative control: the retired rail claimed Ctrl/Cmd+N and fetched /api/threads.
	const key = Object.assign(new tab.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "n", ctrlKey: true });
	tab.window.dispatchEvent(key);
	assert.equal(key.defaultPrevented, false, "Ctrl+N is the browser's");

	tab.type(await tab.find(".operator-composer textarea"), "KEEP-DRAFT");
	const picp = tab.$$(ROWS).find((a) => a.textContent === "#picp")!;
	assert.equal(picp.getAttribute("href"), "#sessions?view=you&session=chat.jsonl&project=picp", "a row's link drops only transcript=");
	tab.click(picp);
	assert.equal(tab.window.location.hash, `${CHAT}&session=chat.jsonl&project=picp`, "a click moves only the selection");
	tab.go(tab.window.location.hash);
	await until(() => current(tab), (name) => name === "#picp", "the picp row current");
	await until(() => tab.$(".session-entries")?.textContent ?? "", (text) => /PICP-ASK/.test(text) && !/REPLY-CARD|LONG-ASK/.test(text), "picp filters the transcript");
	assert.equal((tab.$(".operator-composer textarea") as unknown as { value: string }).value, "KEEP-DRAFT", "one draft per session file, not per selection");
	tab.click(tab.$$(ROWS).find((a) => a.textContent === "#All projects")!);
	tab.go(tab.window.location.hash);
	await tab.waitText(/REPLY-CARD/);
	assert.equal(tab.window.location.hash, `${CHAT}&session=chat.jsonl`, "All clears the selection, keeping the session file");

	// A send and a retried stored send carry only the supported fields.
	tab.click(await tab.find(".operator-composer-send", (b) => !b.hasAttribute("disabled")));
	await until(() => sent(tab).length, (n) => n === 1, "the send");
	tab.click(await tab.find(".session-pending-again", (b) => !b.hasAttribute("disabled")));
	await until(() => sent(tab).length, (n) => n === 2, "the retried send");
	assert.deepEqual(sent(tab).map((body) => [body.text, Object.keys(body).sort()]), [["KEEP-DRAFT", ["client_id", "kind", "text"]], ["OLD-SEND", ["client_id", "kind", "text"]]],
		"no thread or thread_id on a new or retried send");
	await settle();
	assert.deepEqual(tab.requests.filter((r) => /thread/.test(r.path)).map((r) => r.path), [], "no thread read or write");

	// Served CSS: the old thread row's size, selected fill, hover/focus and ellipsis; no thread or header-filter rules.
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (selector: string) => [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	assert.match(rule(".project-row"), /min-height:36px;padding:0 10px;border-radius:8px/);
	assert.match(rule(".project-row[aria-current=page]"), /background:var\(--nav-selected\)/);
	assert.match(rule(".project-row-name"), /text-overflow:ellipsis;white-space:nowrap/);
	assert.match(rule(".project-row:hover,.project-row:focus-visible"), /color:var\(--hover\)/);
	assert.doesNotMatch(css, /\.thread-|\.session-filter-menu|\.operator-composer-hash/, "the retired rules are gone");
});

// Scenario: the chat filter follows the session's projects
//   Given registered picp, atlas and a long name, and a current chat naming only picp and the long name
//   When the URL selects atlas, then All, then atlas's first reply lands, then the older session opens
//   Then atlas shows while selected, goes on All, returns with its reply, and the unattributed older session offers only All
test("project-sidebar-session: rows are the session's projects; a URL selection stays visible; a first reply adds its row; another session recomputes", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed: seedOlder });
	await operatorSession(t, d.stateDir);
	const rows = (tab: Tab) => tab.$$(ROWS).map((a) => a.textContent).join();
	const tab = await openTab(t, d.port, `${CHAT}&project=atlas`, new Map(), undefined, {}, true);
	await until(() => current(tab), (name) => name === "#atlas", "the URL's atlas selection");
	assert.equal(rows(tab), `#All projects,#${LONG},#atlas,#picp`, "a selected project outside the session keeps its row, in order");
	await until(() => tab.$(".session-entries")?.textContent ?? "", (text) => /No loaded entries for atlas/.test(text), "atlas filters to nothing");

	tab.click(tab.$$(ROWS).find((a) => a.textContent === "#All projects")!);
	tab.go(tab.window.location.hash);
	await until(() => rows(tab), (r) => r === `#All projects,#${LONG},#picp`, "cleared, atlas leaves the rows");

	appendFileSync(join(d.home, "pi-sessions", "chat.jsonl"), say(1, "assistant", "[atlas] ATLAS-FIRST"));
	tab.refresh();
	await tab.waitText(/ATLAS-FIRST/);
	await until(() => rows(tab), (r) => r === `#All projects,#${LONG},#atlas,#picp`, "atlas's first reply adds its row live");

	tab.go(`${CHAT}&session=old.jsonl`);
	await tab.waitText(/OLD-REPLY/);
	await until(() => rows(tab), (r) => r === "#All projects", "an older session with no attributed project offers only All");
	tab.go(`${CHAT}&session=chat.jsonl`);
	await until(() => rows(tab), (r) => r === `#All projects,#${LONG},#atlas,#picp`, "back on the current session, its rows return");
});
