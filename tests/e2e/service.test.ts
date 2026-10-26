/**
 * Behavior 15 (P14): install, service and doctor surfaces through a real pi parent with the command-post extension.
 * The package is a copy of this checkout's tracked files, so its installed pi and PATH are the scenario's own; host
 * tools are scripts in a scratch bin dir. Nothing here touches the host's services, ~/.pi or its PATH tools.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import { layoutForHome } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { PI_PACKAGE_PATH } from "../../src/pi-version-nudge.ts";
import type { CheckRecord, HealthRecord } from "../../src/service/health.ts";
import { LEGACY_UNITS } from "../../src/service/daemon-backend.ts";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { RETIRED_INSTALL_FLAGS } from "../../src/service/install.ts";
import {
	COMMAND_POST_EXTENSION, CP_BRIDGE_EXTENSION, createAgentDir, createScratchHome, MockProvider, REPO_ROOT, type RpcRecord, type ScriptStep, startPiChild,
} from "../harness/index.ts";
import { parentHostPids, teardownHome } from "../harness/parent-hosts.ts";

let pkg = "";
before(() => {
	pkg = mkdtempSync(join(tmpdir(), "cp-p14-pkg-"));
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
	for (const file of files.split("\0").filter(Boolean)) {
		mkdirSync(dirname(join(pkg, file)), { recursive: true });
		copyFileSync(join(REPO_ROOT, file), join(pkg, file));
	}
	// The repo's dependencies linked in, but real dirs down to a copied pi package.json (`installed()` rewrites it)
	// and only the package's own pi on .bin: nudges must skip it as "ours".
	const mirror = (rel: string, keep: string) => {
		mkdirSync(join(pkg, rel), { recursive: true });
		for (const name of readdirSync(join(REPO_ROOT, rel)).filter((entry) => entry !== keep && entry !== ".bin")) {
			symlinkSync(join(REPO_ROOT, rel, name), join(pkg, rel, name));
		}
	};
	const parts = PI_PACKAGE_PATH.split("/");
	for (let n = 1; n < parts.length; n += 1) mirror(parts.slice(0, n).join("/"), parts[n]!);
	copyFileSync(join(REPO_ROOT, PI_PACKAGE_PATH), join(pkg, PI_PACKAGE_PATH));
	mkdirSync(join(pkg, "node_modules", ".bin"));
	symlinkSync(realpathSync(join(REPO_ROOT, "node_modules", ".bin", "pi")), join(pkg, "node_modules", ".bin", "pi"));
});
after(() => rmSync(pkg, { recursive: true, force: true }));

const notices = (records: readonly RpcRecord[]) =>
	records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));

/** A scratch bin dir: node and git always; `tools` adds the named stubs, `hostPi` a host `pi` that logs each probe. */
function bin(t: TestContext, tools: string[], hostPi?: string) {
	const dir = mkdtempSync(join(tmpdir(), "cp-p14-bin-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	symlinkSync(process.execPath, join(dir, "node"));
	symlinkSync(realpathSync(whichAll("git")[0]!), join(dir, "git"));
	const log = join(dir, "calls.log");
	const script = (body: string) => `#!/bin/sh\necho "$0 $*" >> ${log}\n${body}\n`;
	for (const tool of tools) writeFileSync(join(dir, tool), script("exit 0"), { mode: 0o755 });
	if (hostPi !== undefined) writeFileSync(join(dir, "pi"), script(hostPi), { mode: 0o755 });
	return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

/** Writes (or with `undefined` removes) the package's installed pi package.json. */
function installed(text: string | undefined): void {
	const file = join(pkg, PI_PACKAGE_PATH);
	rmSync(file, { force: true });
	if (text === undefined) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/** One parent session start on a fresh home; returns its notices once `/cp-version` has answered. */
async function sessionStart(t: TestContext, path: string): Promise<string[]> {
	const home = createScratchHome();
	const agentDir = createAgentDir();
	t.after(() => {
		agentDir.cleanup();
		home.cleanup();
	});
	const child = startPiChild({
		cwd: home.path,
		env: { ...agentDir.env, CP_HOME: home.path, CP_MODE: "multi", PATH: `${join(pkg, "node_modules", ".bin")}:${path}` },
		extensions: [join(pkg, "extensions", "command-post", "index.ts")],
	});
	try {
		await child.prompt("/cp-version");
		await child.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && String(r.message).includes("mode, home"), 90_000);
		return notices(child.records());
	} finally {
		await child.close();
	}
}

const INSTALL = "install: missing from PATH";
const MISMATCH = "pi version mismatch";

test("P14-nudges: session start names missing tools and a host pi drift once, and stays silent on what it cannot tell", { timeout: 300_000 }, async (t) => {
	// Missing treehouse and gh, host pi 0.85.0 against an installed 0.84.4: both warnings, nothing installed.
	t.after(() => installed(readFileSync(join(REPO_ROOT, PI_PACKAGE_PATH), "utf8")));
	installed(`{"version":"0.84.4"}`);
	const bare = bin(t, ["npm"], `echo "pi 0.85.0"`);
	const first = await sessionStart(t, bare.dir);
	const install = first.filter((n) => n.startsWith(INSTALL));
	assert.equal(install.length, 1, first.join("\n---\n"));
	assert.match(install[0]!, /^install: missing from PATH: treehouse, gh\n/, "every missing tool, and only those");
	assert.match(install[0]!, /npm run doctor:install/);
	assert.doesNotMatch(install[0]!, /sudo\s+npm|sudo\s+node|pi-command-post/);
	assert.deepEqual(readdirSync(bare.dir).filter((f) => f !== "calls.log").sort(), ["git", "node", "npm", "pi"], "the nudge installed nothing");
	assert.doesNotMatch(bare.calls(), /npm/, "and ran no installer");
	const drift = first.filter((n) => n.startsWith(MISMATCH));
	assert.equal(drift.length, 1, first.join("\n---\n"));
	assert.match(drift[0]!, new RegExp(`this package installs pi 0\\.84\\.4, the pi running it is 0\\.85\\.0 \\(${bare.dir}/pi\\)`));
	assert.match(drift[0]!, /package\.json piCompat \(pi >= \d+\.\d+\.\d+, tested up to/, "the supported range (#375)");
	assert.match(drift[0]!, /pi update --self/);
	assert.match(drift[0]!, /"@earendil-works\/pi-coding-agent" is CI's tested pin/);
	assert.match(drift[0]!, /piCompat\.testedMax together, then `npm install`/);
	assert.doesNotMatch(drift[0]!, /pi-command-post/);
	assert.match(bare.calls(), /\/pi --version\n/, "the host pi was probed");

	// Every tool present and a noisier spelling of the same version: silence.
	const full = await sessionStart(t, bin(t, ["treehouse", "gh"], `printf 'pi 0.84.4\\n'`).dir);
	assert.deepEqual(full.filter((n) => n.startsWith(INSTALL) || n.startsWith(MISMATCH)), [], full.join("\n---\n"));

	// Unknown is not a mismatch: no host pi but ours, an unreadable version, or a failing probe.
	for (const host of [undefined, `echo "unknown build"`, `echo ""`, `echo "pi 9.9.9"; exit 1`]) {
		const quiet = await sessionStart(t, bin(t, ["treehouse", "gh"], host).dir);
		assert.deepEqual(quiet.filter((n) => n.startsWith(MISMATCH)), [], `host pi ${host}: ${quiet.join("\n---\n")}`);
	}

	// No readable installed version: silent, and the host pi is never spawned.
	for (const text of [undefined, "{not json", "{}", `{"version":"nightly"}`]) {
		installed(text);
		const host = bin(t, ["treehouse", "gh"], `echo "pi 0.85.0"`);
		const quiet = await sessionStart(t, host.dir);
		assert.deepEqual(quiet.filter((n) => n.startsWith(MISMATCH)), [], `installed ${text}: ${quiet.join("\n---\n")}`);
		assert.doesNotMatch(host.calls(), /\/pi /, `installed ${text}: no probe on a machine with nothing to compare`);
	}
});

const failing = (key: string, secondsAgo: number, detail = "x"): CheckRecord =>
	({ status: "fail", key, since: new Date(Date.now() - secondsAgo * 1000).toISOString(), detail, fails: 3, checked_at: new Date().toISOString() });
const healthy: CheckRecord = { status: "ok", key: null, since: new Date().toISOString(), detail: "ok", fails: 0, checked_at: new Date().toISOString() };

/** A scratch home whose `state/health.json` the test writes, plus real parent and cp-bridge sessions on it. */
async function serviceHome(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(() => teardownHome(home, () => provider.stop(), () => agentDir.cleanup()));
	const env = { ...agentDir.env, PI_HOME: home.path, CP_HOME: home.path, CP_MODE: "multi" };
	const stateDir = join(home.path, layoutForHome("multi", home.path).state);
	let scripts = 0;
	const start = (extension: string, steps: ScriptStep[]) => {
		const model = provider.addScript(`p14-${(scripts += 1)}`, steps, { onExhausted: "repeat" });
		agentDir.writeModels(provider);
		return startPiChild({ cwd: home.path, model, env, extensions: [extension] });
	};
	return {
		stateDir,
		health(checks: HealthRecord["checks"]) {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "health.json"), JSON.stringify({ schema_version: 1, last_run_at: new Date().toISOString(), checks }));
		},
		/** One parent session's alert tick: its `raised`/`withdrew` ids from the log line. */
		async tick() {
			const child = start(COMMAND_POST_EXTENSION, [{ kind: "text", text: "noted" }]);
			try {
				const at = Date.now();
				while (!/service health: raised/.test(child.stderr())) {
					if (Date.now() - at > 60_000) throw new Error(`no service health line:\n${child.stderr()}`);
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				const line = /service health: raised (.*); withdrew (.*)/.exec(child.stderr())!;
				const ids = (text: string) => (text === "none" ? [] : text.split(", "));
				return { raised: ids(line[1]!), withdrawn: ids(line[2]!) };
			} finally {
				await child.close();
			}
		},
		/** The operator answers `id` through cp_decide in a parent session; returns the tool's result. */
		async ack(id: string) {
			const quote = `${id}: ack, I will look`;
			const call = { id: "ack", name: "cp_decide", args: { target: id, decision: "ack", basis: { operator_quote: quote } } };
			const child = start(COMMAND_POST_EXTENSION, [{ kind: "tool_calls", calls: [call] }, { kind: "text", text: "noted" }]);
			try {
				await child.prompt(quote);
				await child.waitForSettled(90_000);
				return child.eventsOfType("tool_execution_end").find((end) => end.toolCallId === "ack");
			} finally {
				await child.close();
			}
		},
		/** The service-health relays one operator session posts at start, by escalation id. */
		async relays(count: number) {
			const child = start(CP_BRIDGE_EXTENSION, [{ kind: "text", text: "Noted." }]);
			try {
				const texts = () => child.records().filter((r) => r.type === "message_start" && JSON.stringify(r).includes("(service_health)")).map((r) => JSON.stringify(r));
				await child.waitFor(() => texts().length >= count, 60_000);
				return texts();
			} finally {
				await child.close();
			}
		},
	};
}

test("P14-alerts: cp-health failures become one withdrawable command-post escalation each, relayed to the operator", { timeout: 300_000 }, async (t) => {
	const h = await serviceHome(t);
	// A sticky rollback alerts at once; any other check only after 10 minutes failing.
	h.health({ update: failing("rollback_failed:abc123", 0), disk: failing("low", 540), viewer: failing("down", 660), git: healthy });
	const a = await h.tick();
	assert.equal(a.raised.length, 2, "update and viewer, not the 9-minute disk");
	const [update, viewer] = a.raised;

	// A re-tick with new detail raises nothing again; disk past 10 min raises; a recovered viewer is withdrawn.
	const record = JSON.parse(readFileSync(join(h.stateDir, "health.json"), "utf8")) as HealthRecord;
	h.health({ ...record.checks, update: { ...record.checks.update!, detail: "a different detail" }, disk: failing("low", 700), viewer: healthy });
	const b = await h.tick();
	assert.equal(b.raised.length, 1, "only the disk alert is new");
	assert.deepEqual(b.withdrawn, [viewer]);
	const disk = b.raised[0]!;

	const relayed = await h.relays(2);
	assert.equal(relayed.length, 2, relayed.join("\n"));
	const updateRelay = relayed.find((r) => r.includes(`${update} (service_health)`)) ?? "";
	assert.match(updateRelay, /\[command-post\] es-[\w-]+ \(service_health\) has been open \d+ min/, "the command post's own project");
	assert.match(updateRelay, /cp-daemon health check \\"update\\" failing since \S+ \(key rollback_failed:abc123\)/);
	assert.ok(relayed.some((r) => r.includes(`[command-post] ${disk} (service_health)`)), relayed.join("\n"));

	// The operator acknowledges the rollback; the same failure is never raised again, a new key is.
	const ack = await h.ack(update!);
	assert.equal(ack?.isError, false, JSON.stringify(ack));
	h.health({ update: record.checks.update!, disk: healthy });
	const d1 = await h.tick();
	assert.deepEqual([d1.raised, d1.withdrawn], [[], [disk]], "the answered alert stays answered");
	h.health({ update: failing("rollback_failed:def456", 0), disk: healthy });
	const d2 = await h.tick();
	assert.equal(d2.raised.length, 1, "a new failure key is a new alert");
	const last = await h.relays(1);
	assert.deepEqual(last.map((r) => /\] (es-[\w-]+) \(service_health\)/.exec(r)?.[1]), [d2.raised[0]], "only the new alert is open");
	assert.match(last[0]!, /key rollback_failed:def456/);
});

const MODELS = [
	"provider      model              context  max-out  thinking  images",
	"anthropic     claude-opus-5-5    1M       128K     yes       yes   ",
	"openai        gpt-6.1-sol        400K     128K     yes       yes   ",
	"openai        bad$id             400K     128K     yes       yes   ",
	"openai-codex  gpt-6.1-sol        400K     128K     yes       no    ",
].join("\n");

/** A scratch machine for `node <pkg>/src/service/install.ts`: HOME, a stub-only PATH and a pi listing `models.txt`. */
function machine(t: TestContext) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14-install-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const listing = join(root, "models.txt");
	const tools = bin(t, ["treehouse", "npm", "typescript-language-server", "ast-grep"], [
		`case "$*" in`,
		`  --version) echo "pi 1.4.0" ;;`,
		`  "--no-extensions --list-models") ${whichAll("env")[0]} > ${join(root, "list-env")}`,
		`    while IFS= read -r line; do printf '%s\\n' "$line"; done < ${listing} ;;`,
		`  *) exec ${realpathSync(join(REPO_ROOT, "node_modules", ".bin", "pi"))} "$@" ;;`,
		`esac`,
	].join("\n"));
	writeFileSync(join(tools.dir, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// The unit PATH puts node's own dir first: a node binary of its own keeps a host-global pi out of the listing.
	const node = join(tools.dir, "node");
	rmSync(node);
	try { linkSync(process.execPath, node); } catch { copyFileSync(process.execPath, node); chmodSync(node, 0o755); }
	const base = { HOME: "", USER: "p14", PATH: tools.dir, TERM: "dumb", ANTHROPIC_API_KEY: "sk-shell-only" };
	/** A user of its own (HOME, cp home, pi settings); the machine's tools and listing are shared. */
	const user = (name: string, settings: object, env: Record<string, string> = {}) => {
		const home = join(root, name);
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(settings));
		return { root, home, tools, node, cpHome: join(root, `${name}-cp`), env: { ...base, HOME: home, ...env } };
	};
	return { listing, user };
}

/** cp-install on a pty (`script`), so its prompts read /dev/tty; `replies` answer them in order. Returns exit and output. */
type User = ReturnType<ReturnType<typeof machine>["user"]>;
async function installOnTty(m: User, args: string[], replies: string[]): Promise<{ code: number | null; out: string }> {
	const argv = [m.node, join(pkg, "src/service/install.ts"), "--home", m.cpHome, "--app", pkg, "--no-start", "--no-pi-packages", ...args];
	const child = spawn(whichAll("script")[0]!, ["-qfec", argv.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"], { cwd: m.root, env: m.env });
	let out = "";
	let asked = 0;
	const onData = (chunk: unknown) => {
		out += String(chunk).replace(/\r/g, "");
		if (/\]: $/.test(out) && (out.match(/\]: /g)?.length ?? 0) > asked) child.stdin.write(`${replies[asked++] ?? ""}\r`);
	};
	child.stdout.on("data", onData);
	child.stderr.on("data", onData);
	const kill = setTimeout(() => child.kill("SIGKILL"), 120_000);
	const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
	clearTimeout(kill);
	return { code, out };
}

test("P14-install: cp-install lists models as the service sees them, asks once per target, and keeps the gateway key 0600", { timeout: 300_000 }, async (t) => {
	const box = machine(t);
	writeFileSync(box.listing, `${MODELS}\n`);
	const m = box.user("user", { defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol" }, { PI_CODING_AGENT_DIR: join(box.listing, "..", "user", ".pi", "agent") });
	const keyIn = join(m.root, "key.txt");
	writeFileSync(keyIn, "k3y-VALUE_=+/\n", { mode: 0o600 });
	const flags = ["--viewer-host", "127.0.0.1", "--gateway-url", "https://gw.example", "--gateway-key-file", keyIn];

	// An out-of-range pick fails before anything is written; the prompt lists the service's view of the models.
	const bad = await installOnTty(m, [...flags, `--${RETIRED_INSTALL_FLAGS[0]}`], ["9"]);
	assert.equal(bad.code, 1, bad.out);
	assert.match(bad.out, new RegExp(`--${RETIRED_INSTALL_FLAGS[0]} is deprecated and ignored: the optional tracker step was removed`));
	assert.match(bad.out, /Model for the parent — .*\(3 available/, "the unsafe id is dropped from the count");
	assert.match(bad.out, /\n {2}1\) anthropic\/claude-opus-5-5 {2}recommended: in the routing rubric\n/, "the rubric first, the unsafe id dropped");
	assert.match(bad.out, /\n {2}2\) openai\/gpt-6\.1-sol {9}in the routing rubric\n {2}3\) openai-codex\/gpt-6\.1-sol {3}your pi default\n/);
	assert.match(bad.out, /Choose 1-3, type a provider\/model, or none \[1\]: /);
	assert.match(bad.out, /fail: model: 9 is not one of the choices 1-3; rerun with --parent-model/);
	const daemonJson = join(m.cpHome, layoutForHome("multi", m.cpHome).data, "daemon.json");
	assert.equal(existsSync(daemonJson), false, "a failed pick writes nothing");
	const listEnv = readFileSync(join(m.root, "list-env"), "utf8");
	assert.doesNotMatch(listEnv, /ANTHROPIC_API_KEY|PI_CODING_AGENT_DIR|TERM=/, "a shell-only key never reaches the listing");
	assert.match(listEnv, new RegExp(`^PATH=${m.tools.dir}$`, "m"), "the unit PATH: node's dir first, deduplicated");
	const names = listEnv.split("\n").filter(Boolean).map((line) => line.split("=")[0]).filter((name) => name !== "PWD");
	assert.deepEqual(names.sort(), ["HOME", "PATH", "USER"], "HOME, USER (and LOGNAME) and the unit PATH only");

	// An unlisted ref is refused; then 2 for the parent, Enter for the operator takes the parent's pick.
	const unlisted = await installOnTty(m, [...flags, `--${RETIRED_INSTALL_FLAGS[1]}`], ["x/y"]);
	assert.match(unlisted.out, new RegExp(`--${RETIRED_INSTALL_FLAGS[1]} is deprecated and ignored`));
	assert.match(unlisted.out, /fail: model: x\/y is not a model pi can use as the service sees it/);
	const good = await installOnTty(m, flags, ["2", ""]);
	assert.equal(good.code, 0, good.out);
	assert.match(good.out, /Model for the operator session — [^]*or none \[2\]: /);
	assert.match(good.out, /changed: model: parent openai\/gpt-6\.1-sol \(chosen at the prompt; --parent-model overrides\)/);
	assert.match(good.out, /changed: model: operator openai\/gpt-6\.1-sol \(chosen at the prompt;/);
	assert.equal(JSON.parse(readFileSync(daemonJson, "utf8")).parent_model, "openai/gpt-6.1-sol");

	// The key lands in HOME/.config (no XDG_CONFIG_HOME) at 0600 and is never printed; a rerun keeps it.
	const keyFile = join(m.home, ".config", "pi-command-post", "gateway.env");
	assert.equal(statSync(keyFile).mode & 0o777, 0o600);
	assert.match(readFileSync(keyFile, "utf8"), /^CP_GATEWAY_ADMIN_KEY=k3y-VALUE_=\+\/$/m);
	assert.ok(![bad, unlisted, good].some((run) => run.out.includes("k3y-VALUE")), "the key is never printed");
	assert.match((await installOnTty(m, flags, [])).out, /ok: gateway-key: .*gateway\.env kept/);

	// XDG_CONFIG_HOME wins; a key with a space is refused without echoing it, before anything is written.
	const xdg = box.user("xdg-user", {}, { XDG_CONFIG_HOME: join(m.root, "xdg") });
	writeFileSync(keyIn, "k3y SECRET\n");
	const spaced = await installOnTty(xdg, [...flags, "--parent-model", "openai/gpt-6.1-sol"], []);
	assert.match(spaced.out, /fail: gateway: --gateway-key-file \S+: .*; nothing written/);
	assert.doesNotMatch(spaced.out, /k3y SECRET/);
	// validGatewayKey's other refusals: a quote, a backslash, non-ASCII, and a key over 4096 characters.
	const longKey = `k3y${"L".repeat(4094)}`;
	const refusals: Array<[string, string]> = [[`k3y"Q`, "a quote"], ["k3y'Q", "a quote"], ["k3y\\Q", "a backslash"], ["k3y\u00e9Q", "a non-printable"], [longKey, "longer than 4096"]];
	for (const [key, why] of refusals) {
		writeFileSync(keyIn, `${key}\n`);
		const refused = await installOnTty(xdg, [...flags, "--parent-model", "openai/gpt-6.1-sol"], []);
		assert.equal(refused.code, 1, refused.out);
		assert.match(refused.out, new RegExp(`fail: gateway: --gateway-key-file \\S+: the key [^\\n]*${why}[^\\n]*; nothing written`), key.slice(0, 9));
		assert.ok(!refused.out.includes(key.slice(0, 5)), `${key.slice(0, 5)} is never echoed`);
		assert.equal(existsSync(join(m.root, "xdg", "pi-command-post", "gateway.env")), false, "a refused key writes nothing");
	}
	assert.equal(longKey.length, 4097, "the long key is one over the cap");
	writeFileSync(keyIn, "CP_GATEWAY_ADMIN_KEY=other-key\n");
	const placed = await installOnTty(xdg, [...flags, "--parent-model", "openai/gpt-6.1-sol"], []);
	assert.equal(placed.code, 0, placed.out);
	assert.match(readFileSync(join(m.root, "xdg", "pi-command-post", "gateway.env"), "utf8"), /^CP_GATEWAY_ADMIN_KEY=other-key$/m);
});

test("P14-install-models: cp-install's model step on an empty, unreadable or long listing, and a parent that picks off-list or none", { timeout: 300_000 }, async (t) => {
	const box = machine(t);
	const run = async (name: string, settings: object, replies: string[], args: string[] = []) =>
		(await installOnTty(box.user(name, settings), ["--viewer-host", "127.0.0.1", ...args], replies)).out;

	// No table and no models are a skip that names the rerun, never a prompt or a pin.
	writeFileSync(box.listing, "error: unknown flag --list-models\n");
	assert.match(await run("no-table", {}, []), /skip: model: pi --no-extensions --list-models gave no model table: nothing pinned/);
	writeFileSync(box.listing, "No models available. Use /login or set an API key environment variable. See docs.\n");
	const none = await run("no-models", {}, []);
	assert.match(none, /skip: model: no model pi can use as the service sees it \(.*auth\.json and ambient credentials/);
	assert.doesNotMatch(none, /Model for the parent/);

	// Thirteen listed, the home's routing.json unreadable (so no rubric) and no full pi default: the first nine, asked.
	const rows = Array.from({ length: 12 }, (_, n) => `p${n} m${n} 1K`);
	writeFileSync(box.listing, `${["provider model context", ...rows, "anthropic claude-opus-5-5 1M"].join("\n")}\n`);
	const long = box.user("long", { defaultModel: "x" });
	const routing = join(long.cpHome, layoutForHome("multi", long.cpHome).data, "routing.json");
	mkdirSync(dirname(routing), { recursive: true });
	writeFileSync(routing, "{");
	const longOut = (await installOnTty(long, ["--viewer-host", "127.0.0.1"], ["p10/m10", ""])).out;
	assert.match(longOut, /\(13 available[^]*\n {2}1\) p0\/m0 {2}recommended: listed by pi\n[^]*\n {2}9\) p8\/m8 {2}listed by pi\nChoose 1-9,/);
	assert.match(longOut, /Model for the operator session — [^]*or none \[p10\/m10\]: /, "an off-list pick is the operator's default by its ref");
	assert.match(longOut, /changed: model: operator p10\/m10 \(chosen at the prompt;/);
	const nothing = await run("nothing", {}, ["none", ""]);
	assert.match(nothing, /Model for the operator session — [^]*or none \[none\]: /);
	assert.match(nothing, /skip: model: parent: none chosen;[^]*skip: model: operator: none chosen;/);

	// --yes asks nothing and pins the recommendation: with no routing.json, the shipped rubric's listed model.
	const yes = await run("yes", {}, [], ["--yes"]);
	assert.doesNotMatch(yes, /Choose 1-/);
	assert.match(yes, /changed: model: parent anthropic\/claude-opus-5-5 \(recommended: in the routing rubric; --parent-model overrides\)/);
});

/** Pids whose parent is `pid` (Linux /proc). */
function childrenOf(pid: number): number[] {
	return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((child) => {
		try {
			const stat = readFileSync(`/proc/${child}/stat`, "utf8");
			return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid;
		} catch { return false; } // exited while scanning
	});
}

/** A cp-bridge session on a fresh home shaped by `setup`: the env its host gave the parent, and the host's log. */
async function hostedParent(t: TestContext, env: Record<string, string>, setup: (home: string) => void) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	t.after(() => teardownHome(home, () => provider.stop(), () => agentDir.cleanup()));
	setup(home.path);
	const start = { id: "start", name: "cp_parent", args: { action: "start", home: home.path } };
	const model = provider.addScript("p14-host", [{ kind: "tool_calls", calls: [start] }, { kind: "text", text: "Started." }], { onExhausted: "repeat" });
	agentDir.writeModels(provider);
	const child = startPiChild({ cwd: home.path, model, env: { ...agentDir.env, CP_HOME: home.path, CP_MODE: "multi", ...env }, extensions: [CP_BRIDGE_EXTENSION] });
	try {
		await child.prompt("Start the parent.");
		let environ = "";
		for (const at = Date.now(); !environ.includes("CP_HOME="); await new Promise((resolve) => setTimeout(resolve, 200))) {
			if (Date.now() - at > 90_000) throw new Error(`no hosted parent for ${home.path}:\n${child.stderr()}`);
			const parent = parentHostPids(home.path).flatMap(childrenOf)[0];
			try { environ = parent ? readFileSync(`/proc/${parent}/environ`, "utf8") : ""; } catch { environ = ""; }
		}
		const log = join(home.path, layoutForHome("multi", home.path).state, "parent-host.log");
		const key = environ.split("\0").find((line) => line.startsWith("CP_GATEWAY_ADMIN_KEY="))?.slice("CP_GATEWAY_ADMIN_KEY=".length);
		return { key, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
	} finally {
		await child.close();
	}
}

test("P14-gateway-key: the parent host hands a 0600 gateway.env key only to a gateway home's parent, never echoing it", { timeout: 300_000 }, async (t) => {
	const capacity = (home: string) => {
		const data = join(home, layoutForHome("multi", home).data);
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "capacity.json"), JSON.stringify({ url: "https://gw.example", path: "/api/v1/admin/ops/concurrency" }));
	};
	const keyFile = (config: string, text: string, mode = 0o600) => () => {
		mkdirSync(join(config, "pi-command-post"), { recursive: true, mode: 0o700 });
		writeFileSync(join(config, "pi-command-post", "gateway.env"), text, { mode });
	};
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14-config-")));
	t.after(() => rmSync(scratch, { recursive: true, force: true }));
	const xdg = (name: string, text?: string, mode?: number) => {
		const config = join(scratch, name);
		if (text !== undefined) keyFile(config, text, mode)();
		return { XDG_CONFIG_HOME: config };
	};
	const KEY = "CP_GATEWAY_ADMIN_KEY=k3y-VALUE\n";
	const [keyed, plain, loose, blank, absent, homeless] = await Promise.all([
		hostedParent(t, xdg("keyed", KEY), capacity),
		hostedParent(t, xdg("plain", KEY), () => {}),
		hostedParent(t, xdg("loose", KEY, 0o644), capacity),
		hostedParent(t, xdg("blank", "# nothing\n"), capacity),
		hostedParent(t, xdg("absent"), capacity),
		// No XDG_CONFIG_HOME and an empty HOME: no key file at all, not one relative to the host's cwd.
		hostedParent(t, { HOME: "", XDG_CONFIG_HOME: "" }, (home) => { capacity(home); keyFile(join(home, ".config"), KEY)(); }),
	]);
	assert.equal(keyed.key, "k3y-VALUE", "a gateway home's parent gets the key");
	assert.equal(plain.key, undefined, "no capacity.json: another home keeps quota off");
	assert.equal(loose.key, undefined, "a 0644 key file is refused");
	assert.match(loose.log, /cp-bridge: gateway admin key not loaded: \S+gateway\.env is mode 644, readable beyond its owner; chmod 600 /);
	assert.equal(blank.key, undefined);
	assert.match(blank.log, /gateway admin key not loaded: \S+gateway\.env holds no CP_GATEWAY_ADMIN_KEY= line/);
	assert.equal(absent.key, undefined);
	assert.doesNotMatch(absent.log, /gateway admin key/, "an absent key file is neither a key nor a problem");
	assert.equal(homeless.key, undefined, "nowhere to look is no key");
	assert.ok(![keyed, loose, blank].some((run) => run.log.includes("k3y-VALUE")), "the host log never holds the key");
});

test("P14-units: on a systemd --user machine cp-install writes cp-daemon.service and the cp-operator and cp-tunnel wrappers, escaped, stable and read back", { timeout: 300_000 }, async (t) => {
	const box = machine(t);
	writeFileSync(box.listing, `${MODELS}\n`);
	const m = box.user("u100%", {});
	// systemd --user is running and the user lingers; every other call succeeds. The app holds a quote, %, \ and $.
	writeFileSync(join(m.tools.dir, "systemctl"), '#!/bin/sh\n[ "$2" = is-system-running ] && echo running\nexit 0\n', { mode: 0o755 });
	writeFileSync(join(m.tools.dir, "loginctl"), "#!/bin/sh\necho Linger=yes\n", { mode: 0o755 });
	// P14-install's installs run the real pi probe; this stub answers get_commands once asked, not after a pi boot.
	writeFileSync(join(m.tools.dir, "pi-machine"), readFileSync(join(m.tools.dir, "pi")), { mode: 0o755 });
	writeFileSync(join(m.tools.dir, "pi"), `#!/bin/sh\n[ "$1 $2" = "--mode rpc" ] || exec "${m.tools.dir}/pi-machine" "$@"\nread -r _\necho '${JSON.stringify({ type: "response", id: "probe", success: true, data: { commands: [{ name: "cp-version", source: "extension" }] } })}'\n`, { mode: 0o755 });
	const app = join(m.root, 'a "b" 100%\\x $HOME');
	mkdirSync(join(app, "bin"), { recursive: true });
	for (const name of readdirSync(pkg).filter((entry) => entry !== "bin")) symlinkSync(join(pkg, name), join(app, name));
	const vars = ["CP_HOME", "CP_MODE", "CP_OPERATOR_VIEWER", "CP_VIEWER_HOST", "CP_PARENT_MODEL", "CP_OPERATOR_MODEL"].map((name) => `"$${name}"`);
	writeFileSync(join(app, "bin", "cp-operator"), `#!/bin/sh\nprintf '%s|' ${vars.join(" ")} "$(pwd)"; echo "$*"\n`, { mode: 0o755 });
	writeFileSync(join(app, "bin", "cp-tunnel"), `#!/bin/sh\necho "$CP_HOME|$*"\n`, { mode: 0o755 });
	const fnm = (id: string, extra = "") => ({ ...m, env: { ...m.env, PATH: `${m.tools.dir}:/run/user/1000/fnm_multishells/${id}/bin:/opt/p14/bin:${m.tools.dir}${extra}` } });
	const flags = ["--app", app, "--viewer-host", "127.0.0.1", "--parent-model", "openai/gpt-6.1-sol", "--operator-model", "anthropic/claude-opus-5-5"];
	const unitFile = join(m.home, ".config", "systemd", "user", "cp-daemon.service");
	const first = await installOnTty(fnm("111_1"), flags, []);
	assert.equal(first.code, 0, first.out);
	const unit = readFileSync(unitFile, "utf8");
	const execStart = `ExecStart="${m.tools.dir}/node" "${app.replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\\x/, "\\\\x").replace(/\$/g, "$$$$")}/src/service/daemon.ts" "run"`;
	for (const line of [
		"# Generated by cp-install (pi-command-post); edits are refused on reinstall without --force.", execStart,
		`WorkingDirectory=${m.cpHome.replace(/%/g, "%%")}`, `Environment="CP_HOME=${m.cpHome.replace(/%/g, "%%")}"`, 'Environment="CP_MODE=multi"',
		`Environment="PATH=${m.tools.dir}:/opt/p14/bin"`, "Type=simple", "Restart=on-failure", "RestartSec=5", "RestartSteps=5",
		"RestartMaxDelaySec=300", "RestartPreventExitStatus=78", "KillMode=process", "TimeoutStopSec=30", "StartLimitIntervalSec=1800",
		"StartLimitBurst=6", "WantedBy=default.target",
	]) assert.ok(unit.split("\n").includes(line), `missing ${line}\n${unit}`);
	assert.doesNotMatch(unit, /CP_VIEWER|CP_PARENT_MODEL|CP_OPERATOR_MODEL|sudo|KEY|TOKEN|SECRET|PASSWORD/i, "no viewer host, model or secret");
	for (const line of unit.split("\n").filter((row) => row.startsWith("Environment="))) assert.match(line, /^Environment="(?:CP_[A-Z_]+|PATH)=/);
	assert.deepEqual(readdirSync(dirname(unitFile)), ["cp-daemon.service"], "no legacy cp-* unit is written");

	// The wrappers run this home's app from any directory with the pins; only the parent model is in data/daemon.json.
	const binDir = join(m.home, ".local", "bin");
	const run = (name: string, args: string[]) => execFileSync(join(binDir, name), args, { cwd: tmpdir(), encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
	assert.equal(run("cp-operator", ["--model", "x y"]), `${m.cpHome}|multi|service|127.0.0.1|openai/gpt-6.1-sol|anthropic/claude-opus-5-5|${m.cpHome}|--model x y`);
	assert.equal(run("cp-tunnel", ["up", "--hostname", "a b"]), `${m.cpHome}|up --hostname a b`);
	assert.match(readFileSync(join(binDir, "cp-tunnel"), "utf8"), /^# Generated by cp-install/m);

	// PATH is stable across shells: another fnm_multishells id rewrites nothing; a real new dir changes the unit.
	assert.equal((await installOnTty(fnm("222_2"), flags, [])).code, 0);
	assert.equal(readFileSync(unitFile, "utf8"), unit, "another shell's fnm id: the same unit");
	const gh = fnm("222_2", ":/opt/gh/bin");
	const moved = await installOnTty(gh, [...flags, "--force"], []);
	assert.equal(moved.code, 0, moved.out);
	assert.match(readFileSync(unitFile, "utf8"), new RegExp(`^Environment="PATH=${m.tools.dir}:/opt/p14/bin:/opt/gh/bin"$`, "m"));

	// With data/daemon.json gone, the pins are read back from the wrapper; a generated legacy cp-view.service and
	// cp-parent.service win over it (with --no-start a legacy home is left as is).
	const config = join(m.cpHome, layoutForHome("multi", m.cpHome).data, "daemon.json");
	rmSync(config);
	const fromWrapper = await installOnTty(gh, ["--app", app], []);
	assert.equal(fromWrapper.code, 0, fromWrapper.out);
	assert.match(fromWrapper.out, new RegExp(`ok: viewer-host: 127\\.0\\.0\\.1 kept from ${binDir}/cp-operator`));
	assert.equal(JSON.parse(readFileSync(config, "utf8")).parent_model, "openai/gpt-6.1-sol", fromWrapper.out);
	assert.equal(run("cp-operator", []), `${m.cpHome}|multi|service|127.0.0.1|openai/gpt-6.1-sol|anthropic/claude-opus-5-5|${m.cpHome}|`);
	rmSync(config);
	const generated = "# Generated by cp-install (pi-command-post); edits are refused on reinstall without --force.\n[Service]\n";
	writeFileSync(join(dirname(unitFile), "cp-view.service"), `${generated}Environment="CP_VIEWER_HOST=100.70.1.2"\n`);
	writeFileSync(join(dirname(unitFile), "cp-parent.service"), `${generated}Environment="CP_PARENT_MODEL=anthropic/claude-opus-5-5"\n`);
	const fromUnits = await installOnTty(gh, ["--app", app], []);
	assert.match(fromUnits.out, /ok: viewer-host: 100\.70\.1\.2 kept from cp-view\.service/);
	assert.match(fromUnits.out, /\nok: model: parent anthropic\/claude-opus-5-5 kept\nok: model: operator anthropic\/claude-opus-5-5 kept\n/);

	// XDG_CONFIG_HOME moves the unit dir. What a unit cannot carry is refused before anything is written.
	const xdg = box.user("xdg", {}, { XDG_CONFIG_HOME: join(m.root, "xdg") });
	assert.equal((await installOnTty(xdg, flags, [])).code, 0);
	assert.ok(existsSync(join(m.root, "xdg", "systemd", "user", "cp-daemon.service")));
	const refused = async (user: User, args: string[], why: RegExp) => {
		const out = await installOnTty(user, args, []);
		assert.equal(out.code, 1, out.out);
		assert.match(out.out, why);
		assert.equal(existsSync(join(user.cpHome, layoutForHome("multi", user.cpHome).data, "daemon.json")), false, out.out);
	};
	const broken = join(m.root, "a\nExecStart=");
	mkdirSync(broken);
	await refused(box.user("nl", {}), [...flags, "--app", broken], /fail: unit: unit value holds a line break/);
	await refused(box.user("port", {}), [...flags, "--port", "0"], /fail: unit: port must be 1-65535, got 0/);
	await refused(box.user("my home", {}), flags, /fail: unit: WorkingDirectory= cannot carry/);
	await refused(box.user("it's", {}), flags, /fail: unit: WorkingDirectory= cannot carry/);

	// systemd's own parser accepts the written unit; only this sub-step skips where systemd-analyze cannot run.
	const verify = spawnSync("systemd-analyze", ["--user", "verify", unitFile], { encoding: "utf8", env: { ...process.env, XDG_RUNTIME_DIR: m.root } });
	const unverifiable = verify.error || /Failed to initialize manager/.test(verify.stderr) ? `systemd-analyze: ${verify.error?.message ?? verify.stderr.trim()}` : false;
	await t.test("systemd-analyze --user verify accepts cp-daemon.service", { skip: unverifiable }, () => {
		assert.doesNotMatch(verify.stderr, /WorkingDirectory|fatal|bad unit|cp-daemon\.service:\d+:/i, verify.stderr);
	});
});

/**
 * A systemd --user machine for cp-install's start step: systemctl, loginctl, crontab and the app's daemon.ts are
 * logging stand-ins over one state dir per user ($SM: on-<unit> files, a `down` daemon, `manager`, `update-at`).
 */
function backendMachine(t: TestContext) {
	const box = machine(t);
	writeFileSync(box.listing, `${MODELS}\n`);
	const { tools, root } = box.user("probe", {});
	const node = process.execPath;
	const up = `const up = () => { if (fs.existsSync(sm + "/down")) return; fs.mkdirSync(require("node:path").dirname(process.env.P14_STATE), { recursive: true });
fs.writeFileSync(process.env.P14_STATE, JSON.stringify({ pid: 1, inner: { state: "ready" } }));
fs.writeFileSync(process.env.P14_RUNTIME, JSON.stringify({ units: { parent: { state: "running" }, viewer: { state: "running" } } })); };`;
	const head = (name: string) => `#!${node}\nconst fs = require("node:fs"); const sm = process.env.SM; const a = process.argv.slice(2);\nfs.appendFileSync(sm + "/calls.log", "${name} " + a.join(" ") + "\\n");\nconst read = (f) => (fs.existsSync(sm + "/" + f) ? fs.readFileSync(sm + "/" + f, "utf8") : undefined);\n${up}\n`;
	writeFileSync(join(tools.dir, "systemctl"), `${head("systemctl")}const [, verb, ...rest] = a; const units = rest.filter((w) => !w.startsWith("--")); const on = (u) => sm + "/on-" + u;
if (verb === "is-system-running") { const s = read("manager") ?? "running"; console.log(s); process.exit(s ? 0 : 1); }
if (verb === "is-active" && units[0] === "cp-update.service") { const n = String(Number(read("update-n") ?? 0) + 1); fs.writeFileSync(sm + "/update-n", n); console.log(n === read("update-at") ? "active" : "inactive"); }
else if (verb === "is-active") console.log(fs.existsSync(on(units[0])) ? "active" : "inactive");
else if (verb === "show") console.log(units.includes("cp-view.service") && a.includes("--property=Environment") ? "CP_VIEWER_HOST=100.64.0.9" : "0");
else if (verb === "enable" && rest.includes("--now")) { for (const u of units) fs.writeFileSync(on(u), ""); if (units.includes("cp-daemon.service")) up(); }
else if (verb === "disable" && rest.includes("--now")) for (const u of units) fs.rmSync(on(u), { force: true });
else if (verb === "try-restart") up();
`, { mode: 0o755 });
	writeFileSync(join(tools.dir, "loginctl"), "#!/bin/sh\necho Linger=yes\n", { mode: 0o755 });
	writeFileSync(join(tools.dir, "crontab"), `${head("crontab")}if (a[0] === "-l") { console.error("no crontab for u"); process.exit(1); }\nfs.copyFileSync(a[0], sm + "/crontab.txt");\n`, { mode: 0o755 });
	writeFileSync(join(tools.dir, "pi-machine"), readFileSync(join(tools.dir, "pi")), { mode: 0o755 });
	writeFileSync(join(tools.dir, "pi"), `#!/bin/sh\n[ "$1 $2" = "--mode rpc" ] || exec "${tools.dir}/pi-machine" "$@"\nread -r _\necho '${JSON.stringify({ type: "response", id: "probe", success: true, data: { commands: [{ name: "cp-version", source: "extension" }] } })}'\n`, { mode: 0o755 });
	// The app is this package but for src/service/daemon.ts, whose status exits 0 once $SM/running exists.
	const app = join(root, "app");
	const mirror = (rel: string, keep: string) => {
		mkdirSync(join(app, rel), { recursive: true });
		for (const name of readdirSync(join(pkg, rel)).filter((entry) => entry !== keep)) symlinkSync(join(pkg, rel, name), join(app, rel, name));
	};
	for (const [rel, keep] of [["", "src"], ["src", "service"], ["src/service", "daemon.ts"]] as const) mirror(rel, keep);
	writeFileSync(join(app, "src/service/daemon.ts"), `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${head("daemon").split("\n").slice(1).join("\n")}
if (a[0] === "status") process.exit(fs.existsSync(sm + "/running") ? 0 : 3);
if (a[0] === "start" || a[0] === "restart") { fs.writeFileSync(sm + "/running", ""); up(); }
console.log("cp-daemon " + a[0] + ": ok");
`);
	let n = 0;
	const user = (state: { legacy?: boolean; files?: Record<string, string> } = {}) => {
		const u = box.user(`u${++n}`, {});
		const sm = join(root, `sm${n}`);
		mkdirSync(sm);
		const paths = daemonPaths(u.cpHome);
		const unitDir = join(u.home, ".config", "systemd", "user");
		mkdirSync(unitDir, { recursive: true });
		if (state.legacy) {
			for (const name of LEGACY_UNITS) writeFileSync(join(unitDir, name), GENERATED);
			for (const name of ["cp-parent.service", "cp-view.service", "cp-health.timer", "cp-update.timer"]) writeFileSync(join(sm, `on-${name}`), "");
		}
		for (const [name, text] of Object.entries(state.files ?? {})) writeFileSync(join(sm, name), text);
		const env = { ...u.env, SM: sm, P14_STATE: paths.state, P14_RUNTIME: paths.runtime, CP_TEST_TIME_SCALE: "60", CP_TEST_TIME_ZERO: String(Date.now()) };
		const calls = (tool: string) => (existsSync(join(sm, "calls.log")) ? readFileSync(join(sm, "calls.log"), "utf8") : "").split("\n").filter((line) => line.startsWith(`${tool} `));
		/** cp-install with the flags P14-install pins plus `args`, on no terminal, its clock 60 times fast. */
		const install = async (args: string[]) => {
			const argv = ["--import", join(REPO_ROOT, "tests/harness/time-scale.ts"), join(pkg, "src/service/install.ts"), "--home", u.cpHome, "--app", app, "--no-pi-packages",
				"--viewer-host", "127.0.0.1", "--parent-model", "openai/gpt-6.1-sol", "--operator-model", "openai/gpt-6.1-sol", ...args];
			const child = spawn(u.node, argv, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			child.stdout.on("data", (chunk) => (out += String(chunk)));
			child.stderr.on("data", (chunk) => (out += String(chunk)));
			const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
			return { code, out };
		};
		const on = () => readdirSync(sm).filter((name) => name.startsWith("on-")).map((name) => name.slice(3)).sort();
		return { ...u, sm, paths, unitDir, install, calls, systemctl: () => calls("systemctl").map((line) => line.slice("systemctl --user ".length)), on };
	};
	return { app, node: join(tools.dir, "node"), user };
}
const GENERATED = "# Generated by cp-install (pi-command-post); edits are refused on reinstall without --force.\n";

test("P14-backend: cp-install starts cp-daemon on systemd or detached, migrates a legacy home (M1) or rolls it back, and uninstalls", { timeout: 600_000 }, async (t) => {
	const box = backendMachine(t);
	const reboot = (u: { cpHome: string }) => `"${box.node}" "${box.app}/src/service/daemon.ts" start --home "${u.cpHome}"`;
	const after = (calls: string[], from: string) => calls.slice(calls.indexOf(from));

	// The user manager's state picks the backend: running or degraded is systemd, anything else detached.
	for (const [state, backend] of [["running", /systemctl --user is running: cp-daemon runs as cp-daemon\.service/], ["degraded", /is degraded: cp-daemon runs as/],
		["offline", /no systemd --user \(offline\): cp-daemon runs detached/], ["", /no systemd --user \(unavailable\)/]] as const) {
		assert.match((await box.user({ files: { manager: state } }).install(["--dry-run"])).out, new RegExp(`ok: service: [^\\n]*${backend.source}`), state);
	}

	// systemd, fresh: daemon-reload, enable --now, ready; a changed config try-restarts; one never up fails.
	const fresh = box.user();
	const first = await fresh.install([]);
	assert.deepEqual(after(fresh.systemctl(), "daemon-reload"), ["daemon-reload", "enable --now cp-daemon.service", "is-active cp-daemon.service"], first.out);
	assert.match(first.out, /^ok: enable: cp-daemon\.service is active: the parent supervisor and the viewer run$/m);
	const changed = await fresh.install(["--force", "--port", "7301"]);
	assert.ok(fresh.systemctl().includes("try-restart cp-daemon.service"), changed.out);
	const down = box.user({ files: { down: "" } });
	assert.match((await down.install([])).out, /^fail: enable: no \S+daemon\.json yet after 60s/m);

	// --no-start: systemd enables without --now; detached prints the reboot command; a legacy home is left as it is.
	const quiet = box.user();
	const enabled = await quiet.install(["--no-start"]);
	assert.deepEqual(after(quiet.systemctl(), "daemon-reload"), ["daemon-reload", "enable cp-daemon.service"]);
	assert.match(enabled.out, /enabled, not started \(--no-start\)/);
	const idle = box.user({ files: { manager: "offline" } });
	const printed = await idle.install(["--no-start"]);
	assert.deepEqual(idle.calls("daemon"), [], "no cp-daemon call");
	assert.ok(printed.out.includes(`skip: daemon: not started (--no-start); start it now and after a reboot run: ${reboot(idle)}`), printed.out);
	const held = box.user({ legacy: true });
	const kept = await held.install(["--no-start"]);
	assert.deepEqual(held.systemctl(), ["is-system-running"], kept.out);
	assert.deepEqual([readdirSync(held.unitDir).sort(), held.on()], [[...LEGACY_UNITS].sort(), ["cp-health.timer", "cp-parent.service", "cp-update.timer", "cp-view.service"]]);
	assert.match(kept.out, /^skip: migrate: .*untouched \(--no-start\); rerun without --no-start to migrate/m);

	// detached: a stopped daemon starts, a running one restarts onto a changed config, an unchanged one is left.
	const det = box.user({ files: { manager: "offline" } });
	const started = await det.install([]);
	assert.deepEqual(det.calls("daemon").slice(0, 2), [`daemon status --home ${det.cpHome}`, `daemon start --home ${det.cpHome}`]);
	assert.match(started.out, /^changed: daemon: started \(detached\); after a reboot run: /m);
	const restarted = await det.install(["--force", "--port", "7301"]);
	assert.ok(det.calls("daemon").includes(`daemon restart --home ${det.cpHome}`), restarted.out);
	const before = det.calls("daemon").length;
	const same = await det.install(["--port", "7301", "--crontab"]);
	assert.equal(det.calls("daemon")[before], `daemon status --home ${det.cpHome}`);
	assert.doesNotMatch(det.calls("daemon").slice(before).join("\n"), / (start|restart) /, "an unchanged running daemon is left");
	assert.match(same.out, /^ok: daemon: running \(detached\)/m);
	// --crontab: one marked @reboot line through a file, never stdin; the file goes afterwards.
	const tmp = join(det.paths.stateDir, "daemon-crontab.tmp");
	assert.deepEqual(det.calls("crontab"), ["crontab -l", `crontab ${tmp}`]);
	assert.equal(existsSync(tmp), false, "the temp file is removed");
	const line = `@reboot ${reboot(det)} >/dev/null 2>&1 # cp-daemon ${det.cpHome}`;
	assert.equal(readFileSync(join(det.sm, "crontab.txt"), "utf8"), `${line}\n`);
	assert.ok(same.out.includes(`changed: crontab: added: ${line}`), same.out);

	// M1 preflight refusals: a hand-written legacy unit, an update run in flight, a recorded update phase.
	const hand = box.user({ legacy: true });
	writeFileSync(join(hand.unitDir, "cp-view.service"), "[Service]\nExecStart=/bin/true\n");
	assert.match((await hand.install([])).out, /fail: migrate: \S+cp-view\.service not written by cp-install; migrate by hand/);
	assert.match((await box.user({ legacy: true, files: { "update-at": "1" } }).install([])).out, /fail: migrate: an update run is in flight/);
	const phased = box.user({ legacy: true });
	mkdirSync(phased.paths.stateDir, { recursive: true });
	writeFileSync(phased.paths.update, JSON.stringify({ phase: "merging" }));
	assert.match((await phased.install([])).out, /records phase merging; rerun after it is idle, or with --force/);
	assert.equal(existsSync(phased.paths.config), false, "a refused preflight writes nothing");

	// M1, forced past the phase: timers off, update re-checked, viewer then parent off, cp-daemon on, legacy files go.
	const m1 = await phased.install(["--force"]);
	assert.match(m1.out, /sets CP_VIEWER_HOST=100\.64\.0\.9; cp-daemon does not read it: to keep that address rerun with --viewer-host 100\.64\.0\.9 --force/);
	assert.deepEqual(after(phased.systemctl(), "daemon-reload").slice(0, 7), ["daemon-reload", "disable --now cp-health.timer cp-update.timer", "is-active cp-update.service",
		"disable --now cp-view.service", "disable --now cp-parent.service", "enable --now cp-daemon.service", "is-active cp-daemon.service"]);
	assert.equal(phased.systemctl().at(-1), "daemon-reload");
	assert.deepEqual([readdirSync(phased.unitDir), existsSync(phased.paths.config), phased.on()], [["cp-daemon.service"], true, ["cp-daemon.service"]]);
	assert.match(m1.out, /^changed: migrate: cp-daemon\.service runs the parent supervisor and the viewer/m);

	// M1 rollback: not ready in 60 s disables cp-daemon, removes its unit and daemon.json, re-enables the legacy units.
	const back = box.user({ legacy: true, files: { down: "" } });
	mkdirSync(dirname(back.paths.log), { recursive: true });
	writeFileSync(back.paths.log, "line one\nboom: EADDRINUSE\n");
	const rolled = await back.install([]);
	assert.deepEqual(after(back.systemctl(), "disable --now cp-daemon.service").slice(0, 3), ["disable --now cp-daemon.service", "daemon-reload",
		"enable --now cp-parent.service cp-view.service cp-health.timer cp-update.timer"], rolled.out);
	assert.deepEqual([readdirSync(back.unitDir).sort(), existsSync(back.paths.config)], [[...LEGACY_UNITS].sort(), false]);
	assert.match(rolled.out, /^fail: migrate: .* after 60s; rolled back: .*cp-parent\.service active, cp-view\.service active.*boom: EADDRINUSE/m);

	// An update run that starts while the timers go off (the second check) puts the timers back and changes nothing else.
	const raced = box.user({ legacy: true, files: { "update-at": "2" } });
	const race = await raced.install([]);
	assert.ok(raced.systemctl().includes("enable --now cp-health.timer cp-update.timer"), race.out);
	assert.ok(!raced.systemctl().some((call) => /cp-parent\.service|cp-daemon\.service/.test(call)), raced.systemctl().join("\n"));
	assert.equal(existsSync(raced.paths.config), false);
	assert.match(race.out, /^fail: migrate: an update run started meanwhile/m);

	// --dry-run says what M1 would do and changes no unit.
	const dry = box.user({ legacy: true });
	const would = await dry.install(["--dry-run"]);
	assert.deepEqual(dry.systemctl().filter((call) => /daemon-reload|enable|disable/.test(call)), []);
	assert.match(would.out, /^changed: migrate: would: systemctl --user daemon-reload; disable --now cp-health\.timer cp-update\.timer/m);

	// --uninstall: disables and removes the generated units, leaves a hand-written one.
	const gone = box.user({ legacy: true });
	writeFileSync(join(gone.unitDir, "cp-daemon.service"), GENERATED);
	writeFileSync(join(gone.unitDir, "cp-health.service"), "[Service]\n");
	const removed = await gone.install(["--uninstall"]);
	assert.equal(gone.systemctl()[1], "disable --now cp-daemon.service cp-parent.service cp-view.service cp-health.timer cp-update.timer", removed.out);
	assert.deepEqual(readdirSync(gone.unitDir), ["cp-health.service"]);
	assert.match(removed.out, /^skip: uninstall: \S+cp-health\.service was not written by cp-install/m);
});
