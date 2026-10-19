/**
 * Sessions chat live PR and issue chips (PR A): `attachPrChips` reads only the fleet, ledger, projects, ci-watch and
 * run files; the Markdown chip renders from the `PrChips` context and nowhere else.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import { LAYOUT, PENDING_REVIEW_FILE as CONTRACT_PENDING, paths } from "../src/contracts.ts";
import type { PrChip, SessionEntry } from "../src/viewer/api-types.ts";
import { attachPrChips, PENDING_REVIEW_FILE } from "../src/viewer/pr-chips.ts";
import { runtimeRoot } from "../src/viewer/sessions.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const bundle = await build({ stdin: { contents: 'import {h,render} from "preact"; import {act} from "preact/test-utils"; import renderToString from "preact-render-to-string"; import {Markdown} from "./viewer-app/components/Markdown.tsx"; import {PrChips} from "./viewer-app/components/PrChip.tsx"; export {act}; const tree=(text,links,chips)=>chips ? h(PrChips.Provider,{value:chips},h(Markdown,{text,links})) : h(Markdown,{text,links}); export const html=(text,links,chips)=>renderToString(tree(text,links,chips)); export const mount=(root,text,links,chips)=>render(tree(text,links,chips),root);', resolveDir: REPO_ROOT, loader: "tsx" }, bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", jsxImportSource: "preact" });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`) as {
	act: (run: () => void) => Promise<void>;
	html: (text: string, links?: Record<string, string>, chips?: Record<string, PrChip>) => string;
	mount: (root: Element, text: string, links?: Record<string, string>, chips?: Record<string, PrChip>) => void;
};

const HEAD = "a".repeat(40), MERGE = "b".repeat(40);
const PR = "https://github.com/o/picp/pull/355";
function home(t: TestContext) {
	const scratch = createScratchHome(); t.after(() => scratch.cleanup());
	const state = { home: scratch.path, stateDir: join(scratch.path, LAYOUT.state) };
	const put = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
	const run = (id: string, file: string) => join(state.stateDir, "runs", id, file);
	put(join(dirname(state.stateDir), "data", "projects.json"), { projects: [{ name: "picp", clone_url: "https://github.com/o/picp.git" }] });
	const fleet = (jobs: object[]) => put(join(state.stateDir, "fleet.json"), { jobs });
	const ledger = (jobs: object[]) => put(join(runtimeRoot(state.home), "jobs.json"), { jobs });
	const events = (id: string, list: object[]) => put(run(id, "events.jsonl"), list.map((e) => JSON.stringify({ source: "cp", ts: "2026-10-15T08:00:00Z", ...e })).join("\n") + "\n");
	return { state, put, run, fleet, ledger, events };
}
const job = (id: string, phase: string, url = PR, status = "open", over: object = {}) => ({ job_id: id, project: "picp", phase, receipts: [{ kind: "pr", status, title: "PR", url }], ...over });
const say = (text: string, over: Partial<SessionEntry> = {}): SessionEntry => ({ id: "e1", at: "", kind: "say", who: "Assistant", text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const merged = (id: string, url = PR) => ({ schema_version: 1, job_id: id, pr_url: url, merge_commit_sha: MERGE, head_sha: HEAD, head_branch: id, merged_at: "2026-10-15T09:00:00Z" });

test("the pending-review file name mirrors the contract's and sits in the diff review's attempt directory", () => {
	assert.equal(PENDING_REVIEW_FILE, CONTRACT_PENDING);
	assert.equal(paths.pendingReviewFile("cp-a", "review", 2), `${paths.runDir("cp-a")}/review-2/${PENDING_REVIEW_FILE}`);
});

test("(a)(b)(c)(g) a held PR: draft until readied, CI and review read for its head only", (t) => {
	const h = home(t);
	h.fleet([job("cp-a", "held")]);
	h.put(join(h.state.stateDir, "ci-watch.json"), { jobs: [{ job_id: "cp-a", head_sha: HEAD, last_ci: "green" }] });
	h.put(h.run("cp-a", "review-1/pending.json"), {});
	const chip = () => attachPrChips(h.state, [say(`PR ${PR} is up`)])[PR]!;
	assert.deepEqual({ ...chip(), url: undefined }, { kind: "pr", url: undefined, number: 355, repo: "o/picp", job_id: "cp-a", head_sha: HEAD, state: "draft", merge_sha: null,
		closed_by: null, job_status: null, ci: "green", review: "running" });
	h.events("cp-a", [{ type: "integration_advanced", payload: { step: "ready", pr_url: PR, head_sha: HEAD, undone: false } }]);
	assert.equal(chip().state, "open", "readied by cp_integrate");
	h.events("cp-a", [{ type: "integration_advanced", payload: { step: "ready", pr_url: PR, head_sha: HEAD, undone: true } }]);
	assert.equal(chip().state, "draft", "an undone ready is still a draft");
	h.put(h.run("cp-a", "review-1.json"), { verdict: "pass", head_sha: HEAD, decided_at: "2026-10-15T08:00:00Z", diff_stat: { truncated: false } });
	assert.equal(chip().review, "running", "the pending file wins while it exists");
	for (const [ci, view] of [["in_progress", "pending"], ["failed", "red"], ["unreadable", "unreadable"], ["unknown", null]] as const) {
		h.put(join(h.state.stateDir, "ci-watch.json"), { jobs: [{ job_id: "cp-a", head_sha: HEAD, last_ci: ci }] });
		assert.equal(chip().ci, view, `${ci} reads ${view}`);
	}
});

test("(c) a recorded verdict for the head, with no pending review, is the review", (t) => {
	const h = home(t);
	h.fleet([job("cp-a", "held")]);
	h.put(h.run("cp-a", "envelope.json"), { envelope: { head_sha: HEAD } });
	h.put(h.run("cp-a", "review-1.json"), { verdict: "pass", head_sha: HEAD, decided_at: "2026-10-15T08:00:00Z", diff_stat: { truncated: false } });
	assert.equal(attachPrChips(h.state, [say(PR)])[PR]!.review, "pass");
	h.put(h.run("cp-a", "review-2.json"), { verdict: "revise", head_sha: HEAD, decided_at: "2026-10-15T09:00:00Z", diff_stat: { truncated: false } });
	assert.equal(attachPrChips(h.state, [say(PR)])[PR]!.review, "revise");
	assert.equal(attachPrChips(h.state, [say(PR)])[PR]!.ci, null, "no CI value is null, never a guess");
});

test("(d)(e)(f) merged, a stale open receipt, and closed unmerged", (t) => {
	const h = home(t);
	h.fleet([job("cp-m", "done", PR, "merged"), job("cp-s", "done", "https://github.com/o/picp/pull/356"), job("cp-c", "held", "https://github.com/o/picp/pull/357"),
		job("cp-p", "awaiting_merge", "https://github.com/o/picp/pull/358", "open", { awaiting_merge: { pending: { kind: "closed_unmerged" } } })]);
	h.put(h.run("cp-m", "merge.json"), merged("cp-m"));
	h.events("cp-c", [{ type: "ci_observed", payload: { event: "pr_closed", pr_url: "https://github.com/o/picp/pull/357" } }]);
	const chips = attachPrChips(h.state, [say(`${PR} https://github.com/o/picp/pull/356 https://github.com/o/picp/pull/357 https://github.com/o/picp/pull/358`)]);
	assert.equal(chips[PR]!.state, "merged"); assert.equal(chips[PR]!.merge_sha, MERGE);
	assert.equal(chips["https://github.com/o/picp/pull/356"]!.state, "unknown", "an open receipt on a done job is not claimed open");
	assert.equal(chips["https://github.com/o/picp/pull/357"]!.state, "closed");
	assert.equal(chips["https://github.com/o/picp/pull/358"]!.state, "closed");
});

test("(h) #N resolves only for a registered project: a lead [name], a bridge job's fleet project; unregistered stays text", (t) => {
	const h = home(t);
	h.fleet([job("cp-a", "held")]);
	const lead = say("[picp] #355 and #12");
	attachPrChips(h.state, [lead]);
	assert.deepEqual(lead.links, { "#355": PR, "#12": "https://github.com/o/picp/issues/12" });
	const other = say("**[demo]** #355");
	attachPrChips(h.state, [other]);
	assert.equal(other.links, undefined, "an unregistered project resolves nothing");
	const wake = say("Review is running on #355", { kind: "system", tag: "bridge", bridge: { kind: "wake", job: "cp-a", id: null, receipt: null } });
	assert.ok(attachPrChips(h.state, [wake])[PR], "the bridge job's PR is a chip");
	assert.equal(wake.links?.["#355"], PR);
});

test("(l) issue chips: closed by a merged PR (ledger ref or envelope Closes), open, and no record", (t) => {
	const h = home(t);
	const ISSUE = "https://github.com/o/picp/issues/328";
	h.fleet([job("cp-issue-328-x", "done", PR, "merged"), job("cp-env", "done", "https://github.com/o/picp/pull/356", "merged")]);
	h.ledger([{ id: "cp-issue-328-x", status: "closed", labels: ["project:picp"], external_ref: ISSUE, created_at: "2026-10-14T00:00:00Z" }, { id: "cp-env", status: "closed", labels: ["project:picp"] }]);
	h.put(h.run("cp-issue-328-x", "merge.json"), merged("cp-issue-328-x"));
	h.put(h.run("cp-env", "envelope.json"), { envelope: { summary: "Body says Closes #330." } });
	h.put(h.run("cp-env", "merge.json"), merged("cp-env", "https://github.com/o/picp/pull/356"));
	const entry = say("[picp] #328, #330 and #329");
	const chips = attachPrChips(h.state, [entry]);
	assert.equal(entry.links?.["#328"], ISSUE);
	assert.deepEqual(chips[ISSUE], { kind: "issue", url: ISSUE, number: 328, repo: "o/picp", job_id: "cp-issue-328-x", head_sha: null, state: "closed", merge_sha: null,
		closed_by: { url: PR, number: 355 }, job_status: "closed", ci: null, review: null });
	assert.deepEqual(chips["https://github.com/o/picp/issues/330"]!.closed_by, { url: "https://github.com/o/picp/pull/356", number: 356 });
	assert.equal(chips["https://github.com/o/picp/issues/329"]!.state, null, "no record in either index: no state");
	const rendered = ui.html(entry.text, entry.links, chips);
	assert.match(rendered, /issue #328<\/span><span class="pr-chip-state">closed by #355<\/span><span class="pr-chip-job">job closed/);
	const { document } = parseHTML(`<div>${rendered}</div>`);
	assert.equal(document.querySelector("a.issue-chip.pr-chip-none")?.textContent, "#329");
	h.ledger([{ id: "cp-issue-328-x", status: "in_progress", labels: ["project:picp"], external_ref: ISSUE }]);
	writeFileSync(h.run("cp-issue-328-x", "merge.json"), "{}");
	const open = attachPrChips(h.state, [say("[picp] #328")])[ISSUE]!;
	assert.equal(open.state, "open"); assert.equal(open.closed_by, null); assert.equal(open.job_status, "in_progress");
});

test("(i)(m) rendering: the merged chip's facts; head only when known; code spans and other screens stay plain", () => {
	const chip: PrChip = { kind: "pr", url: PR, number: 355, repo: "o/picp", job_id: "cp-a", head_sha: HEAD, state: "merged", merge_sha: MERGE, closed_by: null, job_status: null, ci: "green", review: "pass" };
	const html = ui.html(`Landed: ${PR}. Also \`#355\`.`, { "#355": PR }, { [PR]: chip });
	const { document } = parseHTML(`<div>${html}</div>`);
	const a = document.querySelector("a.pr-chip.pr-chip-merged")!;
	for (const text of ["#355", "merged bbbbbbb", "CI green", "review pass"]) assert.ok(a.textContent!.includes(text), text);
	assert.equal(a.getAttribute("target"), "_blank"); assert.equal(a.getAttribute("rel"), "noopener noreferrer");
	assert.match(a.getAttribute("title")!, /head aaaaaaa/);
	assert.equal(document.querySelectorAll(".pr-chip").length, 1, "the code span's #355 is no chip");
	assert.equal(document.querySelector("code a")?.className ?? "", "");
	const headless = parseHTML(`<div>${ui.html(PR, undefined, { [PR]: { ...chip, head_sha: null } })}</div>`).document.querySelector(".pr-chip")!;
	assert.doesNotMatch(headless.getAttribute("title")!, /head /);
	assert.equal(ui.html(PR), `<div class="md"><p><a href="${PR}" target="_blank" rel="noopener noreferrer">${PR}</a></p></div>`, "no context: today's anchor");
});

test("(j) a chip updates in place when the stream's state changes", async (t) => {
	const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
	const originals = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of [["window", window], ["document", document]] as const) Object.defineProperty(globalThis, key, { configurable: true, value });
	t.after(() => { for (const [key, d] of originals) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); } });
	const root = document.getElementById("root")!;
	const chip: PrChip = { kind: "pr", url: PR, number: 355, repo: "o/picp", job_id: "cp-a", head_sha: null, state: "draft", merge_sha: null, closed_by: null, job_status: null, ci: "pending", review: null };
	await ui.act(() => ui.mount(root, PR, undefined, { [PR]: chip }));
	const before = root.querySelector(".pr-chip")!;
	assert.ok(before.classList.contains("pr-chip-draft"));
	await ui.act(() => ui.mount(root, PR, undefined, { [PR]: { ...chip, state: "open", ci: "green" } }));
	assert.equal(root.querySelector(".pr-chip"), before, "same node");
	assert.ok(before.classList.contains("pr-chip-open")); assert.match(before.textContent!, /CI green/);
});

test("(k) pr-chips.ts makes no GitHub call: no process, no fetch, no gh beyond parsing a ledger ref", () => {
	const source = readFileSync(join(REPO_ROOT, "src/viewer/pr-chips.ts"), "utf8");
	assert.doesNotMatch(source, /child_process|\bfetch\(|\bgh\b(?! issue view)/);
});
