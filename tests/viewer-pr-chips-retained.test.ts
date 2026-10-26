/**
 * Retained (P18): pr-chips.ts's source has no GitHub call, and its envelope cache counter (`envelopeReads`). No e2e
 * surface can observe either; the chips themselves are covered by tests/e2e/viewer-sessions-p18.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import type { SessionEntry } from "../src/viewer/api-types.ts";
import { attachPrChips, envelopeReads } from "../src/viewer/pr-chips.ts";
import { runtimeRoot } from "../src/viewer/sessions.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

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
	return { state, put, run, fleet, ledger };
}
const job = (id: string, phase: string, url = PR, status = "open", over: object = {}) => ({ job_id: id, project: "picp", phase, receipts: [{ kind: "pr", status, title: "PR", url }], ...over });
const say = (text: string, over: Partial<SessionEntry> = {}): SessionEntry => ({ id: "e1", at: "", kind: "say", who: "Assistant", text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const merged = (id: string, url = PR) => ({ schema_version: 1, job_id: id, pr_url: url, merge_commit_sha: MERGE, head_sha: HEAD, head_branch: id, merged_at: "2026-10-15T09:00:00Z" });

test("(k) pr-chips.ts makes no GitHub call: no process, no fetch, no gh beyond parsing a ledger ref", () => {
	const source = readFileSync(join(REPO_ROOT, "src/viewer/pr-chips.ts"), "utf8");
	assert.doesNotMatch(source, /child_process|\bfetch\(|\bgh\b(?! issue view)/);
});

// A second attach over unchanged files must hit the mtime+size cache: no envelope re-parse, same chips.
test("envelope summaries are parsed once while the file is unchanged", (t) => {
	const h = home(t);
	h.fleet([job("cp-env2", "held", "https://github.com/o/picp/pull/357")]);
	h.ledger([{ id: "cp-env2", status: "open", labels: ["project:picp"] }]);
	h.put(h.run("cp-env2", "envelope.json"), { envelope: { summary: "Closes #331." } });
	const start = envelopeReads.count;
	const first = attachPrChips(h.state, [say("[picp] #331 #357")]);
	const before = envelopeReads.count;
	assert.equal(before, start + 1);
	assert.deepEqual(attachPrChips(h.state, [say("[picp] #331 #357")]), first);
	assert.equal(envelopeReads.count, before);
});

// A PR-only attach (no issue chip) must not read any envelope; the closers map is lazy.
test("PR-only chips never read envelopes", (t) => {
	const h = home(t);
	h.fleet([job("cp-env3", "done", "https://github.com/o/picp/pull/358", "merged")]);
	h.put(h.run("cp-env3", "merge.json"), merged("cp-env3", "https://github.com/o/picp/pull/358"));
	h.ledger([{ id: "cp-env3", status: "open", labels: ["project:picp"] }]);
	h.put(h.run("cp-env3", "envelope.json"), { envelope: { summary: "Closes #332." } });
	const start = envelopeReads.count;
	assert.equal(attachPrChips(h.state, [say("[picp] #358")])["https://github.com/o/picp/pull/358"]?.kind, "pr");
	assert.equal(envelopeReads.count, start);
});
