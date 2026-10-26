/**
 * Behavior 18 (P18b): a job's Transcript tab as the served app renders it from `bin/cp-view` on a scratch home over real
 * HTTP, its clock pinned; DOM and text only, never pixels.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { createScratchHome } from "../harness/index.ts";
import { startViewer } from "../harness/dashboard.ts";

process.env.TZ = "UTC";
const DAY = new Date().toISOString().slice(0, 10);
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

test("P18-transcript-ui: the Transcript tab groups tools, files the report and review, and never renders message HTML", { timeout: 120_000 }, async (t) => {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const put = (rel: string, value: unknown) => {
		mkdirSync(dirname(join(scratch.path, rel)), { recursive: true });
		writeFileSync(join(scratch.path, rel), typeof value === "string" ? value : JSON.stringify(value));
	};
	const say = (role: string, hhmm: string, content: unknown) => ({ type: "message", timestamp: at(hhmm), message: { role, content } });
	const call = (id: string, name: string, args: object) => ({ type: "toolCall", id, name, arguments: args });
	const result = (id: string, name: string, text: string, isError = false) =>
		({ type: "message", timestamp: at("12:01"), message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] } });
	const bridge = (hhmm: string, content: string) => ({ type: "custom_message", customType: "cp-bridge", timestamp: at(hhmm), content });
	const session = (id: string, lines: object[]) => {
		put(join(LAYOUT.state, `sessions/${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		put(join(LAYOUT.runs, id, "status.json"), { session_file: join(scratch.path, LAYOUT.state, `sessions/${id}.jsonl`), model: "anthropic/m" });
	};
	const work = [say("user", "12:00", "The brief <b>x</b>"),
		say("assistant", "12:01", [call("t1", "read", { path: "a.ts" }), call("t2", "read", { path: "b.ts" }), call("t3", "bash", { command: "npm test" })]),
		result("t1", "read", "x"), result("t2", "read", "y"), result("t3", "bash", "boom", true),
		say("assistant", "12:05", [{ type: "text", text: "Done with **it** <script>alert(1)</script>" }]),
		say("assistant", "12:06", [call("r", "report_result", { status: "done" })]), result("r", "report_result", "ok")];
	session("cp-t", [...work, bridge("12:09", "[cp-bridge review-verdict]\nVerdict: pass"), bridge("12:10", "late notice")]);
	session("cp-u", work);
	put(join(LAYOUT.state, "boards/s/board.json"), { title: "T", created_at: at("12:00"), job_ids: ["cp-t"] });
	const ids = ["cp-t", "cp-u", "cp-none"];
	put(".pi-command-post/jobs.json", { jobs: ids.map((id) => ({ id, title: id, status: "closed", labels: ["project:demo", "kind:ship"] })) });
	put(LAYOUT.fleetFile, { jobs: ids.map((job_id) => ({ job_id, project: "demo", kind: "ship", phase: "done", dispatched_at: at("11:59"), closed_at: at("12:30") })) });
	const view = await startViewer(t, { home: scratch.path, requireTailnet: false, at: at("12:00") });

	const tab = await view.open("#job/cp-t?tab=transcript");
	const head = await tab.find(".jt-head");
	assert.match(head.textContent!, /read-only.*Worker session · anthropic\/m · 12:00–12:10.*Jump to Brief.*Report.*Reviews/s);
	assert.deepEqual(tab.$$(".jt-label").map((n) => n.textContent), ["Parent · 12:00", "Worker · 12:05"]);
	const group = tab.$(".tool-run-solid")!;
	const toggle = group.querySelector("button")!;
	assert.equal(toggle.textContent, "▸ 3 tool calls — read 2 files · ran 1 command");
	assert.deepEqual([toggle.getAttribute("aria-expanded"), group.querySelectorAll(".jt-tool").length], ["false", 0], "collapsed: rows are not rendered");
	assert.ok(tab.$("div.session-tool-run.tool-run-solid > button.session-tools"), "the shared tool-run row, solid");
	tab.click(toggle);
	await tab.find(".tool-run-solid .jt-tool-failed");
	assert.match(tab.$(".tool-run-solid button")!.textContent!, /^▾ 3 tool calls/);
	assert.equal(tab.$(".tool-run-solid button")!.getAttribute("aria-expanded"), "true");
	assert.equal(tab.$$(".tool-run-solid .jt-tool").length, 3);
	assert.deepEqual([tab.$(".jt-tool-failed .jt-failed")?.textContent, tab.$(".jt-command")?.textContent, tab.$(".jt-result")?.textContent], ["failed", "npm test", "boom"]);
	const done = tab.$(".jt-report")!;
	assert.match(done.textContent!, /Report filed.*12:06.*Open report/);
	assert.equal(done.querySelector("a")?.getAttribute("href"), "/boards/s/");
	const review = tab.$("details.jt-review")!;
	assert.match(review.querySelector("summary")!.textContent!, /▸review-verdict · 12:09/);
	assert.equal(review.id, "jt-reviews");
	assert.equal(tab.$(".jt-trailing summary")?.textContent, "▸1 more event", "after the last worker/report/review block");
	assert.doesNotMatch(tab.$(".job-transcript")!.innerHTML, /<b>x<\/b>|<script/i, "message text is never raw HTML");

	const unpublished = await view.open("#job/cp-u?tab=transcript");
	await unpublished.find(".jt-report");
	assert.equal(unpublished.$(".jt-report a"), null, "no report link without a published report");
	const bare = await view.open("#job/cp-none?tab=transcript");
	assert.match((await bare.find('.job-transcript [role="status"]')).textContent!, /No worker session recorded/);
	assert.equal(bare.$(".jt-jump"), null, "no jump chips for absent blocks");
});
