/**
 * Behavior 19 (P19a), second file: the Sessions transcripts and the file explorer as `bin/cp-view` serves them on a
 * scratch home, over real HTTP and in the served app's linkedom tab (DOM and text only, no layout).
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { controlJournalFile } from "../../src/viewer/control-files.ts";
import { viewerConfigFile } from "../../src/viewer/host-config.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import { type Json, jsonl, pick, send, viewer, write } from "../harness/conversations.ts";
import { until } from "../harness/dashboard.ts";
import { git } from "../harness/index.ts";

// ---- sessions ------------------------------------------------------------------------------------------------------

const say = (timestamp: string, m: unknown) => JSON.stringify({ type: "message", timestamp, message: m });
const bridgeNote = (timestamp: string, content: string) => JSON.stringify({ type: "custom_message", timestamp, customType: "cp-bridge", display: true, content });
/** Records `files` (oldest first) as the operator session's pi transcripts, as cp-bridge does. */
const record = (stateDir: string, files: Array<[string, string]>) => write(operatorSessionsFile(join(stateDir, "sessions")), jsonl(files.map(([at, session_file]) => ({ at, session_file }))));

test("P19-sessions: /api/sessions traces recorded decision chains and confined worker transcripts; /api/files keeps its confined roots", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-26T10:39:00Z", send = "ps-20260926103900-1234abcd";
	const d = await viewer(t);
	const s = d.stateDir;
	write(join(s, "fleet.json"), { jobs: [{ job_id: "cp-one", project: "demo", phase: "held", worker: { session_file: join(s, "sessions/one.jsonl") } }] });
	write(join(s, "sessions/cp-parent.sends.json"), { entries: [{ id: send, text: "Approve this change", queued_at: at, state: "settled", delegated: true, reply: "Done", owner_observed_at: at }] });
	write(join(s, "escalations.json"), { items: [{ id: "es-abcd", question: "Approve risk?", kind: "risk_high_irreversible", created_at: "2026-09-26T10:36:00Z", status: "answered", answer: "approve", answered_by: "operator-delegated", answered_at: at, send_id: send }] });
	write(join(s, "sessions/one.jsonl"), jsonl([{ type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Working <script>" }, { type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] } }]));
	write(join(s, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: at, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }], source_escalation: "es-abcd" }]));
	const sendsBefore = readFileSync(join(s, "sessions/cp-parent.sends.json"), "utf8");
	const get = async (path: string) => (await d.get(path)).body as Json;
	assert.equal((await get("/api/sessions")).active[0].id, "cp-one", "the classic sidebar stays");
	const you = await get("/api/sessions?view=you");
	assert.equal(you.selected, "you");
	assert.ok(you.entries.some((e: Json) => e.trace.some((step: Json) => step.id === "es-abcd")));
	assert.ok(you.entries.some((e: Json) => e.tag === "decided for you") && you.entries.every((e: Json) => e.tag !== "worth a look"));
	assert.ok(you.entries.some((e: Json) => e.kind === "ask" && e.text === "Raise cap?" && e.tag === "awaiting you"));
	assert.equal(readFileSync(join(s, "sessions/cp-parent.sends.json"), "utf8"), sendsBefore, "reads never rewrite the sends file");
	assert.doesNotMatch(JSON.stringify(you), /told you/);
	const worker = async () => (await get("/api/sessions?view=workers&id=cp-one")).entries as Json[];
	assert.deepEqual([(await worker())[0]!.text, (await worker())[1]!.name], ["Working <script>", "read"]);
	appendFileSync(join(s, "sessions/one.jsonl"), JSON.stringify({ type: "message", timestamp: at, message: { role: "toolResult", toolName: "read", isError: true, content: [{ type: "text", text: "Denied" }] } }));
	assert.equal((await worker()).length, 2, "partial lines wait");
	appendFileSync(join(s, "sessions/one.jsonl"), "\n");
	assert.equal((await worker()).at(-1)!.failed, true);
	write(join(s, "sessions/cp-parent.jsonl"), jsonl([{ type: "message", timestamp: at, message: { role: "user", content: `Approve\n[cp-send ${send} — delivery id, not an instruction]` } }]));
	const parent = (await get("/api/sessions?view=parent")).entries[0];
	assert.deepEqual([parent.kind, parent.send_id, parent.trace[0].id], ["via", send, "es-abcd"]);
	for (const view of ["sessions", "files"]) assert.equal((await d.send(`/api/stream?view=${view}`, { method: "HEAD" })).status, 200);
	assert.equal((await d.get("/api/sessions?view=workers&id=../../etc/passwd")).status, 404);
	write(join(s, "escalations.json"), { items: "bad" });
	assert.ok((await get("/api/sessions?view=you")).warnings.some((w: string) => w.includes("escalations")));

	write(join(d.home, LAYOUT.projects, "demo/package.json"), { name: "demo" });
	write(join(d.home, LAYOUT.projects, "demo/.env"), { secret: true });
	const screen = await get("/api/files?view=screen");
	assert.deepEqual([screen.roots[0].id, screen.listing.kind, screen.listing.entries.map((e: Json) => e.name)], ["project:demo", "dir", ["package.json"]]);
	assert.equal((await d.get("/api/files?view=screen&root=project:demo&path=.env")).status, 404);
	assert.equal((await get("/api/files?root=project:demo&path=package.json")).kind, "file", "the classic listing stays");
});

