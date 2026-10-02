/**
 * cp-daemon P2: the one-command install. `install.ts` runs against fake ports
 * over a scratch HOME (nothing is installed on this machine, no unit is
 * started); `scripts/install.sh` runs against a fake `git` on PATH.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { install, type InstallFlags, type InstallPorts, parseInstallArgs, type RunResult, workerPackageSpecs } from "../src/service/install.ts";
import { DAEMON_UNIT, HEALTH_TIMER, installTargets, OPERATOR_RESUME_UNIT, OPERATOR_UNIT, PARENT_UNIT, renderUnits, UPDATE_TIMER, VIEW_UNIT } from "../src/service/units.ts";
import { daemonPaths } from "../src/service/daemon-files.ts";
import { PI_LENS_TOOLS } from "../src/tool-manifest.ts";
import { ROLE_PACKAGES } from "../src/worker-packages.ts";
import { configureLayout, layoutForHome } from "../src/contracts.ts";
import { gatewayKeyFile, readGatewayKey } from "../src/gateway-key.ts";
import { loadCapacityConfig } from "../src/quota.ts";
import { REPO_ROOT } from "./harness/index.ts";

function scratch(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(join(tmpdir(), "cp-install-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

interface Fake { ports: InstallPorts; calls: string[]; envs: Map<string, NodeJS.ProcessEnv | undefined>; lines: string[]; files: Map<string, string>; modes: Map<string, number>; secrets: string[]; questions: string[]; replies: Array<string | undefined>; writes: string[]; ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> }

/** cp-daemon's records once a start ran: the inner ready, parent and viewer running (daemon-backend's readiness). */
const READY: Record<string, string> = { "state/daemon.json": JSON.stringify({ inner: { state: "ready" } }), "state/daemon-runtime.json": JSON.stringify({ units: { parent: { state: "running" }, viewer: { state: "running" } } }) };

/**
 * In-memory files; every command answers from `answers` (default status 0); `pi install X` appends X to settings.json like pi would.
 * A cp-daemon start (systemctl enable --now / try-restart, or `daemon.ts start|restart`) makes `READY` readable; `daemon.ts status` answers it.
 */
function fake(user: string, answers: Record<string, Partial<RunResult>> = {}): Fake {
	const calls: string[] = [];
	let started = false;
	const envs = new Map<string, NodeJS.ProcessEnv | undefined>();
	const modes = new Map<string, number>();
	const secrets: string[] = [];
	const lines: string[] = [];
	const questions: string[] = [];
	const replies: Array<string | undefined> = [];
	const writes: string[] = [];
	const files = new Map<string, string>();
	let ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
	const app = join(user, ".pi-command-post/app");
	const settings = join(user, ".pi/agent/settings.json");
	files.set(join(app, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1" } } }));
	const ports: InstallPorts = {
		run: (command, args, _cwd, env) => {
			const call = [command, ...args].join(" ");
			calls.push(call);
			envs.set(call, env);
			const key = Object.keys(answers).find((prefix) => call.startsWith(prefix));
			if (new RegExp(`^systemctl --user (enable --now|try-restart) ${DAEMON_UNIT}$|/daemon\\.ts (start|restart) `).test(call)) started = true;
			if (call === `systemctl --user disable --now ${DAEMON_UNIT}` || /\/daemon\.ts stop /.test(call)) started = false;
			const active = call.startsWith("systemctl --user is-active ") ? (call.endsWith("cp-update.service") ? "inactive\n" : "active\n") : undefined;
			const defaults: RunResult = { status: /\/daemon\.ts status /.test(call) && !started ? 3 : 0, stdout: call === "systemctl --user is-system-running" ? "running\n" : active ?? (call.startsWith("loginctl show-user") ? "Linger=yes\n" : call === "npm prefix -g" ? `${user}/.npm-global\n` : ""), stderr: "" };
			const result = { ...defaults, ...(key ? answers[key] : {}) };
			if (call === "npm ci" && result.status === 0) files.set(join(app, "node_modules/.package-lock.json"), files.get(join(app, "package-lock.json"))!);
			if (command === "pi" && args[0] === "install" && result.status === 0) {
				const have = JSON.parse(files.get(settings) ?? "{}") as { packages?: unknown[] };
				files.set(settings, JSON.stringify({ ...have, packages: [...(have.packages ?? []), args[1]] }));
			}
			return result;
		},
		read: (path) => files.get(path) ?? (started ? READY[path.split("/").slice(-2).join("/")] : undefined),
		write: (path, text, mode) => {
			writes.push(path);
			files.set(path, text);
			modes.set(path, mode);
		},
		writeSecret: (path, text) => {
			secrets.push(path);
			files.set(path, text);
			modes.set(path, 0o600);
		},
		mode: (path) => (files.has(path) ? modes.get(path) ?? 0o644 : undefined),
		exists: (path) => files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
		mkdir: (path) => void files.set(join(path, ".dir"), ""),
		remove: (path) => void files.delete(path),
		writable: () => true,
		ask: (question) => {
			questions.push(question);
			return replies.shift();
		},
		env: { HOME: user, USER: "u", PATH: `/opt/node/bin:${join(user, ".local/bin")}` },
		node: { path: "/opt/node/bin/node", version: "v24.18.0" },
		doctor: async () => ({ text: "doctor: all ok", level: "info" }),
		sleep: async () => {},
		log: (line) => void lines.push(line),
		interfaces: () => ifaces,
	};
	const f: Fake = { ports, calls, envs, lines, files, modes, secrets, questions, replies, writes, get ifaces() { return ifaces; }, set ifaces(value) { ifaces = value; } };
	return f;
}

const flags = (user: string, extra: InstallFlags = {}): InstallFlags => ({ app: join(user, ".pi-command-post/app"), ...extra });

const homeOf = (f: Fake) => join(f.ports.env.HOME!, ".pi-command-post");
const configFile = (f: Fake) => daemonPaths(homeOf(f)).config;
/** data/daemon.json as written, or undefined. */
const configOf = (f: Fake): { backend?: string; viewer_host?: string; parent_model?: string; port?: number } | undefined => {
	const text = f.files.get(configFile(f));
	return text === undefined ? undefined : JSON.parse(text);
};
const thinUnit = (f: Fake) => join(installTargets(f.ports.env).unitDir, DAEMON_UNIT);

test("install: a first run writes data/daemon.json, cp-daemon.service and the wrapper and starts cp-daemon; the second is all ok/skip", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	const { unitDir, binDir } = installTargets(f.ports.env);
	for (const file of [thinUnit(f), join(binDir, "cp-operator")]) assert.ok(f.files.has(file), file);
	assert.match(f.files.get(thinUnit(f))!, /^ExecStart="\/opt\/node\/bin\/node" ".*\/src\/service\/daemon\.ts" "run"$/m);
	assert.deepEqual({ ...configOf(f) }, { schema_version: 1, generated_by: "cp-install", backend: "systemd", node: "/opt/node/bin/node", app: join(user, ".pi-command-post/app"), home: homeOf(f), path: `/opt/node/bin:${join(user, ".local/bin")}`, port: 8766 });
	assert.equal(f.modes.get(configFile(f)), 0o600);
	for (const legacy of [PARENT_UNIT, VIEW_UNIT, HEALTH_TIMER, UPDATE_TIMER]) assert.ok(!f.files.has(join(unitDir, legacy)), `no legacy ${legacy}`);
	assert.ok(f.calls.includes("npm ci"));
	assert.ok(f.calls.includes(`systemctl --user enable --now ${DAEMON_UNIT}`), f.calls.join("\n"));
	assert.ok(f.lines.includes(`ok: enable: ${DAEMON_UNIT} is active: the parent supervisor and the viewer run`), f.lines.join("\n"));
	assert.ok(!f.calls.some((call) => call.startsWith("systemctl --user try-restart")), "a newly written unit is started by enable --now, not restarted");
	assert.ok(f.lines.some((line) => line === "ok: doctor: doctor: all ok"));
	assert.equal(JSON.parse(f.files.get(join(user, ".pi-command-post/data/update.json"))!).enabled, true);
	assert.ok(f.calls.every((call) => !/\bsudo\b/.test(call)), "never sudo");

	f.lines.length = 0;
	f.calls.length = 0;
	assert.equal(await install(flags(user), f.ports), 0);
	const statuses = f.lines.filter((line) => /^(ok|changed|skip|fail): /.test(line)).map((line) => line.split(":")[0]);
	assert.deepEqual([...new Set(statuses)].filter((status) => status !== "ok" && status !== "skip"), [], f.lines.join("\n"));
	assert.ok(!f.calls.includes("npm ci"), "a matching node_modules is not reinstalled");
	assert.ok(!f.calls.some((call) => call.startsWith("systemctl --user try-restart")), "nothing changed, nothing restarts");
});

test("install: a changed cp-daemon.service or data/daemon.json is refused without --force (nothing started) and replaced (and restarted) with it", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	await install(flags(user), f.ports);
	for (const path of [thinUnit(f), configFile(f)]) {
		const kept = f.files.get(path)!;
		f.files.set(path, "# edited by hand\n");
		f.lines.length = 0;
		f.calls.length = 0;
		assert.equal(await install(flags(user), f.ports), 1);
		assert.ok(f.lines.some((line) => /^fail: (unit|daemon): /.test(line) && line.includes(`${path} differs`) && line.includes("--force")), f.lines.join("\n"));
		assert.equal(f.files.get(path), "# edited by hand\n");
		assert.ok(!f.calls.some((call) => call.includes(DAEMON_UNIT)), "a refused write starts nothing");
		assert.equal(await install(flags(user, { force: true }), f.ports), 0, f.lines.join("\n"));
		assert.equal(f.files.get(path), kept);
		assert.ok(f.calls.includes(`systemctl --user try-restart ${DAEMON_UNIT}`), f.calls.join("\n"));
	}
});

test("install --dry-run changes nothing and runs no mutating command", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	assert.equal(await install(flags(user, { "dry-run": true }), f.ports), 0, f.lines.join("\n"));
	assert.deepEqual([...f.files.keys()], [join(user, ".pi-command-post/app/package-lock.json")]);
	assert.ok(!f.calls.some((call) => /^(npm ci|systemctl --user (enable|daemon-reload)|loginctl enable)/.test(call)), f.calls.join("\n"));
	assert.ok(f.calls.some((call) => call.includes("install-tools.ts --dry-run")));
});

