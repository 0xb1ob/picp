/**
 * Restart session (cp-aqxl), the launcher half end to end: `runOperator` (bin/cp-operator) relaunches pi only when
 * the exited child left a marker naming its own pid, with exactly `--session <file>` (`-c` when the file is gone),
 * never a `--model`, and stops after the cap. Real child processes (tests/fixtures/fake-relaunch-pi.mjs); no viewer.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_BUILTIN_EXTENSIONS, runOperator } from "../src/viewer/operator.ts";
import { REPO_ROOT } from "./harness/index.ts";

const FAKE_PI = join(REPO_ROOT, "tests/fixtures/fake-relaunch-pi.mjs");
const VIEWER = { host: "127.0.0.1", port: 1 };
/** cp-fl8b: pi's built-in MCP extensions follow the bridge on every run, the relaunch included. */
const BUILTINS = OPERATOR_BUILTIN_EXTENSIONS.flatMap((entry) => ["-e", entry]);

function scratch(t: import("node:test").TestContext, mode: string, sessionExists = true) {
	const dir = mkdtempSync(join(tmpdir(), "cp-relaunch-"));
	const session = join(dir, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
	if (sessionExists) writeFileSync(session, "");
	const env = { CP_OPERATOR_VIEWER: "service", CP_OPERATOR_WEB: "0", CP_OPERATOR_MODEL: "test-model", FAKE_RELAUNCH_LOG: join(dir, "argv.log"), FAKE_RELAUNCH_MODE: mode, FAKE_RELAUNCH_SESSION: session };
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(dir, { recursive: true, force: true });
	});
	const runs = () => readFileSync(env.FAKE_RELAUNCH_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
	return { dir, session, relaunchFile: join(dir, "relaunch.json"), runs };
}

function stderrLines(t: import("node:test").TestContext): string[] {
	const lines: string[] = [];
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
	t.after(() => { process.stderr.write = write; });
	return lines;
}

test("a marker naming the exited child: relaunched once with exactly --session <file> (no --model), the second exit code returned, the marker consumed", async (t) => {
	const { session, relaunchFile, runs } = scratch(t, "once");
	const lines = stderrLines(t);
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: VIEWER, relaunchFile }), 2);
	assert.deepEqual(runs(), [[...BUILTINS, "--model", "test-model"], [...BUILTINS, "--session", session]], "the wrapper's model on the first run only; the resumed session keeps its own");
	assert.equal(existsSync(relaunchFile), false, "the launcher removed the marker it took");
	assert.ok(lines.some((line) => line === `cp-operator: restarting from the dashboard, resuming ${session}\n`), lines.join(""));
});

test("a marker for another pid: no relaunch, pi's exit code, the marker left in place (inert)", async (t) => {
	const { relaunchFile, runs } = scratch(t, "other");
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: VIEWER, relaunchFile }), 0);
	assert.equal(runs().length, 1);
	assert.equal(existsSync(relaunchFile), true);
});

test("no marker: pi runs once and its exit code comes back, exactly as before", async (t) => {
	const { relaunchFile, runs } = scratch(t, "never");
	assert.equal(await runOperator(["--model", "x"], { piBin: FAKE_PI, viewer: VIEWER, relaunchFile }), 1);
	assert.deepEqual(runs(), [[...BUILTINS, "--model", "x"]]);
});

test("the session file is gone: the relaunch falls back to -c", async (t) => {
	const { session, relaunchFile, runs } = scratch(t, "once", false);
	const lines = stderrLines(t);
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: VIEWER, relaunchFile }), 2);
	assert.deepEqual(runs()[1], [...BUILTINS, "-c"]);
	assert.ok(lines.some((line) => line.includes(`${session} is gone, continuing the most recent session (-c)`)), lines.join(""));
});

test("cap: a marker on every exit relaunches at most `count` times in the window, then stops with one line", async (t) => {
	const { session, relaunchFile, runs } = scratch(t, "always");
	const lines = stderrLines(t);
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: VIEWER, relaunchFile, relaunchLimit: { count: 2, windowMs: 600_000 } }), 0);
	assert.equal(runs().length, 3, "the first run plus two relaunches");
	assert.ok(lines.some((line) => line.startsWith(`cp-operator: not restarting: 2 restarts within 10 min; resume by hand: cp-operator --session ${session}`)), lines.join(""));
});