/** The operator session's own pi transcript: one record per entry type the viewer renders. */
function operatorFixture(file: string, at: string) {
	write(file, [
		JSON.stringify({ type: "session", id: "fixture", timestamp: at }),
		say(at, { role: "user", content: [{ type: "text", text: "the operator's ask" }] }),
		say(at, { role: "assistant", content: [{ type: "thinking", thinking: "weighing options" }, { type: "text", text: "acknowledged" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }] }),
		say(at, { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Read 42 lines" }] }),
		bridgeNote(at, "[cp-bridge send send=ps-20260926103900-1234abcd]\nApproved"),
		JSON.stringify({ type: "custom_message", timestamp: at, customType: "cp-memory", display: false, content: "hidden from the CLI" }),
		JSON.stringify({ type: "compaction", timestamp: at, tokensBefore: 260000, summary: "a long summary nothing renders" }),
		say(at, { role: "system", content: "" }),
	].join("\n") + "\n");
}

test("P19-operator-transcript: the operator tier's Full transcript renders the recorded file by entry type, follows the deep link and is tailnet-only", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-27T08:24:05Z";
	const d = await viewer(t);
	const older = join(d.home, "pi-sessions", "older.jsonl"), newest = join(d.home, "pi-sessions", "newest.jsonl");
	operatorFixture(newest, at);
	write(older, jsonl([{ type: "message", timestamp: "2026-09-26T18:00:00Z", message: { role: "user", content: [{ type: "text", text: "the older session" }] } }]));
	const get = async (path: string) => (await d.get(path)).body as Json;
	const FULL = "/api/sessions?view=you&transcript=1";
	let out = await get(FULL);
	assert.deepEqual([out.entries.length, out.operator_session], [0, null]);
	assert.match(out.warnings[0], /No operator session recorded yet/);
	assert.ok(out.warnings[0].includes(operatorSessionsFile(join(d.stateDir, "sessions"))), "the empty state names the record the bridge would have written");
	const gone = join(d.home, "pi-sessions", "gone.jsonl");
	record(d.stateDir, [["2026-09-27T08:24:05.000Z", gone]]);
	out = await get(FULL);
	assert.deepEqual([out.entries.length, out.operator_session, out.warnings[0]], [0, "gone.jsonl", `Operator transcript missing: ${gone} (ENOENT)`]);
	const notAFile = join(d.home, "pi-sessions", "directory.jsonl");
	mkdirSync(notAFile, { recursive: true });
	record(d.stateDir, [["2026-09-28T08:24:05.000Z", notAFile]]);
	assert.equal((await get(FULL)).warnings[0], `Operator transcript unreadable: ${notAFile} (not a file)`);
	write(join(d.stateDir, "operator/asks.jsonl"), jsonl([{ type: "open", id: "ask-abcd", project: "demo", question: "Raise cap?", created_at: at, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }] }]));

	record(d.stateDir, [["2026-09-26T18:00:00.000Z", older], ["2026-09-27T08:24:05.000Z", newest]]);
	const decisions = await get("/api/sessions?view=you");
	assert.deepEqual([decisions.transcript, decisions.subtitle], [undefined, "Recorded decisions and questions"], "the recorded decisions view is still the default");
	assert.ok(decisions.entries.some((e: Json) => e.tag === "awaiting you"));
	const full = await get(FULL);
	assert.deepEqual([full.transcript, full.subtitle, full.operator_session], [true, "Full transcript", "newest.jsonl"]);
	assert.deepEqual(full.operator_sessions.map((s: Json) => s.id), ["newest.jsonl", "older.jsonl"], "newest first, and the older file stays listed");
	assert.deepEqual(full.entries.map((e: Json) => [e.kind, e.name, e.who]), [
		["say", null, "Operator"], ["tool", "thinking", "assistant"], ["say", null, "Assistant"], ["tool", "read", "assistant"], ["system", null, "cp-bridge"], ["system", null, "compaction"], ["ask", null, "Operator → you"],
	], "user, thinking, assistant text, the paired tool call, the bridge message, the compaction marker, the open ask's card");
	assert.deepEqual([full.entries[0].text, full.entries[0].at, full.entries[1].text], ["the operator's ask", at, "weighing options"]);
	assert.match(full.entries[3].text, /Arguments\n\{\n {2}"path": "src\/a\.ts"\n\}/);
	assert.match(full.entries[3].text, /Result\nRead 42 lines/, "the result pairs with its call, not a second entry");
	assert.deepEqual([full.entries[4].tag, full.entries[4].text, full.entries[4].bridge, full.entries[4].paths], ["bridge", "Approved", { kind: "send", job: null, id: null, receipt: null }, undefined]);
	assert.match(full.entries[5].text, /260000 tokens before/);
	assert.ok(!full.entries.some((e: Json) => e.text === "hidden from the CLI" || !e.text.trim()), "display:false and the empty system record add nothing");
	const first = await get(`${FULL}&session=older.jsonl`);
	assert.deepEqual([first.operator_session, first.entries[0].text], ["older.jsonl", "the older session"]);
	assert.equal((await d.get(`${FULL}&session=nope.jsonl`)).status, 404, "an unknown id is the same 404 an unknown worker id is");
	assert.equal((await get("/api/sessions?view=parent&transcript=1")).entries.length, 0, "the parent tier ignores the new params");
	appendFileSync(newest, say("2026-09-27T08:30:00Z", { role: "user", content: [{ type: "text", text: "a later operator word" }] }) + "\n");
	assert.deepEqual(pick((await get(FULL)).entries.at(-1), ["text", "who"]), { text: "a later operator word", who: "Operator" }, "every read re-reads the file");

	// The app's own loader turns each deep link into this projection's request.
	const requested = async (hash: string) => {
		const tab = await d.open(hash);
		return String(await until(() => tab.requests.find((r) => r.path.startsWith("/api/sessions"))?.path, Boolean, `${hash}'s data request`));
	};
	assert.equal(await requested("#sessions?view=you&transcript=1&session=older.jsonl"), "/api/sessions?view=you&transcript=1&session=older.jsonl");
	assert.equal(new URLSearchParams((await requested("#sessions")).split("?")[1]).get("view"), "you", "#sessions opens the operator tier");
	assert.equal(new URLSearchParams((await requested("#sessions?view=you")).split("?")[1]).get("transcript"), "1", "the default hash opens the Full transcript");
	const zero = await requested("#sessions?view=you&transcript=0");
	assert.equal((await get(zero)).transcript, undefined, "transcript=0 is the recorded decisions view");

	const foreign = (port: number) => send(port, FULL, { headers: { host: "evil.example" } });
	const plain = await viewer(t, { requireTailnet: false });
	const refused = await plain.get(FULL);
	assert.equal(refused.status, 403, "only a viewer started with --require-tailnet serves this route");
	assert.match(String(refused.body.error), /require-tailnet/);
	assert.equal((await plain.get("/api/sessions?view=you")).status, 200, "every other route is untouched");
	assert.equal((await foreign(plain.port)).status, 403, "a foreign Host still meets the transcript guard");
	write(viewerConfigFile(d.stateDir), '{"strict_host":true}');
	assert.equal((await foreign(d.port)).status, 421, "under viewer.strict_host an off-tailnet Host is refused before the transcript is read");
	assert.equal((await d.get(FULL)).status, 200, "and the same route answers on the bind itself");
});