test("install: no systemd --user runs cp-daemon detached and prints the reboot command; refused linger prints the sudo line and runs nothing; bad node stops", async (t) => {
	const user = scratch(t);
	const off = fake(user, { "systemctl --user is-system-running": { status: 1, stdout: "offline\n" } });
	assert.equal(await install(flags(user), off.ports), 0, off.lines.join("\n"));
	assert.ok(off.lines.some((line) => line.startsWith("ok: service: no systemd --user (offline): cp-daemon runs detached")), off.lines.join("\n"));
	assert.ok(!off.calls.some((call) => call.includes("enable")));
	assert.ok(!off.files.has(thinUnit(off)), "no unit file");
	assert.equal(configOf(off)?.backend, "detached");
	const daemon = `/opt/node/bin/node ${join(user, ".pi-command-post/app")}/src/service/daemon.ts`;
	assert.ok(off.calls.includes(`${daemon} start --home ${homeOf(off)}`), off.calls.join("\n"));
	const reboot = `"/opt/node/bin/node" "${join(user, ".pi-command-post/app")}/src/service/daemon.ts" start --home "${homeOf(off)}"`;
	assert.ok(off.lines.includes(`changed: daemon: started (detached); after a reboot run: ${reboot}`), off.lines.join("\n"));
	assert.ok(!off.calls.some((call) => call.startsWith("crontab")), "no --crontab: crontab is never touched");
	assert.ok(off.lines.includes("ok: doctor: doctor: all ok"), "doctor runs on the detached backend too");
	assert.ok(off.files.has(join(installTargets(off.ports.env).binDir, "cp-operator")), "the wrapper still lands");
	off.lines.length = 0;
	off.calls.length = 0;
	assert.equal(await install(flags(user), off.ports), 0);
	assert.ok(off.lines.includes(`ok: daemon: running (detached); after a reboot run: ${reboot}`), off.lines.join("\n"));
	assert.ok(!off.calls.some((call) => / (start|restart) --home /.test(call)), "a running daemon with an unchanged config is left alone");

	const noLinger = fake(scratch(t), { "loginctl show-user": { stdout: "Linger=no\n" }, "loginctl enable-linger": { status: 1 } });
	assert.equal(await install(flags(noLinger.ports.env.HOME!), noLinger.ports), 1);
	assert.ok(noLinger.lines.some((line) => line === "fail: linger: loginctl enable-linger refused; run: sudo loginctl enable-linger u"));
	assert.ok(noLinger.calls.every((call) => !call.startsWith("sudo")));

	const oldNode = fake(scratch(t));
	oldNode.ports.node.version = "v22.1.0";
	assert.equal(await install(flags(oldNode.ports.env.HOME!), oldNode.ports), 1);
	assert.ok(!oldNode.calls.includes("npm ci"));
});

test("install --uninstall stops cp-daemon, removes only what it wrote (data/daemon.json too) and never the home or the app", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	await install(flags(user), f.ports);
	const { binDir } = installTargets(f.ports.env);
	f.files.set(join(binDir, "cp-operator"), "#!/bin/sh\n# mine\n");
	const before = [...f.files.keys()].filter((path) => path.startsWith(join(user, ".pi-command-post")) && path !== configFile(f));
	assert.equal(await install(flags(user, { uninstall: true }), f.ports), 0, f.lines.join("\n"));
	assert.ok(f.calls.includes(`systemctl --user disable --now ${DAEMON_UNIT}`), f.calls.join("\n"));
	assert.ok(!f.files.has(thinUnit(f)));
	assert.ok(!f.files.has(configFile(f)), "data/daemon.json removed");
	assert.ok(f.files.has(join(binDir, "cp-operator")), "a wrapper cp-install did not write stays");
	assert.deepEqual([...f.files.keys()].filter((path) => path.startsWith(join(user, ".pi-command-post"))), before);
	assert.ok(f.lines.some((line) => line.startsWith("ok: uninstall: home ") && line.includes("kept (data/daemon.json removed)")), f.lines.join("\n"));

	const off = fake(scratch(t), { "systemctl --user is-system-running": { status: 1, stdout: "offline\n" }, "crontab -l": { stdout: "@daily x\n" } });
	assert.equal(await install(flags(off.ports.env.HOME!), off.ports), 0, off.lines.join("\n"));
	assert.equal(await install(flags(off.ports.env.HOME!, { uninstall: true }), off.ports), 0, off.lines.join("\n"));
	assert.ok(off.calls.some((call) => /\/daemon\.ts stop --home /.test(call)), off.calls.join("\n"));
	assert.ok(!off.calls.some((call) => call.startsWith("crontab ") && call !== "crontab -l"), "no marked line: the crontab is not rewritten");
	assert.ok(!off.files.has(configFile(off)));
});

test("install (cp-rrye): no cp-operator*.service is written — Start in tmux runs tmux directly; a generated one from an older install is removed, never stopped; a hand-written one stays", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	f.files.set("/opt/node/bin/tmux", "");
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	const { unitDir, binDir } = installTargets(f.ports.env);
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) assert.ok(!f.files.has(join(unitDir, name)), `no ${name}`);
	assert.ok(f.files.has(join(binDir, "cp-operator")), "the wrapper the tmux session runs still lands");

	// An older install's units (renderUnits with tmux: what cp-install wrote before cp-rrye).
	const old = renderUnits({ node: "/opt/node/bin/node", app: join(user, ".pi-command-post/app"), home: homeOf(f), path: "/opt/node/bin", port: 8766, tmux: "/opt/node/bin/tmux", wrapper: join(binDir, "cp-operator") });
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) f.files.set(join(unitDir, name), old[name]!);
	f.lines.length = 0;
	f.calls.length = 0;
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) {
		assert.ok(!f.files.has(join(unitDir, name)), `generated ${name} removed`);
		assert.ok(f.lines.includes(`changed: unit: removed ${join(unitDir, name)} (never stopped: Start in tmux runs tmux directly now)`), f.lines.join("\n"));
	}
	assert.ok(!f.calls.some((call) => call.includes("cp-operator")), `no command touches the operator units or session: ${f.calls.join("; ")}`);

	f.files.set(join(unitDir, OPERATOR_UNIT), "[Service]\nExecStart=/usr/bin/tmux new-session -d -s mine\n");
	f.lines.length = 0;
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.ok(f.files.has(join(unitDir, OPERATOR_UNIT)), "a hand-written cp-operator.service stays");
	assert.ok(!f.lines.some((line) => line.includes("removed")), f.lines.join("\n"));

	const dry = fake(scratch(t));
	const dryUnits = installTargets(dry.ports.env).unitDir;
	dry.files.set(join(dryUnits, OPERATOR_UNIT), old[OPERATOR_UNIT]!);
	assert.equal(await install(flags(dry.ports.env.HOME!, { "dry-run": true }), dry.ports), 0, dry.lines.join("\n"));
	assert.ok(dry.files.has(join(dryUnits, OPERATOR_UNIT)), "--dry-run removes nothing");
});

test("install: launchers — tmux and herdr found on the installing PATH are printed; herdr without the pi integration prints the install hint and never runs it", async (t) => {
	const none = fake(scratch(t));
	assert.equal(await install(flags(none.ports.env.HOME!), none.ports), 0, none.lines.join("\n"));
	assert.ok(none.lines.includes("ok: launchers: tmux not on PATH (the dashboard's Start in tmux needs it); herdr not on PATH"), none.lines.join("\n"));
	assert.ok(!none.calls.some((call) => call.includes("herdr")), "no herdr: never run");

	const both = fake(scratch(t), { "/opt/node/bin/herdr integration status": { stdout: "pi: not installed (/home/u/.pi/agent/extensions/herdr-agent-state.ts)\nomp: not installed\n" } });
	both.files.set("/opt/node/bin/tmux", "");
	both.files.set("/opt/node/bin/herdr", "");
	assert.equal(await install(flags(both.ports.env.HOME!), both.ports), 0, both.lines.join("\n"));
	assert.ok(both.lines.includes("ok: launchers: tmux /opt/node/bin/tmux; herdr /opt/node/bin/herdr"), both.lines.join("\n"));
	assert.ok(both.lines.some((line) => line.startsWith("skip: herdr: pi integration not installed") && line.includes("herdr integration install pi")), both.lines.join("\n"));
	assert.ok(!both.calls.some((call) => call.includes("integration install")), "printed, never run");

	const integrated = fake(scratch(t), { "/opt/node/bin/herdr integration status": { stdout: "pi: installed (/home/u/.pi/agent/extensions/herdr-agent-state.ts)\n" } });
	integrated.files.set("/opt/node/bin/herdr", "");
	assert.equal(await install(flags(integrated.ports.env.HOME!), integrated.ports), 0);
	assert.ok(!integrated.lines.some((line) => line.startsWith("skip: herdr:")), "pi integrated: no hint");
});

test("install --uninstall never stops the live operator session (no systemctl call on cp-operator.service) and removes an older install's operator units", async (t) => {
	const f = fake(scratch(t));
	assert.equal(await install(flags(f.ports.env.HOME!), f.ports), 0, f.lines.join("\n"));
	const { unitDir, binDir } = installTargets(f.ports.env);
	const unit = join(unitDir, OPERATOR_UNIT);
	const old = renderUnits({ node: "/opt/node/bin/node", app: join(f.ports.env.HOME!, ".pi-command-post/app"), home: homeOf(f), path: "/opt/node/bin", port: 8766, tmux: "/opt/node/bin/tmux", wrapper: join(binDir, "cp-operator") });
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) f.files.set(join(unitDir, name), old[name]!);
	f.calls.length = 0;
	assert.equal(await install(flags(f.ports.env.HOME!, { uninstall: true }), f.ports), 0, f.lines.join("\n"));
	assert.ok(!f.calls.some((call) => call.includes(OPERATOR_UNIT)), `no systemctl call touches ${OPERATOR_UNIT}: ${f.calls.join("; ")}`);
	assert.ok(!f.calls.some((call) => /systemctl --user (stop|kill)/.test(call)));
	assert.ok(!f.files.has(unit), "its unit file is still removed, tmux or not");
	assert.ok(!f.files.has(join(installTargets(f.ports.env).unitDir, OPERATOR_RESUME_UNIT)), "and its resume twin");
	assert.ok(!f.calls.some((call) => call.includes(OPERATOR_RESUME_UNIT)), "no systemctl call touches the resume twin");
	assert.ok(f.lines.includes(`changed: uninstall: removed ${unit}`), f.lines.join("\n"));
});

test("parseInstallArgs takes the documented flags and refuses others", () => {
	assert.deepEqual({ ...parseInstallArgs(["--home", "/h", "--force", "--no-start", "--crontab", "--parent-model", "m/x", "--viewer-host", "100.70.1.2"]) }, { home: "/h", force: true, "no-start": true, crontab: true, "parent-model": "m/x", "viewer-host": "100.70.1.2" });
	assert.deepEqual({ ...parseInstallArgs(["--operator-model", "o/m", "--gateway-url", "https://gw", "--gateway-key-file", "/k"]) }, { "operator-model": "o/m", "gateway-url": "https://gw", "gateway-key-file": "/k" });
	assert.throws(() => parseInstallArgs(["--sudo"]));
});

const iface = (address: string): NetworkInterfaceInfo => ({ address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "", internal: false, cidr: null }) as NetworkInterfaceInfo;
const HOSTS = { tailscale0: [iface("100.80.0.1")], enp3s0: [iface("192.168.1.5"), iface("fe80::1")], lo: [iface("127.0.0.1")] };
const TAILSCALE = { "tailscale ip -4": { stdout: "100.80.0.1\n" } };
/** The viewer host data/daemon.json pins ("" when none or no file). */
const hostOf = (f: Fake) => configOf(f)?.viewer_host ?? "";
const notOk = (f: Fake) => f.lines.filter((line) => /^(changed|fail): /.test(line));

