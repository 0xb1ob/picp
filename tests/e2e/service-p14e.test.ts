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
import { layoutForHome } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { RETIRED_INSTALL_FLAGS } from "../../src/service/install.ts";
import { OPERATOR_RESUME_UNIT, OPERATOR_UNIT, renderUnits } from "../../src/service/units.ts";
import { PI_LENS_TOOLS } from "../../src/tool-manifest.ts";
import { ROLE_PACKAGES } from "../../src/worker-packages.ts";
import { REPO_ROOT } from "../harness/index.ts";

/** Every stand-in tool: logs `<tool> <args>` to $SM/calls.log, answers from $SM/answers.json (first matching prefix). */
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
/** The legacy units an older cp-install wrote (pins in cp-view and cp-parent.service), with tmux the operator units too. */
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

test("P14e-install-files: cp-install writes, keeps, refuses and replaces its files, plans a dry run and uninstalls only what it wrote", { timeout: 300_000 }, async (t) => {
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
	assert.equal(JSON.parse(u.text(join(u.cpHome, "data", "update.json")) ?? "{}").enabled, true);
	assert.doesNotMatch(u.log().join("\n"), /\bsudo\b/, "never sudo");
	const before = u.log().length;
	const second = await u.install(PINNED);
	assert.deepEqual(lines(second.out, "changed"), [], second.out);
	assert.ok(!u.log().slice(before).some((call) => call === "npm ci" || /try-restart/.test(call)), "no npm ci and no restart on an unchanged rerun");

	// A changed unit or data/daemon.json is refused without --force, nothing started; --force replaces it and try-restarts.
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

	// --dry-run: no file, no mutating command, never gh or pi; a tool a real run installs is planned and the plan goes on.
	const dry = r.user({ drop: ["treehouse"] });
	const plan = await dry.install(["--dry-run", "--yes", "--parent-model", "openai/gpt-6.1-sol"]);
	assert.equal(plan.code, 0, plan.out);
	assert.equal(existsSync(dry.cpHome), false, "the dry-run wrote no home");
	assert.deepEqual(dry.log().filter((call) => /^(npm ci|systemctl --user (enable|daemon-reload)|loginctl enable|gh |pi )/.test(call)), [], dry.log().join("\n"));
	assert.match(plan.out, /^changed: tools: a real run installs the missing required tools first:[^]*treehouse/m);
	assert.match(plan.out, /^skip: gh: login not checked in a dry-run \(gh writes state under HOME\); a real run checks it$/m);
	assert.match(plan.out, /^skip: model: parent openai\/gpt-6\.1-sol \(--parent-model\) written unchecked: a dry-run never runs pi --list-models$/m);
	assert.match(plan.out, /^changed: enable: would run/m, "the plan reaches activation");
	const bare = await r.user().install(["--dry-run"]);
	assert.match(bare.out, /^skip: model: parent, operator: not listed in a dry-run \(pi writes its state under HOME\); a real run asks or recommends/m);
	// An absent HOME stays absent: gh and pi (both write under HOME) never run.
	const homeless = r.user({ homeless: true });
	assert.equal((await homeless.install(["--dry-run", "--yes", "--viewer-host", "127.0.0.1"])).code, 0);
	assert.equal(existsSync(homeless.home), false, "HOME was never created");

	// Right after npm ci the hidden lockfile (another platform's optional packages absent) reads as fresh.
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

	// A home WorkingDirectory= cannot carry fails before anything runs; an unknown flag is refused by name.
	const spaced = r.user();
	const odd = await spaced.install(["--home", join(spaced.home, "my home")]);
	assert.match(odd.out, /^fail: unit: WorkingDirectory= cannot carry/m);
	assert.deepEqual(spaced.log(), [], "nothing ran");
	const bogus = await spaced.install(["--sudo"]);
	assert.notEqual(bogus.code, 0);
	assert.match(bogus.out, /--sudo/);

	// --uninstall stops cp-daemon and removes only what cp-install wrote: data/daemon.json too, never the home or a hand wrapper.
	writeFileSync(join(u.binDir, "cp-operator"), "#!/bin/sh\n# mine\n");
	const gone = await u.install(["--uninstall"]);
	assert.equal(gone.code, 0, gone.out);
	assert.ok(u.calls("systemctl").includes("--user disable --now cp-daemon.service"), gone.out);
	assert.deepEqual([existsSync(u.unit), existsSync(u.paths.config), existsSync(join(u.binDir, "cp-tunnel"))], [false, false, false]);
	assert.equal(u.text(join(u.binDir, "cp-operator")), "#!/bin/sh\n# mine\n", "a wrapper cp-install did not write stays");
	assert.match(gone.out, /^ok: uninstall: home \S+ kept \(data\/daemon\.json removed\) and app/m);
	assert.ok(existsSync(join(u.cpHome, "data", "update.json")), "the home's own files stay");
});

