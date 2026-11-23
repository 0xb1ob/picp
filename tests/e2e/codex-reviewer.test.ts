/**
 * C6: a gate-reviewer on the Codex CLI through the real `cp_review` and `cp_gate` of a pi parent (mock parent model),
 * tests/fixtures/fake-codex.ts and the fake `systemd-run` at the boundary; each case checks the Codex home untouched.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { LAYOUT, paths } from "../../src/contracts.ts";
import { codexAvailabilityFile } from "../../src/native-availability.ts";
import {
	AUTH_SENTINEL, codexFixture, type FakeCodexStep, fakeExecuted, fakePatched, fakeRpcMethods, fakeScopes, fakeSpawns, fakeThreads, fakeUnsupported, OUTSIDE_SENTINEL,
} from "../harness/codex-mock.ts";
import { codexWorkerHome, FAKE_CODEX_REF } from "../harness/codex-worker.ts";
import { readRunEvents, REPO_ROOT, treehouseAvailable, waitFor } from "../harness/index.ts";

const skip = treehouseAvailable() ? false : "needs treehouse on PATH";
type H = Awaited<ReturnType<typeof codexWorkerHome>>;
const FLAGS = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };
const verdict = (jobId: string, value = "pass") => ({ job_id: jobId, verdict: value, flags: FLAGS, reasons: ["reviewed the packet"] });

/** The Codex home is untouched, and no host OPENAI_/CODEX_ key but CODEX_HOME reached an app-server. */
function assertClean(h: H): void {
	assert.deepEqual(h.homeListing(), ["auth.json"]);
	assert.equal(readFileSync(join(h.codexHome, "auth.json"), "utf8"), `${AUTH_SENTINEL}\n`);
	for (const spawn of fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server")) {
		assert.deepEqual(spawn.env.filter((key) => /^OPENAI_/.test(key) || (/^CODEX_/.test(key) && key !== "CODEX_HOME")), []);
	}
}

const allScopesKilled = (h: H) => waitFor(() => fakeScopes(h.state), (scopes) => scopes.filter((each) => each.killed !== undefined || each.collected).length >= scopes.filter((each) => each.started).length,
	{ timeoutMs: 30_000, what: "every started scope killed or collected" });
const toolResults = (h: H) => h.lines<{ tool: string; result: { contentItems?: Array<{ text?: string }>; success?: boolean } }>("tool-results.jsonl");
const resultText = (entry: { result: { contentItems?: Array<{ text?: string }> } }) => (entry.result.contentItems ?? []).map((part) => part.text ?? "").join("\n");
const nativeRun = (events: Array<{ type: string; payload: Record<string, unknown> }>) => events.find((event) => event.type === "native_run")?.payload;
/** The hooked app-servers (trust probe and turn), never the bare thread-delete server. */
const hookedServers = (h: H) => fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server" && each.argv.some((arg) => arg.startsWith("hooks.PreToolUse=")));
const shellOff = (argv: string[]) => argv.some((arg, i) => arg === "--disable" && argv[i + 1] === "shell_tool");
/** The fake's next turn plays `steps`: the turns its cursor already used stay empty. */
function nextTurn(h: H, steps: FakeCodexStep[], knobs?: Record<string, unknown>): void {
	const cursor = join(h.state, "cursor.json");
	const used = existsSync(cursor) ? Number(readFileSync(cursor, "utf8")) : 0;
	h.setScript({ ...(knobs ? { knobs } : {}), turns: [...Array.from({ length: used }, () => []), steps] });
}