test("P19-transcript-notices: bridge notices parse their fields and paths: block into links; a project chip only for a known projects/* dir", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-27T16:18:00Z";
	const d = await viewer(t);
	const run = join(d.stateDir, "runs", "cp-xrhq");
	write(join(d.stateDir, "fleet.json"), { jobs: [{ job_id: "cp-xrhq", project: "demo", phase: "done", worker: {} }] });
	write(join(run, "artifact.md"), "the artifact\n");
	mkdirSync(join(d.home, LAYOUT.projects, "picp"), { recursive: true });
	write(join(d.home, LAYOUT.projects, "notes.txt"), "not a project\n");
	const assistant = (text: string) => say(at, { role: "assistant", content: [{ type: "text", text }] });
	const file = join(d.home, "pi-sessions", "session.jsonl");
	write(file, [
		bridgeNote(at, `[cp-bridge wake job=cp-xrhq receipt=owner_observed]\nMobile chat landed.\npaths:\n- ${join(run, "artifact.md")}\n- ${run}\n- ${join(d.home, "gone/nothing.md")}`),
		bridgeNote(at, "[cp-bridge send send=ps-20260927161800-1234abcd]\nApproved"),
		assistant("[picp] landed the chip"), assistant("[notes.txt] stays in the text"), assistant("[unknown] stays too"),
		bridgeNote(at, "[cp-bridge escalation job=cp-1 id=es-abcd stale receipt=turn_settled]\nbody line"),
		bridgeNote(at, "[cp-bridge wake extra]\nstill the header"),
	].join("\n") + "\n");
	record(d.stateDir, [[at, file]]);
	const entries = ((await d.get("/api/sessions?view=you&transcript=1")).body as Json).entries as Json[];
	const wake = entries[0]!;
	assert.deepEqual(wake.paths.map((p: Json) => [p.path, p.href]), [[join(run, "artifact.md"), "#job/cp-xrhq"], [run, "#job/cp-xrhq"], [join(d.home, "gone/nothing.md"), null]], "each path resolves by the viewer's own evidence rules; an unreadable one is not a link");
	assert.equal(entries[1]!.paths, undefined, "a notice with no paths: block is left alone");
	assert.deepEqual(wake.bridge, { kind: "wake", job: "cp-xrhq", id: null, receipt: "owner_observed" });
	assert.ok(wake.text.startsWith("Mobile chat landed.") && !wake.text.startsWith("[cp-bridge"));
	assert.deepEqual(wake.links, { [join(run, "artifact.md")]: "#job/cp-xrhq", [run]: "#job/cp-xrhq" }, "bare paths in the text resolve by the same helper");
	const says = entries.filter((e) => e.kind === "say");
	assert.deepEqual(says.map((e) => [e.project, e.text]), [["picp", "landed the chip"], [undefined, "[notes.txt] stays in the text"], [undefined, "[unknown] stays too"]]);
	const escalation = entries.find((e) => e.bridge?.kind === "escalation")!;
	assert.deepEqual([escalation.bridge, escalation.text], [{ kind: "escalation", job: "cp-1", id: "es-abcd", receipt: "turn_settled" }, "body line"]);
	const bare = entries.find((e) => String(e.text).includes("still the header"))!;
	assert.equal(bare.bridge, undefined, "a header line that is not exactly the cp-bridge tag stays text");
	assert.match(bare.text, /^\[cp-bridge wake extra\]/);
});

