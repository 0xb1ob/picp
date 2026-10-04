/**
 * T16 acceptance: the pr-hold and local flows, and a double report that
 * changes nothing.
 *
 * The worker is a real pi child that calls `report_result`; intake fires from
 * its event stream, not from a poll.
 */

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type Delivery,
	type FleetRecord,
	isoTimestamp,
	type JobKind,
	LAYOUT,
	paths,
	MINIMAL_PLAN_SUMMARY,
	SCHEMA_VERSION,
} from "../src/contracts.ts";
import { publishBoard } from "../src/board-delivery.ts";
import { CommandPost } from "../src/command-post.ts";
import { EscalationStore } from "../src/escalation.ts";
import { FleetStore } from "../src/fleet.ts";
import { EnvelopeIntake, formatIntake, type IntakeResult } from "../src/intake.ts";
import { loadProfile } from "../src/profiles.ts";
import { RunRegistry } from "../src/runs.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	createAgentDir,
	createScratchHome,
	createScratchRepo,
	MockProvider,
	readFleet,
	readRunEvents,
	REPO_ROOT,
	type ScratchHome,
	waitFor,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");

interface Bench {
	home: ScratchHome;
	fleet: FleetStore;
	runs: RunRegistry;
	intake: EnvelopeIntake;
	reported: IntakeResult[];
	/** Cleanups run in registration order, always before the home is removed. */
	onCleanup(fn: () => void | Promise<void>): void;
}

function benchOf(t: { after(fn: () => void | Promise<void>): void }, viewer: { host?: string; port?: number } = { host: "127.0.0.1", port: 9876 }): Bench {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const reported: IntakeResult[] = [];
	const intake = new EnvelopeIntake({
		home: home.path,
		viewerHost: viewer.host,
		viewerPort: viewer.port,
		fleet,
		runs,
		fail: (jobId, failure) => fleet.markFailed(jobId, failure),
		onReported: (result) => reported.push(result),
	});
	const cleanups: Array<() => void | Promise<void>> = [];
	t.after(async () => {
		for (const fn of cleanups) await fn();
		home.cleanup();
	});
	return { home, fleet, runs, intake, reported, onCleanup: (fn) => cleanups.push(fn) };
}

async function addJob(
	b: Bench,
	jobId: string,
	options: { kind?: JobKind; delivery?: Delivery; worktree?: string } = {},
): Promise<FleetRecord> {
	const record: FleetRecord = {
		job_id: jobId,
		project: "demo",
		kind: options.kind ?? "ship",
		delivery: options.delivery ?? "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(b.home.path, "s.jsonl"),
			profile: options.kind === "research" ? "planner" : "implementer",
			role: options.kind === "research" ? "planner" : "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree: options.worktree ?? join(b.home.path, "wt"),
		branch: jobId,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
	};
	return b.fleet.add(record);
}

function writeEnvelopeFile(home: string, jobId: string, envelope: Record<string, unknown>): void {
	mkdirSync(join(home, paths.runDir(jobId)), { recursive: true });
	writeFileSync(
		join(home, paths.envelopeFile(jobId)),
		`${JSON.stringify({ schema_version: SCHEMA_VERSION, job_id: jobId, received_at: isoTimestamp(), attempt: 1, envelope }, null, 2)}\n`,
	);
}

