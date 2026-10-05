/**
 * bin/cp-operator's viewer lifecycle (src/viewer/operator.ts): the session
 * starts the viewer, reuses one already on the port without ever killing it,
 * and stops the one it started when the session exits — on SIGINT, SIGTERM
 * and SIGHUP too.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_BUILTIN_EXTENSIONS, OPERATOR_SIGNALS, operatorModelArgs, operatorWeb, portInUse, runOperator, startViewer } from "../src/viewer/operator.ts";
import { REPO_ROOT } from "./harness/index.ts";
import { createViewer } from "../src/viewer/server.ts";
import { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../src/contracts.ts";

/** cp-fl8b: pi's built-in MCP, codemode and tool search follow the bridge on every operator run. */
const BUILTINS = OPERATOR_BUILTIN_EXTENSIONS.flatMap((entry) => ["-e", entry]);
const FAKE_PI = join(REPO_ROOT, "tests/fixtures/fake-operator-pi.mjs");
const FAKE_VIEWER = join(REPO_ROOT, "tests/fixtures/fake-viewer.mjs");

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/**
 * A zombie is not alive. A viewer that outlives its launcher is reparented to
 * PID 1, and a container whose PID 1 never reaps (the Nomad CI runner's is
 * `timeout`) leaves it a zombie forever, which `kill(pid, 0)` still finds.
 * A zombie leader with threads still running (`Threads:` > 1) is still
 * exiting and may hold its port, so it counts as alive.
 */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		return !(/^State:\s+Z/m.test(status) && /^Threads:\s+1$/m.test(status));
	} catch {
		return true; // no procfs: kill(pid, 0) is all there is
	}
}

/** Re-check until `check` holds; allow the test runner's 300s CI budget under load. */
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 300_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** The viewer's pid once the file holds one: existsSync alone can see the file before its bytes. */
function pidIn(file: string): number | undefined {
	const pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : Number.NaN;
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

const fakeViewer = (port: number) => ({ host: "127.0.0.1", port, command: [process.execPath, FAKE_VIEWER, String(port)] });

test("start: a free port gets this session's own viewer, and stop ends it", async () => {
	const port = await freePort();
	const viewer = await startViewer(fakeViewer(port));
	assert.equal(viewer.reused, false);
	assert.equal(typeof viewer.pid, "number");
	await until("the viewer to listen", () => portInUse(port));
	viewer.stop();
	await until("the viewer to exit", () => !alive(viewer.pid as number));
	assert.equal(await portInUse(port), false);
});

test("reuse: only a viewer for the same home is reused and never killed", async (t) => {
	const port = await freePort();
	const home = mkdtempSync(join(tmpdir(), "cp-viewer-home-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const existing = createViewer({ home, stateDir: join(home, LAYOUT.state), host: "127.0.0.1", port });
	await new Promise<void>((resolve) => existing.listen(port, "127.0.0.1", resolve));
	t.after(() => existing.close());
	const options = { ...fakeViewer(port), home };
	const viewer = await startViewer(options);
	assert.deepEqual([viewer.reused, viewer.pid], [true, undefined]);
	process.env.FAKE_PI_EXIT_CODE = "0";
	t.after(() => delete process.env.FAKE_PI_EXIT_CODE);
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: options }), 0);
	const otherHome = { ...options, home: join(home, "other") };
	await assert.rejects(startViewer(otherHome), /different home|another home/);
	assert.equal(existing.listening, true, "the session did not start that viewer, so it does not stop it");
});

test("reuse: an unrelated listener is refused without stopping it", async (t) => {
	const existing = createViewer({ home: "/unused", stateDir: "/unused/state", host: "127.0.0.1", port: 1 });
	await new Promise<void>((resolve) => existing.listen(0, "127.0.0.1", resolve));
	t.after(() => existing.close());
	await assert.rejects(startViewer(fakeViewer((existing.address() as AddressInfo).port)), /cannot verify|not a viewer/);
	assert.equal(existing.listening, true);
});