// Scenario: Given the reviews row on codex with a pi fallback and codex_review on, When cp_review runs on held job A,
// Then the Codex reviewer reads the packet, files pi's verdict.json once (a wrong-job verdict refused) and its thread
// is deleted; And with codex_review off the same review of B runs on pi and decides the same.
test("CX-6a: cp_review on a codex reviews row files pi's verdict.json through report_verdict; codex_review off runs pi", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_review: true } });
	const [a, b] = ["cp-cx6a-a", "cp-cx6a-b"];
	await h.heldShipJob(a);
	await h.heldShipJob(b);
	const piModel = h.b.provider.addScript("cx6a-pi", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(b) }] }]);
	h.reviewsRow(piModel);
	h.setScript({ turns: [[
		{ kind: "tool", tool: "read", arguments: { path: "diff.md" } },
		{ kind: "tool", tool: "report_result", arguments: h.report(a) },
		{ kind: "tool", tool: "report_verdict", arguments: verdict("cp-someone-else") },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(a) },
		{ kind: "message", text: "Reviewed." },
	]] });
	await h.run([h.review(a)]);
	const native = await h.reviewRun(a);
	assert.match(String(native.routed?.line), new RegExp(`model=${FAKE_CODEX_REF} .*driver=codex`), JSON.stringify(native.routed));
	assert.deepEqual([native.routed?.requested_driver, native.routed?.driver], ["codex", "codex"], JSON.stringify(native.routed));
	assert.match(String(native.routed?.driver_reason), /^rule: reviews prefers codex/);
	assert.deepEqual(native.verdict, verdict(a), "the verdict file is pi's shape");
	assert.equal(native.result.verdict, "pass", JSON.stringify(native.result));
	const read = toolResults(h).find((entry) => entry.tool === "read");
	assert.match(read ? resultText(read) : "", /REVIEWED-CHANGE-LINE/, "the read tool served the packet's diff");
	assert.equal(toolResults(h).some((entry) => entry.tool === "report_result"), false, "report_result never reached a handler");
	assert.equal(existsSync(join(native.run, "envelope.json")), false);
	await waitFor(() => readFileSync(join(native.run, "events.jsonl"), "utf8"), (body) => body.includes("native_scratch_removed"), { timeoutMs: 60_000, what: "the reviewer's session end" });
	const events = (await h.reviewRun(a)).events;
	const run = nativeRun(events);
	assert.deepEqual([run?.driver, run?.lockdown, run?.report, run?.usage, run?.cost_unknown, run?.report_refusals], ["codex", "ok", true, "measured", true, 1], JSON.stringify(run));
	assert.match(JSON.stringify(run?.denied), /not in the Codex spike's tool set/, "report_result is a hook denial");
	assert.ok((JSON.parse(readFileSync(join(native.run, "status.json"), "utf8")) as { usage: { total_tokens: number } }).usage.total_tokens > 0, "tokens are measured");
	const threads = fakeThreads(h.state);
	assert.deepEqual(threads.map((each) => [each.method, each.dynamicTools, each.mcpServers]), [["thread/start", ["find", "grep", "read", "report_verdict"], []]]);
	assert.ok(hookedServers(h).length >= 2 && hookedServers(h).every((each) => shellOff(each.argv)), "the trust probe and the turn run with the shell off");
	const deleted = events.find((event) => event.type === "native_thread_deleted")?.payload;
	assert.equal(deleted?.deleted, true, JSON.stringify(deleted));
	assert.ok(events.some((event) => event.type === "native_scratch_removed"));
	assert.equal(existsSync(join(h.state, "threads", `${String(deleted?.thread_id)}.json`)), false, "the fake's thread file is gone");
	await allScopesKilled(h);
	assert.equal(h.record(a)?.worker.driver, undefined, "the subject's record names no driver");

	writeFileSync(h.nativeFile, "{}");
	await h.b.closeParents();
	await h.run([h.review(b)]);
	const pi = await h.reviewRun(b);
	assert.equal(pi.routed?.model, piModel, JSON.stringify(pi.routed));
	assert.match(String(pi.routed?.line), /driver=pi/);
	assert.doesNotMatch(String(pi.routed?.line), /driver=codex/);
	assert.equal(nativeRun(pi.events), undefined);
	const same = (v: typeof pi.result) => ({ verdict: v.verdict, cause: v.cause, flags: v.flags, reasons: v.reasons });
	assert.deepEqual(same(native.result), same(pi.result), "the codex review result equals pi's for the same verdict");
	assertClean(h);
});

