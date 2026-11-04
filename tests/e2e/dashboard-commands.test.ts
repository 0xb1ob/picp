/**
 * Full match S6: composer commands through `bin/cp-view`, the served app and the operator session's real
 * dashboard-control socket (pi's ports recorded, no model). Browsing and IME never send; one Submit is one journaled
 * message; refusals keep the draft.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { dashboardCommand } from "../../src/dashboard-commands.ts";
import { controlJournalFile } from "../../src/viewer/control-files.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import type { Context } from "../harness/conversations.ts";
import { browserShims, dashboard, openTab, operatorSession, type Tab, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1";
const STATUS_TEXT = "Dashboard command /status: What is running and what needs me?";

/** A chat with one reply and one in-flight picp job to stop. */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	put("pi-sessions/chat.jsonl", `${JSON.stringify({ type: "message", timestamp: iso(10), message: { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] } })}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: join(home, "pi-sessions", "chat.jsonl") })}\n`);
	put(".pi-command-post/jobs.json", { jobs: [{ id: "cp-live", title: "Title cp-live", status: "in_progress", labels: ["project:picp", "kind:ship"], blocked_by: [] }] });
	put(LAYOUT.fleetFile, { jobs: [{ job_id: "cp-live", project: "picp", kind: "ship", phase: "held", dispatched_at: iso(60) }] });
}
const settle = () => new Promise((done) => setTimeout(done, 50));
const field = (tab: Tab) => tab.$(".operator-composer textarea") as unknown as HTMLTextAreaElement;
const posts = (tab: Tab) => tab.requests.filter((r) => r.method === "POST" && r.path === "/api/operator/message").map((r) => JSON.parse(r.body ?? "null") as Record<string, unknown>);
const n = (tab: Tab, selector: string) => tab.$$(selector).length;
/** POSTs as they start (`posts` lists them once answered). */
const sends = (tab: Tab) => tab.started.filter((r) => r === "POST /api/operator/message").length;
const send = (tab: Tab) => tab.$(".operator-composer-send")!;
const journal = (stateDir: string) => readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
async function type(tab: Tab, value: string) {
	Object.defineProperty(field(tab), "selectionStart", { configurable: true, writable: true, value: value.length });
	tab.type(field(tab) as unknown as Element, value);
	await settle();
}
/** A keydown on the composer field, with the browser's IME flag when `isComposing`. */
async function press(tab: Tab, key: string, isComposing = false) {
	const event = new tab.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, { key: { value: key }, isComposing: { value: isComposing }, keyCode: { value: isComposing ? 229 : 0 } });
	(field(tab) as unknown as Element).dispatchEvent(event);
	await settle();
}
async function pick(tab: Tab, command: string) {
	tab.click(tab.$(".operator-composer-slash")!);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith(command)));
	await tab.find(".operator-composer-command code", (c) => c.textContent!.startsWith(command));
}
const open = async (t: Context, ports: Parameters<typeof operatorSession>[3]) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	const session = await operatorSession(t, d.stateDir, () => true, ports);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	await tab.find(".operator-composer textarea");
	return { d, tab, injected: session.injected };
};

