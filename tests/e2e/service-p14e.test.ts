/**
 * Behavior 15 (P14e): `node src/service/install.ts` on a scratch machine — systemctl, loginctl, crontab, npm, pi, gh
 * and the app's daemon.ts are logging stand-ins over one state dir per user, its interfaces scripted by a preload and
 * its clock 60 times fast; scripts/install.sh, bin/cp-install and bin/cp-bootstrap run as shell with a stand-in git.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { configureLayout, layoutForHome } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { gatewayKeyFile, readGatewayKey } from "../../src/gateway-key.ts";
import { loadCapacityConfig } from "../../src/quota.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { OPERATOR_RESUME_UNIT, OPERATOR_UNIT, renderUnits } from "../../src/service/units.ts";
import { PI_LENS_TOOLS } from "../../src/tool-manifest.ts";
import { ROLE_PACKAGES } from "../../src/worker-packages.ts";
import { REPO_ROOT } from "../harness/index.ts";

/** Every stand-in tool: logs `<tool> <args>` to $SM/calls.log, answers from $SM/answers.json (first prefix). */
const STUB = `const fs = require("node:fs"); const { dirname, join } = require("node:path");
const [tool, ...a] = process.argv.slice(2); const sm = process.env.SM; const line = [tool, ...a].join(" ");
fs.appendFileSync(join(sm, "calls.log"), line + "\\n");
const read = (f) => { try { return fs.readFileSync(join(sm, f), "utf8"); } catch { return undefined; } };
const answers = JSON.parse(read("answers.json") ?? "{}");
const key = Object.keys(answers).find((k) => line.startsWith(k)); const answer = key ? answers[key] : {};
const passes = (answer.status ?? 0) === 0;
const up = () => { if (read("down") !== undefined) return; fs.mkdirSync(dirname(process.env.P14_STATE), { recursive: true });
  fs.writeFileSync(process.env.P14_STATE, JSON.stringify({ pid: 1, inner: { state: "ready" } }));
  fs.writeFileSync(process.env.P14_RUNTIME, read("runtime") ?? JSON.stringify({ units: { parent: { state: "running" }, viewer: { state: "running" } } })); };
let out = "";
if (tool === "systemctl") {
  const verb = a[1]; const units = a.slice(2).filter((w) => !w.startsWith("--")); const on = (u) => join(sm, "on-" + u);
  if (verb === "is-system-running") out = "running\\n";
  else if (verb === "is-active") out = fs.existsSync(on(units[0])) ? "active\\n" : "inactive\\n";
  else if (passes && ((verb === "enable" && a.includes("--now")) || verb === "try-restart")) { for (const u of units) fs.writeFileSync(on(u), ""); if (units.includes("cp-daemon.service")) up(); }
  else if (passes && verb === "disable" && a.includes("--now")) for (const u of units) fs.rmSync(on(u), { force: true });
} else if (tool === "loginctl" && a[0] === "show-user") out = "Linger=yes\\n";
else if (tool === "crontab") { if (a[0] === "-l") { if (!key) answer.status = 1; } else if (passes) fs.copyFileSync(a[0], join(sm, "crontab.txt")); }
else if (tool === "npm" && a[0] === "prefix") out = process.env.HOME + "/.npm-global\\n";
else if (tool === "npm" && a[0] === "ci" && passes) fs.copyFileSync("package-lock.json", "node_modules/.package-lock.json");
else if (tool === "pi" && a[0] === "--version") out = "pi 1.4.0\\n";
else if (tool === "pi" && a[0] === "--mode") { fs.readSync(0, Buffer.alloc(4096)); out = JSON.stringify({ type: "response", id: "probe", success: true, data: { commands: [{ name: "cp-version", source: "extension" }] } }) + "\\n"; }
else if (tool === "pi" && a[1] === "--list-models") { fs.writeFileSync(join(sm, "list-env"), Object.keys(process.env).sort().join(" ") + "\\n" + process.env.PATH); out = read("models.txt") ?? ""; }
else if (tool === "pi" && a[0] === "install" && passes) {
  const file = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME, ".pi/agent"), "settings.json");
  const have = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "{}"); fs.writeFileSync(file, JSON.stringify({ ...have, packages: [...(have.packages ?? []), a[1]] }));
}
process.stdout.write(answer.stdout ?? out); process.stderr.write(answer.stderr ?? ""); process.exit(answer.status ?? 0);
`;

/** The app's src/service/daemon.ts: logs `daemon <args>`; `status` exits 0 once started, `stop` stops it. */
const DAEMON = `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);
const fs = require("node:fs"); const sm = process.env.SM; const a = process.argv.slice(2);
fs.appendFileSync(sm + "/calls.log", "daemon " + a.join(" ") + "\\n");
if (a[0] === "status") process.exit(fs.existsSync(sm + "/running") ? 0 : 3);
if (a[0] === "start" || a[0] === "restart") { fs.writeFileSync(sm + "/running", ""); fs.mkdirSync(require("node:path").dirname(process.env.P14_STATE), { recursive: true });
  fs.writeFileSync(process.env.P14_STATE, JSON.stringify({ pid: 1, inner: { state: "ready" } }));
  fs.writeFileSync(process.env.P14_RUNTIME, JSON.stringify({ units: { parent: { state: "running" }, viewer: { state: "running" } } })); }
if (a[0] === "stop") fs.rmSync(sm + "/running", { force: true });
`;
const BASE_TOOLS = ["systemctl", "loginctl", "crontab", "npm", "pi", "gh", "treehouse", "tailscale", ...PI_LENS_TOOLS.commands];
const LOCK = JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1" } } });
const LISTING = "provider      model            context\nanthropic  claude-opus-5-5  1M\nopenai  gpt-6.1-sol  400K\nopenai-codex  gpt-6.1-sol  400K\n";
const GENERATED = "Generated by cp-install";
type Answer = { status?: number; stdout?: string; stderr?: string };
interface UserOpts { tools?: string[]; drop?: string[]; answers?: Record<string, Answer>; ifaces?: Record<string, string[]>; models?: string; env?: Record<string, string>; homeless?: boolean }