// Scenario: a Codex reviewer's shell calls and patches never run (part 1); a CLI that reads `shell_tool` back on is
// refused before any turn (part 2); a CLI that keeps the shell anyway still runs nothing: the hook refuses, and a
// rule-approved command under a dead hook kills the run with nothing read (part 3).
test("CX-6b: a codex reviewer has no shell: nothing executes, a shell read back on is refused, a kept shell runs nothing", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_review: true } });
	const ids = ["cp-cx6b-1", "cp-cx6b-2", "cp-cx6b-3"] as const;
	for (const id of ids) await h.heldShipJob(id);
	h.reviewsRow(h.b.provider.addScript("cx6b-pi", [{ kind: "text", text: "unused" }]));
	writeFileSync(join(h.outside, "secret.txt"), `${OUTSIDE_SENTINEL}\n`);

	nextTurn(h, [
		{ kind: "shell", command: "cat /etc/hostname" }, { kind: "shell", command: "touch x" }, { kind: "patch", path: "p.txt" },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(ids[0]) }, { kind: "message", text: "Reviewed." },
	]);
	await h.run([h.review(ids[0])]);
	const one = await h.reviewRun(ids[0]);
	assert.deepEqual(fakeExecuted(h.state), []);
	assert.deepEqual(fakeUnsupported(h.state), ["cat /etc/hostname", "touch x"]);
	assert.deepEqual(fakePatched(h.state), []);
	assert.equal(existsSync(join(one.run, "review", "p.txt")), false);
	assert.deepEqual(one.verdict, verdict(ids[0]));
	const run1 = nativeRun(one.events);
	assert.equal(run1?.bypass, undefined, JSON.stringify(run1));
	assert.match(JSON.stringify(run1?.denied), /apply_patch/, "the patch is a hook denial");

	nextTurn(h, [{ kind: "tool", tool: "report_verdict", arguments: verdict(ids[1]) }], { features: { shell_tool: true } });
	await h.b.closeParents();
	const turnsBefore = fakeRpcMethods(h.state).filter((method) => method === "turn/start").length;
	await h.run([h.review(ids[1])]);
	const two = await h.reviewRun(ids[1]);
	const run2 = nativeRun(two.events);
	assert.deepEqual([run2?.lockdown, run2?.stop, (run2?.extra as { features?: number } | undefined)?.features], ["refused", "lockdown", 1], JSON.stringify(run2));
	assert.equal(fakeRpcMethods(h.state).filter((method) => method === "turn/start").length, turnsBefore, "no turn started");
	assert.equal(two.verdict, undefined);
	assert.deepEqual([two.result.verdict, two.result.cause], ["escalate", "operational"], JSON.stringify(two.result));

	nextTurn(h, [
		{ kind: "shell", command: "cat diff.md" },
		{ kind: "shell", command: `cat ${join(h.outside, "secret.txt")}`, hook: "kill" },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(ids[2]) },
	], { shellTool: "keep", autoApprove: ["cat"] });
	await h.b.closeParents();
	const executed = fakeExecuted(h.state).length;
	await h.run([h.review(ids[2])]);
	const three = await h.reviewRun(ids[2]);
	const run3 = nativeRun(three.events);
	assert.match(JSON.stringify(run3?.denied), /a reviewer has no Bash/, JSON.stringify(run3));
	assert.deepEqual([run3?.hook_failed, run3?.stop], [true, "lockdown"], JSON.stringify(run3));
	assert.equal(fakeExecuted(h.state).length, executed, "neither command executed");
	assert.ok(!readFileSync(join(three.run, "events.jsonl"), "utf8").includes(OUTSIDE_SENTINEL));
	assert.ok(!toolResults(h).some((entry) => resultText(entry).includes(OUTSIDE_SENTINEL)));
	assert.equal(three.verdict, undefined);
	await allScopesKilled(h);
	assertClean(h);
});