test("P19-transcript-cards: each cp_parent ask is followed by its decision card, dashboard messages carry their ids, and the window keeps open cards", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-27T08:20:00Z";
	const d = await viewer(t);
	const file = join(d.home, "pi-sessions", "session.jsonl");
	const message = (m: unknown) => say(at, m);
	const askCall = (call: string, id: string) => [
		message({ role: "assistant", content: [{ type: "toolCall", id: call, name: "cp_parent", arguments: { action: "ask", ask: { project: "demo", question: "q", options: [{ label: "Keep", consequence: "c" }], recommendation: "Keep" } } }] }),
		message({ role: "toolResult", toolCallId: call, toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id, state: "open" }) }] }),
	];
	write(file, [
		message({ role: "user", content: [{ type: "text", text: "what next?" }] }),
		...askCall("call-a", "ask-abcd"), ...askCall("call-b", "ask-bbbb"),
		message({ role: "user", content: [{ type: "text", text: "ask-abcd: Keep\n\n[cp-dashboard dc-20260927082500-0123abcd — from the dashboard; ask=ask-abcd]" }] }),
		message({ role: "user", content: [{ type: "text", text: "steer: stop the merge\n\n[cp-dashboard dc-20260927082600-4567cdef — from the dashboard]" }] }),
		message({ role: "user", content: [{ type: "text", text: "look\n\n[cp-dashboard dc-20260927082700-89abcdef — from the dashboard; images=im-20260927-0123456789abcdef01234567.png]" }, { type: "image", data: "aGk=", mimeType: "image/png" }] }),
		message({ role: "user", content: [{ type: "text", text: "from the CLI" }, { type: "image", data: "aGk=", mimeType: "image/png" }] }),
	].join("\n") + "\n");
	const ask = (id: string, created_at: string) => ({ type: "open", id, project: "demo", question: `Question ${id}`, created_at, recommendation: "Keep", options: [{ label: "Keep", consequence: "Paused" }, { label: "Raise", consequence: "Spends" }] });
	write(join(d.stateDir, "operator/asks.jsonl"), jsonl([ask("ask-abcd", at), ask("ask-bbbb", at), { type: "answer", id: "ask-bbbb", answer: "Raise", answered_at: "2026-09-27T08:30:00Z" }, ask("ask-cccc", at), { type: "answer", id: "ask-cccc", answer: "Keep", answered_at: at }, ask("ask-dddd", "2026-09-26T08:00:00Z")]));
	record(d.stateDir, [[at, file]]);
	const full = async () => ((await d.get("/api/sessions?view=you&transcript=1")).body as Json);
	const entries = (await full()).entries as Json[];
	assert.deepEqual(entries.map((e) => e.kind === "ask" ? `card:${e.ask.id}:${e.ask.state}` : e.kind === "tool" ? `tool:${e.ask_id}` : e.kind),
		["card:ask-dddd:open", "say", "tool:ask-abcd", "card:ask-abcd:open", "tool:ask-bbbb", "card:ask-bbbb:answered", "via", "via", "via", "say"],
		"a card follows the call that raised it; an older unanchored open ask sits at the top; a settled unanchored one is omitted");
	assert.deepEqual(entries[3]!.ask.options.map((o: Json) => [o.label, o.consequence, o.reply]), [["Keep", "Paused", "ask-abcd: Keep"], ["Raise", "Spends", "ask-abcd: Raise"]]);
	assert.deepEqual([entries[3]!.ask.recommendation, entries[3]!.tag, entries[5]!.ask.answer, entries[5]!.ask.answered_at], ["Keep", "awaiting you", "Raise", "2026-09-27T08:30:00Z"]);
	assert.deepEqual(pick(entries[6]!, ["who", "tag", "text", "dashboard_id", "ask_id"]), { who: "Operator (dashboard)", tag: "dashboard", text: "ask-abcd: Keep", dashboard_id: "dc-20260927082500-0123abcd", ask_id: "ask-abcd" }, "the marker is stripped and read");
	assert.deepEqual(pick(entries[7]!, ["text", "dashboard_id", "ask_id", "images"]), { text: "steer: stop the merge", dashboard_id: "dc-20260927082600-4567cdef", ask_id: undefined, images: undefined });
	assert.deepEqual(pick(entries[8]!, ["tag", "text", "dashboard_id", "images"]), { tag: "dashboard", text: "look", dashboard_id: "dc-20260927082700-89abcdef", images: ["im-20260927-0123456789abcdef01234567.png"] }, "image parts follow the marker: its ids are the thumbnails");
	assert.equal(entries[9]!.text, "from the CLI\n[image]", "a CLI message with an image is unchanged");
	const fileId = "tx-20260927-0123456789abcdef01234567.html";
	appendFileSync(file, message({ role: "user", content: `File: original.html\n\`\`\`text\n<script>literal</script>\n\`\`\`\n\n[cp-dashboard dc-20260927082800-0123abcd — from the dashboard; thread=notes; files=${fileId}]` }) + "\n");
	write(controlJournalFile(d.stateDir), jsonl([{ type: "upload", id: fileId, mime: "text/plain", bytes: 24, name: "original.html" }]));
	const withFile = (await full()).entries.at(-1);
	assert.deepEqual(pick(withFile, ["tag", "files", "file_metadata"]), { tag: "dashboard", files: [fileId], file_metadata: { [fileId]: { name: "original.html", bytes: 24 } } });
	assert.ok(withFile.text.includes("<script>literal</script>"));
	appendFileSync(file, message({ role: "user", content: [{ type: "text", text: 'from the phone\n\n[cp-remote — through a paired remote device, not this terminal: sent by dev-0123456789abcdef "Phone"]\n[cp-dashboard dc-20260927082900-0123abcd — from the dashboard; remote]' }] }) + "\n");
	assert.deepEqual(pick((await full()).entries.at(-1), ["tag", "text", "dashboard_id", "remote"]), { tag: "dashboard", text: "from the phone", dashboard_id: "dc-20260927082900-0123abcd", remote: { sender: { device_id: "dev-0123456789abcdef", name: "Phone" }, editors: [] } }, "the device line is read into remote, never body text");

	write(file, [
		message({ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "cp_parent", arguments: { action: "ask" } }] }),
		message({ role: "toolResult", toolCallId: "call-a", toolName: "cp_parent", content: [{ type: "text", text: JSON.stringify({ id: "ask-abcd" }) }] }),
		...Array.from({ length: 320 }, (_, i) => message({ role: "user", content: [{ type: "text", text: `line ${i}` }] })),
	].join("\n") + "\n");
	write(join(d.stateDir, "operator/asks.jsonl"), jsonl([ask("ask-abcd", at)]));
	const windowed = await full();
	assert.deepEqual([windowed.truncated, windowed.entries[0].ask.id, windowed.entries.at(-1).text, windowed.entries.length], [true, "ask-abcd", "line 319", 301], "the 300-entry window never drops an open decision card");
});

