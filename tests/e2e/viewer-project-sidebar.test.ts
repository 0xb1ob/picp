/**
 * The operator chat's sidebar project rows (they replaced the retired thread rail), through `bin/cp-view` on a scratch
 * home, its real dashboard-control owner and the served app in its linkedom tab (DOM and served CSS; no layout).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

/** A chat; three registered projects (one long, none named in it); a garbage retired thread registry. */
function seed(stateDir: string, home: string) {
	const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
	const chat = join(home, "pi-sessions", "chat.jsonl");
	put(chat, `${JSON.stringify({ type: "message", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	put(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	put(join(dirname(stateDir), "data", "projects.json"), JSON.stringify({ projects: [{ name: "picp" }, { name: LONG }, { name: "atlas" }] }));
	put(join(stateDir, "operator", "named-threads.jsonl"), "{not json\n");
}
const settle = () => new Promise((done) => setTimeout(done, 50));
const current = (tab: Tab) => tab.$(`${ROWS}[aria-current="page"]`)?.textContent;
const sent = (tab: Tab) => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message").map((r) => JSON.parse(r.body!) as Record<string, unknown>);

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
	assert.deepEqual([tab.$$(ROWS).map((a) => a.textContent), current(tab)], [["#All projects", `#${LONG}`, "#atlas", "#picp"], "#All projects"],
		"All first, then every registered name sorted, including ones with no loaded messages");
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
	assert.equal(picp.getAttribute("href"), `${CHAT}&session=chat.jsonl&project=picp`, "a row moves only the selection");
	tab.go(picp.getAttribute("href")!);
	await until(() => current(tab), (name) => name === "#picp", "the picp row current");
	await until(() => tab.$(".session-entries")?.textContent ?? "", (text) => /No loaded entries for picp/.test(text), "picp filters the transcript");
	assert.equal((tab.$(".operator-composer textarea") as unknown as { value: string }).value, "KEEP-DRAFT", "one draft per session file, not per selection");
	tab.go(tab.$$(ROWS).find((a) => a.textContent === "#All projects")!.getAttribute("href")!);
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

	// Served CSS: the old thread row's size, selected fill and ellipsis; no thread or header-filter rules remain.
	const css = (await d.get(String(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)?.[1]))).text;
	const rule = (selector: string) => [...css.matchAll(/(?<=^|[{}])([^{}@]+)\{([^{}]*)\}/g)].filter((m) => m[1] === selector).map((m) => m[2]).join(";");
	assert.match(rule(".project-row"), /min-height:36px;padding:0 10px;border-radius:8px/);
	assert.match(rule(".project-row[aria-current=page]"), /background:var\(--nav-selected\)/);
	assert.match(rule(".project-row-name"), /text-overflow:ellipsis;white-space:nowrap/);
	assert.doesNotMatch(css, /\.thread-|\.session-filter-menu|\.operator-composer-hash/, "the retired rules are gone");
});