test("install --viewer-host: pinned in data/daemon.json and the wrapper; a rerun (same flag, or none) is all ok/skip", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	f.ifaces = { wt0: [iface("100.70.1.2")], lo: [iface("127.0.0.1")] };
	assert.equal(await install(flags(user, { "viewer-host": "100.70.1.2" }), f.ports), 0, f.lines.join("\n"));
	const { binDir } = installTargets(f.ports.env);
	assert.equal(hostOf(f), "100.70.1.2");
	assert.doesNotMatch(f.files.get(thinUnit(f))!, /CP_VIEWER_HOST/, "never in the thin unit");
	assert.match(f.files.get(join(binDir, "cp-operator"))!, /^export .* CP_VIEWER_HOST='100\.70\.1\.2'$/m);
	assert.ok(f.lines.includes("changed: viewer-host: 100.70.1.2 (--viewer-host; was none)"), f.lines.join("\n"));
	for (const extra of [{ "viewer-host": "100.70.1.2" }, {}]) {
		f.lines.length = 0;
		assert.equal(await install(flags(user, extra), f.ports), 0);
		assert.deepEqual(notOk(f), [], f.lines.join("\n"));
	}
	assert.ok(f.lines.includes(`ok: viewer-host: 100.70.1.2 kept from ${configFile(f)}`), f.lines.join("\n"));
	f.ifaces = {};
	f.lines.length = 0;
	assert.equal(await install(flags(user), f.ports), 0);
	assert.ok(f.lines.some((line) => line.startsWith("skip: viewer-host: 100.70.1.2 is not on this machine's interfaces now")), f.lines.join("\n"));
	assert.deepEqual(notOk(f), [], "kept, units untouched");
});

test("install --viewer-host: wildcard, public, link-local, mapped, zoned, non-IP and foreign addresses fail before npm ci and write nothing", async (t) => {
	for (const value of ["0.0.0.0", "::", "8.8.8.8", "2001:4860::8888", "fe80::1", "fe80::1%eth0", "169.254.1.1", "::ffff:10.0.0.1", "localhost", "10.9.9.9"]) {
		const f = fake(scratch(t));
		f.ifaces = { ...HOSTS, eth1: [iface("169.254.1.1")] };
		assert.equal(await install(flags(f.ports.env.HOME!, { "viewer-host": value }), f.ports), 1, value);
		assert.ok(f.lines.some((line) => line.startsWith("fail: viewer-host: ")), `${value}\n${f.lines.join("\n")}`);
		assert.ok(!f.calls.includes("npm ci"), value);
		assert.deepEqual(f.writes, [], value);
	}
});

test("install, fresh and prompting: one numbered question, Tailscale recommended; empty takes it, a number or a typed local IP picks, anything else fails", async (t) => {
	const ask = async (reply: string) => {
		const f = fake(scratch(t), TAILSCALE);
		f.ifaces = HOSTS;
		f.replies.push(reply);
		const code = await install(flags(f.ports.env.HOME!), f.ports);
		return { f, code };
	};
	const empty = await ask("");
	assert.equal(empty.code, 0, empty.f.lines.join("\n"));
	const questions = empty.f.questions.filter((q) => q.startsWith("Dashboard address"));
	assert.equal(questions.length, 1);
	assert.match(questions[0]!, /anyone who can reach it can steer the operator session/);
	assert.match(questions[0]!, /\n {2}1\) 100\.80\.0\.1 {2}Tailscale \(tailscale0\) — recommended: only devices on your tailnet can reach it\n {2}2\) 192\.168\.1\.5 {2}enp3s0 — anyone on this network can reach it\n {2}3\) 127\.0\.0\.1 {2}lo — this machine only/);
	assert.ok(questions[0]!.endsWith("Choose 1-3 or type an IP [1]: "), questions[0]);
	assert.equal(hostOf(empty.f), "100.80.0.1");
	assert.ok(empty.f.lines.some((line) => line.startsWith("changed: viewer-host: 100.80.0.1 (tailscale; recommended")), empty.f.lines.join("\n"));

	const second = await ask("2");
	assert.equal(second.code, 0);
	assert.equal(hostOf(second.f), "192.168.1.5");
	assert.ok(second.f.lines.includes("changed: viewer-host: 192.168.1.5 (private; chosen at the prompt)"), second.f.lines.join("\n"));

	const typed = await ask("127.0.0.1");
	assert.equal(typed.code, 0);
	assert.equal(hostOf(typed.f), "127.0.0.1");

	for (const bad of ["8.8.8.8", "9", "10.9.9.9"]) {
		const refused = await ask(bad);
		assert.equal(refused.code, 1, bad);
		assert.ok(refused.f.lines.some((line) => line.startsWith("fail: viewer-host: ") && line.endsWith("rerun with --viewer-host <ip>")), refused.f.lines.join("\n"));
		assert.equal(configOf(refused.f), undefined, "no data/daemon.json written");
	}
});

test("install --yes: the Tailscale address is pinned unasked; without one nothing is pinned and the files render as before; a LAN address is never picked", async (t) => {
	const tailnet = fake(scratch(t), TAILSCALE);
	tailnet.ifaces = HOSTS;
	assert.equal(await install(flags(tailnet.ports.env.HOME!, { yes: true }), tailnet.ports), 0, tailnet.lines.join("\n"));
	assert.deepEqual(tailnet.questions, []);
	assert.equal(hostOf(tailnet), "100.80.0.1");
	assert.ok(tailnet.lines.some((line) => line.startsWith("changed: viewer-host: 100.80.0.1 (tailscale; recommended") && line.endsWith("--viewer-host overrides)")));

	const lan = fake(scratch(t), { "tailscale ip -4": { status: 1 } });
	lan.ifaces = { enp3s0: HOSTS.enp3s0, lo: HOSTS.lo };
	assert.equal(await install(flags(lan.ports.env.HOME!, { yes: true }), lan.ports), 0, lan.lines.join("\n"));
	assert.ok(lan.lines.some((line) => line.startsWith("skip: viewer-host: no Tailscale address on this machine; nothing pinned") && line.includes("--viewer-host <ip>")), lan.lines.join("\n"));
	const plain = fake(lan.ports.env.HOME!, { "tailscale ip -4": { status: 1 } });
	assert.equal(await install(flags(lan.ports.env.HOME!, { yes: true }), plain.ports), 0);
	for (const [path, text] of lan.files) if (path.endsWith(".service") || path.endsWith("cp-operator") || path === configFile(lan)) {
		assert.doesNotMatch(text, /CP_VIEWER_HOST|viewer_host/, path);
		assert.equal(text, plain.files.get(path), `${path}: byte-identical to an install on a host with no interfaces`);
	}
});

test("install: an existing data/daemon.json keeps its host (or none) unasked; another --viewer-host is refused without --force and applied (restarting cp-daemon) with it", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	f.ifaces = HOSTS;
	assert.equal(await install(flags(user, { yes: true }), f.ports), 0, f.lines.join("\n"));
	assert.equal(hostOf(f), "", "no tailscale yet: none pinned");
	const later = fake(user, TAILSCALE);
	for (const [path, text] of f.files) later.files.set(path, text);
	later.ifaces = HOSTS;
	assert.equal(await install(flags(user), later.ports), 0, later.lines.join("\n"));
	assert.deepEqual(later.questions.filter((q) => q.startsWith("Dashboard address")), [], "an existing install is never asked");
	assert.ok(later.lines.some((line) => line.startsWith(`skip: viewer-host: none pinned in ${configFile(later)}`) && line.includes("--viewer-host <ip> --force")), later.lines.join("\n"));
	assert.deepEqual(notOk(later), [], later.lines.join("\n"));

	later.lines.length = 0;
	assert.equal(await install(flags(user, { "viewer-host": "192.168.1.5" }), later.ports), 1);
	assert.ok(later.lines.some((line) => line.startsWith(`fail: daemon: ${configFile(later)} differs`) && line.includes("--force")), later.lines.join("\n"));
	later.calls.length = 0;
	assert.equal(await install(flags(user, { "viewer-host": "192.168.1.5", force: true }), later.ports), 0, later.lines.join("\n"));
	assert.equal(hostOf(later), "192.168.1.5");
	assert.ok(later.calls.includes(`systemctl --user try-restart ${DAEMON_UNIT}`), later.calls.join("\n"));
});

test("install: a legacy cp-view.service drop-in's CP_VIEWER_HOST is reported once (M1 preflight), never adopted; --dry-run prints the choice and writes nothing", async (t) => {
	const f = fake(scratch(t), { [`systemctl --user show ${VIEW_UNIT} --property=Environment --value`]: { stdout: "CP_HOME=/h CP_VIEWER_HOST=10.1.1.1\n" } });
	const unitDir = installTargets(f.ports.env).unitDir;
	for (const [name, text] of Object.entries(renderUnits({ node: "/opt/node/bin/node", app: join(f.ports.env.HOME!, ".pi-command-post/app"), home: homeOf(f), path: "/bin", port: 8766 }))) f.files.set(join(unitDir, name), text);
	assert.equal(await install(flags(f.ports.env.HOME!, { yes: true }), f.ports), 0, f.lines.join("\n"));
	assert.equal(f.lines.filter((line) => line.startsWith(`skip: viewer-host: a drop-in on ${VIEW_UNIT} sets CP_VIEWER_HOST=10.1.1.1`)).length, 1, f.lines.join("\n"));
	assert.equal(hostOf(f), "");

	const dry = fake(scratch(t), TAILSCALE);
	dry.ifaces = HOSTS;
	assert.equal(await install(flags(dry.ports.env.HOME!, { "dry-run": true }), dry.ports), 0, dry.lines.join("\n"));
	assert.ok(dry.lines.some((line) => line.startsWith("changed: viewer-host: 100.80.0.1 (tailscale;") && line.endsWith("(dry-run)")), dry.lines.join("\n"));
	assert.deepEqual(dry.writes, []);
	assert.deepEqual(dry.questions, []);
});

const settingsFile = (user: string) => join(user, ".pi/agent/settings.json");
const pkgLine = (f: Fake) => f.calls.filter((call) => call.startsWith("pi install npm:"));

test("install: the pi package set is ROLE_PACKAGES' union; adding a role package changes the plan", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	const union = [...new Set(Object.values(ROLE_PACKAGES).flat())];
	assert.deepEqual(workerPackageSpecs(), union);
	assert.deepEqual(pkgLine(f), union.map((spec) => `pi install npm:${spec}`));
	assert.ok(!f.calls.some((call) => call.startsWith("pi install") && !call.startsWith("pi install npm:")), "no self package (single-project mode was removed)");
	assert.deepEqual(workerPackageSpecs({ ...ROLE_PACKAGES, implementer: [...ROLE_PACKAGES.implementer, "pi-new@1.2.0"] }), [...union, "pi-new@1.2.0"], "a pin stays a pin");
});