test("P19-upload-metadata: a dashboard file's name and size follow the upload journal as it grows, is truncated, rotated or removed", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const [first, second] = ["tx-20261004-0123456789abcdef01234567.md", "tx-20261004-abcdef0123456789abcdef01.txt"];
	const file = join(d.home, "pi-sessions", "session.jsonl");
	write(file, say("2026-10-04T14:00:00Z", { role: "user", content: `look\n\n[cp-dashboard dc-20261004140000-0123abcd — from the dashboard; files=${first},${second}]` }) + "\n");
	record(d.stateDir, [["2026-10-04T14:00:00Z", file]]);
	const journal = controlJournalFile(d.stateDir);
	const upload = (id: string, name: string, bytes: number) => `${JSON.stringify({ type: "upload", id, name, bytes })}\n`;
	const meta = async () => ((await d.get("/api/sessions?view=you&transcript=1")).body as Json).entries.at(-1).file_metadata as Json;
	write(journal, upload(first, "../report[1].md", 12) + upload(second, "image.png", 20));
	assert.deepEqual(await meta(), { [first]: { name: "report_1_.md", bytes: 12 }, [second]: { name: "image.png", bytes: 20 } }, "names are sanitized");
	appendFileSync(journal, `${upload(first, "latest.md", 30)}not json\n${upload(first, "invalid", -1)}`);
	assert.deepEqual(await meta(), { [first]: { name: "latest.md", bytes: 30 }, [second]: { name: "image.png", bytes: 20 } }, "the latest valid record wins; bad lines are skipped");
	write(journal, upload(second, "new.png", 3));
	assert.deepEqual(await meta(), { [second]: { name: "new.png", bytes: 3 } }, "a truncated journal starts over");
	renameSync(journal, `${journal}.old`);
	write(journal, upload(first, "rotated.md", 4) + `${JSON.stringify({ type: "request", text: "x".repeat(300) })}\n`);
	assert.deepEqual(await meta(), { [first]: { name: "rotated.md", bytes: 4 } }, "a rotated, larger journal starts over");
	rmSync(journal);
	assert.deepEqual(await meta(), {}, "a missing journal names nothing");
	write(journal, upload(second, "restored.png", 5));
	assert.deepEqual(await meta(), { [second]: { name: "restored.png", bytes: 5 } });

	const partial = Buffer.from(upload(first, "café.md", 2).trimEnd());
	const split = partial.indexOf(Buffer.from("é")) + 1;
	// Rewritten in place (same inode, larger, other bytes): size and inode alone would read on from the old offset.
	write(journal, Buffer.concat([Buffer.from(upload(second, "keep.png", 1)), partial.subarray(0, split)]));
	assert.deepEqual(await meta(), { [second]: { name: "keep.png", bytes: 1 } }, "a partial record split inside a UTF-8 character waits");
	appendFileSync(journal, partial.subarray(split));
	assert.deepEqual(Object.keys(await meta()), [second], "valid JSON without its newline is still pending");
	appendFileSync(journal, "\n");
	assert.deepEqual((await meta())[first], { name: "caf_.md", bytes: 2 });
	appendFileSync(journal, "x".repeat(300));
	await meta();
	write(journal, `${upload(first, "replaced.md", 3)}${"x".repeat(150)}`);
	assert.deepEqual(await meta(), { [first]: { name: "replaced.md", bytes: 3 } }, "a shrink above the committed offset starts over");

	write(journal, `${JSON.stringify({ type: "request", text: "x".repeat(1024 * 1024 - 70) })}\n${upload(first, "boundary.md", 8)}`);
	assert.deepEqual(await meta(), { [first]: { name: "boundary.md", bytes: 8 } }, "a record across the read chunk boundary");
	appendFileSync(journal, JSON.stringify({ type: "upload", id: second, name: "large.txt", bytes: 9, ignored: "x".repeat(1024 * 1024 + 20) }));
	assert.equal((await meta())[second], undefined, "a large trailing record waits");
	appendFileSync(journal, "\n");
	assert.deepEqual((await meta())[second], { name: "large.txt", bytes: 9 }, "and is read whole once complete");
});