/** A scratch machine: each user gets a HOME, a stub-only PATH, a state dir ($SM) and an app mirror of this checkout. */
function rig(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14e-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "stub.cjs"), STUB);
	let n = 0;
	const user = (o: UserOpts = {}) => {
		const name = `u${++n}`;
		const [home, sm, bin, app] = ["home", "sm", "bin", "app"].map((part) => join(root, `${name}-${part}`)) as [string, string, string, string];
		const cpHome = join(home, ".pi-command-post");
		const paths = daemonPaths(cpHome);
		for (const dir of [sm, bin]) mkdirSync(dir);
		if (!o.homeless) mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const node = join(bin, "node");
		try { linkSync(process.execPath, node); } catch { copyFileSync(process.execPath, node); chmodSync(node, 0o755); }
		symlinkSync(realpathSync(whichAll("git")[0]!), join(bin, "git"));
		for (const tool of [...BASE_TOOLS, ...(o.tools ?? [])].filter((name) => !(o.drop ?? []).includes(name))) {
			writeFileSync(join(bin, tool), `#!/bin/sh\nexport SM="${sm}" P14_STATE="${paths.state}" P14_RUNTIME="${paths.runtime}"\nexec "${node}" "${join(root, "stub.cjs")}" ${tool} "$@"\n`, { mode: 0o755 });
		}
		writeFileSync(join(sm, "answers.json"), JSON.stringify(o.answers ?? {}));
		writeFileSync(join(sm, "models.txt"), o.models ?? LISTING);
		// The app: this checkout but for its daemon.ts and a lockfile pair of its own (npm ci writes the hidden one).
		const mirror = (rel: string, skip: string[]) => {
			mkdirSync(join(app, rel), { recursive: true });
			for (const entry of readdirSync(join(REPO_ROOT, rel)).filter((e) => !skip.includes(e))) symlinkSync(join(REPO_ROOT, rel, entry), join(app, rel, entry));
		};
		mirror("", ["src", "node_modules", "package-lock.json", ".git"]);
		mirror("src", ["service"]);
		mirror("src/service", ["daemon.ts"]);
		mirror("node_modules", [".package-lock.json"]);
		writeFileSync(join(app, "src/service/daemon.ts"), DAEMON);
		writeFileSync(join(app, "package-lock.json"), LOCK);
		const unitDir = join(home, ".config", "systemd", "user");
		const binDir = join(home, ".local", "bin");
		const env: Record<string, string> = { HOME: home, USER: "u", PATH: bin, TERM: "dumb", SM: sm, P14_STATE: paths.state, P14_RUNTIME: paths.runtime, CP_TEST_TIME_SCALE: "60", CP_TEST_INTERFACES: JSON.stringify(o.ifaces ?? { lo: ["127.0.0.1"] }), ...o.env };
		/** cp-install with `args`; with `replies` on a pty (`script`) answering each `]: ` prompt in order. */
		const install = async (args: string[], replies?: string[]): Promise<{ code: number | null; out: string }> => {
			const argv = [node, "--import", join(REPO_ROOT, "tests/harness/interfaces.ts"), "--import", join(REPO_ROOT, "tests/harness/time-scale.ts"), join(REPO_ROOT, "src/service/install.ts"), "--home", cpHome, "--app", app, ...args];
			const runEnv = { ...env, CP_TEST_TIME_ZERO: String(Date.now()) };
			const child = replies === undefined
				? spawn(node, argv.slice(1), { cwd: root, env: runEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] })
				: spawn(whichAll("script")[0]!, ["-qfec", argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"], { cwd: root, env: runEnv });
			let out = "";
			let asked = 0;
			const onData = (chunk: unknown) => {
				out += String(chunk).replace(/\r/g, "");
				if (replies && /\]: $/.test(out) && (out.match(/\]: /g)?.length ?? 0) > asked) child.stdin?.write(`${replies[asked++] ?? ""}\r`);
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
			return { code, out };
		};
		const log = () => (existsSync(join(sm, "calls.log")) ? readFileSync(join(sm, "calls.log"), "utf8").split("\n").filter(Boolean) : []);
		const calls = (tool: string) => log().filter((line) => line.startsWith(`${tool} `)).map((line) => line.slice(tool.length + 1));
		const text = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
		const config = () => JSON.parse(text(paths.config) ?? "null") as Record<string, unknown> | null;
		const pinned = () => [config()?.parent_model, /CP_OPERATOR_MODEL='([^']*)'/.exec(text(join(binDir, "cp-operator")) ?? "")?.[1]];
		const answer = (answers: Record<string, Answer>) => writeFileSync(join(sm, "answers.json"), JSON.stringify(answers));
		const unit = join(unitDir, "cp-daemon.service");
		return { home, sm, bin, app, cpHome, node, paths, unitDir, binDir, unit, env, install, calls, log, text, config, pinned, answer };
	};
	return { root, user };
}
type User = ReturnType<ReturnType<typeof rig>["user"]>;
const lines = (out: string, status: string) => out.split("\n").filter((line) => line.startsWith(`${status}: `));
/** The legacy units an older cp-install wrote (pins in cp-view and cp-parent.service); with tmux, operator units. */
const legacyHome = (u: User, tmux = false) => {
	const units = renderUnits({ node: u.node, app: u.app, home: u.cpHome, path: "/bin", port: 8766, viewerHost: "100.80.0.1", parentModel: "openai/gpt-6.1-sol", ...(tmux ? { tmux: "/usr/bin/tmux", wrapper: join(u.binDir, "cp-operator") } : {}) });
	mkdirSync(u.unitDir, { recursive: true });
	for (const [name, text] of Object.entries(units)) writeFileSync(join(u.unitDir, name), text);
	for (const name of ["cp-parent.service", "cp-view.service", "cp-health.timer", "cp-update.timer"]) writeFileSync(join(u.sm, `on-${name}`), "");
	return units;
};
const HOSTS = { tailscale0: ["100.80.0.1"], enp3s0: ["192.168.1.5", "fe80::1"], lo: ["127.0.0.1"] };
const TAILSCALE = { "tailscale ip -4": { stdout: "100.80.0.1\n" } };
const PINNED = ["--parent-model", "openai/gpt-6.1-sol", "--operator-model", "openai/gpt-6.1-sol"];

