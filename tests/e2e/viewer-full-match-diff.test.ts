/**
 * Full match S7 (cp-dfm-s7-diff-hsbl): a job's recorded base...head diff through `bin/cp-view` on a scratch home
 * with a real git clone, and the pane's Diff tab and inline Update block in the served app (`--stage full-match-diff`).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { operatorSessionsFile } from "../../src/viewer/operator-sessions.ts";
import type { Context } from "../harness/conversations.ts";
import { browserShims, dashboard, openTab, operatorSession, until } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const NOON = Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`);
const iso = (minutes: number) => new Date(NOON - minutes * 60_000).toISOString();
const CHAT = "#sessions?view=you&transcript=1&untagged=1";
const JOB = "cp-df7a", PR = "https://github.com/o/picp/pull/740";
const BAIT = 'export const html = "<img src=x onerror=alert(1)>";';
const shas = { base: "", head: "", big: "" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A picp clone: base, head (markup, a binary and a textconv'd file) and big (+300 KB); cp-df7a records base/head. */
function seed(stateDir: string, home: string) {
	const put = (file: string, value: unknown) => {
		mkdirSync(dirname(join(home, file)), { recursive: true });
		writeFileSync(join(home, file), typeof value === "string" ? value : JSON.stringify(value));
	};
	const repo = join(home, LAYOUT.projects, "picp");
	mkdirSync(join(repo, "assets"), { recursive: true });
	git(repo, "init", "-b", "main", "--quiet");
	for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]]) git(repo, "config", k!, v!);
	// A clone's own config may name commands: the endpoint must never run an external diff or a textconv filter.
	for (const [k, v] of [["diff.external", "echo EXT-DIFF-RAN"], ["diff.shout.textconv", "echo TEXTCONV-RAN"]]) git(repo, "config", k!, v!);
	writeFileSync(join(repo, ".gitattributes"), "*.shout diff=shout\n");
	writeFileSync(join(repo, "app.ts"), "export const one = 1;\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "base", "--quiet");
	shas.base = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "app.ts"), `export const one = 1;\n${BAIT}\n`);
	writeFileSync(join(repo, "assets", "logo.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
	writeFileSync(join(repo, "note.shout"), "raw shout line\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "head", "--quiet");
	shas.head = git(repo, "rev-parse", "HEAD");
	writeFileSync(join(repo, "big.txt"), "a line of the oversized file that the diff must cut short\n".repeat(6000));
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "big", "--quiet");
	shas.big = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "--quiet", shas.base);

	const msg = (minutes: number, message: object) => ({ type: "message", timestamp: iso(minutes), message });
	const chat = join(home, "pi-sessions", "chat.jsonl");
	put("pi-sessions/chat.jsonl", `${[{ type: "custom_message", timestamp: iso(19), customType: "cp-bridge", display: true, content: `[cp-bridge wake job=${JOB}]\nDIFF woke` },
		msg(19, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
		msg(19, { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] }),
		msg(10, { role: "assistant", content: [{ type: "text", text: "REPLY-CARD" }] })].map((l) => JSON.stringify(l)).join("\n")}\n`);
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	writeFileSync(operatorSessionsFile(join(stateDir, "sessions")), `${JSON.stringify({ at: iso(20), session_file: chat })}\n`);
	put(".pi-command-post/jobs.json", { jobs: [{ id: JOB, title: "Diff job", status: "in_progress", labels: ["project:picp", "kind:ship"], blocked_by: [] }] });
	put(LAYOUT.fleetFile, { jobs: [{ job_id: JOB, project: "picp", kind: "ship", delivery: "pr", phase: "held", branch: JOB, dispatched_at: iso(60),
		receipts: [{ kind: "pr", status: "open", title: "Diff job", url: PR }] }] });
	envelope(home, shas.base, shas.head);
	// The worker's log: a read with pi's range notice, a read with its "more lines" notice, and an 11-line edit.
	const worker = join(stateDir, "sessions", `${JOB}.jsonl`), call = (id: string, name: string, args: object, text: string) => [
		msg(30, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }),
		msg(30, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }] })];
	put(join(LAYOUT.runs, JOB, "status.json"), { session_file: worker });
	writeFileSync(worker, `${[...call("r1", "read", { path: "src/long.ts" }, "line one\nline two\n\n[Showing lines 1-2 of 5000. Use offset=3 to continue.]"),
		...call("r2", "read", { path: "src/short.ts" }, "alpha\nbeta\n\n[3 more lines in file. Use offset=3 to continue.]"),
		...call("e1", "edit", { path: "app.ts", oldText: "keep\n<b>old</b>", newText: `keep\n<b>new</b>\n${Array.from({ length: 9 }, (_, i) => `l${i + 1}`).join("\n")}` }, "Applied 1 edit"),
	].map((l) => JSON.stringify(l)).join("\n")}\n`);
}
/** The job's recorded envelope: what the endpoint reads; the browser never names a sha. */
const envelope = (home: string, base: string, head: string) => {
	const file = join(home, LAYOUT.runs, JOB, "envelope.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: 1, job_id: JOB, attempt: 1, envelope: { base_sha: base, head_sha: head, branch: JOB, status: "done", summary: "s" } }));
};
const start = async (t: Context) => {
	const d = await dashboard(t, { at: new Date(NOON).toISOString(), seed });
	await operatorSession(t, d.stateDir);
	return d;
};
const snapshot = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() || e.isDirectory())
	.map((e) => [e.name, e.isDirectory() ? snapshot(join(dir, e.name)) : readFileSync(join(dir, e.name)).toString("base64")]);