test("install: configured packages are skipped, the human's packages untouched, settings.json never written; --no-pi-packages / --no-self-package", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	const mine = ["npm:zzz-theme", { source: "npm:pi-lens@4.3.0" }, "git:github.com/me/tools"];
	f.files.set(settingsFile(user), JSON.stringify({ packages: mine }));
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.ok(!pkgLine(f).some((call) => call.includes("pi-lens")), "pi-lens is configured (pinned by the human)");
	assert.ok(f.lines.includes("ok: pi-package: pi-lens configured as npm:pi-lens@4.3.0 (yours, kept; workers name npm:pi-lens)"), f.lines.join("\n"));

	const lookalike = fake(scratch(t));
	lookalike.files.set(settingsFile(lookalike.ports.env.HOME!), JSON.stringify({ packages: ["../src/pi-command-post", "npm:pi-command-post-extras"] }));
	await install(flags(lookalike.ports.env.HOME!), lookalike.ports);
	assert.ok(!lookalike.calls.includes(`pi install ${join(lookalike.ports.env.HOME!, ".pi-command-post/app")}`), "the checkout is never installed as a pi package");
	assert.ok(!lookalike.lines.some((line) => line.includes("self-package")), lookalike.lines.join("\n"));
	assert.deepEqual((JSON.parse(f.files.get(settingsFile(user))!) as { packages: unknown[] }).packages.slice(0, 3), mine, "order and entries kept");
	assert.ok(!f.writes.includes(settingsFile(user)), "only pi install touches settings.json");

	const off = fake(scratch(t));
	assert.equal(await install(flags(off.ports.env.HOME!, { "no-pi-packages": true, "no-self-package": true }), off.ports), 0);
	assert.ok(!off.calls.some((call) => call.startsWith("pi install")), off.calls.join("\n"));
	assert.ok(off.lines.includes("skip: pi-package: --no-pi-packages"), off.lines.join("\n"));
	assert.ok(!off.lines.some((line) => line.includes("self-package")), "--no-self-package still parses and is a no-op");

	const broken = fake(scratch(t));
	broken.files.set(settingsFile(broken.ports.env.HOME!), "{ nope");
	assert.equal(await install(flags(broken.ports.env.HOME!), broken.ports), 1);
	assert.ok(broken.lines.some((line) => line.startsWith("fail: pi-package:") && line.includes("never edited here")));
	assert.ok(!broken.calls.some((call) => call.startsWith("pi install")));
});

test("install: the br prompt defaults to no, to yes with a beads tracker; --with-br / --no-br answer it", async (t) => {
	const missing = { "br --version": { status: 127 } };
	const user = scratch(t);
	const plain = fake(user, missing);
	assert.equal(await install(flags(user), plain.ports), 0);
	assert.ok(plain.questions.some((q) => q.startsWith("Install the br (beads) CLI?") && q.endsWith("[y/N] ")), plain.questions.join("\n"));
	assert.ok(plain.lines.some((line) => line.startsWith("skip: br: not on PATH (optional") && line.includes("not wanted")));

	const tracked = fake(scratch(t), missing);
	tracked.files.set(join(tracked.ports.env.HOME!, ".pi-command-post/data/trackers.json"), JSON.stringify({ schema_version: 1, connections: [{ id: "x-beads", adapter: "beads", status: "active" }] }));
	assert.equal(await install(flags(tracked.ports.env.HOME!), tracked.ports), 0);
	assert.ok(tracked.questions.some((q) => q.startsWith("Install the br (beads) CLI?") && q.includes("beads tracker") && q.endsWith("[Y/n] ")));
	assert.ok(tracked.lines.some((line) => line.startsWith("skip: br: not on PATH; install br")), tracked.lines.join("\n"));

	const cloned = fake(scratch(t), missing);
	const user2 = cloned.ports.env.HOME!;
	cloned.files.set(join(user2, ".pi-command-post/data/projects.json"), JSON.stringify({ schema_version: 1, projects: [{ name: "other" }, { name: "tracked" }] }));
	cloned.files.set(join(user2, ".pi-command-post/projects/tracked/.beads/beads.db"), "");
	assert.equal(await install(flags(cloned.ports.env.HOME!), cloned.ports), 0);
	assert.ok(cloned.questions.some((q) => q.startsWith("Install the br (beads) CLI?") && q.endsWith("[Y/n] ")), "a project clone's .beads/beads.db is a beads tracker too");

	for (const [flag, want] of [["with-br", true], ["no-br", false]] as const) {
		const f = fake(scratch(t), missing);
		await install(flags(f.ports.env.HOME!, { [flag]: true }), f.ports);
		assert.ok(!f.questions.some((q) => q.includes("br (beads)")), `--${flag} is the answer`);
		assert.equal(f.lines.some((line) => line.startsWith("skip: br: not on PATH; install br")), want);
	}
	assert.ok(plain.calls.every((call) => !/curl|\bsudo\b/.test(call)), "no guessed URL, no sudo");
});

test("install: no terminal takes every default; --yes asks nothing; a typed answer wins", async (t) => {
	const user = scratch(t);
	const noTty = fake(user);
	assert.equal(await install(flags(user), noTty.ports), 0);
	assert.ok(noTty.questions.length > 0, "asked, and undefined (no tty) meant the default");
	assert.ok(!noTty.calls.some((call) => call.startsWith("pi install") && !call.includes("npm:")), "no self package");
	assert.ok(noTty.lines.includes("skip: push: not set up; rerun with --push-origin URL to enable it"));

	const quiet = fake(scratch(t));
	assert.equal(await install(flags(quiet.ports.env.HOME!, { yes: true }), quiet.ports), 0);
	assert.deepEqual(quiet.questions, []);
	assert.ok(!quiet.calls.some((call) => call.startsWith("pi install") && !call.includes("npm:")));

	const typed = fake(scratch(t));
	typed.replies.push("https://cp.example");
	assert.equal(await install(flags(typed.ports.env.HOME!), typed.ports), 0);
	assert.ok(!typed.questions.some((q) => q.includes("pi package")), "no self-package prompt");
	assert.ok(typed.calls.some((call) => call.includes("push-init.ts --origin https://cp.example")), typed.calls.join("\n"));
});