test("P19-sessions-qa: the operator tier shows decisions and every ask state, never parent replies; tool calls stay a collapsed pill until shown", { timeout: 120_000 }, async (t) => {
	const at = "2026-09-26T10:39:00Z", later = "2026-09-26T10:41:00Z", sendId = "ps-20260926103900-1234abcd";
	const d = await viewer(t);
	const s = d.stateDir, live = join(s, "sessions/live.jsonl");
	write(join(s, "fleet.json"), { jobs: [{ job_id: "cp-live", phase: "waiting", worker: { session_file: live } }, { job_id: "cp-failed", phase: "failed" }, { job_id: "cp-done", phase: "done" }] });
	write(join(s, "escalations.json"), { items: [{ id: "es-abcd", question: "Approve **review** of `src/main.ts`?", kind: "risk_high_irreversible", created_at: at, status: "answered", answer: "approve", answered_by: "operator-delegated", answered_at: later, send_id: sendId, delegation_rule: "Inside the approved objective" }] });
	write(join(s, "sessions/cp-parent.sends.json"), { entries: [{ id: sendId, text: "approve", queued_at: at, state: "settled", reply: "PARENT-REPLY-MUST-NOT-APPEAR", owner_observed_at: later }] });
	const asks = ["ask-aa", "ask-bb", "ask-cc"].map((id) => ({ type: "open", id, created_at: at, project: "demo", question: `Question ${id}`, options: [{ label: "Keep", consequence: "Paused" }], recommendation: "Keep", source_escalation: "es-abcd" }));
	write(join(s, "operator/asks.jsonl"), jsonl([...asks, { type: "answer", id: "ask-bb", answer: "Keep", answered_at: later }, { type: "withdraw", id: "ask-cc", reason: "No longer needed" }]));
	write(live, jsonl([
		{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/main.ts" } }] },
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Read 42 lines\nFull file contents" }] },
		{ role: "assistant", content: [{ type: "text", text: "**Checked** `src/main.ts` <script>alert(1)</script> [link](https://example.com)" }] },
	].map((message) => ({ type: "message", timestamp: at, message }))));
	const you = (await d.get("/api/sessions?view=you")).body as Json;
	assert.deepEqual(you.workers.map((w: Json) => w.id), ["cp-live", "cp-failed"], "a done worker stays hidden");
	assert.deepEqual(you.entries.find((e: Json) => e.kind === "decision").trace.map((step: Json) => [step.label, step.at]), [["parent asked", at], ["decided", later]]);
	assert.equal(you.entries.find((e: Json) => e.id === "ask-cc").at, at, "withdrawals have no recorded timestamp");

	const decisions = await d.open("#sessions?view=you&transcript=0");
	const text = await decisions.waitText(/No longer needed/);
	assert.doesNotMatch(text, /PARENT-REPLY-MUST-NOT-APPEAR|Parent reply via main session|worth a look|cp-done|told you/);
	for (const shown of [/send ps-20260926103900-1234abcd/, /Inside the approved objective/, /decided for you/, /awaiting you/, /Question ask-bb/, /Question ask-cc/, /Trace a decision/]) assert.match(text, shown);
	assert.equal(decisions.$$('a[href*="transcript="], .session-views').length, 0, "audit P4 #27: no Decisions / Full transcript toggle");
	assert.equal(decisions.$('[aria-label="Operator session file"]'), null, "no file picker before the transcript view");

	const worker = await d.open("#sessions?view=workers&id=cp-live");
	const pill = await worker.find("button.session-tools");
	assert.deepEqual([pill.getAttribute("aria-expanded"), pill.closest(".session-tool-run.session-steps") !== null], ["false", true]);
	assert.match(pill.textContent ?? "", /≡ 1 step/, "the shared ToolRunRow's collapsed steps pill");
	assert.equal(worker.$(".session-tool"), null, "a hidden tool call renders neither its summary nor its result");
	assert.doesNotMatch(worker.text(), /Full file contents/);
	assert.deepEqual([worker.$$("strong").some((b) => b.textContent === "Checked"), worker.$$("code").some((c) => c.textContent === "src/main.ts")], [true, true]);
	assert.ok(worker.text().includes("<script>alert(1)</script>") && !worker.$("script"), "markup in a reply is text");
	const link = worker.$('a[href="https://example.com"]')!;
	assert.deepEqual([link.textContent, link.getAttribute("target"), link.getAttribute("rel")], ["link", "_blank", "noopener noreferrer"]);
	worker.storage.set("cp-sessions-tool-calls", "1");
	const shown = await worker.reopen();
	const summary = (await shown.find("details.session-tool summary")).textContent ?? "";
	assert.match(summary, /Read 42 lines/);
	assert.doesNotMatch(summary, /"path"|Full file contents/, "the summary carries neither raw args nor the result body");
	assert.match(shown.text(), /Full file contents/);

	write(live, jsonl([{ type: "message", timestamp: at, message: { role: "toolResult", toolCallId: "older-call", toolName: "index", content: [{ type: "text", text: JSON.stringify({ summary: "Indexed 8 files", project: "demo" }) }] } }]));
	const orphan = ((await d.get("/api/sessions?view=workers&id=cp-live")).body as Json).entries[0];
	assert.equal(orphan.summary, "Indexed 8 files");
	assert.match(orphan.text, /"project":"demo"/);
});

test("P19-sessions-transcript-ui: the Full transcript offers a file picker, renders system notices and hides tool calls behind a count", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t);
	const newest = join(d.home, "pi-sessions", "newest.jsonl"), older = join(d.home, "pi-sessions", "older.jsonl");
	write(newest, [
		say("2026-09-27T08:24:05Z", { role: "user", content: [{ type: "text", text: "the operator's ask" }] }),
		say("2026-09-27T08:24:05Z", { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } }] }),
		say("2026-09-27T08:24:05Z", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: `${"x".repeat(1300)}-TAIL-MARKER` }] }),
		bridgeNote("2026-09-27T08:24:05Z", "[cp-bridge send send=ps-20260927082405-1234abcd]\napproved"),
		JSON.stringify({ type: "compaction", timestamp: "2026-09-27T08:24:05Z", tokensBefore: 260000, summary: "s" }),
	].join("\n") + "\n");
	write(older, say("2026-09-26T18:00:00Z", { role: "user", content: "older" }) + "\n");
	record(d.stateDir, [["2026-09-26T18:00:00Z", older], ["2026-09-27T08:24:05Z", newest]]);
	const tab = await d.open("#sessions?view=you&transcript=1");
	const picker = await tab.find('[aria-label="Operator session file"]');
	const label = (at: string) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
	const options = [...picker.querySelectorAll("option")].map((o) => [o.getAttribute("title"), o.textContent]);
	assert.deepEqual(options, [["newest.jsonl", `${label("2026-09-27T08:24:05Z")} · current`], ["older.jsonl", label("2026-09-26T18:00:00Z")]], "dated labels, the file name only as a title");
	await tab.waitText(/260000 tokens before/);
	assert.equal(tab.$$('a[href*="transcript="], .session-views').length, 0);
	const notices = tab.$$(".session-message.session-notice.session-system").map((n) => n.textContent ?? "");
	assert.deepEqual(notices.map((n) => n.replace(/^\d\d:\d\d/, "")), ["bridgesendapproved", "compactionContext compacted (260000 tokens before)"], "the bridge notice and the compaction marker");
	assert.match(tab.text(), /Tools 1/, "the transcript header offers the hidden count");
	assert.match(tab.text(), /1 step/, "the long tool call collapses to its one-line run");
	assert.doesNotMatch(tab.text(), /show all|-TAIL-MARKER/, "its text and its show-all link both stay hidden until shown");
});