test("board delivery publishes a static site and relays its URL", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-board", { kind: "research", delivery: "board" });
	const source = join(b.home.path, paths.artifactDir("cp-board"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Status", description: "Current jobs", job_ids: ["cp-board"], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "<h1>Status</h1>");
	writeEnvelopeFile(b.home.path, "cp-board", {
		job_id: "cp-board", kind: "research", status: "done", summary: "Status board published.",
		artifact_path: join(source, "board.json"),
	});
	const result = await b.intake.intake("cp-board");
	assert.equal(result.accepted, true);
	assert.equal(result.next, "teardown");
	assert.equal(result.board_url, "http://127.0.0.1:9876/boards/cp-board/");
	assert.deepEqual(result.receipts?.find((r) => r.kind === "board"), { kind: "board", status: "published", title: "board for cp-board", url: "http://127.0.0.1:9876/boards/cp-board/" }, "pi-command-post-1jz: the board url survives as a durable receipt, not only the one-time wake text");
	assert.match(formatIntake(result), /board: http:\/\/.*\/boards\/cp-board\//);
	assert.equal(readFileSync(join(b.home.path, LAYOUT.state, "boards/cp-board/site/index.html"), "utf8"), "<h1>Status</h1>");
	assert.equal((await b.intake.intake("cp-board")).already, true);
});

test("production intake uses the viewer's configured address", async (t) => {
	const b = benchOf(t);
	const post = new CommandPost({ home: b.home.path, packageRoot: REPO_ROOT, parentEnv: { CP_VIEWER_HOST: "127.0.0.2", CP_VIEWER_PORT: "9911" } });
	t.after(() => post.shutdown());
	await addJob(b, "cp-config", { kind: "research", delivery: "board" });
	const source = join(b.home.path, paths.artifactDir("cp-config"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Status", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "ok");
	writeEnvelopeFile(b.home.path, "cp-config", { job_id: "cp-config", kind: "research", status: "done", summary: "Published.", artifact_path: join(source, "board.json") });
	assert.equal((await post.intake.intake("cp-config")).board_url, "http://127.0.0.2:9911/boards/cp-config/");
});

test("board delivery with no configured viewer host resolves the tailnet address the viewer binds under --require-tailnet, never a default (pi-command-post-1jz)", async (t) => {
	const binDir = join(REPO_ROOT, `.tmp-tailscale-${process.pid}-${Date.now()}`);
	mkdirSync(binDir, { recursive: true });
	const tailscaleBin = join(binDir, "tailscale");
	writeFileSync(tailscaleBin, "#!/bin/sh\necho 100.64.9.9\n");
	chmodSync(tailscaleBin, 0o755);
	const originalPath = process.env.PATH ?? "";
	process.env.PATH = `${binDir}:${originalPath}`;
	t.after(() => {
		process.env.PATH = originalPath;
		rmSync(binDir, { recursive: true, force: true });
	});
	// No viewerHost/viewerPort configured: the board url must come from the
	// fake `tailscale ip -4` above, never the 127.0.0.1 loopback default.
	const b = benchOf(t, {});
	await addJob(b, "cp-tailnet", { kind: "research", delivery: "board" });
	const source = join(b.home.path, paths.artifactDir("cp-tailnet"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Status", description: "", job_ids: ["cp-tailnet"], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "<h1>Status</h1>");
	writeEnvelopeFile(b.home.path, "cp-tailnet", {
		job_id: "cp-tailnet", kind: "research", status: "done", summary: "Status board published.",
		artifact_path: join(source, "board.json"),
	});
	const result = await b.intake.intake("cp-tailnet");
	assert.equal(result.accepted, true);
	assert.equal(result.board_url, "http://100.64.9.9:8766/boards/cp-tailnet/", "the served host is the tailnet address, not the 127.0.0.1 default");
});

test("board delivery with no configured viewer host and no tailnet is refused, never silently defaulted (pi-command-post-1jz)", async (t) => {
	const originalPath = process.env.PATH;
	// A PATH with no `tailscale` binary reachable: the fallback must refuse the
	// job instead of quietly resolving to loopback.
	process.env.PATH = "";
	t.after(() => { process.env.PATH = originalPath; });
	const b = benchOf(t, {});
	await addJob(b, "cp-no-tailnet", { kind: "research", delivery: "board" });
	const source = join(b.home.path, paths.artifactDir("cp-no-tailnet"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Status", description: "", job_ids: ["cp-no-tailnet"], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "<h1>Status</h1>");
	writeEnvelopeFile(b.home.path, "cp-no-tailnet", {
		job_id: "cp-no-tailnet", kind: "research", status: "done", summary: "Status board published.",
		artifact_path: join(source, "board.json"),
	});
	const result = await b.intake.intake("cp-no-tailnet");
	assert.equal(result.accepted, false);
	assert.match(formatIntake(result), /require-tailnet/);
});

test("board publication refuses a site file swapped to an external symlink after validation", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const source = join(home.path, paths.artifactDir("cp-swap"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Safe", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "safe");
	const outside = join(home.path, "secret.html");
	writeFileSync(outside, "private");
	assert.throws(() => Reflect.apply(publishBoard, null, [home.path, "cp-swap", join(source, "board.json"), () => {
		rmSync(join(source, "site/index.html"));
		symlinkSync(outside, join(source, "site/index.html"));
	}]), /resolves outside/);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "boards/cp-swap")), false);
});

test("board publication rejects a directory swapped to a symlink while staging", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const source = join(home.path, paths.artifactDir("cp-dir-swap"));
	mkdirSync(join(source, "site/assets"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Safe", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "safe");
	writeFileSync(join(source, "site/assets/icon.svg"), "safe");
	const outside = join(home.path, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "icon.svg"), "private");
	assert.throws(() => publishBoard(home.path, "cp-dir-swap", join(source, "board.json"), () => {
		renameSync(join(source, "site/assets"), join(source, "site/old-assets"));
		symlinkSync(outside, join(source, "site/assets"));
	}), /resolves outside/);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "boards/cp-dir-swap")), false);
});

test("board publication refuses a FIFO under site without blocking", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const source = join(home.path, paths.artifactDir("cp-fifo"));
	mkdirSync(join(source, "site"), { recursive: true });
	writeFileSync(join(source, "board.json"), JSON.stringify({ title: "Safe", description: "", job_ids: [], created_at: isoTimestamp() }));
	writeFileSync(join(source, "site/index.html"), "safe");
	execFileSync("mkfifo", [join(source, "site/pipe")]);
	const script = `import { publishBoard } from ${JSON.stringify(join(REPO_ROOT, "src/board-delivery.ts"))};
try { publishBoard(${JSON.stringify(home.path)}, "cp-fifo", ${JSON.stringify(join(source, "board.json"))}); process.exitCode = 2; }
catch (error) { if (!/not a regular file or directory/.test(String(error))) { console.error(error); process.exitCode = 3; } }`;
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 5_000 });
	assert.equal(result.status, 0, result.error?.message ?? result.stderr);
	assert.equal(existsSync(join(home.path, LAYOUT.state, "boards/cp-fifo")), false);
});

