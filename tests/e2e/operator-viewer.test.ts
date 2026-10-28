/**
 * P17b, behavior 17: bin/cp-operator as the operator runs it — a real launcher process, a fake `pi` on PATH that
 * records its argv and env, and the real viewer it starts, reuses or leaves to the service.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { saveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { LAYOUT } from "../../src/contracts.ts";
import { atomicWrite, daemonPaths } from "../../src/service/daemon-files.ts";
import { tunnelConfigFile } from "../../src/service/daemon-tunnel-files.ts";
import { OPERATOR_BUILTIN_EXTENSIONS, OPERATOR_SIGNALS, portInUse } from "../../src/viewer/operator.ts";
import { dashboard, until } from "../harness/dashboard.ts";
import { REPO_ROOT } from "../harness/index.ts";
import { configure, flagValues, installPackage } from "../harness/package-home.ts";

const BRIDGE = join(REPO_ROOT, "extensions/cp-bridge/index.ts");
const PREFIX = ["--no-extensions", "--no-skills", "-e", BRIDGE, ...OPERATOR_BUILTIN_EXTENSIONS.flatMap((entry) => ["-e", entry])];
/** The operator's `pi`: one JSON line per run (argv, viewer address, web status, live viewers on its port). */
const FAKE_PI = `#!/usr/bin/env node
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
const port = process.env.CP_VIEWER_PORT;
const viewers = readdirSync("/proc").filter((pid) => /^\\d+$/.test(pid)).filter((pid) => {
	try { const argv = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0"); return argv.some((a) => a.endsWith("src/viewer/cli.ts")) && argv.includes(port); }
	catch { return false; }
}).length;
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), host: process.env.CP_VIEWER_HOST ?? null, port, web: process.env.CP_OPERATOR_WEB_STATUS, viewers }) + "\\n");
const code = process.env.FAKE_PI_EXIT_CODE, gate = process.env.FAKE_PI_WAIT_FOR;
setInterval(() => { if (code !== undefined && (!gate || existsSync(gate))) process.exit(Number(code)); }, 25);
`;
type Run = { args: string[]; host: string | null; port: string; web: string; viewers: number };

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	await new Promise((done) => server.close(done));
	return port;
}