test("install: tmux and br missing, gh logged out and no provider login are reported, never fatal", async (t) => {
	const user = scratch(t);
	const f = fake(user, { "br --version": { status: 127 }, "tmux -V": { status: 127 }, "gh auth status": { status: 1 }, "gh api user": { status: 1 } });
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.ok(f.lines.some((line) => line.startsWith("skip: tmux: not on PATH (optional")));
	assert.ok(f.lines.some((line) => line.startsWith("skip: br: not on PATH")));
	assert.ok(f.lines.some((line) => line.startsWith("skip: gh: not logged in") && line.includes("gh auth login")));
	assert.ok(!f.calls.includes("gh auth login"), "login is the human's");
	assert.ok(f.lines.some((line) => line.startsWith("skip: login: no provider") && line.includes("/login")));
	assert.ok(f.lines.some((line) => line.includes("treehouse (required, not optional")));

	const logged = fake(scratch(t));
	logged.files.set(join(logged.ports.env.HOME!, ".pi/agent/auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
	await install(flags(logged.ports.env.HOME!), logged.ports);
	assert.ok(logged.lines.some((line) => line.startsWith("ok: login: 1 provider(s)")));
});

test("install: gh reads only the active account; a gh without --active falls back to gh api user", async (t) => {
	// Plain `gh auth status` exits 1 for any invalid stored account, even when the active one is fine.
	const active = fake(scratch(t), { "gh auth status --active": { status: 0 } });
	await install(flags(active.ports.env.HOME!), active.ports);
	assert.ok(active.lines.includes("ok: gh: logged in"), active.lines.join("\n"));
	assert.ok(active.calls.includes("gh auth status --active") && !active.calls.includes("gh auth status"), active.calls.join("\n"));

	const old = fake(scratch(t), { "gh auth status": { status: 1, stderr: "unknown flag: --active" } });
	await install(flags(old.ports.env.HOME!), old.ports);
	assert.ok(old.calls.includes("gh api user --jq .login"), old.calls.join("\n"));
	assert.ok(old.lines.includes("ok: gh: logged in"), old.lines.join("\n"));
});

test("install: cp-daemon not ready after enable --now fails, naming why and the journal; --no-start enables without --now and verifies nothing", async (t) => {
	const dead = fake(scratch(t), { [`systemctl --user is-active ${DAEMON_UNIT}`]: { status: 3, stdout: "failed\n" } });
	assert.equal(await install(flags(dead.ports.env.HOME!), dead.ports), 1, dead.lines.join("\n"));
	assert.ok(dead.lines.includes(`fail: enable: ${DAEMON_UNIT} is failed after 60s; see cp-daemon log; journalctl --user -u ${DAEMON_UNIT} -n 20`), dead.lines.join("\n"));
	assert.equal(dead.calls.filter((call) => call === `systemctl --user is-active ${DAEMON_UNIT}`).length, 61, "polled through the whole window");

	const crashed = fake(scratch(t));
	const read = crashed.ports.read;
	crashed.ports.read = (path) => (path.endsWith("state/daemon-runtime.json") && read(path) ? JSON.stringify({ units: { parent: { state: "failed", result: "exit-code" }, viewer: { state: "running" } } }) : read(path));
	assert.equal(await install(flags(crashed.ports.env.HOME!), crashed.ports), 1);
	assert.ok(crashed.lines.some((line) => line.startsWith("fail: enable: the parent supervisor is failed (exit-code) after 60s")), crashed.lines.join("\n"));

	const unstarted = fake(scratch(t));
	assert.equal(await install(flags(unstarted.ports.env.HOME!, { "no-start": true }), unstarted.ports), 0, unstarted.lines.join("\n"));
	assert.ok(unstarted.calls.includes(`systemctl --user enable ${DAEMON_UNIT}`), unstarted.calls.join("\n"));
	assert.ok(!unstarted.calls.some((call) => call.includes("--now") || call.includes("is-active") || call.includes("try-restart")), unstarted.calls.join("\n"));
	assert.ok(unstarted.lines.includes(`ok: enable: ${DAEMON_UNIT} enabled, not started (--no-start); start it: systemctl --user start ${DAEMON_UNIT}`), unstarted.lines.join("\n"));
	assert.ok(unstarted.lines.includes("skip: doctor: --no-start"));
});

test("install --crontab (detached): one marked @reboot line through a file; without it crontab is never touched", async (t) => {
	const f = fake(scratch(t), { "systemctl --user is-system-running": { status: 1, stdout: "offline\n" }, "crontab -l": { stdout: "@daily x\n" } });
	assert.equal(await install(flags(f.ports.env.HOME!, { crontab: true }), f.ports), 0, f.lines.join("\n"));
	const tmp = join(daemonPaths(homeOf(f)).stateDir, "daemon-crontab.tmp");
	assert.ok(f.calls.includes(`crontab ${tmp}`) && f.writes.includes(tmp) && !f.files.has(tmp), f.calls.join("\n"));
	assert.ok(f.lines.some((line) => line.startsWith("changed: crontab: added: @reboot ") && line.endsWith(`# cp-daemon ${homeOf(f)}`)), f.lines.join("\n"));
});

test("install on a legacy home: --no-start leaves the legacy units running and untouched; a plain rerun migrates (M1), keeping their pins and never stopping the host", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	const { unitDir } = installTargets(f.ports.env);
	// With tmux: the older install's cp-operator*.service too — held with the rest under --no-start, removed (never stopped) by the migrating rerun.
	const legacy = renderUnits({ node: "/opt/node/bin/node", app: join(user, ".pi-command-post/app"), home: homeOf(f), path: "/bin", port: 8766, viewerHost: "100.80.0.1", parentModel: "openai/gpt-6.1-sol", tmux: "/usr/bin/tmux", wrapper: join(installTargets(f.ports.env).binDir, "cp-operator") });
	assert.ok(legacy[OPERATOR_UNIT] && legacy[OPERATOR_RESUME_UNIT], "the operator units are part of the older install");
	for (const [name, text] of Object.entries(legacy)) f.files.set(join(unitDir, name), text);
	f.ifaces = HOSTS;

	assert.equal(await install(flags(user, { "no-start": true }), f.ports), 0, f.lines.join("\n"));
	assert.ok(f.lines.some((line) => line.startsWith("skip: migrate: ") && line.endsWith("untouched (--no-start); rerun without --no-start to migrate")), f.lines.join("\n"));
	assert.equal(configOf(f), undefined, "no data/daemon.json beside running legacy units");
	assert.ok(!f.files.has(thinUnit(f)));
	for (const name of Object.keys(legacy)) assert.equal(f.files.get(join(unitDir, name)), legacy[name], name);
	assert.ok(!f.calls.some((call) => /^systemctl --user (enable|disable|stop|kill|try-restart)/.test(call)), f.calls.join("\n"));

	f.lines.length = 0;
	f.calls.length = 0;
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.deepEqual([configOf(f)?.viewer_host, configOf(f)?.parent_model], ["100.80.0.1", "openai/gpt-6.1-sol"], "pins kept from the legacy units");
	assert.ok(f.calls.includes(`systemctl --user disable --now ${PARENT_UNIT}`) && f.calls.includes(`systemctl --user enable --now ${DAEMON_UNIT}`), f.calls.join("\n"));
	assert.ok(!f.calls.some((call) => /^systemctl --user (stop|kill)/.test(call)), "never stop or kill: the parent host keeps running");
	assert.ok(!f.calls.some((call) => call.includes("cp-operator")), "no command touches the operator units: the tmux session survives");
	for (const name of Object.keys(legacy)) assert.ok(!f.files.has(join(unitDir, name)), `${name} removed`);
	assert.ok(f.files.has(thinUnit(f)));
	assert.ok(f.lines.some((line) => line.startsWith(`changed: migrate: ${DAEMON_UNIT} runs the parent supervisor and the viewer`)), f.lines.join("\n"));
});

/** A legacy home (the six generated units, pins in cp-view/cp-parent.service) in `f`; returns the files as written. */
function legacyHome(f: Fake): Record<string, string> {
	const user = f.ports.env.HOME!;
	const legacy = renderUnits({ node: "/opt/node/bin/node", app: join(user, ".pi-command-post/app"), home: homeOf(f), path: "/bin", port: 8766, viewerHost: "100.80.0.1", parentModel: "openai/gpt-6.1-sol" });
	for (const [name, text] of Object.entries(legacy)) f.files.set(join(installTargets(f.ports.env).unitDir, name), text);
	f.ifaces = HOSTS;
	return legacy;
}

/** The refused legacy install left nothing of cp-daemon's behind and the legacy units as they were. */
function legacyUntouched(f: Fake, legacy: Record<string, string>): void {
	assert.equal(f.files.has(configFile(f)), false, "no data/daemon.json beside the running legacy units");
	assert.equal(f.files.has(thinUnit(f)), false, "no cp-daemon.service");
	for (const name of Object.keys(legacy)) assert.equal(f.files.get(join(installTargets(f.ports.env).unitDir, name)), legacy[name], name);
	assert.ok(!f.calls.some((call) => /^systemctl --user (daemon-reload|enable|disable|stop|kill|try-restart)/.test(call)), f.calls.join("\n"));
}

test("install on a legacy home: a wrapper that differs (no --force) is refused before anything is written", async (t) => {
	const f = fake(scratch(t));
	const legacy = legacyHome(f);
	const wrapper = join(installTargets(f.ports.env).binDir, "cp-operator");
	f.files.set(wrapper, "#!/bin/sh\n# hand-edited\n");
	assert.equal(await install(flags(f.ports.env.HOME!), f.ports), 1, f.lines.join("\n"));
	assert.ok(f.lines.includes(`fail: wrapper: ${wrapper} differs from what this install renders; rerun with --force to replace it`), f.lines.join("\n"));
	assert.ok(f.lines.includes(`skip: daemon: ${configFile(f)} not written: another file was refused, so nothing is written`), f.lines.join("\n"));
	assert.equal(f.files.get(wrapper), "#!/bin/sh\n# hand-edited\n", "the user's wrapper is kept");
	legacyUntouched(f, legacy);
});

test("install on a legacy home: refused linger stops before anything is written", async (t) => {
	const f = fake(scratch(t), { "loginctl show-user": { stdout: "Linger=no\n" }, "loginctl enable-linger": { status: 1 } });
	const legacy = legacyHome(f);
	assert.equal(await install(flags(f.ports.env.HOME!), f.ports), 1, f.lines.join("\n"));
	assert.ok(f.lines.includes("fail: linger: loginctl enable-linger refused; run: sudo loginctl enable-linger u"), f.lines.join("\n"));
	assert.equal(f.files.has(join(installTargets(f.ports.env).binDir, "cp-operator")), false, "no wrapper either");
	legacyUntouched(f, legacy);
});

test("install on a legacy home (cp-rrye): the generated cp-operator*.service go only at M1's success (S8) — a refused preflight or a rolled-back M1 keeps them; a hand-written one always stays; none is ever stopped", async (t) => {
	/** A legacy home whose older install also wrote the operator units (tmux on PATH then). */
	const withOperator = (f: Fake) => {
		const user = f.ports.env.HOME!;
		const { unitDir, binDir } = installTargets(f.ports.env);
		const legacy = legacyHome(f);
		const old = renderUnits({ node: "/opt/node/bin/node", app: join(user, ".pi-command-post/app"), home: homeOf(f), path: "/bin", port: 8766, tmux: "/usr/bin/tmux", wrapper: join(binDir, "cp-operator") });
		const operator = { [OPERATOR_UNIT]: old[OPERATOR_UNIT]!, [OPERATOR_RESUME_UNIT]: old[OPERATOR_RESUME_UNIT]! };
		for (const [name, text] of Object.entries(operator)) f.files.set(join(unitDir, name), text);
		return { legacy, operator, unitDir };
	};
	const kept = (f: Fake, unitDir: string, operator: Record<string, string>) => {
		for (const [name, text] of Object.entries(operator)) assert.equal(f.files.get(join(unitDir, name)), text, `${name} kept`);
		assert.ok(!f.lines.some((line) => line.includes("removed") && line.includes("cp-operator")), f.lines.join("\n"));
		assert.ok(!f.calls.some((call) => call.includes("cp-operator")), "no command touches the operator units");
	};

	// Preflight refusal (an update run in flight): nothing changed, the operator units included.
	const refused = fake(scratch(t), { "systemctl --user is-active cp-update.service": { stdout: "active\n" } });
	const r = withOperator(refused);
	assert.equal(await install(flags(refused.ports.env.HOME!), refused.ports), 1, refused.lines.join("\n"));
	assert.ok(refused.lines.some((line) => line.startsWith("fail: migrate: an update run is in flight") && line.endsWith("nothing was changed")), refused.lines.join("\n"));
	legacyUntouched(refused, r.legacy);
	kept(refused, r.unitDir, r.operator);

	// M1 rolled back (cp-daemon.service does not start): the legacy units are re-enabled and the operator units stay.
	const rolled = fake(scratch(t), { [`systemctl --user enable --now ${DAEMON_UNIT}`]: { status: 1, stderr: "boom" } });
	const b = withOperator(rolled);
	await install(flags(rolled.ports.env.HOME!), rolled.ports);
	assert.ok(rolled.lines.some((line) => line.startsWith("fail: migrate: ") && line.includes("rolled back")), rolled.lines.join("\n"));
	for (const name of Object.keys(b.legacy)) assert.ok(rolled.files.has(join(b.unitDir, name)), `${name} kept by the rollback`);
	kept(rolled, b.unitDir, b.operator);

	// M1 succeeds: the generated operator units go with the legacy ones (S8), unstopped; a hand-written one stays.
	const ok = fake(scratch(t));
	const s = withOperator(ok);
	const mine = "[Service]\nExecStart=/usr/bin/tmux new-session -d -s mine\n";
	ok.files.set(join(s.unitDir, OPERATOR_RESUME_UNIT), mine);
	assert.equal(await install(flags(ok.ports.env.HOME!), ok.ports), 0, ok.lines.join("\n"));
	assert.ok(!ok.files.has(join(s.unitDir, OPERATOR_UNIT)), "the generated cp-operator.service removed");
	assert.equal(ok.files.get(join(s.unitDir, OPERATOR_RESUME_UNIT)), mine, "the hand-written one stays");
	assert.ok(ok.lines.some((line) => line.startsWith(`changed: migrate: ${DAEMON_UNIT} runs the parent supervisor and the viewer; removed `) && line.includes(`${OPERATOR_UNIT} (the parent host kept running; the operator units never stopped)`)), ok.lines.join("\n"));
	assert.ok(!ok.calls.some((call) => call.includes("cp-operator")), "no command touches the operator units: the tmux session survives");
});

test("install: a home WorkingDirectory= cannot carry is a clear fail, not a crash", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	assert.equal(await install(flags(user, { home: join(user, "my home") }), f.ports), 1);
	assert.ok(f.lines.some((line) => line.startsWith("fail: unit: WorkingDirectory= cannot carry")), f.lines.join("\n"));
	assert.deepEqual(f.calls, [], "nothing ran");
});

test("install: right after npm ci the hidden lockfile (other platforms' optional packages absent) reads as fresh", async (t) => {
	const user = scratch(t);
	const f = fake(user);
	const app = join(user, ".pi-command-post/app");
	const lock = { packages: { "": { name: "x" }, "node_modules/a": { version: "1" }, "node_modules/@esbuild/darwin-arm64": { version: "0.25.0", optional: true, os: ["darwin"] } } };
	f.files.set(join(app, "package-lock.json"), JSON.stringify(lock));
	f.files.set(join(app, "node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1" } } }));
	assert.equal(await install(flags(user, { "dry-run": true }), f.ports), 0);
	assert.ok(f.lines.includes("ok: npm: node_modules matches package-lock.json"), f.lines.join("\n"));

	for (const installed of [{}, { "node_modules/a": { version: "2" } }, { "node_modules/a": { version: "1" }, "node_modules/stray": { version: "1" } }]) {
		f.lines.length = 0;
		f.files.set(join(app, "node_modules/.package-lock.json"), JSON.stringify({ packages: installed }));
		await install(flags(user, { "dry-run": true }), f.ports);
		assert.ok(f.lines.some((line) => line.startsWith("changed: npm: would run npm ci")), `${JSON.stringify(installed)}\n${f.lines.join("\n")}`);
	}
});

