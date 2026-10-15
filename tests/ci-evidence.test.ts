/** awaiting_merge PR4: operator-forwarded CI is stored head-keyed with its quote, and projected for display only. */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerIntegrateTools } from "../extensions/command-post/tools-integrate.ts";
import { CiEvidenceError, readCiEvidence, recordForwardedCi } from "../src/ci-evidence.ts";
import { CI_EVIDENCE_KEEP, LAYOUT, paths } from "../src/contracts.ts";
import { forwardedCi } from "../src/viewer/overview-jobs.ts";
import { createScratchHome } from "./harness/index.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const QUOTE = "CI is green on the head, I checked the Actions tab.";

function bench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const record = (over: Partial<Parameters<typeof recordForwardedCi>[0]> = {}) =>
		recordForwardedCi({ home: home.path, jobId: "cp-fwd", repo: "o/r", headSha: A, result: "success", operatorQuote: QUOTE, now: new Date("2026-10-15T12:00:00Z"), ...over });
	const state = { home: home.path, stateDir: join(home.path, LAYOUT.state) } as Parameters<typeof forwardedCi>[0];
	return { home: home.path, record, state };
}

test("recordForwardedCi: stores source forwarded with its quote; an identical repeat appends nothing", (t) => {
	const b = bench(t);
	const first = b.record({ url: "https://github.com/o/r/actions/runs/12" });
	assert.deepEqual(first, { head_sha: A, result: "success", source: "forwarded", observed_at: "2026-10-15T12:00:00Z", url: "https://github.com/o/r/actions/runs/12", operator_quote: QUOTE });
	b.record({ url: "https://github.com/o/r/actions/runs/12", now: new Date("2026-10-15T12:05:00Z") });
	assert.equal(readCiEvidence(b.home, "cp-fwd")?.observations.length, 1);
	b.record({ result: "failure" });
	assert.deepEqual(readCiEvidence(b.home, "cp-fwd")?.observations.map((o) => o.result), ["success", "failure"]);
});

test("recordForwardedCi: refuses a short or moved head, a credential-shaped quote or url, and another repo", (t) => {
	const b = bench(t);
	assert.throws(() => b.record({ headSha: "abc1234" }), /full 40-hex/);
	assert.throws(() => b.record({ currentHead: B }), /superseded head/);
	const token = `ghp_${"x".repeat(36)}`;
	assert.throws(() => b.record({ operatorQuote: `green, token ${token}.` }), (error: Error) => error instanceof CiEvidenceError && /github token/.test(error.message) && !error.message.includes(token));
	assert.throws(() => b.record({ url: `https://x:${token}@github.com/o/r` }), /plain https url/);
	assert.throws(() => b.record({ url: "https://github.com/o/r/actions?token=1" }), /plain https url/);
	assert.equal(readCiEvidence(b.home, "cp-fwd"), undefined, "nothing refused was written");
	b.record();
	assert.throws(() => b.record({ repo: "o/other" }), /is for o\/r/);
});

test("recordForwardedCi: keeps the newest CI_EVIDENCE_KEEP observations", (t) => {
	const b = bench(t);
	for (let index = 0; index <= CI_EVIDENCE_KEEP; index += 1) b.record({ operatorQuote: `green ${index}.`, now: new Date(Date.UTC(2026, 9, 15, 12, 0, index)) });
	const kept = readCiEvidence(b.home, "cp-fwd")!.observations;
	assert.equal(kept.length, CI_EVIDENCE_KEEP);
	assert.equal(kept[0]!.operator_quote, "green 1.");
});

test("forwardedCi (viewer): the newest forwarded result for the head only; native rows and other heads are not forwarded", (t) => {
	const b = bench(t);
	assert.equal(forwardedCi(b.state, "cp-fwd", A), null, "no file is no forwarded CI");
	const file = join(b.home, paths.ciEvidenceFile("cp-fwd"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: 1, job_id: "cp-fwd", repo: "o/r", observations: [
		{ head_sha: A, result: "failure", source: "forwarded", observed_at: "2026-10-15T11:00:00Z", operator_quote: "red." },
		{ head_sha: A, result: "pending", source: "forwarded", observed_at: "2026-10-15T12:00:00Z", operator_quote: "running.", url: "https://x?y" },
		{ head_sha: A, result: "success", source: "actions", observed_at: "2026-10-15T13:00:00Z" },
		{ head_sha: B, result: "success", source: "forwarded", observed_at: "2026-10-15T14:00:00Z", operator_quote: "green." },
	] }));
	assert.deepEqual(forwardedCi(b.state, "cp-fwd", A), { ci: "in_progress", observed_at: "2026-10-15T12:00:00Z", url: null });
	assert.deepEqual(forwardedCi(b.state, "cp-fwd", B)?.ci, "green");
	assert.equal(forwardedCi(b.state, "cp-fwd", "c".repeat(40)), null);
	assert.equal(forwardedCi(b.state, "cp-fwd", null), null);
});

test("cp_integrate record_ci: needs a verbatim operator quote and the job's current head; stores display-only evidence", async (t) => {
	const b = bench(t);
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
	const record = { job_id: "cp-fwd", receipts: [{ kind: "pr", url: "https://github.com/o/r/pull/3", status: "open" }] };
	registerIntegrateTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as never, {
		commandPost: () => ({ home: b.home, fleet: { require: () => record }, ciWatch: { store: { job: () => ({ head_sha: A }) } } }),
		setLive: () => {}, refreshWidget: () => {},
	} as never);
	const ctx = { sessionManager: { getEntries: () => [{ type: "message", message: { role: "user", content: `fyi: ${QUOTE}` } }] } };
	const invoke = (params: Record<string, unknown>) => tools.get("cp_integrate")!.execute("t", { job_id: "cp-fwd", action: "record_ci", result: "success", ...params }, undefined, undefined, ctx);
	await assert.rejects(invoke({ head_sha: A, operator_quote: "CI is green, trust me." }), /quote not found/);
	await assert.rejects(invoke({ head_sha: B, operator_quote: QUOTE }), /superseded head/);
	assert.match((await invoke({ head_sha: A, operator_quote: QUOTE })).content[0]!.text, /forwarded CI success recorded on aaaaaaaaaaaa; display only/);
	assert.deepEqual(readCiEvidence(b.home, "cp-fwd")?.observations.map((o) => [o.source, o.operator_quote]), [["forwarded", QUOTE]]);
	assert.equal(readCiEvidence(b.home, "cp-fwd")?.repo, "o/r");
});