test("bad board metadata, slug and external symlinks refuse the envelope with a reason", async (t) => {
	const b = benchOf(t);
	for (const [id, defect] of [["cp-json", "json"], ["cp-date", "date"], ["cp_bad", "slug"], ["cp-link", "link"], ["cp-traverse", "traverse"]] as const) {
		await addJob(b, id, { kind: "research", delivery: "board" });
		const source = join(b.home.path, paths.artifactDir(id));
		mkdirSync(join(source, "site"), { recursive: true });
		writeFileSync(join(source, "board.json"), defect === "json" ? "{bad" : JSON.stringify({ title: "Status", description: "", job_ids: [], created_at: defect === "date" ? "yesterday" : isoTimestamp() }));
		writeFileSync(join(source, "site/index.html"), "ok");
		if (defect === "link") {
			writeFileSync(join(b.home.path, "outside.html"), "secret");
			symlinkSync(join(b.home.path, "outside.html"), join(source, "site/escape.html"));
		}
		writeEnvelopeFile(b.home.path, id, { job_id: id, kind: "research", status: "done", summary: "Board ready.", artifact_path: defect === "traverse" ? join(source, "..", "board.json") : join(source, "board.json") });
		const result = await b.intake.intake(id);
		assert.equal(result.accepted, false);
		assert.match(formatIntake(result), defect === "json" ? /malformed JSON/ : defect === "date" ? /created_at/ : defect === "slug" ? /board slug/ : defect === "traverse" ? /artifact_path must be/ : /resolves outside/);
		assert.equal(existsSync(join(b.home.path, LAYOUT.state, "boards", id)), false);
	}
});

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