test("P14e-install-backend: detached start and reboot line, refused linger, a daemon never ready, --no-start, crontab and the operator units", { timeout: 300_000 }, async (t) => {
	const r = rig(t);
	const offline = { "systemctl --user is-system-running": { status: 1, stdout: "offline\n" } };
	// No systemd --user: cp-daemon runs detached, no unit, the reboot command printed; doctor and the wrapper still land.
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
	// --uninstall, detached: daemon.ts stop; a crontab without the marked line is not rewritten.
	off.answer({ ...offline, "crontab -l": { stdout: "@daily x\n" } });
	assert.equal((await off.install(["--uninstall"])).code, 0);
	assert.ok(off.calls("daemon").includes(`stop --home ${off.cpHome}`), off.log().join("\n"));
	assert.deepEqual(off.calls("crontab").filter((call) => call !== "-l"), [], "no marked line: the crontab is not rewritten");
	assert.equal(existsSync(off.paths.config), false);

	// --crontab (detached): the @reboot line goes through a file, never stdin.
	const cron = r.user({ answers: { ...offline, "crontab -l": { stdout: "@daily x\n" } } });
	const added = await cron.install([...PINNED, "--crontab"]);
	const tmp = join(cron.paths.stateDir, "daemon-crontab.tmp");
	assert.deepEqual([cron.calls("crontab").includes(tmp), existsSync(tmp)], [true, false], cron.log().join("\n"));
	assert.match(added.out, new RegExp(`^changed: crontab: added: @reboot .*# cp-daemon ${cron.cpHome}$`, "m"));
	assert.match(cron.text(join(cron.sm, "crontab.txt")) ?? "", /^@daily x\n@reboot /);

	// Refused linger prints the sudo line, runs no sudo and writes nothing.
	const linger = r.user({ answers: { "loginctl show-user": { stdout: "Linger=no\n" }, "loginctl enable-linger": { status: 1 } } });
	const refused = await linger.install(PINNED);
	assert.equal(refused.code, 1);
	assert.match(refused.out, /^fail: linger: loginctl enable-linger refused; run: sudo loginctl enable-linger u$/m);
	assert.deepEqual([existsSync(linger.paths.config), existsSync(join(linger.binDir, "cp-operator"))], [false, false]);

	// A cp-daemon.service that never turns active fails after the whole 60 s window, naming the journal.
	const dead = r.user({ answers: { "systemctl --user is-active cp-daemon.service": { status: 3, stdout: "failed\n" } } });
	const failed = await dead.install(PINNED);
	assert.equal(failed.code, 1);
	assert.match(failed.out, /^fail: enable: cp-daemon\.service is failed after 60s; see cp-daemon log; journalctl --user -u cp-daemon\.service -n 20$/m);
	assert.equal(dead.calls("systemctl").filter((call) => call === "--user is-active cp-daemon.service").length, 61, "polled through the whole window");
	const crashed = r.user();
	writeFileSync(join(crashed.sm, "runtime"), JSON.stringify({ units: { parent: { state: "failed", result: "exit-code" }, viewer: { state: "running" } } }));
	assert.match((await crashed.install(PINNED)).out, /^fail: enable: the parent supervisor is failed \(exit-code\) after 60s/m);
	// --no-start enables without --now and verifies nothing.
	const quiet = r.user();
	const enabled = await quiet.install([...PINNED, "--no-start"]);
	assert.equal(enabled.code, 0, enabled.out);
	assert.ok(quiet.calls("systemctl").includes("--user enable cp-daemon.service"));
	assert.ok(!quiet.calls("systemctl").some((call) => /--now|is-active|try-restart/.test(call)), quiet.calls("systemctl").join("\n"));
	assert.match(enabled.out, /^ok: enable: cp-daemon\.service enabled, not started \(--no-start\); start it: systemctl --user start cp-daemon\.service$/m);
	assert.match(enabled.out, /^skip: doctor: --no-start$/m);

	// cp-rrye: no cp-operator*.service is written; an older install's generated ones are removed, never stopped.
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
	// --uninstall never runs systemctl on the operator units (the live tmux session), but removes generated ones.
	for (const name of [OPERATOR_UNIT, OPERATOR_RESUME_UNIT]) writeFileSync(join(op.unitDir, name), old[name]!);
	const gone = await op.install(["--uninstall"]);
	assert.ok(gone.out.includes(`changed: uninstall: removed ${join(op.unitDir, OPERATOR_UNIT)}`), gone.out);
	assert.equal(existsSync(join(op.unitDir, OPERATOR_RESUME_UNIT)), false, "and its resume twin");
	assert.ok(!op.calls("systemctl").some((call) => call.includes("cp-operator") || /--user (stop|kill)/.test(call)), op.calls("systemctl").join("\n"));

	// Launchers: tmux and herdr on the installing PATH are printed; herdr without its pi integration prints the hint only.
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

test("P14e-install-viewer-host: --viewer-host is checked against this machine, a fresh install asks once or takes Tailscale, a kept pin is never re-asked", { timeout: 300_000 }, async (t) => {
	const r = rig(t);
	const quiet = [...PINNED, "--no-start"];
	const notOk = (out: string) => [...lines(out, "changed"), ...lines(out, "fail")];
	// A flag pins data/daemon.json and the wrapper, never the unit; a rerun with it or without is all ok/skip.
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

	// Wildcard, public, link-local, mapped, zoned, non-IP and foreign addresses fail before npm ci and write nothing.
	const bad = r.user({ ifaces: { ...HOSTS, eth1: ["169.254.1.1"] } });
	const refusals = [];
	for (const value of ["0.0.0.0", "::", "8.8.8.8", "2001:4860::8888", "fe80::1", "fe80::1%eth0", "169.254.1.1", "::ffff:10.0.0.1", "localhost", "10.9.9.9"]) {
		const run = await bad.install([...quiet, "--viewer-host", value]);
		refusals.push(run.code === 1 && /^fail: viewer-host: /m.test(run.out) ? "refused" : `${value}: ${run.out}`);
	}
	assert.deepEqual(new Set(refusals), new Set(["refused"]));
	assert.deepEqual([bad.calls("npm"), existsSync(bad.cpHome)], [[], false], "nothing ran or was written");

	// Fresh on a terminal: one numbered question, Tailscale recommended; Enter takes it, a number or a local IP picks.
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

	// --yes pins the Tailscale address unasked; with none nothing is pinned, the files as on a host with no interfaces.
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

	// An existing data/daemon.json keeps its host (none) unasked; another --viewer-host needs --force, then restarts cp-daemon.
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

	// A legacy cp-view.service drop-in's CP_VIEWER_HOST is reported once by M1's preflight, never adopted.
	const drop = r.user({ answers: { "systemctl --user show cp-view.service --property=Environment --value": { stdout: "CP_HOME=/h CP_VIEWER_HOST=10.1.1.1\n" } } });
	mkdirSync(drop.unitDir, { recursive: true });
	for (const [name, text] of Object.entries(renderUnits({ node: drop.node, app: drop.app, home: drop.cpHome, path: "/bin", port: 8766 }))) writeFileSync(join(drop.unitDir, name), text);
	const reported = await drop.install([...PINNED, "--yes"]);
	assert.equal(lines(reported.out, "skip").filter((line) => line.startsWith("skip: viewer-host: a drop-in on cp-view.service sets CP_VIEWER_HOST=10.1.1.1")).length, 1, reported.out);
	assert.equal(drop.config()?.viewer_host, undefined);
	// --dry-run prints the choice and writes nothing, never asking.
	const dry = r.user({ ifaces: HOSTS, answers: TAILSCALE });
	const plan = await dry.install(["--dry-run"], []);
	assert.match(plan.out, /^changed: viewer-host: 100\.80\.0\.1 \(tailscale;.*\(dry-run\)$/m);
	assert.deepEqual([existsSync(dry.cpHome), /Dashboard address/.test(plan.out)], [false, false]);
});