test("install: the pi-lens tools are tool-manifest's list, shared with doctor; a sudo prefix prints the fix and runs nothing", async (t) => {
	const doctor = readFileSync(join(REPO_ROOT, "src/doctor.ts"), "utf8");
	assert.ok(doctor.includes("PI_LENS_TOOLS.commands") && doctor.includes("PI_LENS_TOOLS.packages") && !doctor.includes("@ast-grep/cli"), "doctor reads the one list");
	const user = scratch(t);
	const f = fake(user, { "ast-grep --version": { status: 127 } });
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.ok(f.calls.includes(`npm i -g ${PI_LENS_TOOLS.packages.join(" ")}`), f.calls.join("\n"));

	const locked = fake(scratch(t), { "ast-grep --version": { status: 127 }, "npm prefix -g": { stdout: "/usr\n" } });
	locked.ports.writable = () => false;
	assert.equal(await install(flags(locked.ports.env.HOME!), locked.ports), 1);
	assert.ok(!locked.calls.some((call) => call.startsWith("npm i ")), "not run");
	assert.ok(locked.lines.some((line) => line.startsWith("fail: pi-lens: npm's global prefix /usr needs sudo") && line.includes("npm config set prefix")));
	assert.ok(locked.calls.every((call) => !/\bsudo\b/.test(call)));
});

test("install: node 24 or newer passes, older prints the fix", async (t) => {
	const newer = fake(scratch(t));
	newer.ports.node.version = "v25.1.0";
	assert.equal(await install(flags(newer.ports.env.HOME!), newer.ports), 0);
	const older = fake(scratch(t));
	older.ports.node.version = "v22.1.0";
	assert.equal(await install(flags(older.ports.env.HOME!), older.ports), 1);
	assert.ok(older.lines.some((line) => line.startsWith("fail: node:") && line.includes("node 24 or newer")));
});

/** A fake `git` (clone writes a stub install.ts that records its argv) and a `node` that runs it. */
function fakeGit(dir: string, origin: string): { env: NodeJS.ProcessEnv; argvFile: string } {
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const argvFile = join(dir, "argv");
	writeFileSync(join(bin, "git"), [
		"#!/bin/sh",
		`echo "$*" >> ${JSON.stringify(join(dir, "git.log"))}`,
		'if [ "$1" = clone ]; then for last; do :; done; mkdir -p "$last/.git" "$last/src/service"',
		`  printf 'import { appendFileSync } from "node:fs"; appendFileSync(%s, JSON.stringify(process.argv.slice(2)) + "\\\\n");\\n' ${JSON.stringify(JSON.stringify(argvFile))} > "$last/src/service/install.ts"; exit 0; fi`,
		'case "$*" in',
		`  *"remote get-url origin"*) echo ${JSON.stringify(origin)} ;;`,
		"  *rev-parse\\ --abbrev-ref*) echo main ;;",
		"  *status\\ --porcelain*) ;;",
		"  *rev-list*) echo 0 ;;",
		"  *rev-parse\\ HEAD*|*rev-parse\\ origin/main*) echo abc ;;",
		"esac",
		"",
	].join("\n"));
	chmodSync(join(bin, "git"), 0o755);
	return { env: { ...process.env, HOME: dir, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CP_REPO_URL: "https://example.invalid/cp.git" }, argvFile };
}

test("install.sh: clones the code to ~/.pi-command-post/app when absent, then execs its install.ts with the flags", (t) => {
	const dir = scratch(t);
	const { env, argvFile } = fakeGit(dir, "https://example.invalid/cp.git");
	const out = execFileSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--no-start", "--port", "9000"], { env, encoding: "utf8" });
	assert.match(out, /changed: code: cloned https:\/\/example\.invalid\/cp\.git into .*\.pi-command-post\/app/);
	assert.match(readFileSync(join(dir, "git.log"), "utf8"), /^clone --branch main https:\/\/example\.invalid\/cp\.git .*\/\.pi-command-post\/app$/m);
	assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), ["--no-start", "--port", "9000"]);
	// Second run: the checkout exists, is clean and at origin/main.
	const again = execFileSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--no-start"], { env, encoding: "utf8" });
	assert.match(again, /ok: code: .* is at origin\/main/);
	assert.doesNotMatch(readFileSync(join(dir, "git.log"), "utf8").split("\n").slice(1).join("\n"), /clone|merge/);
});