test("delivery:pr holds; delivery:local is ready for teardown", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-pr", { delivery: "pr" });
	await addJob(b, "cp-local", { delivery: "local" });

	writeEnvelopeFile(b.home.path, "cp-pr", {
		job_id: "cp-pr",
		kind: "ship",
		status: "done",
		summary: "Shipped the retry ladder.",
		branch: "cp-pr",
		pr_url: "https://github.com/o/r/pull/9",
	});
	writeEnvelopeFile(b.home.path, "cp-local", {
		job_id: "cp-local",
		kind: "ship",
		status: "done",
		summary: "Fixed it locally.",
		branch: "cp-local",
	});

	const pr = await b.intake.intake("cp-pr");
	assert.equal(pr.accepted, true);
	assert.equal(pr.phase, "held");
	assert.equal(pr.next, "hold");
	assert.equal(pr.receipts?.find((receipt) => receipt.kind === "pr")?.url, "https://github.com/o/r/pull/9");

	const local = await b.intake.intake("cp-local");
	assert.equal(local.next, "teardown");
	assert.equal(local.phase, "held", "held means the envelope is in; teardown is the parent's next move");

	const jobs = Object.fromEntries(readFleet(b.home.path).jobs.map((job) => [job.job_id, job]));
	assert.ok(jobs["cp-pr"]?.reported_at);
	assert.ok(jobs["cp-local"]?.reported_at);
	assert.equal(b.reported.length, 2);
	assert.match(formatIntake(pr), /cp-pr reported done \(ship\/pr\) → hold/);
	assert.match(formatIntake(pr), /PR: https/);
});

test("a ship envelope with no CI claim is accepted, and its pushed head sha becomes a receipt (cp-kzc)", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-head", { delivery: "pr" });
	const head = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";

	// Deliberately silent about CI: the worker pushed and stopped, exactly as the
	// brief now requires. Silence is not an incomplete job.
	writeEnvelopeFile(b.home.path, "cp-head", {
		job_id: "cp-head",
		kind: "ship",
		status: "done",
		summary: "Pushed the fix; local suite green on the rebased tree.",
		branch: "cp-head",
		pr_url: "https://github.com/o/r/pull/11",
		head_sha: head,
		base_sha: "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a",
	});

	const result = await b.intake.intake("cp-head");
	assert.equal(result.accepted, true);
	assert.equal(result.phase, "held");
	assert.equal(result.next, "hold");
	const ci = result.receipts?.find((receipt) => receipt.kind === "ci");
	assert.equal(ci?.status, "unverified", "the parent verifies CI itself, against this sha");
	assert.equal(ci?.title, `head ${head}`);
});

test("cp-u3o4: a delivery:answer envelope is teardown-next, and onReported carries a pointer only", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-question", { kind: "research", delivery: "answer" });

	const source = join(b.home.path, "outside", "answer.md");
	mkdirSync(join(b.home.path, "outside"), { recursive: true });
	writeFileSync(source, "# Answer\n\nThe retry ladder is configured in src/routing.ts.\n");

	writeEnvelopeFile(b.home.path, "cp-question", {
		job_id: "cp-question",
		kind: "research",
		status: "done",
		summary: "Configured in src/routing.ts.",
		artifact_path: source,
	});

	const result = await b.intake.intake("cp-question");
	assert.equal(result.accepted, true);
	assert.equal(result.phase, "held");
	// `answer` is a delivery, and only `pr` holds: an answer needs no PR to land.
	assert.equal(result.next, "teardown");
	assert.equal(result.delivery, "answer");
	assert.equal(result.kind, "research");
	// The card is built from exactly this: a path, a byte count and a headline.
	assert.equal(result.artifact?.path, join(b.home.path, paths.artifactFile("cp-question")));
	assert.ok((result.artifact?.bytes ?? 0) > 0);
	assert.equal(result.summary, "Configured in src/routing.ts.");
	assert.ok(!JSON.stringify(result).includes("retry ladder is configured"), "the answer body never travels in the result");
	assert.match(formatIntake(result), /cp-question reported done \(research\/answer\) → teardown/);

	// One accepted envelope means one card: a duplicate intake appends nothing.
	assert.equal(b.reported.length, 1);
	const again = await b.intake.intake("cp-question");
	assert.equal(again.already, true);
	assert.equal(b.reported.length, 1);
});