test("start: passes the selected operator home explicitly, not the fallback CP_HOME", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-selected-"));
	const previous = { PI_HOME: process.env.PI_HOME, CP_HOME: process.env.CP_HOME };
	process.env.PI_HOME = dir;
	process.env.CP_HOME = join(dir, "wrong-home");
	t.after(() => {
		for (const key of ["PI_HOME", "CP_HOME"] as const) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(dir, { recursive: true, force: true });
	});
	const home = join(dir, "selected-home");
	saveOperatorTarget({ home, mode: "multi", hostPid: process.pid, parentPid: process.pid });
	const argsFile = join(dir, "argv.json");
	const viewer = await startViewer({ host: "127.0.0.1", port: await freePort(), command: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(1)))`, "--"] });
	t.after(() => viewer.stop());
	await until("viewer argv", () => existsSync(argsFile));
	assert.deepEqual(JSON.parse(readFileSync(argsFile, "utf8")), ["--home", home]);
	for (const [dir, id] of [[home, "cp-selected"], [process.env.CP_HOME!, "cp-wrong"]]) {
		mkdirSync(join(dir!, LAYOUT.state), { recursive: true });
		writeFileSync(join(dir!, LAYOUT.fleetFile), JSON.stringify({ jobs: [{ job_id: id, phase: "waiting" }] }));
	}
	// A viewer that died (say, its port was taken between freePort and bind) never listens: retry on a fresh port, then fail named, not at the 300s test budget.
	let port = 0, realViewer!: Awaited<ReturnType<typeof startViewer>>;
	for (let attempt = 1; ; attempt++) {
		port = await freePort();
		const started = realViewer = await startViewer({ host: "127.0.0.1", port });
		t.after(() => started.stop());
		try {
			await until("selected-home viewer to listen", () => {
				if (!alive(started.pid as number)) throw new Error(`the selected-home viewer (pid ${started.pid}) exited before listening on ${port}`);
				return portInUse(port);
			});
			break;
		} catch (error) {
			if (attempt >= 3 || !/exited before listening/.test(String(error))) throw error;
		}
	}
	const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { signal: AbortSignal.timeout(60_000) });
	const sessions = await response.json() as { active: Array<{ id: string }> };
	assert.deepEqual(sessions.active.map((row) => row.id), ["cp-selected"]);
	realViewer.stop();
	await until("selected-home viewer to exit", () => !alive(realViewer.pid as number));
});

test("explicit --host/--port reach the parent at the viewer's address", async (t) => {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-address-"));
	const addressFile = join(dir, "address.json");
	Object.assign(process.env, { FAKE_PI_EXIT_CODE: "0", FAKE_PI_ADDRESS_FILE: addressFile, CP_OPERATOR_WEB: "0" });
	t.after(() => {
		delete process.env.CP_OPERATOR_WEB;
		delete process.env.FAKE_PI_EXIT_CODE;
		delete process.env.FAKE_PI_ADDRESS_FILE;
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(await runOperator(["--host", "127.0.0.1", "--port", String(port), "--model", "test"], { piBin: FAKE_PI, viewer: { command: [process.execPath, FAKE_VIEWER, String(port)] } }), 0);
	assert.deepEqual(JSON.parse(readFileSync(addressFile, "utf8")), {
		host: "127.0.0.1", port: String(port), args: ["--no-extensions", "-e", join(REPO_ROOT, "extensions/cp-bridge/index.ts"), ...BUILTINS, "--model", "test"],
	});
});

test("without --host, the operator uses the tailnet address for parent board links", async (t) => {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-tailnet-"));
	const addressFile = join(dir, "address.json");
	const tailscale = join(dir, "tailscale");
	writeFileSync(tailscale, "#!/bin/sh\nprintf '100.101.102.103\\n'\n");
	chmodSync(tailscale, 0o755);
	const previous = { PATH: process.env.PATH, CP_VIEWER_HOST: process.env.CP_VIEWER_HOST };
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	delete process.env.CP_VIEWER_HOST;
	Object.assign(process.env, { FAKE_PI_EXIT_CODE: "0", FAKE_PI_ADDRESS_FILE: addressFile, CP_OPERATOR_WEB: "0" });
	t.after(() => {
		for (const key of ["PATH", "CP_VIEWER_HOST"] as const) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		delete process.env.CP_OPERATOR_WEB;
		delete process.env.FAKE_PI_EXIT_CODE;
		delete process.env.FAKE_PI_ADDRESS_FILE;
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: { port, command: [process.execPath, FAKE_VIEWER, String(port)] } }), 0);
	assert.deepEqual(JSON.parse(readFileSync(addressFile, "utf8")), {
		host: "100.101.102.103", port: String(port), args: ["--no-extensions", "-e", join(REPO_ROOT, "extensions/cp-bridge/index.ts"), ...BUILTINS],
	});
	rmSync(tailscale);
	process.env.PATH = dir;
	await assert.rejects(runOperator([], { piBin: FAKE_PI, viewer: { port, command: [process.execPath, FAKE_VIEWER, String(port)] } }), /require-tailnet/);
	const viewer = await startViewer({ port });
	t.after(() => viewer.stop());
	await until("cp-view to reject the missing tailnet address", () => !alive(viewer.pid as number));
	assert.equal(await portInUse(port), false);
});

test("stop-on-exit: the session's exit code comes back and the viewer it started is gone", async (t) => {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-"));
	const pidFile = join(dir, "viewer.pid");
	Object.assign(process.env, { FAKE_PI_EXIT_CODE: "3", FAKE_PI_WAIT_FOR: pidFile, FAKE_VIEWER_PIDFILE: pidFile });
	t.after(() => {
		for (const key of ["FAKE_PI_EXIT_CODE", "FAKE_PI_WAIT_FOR", "FAKE_VIEWER_PIDFILE"]) delete process.env[key];
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: fakeViewer(port) }), 3);
	await until("the viewer's pid", () => pidIn(pidFile) !== undefined);
	const pid = pidIn(pidFile) as number;
	await until("the viewer to exit", () => !alive(pid));
});

test("CP_OPERATOR_VIEWER=service: cp-view.service serves the dashboard, so the session starts no viewer of its own", async (t) => {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-service-"));
	const pidFile = join(dir, "viewer.pid");
	Object.assign(process.env, { FAKE_PI_EXIT_CODE: "0", FAKE_VIEWER_PIDFILE: pidFile, CP_OPERATOR_VIEWER: "service" });
	t.after(() => {
		for (const key of ["FAKE_PI_EXIT_CODE", "FAKE_VIEWER_PIDFILE", "CP_OPERATOR_VIEWER"]) delete process.env[key];
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(await runOperator([], { piBin: FAKE_PI, viewer: fakeViewer(port) }), 0);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(existsSync(pidFile), false, "no session viewer was spawned");
	assert.equal(await portInUse(port), false);
});

for (const signal of OPERATOR_SIGNALS) {
	test(`stop-on-exit: ${signal} to the launcher ends the session and the viewer it started`, async (t) => {
		const port = await freePort();
		const dir = mkdtempSync(join(tmpdir(), "cp-operator-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const pidFile = join(dir, "viewer.pid");
		const driver = join(dir, "driver.mjs");
		writeFileSync(
			driver,
			`import { runOperator } from ${JSON.stringify(join(REPO_ROOT, "src/viewer/operator.ts"))};\n` +
				`const code = await runOperator([], { piBin: ${JSON.stringify(FAKE_PI)}, viewer: ${JSON.stringify(fakeViewer(port))} });\n` +
				"process.exit(code);\n",
		);
		const env: NodeJS.ProcessEnv = { ...process.env, FAKE_VIEWER_PIDFILE: pidFile };
		delete env.FAKE_PI_EXIT_CODE;
		const launcher = spawn(process.execPath, [driver], { env, stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => launcher.once("exit", (code) => resolve(code)));
		t.after(() => launcher.kill("SIGKILL"));
		await until("the viewer to write its pid", () => pidIn(pidFile) !== undefined);
		const pid = pidIn(pidFile) as number;
		assert.equal(alive(pid), true);
		launcher.kill(signal);
		assert.notEqual(await exited, 0, "a session ended by a signal does not report success");
		await until("the viewer to exit", () => !alive(pid));
	});
}

test("operatorWeb: installed package gives its extension; missing, withheld or failed gives a status line; CP_OPERATOR_WEB=0 is silent", async () => {
	const installed = { packages: { "pi-web-access": { extensions: ["/pkg/web/index.ts"], skills: [] } } };
	assert.deepEqual(await operatorWeb({}, async () => installed), { extensions: ["/pkg/web/index.ts"] });
	assert.match((await operatorWeb({}, async () => ({ packages: {} }))).status ?? "", /pi-web-access is not installed/);
	// A detected package without an extension entrypoint (skills only) adds no -e.
	assert.deepEqual(await operatorWeb({}, async () => ({ packages: { "pi-web-access": { extensions: [], skills: ["/pkg/web/skills/x"] } } })).then((r) => r.extensions), []);
	assert.match((await operatorWeb({}, async () => ({ packages: {}, withheld: { "pi-web-access": "no provider" } }))).status ?? "", /no provider/);
	assert.match((await operatorWeb({}, async () => ({ packages: {}, error: "boom" }))).status ?? "", /boom/);
	assert.deepEqual(await operatorWeb({ CP_OPERATOR_WEB: "0" }, async () => installed), { extensions: [] });
});

test("operatorModelArgs: the wrapper's CP_OPERATOR_MODEL becomes --model, never over an explicit model flag or a resumed session", () => {
	const env = { CP_OPERATOR_MODEL: "a/b" };
	assert.deepEqual(operatorModelArgs([], env), ["--model", "a/b"]);
	assert.deepEqual(operatorModelArgs(["--thinking", "high"], env), ["--model", "a/b", "--thinking", "high"]);
	for (const argv of [["--model", "x"], ["--model=x"], ["--models", "x"], ["--provider", "p"], ["-c"], ["--continue"], ["-r"], ["--resume"], ["--session", "s"], ["--session=s"], ["--session-id", "i"], ["--fork", "f"]]) {
		assert.deepEqual(operatorModelArgs(argv, env), argv, argv.join(" "));
	}
	assert.deepEqual(operatorModelArgs(["-c"], {}), ["-c"]);
	assert.deepEqual(operatorModelArgs([], { CP_OPERATOR_MODEL: " " }), [], "blank is unset");
});
