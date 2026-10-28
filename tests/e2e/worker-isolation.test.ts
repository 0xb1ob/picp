/**
 * #576: a worker runs in its own memory-capped systemd scope (systemd backend only, never failing a spawn), and a
 * SIGKILLed test runner leaks no dashboard viewer. `systemd-run` is a scratch stub on PATH; the host is never touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { childEnv, type DaemonConfig } from "../../src/service/daemon-files.ts";
import { WorkerProcess } from "../../src/worker-process.ts";
import { until } from "../harness/dashboard.ts";
import { REPO_ROOT } from "../harness/index.ts";

const FAKE_WORKER = resolve(REPO_ROOT, "tests/fixtures/fake-entries-worker.mjs");

/** A PATH whose `systemd-run` logs its argv and execs the command after `--`; `broken` makes every call fail. */
function fakeSystemdRun(t: TestContext, broken = false) {
	const dir = mkdtempSync(join(tmpdir(), "cp-576-bin-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	writeFileSync(join(dir, "systemd-run"), `#!/bin/sh\necho "$*" >> "${log}"\n${broken ? "exit 1\n" : ""}while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
	return { PATH: `${dir}:${process.env.PATH}`, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

async function runWorker(t: TestContext, env: NodeJS.ProcessEnv, jobId: string) {
	const worker = WorkerProcess.spawn({ cwd: process.cwd(), model: "mock/irrelevant", piBin: FAKE_WORKER, env, jobId });
	t.after(() => worker.shutdown());
	assert.equal((await worker.getEntries(undefined, 10_000)).leafId, "e-499", "the worker answers through its scope");
}

const config = (extra: Partial<DaemonConfig>): DaemonConfig => ({ schema_version: 1, generated_by: "cp-install", backend: "systemd", node: "/n", app: "/a", home: "/h", path: "/bin", port: 1, ...extra });

test("#576 scope: a worker on the systemd backend runs under systemd-run with MemoryMax, probed once", { timeout: 30_000 }, async (t) => {
	const bin = fakeSystemdRun(t);
	const job = `cp-576-${randomBytes(3).toString("hex")}`;
	await runWorker(t, { PATH: bin.PATH, CP_WORKER_MEMORY_MAX: "6G" }, job);
	await runWorker(t, { PATH: bin.PATH, CP_WORKER_MEMORY_MAX: "6G" }, job);
	const [probe, ...spawns] = bin.calls();
	assert.equal(probe, "--user --scope --quiet --collect -- true");
	assert.equal(spawns.length, 2, `one probe per process, then one scope per worker: ${bin.calls().join(" | ")}`);
	for (const line of spawns) {
		assert.match(line, new RegExp(`^--user --scope --quiet --collect --unit=cp-worker-${job}-[0-9a-f]{6} -p MemoryMax=6G -p MemorySwapMax=0 -- ${FAKE_WORKER} --mode rpc `));
	}
	assert.notEqual(spawns[0]!.split(" ")[4], spawns[1]!.split(" ")[4], "every worker gets its own unit name");
});

test("#576 scope: when systemd-run cannot start a scope the worker spawns unscoped and it is logged once", { timeout: 30_000 }, async (t) => {
	const bin = fakeSystemdRun(t, true);
	const warn = t.mock.method(console, "warn", () => {});
	await runWorker(t, { PATH: bin.PATH, CP_WORKER_MEMORY_MAX: "6G" }, "cp-576-fallback");
	await runWorker(t, { PATH: bin.PATH, CP_WORKER_MEMORY_MAX: "6G" }, "cp-576-fallback");
	assert.deepEqual(bin.calls(), ["--user --scope --quiet --collect -- true"], "only the probe ran");
	assert.equal(warn.mock.callCount(), 1);
	assert.match(String(warn.mock.calls[0]!.arguments[0]), /workers run unscoped, without MemoryMax=6G/);
});

test("#576 scope: the detached backend asks for no scope, so workers spawn exactly as before", { timeout: 30_000 }, async (t) => {
	assert.equal(childEnv(config({ backend: "detached" }), "parent", {}).CP_WORKER_MEMORY_MAX, undefined);
	assert.equal(childEnv(config({}), "parent", {}).CP_WORKER_MEMORY_MAX, "6G", "systemd defaults to 6G");
	assert.equal(childEnv(config({ worker_memory_max: "2G" }), "parent", {}).CP_WORKER_MEMORY_MAX, "2G");
	assert.equal(childEnv(config({}), "viewer", {}).CP_WORKER_MEMORY_MAX, undefined, "only the parent spawns workers");
	const bin = fakeSystemdRun(t);
	await runWorker(t, { PATH: bin.PATH, CP_WORKER_MEMORY_MAX: "" }, "cp-576-detached");
	assert.deepEqual(bin.calls(), [], "systemd-run never ran");
});

test("#576 lifeline: a SIGKILLed test runner leaves no dashboard viewer behind", { timeout: 90_000 }, async (t) => {
	const harness = pathToFileURL(join(REPO_ROOT, "tests/harness/dashboard.ts")).href;
	const code = `const { dashboard } = await import(${JSON.stringify(harness)});\nconst d = await dashboard({ after() {} });\nconsole.log(JSON.stringify({ pid: d.pid, home: d.home }));\nsetInterval(() => {}, 60_000);\n`;
	const runner = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	runner.stdout.on("data", (chunk) => (out += chunk));
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const line = await until(() => out, (text) => text.includes("\n"), "the runner's viewer", 60_000);
	const { pid, home } = JSON.parse(line) as { pid: number; home: string };
	t.after(() => {
		if (alive(pid)) process.kill(pid, "SIGKILL");
		rmSync(home, { recursive: true, force: true });
	});
	assert.equal(alive(pid), true, "the viewer serves while its runner lives");
	runner.kill("SIGKILL");
	await until(() => alive(pid), (up) => !up, `viewer pid ${pid} to exit after its runner was SIGKILLed`, 20_000);
});
