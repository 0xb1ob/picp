/**
 * Guard for pi-command-post-6wn: the real ~/.pi operator-target selector must
 * never be touched by the suite. `tests/harness/hermetic-env.ts` (preloaded via
 * `--import` for every test process) forces PI_HOME to a scratch dir before any
 * test runs, so a call that forgets to pass its own env still lands off the
 * real home — and it snapshots the real selector at preload and fails the whole
 * process on exit if that snapshot ever changes.
 *
 * This file additionally exercises the real save path with no explicit env
 * (the shape that leaked before the fix) and asserts the real selector is
 * byte- and mtime-identical to its pre-call state.
 */
import "./harness/hermetic-env.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { operatorTargetFile, saveOperatorTarget } from "../extensions/cp-bridge/index.ts";

const REAL_SELECTOR = resolve(homedir(), ".pi", "command-post", "operator-targets", "selected.json");

function snapshot(): { existed: boolean; content?: string; mtimeMs?: number } {
	if (!existsSync(REAL_SELECTOR)) return { existed: false };
	return { existed: true, content: readFileSync(REAL_SELECTOR, "utf8"), mtimeMs: statSync(REAL_SELECTOR).mtimeMs };
}

test("operator-target paths never resolve under the real ~/.pi during tests", () => {
	const realRoot = resolve(homedir(), ".pi");
	assert.notEqual(resolve(process.env.PI_HOME ?? ""), realRoot, "PI_HOME must not be the real ~/.pi in a test process");
	const resolved = operatorTargetFile("/tmp/example-operator-home");
	assert.ok(!resolved.startsWith(`${realRoot}/`), `operator target file resolved under the real home: ${resolved}`);
});

test("saving an operator target through the real save path, with no explicit env, never touches the real selector", () => {
	const before = snapshot();
	saveOperatorTarget({ home: "/tmp/example-operator-home-2", mode: "multi", hostPid: process.pid, parentPid: process.pid });
	const after = snapshot();
	assert.deepEqual(after, before, "the real ~/.pi operator-target selector changed as a side effect of a test's save call");
});

// The leak that survived the preload: a test file run as bare `node --test <file>`, without
// `--import ./tests/harness/hermetic-env.ts`, had no scratch PI_HOME. The harness now imports
// the preload itself. The child runs with HOME pointed at a scratch dir, so a regression lands
// there and never in the operator's real ~/.pi.
test("without the --import preload, a process that loads the harness still saves operator targets off $HOME/.pi", (t) => {
	const fakeHome = mkdtempSync(join(tmpdir(), "cp-fake-user-home-"));
	t.after(() => rmSync(fakeHome, { recursive: true, force: true }));
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
	delete env.PI_HOME;
	const harness = pathToFileURL(resolve(import.meta.dirname, "harness", "index.ts")).href;
	const bridge = pathToFileURL(resolve(import.meta.dirname, "..", "extensions", "cp-bridge", "index.ts")).href;
	const script = `await import(${JSON.stringify(harness)}); const { saveOperatorTarget } = await import(${JSON.stringify(bridge)}); saveOperatorTarget({ home: "/tmp/example-operator-home-3", mode: "multi", hostPid: 1, parentPid: 1 }); process.exit(0);`;
	const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
	assert.equal(run.status, 0, run.stderr);
	assert.ok(!existsSync(join(fakeHome, ".pi")), `a bare run wrote under $HOME/.pi: ${join(fakeHome, ".pi")}`);
});