test("a research artifact is registered by stat and move, never read", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-research", { kind: "research", delivery: "pipeline" });

	// The worker wrote its findings somewhere outside the worktree.
	const source = join(b.home.path, "outside", "report.md");
	mkdirSync(join(b.home.path, "outside"), { recursive: true });
	writeFileSync(source, "# Findings\n\nA very long body the parent must never read.\n");

	writeEnvelopeFile(b.home.path, "cp-research", {
		job_id: "cp-research",
		kind: "research",
		status: "done",
		summary: "Three call sites need the guard; details in the artifact.",
		artifact_path: source,
		plan_summary: MINIMAL_PLAN_SUMMARY,
		self_assessment: { confidence: "high", scope: "M", blocking_unknowns: false, destructive_scope: false },
	});

	const result = await b.intake.intake("cp-research");
	assert.equal(result.accepted, true);
	assert.equal(result.artifact?.relocated, true);
	assert.equal(result.artifact?.path, join(b.home.path, paths.artifactFile("cp-research")));
	assert.ok((result.artifact?.bytes ?? 0) > 0);
	assert.ok(existsSync(join(b.home.path, paths.artifactFile("cp-research"))));

	// Nothing in the result carries the body.
	const serialized = JSON.stringify(result);
	assert.ok(!serialized.includes("A very long body"), "the artifact body never enters the parent's world");
	assert.ok(serialized.includes("details in the artifact"), "the headline does travel");
	assert.equal(result.receipts?.find((receipt) => receipt.kind === "artifact")?.status, "stored");
});

test("re-reporting is idempotent; the second intake writes nothing", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-twice", { delivery: "pr" });
	writeEnvelopeFile(b.home.path, "cp-twice", {
		job_id: "cp-twice",
		kind: "ship",
		status: "done",
		summary: "Done once.",
		branch: "cp-twice",
		pr_url: "https://github.com/o/r/pull/1",
	});

	const first = await b.intake.intake("cp-twice");
	const fleetAfterFirst = readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8");
	const second = await b.intake.intake("cp-twice");

	assert.equal(first.already, false);
	assert.equal(second.already, true);
	assert.equal(second.phase, "held");
	assert.equal(readFileSync(join(b.home.path, LAYOUT.fleetFile), "utf8"), fleetAfterFirst);
	assert.equal(b.reported.length, 1, "the operator is told once");
	assert.equal(
		readRunEvents(b.home.path, "cp-twice").filter((event) => event.type === "envelope_received").length,
		1,
	);
});

test("a blocked envelope is accepted, with its blockers", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-blocked", { delivery: "local" });
	writeEnvelopeFile(b.home.path, "cp-blocked", {
		job_id: "cp-blocked",
		kind: "ship",
		status: "blocked",
		summary: "Cannot proceed: the migration needs owner sign-off.",
		blockers: ["migration needs owner sign-off"],
	});

	const result = await b.intake.intake("cp-blocked");
	assert.equal(result.accepted, true);
	assert.equal(result.status, "blocked");
	assert.deepEqual(result.blockers, ["migration needs owner sign-off"]);
	assert.match(formatIntake(result), /blockers: migration needs owner sign-off/);
});