/** A scratch operator: PATH holds only node, the fake pi and (optionally) tailscale; `home` is the selected home. */
function operator(t: TestContext, home?: string) {
	const dir = mkdtempSync(join(tmpdir(), "cp-operator-e2e-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin"), agent = join(dir, "agent"), log = join(dir, "pi.jsonl");
	mkdirSync(bin);
	mkdirSync(agent);
	symlinkSync(process.execPath, join(bin, "node"));
	symlinkSync(execFileSync("sh", ["-c", "command -v dirname"], { encoding: "utf8" }).trim(), join(bin, "dirname")); // bin/cp-operator's own
	writeFileSync(join(bin, "pi"), FAKE_PI);
	chmodSync(join(bin, "pi"), 0o755);
	const selected = home ?? join(dir, "selected-home");
	const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, HOME: dir, PI_HOME: join(dir, "pi-home"), PI_CODING_AGENT_DIR: agent,
		CP_HOME: join(dir, "wrong-home"), CP_OPERATOR_WEB: "0", FAKE_LOG: log };
	for (const key of ["CP_VIEWER_HOST", "CP_VIEWER_PORT", "CP_OPERATOR_VIEWER", "CP_OPERATOR_MODEL", "FAKE_PI_EXIT_CODE", "FAKE_PI_WAIT_FOR"]) delete env[key];
	saveOperatorTarget({ home: selected, mode: "multi", hostPid: process.pid, parentPid: process.pid }, env);
	const children: ChildProcess[] = [];
	t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
	return {
		dir, bin, agent, home: selected, env,
		tailscale: (ip: string | null) => {
			if (ip === null) return rmSync(join(bin, "tailscale"), { force: true });
			writeFileSync(join(bin, "tailscale"), `#!/bin/sh\nprintf '${ip}\\n'\n`);
			chmodSync(join(bin, "tailscale"), 0o755);
		},
		/** `bin/cp-operator <argv>`: its exit, stderr, and every pi run it made. */
		start(argv: string[], extra: NodeJS.ProcessEnv = {}) {
			const child = spawn(join(REPO_ROOT, "bin/cp-operator"), argv, { env: { ...env, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
			children.push(child);
			let stderr = "";
			child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
			// `exit` is the launcher's own; `close` also waits for stdio, which an orphaned pi would hold open forever.
			const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
			const closed = new Promise<void>((done) => child.once("close", () => done()));
			return { child, exit, closed, stderr: () => stderr };
		},
		runs: (): Run[] => { try { return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Run); } catch { return []; } },
	};
}

async function run(op: ReturnType<typeof operator>, argv: string[], extra: NodeJS.ProcessEnv = {}) {
	const started = op.start(argv, { FAKE_PI_EXIT_CODE: "0", ...extra });
	const exit = await started.exit;
	await started.closed;
	return { ...exit, stderr: started.stderr(), last: op.runs().at(-1) };
}

const freed = (port: number) => until(() => portInUse(port), (busy) => !busy, `port ${port} released`, 60_000);

test("P17-operator-viewer: cp-operator starts a viewer for the selected home, hands pi its address and skills, returns pi's exit code", { timeout: 180_000 }, async (t) => {
	const op = operator(t);
	for (const [home, id] of [[op.home, "cp-selected"], [op.env.CP_HOME!, "cp-wrong"]] as const) {
		mkdirSync(join(home, LAYOUT.state), { recursive: true });
		writeFileSync(join(home, LAYOUT.fleetFile), JSON.stringify({ jobs: [{ job_id: id, phase: "waiting" }] }));
	}
	mkdirSync(join(op.agent, "skills/brainstorming"), { recursive: true });
	writeFileSync(join(op.agent, "skills/brainstorming/SKILL.md"), "---\nname: brainstorming\n---\n");
	const port = await freePort(), gate = join(op.dir, "gate");
	const session = op.start(["--host", "127.0.0.1", "--port", String(port), "--model", "test"], { FAKE_PI_EXIT_CODE: "3", FAKE_PI_WAIT_FOR: gate });
	const sessions = await until(async () => {
		try { return (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as { active: Array<{ id: string }> }; } catch { return null; }
	}, (body) => body !== null, "the session's viewer to serve", 60_000);
	assert.deepEqual(sessions!.active.map((row) => row.id), ["cp-selected"], "the selected home, never the fallback CP_HOME");
	writeFileSync(gate, "");
	assert.deepEqual(await session.exit, { code: 3, signal: null }, "pi's exit code comes back");
	assert.deepEqual(op.runs(), [{ args: [...PREFIX, "--skill", join(op.agent, "skills/brainstorming"), "--model", "test"], host: "127.0.0.1", port: String(port), web: "", viewers: 1 }]);
	assert.equal(await freed(port), false, "stop ends its viewer");
});

test("P17-operator-reuse: a same-home viewer is reused and never stopped; another home's or an unrelated listener refuses the start", { timeout: 180_000 }, async (t) => {
	const d = await dashboard(t);
	const same = operator(t, d.home);
	const reused = await run(same, ["--host", "127.0.0.1", "--port", String(d.port)]);
	assert.deepEqual([reused.code, reused.last?.viewers], [0, 1], "reused: only the viewer already serving that port");
	assert.equal((await d.get("/api/identity")).status, 200, "the session did not start that viewer, so it does not stop it");
	const other = await run(operator(t), ["--host", "127.0.0.1", "--port", String(d.port)]);
	assert.notEqual(other.code, 0);
	assert.match(other.stderr, /belongs to another home; choose a different --port/);
	assert.equal((await d.get("/api/identity")).status, 200);
	const unrelated = createHttpServer((_req, res) => res.writeHead(404).end());
	await new Promise<void>((done) => unrelated.listen(0, "127.0.0.1", done));
	t.after(() => unrelated.close());
	const refused = await run(operator(t), ["--host", "127.0.0.1", "--port", String((unrelated.address() as AddressInfo).port)]);
	assert.notEqual(refused.code, 0);
	assert.match(refused.stderr, /cannot verify viewer on port/);
	assert.equal(unrelated.listening, true);
});

test("P17-operator-signals: SIGINT, SIGTERM or SIGHUP to cp-operator ends pi unsuccessfully and stops the viewer it started", { timeout: 300_000 }, async (t) => {
	for (const signal of OPERATOR_SIGNALS) {
		const op = operator(t), port = await freePort();
		const session = op.start(["--host", "127.0.0.1", "--port", String(port)]);
		await until(() => op.runs().length, (n) => n === 1, `${signal}: pi running`, 60_000);
		await until(() => portInUse(port), Boolean, `${signal}: the viewer listening`, 60_000);
		session.child.kill(signal);
		const exit = await session.exit;
		assert.notDeepEqual(exit, { code: 0, signal: null }, `${signal}: a session ended by a signal does not report success`);
		assert.equal(await freed(port), false, `${signal}: the viewer stops`);
	}
});

test("P17-operator-address: without --host pi gets the tailnet address; service mode starts no viewer; remote-only gets no host", { timeout: 180_000 }, async (t) => {
	const op = operator(t), port = await freePort();
	op.tailscale("100.101.102.103");
	const tailnet = await run(op, ["--port", String(port)]);
	assert.deepEqual([tailnet.code, tailnet.last?.host, tailnet.last?.port, tailnet.last?.args], [0, "100.101.102.103", String(port), PREFIX]);
	const service = await run(op, ["--port", String(port)], { CP_OPERATOR_VIEWER: "service" });
	assert.deepEqual([service.code, service.last?.host, service.last?.viewers], [0, "100.101.102.103", 0], "cp-daemon serves it: no session viewer");
	op.tailscale(null);
	for (const extra of [{}, { CP_OPERATOR_VIEWER: "service" }]) {
		const refused = await run(op, [], extra);
		assert.notEqual(refused.code, 0);
		assert.match(refused.stderr, /--require-tailnet is set; exiting instead of serving on loopback/, JSON.stringify(extra));
	}
	const { dataDir } = daemonPaths(op.home);
	mkdirSync(dataDir, { recursive: true });
	const tunnel = (enabled: boolean) => atomicWrite(tunnelConfigFile(dataDir), { schema_version: 1, enabled, mode: "quick", port: 8767, binary: "/opt/cf/cloudflared", revision: 1 });
	tunnel(false);
	assert.match((await run(op, [], { CP_OPERATOR_VIEWER: "service" })).stderr, /--require-tailnet/, "a disabled tunnel is not remote-only");
	tunnel(true);
	const remote = await run(op, [], { CP_OPERATOR_VIEWER: "service" });
	assert.deepEqual([remote.code, remote.last?.host, remote.last?.port], [0, null, "8766"], "no local listener: pi gets no CP_VIEWER_HOST");
	const pinned = await run(op, [], { CP_OPERATOR_VIEWER: "service", CP_VIEWER_HOST: "100.64.0.1" });
	assert.equal(pinned.last?.host, "100.64.0.1", "a pinned host is always local");
	const bad = await run(op, [], { CP_OPERATOR_VIEWER: "service", CP_VIEWER_PORT: "0" });
	assert.match(bad.stderr, /CP_VIEWER_PORT must be 1-65535/);
});

test("P17-operator-model: data/operator.json's model beats CP_OPERATOR_MODEL, never a model flag or a resume; its thinking never an explicit --thinking or a resume", { timeout: 300_000 }, async (t) => {
	const op = operator(t);
	const env = { CP_OPERATOR_VIEWER: "service", CP_VIEWER_HOST: "127.0.0.1", CP_OPERATOR_MODEL: "env/m" };
	const model = async (argv: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
		const result = await run(op, argv, { ...env, ...extra });
		assert.equal(result.code, 0, result.stderr);
		return { args: result.last!.args.slice(PREFIX.length), stderr: result.stderr };
	};
	assert.deepEqual(await model(), { args: ["--model", "env/m"], stderr: "" }, "absent file: the env pin");
	assert.deepEqual((await model(["--thinking", "high"])).args, ["--model", "env/m", "--thinking", "high"]);
	assert.deepEqual((await model([], { CP_OPERATOR_MODEL: " " })).args, [], "blank is unset");
	const settings = join(op.home, LAYOUT.data, "operator.json");
	mkdirSync(join(op.home, LAYOUT.data), { recursive: true });
	writeFileSync(settings, JSON.stringify({ compact_at_tokens: 1000, model: "file/m" }));
	assert.deepEqual(await model(), { args: ["--model", "file/m"], stderr: "" });
	for (const argv of [["--model", "x"], ["--model=x"], ["--models", "x"], ["--provider", "p"], ["-c"], ["--continue"], ["-r"], ["--resume"], ["--session", "s"], ["--session=s"], ["--session-id", "i"], ["--fork", "f"]]) {
		assert.deepEqual((await model(argv)).args, argv, argv.join(" "));
	}
	// Thinking (dashboard Settings): only an explicit --thinking or a resume beats it; an explicit --model keeps it.
	writeFileSync(settings, JSON.stringify({ model: "file/m", thinking: "low" }));
	assert.deepEqual((await model()).args, ["--model", "file/m", "--thinking", "low"]);
	assert.deepEqual((await model(["--model", "x"])).args, ["--thinking", "low", "--model", "x"], "an explicit model keeps the file thinking");
	for (const argv of [["--thinking", "high"], ["--thinking=high"]]) assert.deepEqual((await model(argv)).args, ["--model", "file/m", ...argv], argv.join(" "));
	for (const argv of [["--session", "s"], ["-c"]]) assert.deepEqual((await model(argv)).args, argv, argv.join(" "));
	writeFileSync(settings, JSON.stringify({ thinking: "low" }));
	assert.deepEqual((await model()).args, ["--model", "env/m", "--thinking", "low"], "file thinking with the env model");
	writeFileSync(settings, JSON.stringify({ model: "not a model", thinking: "huge" }));
	assert.deepEqual((await model()).args, ["--model", "env/m"], "an invalid model or thinking is ignored");
	rmSync(settings);
	mkdirSync(settings);
	const unreadable = await model();
	assert.deepEqual(unreadable.args, ["--model", "env/m"]);
	assert.match(unreadable.stderr, /^cp-operator: operator model setting unreadable \(.*operator\.json: EISDIR.*\); falling back to CP_OPERATOR_MODEL\n$/);
});

test("P17-operator-web: an installed pi-web-access rides as -e; missing, withheld or unresolvable is pi's status line; CP_OPERATOR_WEB=0 is silent", { timeout: 180_000 }, async (t) => {
	const env = { CP_OPERATOR_VIEWER: "service", CP_VIEWER_HOST: "127.0.0.1", CP_OPERATOR_WEB: "" };
	const web = async (op: ReturnType<typeof operator>, extra: NodeJS.ProcessEnv = {}) => {
		const result = await run(op, [], { ...env, ...extra });
		assert.equal(result.code, 0, result.stderr);
		return { extensions: flagValues(result.last!.args, "-e").slice(PREFIX.length / 2 - 1), status: result.last!.web };
	};
	const op = operator(t);
	assert.match((await web(op)).status, /pi-web-access is not installed/);
	assert.deepEqual(await web(op, { CP_OPERATOR_WEB: "0" }), { extensions: [], status: "" });
	const root = installPackage(op.agent, "pi-web-access", { extensions: ["./index.ts"] }, { "index.ts": "export default function () {}\n" });
	assert.deepEqual(await web(op), { extensions: [join(root, "index.ts")], status: "" });
	assert.deepEqual(await web(op, { CP_OPERATOR_WEB: "0" }), { extensions: [], status: "" });
	writeFileSync(join(op.agent, "web-search.json"), "{ not json");
	const withheld = await web(op);
	assert.deepEqual(withheld.extensions, []);
	assert.match(withheld.status, /web-search\.json does not parse/);
	const skills = operator(t);
	installPackage(skills.agent, "pi-web-access", { skills: ["./skills"] }, { "skills/x/SKILL.md": "---\nname: x\ndescription: d\n---\n" });
	assert.deepEqual((await web(skills)).extensions, [], "a package with no extension entrypoint adds no -e");
	const broken = operator(t);
	configure(broken.agent, "npm:pi-web-access");
	writeFileSync(join(broken.agent, "settings.json"), "{ broken");
	const failed = await web(broken);
	assert.deepEqual(failed.extensions, []);
	assert.match(failed.status, /^web search: unavailable \((?!pi-web-access is not installed\)).+\); CP_OPERATOR_WEB=0 silences this$/, "an unresolvable package set says why");
});
