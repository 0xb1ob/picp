/**
 * cp-live-session-viewer: the read-only web viewer's logic — tailing with
 * byte-offset reading, the sidebar data derived from fleet + run records,
 * path-traversal refusal and the Host-header bind check.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createViewer, hostAllowed, type ViewerOptions } from "../src/viewer/server.ts";
import { deriveSidebar, resolveSessionFile, resolveStateDir, sidebar, type SessionRow } from "../src/viewer/sessions.ts";
import { readLines, startOffset } from "../src/viewer/tail.ts";
import { defaultHost } from "../src/viewer/cli.ts";
import { spawnSync } from "node:child_process";
import { REPO_ROOT, git } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

function scratch(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-viewer-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

for (const direction of ["from denied", "to denied"] as const) {
	test(`git routes suppress both paths and content of renames ${direction}`, async (t) => {
		const options = home(t);
		const repo = join(options.home, LAYOUT.projects, "demo");
		mkdirSync(join(repo, "nested"), { recursive: true });
		git(repo, "init", "-b", "main", "--quiet");
		git(repo, "config", "user.name", "test");
		git(repo, "config", "user.email", "test@example.invalid");
		const pairs: Array<[string, string]> = [
			["nested/.ENV.private", "exposed[1].txt"],
			["nested/auth.json", "odd\tname\n.txt"],
		];
		if (direction === "to denied") for (const pair of pairs) pair.reverse();
		for (const [index, [from]] of pairs.entries()) writeFileSync(join(repo, from), `PRIVATE-${index}\n`.repeat(20));
		writeFileSync(join(repo, "safe-old.txt"), "ordinary rename\n");
		git(repo, "add", "-f", ".");
		git(repo, "commit", "-qm", "baseline");
		const base = git(repo, "rev-parse", "HEAD");
		for (const [from, to] of pairs) {
			renameSync(join(repo, from), join(repo, to));
			appendFileSync(join(repo, to), "PRIVATE-EDIT\n");
		}
		renameSync(join(repo, "safe-old.txt"), join(repo, "safe-new.txt"));
		writeFileSync(join(repo, "visible.txt"), "PUBLIC-CONTENT\n");
		git(repo, "add", "-f", ".");
		const server = createViewer(options);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		options.port = (server.address() as AddressInfo).port;
		t.after(() => server.close());
		const status = JSON.parse((await get(options.port, "/api/git?root=project:demo&view=status")).body);
		git(repo, "commit", "-qm", "moves");
		const head = git(repo, "rev-parse", "HEAD");
		const renames = git(repo, "diff", "--name-status", "-M", base, head);
		assert.equal(renames.split("\n").filter((line) => /^R\d+\t/.test(line)).length, 3, "fixture contains all three detected renames");
		writeFileSync(join(options.stateDir, "runs", "cp-a", "envelope.json"), JSON.stringify({ envelope: { base_sha: base, head_sha: head } }));
		const show = JSON.parse((await get(options.port, `/api/git?root=project:demo&view=show&sha=${head}`)).body);
		const diff = JSON.parse((await get(options.port, "/api/diff?id=cp-a")).body);
		assert.deepEqual([status.ok, show.ok, diff.available], [true, true, true]);
		for (const output of [status.lines.join("\n"), show.text, diff.text]) {
			assert.match(output, /visible.txt/);
			assert.match(output, /safe-old.txt/);
			assert.match(output, /safe-new.txt/);
			assert.doesNotMatch(output, /PRIVATE-/);
			for (const name of pairs.flat()) assert.ok(!output.includes(name) && !output.includes(JSON.stringify(name).slice(1, -1)), `leaked ${JSON.stringify(name)}: ${output}`);
		}
		for (const output of [show.text, diff.text]) assert.match(output, /PUBLIC-CONTENT/);
	});
}

// ---------------------------------------------------------------------------
// tail / offset / resume
// ---------------------------------------------------------------------------

test("tail: complete lines only, ids are byte offsets past each newline, partial line waits", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, '{"a":1}\n{"b":"é"}\n{"c":');
	const first = readLines(file, 0);
	assert.deepEqual(
		first.lines.map((line) => line.text),
		['{"a":1}', '{"b":"é"}'],
	);
	assert.equal(first.lines[0]?.id, 8);
	assert.equal(first.lines[1]?.id, 8 + Buffer.byteLength('{"b":"é"}\n'));
	assert.equal(first.offset, first.lines[1]?.id, "the partial line is not consumed");

	appendFileSync(file, "3}\n");
	const second = readLines(file, first.offset);
	assert.deepEqual(
		second.lines.map((line) => line.text),
		['{"c":3}'],
	);
	assert.equal(readLines(file, second.offset).lines.length, 0);
});

test("tail: a file that shrank below the offset restarts at 0 and says reset", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, "x\n");
	const chunk = readLines(file, 500);
	assert.equal(chunk.reset, true);
	assert.deepEqual(
		chunk.lines.map((line) => line.text),
		["x"],
	);
	assert.deepEqual(readLines(join(scratch(t), "missing.jsonl"), 0), { lines: [], offset: 0, reset: false });
});

test("resume: Last-Event-ID on a line boundary resumes there; garbage, mid-line or past-end does not", (t) => {
	const file = join(scratch(t), "s.jsonl");
	writeFileSync(file, "aaaa\nbbbb\ncccc\n");
	assert.deepEqual(startOffset(file, "5"), { offset: 5, reset: false });
	assert.deepEqual(startOffset(file, "0"), { offset: 0, reset: false });
	// A supplied id that is rejected starts over AND says reset, so the client clears.
	assert.deepEqual(startOffset(file, "7"), { offset: 0, reset: true }, "mid-line id is not a resume point");
	assert.deepEqual(startOffset(file, "9999"), { offset: 0, reset: true }, "past EOF: rotated or replaced");
	assert.deepEqual(startOffset(file, "-1"), { offset: 0, reset: true });
	assert.deepEqual(startOffset(file, "5; drop"), { offset: 0, reset: true });
	assert.deepEqual(startOffset(file, undefined), { offset: 0, reset: false }, "a fresh connection is not a reset");
	assert.deepEqual(startOffset(file, ""), { offset: 0, reset: false });
	assert.deepEqual(startOffset(join(scratch(t), "gone.jsonl"), "5"), { offset: 0, reset: true });
	// Resuming at the id of line 1 yields exactly the lines after it.
	assert.deepEqual(
		readLines(file, startOffset(file, "5").offset).lines.map((line) => line.text),
		["bbbb", "cccc"],
	);
	// A fresh connection on a big file starts at a line boundary inside the backlog.
	assert.deepEqual(startOffset(file, undefined, 7), { offset: 10, reset: false });
	assert.deepEqual(startOffset(file, "7", 7), { offset: 10, reset: true });
});

// ---------------------------------------------------------------------------
// worker list from fleet + run records
// ---------------------------------------------------------------------------

const PARENT: SessionRow = { id: "cp-parent", kind: "parent", live: false };

function job(id: string, phase: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		job_id: id,
		project: "demo",
		phase,
		dispatched_at: `2026-09-01T00:00:0${id.length % 10}Z`,
		worker: { role: "implementer", profile: "implementer", model: "fleet-model", session_file: `/x/${id}.jsonl` },
		...extra,
	};
}

test("sidebar: active workers in dispatch order, finished ones newest-first and capped", () => {
	const jobs = [
		job("cp-b", "held", { dispatched_at: "2026-09-01T00:00:02Z" }),
		job("cp-a", "waiting", { dispatched_at: "2026-09-01T00:00:01Z" }),
		...Array.from({ length: 12 }, (_, i) =>
			job(`cp-done${i}`, i % 2 ? "done" : "failed", { closed_at: `2026-09-02T00:00:${String(i).padStart(2, "0")}Z` }),
		),
		{ job_id: "../evil", phase: "waiting", worker: {} },
		"not an object",
	];
	const status = (id: string) =>
		id === "cp-a"
			? { phase: "working", model: "status-model", profile: "planner", usage: { cost_usd: 1.25 }, last_activity_at: "2026-09-01T01:00:00Z" }
			: id === "cp-b"
				? { phase: "idle" }
				: undefined;
	const view = deriveSidebar(jobs as Record<string, unknown>[], status, PARENT);
	assert.equal(view.parent.id, "cp-parent");
	assert.deepEqual(
		view.active.map((row) => row.id),
		["cp-a", "cp-b"],
	);
	const a = view.active[0] as SessionRow;
	assert.equal(a.project, "demo");
	assert.equal(a.role, "implementer");
	assert.equal(a.model, "status-model", "status.json wins over the fleet's dispatch-time model");
	assert.equal(a.profile, "planner");
	assert.equal(a.cost_usd, 1.25);
	assert.equal(a.live, true);
	assert.equal(a.last_activity, "2026-09-01T01:00:00Z");
	assert.equal(view.active[1]?.live, false, "idle is not live");
	assert.equal(view.recent.length, 10);
	assert.equal(view.recent[0]?.id, "cp-done11");
	assert.ok(view.recent.every((row) => !row.live));
});

test("sidebar: read from a home's one state dir, <home>/.pi-command-post/state (cp-u3i2)", (t) => {
	const home = scratch(t);
	const state = join(home, ".pi-command-post", "state");
	mkdirSync(join(state, "runs", "cp-a"), { recursive: true });
	writeFileSync(join(state, "fleet.json"), JSON.stringify({ jobs: [job("cp-a", "waiting")] }));
	writeFileSync(join(state, "runs", "cp-a", "status.json"), JSON.stringify({ phase: "starting", usage: { cost_usd: 0.5 } }));
	// A top-level state/ holding a fleet is no candidate: there is exactly one state dir.
	mkdirSync(join(home, "state"), { recursive: true });
	writeFileSync(join(home, "state", "fleet.json"), JSON.stringify({ jobs: [] }));
	assert.equal(resolveStateDir(home), state);
	const view = sidebar({ home, stateDir: state });
	assert.equal(view.active[0]?.cost_usd, 0.5);
	assert.equal(view.parent.live, false, "no parent transcript yet");
	// A corrupt fleet is an empty list, not a crash.
	writeFileSync(join(state, "fleet.json"), "{nope");
	assert.deepEqual(sidebar({ home, stateDir: state }).active, []);
});

// ---------------------------------------------------------------------------
// path traversal
// ---------------------------------------------------------------------------

function home(t: { after(fn: () => void): void }): ViewerOptions {
	const dir = scratch(t);
	const state = join(dir, LAYOUT.state);
	mkdirSync(join(state, "sessions"), { recursive: true });
	mkdirSync(join(state, "runs", "cp-a"), { recursive: true });
	writeFileSync(join(state, "sessions", "cp-parent.jsonl"), '{"type":"session","timestamp":"t0"}\n');
	writeFileSync(join(state, "sessions", "a.jsonl"), '{"type":"session","timestamp":"t1"}\n{"type":"session","timestamp":"t2"}\n');
	writeFileSync(join(dir, "secret.jsonl"), "{}\n");
	symlinkSync(join(dir, "secret.jsonl"), join(state, "sessions", "link.jsonl"));
	writeFileSync(
		join(state, "fleet.json"),
		JSON.stringify({
			jobs: [
				job("cp-a", "waiting", { worker: { session_file: join(state, "sessions", "a.jsonl") } }),
				job("cp-out", "waiting", { worker: { session_file: join(dir, "secret.jsonl") } }),
				job("cp-dots", "waiting", { worker: { session_file: join(state, "sessions", "..", "..", "secret.jsonl") } }),
				job("cp-link", "waiting", { worker: { session_file: join(state, "sessions", "link.jsonl") } }),
				job("cp-passwd", "waiting", { worker: { session_file: "/etc/passwd" } }),
			],
		}),
	);
	return { home: dir, stateDir: state, host: "127.0.0.1", port: 0 };
}

test("traversal: only known sessions inside state/sessions resolve", (t) => {
	const state = home(t);
	assert.ok(resolveSessionFile(state, "cp-parent")?.endsWith("cp-parent.jsonl"));
	assert.ok(resolveSessionFile(state, "cp-a")?.endsWith("a.jsonl"));
	for (const id of ["cp-out", "cp-dots", "cp-link", "cp-passwd", "../secret", "..", "cp-a/../x", "", "cp-unknown", "/etc/passwd"]) {
		assert.equal(resolveSessionFile(state, id), undefined, id);
	}
});

test("script jobs have no model session or transcript link", (t) => {
 const state = home(t);
 const fleetFile = join(state.stateDir, "fleet.json");
 const fleet = JSON.parse(readFileSync(fleetFile, "utf8"));
 fleet.jobs.push(job("cp-script", "waiting", { executor: "script", script_path: "scripts/run.sh", worker: undefined }));
 writeFileSync(fleetFile, JSON.stringify(fleet));
 mkdirSync(join(state.stateDir, "runs", "cp-script"), { recursive: true });
 writeFileSync(join(state.stateDir, "runs", "cp-script", "status.json"), JSON.stringify({ phase: "working", session_file: join(state.stateDir, "sessions", "a.jsonl") }));
 assert.equal(resolveSessionFile(state, "cp-script"), undefined);
 assert.ok(!sidebar(state).active.some((row) => row.id === "cp-script"));
});

// ---------------------------------------------------------------------------
// host bind, and the server end to end
// ---------------------------------------------------------------------------

test("host bind: only the exact configured host:port is accepted", () => {
	assert.equal(hostAllowed("100.64.0.1:8766", "100.64.0.1", 8766), true);
	assert.equal(hostAllowed("100.64.0.1:8767", "100.64.0.1", 8766), false);
	assert.equal(hostAllowed("evil.example:8766", "100.64.0.1", 8766), false);
	assert.equal(hostAllowed("localhost:8766", "127.0.0.1", 8766), false);
	assert.equal(hostAllowed(undefined, "127.0.0.1", 8766), false);
	assert.equal(hostAllowed("[::1]:8766", "::1", 8766), true);
	assert.equal(hostAllowed("box", "box", 80), true);
});

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Reply> {
	return new Promise((resolvePromise, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				body += chunk;
			});
			const done = (): void => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body });
			res.on("end", done);
		});
		req.on("error", reject);
		req.end();
	});
}

test("server: host check, GET-only, and no arbitrary paths", async (t) => {
	const options = home(t);
	const server = createViewer(options);
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const port = options.port;

	assert.equal((await get(port, "/", { host: "evil.example" })).status, 421);
	assert.equal((await get(port, "/", {}, "POST")).status, 405);
	assert.equal((await get(port, "/state/fleet.json")).status, 404);
	assert.equal((await get(port, "/api/stream?id=..%2F..%2Fsecret")).status, 404);
	assert.equal((await get(port, "/api/stream?id=cp-out")).status, 404);

	const list = JSON.parse((await get(port, "/api/sessions")).body) as { active: SessionRow[] };
	assert.ok(list.active.some((row) => row.id === "cp-a"));
});

test("default host: interactive falls back to 127.0.0.1; with --require-tailnet (bin/cp-operator) no tailnet IP is a refusal", () => {
	assert.equal(defaultHost(() => "100.64.0.7"), "100.64.0.7");
	assert.equal(defaultHost(() => "100.64.0.7", true), "100.64.0.7");
	assert.equal(defaultHost(() => undefined), "127.0.0.1");
	assert.throws(() => defaultHost(() => undefined, true), /require-tailnet/);
	assert.throws(() => defaultHost(() => undefined, true), /tailscale ip -4.*--viewer-host/);
});

test("cli: under --require-tailnet a wildcard, public or non-IP host is refused before anything binds", () => {
	for (const host of ["0.0.0.0", "8.8.8.8", "localhost"]) {
		const result = spawnSync(process.execPath, [join(REPO_ROOT, "src", "viewer", "cli.ts"), "--require-tailnet", "--host", host, "--port", "1", "--home", tmpdir()], { encoding: "utf8", timeout: 30_000 });
		assert.notEqual(result.status, 0, host);
		assert.match(result.stderr, new RegExp(`refusing to serve dashboard controls on ${host.replace(/\./g, "\\.")}`), result.stderr);
	}
});

test("cli: --require-tailnet without a tailnet address exits non-zero instead of serving on loopback", () => {
	const result = spawnSync(process.execPath, [join(REPO_ROOT, "src", "viewer", "cli.ts"), "--require-tailnet", "--port", "1", "--home", tmpdir()], {
		encoding: "utf8",
		env: { ...process.env, PATH: "/nonexistent" },
		timeout: 30_000,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /require-tailnet/);
});