const question = {
	question: "Which store?",
	why: "Schema depends on it.",
	options: ["Postgres", "SQLite"],
	recommended: "SQLite",
	assume_if_unanswered: "SQLite",
};

test("a blocked planner envelope waits, and the wake-up carries the questions not the body", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-planq", { kind: "research", delivery: "pipeline" });
	const source = join(b.home.path, "outside", "report.md");
	mkdirSync(join(b.home.path, "outside"), { recursive: true });
	writeFileSync(source, "SECRET_BODY_DO_NOT_TRAVEL\n");
	writeEnvelopeFile(b.home.path, "cp-planq", {
		job_id: "cp-planq",
		kind: "research",
		status: "blocked",
		summary: "Need a store decision.",
		artifact_path: source,
		blockers: [question, { ...question, question: "Which TTL?" }],
	});

	const result = await b.intake.intake("cp-planq");
	assert.equal(result.accepted, true);
	assert.equal(result.phase, "waiting");
	assert.equal(result.next, "answer");
	assert.equal(readFleet(b.home.path).jobs[0]?.phase, "waiting");
	assert.equal(readFleet(b.home.path).jobs[0]?.planner_blocked_rounds, 1);
	const wake = formatIntake(result);
	assert.match(wake, /Which store\?/);
	assert.match(wake, /SQLite/);
	assert.match(wake, /Which TTL\?/);
	assert.ok(!wake.includes("SECRET_BODY_DO_NOT_TRAVEL"), wake);
	assert.ok(!wake.includes(source), "the artifact path is not the headline");
});

test("the third blocked planner round escalates instead of asking the parent", async (t) => {
	const b = benchOf(t);
	const escalations = new EscalationStore({ home: b.home.path });
	b.intake = new EnvelopeIntake({
		home: b.home.path,
		fleet: b.fleet,
		runs: b.runs,
		escalations: () => escalations,
		fail: (jobId, failure) => b.fleet.markFailed(jobId, failure),
		onReported: (result) => b.reported.push(result),
	});
	await addJob(b, "cp-round", { kind: "research", delivery: "local" });
	await b.fleet.patch("cp-round", { planner_blocked_rounds: 2 });
	writeEnvelopeFile(b.home.path, "cp-round", {
		job_id: "cp-round",
		kind: "research",
		status: "blocked",
		summary: "Still blocked.",
		blockers: [question],
	});
	const result = await b.intake.intake("cp-round");
	assert.equal(result.next, "escalate");
	assert.equal(result.phase, "waiting");
	assert.match(result.escalation_id ?? "", /^es-/);
	assert.match(formatIntake(result), /do not answer these blockers/);
	assert.match(formatIntake(result), /Which store\?/);
});

test("an envelope that contradicts the dispatch record is refused, then fails the job when it is repeated", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-liar", { kind: "ship", delivery: "pr" });
	const contradiction = {
		job_id: "cp-someone-else",
		kind: "research" as const,
		status: "done" as const,
		summary: "Not my job.",
	};
	writeEnvelopeFile(b.home.path, "cp-liar", contradiction);

	// pi-command-post-uad: refused, never stamped — and never left on disk, which
	// is what used to close the worker's slot for good.
	const first = await b.intake.intake("cp-liar");
	assert.equal(first.accepted, false);
	assert.equal(first.failure, undefined, "a correctable refusal is not a job failure");
	assert.match(first.correction?.reason ?? "", /cp-someone-else/, "the reason names the contradiction itself");
	assert.equal(readFleet(b.home.path).jobs[0]?.phase, "waiting", "still reportable");
	assert.equal(readFleet(b.home.path).jobs[0]?.reported_at, undefined, "never stamped");

	// The same contradiction again: the generation's one correction is spent.
	writeEnvelopeFile(b.home.path, "cp-liar", contradiction);
	const second = await b.intake.intake("cp-liar");
	assert.equal(second.accepted, false);
	assert.equal(second.correction, undefined);
	assert.equal(second.phase, "failed");
	assert.equal(second.failure?.class, "envelope_invalid");
	assert.equal(readFleet(b.home.path).jobs[0]?.phase, "failed");
});