// Scenario: a Codex reviewer reading outside its packet gets a hook refusal and no outside text (part 1); a read under
// a dead hook ends the review with no verdict and no packet text (part 2); a symlink planted in the packet is never
// followed (part 3, the run core: picp writes the packet at review start, so no public entry plants a link).
test("CX-6c: a codex reviewer reads only its packet: outside paths refused, a dead hook ends the review, a link is never followed", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_review: true } });
	const ids = ["cp-cx6c-1", "cp-cx6c-2"] as const;
	for (const id of ids) await h.heldShipJob(id);
	h.reviewsRow(h.b.provider.addScript("cx6c-pi", [{ kind: "text", text: "unused" }]));
	nextTurn(h, [
		{ kind: "tool", tool: "read", arguments: { path: "../brief.md" } },
		{ kind: "tool", tool: "read", arguments: { path: "/etc/hostname" } },
		{ kind: "tool", tool: "grep", arguments: { pattern: "x", path: ".." } },
		{ kind: "tool", tool: "find", arguments: { pattern: "/etc/*" } },
		{ kind: "tool", tool: "grep", arguments: { pattern: "REVIEWED-CHANGE-LINE" } },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(ids[0]) },
	]);
	await h.run([h.review(ids[0])]);
	const one = await h.reviewRun(ids[0]);
	const denied = (nativeRun(one.events)?.denied ?? []) as string[];
	assert.equal(denied.filter((line) => /a reviewer reads only its scratch dir/.test(line)).length, 4, JSON.stringify(denied));
	assert.deepEqual(toolResults(h).map((entry) => entry.tool), ["grep", "report_verdict"], "no outside call reached a handler");
	const brief = readFileSync(join(one.run, "brief.md"), "utf8");
	const marker = brief.split("\n").find((line) => line.length > 40) ?? brief;
	assert.ok(!toolResults(h).some((entry) => resultText(entry).includes(marker)), "the brief's text is in no result");
	assert.match(resultText(toolResults(h)[0]!), /diff\.md:\d+: .*REVIEWED-CHANGE-LINE/);
	assert.deepEqual(one.verdict, verdict(ids[0]));

	nextTurn(h, [{ kind: "tool", tool: "read", arguments: { path: "diff.md" }, hook: "kill" }, { kind: "tool", tool: "report_verdict", arguments: verdict(ids[1]) }]);
	await h.b.closeParents();
	const before = toolResults(h).length;
	await h.run([h.review(ids[1])]);
	const two = await h.reviewRun(ids[1]);
	const run2 = nativeRun(two.events);
	assert.deepEqual([run2?.hook_failed, run2?.stop], [true, "lockdown"], JSON.stringify(run2));
	for (const entry of toolResults(h).slice(before)) assert.doesNotMatch(resultText(entry), /REVIEWED-CHANGE-LINE/, "picp's refusal, never the packet");
	assert.equal(two.verdict, undefined);
	assert.deepEqual([two.result.verdict, two.result.cause], ["escalate", "operational"], JSON.stringify(two.result));
	await allScopesKilled(h);
	assertClean(h);

	const core = codexFixture(t, "cp-cx6c-core", { turns: [[
		{ kind: "tool", tool: "read", arguments: { path: "link" } },
		{ kind: "tool", tool: "find", arguments: {} },
		{ kind: "message", text: "Reviewed." },
	]] });
	symlinkSync(join(core.outside, "secret.txt"), join(core.worktree, "link"));
	const result = await core.run({ job: { job_id: "cp-cx6c-core", kind: "research", role: "gate-reviewer", delivery: "pr", runDir: core.runDir, worktree: core.worktree } });
	assert.equal(result.lockdown?.verdict, "ok", JSON.stringify(result.lockdown));
	assert.match(JSON.stringify(result.denials), /"tool":"read".*a reviewer reads only its scratch dir/, JSON.stringify(result.denials));
	const coreResults = readFileSync(join(core.stateDir, "tool-results.jsonl"), "utf8");
	assert.match(coreResults, /README\.md/);
	assert.doesNotMatch(coreResults, /secret\.txt|"link/);
	assert.ok(!coreResults.includes(OUTSIDE_SENTINEL));
	assert.equal(result.bypass, undefined);
});

// Scenario: with no data/native.json and a hand-written codex reviews row, a review refuses naming the switch (cp-qmry:
// never pi) and nothing persisted names codex, so the previous build reads every file (S5).
test("CX-6d: switches off, a codex reviews row refuses by name (never pi) and no persisted file names codex", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: null });
	const id = "cp-cx6d";
	await h.heldShipJob(id);
	const piModel = h.b.provider.addScript("cx6d-pi", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(id) }] }]);
	h.reviewsRow(piModel);
	const [refused] = (await h.run([h.review(id)])).filter((end) => end.toolName === "cp_review");
	assert.equal(refused?.isError, true, JSON.stringify(refused?.result.content));
	assert.match(JSON.stringify(refused?.result.content), /cannot run on the Codex CLI driver: the switch codex_review is off/);
	assert.equal(existsSync(join(h.b.home, paths.reviewRunDir(id, 1))), false, "a reviewer ran on another CLI");
	assert.equal(existsSync(codexAvailabilityFile(h.b.home)), false);
	assert.equal(existsSync(h.nativeFile), false, "native.json was never written");
	const codexValue = /"(?:requested_)?driver":"codex"|driver=codex/;
	for (const file of [LAYOUT.fleetFile, LAYOUT.dispatchQueueFile, LAYOUT.armedDispatchFile].map((rel) => join(h.b.home, rel))) {
		if (existsSync(file)) assert.doesNotMatch(readFileSync(file, "utf8"), codexValue, file);
	}
	const rubric = (JSON.parse(readFileSync(join(h.b.home, LAYOUT.routingFile), "utf8")) as { rubric: Array<{ id: string; driver?: string }> }).rubric;
	assert.deepEqual(rubric.filter((row) => row.driver === "codex").map((row) => row.id), ["reviews"]);
	assert.deepEqual(fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server"), [], "no app-server started");
	assertClean(h);
});