test("commands-submit: menu browsing and IME never send; one Submit sends /status once, journaled; the text draft stays", { timeout: 180_000 }, async (t) => {
	const { d, tab, injected } = await open(t, { command: dashboardCommand });
	await type(tab, "KEEP");
	await pick(tab, "/status");
	await press(tab, "Enter", true);
	assert.deepEqual([sends(tab), injected.length, field(tab).value], [0, 0, "KEEP"], "browsing, picking and an IME Enter send nothing");
	// A double click before the first answer: one POST, one injection (the idempotency key and the in-flight guard).
	tab.click(send(tab));
	tab.click(send(tab));
	await until(() => n(tab, ".operator-composer-command"), (c) => c === 0, "the accepted command clears");
	await settle();
	const [body] = posts(tab);
	// Human provenance: the bridge's own dashboard tag, as on every composer send.
	assert.deepEqual([sends(tab), injected.map(([text]) => text), field(tab).value], [1, [`${STATUS_TEXT}\n\n[cp-dashboard ${String(body!.client_id)} — from the dashboard]`], "KEEP"],
		"one request, the text draft kept");
	assert.deepEqual([body!.kind, body!.command, /^dc-\d{14}-[0-9a-f]{8}$/.test(String(body!.client_id))], ["command", "status", true]);
	const requests = journal(d.stateDir).filter((l) => l.type === "request");
	assert.deepEqual(requests.map((l) => [l.kind, l.command, l.text, l.id === body!.client_id]), [["message", "/status", STATUS_TEXT, true]], "journaled before injection, as a human message");
	// The same key again is refused by the bridge, never injected twice.
	const token = String((await d.get("/api/operator/control")).body.token);
	const again = await d.get("/api/operator/message", { method: "POST", body: JSON.stringify(body), headers: { origin: d.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": token } });
	assert.deepEqual([again.status, injected.length], [409, 1]);
});

test("commands-stop: /stop without a job never sends; its picked job sends one stop request; an unknown command stays text or is refused", { timeout: 180_000 }, async (t) => {
	const { d, tab, injected } = await open(t, { command: dashboardCommand });
	await pick(tab, "/stop");
	assert.deepEqual([tab.$("#operator-composer-command-menu h3")!.textContent, tab.$(".operator-composer-command > span")!.textContent, send(tab).hasAttribute("disabled")],
		["Stop which job?", "Pick the job to stop with @ job", true], "/stop keeps the menu on its job list; Submit waits for a job");
	tab.key(tab.$(".operator-composer-slash")!, "Escape");
	await until(() => n(tab, "#operator-composer-command-menu"), (c) => c === 0, "Escape closes the menu");
	await press(tab, "Enter");
	assert.deepEqual([sends(tab), injected.length], [0, 0], "Enter without a target sends nothing");
	tab.click(tab.$(".operator-composer-at")!);
	tab.click(await tab.find("#operator-composer-command-menu button", (b) => b.textContent!.startsWith("cp-live")));
	await tab.find(".operator-composer-command code", (c) => c.textContent === "/stop cp-live");
	tab.click(send(tab));
	await until(() => injected.length, (c) => c === 1, "the stop request");
	assert.match(injected[0]![0], /^Dashboard command \/stop cp-live: please stop job cp-live\. This is my request, not a grant change;/);
	assert.deepEqual((await until(() => posts(tab), (p) => p.length > 0, "the stop POST")).map((b) => [b.command, b.job_id]), [["stop", "cp-live"]]);

	// Typed `/deploy now` is no command: it is sent as the text it is.
	await type(tab, "/deploy now");
	await press(tab, "Enter");
	await until(() => injected.length, (c) => c === 2, "the plain message");
	assert.deepEqual([injected[1]![0].split("\n\n")[0], (await until(() => posts(tab), (p) => p.length === 2, "the message POST")).at(-1)!.kind], ["/deploy now", "message"]);
	const token = String((await d.get("/api/operator/control")).body.token);
	const post = (body: unknown) => d.get("/api/operator/message", { method: "POST", body: JSON.stringify(body), headers: { origin: d.origin, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-cp-control-token": token } });
	const id = (k: number) => `dc-20260101000000-0000000${k}`;
	const refused = await Promise.all([{ kind: "command", command: "deploy", client_id: id(1) }, { kind: "command", command: "stop", client_id: id(2) },
		{ kind: "command", command: "stop", job_id: "../x", client_id: id(3) }, { kind: "command", command: "status", job_id: "cp-live", client_id: id(4) }].map(post));
	assert.deepEqual(refused.map((r) => `${r.status} ${String(r.body.error)}`), ['400 command must be "status" or "stop"; send anything else as a message', "400 /stop needs the job to stop",
		"400 job_id must be a job id", "400 /status takes no job"], "explicit validation errors, nothing run");
	assert.equal(injected.length, 2, "no refused command reached the session");
});

test("commands-old-bridge: a cp-bridge without the command port refuses with restart-required, and the command and draft stay", { timeout: 180_000 }, async (t) => {
	const { tab, injected } = await open(t, {});
	await type(tab, "KEEP");
	await pick(tab, "/status");
	tab.click(send(tab));
	const alert = await tab.find(".operator-composer-command [role=alert]");
	assert.match(alert.textContent!, /^unsupported: this session's cp-bridge predates dashboard commands; restart the session/);
	assert.deepEqual([tab.$(".operator-composer-command code")!.textContent, field(tab).value, send(tab).hasAttribute("disabled"), injected.length], ["/status", "KEEP", false, 0],
		"the command, the text and Submit stay for a retry after the restart");
});