test("S7-diff-http: /api/diff serves the recorded base...head from the picp clone; paths, revisions and bad ids are refused; nothing is written", { timeout: 120_000 }, async (t) => {
	const d = await start(t);
	const before = snapshot(join(d.home, ".pi-command-post"));
	const read = async () => { const reply = await d.get(`/api/diff?id=${JOB}`); assert.equal(reply.status, 200, reply.text); return reply.body as Record<string, any>; };
	const ok = await read();
	assert.deepEqual([ok.available, ok.unavailable, ok.base, ok.head, ok.branch, ok.root, ok.truncated, ok.files_href],
		[true, null, shas.base, shas.head, JOB, "project:picp", false, `${PR}/files`]);
	assert.deepEqual(ok.provenance, { base: "envelope", head: "envelope", root: "project:picp", command: "git diff --no-ext-diff --no-textconv --no-color -M base...head" });
	assert.ok(ok.text.split("\n").includes(`+${BAIT}`), "the markup is diff text, served as JSON");
	assert.ok(ok.text.split("\n").includes("Binary files /dev/null and b/assets/logo.bin differ"), "a binary file is named, never its bytes");
	assert.deepEqual([ok.text.includes("EXT-DIFF-RAN"), ok.text.includes("TEXTCONV-RAN"), ok.text.split("\n").includes("+raw shout line")], [false, false, true],
		"--no-ext-diff and --no-textconv: the clone's configured commands never run");

	envelope(d.home, shas.base, shas.big);
	const big = await read();
	assert.deepEqual([big.available, big.truncated, big.text.length <= 256_000, big.text.length > 200_000], [true, true, true, true], "oversized output is cut and says so");
	envelope(d.home, shas.base, "f".repeat(40));
	const gone = await read();
	assert.deepEqual([gone.available, gone.text, gone.head, gone.files_href], [false, "", "f".repeat(40), `${PR}/files`]);
	assert.match(gone.unavailable, /^git could not read the recorded shas: /, "an absent object is unavailable, never an empty diff");

	for (const query of ["&path=../../etc/passwd", "&rev=HEAD~1", `&base=${shas.base}`, "&head=main", "&id=cp-other"]) {
		const reply = await d.get(`/api/diff?id=${JOB}${query}`);
		assert.deepEqual([reply.status, reply.body.error], [400, "only id is read: a path or revision is never accepted"], query);
	}
	for (const id of ["", "../x", "cp-nope", "HEAD", "--output=x", encodeURIComponent(`${shas.base}...${shas.head}`)]) {
		assert.equal((await d.get(`/api/diff?id=${id}`)).status, 404, `id ${JSON.stringify(id)}`);
	}
	assert.equal((await d.get(`/api/diff?id=${JOB}`, { method: "POST" })).status, 405);
	// Review 1 (security): a recorded short sha, ref name or dash-led string never reaches git as a revision; with the
	// check gone, `main` and the short sha diff, and `--output=` writes `/tmp/x...<head>` (removed below if created).
	const outputs = ["/tmp/x", `/tmp/x...${shas.head}`], existed = outputs.map((file) => existsSync(file));
	t.after(() => { if (!existed[1]) rmSync(outputs[1]!, { force: true }); });
	for (const [base, head] of [[shas.base, shas.head.slice(0, 12)], ["main", shas.head], ["--output=/tmp/x", shas.head], [shas.base, "--output=/tmp/x"]]) {
		envelope(d.home, base!, head!);
		const bad = await read();
		assert.deepEqual([bad.available, bad.unavailable, bad.text, bad.base, bad.head], [false, "recorded base/head is not a full sha", "", base, head],
			`${base}...${head} is unavailable before any git call`);
	}
	assert.deepEqual(outputs.map((file) => existsSync(file)), existed, "no git --output file was written");
	envelope(d.home, shas.base, shas.head);
	assert.deepEqual(snapshot(join(d.home, ".pi-command-post")), before, "the endpoint never writes to the clone or the state");
});