test("install.sh: an existing checkout with another origin is refused; --dry-run with no checkout clones nothing", (t) => {
	const dir = scratch(t);
	const { env } = fakeGit(dir, "https://elsewhere.invalid/x.git");
	mkdirSync(join(dir, ".pi-command-post/app/.git"), { recursive: true });
	const refused = spawnSync("sh", [join(REPO_ROOT, "scripts/install.sh")], { env, encoding: "utf8" });
	assert.equal(refused.status, 1);
	assert.match(refused.stdout, /fail: code: .* has origin 'https:\/\/elsewhere\.invalid\/x\.git'/);

	const fresh = scratch(t);
	const dry = fakeGit(fresh, "https://example.invalid/cp.git");
	const app = join(fresh, "app");
	const result = spawnSync("sh", ["-c", `cat ${JSON.stringify(join(REPO_ROOT, "scripts/install.sh"))} | sh -s -- --dry-run --app ${JSON.stringify(app)}`], { env: dry.env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /changed: code: would git clone .* \(dry-run\)/);
	assert.equal(existsSync(app), false);
});

test("install.sh: a checkout with no node_modules runs npm ci before install.ts imports a package; a current one is left alone", (t) => {
	const dir = scratch(t);
	const { env, argvFile } = fakeGit(dir, "https://example.invalid/cp.git");
	const app = join(dir, ".pi-command-post/app");
	mkdirSync(join(app, ".git"), { recursive: true });
	mkdirSync(join(app, "src/service"), { recursive: true });
	writeFileSync(join(app, "package-lock.json"), "{}");
	writeFileSync(join(app, "src/service/install.ts"), `import "fake-dep"; import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	const npmLog = join(dir, "npm.log");
	writeFileSync(join(dir, "bin/npm"), [
		"#!/bin/sh",
		`echo "$*" >> ${JSON.stringify(npmLog)}`,
		"mkdir -p node_modules/fake-dep && echo '{\"name\":\"fake-dep\",\"main\":\"index.js\"}' > node_modules/fake-dep/package.json",
		": > node_modules/fake-dep/index.js && echo '{}' > node_modules/.package-lock.json",
		"",
	].join("\n"));
	chmodSync(join(dir, "bin/npm"), 0o755);
	const npmCalls = () => (existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n") : []);

	const dry = spawnSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--dry-run", "--no-start"], { env, encoding: "utf8" });
	assert.match(dry.stdout, /changed: code: would run npm ci in .*app \(dry-run\)/);
	assert.deepEqual(npmCalls(), [], "dry-run runs no npm");

	const first = spawnSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--no-start"], { env, encoding: "utf8" });
	assert.equal(first.status, 0, first.stdout + first.stderr);
	assert.match(first.stdout, /changed: code: npm ci in .*app/);
	assert.deepEqual(npmCalls(), ["ci --no-audit --no-fund --loglevel=error"]);
	assert.match(readFileSync(argvFile, "utf8"), /\["--no-start"\]/, "install.ts got past its imports");

	const again = spawnSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--no-start"], { env, encoding: "utf8" });
	assert.equal(again.status, 0, again.stdout + again.stderr);
	assert.match(again.stdout, /ok: code: .*node_modules is current/);
	assert.equal(npmCalls().length, 1, "a current node_modules is not reinstalled");
});

test("bin/cp-install is the same one command: it forwards every flag to scripts/install.sh", (t) => {
	const dir = scratch(t);
	const { env } = fakeGit(dir, "https://example.invalid/cp.git");
	const app = join(dir, "app");
	const home = join(dir, "home");
	const run = spawnSync(join(REPO_ROOT, "bin/cp-install"), ["--dry-run", "--app", app, "--home", home], { env, encoding: "utf8" });
	assert.ok(run.stdout.includes(`changed: code: would git clone --branch main https://example.invalid/cp.git ${app} (dry-run)`), run.stdout + run.stderr);
	assert.match(run.stdout, /^ok: node: /m, "the dry-run went on into install.ts");
	assert.equal(existsSync(app), false);
	assert.equal(existsSync(home), false, "dry-run created nothing");
	// Every flag reaches install.ts: one it does not know is refused there, by name.
	const bogus = spawnSync(join(REPO_ROOT, "bin/cp-install"), ["--dry-run", "--app", app, "--bogus"], { env, encoding: "utf8" });
	assert.notEqual(bogus.status, 0);
	assert.match(bogus.stderr, /--bogus/);
});

const BOOTSTRAP = join(REPO_ROOT, "bin/cp-bootstrap");

test("bin/cp-bootstrap: POSIX sh, at most 60 lines, shellcheck-clean when shellcheck is here", (t) => {
	assert.equal(spawnSync("sh", ["-n", BOOTSTRAP]).status, 0);
	assert.ok(readFileSync(BOOTSTRAP, "utf8").trimEnd().split("\n").length <= 60);
	const check = spawnSync("shellcheck", ["-s", "sh", BOOTSTRAP], { encoding: "utf8" });
	if (check.error) return t.skip("shellcheck is not installed");
	assert.equal(check.status, 0, check.stdout);
});

test("bin/cp-bootstrap --dry-run in a scratch HOME clones nothing; old node and a dirty checkout are refused", (t) => {
	const dir = scratch(t);
	const env = { HOME: dir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
	const dry = spawnSync("sh", ["-c", `cat ${JSON.stringify(BOOTSTRAP)} | sh -s -- --dry-run`], { env, encoding: "utf8" });
	assert.equal(dry.status, 0, dry.stdout + dry.stderr);
	assert.match(dry.stdout, /^ok: bootstrap: git and node v\d+/m);
	assert.match(dry.stdout, /changed: bootstrap: would git clone --branch main https:\/\/github\.com\/0xb1ob\/picp\.git .*\/\.pi-command-post\/app, npm ci, then bin\/cp-install \(dry-run\)/);
	assert.equal(existsSync(join(dir, ".pi-command-post")), false, "nothing written");

	const bin = join(dir, "oldnode");
	mkdirSync(bin);
	writeFileSync(join(bin, "node"), '#!/bin/sh\ncase "$1" in -p) echo 22 ;; *) echo v22.1.0 ;; esac\n');
	chmodSync(join(bin, "node"), 0o755);
	const old = spawnSync("sh", [BOOTSTRAP], { env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
	assert.equal(old.status, 1);
	assert.match(old.stdout, /fail: bootstrap: node v22\.1\.0 is older than 24; install node 24 or newer/);

	const app = join(dir, "app");
	mkdirSync(app);
	execFileSync("git", ["init", "-q", "-b", "main", app]);
	writeFileSync(join(app, "dirty"), "x");
	const dirty = spawnSync("sh", [BOOTSTRAP, "--dry-run"], { env: { ...env, CP_APP: app }, encoding: "utf8" });
	assert.equal(dirty.status, 1);
	assert.match(dirty.stdout, /fail: bootstrap: .*app has uncommitted changes/);
	assert.deepEqual(readFileSync(join(app, "dirty"), "utf8"), "x", "left as is");
});

test("bin/cp-bootstrap: a second run on an up-to-date checkout is all ok and never reruns npm ci", (t) => {
	const dir = scratch(t);
	const env = { HOME: dir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1" };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8" });
	const seed = join(dir, "seed");
	mkdirSync(join(seed, "bin"), { recursive: true });
	writeFileSync(join(seed, "bin/cp-install"), `#!/bin/sh\necho "cp-install $*"\n`);
	writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
	git(dir, "init", "-q", "-b", "main", seed);
	git(seed, "add", ".");
	git(seed, "commit", "-qm", "seed");
	const app = join(dir, "app");
	git(dir, "clone", "-q", "--branch", "main", seed, app);
	mkdirSync(join(app, "node_modules"));
	writeFileSync(join(app, "node_modules/.package-lock.json"), "{}");
	const again = spawnSync("sh", [BOOTSTRAP, "--no-start"], { env: { ...env, CP_APP: app }, encoding: "utf8" });
	assert.equal(again.status, 0, again.stdout + again.stderr);
	const statuses = again.stdout.split("\n").filter((line) => /^\w+: bootstrap: /.test(line)).map((line) => line.split(":")[0]);
	assert.deepEqual([...new Set(statuses)], ["ok"], again.stdout);
	assert.doesNotMatch(again.stdout, /npm ci/);
	assert.match(again.stdout, new RegExp(`^cp-install --app ${app} --no-start$`, "m"), "execs cp-install with every flag");
});

// cp-er76: step 3c (models) and step 7b (the optional gateway).
const LISTED = ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"];
const LIST_CALL = "pi --no-extensions --list-models";
const LISTING = { [LIST_CALL]: { stdout: `provider      model            context  max-out  thinking  images\n${LISTED.map((ref) => ref.replace("/", "  ")).join("\n")}\n` } };
/** data/daemon.json's text ("" when absent): where cp-daemon's parent model is pinned. */
const configText = (f: Fake) => f.files.get(configFile(f)) ?? "";
const wrapperOf = (f: Fake) => f.files.get(join(installTargets(f.ports.env).binDir, "cp-operator")) ?? "";
const pinsParent = (f: Fake, model: string) => configOf(f)?.parent_model === model;
const exportsOf = (f: Fake) => wrapperOf(f).split("\n").find((line) => line.startsWith("export ")) ?? "";
const modelQuestions = (f: Fake) => f.questions.filter((q) => q.startsWith("Model for"));
/** A fake with pi's listing and the shipped rubric in its app. */
function modelFake(user: string, answers: Record<string, Partial<RunResult>> = LISTING): Fake {
	const f = fake(user, answers);
	f.files.set(join(user, ".pi-command-post/app/defaults/routing.default.json"), readFileSync(join(REPO_ROOT, "defaults/routing.default.json"), "utf8"));
	return f;
}
const snapshot = (f: Fake) => new Map([...f.files].filter(([path]) => path.startsWith(installTargets(f.ports.env).unitDir) || path.startsWith(installTargets(f.ports.env).binDir) || path === configFile(f)));

test("install, fresh and prompting: one model question for both sessions; empty takes the recommendation, a number or a listed ref picks, none pins nothing, anything else fails and writes nothing", async (t) => {
	for (const [reply, want] of [["", "anthropic/claude-opus-5-5"], ["2", "openai/gpt-6.1-sol"], ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"]] as const) {
		const user = scratch(t);
		const f = modelFake(user);
		f.replies.push(reply);
		assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
		const asked = modelQuestions(f);
		assert.equal(asked.length, 1, f.questions.join("\n---\n"));
		assert.match(asked[0]!, /^Model for the parent and the operator session/);
		assert.match(asked[0]!, /\n {2}1\) anthropic\/claude-opus-5-5 +recommended: in the routing rubric\n/);
		assert.ok(pinsParent(f, want), configText(f));
		assert.ok(exportsOf(f).endsWith(` CP_PARENT_MODEL='${want}' CP_OPERATOR_MODEL='${want}'`), exportsOf(f));
	}
	const none = modelFake(scratch(t));
	none.replies.push("none");
	assert.equal(await install(flags(none.ports.env.HOME!), none.ports), 0, none.lines.join("\n"));
	assert.doesNotMatch(configText(none) + wrapperOf(none), /parent_model|CP_PARENT_MODEL|CP_OPERATOR_MODEL/);
	const bad = modelFake(scratch(t));
	bad.replies.push("x/y");
	assert.equal(await install(flags(bad.ports.env.HOME!), bad.ports), 1);
	assert.ok(bad.lines.some((line) => line.startsWith("fail: model: x/y is not a model pi can use")), bad.lines.join("\n"));
	assert.equal(configText(bad) + wrapperOf(bad), "", "no data/daemon.json, no wrapper");
});

test("install: the parent's own default model is recommended ahead of the rubric when pi lists it; the listing runs with cp-daemon's env", async (t) => {
	const user = scratch(t);
	const saved = modelFake(user);
	const home = join(user, ".pi-command-post");
	saved.files.set(join(home, layoutForHome("multi", home).sessions, "cp-parent-control.json"), JSON.stringify({ model: "openai/gpt-6.1-sol" }));
	saved.ports.env.ANTHROPIC_API_KEY = "sk-shell-only";
	assert.equal(await install(flags(user, { yes: true }), saved.ports), 0, saved.lines.join("\n"));
	assert.deepEqual(saved.questions, []);
	assert.ok(saved.lines.includes("changed: model: parent openai/gpt-6.1-sol (recommended: the parent's current model (cp-parent-control.json); --parent-model overrides)"), saved.lines.join("\n"));
	assert.ok(saved.lines.includes("changed: model: operator openai/gpt-6.1-sol (recommended: the parent's current model (cp-parent-control.json); --operator-model overrides)"), saved.lines.join("\n"));
	assert.ok(pinsParent(saved, "openai/gpt-6.1-sol"));
	assert.deepEqual(saved.envs.get(LIST_CALL), { HOME: user, USER: "u", PATH: `/opt/node/bin:${join(user, ".local/bin")}` }, "no shell-only provider key");

	const env = modelFake(scratch(t));
	env.ports.env.CP_PARENT_MODEL = "openai-codex/gpt-6.1-sol";
	env.replies.push("");
	assert.equal(await install(flags(env.ports.env.HOME!), env.ports), 0, env.lines.join("\n"));
	assert.match(modelQuestions(env)[0] ?? "", /1\) openai-codex\/gpt-6\.1-sol +recommended: the parent's default/);
	assert.ok(pinsParent(env, "openai-codex/gpt-6.1-sol"));

	const unlisted = modelFake(scratch(t));
	unlisted.ports.env.CP_PARENT_MODEL = "openai/not-logged-in";
	assert.equal(await install(flags(unlisted.ports.env.HOME!, { yes: true }), unlisted.ports), 0);
	assert.ok(pinsParent(unlisted, "anthropic/claude-opus-5-5"), "an unlisted default is never recommended; the rubric follows");
});

test("install --parent-model / --operator-model win; on a fresh install one flag sets both; an unlisted flag fails; an empty listing writes the flag with a note", async (t) => {
	const one = modelFake(scratch(t));
	assert.equal(await install(flags(one.ports.env.HOME!, { "parent-model": "openai/gpt-6.1-sol" }), one.ports), 0, one.lines.join("\n"));
	assert.deepEqual(modelQuestions(one), []);
	assert.ok(pinsParent(one, "openai/gpt-6.1-sol"));
	assert.ok(exportsOf(one).endsWith(" CP_PARENT_MODEL='openai/gpt-6.1-sol' CP_OPERATOR_MODEL='openai/gpt-6.1-sol'"), exportsOf(one));

	const two = modelFake(scratch(t));
	assert.equal(await install(flags(two.ports.env.HOME!, { "parent-model": "openai/gpt-6.1-sol", "operator-model": "anthropic/claude-opus-5-5" }), two.ports), 0);
	assert.ok(pinsParent(two, "openai/gpt-6.1-sol"));
	assert.ok(exportsOf(two).endsWith(" CP_PARENT_MODEL='openai/gpt-6.1-sol' CP_OPERATOR_MODEL='anthropic/claude-opus-5-5'"), exportsOf(two));

	const unlisted = modelFake(scratch(t));
	assert.equal(await install(flags(unlisted.ports.env.HOME!, { "operator-model": "x/y" }), unlisted.ports), 1);
	assert.ok(unlisted.lines.some((line) => line.startsWith("fail: model: x/y (--operator-model) is not a model pi can use")), unlisted.lines.join("\n"));
	assert.equal(configText(unlisted), "");

	const empty = modelFake(scratch(t), { [LIST_CALL]: { stdout: "No models available. Use /login or set an API key environment variable.\n" } });
	assert.equal(await install(flags(empty.ports.env.HOME!, { "parent-model": "x/y" }), empty.ports), 0, empty.lines.join("\n"));
	assert.ok(empty.lines.includes("skip: model: parent x/y (--parent-model) written unchecked: pi's model list is empty"), empty.lines.join("\n"));
	assert.ok(pinsParent(empty, "x/y"));
});

test("install: no usable model says run pi then /login and pins nothing; the login step is unchanged", async (t) => {
	const f = modelFake(scratch(t), { [LIST_CALL]: { stdout: "No models available. Use /login or set an API key environment variable.\n" } });
	assert.equal(await install(flags(f.ports.env.HOME!), f.ports), 0, f.lines.join("\n"));
	const line = f.lines.find((l) => l.startsWith("skip: model: no model pi can use as the service sees it (")) ?? "";
	assert.match(line, /auth\.json.*run `pi`, then \/login, then rerun cp-install/, f.lines.join("\n"));
	assert.deepEqual(modelQuestions(f), []);
	assert.doesNotMatch(configText(f) + wrapperOf(f), /parent_model|CP_PARENT_MODEL|CP_OPERATOR_MODEL/);
	assert.ok(f.lines.some((l) => l.startsWith("skip: login: no provider")));
});

test("install: a rerun keeps every pin unasked and byte-identical; --force re-opens only an unpinned choice", async (t) => {
	const user = scratch(t);
	const f = modelFake(user);
	f.replies.push("2");
	assert.equal(await install(flags(user), f.ports), 0);
	const before = snapshot(f);
	f.lines.length = 0;
	f.questions.length = 0;
	f.calls.length = 0;
	assert.equal(await install(flags(user), f.ports), 0);
	assert.deepEqual(modelQuestions(f), []);
	assert.deepEqual(f.lines.filter((line) => line.includes(": model:")), ["ok: model: parent openai/gpt-6.1-sol kept", "ok: model: operator openai/gpt-6.1-sol kept"]);
	assert.deepEqual(notOk(f), [], f.lines.join("\n"));
	assert.deepEqual(snapshot(f), before);
	assert.ok(!f.calls.includes(LIST_CALL), "nothing to choose: no listing");
	assert.equal(await install(flags(user, { force: true, yes: true }), f.ports), 0);
	assert.deepEqual(snapshot(f), before, "--force never re-asks a pinned choice");

	const unpinned = modelFake(scratch(t));
	unpinned.replies.push("none");
	assert.equal(await install(flags(unpinned.ports.env.HOME!), unpinned.ports), 0);
	const plain = snapshot(unpinned);
	unpinned.lines.length = 0;
	assert.equal(await install(flags(unpinned.ports.env.HOME!), unpinned.ports), 0);
	assert.ok(unpinned.lines.includes("skip: model: parent: none pinned; --force asks, --parent-model <provider/model> --force pins one"), unpinned.lines.join("\n"));
	assert.deepEqual(snapshot(unpinned), plain);
	assert.equal(await install(flags(unpinned.ports.env.HOME!, { force: true, yes: true }), unpinned.ports), 0, unpinned.lines.join("\n"));
	assert.ok(pinsParent(unpinned, "anthropic/claude-opus-5-5"));
	assert.ok(exportsOf(unpinned).endsWith(" CP_PARENT_MODEL='anthropic/claude-opus-5-5' CP_OPERATOR_MODEL='anthropic/claude-opus-5-5'"));
});

test("install: an existing install that pinned only data/daemon.json (older wrapper) stays byte-identical", async (t) => {
	const user = scratch(t);
	const f = modelFake(user);
	assert.equal(await install(flags(user, { "parent-model": "openai/gpt-6.1-sol", "operator-model": "openai/gpt-6.1-sol" }), f.ports), 0);
	const wrapper = join(installTargets(f.ports.env).binDir, "cp-operator");
	f.files.set(wrapper, wrapperOf(f).replace(" CP_PARENT_MODEL='openai/gpt-6.1-sol' CP_OPERATOR_MODEL='openai/gpt-6.1-sol'", ""));
	const before = snapshot(f);
	f.lines.length = 0;
	assert.equal(await install(flags(user), f.ports), 0, f.lines.join("\n"));
	assert.deepEqual(notOk(f), [], f.lines.join("\n"));
	assert.deepEqual(snapshot(f), before);
});

const KEY = "k3y-VALUE";
const capacityOf = (f: Fake) => {
	const home = join(f.ports.env.HOME!, ".pi-command-post");
	return join(home, layoutForHome("multi", home).data, "capacity.json");
};
const keyFileOf = (f: Fake) => gatewayKeyFile(f.ports.env)!;
/** A fake whose user holds the admin key in `~/gw-key`. */
function gatewayFake(user: string): Fake {
	const f = fake(user);
	f.files.set(join(user, "gw-key"), `${KEY}\n`);
	return f;
}
const leaks = (f: Fake) => [...f.lines, ...f.calls, ...f.files.entries()].filter((entry) => (Array.isArray(entry) ? entry[0] !== keyFileOf(f) && entry[0] !== join(f.ports.env.HOME!, "gw-key") && entry[1].includes(KEY) : entry.includes(KEY)));

test("install: the gateway is opt-in — no flags skips with the add-later line; the flags write capacity.json and a 0600 key file, never printing the key or touching a unit", async (t) => {
	const plain = fake(scratch(t));
	assert.equal(await install(flags(plain.ports.env.HOME!), plain.ports), 0);
	assert.ok(plain.lines.includes("skip: gateway: not set up (optional: capacity-aware routing through a sub2api gateway); add it later: cp-install --gateway-url https://<gateway> --gateway-key-file <file>"), plain.lines.join("\n"));
	assert.ok(!plain.files.has(capacityOf(plain)));

	const user = scratch(t);
	const f = gatewayFake(user);
	assert.equal(await install(flags(user, { yes: true, "gateway-url": "https://gw.example", "gateway-key-file": join(user, "gw-key") }), f.ports), 0, f.lines.join("\n"));
	const capacity = f.files.get(capacityOf(f))!;
	assert.deepEqual(JSON.parse(capacity), { url: "https://gw.example/", path: "/api/v1/admin/ops/concurrency" });
	assert.equal(f.modes.get(capacityOf(f)), 0o600);
	assert.deepEqual(f.secrets, [keyFileOf(f)]);
	assert.equal(keyFileOf(f), join(user, ".config/pi-command-post/gateway.env"));
	assert.match(f.files.get(keyFileOf(f))!, new RegExp(`^CP_GATEWAY_ADMIN_KEY=${KEY}$`, "m"));
	assert.deepEqual(leaks(f), [], "the key is in no line, no argv, no unit, no wrapper");
	const real = scratch(t);
	const data = join(real, layoutForHome("multi", real).data);
	mkdirSync(data, { recursive: true });
	writeFileSync(join(data, "capacity.json"), capacity);
	configureLayout("multi", real);
	assert.equal(loadCapacityConfig(real).endpoint, "https://gw.example/api/v1/admin/ops/concurrency");

	const before = snapshot(f);
	f.lines.length = 0;
	assert.equal(await install(flags(user), f.ports), 0);
	assert.ok(f.lines.includes(`ok: gateway: ${capacityOf(f)} kept`) && f.lines.includes(`ok: gateway-key: ${keyFileOf(f)} kept`), f.lines.join("\n"));
	assert.deepEqual(snapshot(f), before, "no unit changes");
});

test("install --gateway-url: not https, userinfo, a path or a query fail; no obtainable key fails naming --gateway-key-file; nothing is written", async (t) => {
	for (const url of ["http://gw.example", "https://u:p@gw.example", "https://gw.example/x", "https://gw.example/?q=1", "gw.example"]) {
		const user = scratch(t);
		const f = gatewayFake(user);
		assert.equal(await install(flags(user, { yes: true, "gateway-url": url, "gateway-key-file": join(user, "gw-key") }), f.ports), 1, url);
		assert.ok(f.lines.some((line) => line.startsWith("fail: gateway: ") && line.endsWith("; nothing written")), f.lines.join("\n"));
		assert.ok(!f.files.has(capacityOf(f)) && f.secrets.length === 0, url);
	}
	const user = scratch(t);
	const f = gatewayFake(user);
	assert.equal(await install(flags(user, { yes: true, "gateway-url": "https://gw.example" }), f.ports), 1);
	assert.ok(f.lines.some((line) => line.startsWith("fail: gateway: --gateway-url needs the admin key") && line.includes("--gateway-key-file")), f.lines.join("\n"));
	assert.ok(!f.files.has(capacityOf(f)) && f.secrets.length === 0);
	f.files.set(join(user, "bad-key"), "k3y with space\n");
	f.lines.length = 0;
	assert.equal(await install(flags(user, { yes: true, "gateway-url": "https://gw.example", "gateway-key-file": join(user, "bad-key") }), f.ports), 1);
	assert.ok(f.lines.some((line) => line.includes("holds whitespace") && !line.includes("k3y with space")), f.lines.join("\n"));
	assert.ok(!f.files.has(capacityOf(f)) && f.secrets.length === 0);
});

test("install: an existing gateway is kept; another url needs --force (other keys kept); a loose key file is tightened; --dry-run writes nothing; --uninstall keeps the key file", async (t) => {
	const user = scratch(t);
	const f = gatewayFake(user);
	const keyFlags = { "gateway-key-file": join(user, "gw-key") };
	assert.equal(await install(flags(user, { yes: true, "gateway-url": "https://gw.example", ...keyFlags }), f.ports), 0);
	f.files.set(capacityOf(f), `${JSON.stringify({ url: "https://gw.example/", path: "/api/v1/admin/ops/concurrency", quota: { five_hour: 80 } })}\n`);
	f.lines.length = 0;
	assert.equal(await install(flags(user, { "gateway-url": "https://gw2.example" }), f.ports), 1);
	assert.ok(f.lines.some((line) => line.startsWith(`fail: gateway: ${capacityOf(f)} names https://gw.example/; rerun with --force`)), f.lines.join("\n"));
	assert.equal(await install(flags(user, { force: true, "gateway-url": "https://gw2.example" }), f.ports), 0);
	assert.deepEqual(JSON.parse(f.files.get(capacityOf(f))!), { url: "https://gw2.example/", path: "/api/v1/admin/ops/concurrency", quota: { five_hour: 80 } });
	f.files.set(join(user, "gw-key2"), "other-k3y\n");
	f.lines.length = 0;
	assert.equal(await install(flags(user, { "gateway-key-file": join(user, "gw-key2") }), f.ports), 1);
	assert.ok(f.lines.some((line) => line.startsWith(`fail: gateway: ${keyFileOf(f)} holds another key; rerun with --force`)), f.lines.join("\n"));
	assert.equal(await install(flags(user, { force: true, "gateway-key-file": join(user, "gw-key2") }), f.ports), 0);
	assert.match(f.files.get(keyFileOf(f))!, /^CP_GATEWAY_ADMIN_KEY=other-k3y$/m);

	f.modes.set(keyFileOf(f), 0o644);
	f.lines.length = 0;
	assert.equal(await install(flags(user), f.ports), 0);
	assert.ok(f.lines.includes(`changed: gateway-key: tightened ${keyFileOf(f)} to 0600`), f.lines.join("\n"));
	assert.equal(f.modes.get(keyFileOf(f)), 0o600);

	// The flag path with the same key and url tightens a loose file too, or the parent host refuses it (cp-er76 review).
	for (const dry of [true, false]) {
		f.modes.set(keyFileOf(f), 0o644);
		f.lines.length = 0;
		assert.equal(await install(flags(user, { "dry-run": dry, "gateway-url": "https://gw2.example", "gateway-key-file": join(user, "gw-key2") }), f.ports), 0, f.lines.join("\n"));
		assert.ok(f.lines.some((line) => line.startsWith(`changed: gateway-key: tightened ${keyFileOf(f)} to 0600`)), f.lines.join("\n"));
		assert.equal(f.modes.get(keyFileOf(f)), dry ? 0o644 : 0o600, dry ? "--dry-run writes nothing" : "tightened");
		assert.ok(!f.lines.some((line) => line.includes("other-k3y")), "the key is never printed");
	}
	const onDisk = join(scratch(t), "gateway.env");
	writeFileSync(onDisk, f.files.get(keyFileOf(f))!, { mode: f.modes.get(keyFileOf(f)) });
	assert.deepEqual(readGatewayKey(onDisk), { key: "other-k3y" }, "what the parent host reads");

	const dry = gatewayFake(scratch(t));
	assert.equal(await install(flags(dry.ports.env.HOME!, { "dry-run": true, "gateway-url": "https://gw.example", "gateway-key-file": join(dry.ports.env.HOME!, "gw-key") }), dry.ports), 0, dry.lines.join("\n"));
	assert.ok(!dry.files.has(capacityOf(dry)) && dry.secrets.length === 0);
	assert.ok(dry.lines.some((line) => line.startsWith("changed: gateway-key: wrote") && line.endsWith("(dry-run)")), dry.lines.join("\n"));

	f.lines.length = 0;
	assert.equal(await install(flags(user, { uninstall: true }), f.ports), 0);
	assert.ok(f.lines.includes(`skip: uninstall: ${keyFileOf(f)} kept (your gateway admin key; remove it yourself)`), f.lines.join("\n"));
	assert.ok(f.files.has(keyFileOf(f)));
});