// ---- explorer ------------------------------------------------------------------------------------------------------

const KEYS = ["key.pem", "tls.key", "id_rsa", "id_rsa.pub", "cert.p12", "auth.json"];
const SECRET_FILES = [".env", "sub/.ENV.prod", "secrets/db.txt", "deep/Secrets/x.txt", "k.pem", "sub/tls.key", "id_rsa", "sub/id_rsa.pub", "c.p12", "sub/auth.json"];

test("P19-explorer: /api/roots, /api/files and /api/git serve project clones and live worktrees, and no denied name, symlink out or traversal", { timeout: 120_000 }, async (t) => {
	let repo = "", sha = "";
	const d = await viewer(t, { seed: (stateDir, home, env) => {
		const pool = join(home, "pool"), outside = join(home, "outside");
		repo = join(home, LAYOUT.projects, "demo");
		mkdirSync(join(repo, "src", "Secrets"), { recursive: true });
		git(repo, "init", "-b", "main", "--quiet");
		for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
		write(join(repo, "src", "a.ts"), "export const a = 1;\n");
		write(join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
		for (const rel of [".env", ".env.local", "secrets/db.txt", ".github/workflows/ci.yml", ...KEYS.map((n) => `src/${n}`)]) write(join(repo, rel), "k\n");
		symlinkSync("/etc", join(repo, "out"));
		symlinkSync(".git/config", join(repo, "cfg"));
		symlinkSync("secrets", join(repo, "hidden"));
		git(repo, "add", "src/a.ts");
		git(repo, "commit", "-m", "first", "--quiet");
		sha = git(repo, "rev-parse", "HEAD");
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(home, LAYOUT.projects, "evil"));
		for (const wt of ["wt-held", "wt-done"]) mkdirSync(join(pool, wt), { recursive: true });
		write(join(stateDir, "fleet.json"), { jobs: [
			{ job_id: "cp-held", project: "demo", phase: "held", worktree: join(pool, "wt-held") },
			{ job_id: "cp-done", project: "demo", phase: "done", worktree: join(pool, "wt-done") },
			{ job_id: "cp-away", project: "demo", phase: "waiting", worktree: outside },
			{ job_id: "cp-sec", project: "demo", kind: "ship", delivery: "pr", phase: "held", worktree: "/nonexistent/cp-sec" },
		] });
		env.CP_TREEHOUSE_ROOT = pool;
	} });
	const files = (root: string, path: string) => d.get(`/api/files?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
	const read = async (path: string, root = "project:demo") => (await files(root, path)).body as Json;
	assert.deepEqual(((await d.get("/api/roots")).body as Json).roots.map((r: Json) => r.id), ["project:demo", "worktree:cp-held"], "clones and live pool worktrees only");
	assert.deepEqual(pick(await read("src/a.ts"), ["kind", "size", "binary", "too_large", "text"]), { kind: "file", size: 20, binary: false, too_large: false, text: "export const a = 1;\n" });
	assert.deepEqual(pick(await read("bin.dat"), ["kind", "size", "binary", "text"]), { kind: "file", size: 3, binary: true, text: undefined });
	assert.equal((await read(".github/workflows/ci.yml")).kind, "file", "workflow files stay readable");
	const names = (await read("")).entries.map((e: Json) => e.name);
	assert.deepEqual([names.slice(0, 2), names.filter((n: string) => [".git", ".env", ".env.local", "secrets"].includes(n))], [[".github", "src"], []], "directories first, denied names hidden");
	assert.deepEqual((await read("src")).entries.map((e: Json) => e.name), ["a.ts"]);
	for (const rel of ["..", "a/../..", "src/../..", "%2e%2e", ".", "./src", ".git/config", ".git", ".env", ".env.local", "cfg", "out/passwd", "out", "hidden/db.txt", "secrets/db.txt", "src/Secrets", "src//a.ts", "src/", "/src", "src\0/a.ts", "src\\a.ts", ...KEYS.map((n) => `src/${n}`)]) {
		assert.equal((await files("project:demo", rel)).status, 404, JSON.stringify(rel));
	}
	for (const root of ["project:evil", "project:..", "project:demo:x", "project:demo/src", "worktree:cp-done", "worktree:cp-away", "worktree:../x", "demo", ""]) assert.equal((await files(root, "")).status, 404, root);
	assert.equal((await read("", "worktree:cp-held")).kind, "dir");
	const named = join(repo, "names");
	for (const name of [".GIT", ".env", ".env.local", "secrets", "Secrets", "a.pem", "b.KEY", "id_rsa", "id_rsa.pub", "c.p12", "auth.json", "src", "workflows", ".github", "env.ts", "keys.ts", "secret.ts", "auth.ts"]) write(join(named, name), "n\n");
	assert.deepEqual((await read("names")).entries.map((e: Json) => e.name).sort(), [".github", "auth.ts", "env.ts", "keys.ts", "secret.ts", "src", "workflows"], ".git, .env*, secrets segments and key-like names are denied");

	const gitApi = (query: string) => d.get(`/api/git?root=project:demo&${query}`);
	assert.deepEqual(((await gitApi("view=log")).body as Json).commits.map((c: Json) => [c.sha, c.subject]), [[sha, "first"]]);
	assert.match(((await gitApi(`view=show&sha=${sha}`)).body as Json).text, /^\+export const a = 1;$/m);
	for (const view of ["status", "refs"]) assert.equal((await gitApi(`view=${view}`)).status, 200, view);
	for (const q of ["view=show&sha=HEAD", "view=show&sha=--output%3Dx", "view=show", "view=config", "view=constructor", "view=nope"]) assert.equal((await gitApi(q)).status, 400, q);
	assert.equal((await d.get("/api/git?root=project:evil&view=log")).status, 404);

	rmSync(named, { recursive: true });
	git(repo, "add", "-f", "--all");
	git(repo, "commit", "-m", "baseline", "--quiet");
	const base = git(repo, "rev-parse", "HEAD");
	write(join(repo, ".env.secret"), "secret\n");
	write(join(repo, "ordinary.txt"), "visible\n");
	const status = (await gitApi("view=status")).body as Json;
	assert.deepEqual([status.ok, status.lines.filter((line: string) => line.startsWith("?? "))], [true, ["?? ordinary.txt"]], "status omits denied untracked names");
	// A head commit touching every denied pattern plus one ordinary file, named by a held job's envelope.
	for (const rel of SECRET_FILES) write(join(repo, rel), `SEKRIT ${rel}\n`);
	write(join(repo, "src", "b.ts"), "export const visible = 2;\n");
	git(repo, "add", "-f", "src/b.ts", ...SECRET_FILES);
	git(repo, "commit", "-m", "secrets", "--quiet");
	const head = git(repo, "rev-parse", "HEAD");
	write(join(d.stateDir, "runs", "cp-sec", "envelope.json"), { envelope: { head_sha: head, base_sha: base } });
	const show = (await gitApi(`view=show&sha=${head}`)).body as Json;
	const diff = (await d.get("/api/diff?id=cp-sec")).body as Json;
	assert.deepEqual([show.ok, diff.available], [true, true], JSON.stringify(diff));
	for (const [what, text] of [["git show", show.text], ["/api/diff", diff.text]] as const) {
		assert.match(text, /^\+export const visible = 2;$/m, `${what} still shows the ordinary file`);
		assert.doesNotMatch(text, /SEKRIT/, `${what} leaks a denied file's content`);
		for (const rel of SECRET_FILES) assert.ok(!text.includes(rel), `${what} names ${rel}`);
	}
});