test("S7-diff-tab: the pane's Diff labels both shas and renders lines as text; truncated and unavailable say so; the Log's Update shows its block", { timeout: 180_000 }, async (t) => {
	const d = await start(t);
	const tab = await openTab(t, d.port, CHAT, new Map(), undefined, {}, true);
	browserShims(t, tab);
	await tab.waitText(/REPLY-CARD/);
	tab.click(tab.$$(".session-steps .session-tools").find((b) => b.getAttribute("title") === JOB)!);
	tab.click(await tab.find(".session-steps-link", (a) => a.getAttribute("href") === `#job/${JOB}?tab=transcript`));
	const texts = (selector: string) => tab.$$(`.workspace-job ${selector}`).map((e) => e.textContent ?? "");
	const rows = await until(() => texts(".workspace-log-tool > pre"), (r) => r.length === 3, "the Log");
	// C2: pi's trailing notice is never counted as file lines; a range notice words the note itself.
	assert.deepEqual(rows, ["└ Read lines 1–2 of 5000", "└ Read 2 lines", "└ Added 10 lines, removed 1 line"]);
	assert.deepEqual([texts(".workspace-log-edit .workspace-log-diff-line"), texts(".workspace-log-diff-more"), tab.$$(".workspace-log-edit b").length],
		[["- <b>old</b>", "+ <b>new</b>", ...Array.from({ length: 6 }, (_, i) => `+ l${i + 1}`)], ["3 more lines"], 0], "frame 2's block: removed, then added, capped, as text");
	assert.deepEqual(texts(".workspace-log-tab-short"), ["Log", "Report", "Files", "Diff", "Details"], "frame 8's toolbar gains Diff");

	tab.click(tab.$('.workspace-log-tabs [data-view="diff"]')!);
	await tab.find(".workspace-log-diff-view .workspace-log-diff");
	assert.deepEqual(texts(".workspace-log-shas > div"), [`base${shas.base} · envelope`, `head${shas.head} · envelope`], "both full shas and their source");
	assert.equal(texts(".workspace-log-diff-view .workspace-log-meta")[0], `Recorded base...head of ${JOB} in the picp clone; not the live worktree or PR`);
	assert.deepEqual([texts(".workspace-log-diff-add").includes(`+${BAIT}`), tab.$$(".workspace-log-diff-view img").length, texts(".workspace-log-diff-note")],
		[true, 0, ["assets/logo.bin · binary, not shown"]], "markup stays text; a binary file is named only");
	assert.equal(tab.$(".workspace-log-diff-truncated"), null);

	envelope(d.home, shas.base, shas.big);
	tab.refresh();
	const cut = await tab.find(".workspace-log-diff-truncated");
	assert.equal(cut.textContent, "Truncated · only the first part of the diff is shown · Files on the forge", "truncation is always named");
	assert.equal(cut.querySelector("a")!.getAttribute("href"), `${PR}/files`);

	envelope(d.home, shas.base, "f".repeat(40));
	tab.refresh();
	const gone = await tab.find(".workspace-log-diff-view [role=status]", (s) => s.textContent!.startsWith("Diff unavailable"));
	assert.match(gone.textContent!, /^Diff unavailable · git could not read the recorded shas: .+ · Files on the forge$/);
	assert.deepEqual([tab.$$(".workspace-log-diff-view .workspace-log-diff").length, texts(".workspace-log-shas code")[1]], [0, "f".repeat(40)], "no empty diff; the recorded head stays labelled");
	tab.click(tab.$('.workspace-log-tabs [data-view="log"]')!);
	await tab.find(".workspace-log-row");
	tab.click(tab.$('.workspace-job button[aria-label="Close job"]')!);
	await until(() => tab.$(".workspace-job"), (el) => el === null, "close still works");
	assert.equal(tab.requests.filter((r) => r.method !== "GET" && r.method !== "HEAD").length, 0, "the pane only reads");
	assert.ok(tab.requests.filter((r) => r.path.startsWith("/api/diff")).every((r) => r.path === `/api/diff?id=${JOB}`), "the browser names only the job");
});