// Scenario: a live codex research job holds the one codex slot, so a review on a codex row waits for Codex CLI capacity
// (cp-qmry: its pi fallback never runs); once that job tears down, the review takes the slot on codex.
test("CX-6e: a reviewer that finds the codex slot full waits for Codex CLI capacity, never pi; a free slot runs codex", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_review: true } });
	const research = await h.job();
	const [full, free] = ["cp-cx6e-full", "cp-cx6e-free"];
	for (const id of [full, free]) await h.heldShipJob(id);
	const piModel = h.b.provider.addScript("cx6e-pi", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(full) }] }]);
	h.reviewsRow(piModel);
	h.setScript({ turns: [h.reporting(research.id), [{ kind: "tool", tool: "report_verdict", arguments: verdict(free) }]] });
	const [occupied] = (await h.run([research.dispatch(), h.awaitEnvelope(research.id), h.review(full)])).filter((end) => end.toolName === "cp_review");
	assert.equal(h.record(research.id)?.worker.driver, "codex");
	assert.equal(occupied?.isError, true, JSON.stringify(occupied?.result.content));
	assert.match(JSON.stringify(occupied?.result.content), new RegExp(`codex concurrency is 1 and ${research.id} is live.* is waiting for Codex CLI capacity`));
	assert.equal(existsSync(join(h.b.home, paths.reviewRunDir(full, 1))), false, "a reviewer ran on pi");
	await h.b.closeParents();
	await h.run([{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: research.id } }] }, h.pause(2), h.review(free)]);
	const codex = await h.reviewRun(free);
	assert.match(String(codex.routed?.line), /driver=codex/, JSON.stringify(codex.routed));
	assert.deepEqual(codex.verdict, verdict(free));
	assert.equal(h.b.provider.requests("cx6e-pi").length, 0, "the pi reviewer model was never called");
	await allScopesKilled(h);
	assertClean(h);
});

// Scenario: a codex quality voter row; voter 1 runs on codex and, while it runs, codex_max_concurrent drops to 1 with
// the subject holding a slot, so voter 2's spawn is refused "codex concurrency". cp-qmry: it abstains by name and
// never votes on pi (the old quality.ts re-route ran it on the row's pi fallback).
test("CX-6f: a quality voter that loses the codex slot at spawn abstains by name, never votes on pi", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_review: true, codex_max_concurrent: 2 } });
	const subject = await h.job();
	const marker = join(h.state, "voter-1-running");
	h.setScript({ turns: [h.reporting(subject.id), [
		{ kind: "hold", marker: "voter-1-running", forMs: 3_000 },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(subject.id) },
		{ kind: "message", text: "Reviewed." },
	]] });
	const piVoter = h.b.provider.addScript("cx6f-pi-voter", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(subject.id) }] }]);
	h.b.agent.writeModels(h.b.provider);
	h.reviewsRow(piVoter);
	// codexSelectionRefusal and the spawn read this process's env: the stub dir and the synthetic Codex home.
	const saved = { PATH: process.env.PATH, CP_CODEX_HOME: process.env.CP_CODEX_HOME };
	Object.assign(process.env, h.env);
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
	});
	const post = h.b.ownPost(new CommandPost({
		home: h.b.home, packageRoot: REPO_ROOT, holdsParentLock: () => true, parentEnv: { ...process.env, ...h.b.agent.env, ...h.env },
		modelRegistry: () => ({ find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: (m: { provider: string; id: string }) => `${m.provider}/${m.id}` !== FAKE_CODEX_REF }),
	}));
	await post.dispatch({ jobId: subject.id, task: "Report what README.md says.", model: FAKE_CODEX_REF, driver: "codex", fetch: false });
	await waitFor(() => readRunEvents(h.b.home, subject.id).some((event) => event.type === "agent_settled"), Boolean, { timeoutMs: 120_000, what: "the subject's settled turn" });
	const lose = waitFor(() => existsSync(marker), Boolean, { timeoutMs: 120_000, what: "voter 1 running" })
		.then(() => writeFileSync(h.nativeFile, JSON.stringify({ codex_research: true, codex_review: true, codex_max_concurrent: 1 })));
	const panel = await post.qualityPass().runAndWait({ jobId: subject.id, task: "Report what README.md says.", config: { verify: true, voters: 2, threshold: 1 } });
	await lose;
	const votes = panel?.verify?.votes ?? [];
	assert.deepEqual(votes.map((vote) => [vote.model, vote.abstained ?? false]), [[FAKE_CODEX_REF, false], [FAKE_CODEX_REF, true]], JSON.stringify(votes));
	assert.match(JSON.stringify(votes[1]), /codex concurrency is 1/);
	assertClean(h);
});

