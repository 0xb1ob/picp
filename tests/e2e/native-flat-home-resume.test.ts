/**
 * N4l: a native ship job in a flat home (`~/.pi-command-post`) reports done; the red-CI repair promotion (`cp_send`
 * purpose repair) must resume it. The worker read the nested layout and refused: "no native fleet record". Real
 * `cp_dispatch`/`cp_send` of a pi parent; the installed `claude` on the fake model.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { configureLayout, LAYOUT, paths, SCHEMA_VERSION } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { REPORT_TOOL } from "../../src/drivers/claude-spike.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { type ClaudeStep, FAKE_CLAUDE_AUTH_TOKEN, FAKE_NATIVE_MODEL, routeNativeModel, startClaudeMockProvider } from "../harness/claude-mock-provider.ts";
import { readFleet, readRunEvents, treehouseAvailable } from "../harness/index.ts";

// This process writes the home's files through LAYOUT, so it takes the flat layout its homes have.
configureLayout("multi", join(tmpdir(), ".pi-command-post"));
const missing = [whichAll("claude", process.env)[0] === undefined && "claude", !treehouseAvailable() && "treehouse"].filter(Boolean);
const skip = missing.length > 0 ? `needs ${missing.join(" and ")} on PATH` : false;
type Tool = { toolName: string; isError?: boolean; result: { details?: Record<string, unknown>; content?: unknown } };
const text = (end: Tool | undefined) => JSON.stringify(end?.result.content ?? "");
const step = (name: string, input: unknown): ClaudeStep => ({ kind: "tool_use", calls: [{ name, input }] });
const bash = (args: unknown) => ({ kind: "tool_calls" as const, calls: [{ name: "bash", args }] });

test("N4l: in a flat home, a native ship job that reported done resumes on the red-CI repair promotion", { skip, timeout: 420_000 }, async (t) => {
	const PR_URL = "https://github.com/picp-e2e/forge/pull/9";
	let id = "";
	const b = await dispatchS29(t, { flat: true });
	assert.equal(b.home.endsWith("/.pi-command-post"), true);
	const worktree = () => readFleet(b.home).jobs.find((job) => job.job_id === id)!.worktree;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree(), encoding: "utf8" }).trim();
	const report = (summary: string) => ({ job_id: id, kind: "ship", status: "done", summary, branch: id, head_sha: git("rev-parse", "HEAD"), pr_url: PR_URL });
	const claude = await startClaudeMockProvider([
		step("Write", () => ({ file_path: join(worktree(), "shipped.txt"), content: "shipped\n" })),
		step("Bash", { command: "git add -A && git commit -q -m shipped" }),
		step("mcp__picp__git_push", {}),
		step("mcp__picp__pr_create", { title: "Ship it", body: "Native flat-home e2e." }),
		step(REPORT_TOOL, () => report("Shipped natively.")),
		{ kind: "text", text: "Reported." },
		step("Write", () => ({ file_path: join(worktree(), "repaired.txt"), content: "fixed\n" })),
		step("Bash", { command: "git add -A && git commit -q -m repaired" }),
		step("mcp__picp__git_push", {}),
		step(REPORT_TOOL, () => report("Repaired natively.")),
		{ kind: "text", text: "Repaired." },
	]);
	routeNativeModel(b.home);
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-n4l-home-"));
	const bin = mkdtempSync(join(tmpdir(), "cp-n4l-gh-"));
	t.after(async () => { await claude.close(); rmSync(fakeHome, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); });
	mkdirSync(join(fakeHome, ".claude"), { recursive: true, mode: 0o700 });
	writeFileSync(join(fakeHome, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: claude.url, ANTHROPIC_AUTH_TOKEN: FAKE_CLAUDE_AUTH_TOKEN } }));
	writeFileSync(join(b.home, LAYOUT.routingFile), JSON.stringify({ schema_version: SCHEMA_VERSION, allow: ["mock/*", FAKE_NATIVE_MODEL],
		rubric: [{ id: "small-ship", role: "implementer", scope: ["S"], model: FAKE_NATIVE_MODEL, driver: "claude" }] }));
	writeFileSync(join(b.home, LAYOUT.data, "native.json"), JSON.stringify({ claude_ship: true }));
	copyFileSync(join(import.meta.dirname, "..", "fixtures", "forge-gh"), join(bin, "gh"));
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(bin, "gitconfig"), "[user]\n\tname = n4l e2e\n\temail = n4l@test.invalid\n");
	id = (await b.ledger.create({ title: `n4l flat ship ${Math.random()}`, project: "demo", delivery: "pr", kind: "ship" })).id;
	const envelope = join(b.home, paths.envelopeFile(id));
	const waitEnvelope = bash({ command: `for i in $(seq 600); do [ -f "${envelope}" ] && break; sleep 0.2; done; sleep 2` });
	// The red CI run on the reported head, as the CI watch records it, beside intake's PR receipt.
	const ciRed = bash(() => {
		const file = join(b.home, LAYOUT.fleetFile);
		const fleet = JSON.parse(readFileSync(file, "utf8")) as { jobs: Array<{ job_id: string; receipts?: unknown[] }> };
		const job = fleet.jobs.find((entry) => entry.job_id === id)!;
		job.receipts = [...(job.receipts ?? []), { kind: "ci", status: "failure", title: "CI on the reported head" }];
		writeFileSync(file, JSON.stringify(fleet, null, 2));
		return { command: "true" };
	});
	const ends = (await b.run([
		{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: id, task: "Add shipped.txt.", scope: "S", queue: false, when_ready: false } }] },
		waitEnvelope,
		ciRed,
		{ kind: "tool_calls", calls: [{ name: "cp_send", args: { job_id: id, message: "CI is red on the pushed head: fix it.", purpose: "repair" } }] },
		waitEnvelope,
	], { HOME: fakeHome, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FORGE_GH_LOG: join(bin, "calls.log"), GIT_CONFIG_GLOBAL: join(bin, "gitconfig") }, undefined, 300_000)) as Tool[];

	const dispatched = ends.find((end) => end.toolName === "cp_dispatch");
	assert.notEqual(dispatched?.isError, true, text(dispatched));
	const record = readFleet(b.home).jobs.find((job) => job.job_id === id)!;
	assert.equal(record.worker.driver, "claude");
	assert.deepEqual([...new Set((record.receipts ?? []).map((receipt) => receipt.kind))].sort(), ["ci", "pr"]);
	// The repair promotion started a resumed turn: no "no native fleet record" refusal from the worker.
	const sent = ends.find((end) => end.toolName === "cp_send");
	assert.notEqual(sent?.isError, true, text(sent));
	assert.equal(sent?.result.details?.receipt, "delivered", text(sent));
	assert.match(String(sent?.result.details?.native), /^resuming:/, text(sent));
	const repair = claude.requests.filter((request) => JSON.stringify(request.body.messages ?? "").includes("CI is red on the pushed head"));
	assert.match(JSON.stringify(repair[0]?.body.messages ?? ""), /Shipped natively\.[\s\S]*CI is red on the pushed head/, "the repair resumed the session");
	const events = readRunEvents(b.home, id);
	assert.equal(events.filter((event) => event.type === "envelope_received").length, 2, "the ship and the repair");
	const runs = events.filter((event) => event.type === "native_run").map((event) => (event.payload as { resumed?: boolean }).resumed);
	assert.deepEqual(runs, [false, true]);
	assert.equal(claude.overrun(), 0);
});