test("P14e-install-files: cp-install writes, refuses, plans and uninstalls its files", { timeout: 300_000 }, async (t) => {
	const r = rig(t);
	const u = r.user();
	const first = await u.install(PINNED);
	assert.match(u.text(u.unit) ?? "", /^ExecStart="[^"]+\/node" "[^"]+\/src\/service\/daemon\.ts" "run"$/m, first.out);
	assert.deepEqual({ ...u.config(), parent_model: undefined }, { schema_version: 1, generated_by: "cp-install", backend: "systemd", node: u.node, app: u.app, home: u.cpHome, path: u.bin, port: 8766, parent_model: undefined });
	assert.equal(statSync(u.paths.config).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(u.unitDir), ["cp-daemon.service"], "no legacy unit is written");
	assert.deepEqual(readdirSync(u.binDir).sort(), ["cp-operator", "cp-tunnel"]);
	assert.deepEqual(readdirSync(u.cpHome, { recursive: true }).filter((path) => /tunnel/.test(String(path))), [], "no tunnel config is written");
	assert.deepEqual(u.calls("npm").filter((call) => call === "ci"), ["ci"]);
	assert.deepEqual(u.calls("systemctl").filter((call) => /enable|try-restart/.test(call)), ["--user enable --now cp-daemon.service"], "enabled with --now, never restarted");
	assert.match(first.out, /^ok: enable: cp-daemon\.service is active: the parent supervisor and the viewer run$/m);
	assert.match(first.out, /^fail: doctor: no parent running for \S+ after 90s; see cp-daemon log$/m, "the doctor step runs once cp-daemon started");
	assert.equal(JSON.parse(u.text(join(u.paths.dataDir, "update.json")) ?? "{}").enabled, true);
	assert.doesNotMatch(u.log().join("\n"), /\bsudo\b/, "never sudo");
	const before = u.log().length;
	const second = await u.install(PINNED);
	assert.deepEqual(lines(second.out, "changed").concat(lines(second.out, "fail").filter((l) => !/^fail: doctor: no parent/.test(l))), [], second.out);
	assert.ok(!u.log().slice(before).some((call) => call === "npm ci" || /try-restart/.test(call)), "no npm ci and no restart on an unchanged rerun");

	for (const path of [u.unit, u.paths.config]) {
		const kept = u.text(path)!;
		writeFileSync(path, "# edited by hand\n");
		const at = u.log().length;
		const refused = await u.install(PINNED);
		assert.equal(refused.code, 1);
		assert.match(refused.out, new RegExp(`^fail: (unit|daemon): ${path.replace(/[.]/g, "\\.")} differs from what this install renders; rerun with --force`, "m"));
		assert.equal(u.text(path), "# edited by hand\n");
		assert.ok(!u.log().slice(at).some((call) => call.includes("cp-daemon.service")), "a refused write starts nothing");
		await u.install([...PINNED, "--force"]);
		assert.equal(u.text(path), kept);
		assert.ok(u.log().slice(at).includes("systemctl --user try-restart cp-daemon.service"), u.log().slice(at).join("\n"));
	}

	const dry = r.user({ drop: ["treehouse"] });
	const plan = await dry.install(["--dry-run", "--yes", "--parent-model", "openai/gpt-6.1-sol"]);
	assert.equal(plan.code, 0, plan.out);
	assert.equal(existsSync(dry.cpHome), false, "the dry-run wrote no home");
	assert.deepEqual(dry.log().filter((call) => /^(npm ci|systemctl --user (enable|daemon-reload)|loginctl enable|gh |pi )/.test(call)), [], dry.log().join("\n"));
	assert.match(plan.out, /^changed: tools: a real run installs the missing required tools first:[^]*treehouse/m);
	assert.match(plan.out, /^skip: gh: login not checked in a dry-run \(gh writes state under HOME\); a real run checks it$/m);
	assert.match(plan.out, /^skip: model: parent openai\/gpt-6\.1-sol \(--parent-model\) written unchecked: a dry-run never runs pi --list-models$/m);
	assert.match(plan.out, /^changed: enable: would run/m, "the plan reaches activation");
	const blocked = await r.user({ drop: ["gh"] }).install(["--dry-run", "--yes"]);
	assert.deepEqual([blocked.code, /^fail: tools: scripts\/install-tools\.ts exited 1:[^]*gh/m.test(blocked.out), /^changed: enable/m.test(blocked.out)], [1, true, false], blocked.out);
	const bare = await r.user().install(["--dry-run"]);
	assert.match(bare.out, /^skip: model: parent, operator: not listed in a dry-run \(pi writes its state under HOME\); a real run asks or recommends/m);
	const homeless = r.user({ homeless: true });
	assert.equal((await homeless.install(["--dry-run", "--yes", "--viewer-host", "127.0.0.1"])).code, 0);
	assert.equal(existsSync(homeless.home), false, "HOME was never created");

	const lock = r.user();
	writeFileSync(join(lock.app, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/@esbuild/darwin-arm64": { version: "0.25.0", optional: true, os: ["darwin"] } } }));
	const hidden = join(lock.app, "node_modules", ".package-lock.json");
	writeFileSync(hidden, JSON.stringify({ packages: { "node_modules/a": { version: "1" } } }));
	assert.match((await lock.install(["--dry-run"])).out, /^ok: npm: node_modules matches package-lock\.json$/m);
	const stale = [];
	for (const installed of [{}, { "node_modules/a": { version: "2" } }, { "node_modules/a": { version: "1" }, "node_modules/stray": { version: "1" } }]) {
		writeFileSync(hidden, JSON.stringify({ packages: installed }));
		stale.push(/^changed: npm: would run npm ci/m.test((await lock.install(["--dry-run"])).out));
	}
	assert.deepEqual(stale, [true, true, true]);

	const spaced = r.user();
	const odd = await spaced.install(["--home", join(spaced.home, "my home")]);
	assert.match(odd.out, /^fail: unit: WorkingDirectory= cannot carry/m);
	assert.deepEqual(spaced.log(), [], "nothing ran");
	const bogus = await spaced.install(["--sudo"]);
	assert.notEqual(bogus.code, 0);
	assert.match(bogus.out, /--sudo/);

	writeFileSync(join(u.binDir, "cp-operator"), "#!/bin/sh\n# mine\n");
	const gone = await u.install(["--uninstall"]);
	assert.equal(gone.code, 0, gone.out);
	assert.ok(u.calls("systemctl").includes("--user disable --now cp-daemon.service"), gone.out);
	assert.deepEqual([existsSync(u.unit), existsSync(u.paths.config), existsSync(join(u.binDir, "cp-tunnel"))], [false, false, false]);
	assert.equal(u.text(join(u.binDir, "cp-operator")), "#!/bin/sh\n# mine\n", "a wrapper cp-install did not write stays");
	assert.match(gone.out, /^ok: uninstall: home \S+ kept \(data\/daemon\.json removed\) and app/m);
	assert.ok(existsSync(join(u.paths.dataDir, "update.json")), "the home's own files stay");
});

test("P14e-install-backend: detached, linger, readiness, --no-start, crontab, operator units", { timeout: 300_000 }, async (t) => {
	const r = rig(t);
	const offline = { "systemctl --user is-system-running": { status: 1, stdout: "offline\n" } };
	const off = r.user({ answers: offline });
	const first = await off.install(PINNED);
	const reboot = `"${off.node}" "${off.app}/src/service/daemon.ts" start --home "${off.cpHome}"`;
	assert.match(first.out, /^ok: service: no systemd --user \(offline\): cp-daemon runs detached/m);
	assert.deepEqual([existsSync(off.unit), off.config()?.backend, off.calls("systemctl").filter((call) => call.includes("enable"))], [false, "detached", []]);
	assert.ok(off.calls("daemon").includes(`start --home ${off.cpHome}`), off.log().join("\n"));
	assert.ok(first.out.includes(`changed: daemon: started (detached); after a reboot run: ${reboot}`), first.out);
	assert.deepEqual(off.calls("crontab"), [], "no --crontab: crontab is never touched");
	assert.match(first.out, /^fail: doctor: no parent running/m, "doctor runs on the detached backend too");
	assert.ok(existsSync(join(off.binDir, "cp-operator")), "the wrapper still lands");
	const at = off.log().length;
	const again = await off.install(PINNED);
	assert.ok(again.out.includes(`ok: daemon: running (detached); after a reboot run: ${reboot}`), again.out);
	assert.ok(!off.log().slice(at).some((call) => / (start|restart) --home /.test(call)), "an unchanged running daemon is left alone");
	off.answer({ ...offline, "crontab -l": { stdout: "@daily x\n" } });
	assert.equal((await off.install(["--uninstall"])).code, 0);
	assert.ok(off.calls("daemon").includes(`stop --home ${off.cpHome}`), off.log().join("\n"));
	assert.deepEqual(off.calls("crontab").filter((call) => call !== "-l"), [], "no marked line: the crontab is not rewritten");
	assert.equal(existsSync(off.paths.config), false);

	const cron = r.user({ answers: { ...offline, "crontab -l": { stdout: "@daily x\n" } } });
	const added = await cron.install([...PINNED, "--crontab"]);
	const tmp = join(cron.paths.stateDir, "daemon-crontab.tmp");
	assert.deepEqual([cron.calls("crontab").includes(tmp), existsSync(tmp)], [true, false], cron.log().join("\n"));
	assert.match(added.out, new RegExp(`^changed: crontab: added: @reboot .*# cp-daemon ${cron.cpHome}$`, "m"));
	assert.match(cron.text(join(cron.sm, "crontab.txt")) ?? "", /^@daily x\n@reboot /);

	const linger = r.user({ answers: { "loginctl show-user": { stdout: "Linger=no\n" }, "loginctl enable-linger": { status: 1 } } });
	const refused = await linger.install(PINNED);
	assert.equal(refused.code, 1);
	assert.match(refused.out, /^fail: linger: loginctl enable-linger refused; run: sudo loginctl enable-linger u$/m);
	assert.deepEqual([existsSync(linger.paths.config), existsSync(join(linger.binDir, "cp-operator"))], [false, false]);

	const dead = r.user({ answers: { "systemctl --user is-active cp-daemon.service": { status: 3, stdout: "failed\n" } } });
	const failed = await dead.install(PINNED);
	assert.equal(failed.code, 1);
	assert.match(failed.out, /^fail: enable: cp-daemon\.service is failed after 60s; see cp-daemon log; journalctl --user -u cp-daemon\.service -n 20$/m);
	assert.equal(dead.calls("systemctl").filter((call) => call === "--user is-active cp-daemon.service").length, 61, "polled through the whole window");
	const crashed = r.user();
	writeFileSync(join(crashed.sm, "runtime"), JSON.stringify({ units: { parent: { state: "failed", result: "exit-code" }, viewer: { state: "running" } } }));
	assert.match((await crashed.install(PINNED)).out, /^fail: enable: the parent supervisor is failed \(exit-code\) after 60s/m);
	const quiet = r.user();
	const enabled = await quiet.install([...PINNED, "--no-start"]);
	assert.equal(enabled.code, 0, enabled.out);
	assert.ok(quiet.calls("systemctl").includes("--user enable cp-daemon.service"));
	assert.ok(!quiet.calls("systemctl").some((call) => /--now|is-active|try-restart/.test(call)), quiet.calls("systemctl").join("\n"));
	assert.match(enabled.out, /^ok: enable: cp-daemon\.service enabled, not started \(--no-start\); start it: systemctl --user start cp-daemon\.service$/m);
	assert.match(enabled.out, /^skip: doctor: --no-start$/m);

	const op = r.user({ tools: ["tmux"] });
	await op.install([...PINNED, "--no-start"]);
	assert.deepEqual(readdirSync(op.unitDir), ["cp-daemon.service"], "no operator unit is written");
	const old = renderUnits({ node: op.node, app: op.app, home: op.cpHome, path: op.bin, port: 8766, tmux: join(op.bin, "tmux"), wrapper: join(op.binDir, "cp-operator") });
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) writeFileSync(join(op.unitDir, name), old[name]!);
	const dryRetire = await op.install([...PINNED, "--no-start", "--dry-run"]);
	assert.ok(existsSync(join(op.unitDir, OPERATOR_UNIT)), `--dry-run removes nothing: ${dryRetire.out}`);
	const retired = await op.install([...PINNED, "--no-start"]);
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) {
		assert.ok(retired.out.includes(`changed: unit: removed ${join(op.unitDir, name)} (never stopped: Start in tmux runs tmux directly now)`), retired.out);
	}
	assert.deepEqual(readdirSync(op.unitDir), ["cp-daemon.service"]);
	writeFileSync(join(op.unitDir, OPERATOR_UNIT), "[Service]\nExecStart=/usr/bin/tmux new-session -d -s mine\n");
	assert.doesNotMatch((await op.install([...PINNED, "--no-start"])).out, /removed/, "a hand-written cp-operator.service stays");
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) writeFileSync(join(op.unitDir, name), old[name]!);
	const gone = await op.install(["--uninstall"]);
	assert.ok(gone.out.includes(`changed: uninstall: removed ${join(op.unitDir, OPERATOR_UNIT)}`), gone.out);
	assert.equal(existsSync(join(op.unitDir, OPERATOR_RESUME_UNIT)), false, "and its resume twin");
	assert.ok(!op.calls("systemctl").some((call) => call.includes("cp-operator") || /--user (stop|kill)/.test(call)), op.calls("systemctl").join("\n"));

	const none = await r.user().install([...PINNED, "--no-start"]);
	assert.match(none.out, /^ok: launchers: tmux not on PATH \(the dashboard's Start in tmux needs it\); herdr not on PATH$/m);
	const both = r.user({ tools: ["tmux", "herdr"], answers: { "herdr integration status": { stdout: "pi: not installed (x)\nomp: not installed\n" } } });
	const shown = await both.install([...PINNED, "--no-start"]);
	assert.ok(shown.out.includes(`ok: launchers: tmux ${join(both.bin, "tmux")}; herdr ${join(both.bin, "herdr")}`), shown.out);
	assert.match(shown.out, /^skip: herdr: pi integration not installed.*herdr integration install pi$/m);
	assert.deepEqual(both.calls("herdr"), ["integration status"], "the hint is printed, never run");
	const integrated = r.user({ tools: ["herdr"], answers: { "herdr integration status": { stdout: "pi: installed (x)\n" } } });
	assert.doesNotMatch((await integrated.install([...PINNED, "--no-start"])).out, /^skip: herdr:/m, "pi integrated: no hint");
});

test("P14e-install-viewer-host: the flag, the prompt, --yes and a kept pin", { timeout: 300_000 }, async (t) => {
	const r = rig(t);
	const quiet = [...PINNED, "--no-start"];
	const notOk = (out: string) => [...lines(out, "changed"), ...lines(out, "fail")];
	const u = r.user({ ifaces: { wt0: ["100.70.1.2"], lo: ["127.0.0.1"] } });
	const pinned = await u.install([...quiet, "--viewer-host", "100.70.1.2"]);
	assert.equal(u.config()?.viewer_host, "100.70.1.2");
	assert.doesNotMatch(u.text(u.unit) ?? "", /CP_VIEWER_HOST/, "never in the thin unit");
	assert.match(u.text(join(u.binDir, "cp-operator")) ?? "", /^export .* CP_VIEWER_HOST='100\.70\.1\.2'/m);
	assert.match(pinned.out, /^changed: viewer-host: 100\.70\.1\.2 \(--viewer-host; was none\)$/m);
	const reruns = [];
	for (const extra of [["--viewer-host", "100.70.1.2"], []]) reruns.push(notOk((await u.install([...quiet, ...extra])).out));
	assert.deepEqual(reruns, [[], []]);
	u.env.CP_TEST_INTERFACES = JSON.stringify({ lo: ["127.0.0.1"] });
	const moved = await u.install(quiet);
	assert.ok(moved.out.includes(`ok: viewer-host: 100.70.1.2 kept from ${u.paths.config}`), moved.out);
	assert.match(moved.out, /^skip: viewer-host: 100\.70\.1\.2 is not on this machine's interfaces now/m);
	assert.deepEqual(notOk(moved.out), [], "kept, files untouched");

	const bad = r.user({ ifaces: { ...HOSTS, eth1: ["169.254.1.1"] } });
	const refusals = [];
	for (const value of ["0.0.0.0", "::", "8.8.8.8", "2001:4860::8888", "fe80::1", "fe80::1%eth0", "169.254.1.1", "::ffff:10.0.0.1", "localhost", "10.9.9.9"]) {
		const run = await bad.install([...quiet, "--viewer-host", value]);
		refusals.push(run.code === 1 && /^fail: viewer-host: /m.test(run.out) ? "refused" : `${value}: ${run.out}`);
	}
	assert.deepEqual(new Set(refusals), new Set(["refused"]));
	assert.deepEqual([bad.calls("npm"), existsSync(bad.cpHome)], [[], false], "nothing ran or was written");

	const ask = async (reply: string) => {
		const user = r.user({ ifaces: HOSTS, answers: TAILSCALE });
		const run = await user.install(quiet, [reply]);
		return { ...run, host: user.config()?.viewer_host, config: user.config() };
	};
	const empty = await ask("");
	assert.equal(empty.out.match(/Dashboard address/g)?.length, 1, empty.out);
	assert.match(empty.out, /Dashboard address — it serves write controls: anyone who can reach it can steer the operator session\.\n {2}1\) 100\.80\.0\.1 {2}Tailscale \(tailscale0\) — recommended: only devices on your tailnet can reach it\n {2}2\) 192\.168\.1\.5 {2}enp3s0 — anyone on this network can reach it\n {2}3\) 127\.0\.0\.1 {2}lo — this machine only[^\n]*\nChoose 1-3 or type an IP \[1\]: /);
	assert.equal(empty.host, "100.80.0.1");
	assert.match(empty.out, /^changed: viewer-host: 100\.80\.0\.1 \(tailscale; recommended/m);
	const second = await ask("2");
	assert.deepEqual([second.host, /^changed: viewer-host: 192\.168\.1\.5 \(private; chosen at the prompt\)$/m.test(second.out)], ["192.168.1.5", true]);
	assert.equal((await ask("127.0.0.1")).host, "127.0.0.1");
	const wrong = [];
	for (const reply of ["8.8.8.8", "9", "10.9.9.9"]) {
		const run = await ask(reply);
		wrong.push([run.code, /^fail: viewer-host: .*rerun with --viewer-host <ip>$/m.test(run.out), run.config]);
	}
	assert.deepEqual(wrong, [[1, true, null], [1, true, null], [1, true, null]]);

	const tailnet = r.user({ ifaces: HOSTS, answers: TAILSCALE });
	const yes = await tailnet.install([...quiet, "--yes"], []);
	assert.doesNotMatch(yes.out, /Dashboard address/);
	assert.match(yes.out, /^changed: viewer-host: 100\.80\.0\.1 \(tailscale; recommended.*--viewer-host overrides\)$/m);
	const lan = r.user({ ifaces: { enp3s0: HOSTS.enp3s0, lo: HOSTS.lo }, answers: { "tailscale ip -4": { status: 1 } } });
	const unpinned = await lan.install([...quiet, "--yes"]);
	assert.match(unpinned.out, /^skip: viewer-host: no Tailscale address on this machine; nothing pinned.*--viewer-host <ip>/m);
	const files = () => [lan.text(lan.unit), lan.text(join(lan.binDir, "cp-operator")), lan.text(lan.paths.config)];
	const withLan = files();
	assert.doesNotMatch(withLan.join("\n"), /CP_VIEWER_HOST|viewer_host/);
	for (const path of [lan.unit, join(lan.binDir, "cp-operator"), lan.paths.config]) rmSync(path);
	lan.env.CP_TEST_INTERFACES = "{}";
	await lan.install([...quiet, "--yes"]);
	assert.deepEqual(files(), withLan, "byte-identical to an install on a host with no interfaces");

	const kept = r.user({ ifaces: HOSTS });
	await kept.install(PINNED.concat("--yes"));
	kept.answer(TAILSCALE);
	const later = await kept.install(PINNED, []);
	assert.doesNotMatch(later.out, /Dashboard address/, "an existing install is never asked");
	assert.ok(later.out.includes(`skip: viewer-host: none pinned in ${kept.paths.config}`) && later.out.includes("--viewer-host <ip> --force"), later.out);
	const other = await kept.install([...PINNED, "--viewer-host", "192.168.1.5"]);
	assert.equal(other.code, 1);
	assert.ok(other.out.includes(`fail: daemon: ${kept.paths.config} differs`), other.out);
	const at = kept.log().length;
	await kept.install([...PINNED, "--viewer-host", "192.168.1.5", "--force"]);
	assert.equal(kept.config()?.viewer_host, "192.168.1.5");
	assert.ok(kept.log().slice(at).includes("systemctl --user try-restart cp-daemon.service"), kept.log().slice(at).join("\n"));

	const drop = r.user({ answers: { "systemctl --user show cp-view.service --property=Environment --value": { stdout: "CP_HOME=/h CP_VIEWER_HOST=10.1.1.1\n" } } });
	mkdirSync(drop.unitDir, { recursive: true });
	for (const [name, text] of Object.entries(renderUnits({ node: drop.node, app: drop.app, home: drop.cpHome, path: "/bin", port: 8766 }))) writeFileSync(join(drop.unitDir, name), text);
	const reported = await drop.install([...PINNED, "--yes"]);
	assert.equal(lines(reported.out, "skip").filter((line) => line.startsWith("skip: viewer-host: a drop-in on cp-view.service sets CP_VIEWER_HOST=10.1.1.1")).length, 1, reported.out);
	assert.equal(drop.config()?.viewer_host, undefined);
	const dry = r.user({ ifaces: HOSTS, answers: TAILSCALE });
	const plan = await dry.install(["--dry-run"], []);
	assert.match(plan.out, /^changed: viewer-host: 100\.80\.0\.1 \(tailscale;.*\(dry-run\)$/m);
	assert.deepEqual([existsSync(dry.cpHome), /Dashboard address/.test(plan.out)], [false, false]);
});

test("P14e-install-extras: packages, gh, login, pi-lens, push and tmux", { timeout: 600_000 }, async (t) => {
	const r = rig(t);
	const quiet = [...PINNED, "--no-start", "--viewer-host", "127.0.0.1"];
	const installs = (u: User) => u.calls("pi").filter((call) => call.startsWith("install "));
	const u = r.user();
	const plain = await u.install(quiet, []);
	assert.deepEqual(installs(u), [...new Set(Object.values(ROLE_PACKAGES).flat())].map((spec) => `install npm:${spec}`));
	assert.doesNotMatch(plain.out, /\]: /, "no prompt");
	assert.match(plain.out, /^skip: push: not set up; rerun with --push-origin URL to enable it$/m);
	assert.deepEqual([existsSync(join(u.paths.dataDir, "push", "config.json")), /self-package/.test(plain.out)], [false, false]);
	const pushed = r.user();
	const origin = await pushed.install([...quiet, "--push-origin", "https://cp.example"]);
	assert.match(origin.out, /^changed: push: push set up for https:\/\/cp\.example$/m);

	const mine = ["npm:zzz-theme", { source: "npm:pi-lens@4.3.0" }, "git:github.com/me/tools"];
	const human = r.user();
	writeFileSync(join(human.home, ".pi/agent/settings.json"), JSON.stringify({ packages: mine }));
	const kept = await human.install(quiet);
	assert.ok(!installs(human).some((call) => call.includes("pi-lens")), "pi-lens is configured (pinned by the human)");
	assert.match(kept.out, /^ok: pi-package: pi-lens configured as npm:pi-lens@4\.3\.0 \(yours, kept; workers name npm:pi-lens\)$/m);
	assert.deepEqual(JSON.parse(human.text(join(human.home, ".pi/agent/settings.json"))!).packages.slice(0, 3), mine, "order and entries kept");
	const lookalike = r.user();
	writeFileSync(join(lookalike.home, ".pi/agent/settings.json"), JSON.stringify({ packages: ["../src/pi-command-post", "npm:pi-command-post-extras"] }));
	const self = await lookalike.install(quiet);
	assert.ok(!installs(lookalike).includes(`install ${lookalike.app}`) && !/self-package/.test(self.out), "the checkout is never a pi package");
	const off = r.user();
	const skipped = await off.install([...quiet, "--no-pi-packages", "--no-self-package"]);
	assert.deepEqual(installs(off), []);
	assert.match(skipped.out, /^skip: pi-package: --no-pi-packages$/m);
	const broken = r.user();
	writeFileSync(join(broken.home, ".pi/agent/settings.json"), "{ nope");
	const unparsed = await broken.install(quiet);
	assert.equal(unparsed.code, 1);
	assert.match(unparsed.out, /^fail: pi-package: .*never edited here/m);
	assert.deepEqual(installs(broken), []);

	const tracked = r.user();
	mkdirSync(tracked.paths.dataDir, { recursive: true });
	writeFileSync(join(tracked.paths.dataDir, "trackers.json"), "{ retired, malformed");
	writeFileSync(join(tracked.paths.dataDir, "projects.json"), JSON.stringify({ schema_version: 1, projects: [{ name: "tracked" }] }));
	const untracked = await tracked.install(quiet);
	assert.doesNotMatch(untracked.out, /tracker|--with-/i);
	assert.deepEqual(tracked.log().filter((call) => call.endsWith(" --version")).map((call) => call.split(" ")[0]).filter((tool) => !["pi", ...PI_LENS_TOOLS.commands].includes(tool!)), [], "only surviving tools are probed");

	const NONE = "No models available. Use /login or set an API key environment variable.\n";
	const bare = r.user({ models: NONE, answers: { "gh auth status": { status: 1 }, "gh api user": { status: 1 } } });
	const reported = await bare.install(quiet);
	assert.equal(reported.code, 0, reported.out);
	assert.match(reported.out, /^skip: tmux: not on PATH \(optional/m);
	assert.match(reported.out, /^skip: gh: not logged in.*gh auth login/m);
	assert.match(reported.out, /^skip: login: no provider.*\/login/m);
	assert.match(reported.out, /treehouse \(required, not optional/);
	assert.ok(!bare.calls("gh").includes("auth login"), "login is the human's");
	const logged = r.user({ models: NONE });
	writeFileSync(join(logged.home, ".pi/agent/auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
	assert.match((await logged.install(quiet)).out, /^ok: login: 1 provider\(s\)/m);
	assert.match(plain.out, /^ok: gh: logged in$/m);
	assert.deepEqual(u.calls("gh"), ["auth status --active"]);
	const oldGh = r.user({ answers: { "gh auth status": { status: 1, stderr: "unknown flag: --active" } } });
	const fallback = await oldGh.install(quiet);
	assert.deepEqual([oldGh.calls("gh").includes("api user --jq .login"), /^ok: gh: logged in$/m.test(fallback.out)], [true, true]);

	const lens = r.user({ drop: ["ast-grep"] });
	mkdirSync(join(lens.home, ".npm-global"));
	await lens.install(quiet);
	assert.ok(lens.calls("npm").includes(`i -g ${PI_LENS_TOOLS.packages.join(" ")}`), lens.log().join("\n"));
	const locked = r.user({ drop: ["ast-grep"], answers: { "npm prefix -g": { stdout: "/nonexistent-p14e-prefix\n" } } });
	const sudo = await locked.install(quiet);
	assert.equal(sudo.code, 1);
	assert.match(sudo.out, /^fail: pi-lens: npm's global prefix \/nonexistent-p14e-prefix needs sudo.*npm config set prefix/m);
	assert.ok(!locked.calls("npm").some((call) => call.startsWith("i ")), "not run");
	assert.doesNotMatch(locked.log().join("\n"), /\bsudo\b/);
	assert.deepEqual([existsSync(locked.cpHome), existsSync(locked.unit), existsSync(join(locked.binDir, "cp-operator"))], [false, false, false], "a failed prerequisite writes nothing");
	assert.ok(!locked.log().some((call) => call.includes("cp-daemon.service") || call.startsWith("daemon ")), "and starts nothing");
	assert.match(plain.out, /^ok: node: \S+ v2[4-9]\./m, "node 24 or newer passes");
});

test("P14e-install-legacy: held, migrated or refused", { timeout: 600_000 }, async (t) => {
	const r = rig(t);
	const untouched = (u: User, units: Record<string, string>) => {
		assert.deepEqual([existsSync(u.paths.config), existsSync(u.unit)], [false, false], "nothing of cp-daemon's beside the legacy units");
		assert.deepEqual(Object.keys(units).filter((name) => u.text(join(u.unitDir, name)) !== units[name]), [], "the legacy units as they were");
		assert.deepEqual(u.calls("systemctl").filter((call) => /^--user (daemon-reload|enable|disable|stop|kill|try-restart)/.test(call)), []);
	};
	const u = r.user({ ifaces: HOSTS });
	const units = legacyHome(u, true);
	assert.ok(units[OPERATOR_UNIT] && units[OPERATOR_RESUME_UNIT], "the operator units are part of the older install");
	const held = await u.install(["--no-start"]);
	assert.match(held.out, /^skip: migrate: .*untouched \(--no-start\); rerun without --no-start to migrate$/m);
	untouched(u, units);
	const migrated = await u.install([]);
	assert.deepEqual([u.config()?.viewer_host, u.config()?.parent_model], ["100.80.0.1", "openai/gpt-6.1-sol"], "pins kept from the legacy units");
	assert.ok(u.calls("systemctl").includes("--user disable --now cp-parent.service") && u.calls("systemctl").includes("--user enable --now cp-daemon.service"), migrated.out);
	assert.ok(!u.calls("systemctl").some((call) => /^--user (stop|kill)|cp-operator/.test(call)), "never stopped: the parent host and the tmux session keep running");
	assert.deepEqual(readdirSync(u.unitDir), ["cp-daemon.service"], "the legacy and operator units are gone");
	assert.match(migrated.out, /^changed: migrate: cp-daemon\.service runs the parent supervisor and the viewer/m);

	const wrapped = r.user({ ifaces: HOSTS });
	const wrappedUnits = legacyHome(wrapped);
	mkdirSync(wrapped.binDir, { recursive: true });
	writeFileSync(join(wrapped.binDir, "cp-operator"), "#!/bin/sh\n# hand-edited\n");
	const refused = await wrapped.install([]);
	assert.equal(refused.code, 1);
	assert.ok(refused.out.includes(`fail: wrapper: ${join(wrapped.binDir, "cp-operator")} differs from what this install renders; rerun with --force to replace it`), refused.out);
	assert.ok(refused.out.includes(`skip: daemon: ${wrapped.paths.config} not written: another file was refused, so nothing is written`), refused.out);
	assert.equal(wrapped.text(join(wrapped.binDir, "cp-operator")), "#!/bin/sh\n# hand-edited\n");
	untouched(wrapped, wrappedUnits);
	const linger = r.user({ ifaces: HOSTS, answers: { "loginctl show-user": { stdout: "Linger=no\n" }, "loginctl enable-linger": { status: 1 } } });
	const lingerUnits = legacyHome(linger);
	assert.match((await linger.install([])).out, /^fail: linger: loginctl enable-linger refused; run: sudo loginctl enable-linger u$/m);
	assert.equal(existsSync(join(linger.binDir, "cp-operator")), false, "no wrapper either");
	untouched(linger, lingerUnits);

	const busy = r.user({ ifaces: HOSTS, answers: { "systemctl --user is-active cp-update.service": { stdout: "active\n" } } });
	const busyUnits = legacyHome(busy, true);
	const inFlight = await busy.install([]);
	assert.match(inFlight.out, /^fail: migrate: an update run is in flight.*nothing was changed$/m);
	untouched(busy, busyUnits);
	const rolled = r.user({ ifaces: HOSTS, answers: { "systemctl --user enable --now cp-daemon.service": { status: 1, stderr: "boom" } } });
	const rolledUnits = legacyHome(rolled, true);
	const back = await rolled.install([]);
	assert.match(back.out, /^fail: migrate: .*rolled back/m);
	assert.deepEqual(Object.keys(rolledUnits).filter((name) => !existsSync(join(rolled.unitDir, name))), [], "the legacy and operator units kept by the rollback");
	assert.ok(!rolled.calls("systemctl").some((call) => call.includes("cp-operator")), "no command touches the operator units");
	const hand = r.user({ ifaces: HOSTS });
	legacyHome(hand, true);
	const mine = "[Service]\nExecStart=/usr/bin/tmux new-session -d -s mine\n";
	writeFileSync(join(hand.unitDir, OPERATOR_RESUME_UNIT), mine);
	const done = await hand.install([]);
	assert.deepEqual([existsSync(join(hand.unitDir, OPERATOR_UNIT)), hand.text(join(hand.unitDir, OPERATOR_RESUME_UNIT))], [false, mine], "a hand-written one stays");
	assert.match(done.out, new RegExp(`^changed: migrate: cp-daemon\\.service runs the parent supervisor and the viewer; removed .*${OPERATOR_UNIT} \\(the parent host kept running; the operator units never stopped\\)`, "m"));
	assert.ok(!hand.calls("systemctl").some((call) => call.includes("cp-operator")));
});

/** A scratch dir removed after the test, for the shell entry points. */
function scratch(t: TestContext): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14e-sh-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

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

test("P14e-sh-clone: install.sh clones, then execs install.ts", (t) => {
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

test("P14e-sh-origin: install.sh refuses another origin", (t) => {
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

test("P14e-sh-nofetch: install.sh --dry-run never fetches", (t) => {
	const dir = scratch(t);
	const { env, argvFile } = fakeGit(dir, "https://example.invalid/cp.git");
	const app = join(dir, ".pi-command-post/app");
	mkdirSync(join(app, ".git"), { recursive: true });
	mkdirSync(join(app, "src/service"), { recursive: true });
	writeFileSync(join(app, "src/service/install.ts"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	const dry = spawnSync("sh", [join(REPO_ROOT, "scripts/install.sh"), "--dry-run"], { env, encoding: "utf8" });
	assert.equal(dry.status, 0, dry.stdout + dry.stderr);
	assert.match(dry.stdout, /changed: code: would fetch origin main and fast-forward .* \(dry-run: nothing fetched\)/);
	assert.doesNotMatch(readFileSync(join(dir, "git.log"), "utf8"), /\bfetch\b|\bmerge\b/);
	assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), ["--dry-run"]);
});

test("P14e-sh-npm: install.sh runs npm ci only when needed", (t) => {
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
	assert.match(again.stdout, /ok: code: .*node_modules matches package-lock\.json/);
	assert.equal(npmCalls().length, 1, "a current node_modules is not reinstalled");
});

test("P14e-sh-cp-install: bin/cp-install forwards every flag", (t) => {
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

test("P14e-sh-posix: cp-bootstrap is POSIX sh and short", (t) => {
	assert.equal(spawnSync("sh", ["-n", BOOTSTRAP]).status, 0);
	assert.ok(readFileSync(BOOTSTRAP, "utf8").trimEnd().split("\n").length <= 60);
	const check = spawnSync("shellcheck", ["-s", "sh", BOOTSTRAP], { encoding: "utf8" });
	if (check.error) return t.skip("shellcheck is not installed");
	assert.equal(check.status, 0, check.stdout);
});

test("P14e-sh-bootstrap-dry: cp-bootstrap dry run and refusals", (t) => {
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

test("P14e-sh-bootstrap-app: cp-bootstrap honours --app", (t) => {
	const dir = scratch(t);
	const { env } = fakeGit(dir, "https://example.invalid/cp.git");
	const fresh = join(dir, "custom-app");
	for (const args of [["--dry-run", "--app", fresh], ["--dry-run", `--app=${fresh}`]]) {
		const dry = spawnSync("sh", [BOOTSTRAP, ...args], { env: { ...env, CP_APP: join(dir, "elsewhere") }, encoding: "utf8" });
		assert.equal(dry.status, 0, dry.stdout + dry.stderr);
		assert.ok(dry.stdout.includes(`would git clone --branch main https://example.invalid/cp.git ${fresh}, npm ci`), dry.stdout);
		assert.equal(existsSync(fresh), false);
	}
	const app = join(dir, "app");
	mkdirSync(join(app, ".git"), { recursive: true });
	mkdirSync(join(app, "bin"));
	writeFileSync(join(app, "bin/cp-install"), `#!/bin/sh\necho "cp-install $*"\n`);
	for (const flag of [["--app", app], [`--app=${app}`]]) {
		const dry = spawnSync("sh", [BOOTSTRAP, "--dry-run", ...flag], { env, encoding: "utf8" });
		assert.equal(dry.status, 0, dry.stdout + dry.stderr);
		assert.ok(dry.stdout.includes(`changed: bootstrap: would fetch origin main and fast-forward ${app} when behind (dry-run: nothing fetched; not ahead of the local origin/main)`), dry.stdout);
		assert.ok(dry.stdout.includes(`cp-install --app ${app} --dry-run ${flag.join(" ")}`), dry.stdout);
	}
	assert.doesNotMatch(readFileSync(join(dir, "git.log"), "utf8"), /\bfetch\b|\bmerge\b/);

	// A checkout ahead of its local origin/main is refused in a dry run as in a real one, still without a fetch.
	const genv = { HOME: dir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1" };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: genv, encoding: "utf8" });
	const seed = join(dir, "seed");
	mkdirSync(seed);
	git(dir, "init", "-q", "-b", "main", seed);
	git(seed, "commit", "-q", "--allow-empty", "-m", "seed");
	const ahead = join(dir, "ahead");
	git(dir, "clone", "-q", "--branch", "main", seed, ahead);
	git(ahead, "commit", "-q", "--allow-empty", "-m", "local");
	const refused = spawnSync("sh", [BOOTSTRAP, "--dry-run", "--app", ahead], { env: genv, encoding: "utf8" });
	assert.equal(refused.status, 1, refused.stdout + refused.stderr);
	assert.ok(refused.stdout.includes(`fail: bootstrap: ${ahead} has commits not on origin/main; push or drop them, then rerun`), refused.stdout);
	assert.equal(existsSync(join(ahead, ".git/FETCH_HEAD")), false, "a dry run never fetches");
});

test("P14e-sh-bootstrap-rerun: cp-bootstrap rerun is all ok", (t) => {
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

const NO_MODELS = "No models available. Use /login or set an API key environment variable.\n";
const LOCAL = ["--no-start", "--viewer-host", "127.0.0.1"];
/** The unit, the wrapper and data/daemon.json as written: the files a model pin lives in. */
const snapshot = (u: User) => [u.text(u.unit), u.text(join(u.binDir, "cp-operator")), u.text(u.paths.config)];
const exportsOf = (u: User) => (u.text(join(u.binDir, "cp-operator")) ?? "").split("\n").find((line) => line.startsWith("export ")) ?? "";

test("P14e-install-models: questions, defaults, flags and pins", { timeout: 600_000 }, async (t) => {
	const r = rig(t);
	const picks = [];
	for (const [replies, enter] of [[[""], "1"], [["2"], "2"], [["openai-codex/gpt-6.1-sol"], "openai-codex/gpt-6.1-sol"], [["2", "1"], "2"]] as const) {
		const u = r.user();
		const run = await u.install(LOCAL, [...replies]);
		const asked = run.out.split(/\n(?=Model for )/).slice(1).map((q) => q.slice(0, q.indexOf("]: ") + 3));
		assert.deepEqual(asked.map((q) => q.split(" — ")[0]), ["Model for the parent", "Model for the operator session"], run.out);
		assert.equal(asked[0]!.split("\n").slice(1, -1).join("\n"), asked[1]!.split("\n").slice(1, -1).join("\n"), "the same numbered list");
		assert.match(asked[0]!, /\n {2}1\) anthropic\/claude-opus-5-5 +recommended: in the routing rubric\n/);
		assert.match(asked[0]!, /none \[1\]: $/);
		assert.ok(asked[1]!.endsWith(`none [${enter}]: `), asked[1]);
		picks.push(u.pinned());
		if (replies[0] === "") assert.deepEqual(lines(run.out, "changed").filter((line) => line.includes(" model:")), [
			"changed: model: parent anthropic/claude-opus-5-5 (recommended: in the routing rubric; --parent-model overrides)",
			"changed: model: operator anthropic/claude-opus-5-5 (recommended: in the routing rubric; --operator-model overrides)",
		]);
	}
	assert.deepEqual(picks, [["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"], ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"], ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"], ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"]]);
	const none = r.user();
	const unpinned = await none.install(LOCAL, ["none"]);
	assert.match(unpinned.out, /none \[none\]: /, "the operator inherits none");
	assert.doesNotMatch(snapshot(none).join("\n"), /parent_model|CP_PARENT_MODEL|CP_OPERATOR_MODEL/);
	const failures = [];
	for (const [replies, why, flag] of [[["x/y"], "x/y is not a model pi can use", "--parent-model"], [["", "7"], "7 is not one of the choices", "--operator-model"]] as const) {
		const u = r.user();
		const run = await u.install(LOCAL, [...replies]);
		failures.push([run.code, new RegExp(`^fail: model: ${why}.*rerun with ${flag} <provider/model>$`, "m").test(run.out), existsSync(u.paths.config), existsSync(join(u.binDir, "cp-operator"))]);
	}
	assert.deepEqual(failures, [[1, true, false, false], [1, true, false, false]], "a failed choice writes nothing");

	const saved = r.user({ env: { ANTHROPIC_API_KEY: "sk-shell-only" } });
	const sessions = join(saved.cpHome, layoutForHome("multi", saved.cpHome).sessions);
	mkdirSync(sessions, { recursive: true });
	writeFileSync(join(sessions, "cp-parent-control.json"), JSON.stringify({ model: "openai/gpt-6.1-sol" }));
	const recommended = await saved.install([...LOCAL, "--yes"], []);
	assert.doesNotMatch(recommended.out, /\]: /, "--yes asks nothing");
	for (const role of ["parent", "operator"]) assert.ok(recommended.out.includes(`changed: model: ${role} openai/gpt-6.1-sol (recommended: the parent's current model (cp-parent-control.json); --${role}-model overrides)`), recommended.out);
	const [keys, path] = (saved.text(join(saved.sm, "list-env")) ?? "").split("\n");
	assert.deepEqual([keys!.split(" ").includes("ANTHROPIC_API_KEY"), path], [false, saved.config()?.path], "cp-daemon's PATH, no shell-only provider key");
	const env = r.user({ env: { CP_PARENT_MODEL: "openai-codex/gpt-6.1-sol" } });
	assert.match((await env.install(LOCAL, [""])).out, /1\) openai-codex\/gpt-6\.1-sol +recommended: the parent's default/);
	const unlisted = r.user({ env: { CP_PARENT_MODEL: "openai/not-logged-in" } });
	await unlisted.install([...LOCAL, "--yes"]);
	assert.deepEqual([env.pinned()[0], unlisted.pinned()[0]], ["openai-codex/gpt-6.1-sol", "anthropic/claude-opus-5-5"], "an unlisted default is never recommended");

	const flagged = [];
	for (const [args, replies] of [[["--parent-model", "openai/gpt-6.1-sol"], undefined], [[...PINNED.slice(0, 2), "--operator-model", "anthropic/claude-opus-5-5"], undefined], [["--operator-model", "openai-codex/gpt-6.1-sol"], ["2"]], [["--operator-model", "openai-codex/gpt-6.1-sol", "--yes"], undefined]] as const) {
		const u = r.user();
		const run = await u.install([...LOCAL, ...args], replies && [...replies]);
		flagged.push([...u.pinned(), (run.out.match(/^Model for [^—]+/gm) ?? []).map((q) => q.trim())]);
	}
	assert.deepEqual(flagged, [
		["openai/gpt-6.1-sol", "openai/gpt-6.1-sol", []],
		["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5", []],
		["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol", ["Model for the parent"]],
		["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol", []],
	]);
	const wrongFlag = r.user();
	const wrong = await wrongFlag.install([...LOCAL, "--operator-model", "x/y"]);
	assert.deepEqual([wrong.code, /^fail: model: x\/y \(--operator-model\) is not a model pi can use/m.test(wrong.out), wrongFlag.config()], [1, true, null]);
	const empty = r.user({ models: NO_MODELS });
	assert.ok((await empty.install([...LOCAL, "--parent-model", "x/y"])).out.includes("skip: model: parent x/y (--parent-model) written unchecked: pi's model list is empty"));
	assert.equal(empty.pinned()[0], "x/y");

	const later = r.user({ models: NO_MODELS });
	const first = await later.install(LOCAL, []);
	const line = lines(first.out, "skip").find((l) => l.startsWith("skip: model: no model pi can use as the service sees it (")) ?? "";
	assert.match(line, /auth\.json.*run `pi`, then \/login, then /, first.out);
	assert.ok(line.includes(`then ${later.app}/bin/cp-install --home ${later.cpHome} --app ${later.app} --force (without --force a rerun keeps this unpinned;`), line);
	assert.match(line, /--force also reruns npm ci and replaces data\/daemon\.json, a unit or the wrapper that differs.*a login can still leave nothing to pin$/);
	assert.doesNotMatch(first.out, /^Model for /m);
	assert.doesNotMatch(snapshot(later).join("\n"), /parent_model|CP_PARENT_MODEL|CP_OPERATOR_MODEL/);
	assert.match(first.out, /^skip: login: no provider/m, "the login step is unchanged");
	writeFileSync(join(later.sm, "models.txt"), LISTING);
	const before = snapshot(later);
	const rerun = await later.install(LOCAL);
	assert.ok(rerun.out.includes("skip: model: parent: none pinned; --force asks, --parent-model <provider/model> --force pins one"), rerun.out);
	assert.deepEqual(snapshot(later), before, "a rerun keeps the unpinned choice");
	await later.install([...LOCAL, "--force", "--yes"]);
	assert.deepEqual(later.pinned(), ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5"]);

	const kept = r.user();
	await kept.install(LOCAL, ["2"]);
	const pins = snapshot(kept);
	const at = kept.log().length;
	const again = await kept.install(LOCAL, []);
	assert.deepEqual(lines(again.out, "ok").filter((l) => l.includes(" model:")), ["ok: model: parent openai/gpt-6.1-sol kept", "ok: model: operator openai/gpt-6.1-sol kept"]);
	assert.deepEqual([...lines(again.out, "changed"), ...lines(again.out, "fail"), /^Model for /m.test(again.out)], [false]);
	assert.deepEqual(kept.log().slice(at).filter((call) => call === "pi --no-extensions --list-models"), ["pi --no-extensions --list-models"]);
	await kept.install([...LOCAL, "--force", "--yes"]);
	assert.deepEqual(snapshot(kept), pins, "--force never re-asks a pinned choice");
	const older = r.user();
	await older.install([...LOCAL, ...PINNED]);
	const wrapper = join(older.binDir, "cp-operator");
	writeFileSync(wrapper, older.text(wrapper)!.replace(" CP_PARENT_MODEL='openai/gpt-6.1-sol' CP_OPERATOR_MODEL='openai/gpt-6.1-sol'", ""));
	const old = snapshot(older);
	const quiet = await older.install(LOCAL);
	assert.deepEqual([lines(quiet.out, "changed"), lines(quiet.out, "fail")], [[], []], quiet.out);
	assert.deepEqual(snapshot(older), old);
	assert.doesNotMatch(exportsOf(older), /CP_PARENT_MODEL/);
});

test("P14e-install-gateway: opt-in, validated, kept, tightened", { timeout: 600_000 }, async (t) => {
	const r = rig(t);
	const KEY = "k3y-VALUE";
	const gw = (o: UserOpts = {}) => {
		const u = r.user(o);
		writeFileSync(join(u.home, "gw-key"), `${KEY}\n`);
		const capacity = join(u.cpHome, layoutForHome("multi", u.cpHome).data, "capacity.json");
		return Object.assign(u, { capacity, keyFile: gatewayKeyFile({ HOME: u.home })!, flags: ["--gateway-key-file", join(u.home, "gw-key")] });
	};
	const plain = await r.user().install([...LOCAL, ...PINNED]);
	assert.ok(plain.out.includes("skip: gateway: not set up (optional: capacity-aware routing through a sub2api gateway); add it later: cp-install --gateway-url https://<gateway> --gateway-key-file <file>"), plain.out);
	const u = gw();
	const set = await u.install([...LOCAL, ...PINNED, "--gateway-url", "https://gw.example", ...u.flags]);
	assert.deepEqual(JSON.parse(u.text(u.capacity)!), { url: "https://gw.example/", path: "/api/v1/admin/ops/concurrency" });
	assert.deepEqual([statSync(u.capacity).mode & 0o777, statSync(u.keyFile).mode & 0o777, u.keyFile], [0o600, 0o600, join(u.home, ".config/pi-command-post/gateway.env")]);
	assert.match(u.text(u.keyFile)!, new RegExp(`^CP_GATEWAY_ADMIN_KEY=${KEY}$`, "m"));
	assert.deepEqual([set.out, u.log().join("\n"), ...snapshot(u)].filter((text) => text?.includes(KEY)), [], "the key leaks nowhere");
	configureLayout("multi", u.cpHome);
	assert.equal(loadCapacityConfig(u.cpHome).endpoint, "https://gw.example/api/v1/admin/ops/concurrency", "what the parent host reads");
	const files = snapshot(u);
	const kept = await u.install(LOCAL);
	assert.ok(kept.out.includes(`ok: gateway: ${u.capacity} kept`) && kept.out.includes(`ok: gateway-key: ${u.keyFile} kept`), kept.out);
	assert.deepEqual(snapshot(u), files, "no unit changes");

	const refusals = [];
	for (const [url, keyArgs] of [["http://gw.example"], ["https://u:p@gw.example"], ["https://gw.example/x"], ["https://gw.example/?q=1"], ["gw.example"], ["https://gw.example", []], ["https://gw.example", ["bad"]]] as const) {
		const v = gw();
		writeFileSync(join(v.home, "bad"), "k3y with space\n");
		const run = await v.install([...PINNED, "--viewer-host", "127.0.0.1", "--gateway-url", url, ...(keyArgs === undefined ? v.flags : keyArgs.map((name) => ["--gateway-key-file", join(v.home, name)]).flat())]);
		const fail = lines(run.out, "fail").find((line) => line.startsWith("fail: gateway: ")) ?? run.out;
		refusals.push([run.code, existsSync(v.cpHome), existsSync(v.keyFile), v.log().some((call) => call.includes("cp-daemon.service") || call.startsWith("daemon ")), keyArgs?.[0] === "bad" ? /holds whitespace/.test(fail) && !fail.includes("k3y with space") : keyArgs ? /needs the admin key.*--gateway-key-file/.test(fail) : fail.endsWith("; nothing written")]);
	}
	assert.deepEqual(refusals.slice(0, 5).map((row) => row.slice(0, 4)), Array(5).fill([1, false, false, false]), "a bad url writes and starts nothing");
	assert.deepEqual(refusals.slice(5).map((row) => row.slice(0, 4)), Array(2).fill([1, false, false, false]), "a missing or bad key writes nothing");
	assert.deepEqual(refusals.map((row) => row[4]), Array(7).fill(true), `each refusal names its cause: ${JSON.stringify(refusals)}`);

	writeFileSync(u.capacity, `${JSON.stringify({ url: "https://gw.example/", path: "/api/v1/admin/ops/concurrency", quota: { five_hour: 80 } })}\n`);
	const other = await u.install([...LOCAL, "--gateway-url", "https://gw2.example"]);
	assert.ok(other.code === 1 && other.out.includes(`fail: gateway: ${u.capacity} names https://gw.example/; rerun with --force`), other.out);
	await u.install([...LOCAL, "--force", "--gateway-url", "https://gw2.example"]);
	assert.deepEqual(JSON.parse(u.text(u.capacity)!), { url: "https://gw2.example/", path: "/api/v1/admin/ops/concurrency", quota: { five_hour: 80 } });
	writeFileSync(join(u.home, "gw-key2"), "other-k3y\n");
	const key2 = ["--gateway-key-file", join(u.home, "gw-key2")];
	const otherKey = await u.install([...LOCAL, ...key2]);
	assert.ok(otherKey.code === 1 && otherKey.out.includes(`fail: gateway: ${u.keyFile} holds another key; rerun with --force`), otherKey.out);
	await u.install([...LOCAL, "--force", ...key2]);
	assert.match(u.text(u.keyFile)!, /^CP_GATEWAY_ADMIN_KEY=other-k3y$/m);
	chmodSync(u.keyFile, 0o644);
	assert.ok((await u.install(LOCAL)).out.includes(`changed: gateway-key: tightened ${u.keyFile} to 0600`));
	const tightened = [];
	for (const dry of [true, false]) {
		chmodSync(u.keyFile, 0o644);
		const run = await u.install([...LOCAL, ...(dry ? ["--dry-run"] : []), "--gateway-url", "https://gw2.example", ...key2]);
		tightened.push([run.out.includes(`changed: gateway-key: tightened ${u.keyFile} to 0600`), statSync(u.keyFile).mode & 0o777, run.out.includes("other-k3y")]);
	}
	assert.deepEqual(tightened, [[true, 0o644, false], [true, 0o600, false]], "--dry-run writes nothing; the flag path tightens");
	assert.deepEqual(readGatewayKey(u.keyFile), { key: "other-k3y" }, "what the parent host reads");
	const dry = gw();
	const plan = await dry.install([...LOCAL, ...PINNED, "--dry-run", "--gateway-url", "https://gw.example", ...dry.flags]);
	assert.match(plan.out, /^changed: gateway-key: wrote.*\(dry-run\)$/m);
	assert.deepEqual([existsSync(dry.capacity), existsSync(dry.keyFile)], [false, false]);
	const gone = await u.install(["--uninstall"]);
	assert.ok(gone.out.includes(`skip: uninstall: ${u.keyFile} kept (your gateway admin key; remove it yourself)`) && existsSync(u.keyFile), gone.out);
});