// Scenario: cp_gate on a codex research job, with the reviews row on codex, runs its gate reviewer on codex: it reads
// the artifact copy in its packet and files a pass.
test("CX-6g: cp_gate on a codex reviews row runs the gate reviewer on codex", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_research: true, codex_review: true, codex_max_concurrent: 2 } });
	const research = await h.job();
	h.reviewsRow(h.b.provider.addScript("cx6g-pi", [{ kind: "text", text: "unused" }]));
	h.setScript({ turns: [h.reporting(research.id), [
		{ kind: "tool", tool: "read", arguments: { path: "artifact.md" } },
		{ kind: "tool", tool: "report_verdict", arguments: verdict(research.id) },
		{ kind: "message", text: "Gated." },
	]] });
	await h.run([research.dispatch(), h.awaitEnvelope(research.id), { kind: "tool_calls", calls: [{ name: "cp_gate", args: { job_id: research.id } }] }]);
	const file = join(h.b.home, paths.gateFile(research.id, 1));
	await waitFor(() => existsSync(file), Boolean, { timeoutMs: 180_000, what: "the gate's first verdict" });
	assert.equal((JSON.parse(readFileSync(file, "utf8")) as { verdict: string }).verdict, "pass", readFileSync(file, "utf8"));
	const events = readFileSync(join(h.b.home, paths.gateRunDir(research.id, 1), "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
	const run = nativeRun(events);
	assert.deepEqual([run?.driver, run?.lockdown, run?.report], ["codex", "ok", true], JSON.stringify(run));
	assert.match(resultText(toolResults(h).find((entry) => entry.tool === "read")!), /# codex findings/);
	assertClean(h);
});

// Scenario: the reviewer's guard follows codex_review (C8 h)
//   Given only codex_review on, a signed-out codex and the reviews row on codex with pi fallback, When cp_review runs,
//   Then cp-qmry: the review refuses naming the auth reason and never runs on pi.
test("CX-8i: a signed-out codex refuses a codex-row review by name, never pi; the guard follows codex_review", { skip, timeout: 300_000 }, async (t) => {
	const h = await codexWorkerHome(t, { native: { codex_review: true } });
	const id = "cp-cx8i";
	await h.heldShipJob(id);
	h.reviewsRow(h.b.provider.addScript("cx8i-pi", [{ kind: "tool_calls", calls: [{ name: "report_verdict", args: verdict(id) }] }]));
	h.setScript({ knobs: { loginStatus: 1 }, turns: [] });
	const [refused] = (await h.run([h.review(id)])).filter((end) => end.toolName === "cp_review");
	assert.equal(refused?.isError, true, JSON.stringify(refused?.result.content));
	assert.match(JSON.stringify(refused?.result.content), /cannot run on the Codex CLI driver: codex is not signed in/);
	assert.equal(existsSync(join(h.b.home, paths.reviewRunDir(id, 1))), false, "a reviewer ran on another CLI");
	assert.deepEqual(fakeSpawns(h.state).filter((each) => each.argv[0] === "app-server"), [], "no app-server started");
	assertClean(h);
});