test("an exhausted worker (envelope-rejected.json) is an envelope_invalid failure", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-rejected", { delivery: "local" });
	mkdirSync(join(b.home.path, paths.runDir("cp-rejected")), { recursive: true });
	writeFileSync(
		join(b.home.path, paths.runDir("cp-rejected"), "envelope-rejected.json"),
		JSON.stringify({ job_id: "cp-rejected", attempts: 3 }),
	);

	const result = await b.intake.intake("cp-rejected");
	assert.equal(result.accepted, false);
	assert.equal(result.failure?.class, "envelope_invalid");
	assert.equal(readFleet(b.home.path).jobs[0]?.phase, "failed");

	// Idempotent: a second pass does not re-fail an already failed job.
	const again = await b.intake.intake("cp-rejected");
	assert.equal(again.failure, undefined);
	assert.equal(again.phase, "failed");
});

test("nothing on disk yet is not an error", async (t) => {
	const b = benchOf(t);
	await addJob(b, "cp-quiet", { delivery: "pr" });
	const result = await b.intake.intake("cp-quiet");
	assert.deepEqual(result, { job_id: "cp-quiet", accepted: false, already: false, phase: "waiting" });
	await assert.rejects(() => b.intake.intake("cp-unknown"), /no fleet record/);
});

// ---------------------------------------------------------------------------
// against a live worker
// ---------------------------------------------------------------------------

test("intake fires from the worker's own event stream", { timeout: 120_000 }, async (t) => {
	const jobId = "cp-live";
	const b = benchOf(t);
	const repo = createScratchRepo({ name: "intake" });
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const envelope = {
		job_id: jobId,
		kind: "ship" as const,
		status: "done" as const,
		summary: "Reported through the tool, not through prose.",
		branch: jobId,
		pr_url: "https://github.com/o/r/pull/42",
		head_sha: repo.head(),
	};
	const model = provider.addScript("intake", [{ kind: "tool_calls", calls: [{ name: "report_result", args: envelope }] }]);
	agentDir.writeModels(provider);

	const manager = new WorkerManager({
		home: b.home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const runDir = join(b.home.path, paths.runDir(jobId));
	mkdirSync(runDir, { recursive: true });
	await addJob(b, jobId, { delivery: "pr", worktree: repo.path });

	const managed = manager.spawn({
		identity: { jobId, kind: "ship", delivery: "pr", runDir, worktree: repo.path },
		profile: loadProfile(PROFILES_DIR, "implementer"),
		model,
		sessionDir: join(b.home.path, "sessions"),
	});
	b.runs.open(jobId).markSpawned({ pid: managed.worker.pid, model, profile: "implementer" });
	b.runs.open(jobId).attach(managed.worker);
	const detach = b.intake.watch(jobId, managed.worker);

	b.onCleanup(async () => {
		detach();
		await manager.shutdownAll();
		b.runs.closeAll();
		agentDir.cleanup();
		repo.cleanup();
		await provider.stop();
	});

	await managed.worker.getState(30_000);
	await managed.worker.send("do the job");

	const record = await waitFor(
		() => readFleet(b.home.path).jobs[0] as FleetRecord,
		(job) => job.phase === "held",
		{ what: "the job to be held after its envelope" },
	);
	assert.ok(record.reported_at);
	assert.equal(record.receipts?.find((receipt) => receipt.kind === "pr")?.url, envelope.pr_url);
	assert.equal(b.reported.length, 1, "one envelope, one notification");
	assert.equal(b.reported[0]?.summary, envelope.summary);
	assert.equal(b.reported[0]?.next, "hold");
	assert.equal(managed.worker.alive, true, "a delivery:pr hold keeps the worker alive");
});
