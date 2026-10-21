/**
 * Disposable Docker sandbox for the real install entry points (#375; tests/e2e/README.md "Installer sandbox").
 * Host: builds tests/fixtures/install/Dockerfile, streams a tar of this checkout's files into a `--network none`
 * container and reads back one result line. Inside (`--inside`): the scenario runs bin/cp-bootstrap end to end.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { daemonPaths } from "../../src/service/daemon-files.ts";
import { realpathSync as entryRealpath } from "node:fs";
import { fileURLToPath as entryPath } from "node:url";

export const SCENARIOS = ["fresh", "prerequisites", "rerun", "login", "recovery", "root", "compat", "onboarding", "prompt", "node-floor"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const IMAGE = "picp-install-sandbox:local";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RESULT_MARK = "INSTALL_SANDBOX_RESULT ";
const PHASE_TIMEOUT_MS = 300_000;

export interface Phase { phase: string; seconds: number; exit: number | null; slowest?: string[] }
export interface ScenarioResult {
	scenario: string;
	seconds: number;
	phases: Phase[];
	failures: string[];
	/** The last install's `skip:`/`fail:` lines (what a fresh user still has to do), or the scenario's own notes. */
	observed: string[];
}
export interface SandboxRun { scenario: string; exit: number | null; seconds: number; result?: ScenarioResult; output: string }

const since = (start: number): number => Math.round((performance.now() - start) / 10) / 100;

// ---- host side ------------------------------------------------------------------------------------------------

/** Why Docker cannot run the sandbox here, or undefined when it can. */
export function dockerUnavailable(): string | undefined {
	const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 30_000 });
	if (probe.status === 0) return undefined;
	return `docker is not usable here (${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}); the installer sandbox needs a Docker daemon`;
}

/** Builds IMAGE from the fixture, the lockfile's pi and the packages cp-install would install; returns seconds. */
export async function buildImage(): Promise<number> {
	const { PI_LENS_TOOLS } = await import("../../src/tool-manifest.ts");
	const { workerPackageSpecs } = await import("../../src/service/install.ts");
	const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
	const pi = lock.packages["node_modules/@earendil-works/pi-coding-agent"]?.version;
	if (!pi) throw new Error("package-lock.json resolves no @earendil-works/pi-coding-agent");
	const start = performance.now();
	// The context is only the Dockerfile and the lockfile pair, streamed as a tar: nothing is written on the host.
	const context = spawnSync("tar", ["-c", "-C", ROOT, "--transform", "s|^tests/fixtures/install/||", "tests/fixtures/install/Dockerfile", "package.json", "package-lock.json"], { maxBuffer: 64 << 20 });
	if (context.status !== 0) throw new Error(`tar of the build context failed: ${context.stderr}`);
	const args = ["build", "-q", "-t", IMAGE, "--build-arg", `PI_VERSION=${pi}`, "--build-arg", `LENS_PACKAGES=${PI_LENS_TOOLS.packages.join(" ")}`, "--build-arg", `WORKER_PACKAGES=${workerPackageSpecs().join(" ")}`, "-"];
	const built = spawnSync("docker", args, { input: context.stdout, encoding: "utf8", timeout: 1_800_000, maxBuffer: 64 << 20 });
	if (built.status !== 0) throw new Error(`docker build failed (exit ${built.status}): ${tail(`${built.stdout}${built.stderr}${built.error?.message ?? ""}`, 40)}`);
	return since(start);
}

/** A tar of this checkout's tracked and untracked-unignored files: the worker's edits, never .git or node_modules. */
function files(): Buffer {
	const listed = spawnSync("git", ["-C", ROOT, "ls-files", "-z", "-co", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 << 20 });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	const present = listed.stdout.split("\0").filter((path) => path && existsSync(join(ROOT, path)));
	const tar = spawnSync("tar", ["-c", "-C", ROOT, "--null", "-T", "-"], { input: present.join("\0"), maxBuffer: 1 << 30 });
	if (tar.status !== 0) throw new Error(`tar of the checkout failed: ${tar.stderr}`);
	return tar.stdout;
}

/** One scenario in a fresh container, removed by its own name afterwards whatever happened. */
export function runScenario(scenario: Scenario, timeoutMs = 900_000): SandboxRun {
	const name = `picp-install-${scenario}-${randomBytes(4).toString("hex")}`;
	const start = performance.now();
	const inner = `mkdir -p /tmp/src && tar -x -C /tmp/src && exec node /tmp/src/tests/harness/install-sandbox.ts --inside --scenario ${scenario}`;
	let run: SpawnSyncReturns<string>;
	try {
		// uid 0 is the container's own root (never host sudo), with root's own HOME.
		const user = scenario === "root" ? ["--user", "0", "-e", "HOME=/root"] : [];
		run = spawnSync("docker", ["run", "-i", "--rm", "--init", "--network", "none", "--name", name, "-e", "npm_config_prefer_offline=true", ...user, IMAGE, "sh", "-c", inner], { input: files(), encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 << 20 });
	} finally {
		spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", timeout: 60_000 });
	}
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`;
	const line = output.split("\n").reverse().find((text) => text.startsWith(RESULT_MARK));
	const result = line ? (JSON.parse(line.slice(RESULT_MARK.length)) as ScenarioResult) : undefined;
	return { scenario, exit: run.status, seconds: since(start), output, ...(result ? { result } : {}) };
}

/** The phase table, waits and observations; the whole timestamped container output on failure or `verbose`. */
export function formatRun(run: SandboxRun, verbose = false): string {
	const lines = [`scenario ${run.scenario}: exit ${run.exit}, ${run.seconds}s wall (container start included)`];
	for (const phase of run.result?.phases ?? []) {
		lines.push(`  ${phase.phase.padEnd(28)} ${String(phase.seconds).padStart(7)}s  exit ${phase.exit}`);
		for (const wait of phase.slowest ?? []) lines.push(`      waited ${wait}`);
	}
	for (const line of run.result?.observed ?? []) lines.push(`  observed: ${line}`);
	for (const failure of run.result?.failures ?? ["no result line: the container did not finish its scenario"]) lines.push(`  FAIL ${failure}`);
	if (verbose || !run.result || run.result.failures.length > 0) lines.push("  --- container output ---", run.output);
	return lines.join("\n");
}

const tail = (text: string, lines: number): string => text.split("\n").slice(-lines).join("\n");

// ---- container side -------------------------------------------------------------------------------------------

const SRC = "/tmp/src";
const HOME = process.env.HOME ?? "/home/node";
const CP_HOME = join(HOME, ".pi-command-post");
const APP = join(CP_HOME, "app");
const MODEL_SCRIPT = "parent";
const VIEWER = "http://127.0.0.1:8766/healthz";
const RAW_BOOTSTRAP = "https://raw.githubusercontent.com/0xb1ob/picp/main/bin/cp-bootstrap";
/** PATH without the image's npm prefix: pi is absent. */
const NO_PI_PATH = "/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin";
const PI_STUB = "/home/node/pi-stub";

/**
 * A stub as the only pi; the image's pi sits behind it. `--version` reads ./version, `update --self` logs and takes
 * ./update-to (fails without one), ./broken fails all else, ./list-fails fails `--list-models`. Returns the undo.
 */
function makePiStub(): () => void {
	const link = join(HOME, ".npm-global/bin/pi");
	const real = exec("readlink", ["-f", link]).out.trim();
	exec("mkdir", ["-p", PI_STUB]);
	rmSync(link);
	const script = [
		"#!/bin/sh",
		'd=$(dirname "$0")',
		'if [ "$1" = --version ]; then cat "$d/version"; exit 0; fi',
		'if [ "$1" = update ]; then echo "$*" >> "$d/updates"; [ -f "$d/update-to" ] || exit 1; cp "$d/update-to" "$d/version"; echo updated; exit 0; fi',
		'if [ -f "$d/broken" ]; then echo "stub: this pi lacks the extension API" >&2; exit 1; fi',
		'case " $* " in *" --list-models "*) if [ -f "$d/list-fails" ]; then echo "stub: list failed" >&2; exit 1; fi ;; esac',
		`exec "${real}" "$@"`,
	];
	writeFileSync(join(PI_STUB, "pi"), `${script.join("\n")}\n`, { mode: 0o755 });
	return () => {
		rmSync(PI_STUB, { recursive: true, force: true });
		exec("ln", ["-s", real, link]);
	};
}

/** Every path, size and mtime under /etc /usr /opt /var: the root scenario's before/after. */
function systemSnapshot(): Set<string> {
	const listed = exec("find", ["/etc", "/usr", "/opt", "/var", "-xdev", "-printf", "%p %s %T@\\n"]);
	return new Set(listed.out.split("\n").filter(Boolean));
}

interface Ctx { result: ScenarioResult; remote: string; seed: string; model: string }

function exec(command: string, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {}): { status: number | null; out: string; seconds: number } {
	const start = performance.now();
	const run = spawnSync(command, [...args], { encoding: "utf8", timeout: PHASE_TIMEOUT_MS, maxBuffer: 64 << 20, input: options.input ?? "", env: options.env ?? process.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
	return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\n${run.error.message}` : ""}`, seconds: since(start) };
}

/**
 * `curl … | sh -s -- FLAGS`, as the README's one-liner runs it, against the sandbox's local remote. Each output
 * line is timed, so the phase records its slowest waits: where a fresh user's minutes go.
 */
function bootstrap(ctx: Ctx, phase: string, extra: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; out: string }> {
	const flags = ["--home", CP_HOME, "--app", APP, "--yes", "--parent-model", ctx.model, "--viewer-host", "127.0.0.1", "--no-update", ...extra];
	return timed(ctx, phase, ["-s", "--", ...flags], env, readFileSync(join(SRC, "bin/cp-bootstrap"), "utf8"));
}

/** A command line an install printed for the user to rerun, run as they would paste it. */
function rerun(ctx: Ctx, phase: string, line: string, env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; out: string }> {
	return timed(ctx, phase, ["-c", line.replace(`curl -fsSL ${RAW_BOOTSTRAP}`, `cat ${join(SRC, "bin/cp-bootstrap")}`)], env, "");
}

// install.ts's shellWord; that module is not imported here because the container's /tmp/src has no node_modules.
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * `curl … | sh -s -- FLAGS` with a terminal (`script` gives it a pty, so /dev/tty prompts render) and no --yes. Each
 * `answers` entry is typed once its `after` text has been printed; stdin stays open, so an unexpected prompt hangs.
 */
function bootstrapTty(ctx: Ctx, phase: string, flags: readonly string[], env: NodeJS.ProcessEnv, answers: ReadonlyArray<{ after: string; type: string }> = []): Promise<{ status: number | null; out: string }> {
	const line = `cat ${shellWord(join(SRC, "bin/cp-bootstrap"))} | sh -s -- ${flags.map(shellWord).join(" ")}`;
	return timed(ctx, phase, ["-c", line], env, "", answers);
}

async function timed(ctx: Ctx, phase: string, shArgs: readonly string[], env: NodeJS.ProcessEnv, stdin: string, answers?: ReadonlyArray<{ after: string; type: string }>): Promise<{ status: number | null; out: string }> {
	const start = performance.now();
	const [command, args] = answers ? ["script", ["-qec", ["sh", ...shArgs].map(shellWord).join(" "), "/dev/null"]] : ["sh", [...shArgs]];
	const child = spawn(command, args, { env: { ...env, CP_REPO_URL: env.CP_REPO_URL ?? ctx.remote }, stdio: ["pipe", "pipe", "pipe"] });
	const lines: Array<{ at: number; text: string }> = [];
	let partial = "";
	let seen = "";
	const pending = [...(answers ?? [])];
	const take = (chunk: Buffer): void => {
		const text = chunk.toString("utf8").replaceAll("\r", "");
		const parts = (partial + text).split("\n");
		partial = parts.pop() ?? "";
		for (const line of parts) lines.push({ at: since(start), text: line });
		seen += text;
		while (pending[0] && seen.includes(pending[0].after)) {
			seen = seen.slice(seen.indexOf(pending[0].after) + pending[0].after.length);
			child.stdin.write(pending.shift()?.type);
		}
	};
	child.stdout.on("data", take);
	child.stderr.on("data", take);
	if (answers) child.stdin.write(stdin);
	else child.stdin.end(stdin);
	const timer = setTimeout(() => child.kill("SIGKILL"), PHASE_TIMEOUT_MS);
	const status = await new Promise<number | null>((done) => child.on("close", (code) => done(code)));
	clearTimeout(timer);
	if (partial) lines.push({ at: since(start), text: partial });
	const seconds = since(start);
	const waits = lines.map((line, n) => ({ gap: Math.round((line.at - (lines[n - 1]?.at ?? 0)) * 100) / 100, text: line.text }));
	const slowest = waits.filter(({ gap }) => gap >= 1).sort((a, b) => b.gap - a.gap).slice(0, 4).map(({ gap, text }) => `${gap}s before "${text.slice(0, 90)}"`);
	ctx.result.phases.push({ phase, seconds, exit: status, slowest });
	process.stdout.write(`--- ${phase} (exit ${status}, ${seconds}s)\n${lines.map((line) => `[+${line.at}s] ${line.text}`).join("\n")}\n`);
	return { status, out: lines.map((line) => line.text).join("\n") };
}

function check(ctx: Ctx, ok: boolean, failure: string): void {
	if (!ok) ctx.result.failures.push(failure);
}

const observed = (out: string): string[] => out.split("\n").filter((line) => /^(skip|fail): /.test(line));
const daemons = (): number => exec("pgrep", ["-fc", "src/service/daemon.ts run"]).out.trim().split("\n").map(Number)[0] ?? 0;
const git = (args: readonly string[], cwd: string) => exec("git", ["-c", "user.name=sandbox", "-c", "user.email=sandbox@test.invalid", ...args], { cwd });

/** A full install that must reach a ready daemon, a serving viewer and a clean parent doctor. */
async function install(ctx: Ctx, phase: string, extra: readonly string[] = []): Promise<string> {
	return verify(ctx, phase, await bootstrap(ctx, phase, extra));
}

/** The checks of a full install, whichever command ran it. */
async function verify(ctx: Ctx, phase: string, run: { status: number | null; out: string }): Promise<string> {
	ctx.result.observed = observed(run.out);
	check(ctx, run.status === 0, `${phase}: bootstrap exited ${run.status}`);
	check(ctx, /^ok: doctor: /m.test(run.out), `${phase}: no "ok: doctor" line (the parent's doctor did not pass)`);
	const status = exec(process.execPath, [join(APP, "src/service/daemon.ts"), "status", "--home", CP_HOME]);
	check(ctx, status.status === 0, `${phase}: cp-daemon status exited ${status.status}: ${status.out.trim()}`);
	const health = await fetch(VIEWER).then(async (res) => `${res.status} ${(await res.text()).trim()}`).catch((error: Error) => error.message);
	check(ctx, health === "200 ok", `${phase}: viewer ${VIEWER} answered ${health}`);
	check(ctx, daemons() === 1, `${phase}: ${daemons()} cp-daemon processes, expected exactly one`);
	return run.out;
}

const scenarios: Record<Scenario, (ctx: Ctx) => Promise<void>> = {
	async fresh(ctx) {
		const dry = await bootstrap(ctx, "dry-run", ["--dry-run"]);
		check(ctx, dry.status === 0, `dry-run: exited ${dry.status}`);
		check(ctx, !existsSync(CP_HOME), `dry-run: created ${CP_HOME}`);
		await install(ctx, "fresh install");
	},
	async prerequisites(ctx) {
		const cases = [
			{ name: "no node", path: "/usr/bin:/bin", says: "node is not on PATH" },
			{ name: "node 22", path: "/opt/node22/bin:/usr/bin:/bin", says: "is older than 24" },
		];
		for (const { name, path, says } of cases) {
			const run = await bootstrap(ctx, `bootstrap, ${name}`, [], { ...process.env, PATH: path });
			check(ctx, run.status === 1 && run.out.includes(says), `bootstrap, ${name}: expected exit 1 saying "${says}", got exit ${run.status}`);
			check(ctx, !existsSync(APP), `bootstrap, ${name}: cloned ${APP} before refusing`);
		}
		// #375 P4: bin/cp-install refuses before cloning too, naming node rather than npm.
		for (const { name, path, says } of cases) {
			const run = exec("sh", [join(SRC, "bin/cp-install"), "--home", CP_HOME, "--app", APP, "--yes"], { env: { ...process.env, PATH: path, CP_REPO_URL: ctx.remote } });
			ctx.result.phases.push({ phase: `cp-install, ${name}`, seconds: run.seconds, exit: run.status });
			process.stdout.write(`--- cp-install, ${name} (exit ${run.status})\n${run.out}\n`);
			check(ctx, run.status === 1 && run.out.includes(says) && !/npm/.test(run.out), `cp-install, ${name}: expected exit 1 saying "${says}" (not npm), got exit ${run.status}`);
			check(ctx, !existsSync(APP), `cp-install, ${name}: cloned ${APP} before refusing`);
			check(ctx, !existsSync(daemonPaths(CP_HOME).config), `cp-install, ${name}: wrote data/daemon.json`);
		}
	},
	async rerun(ctx) {
		await install(ctx, "first install");
		const pin = (): unknown => (JSON.parse(readFileSync(daemonPaths(CP_HOME).config, "utf8")) as { parent_model?: unknown }).parent_model;
		const same = await install(ctx, "same-home rerun");
		const changed = same.split("\n").filter((line) => line.startsWith("changed: "));
		check(ctx, changed.length === 0, `same-home rerun: not idempotent: ${changed.join(" | ")}`);
		appendFileSync(join(ctx.seed, "README.md"), "\n<!-- sandbox upgrade -->\n");
		git(["commit", "-qam", "sandbox upgrade"], ctx.seed);
		git(["push", "-q", "origin", "main"], ctx.seed);
		const upgrade = await install(ctx, "upgrade (fast-forward)");
		check(ctx, upgrade.includes(`fast-forwarded ${APP}`), "upgrade: the app was not fast-forwarded");
		check(ctx, git(["rev-parse", "HEAD"], APP).out === git(["rev-parse", "main"], ctx.remote).out, "upgrade: app HEAD is not the remote main");
		check(ctx, pin() === ctx.model, `upgrade: parent_model pin is ${String(pin())}`);
		const wrapper = join(HOME, ".local/bin/cp-operator");
		appendFileSync(wrapper, "# a local edit\n");
		const refused = await bootstrap(ctx, "edited wrapper, no --force", []);
		check(ctx, refused.status === 1 && refused.out.includes("rerun with --force"), `edited wrapper: expected a --force refusal, got exit ${refused.status}`);
		await install(ctx, "edited wrapper, --force", ["--force"]);
		check(ctx, !readFileSync(wrapper, "utf8").includes("# a local edit"), "--force did not replace the edited wrapper");
	},
	async login(ctx) {
		// #375 P1: without a usable provider nothing is written or started, and exactly one line says how to go on.
		const models = join(HOME, ".pi/agent/models.json");
		const saved = readFileSync(models, "utf8");
		rmSync(models);
		const none = await bootstrap(ctx, "no login", []);
		const lines = none.out.split("\n").filter((line) => line.includes("/login"));
		check(ctx, none.status === 4, `no login: expected exit 4, got ${none.status}`);
		check(ctx, lines.length === 1 && /^fail: login: .*run `pi`, then \/login, then re-run: /.test(lines[0] ?? ""), `no login: expected one continuation line, got ${JSON.stringify(lines)}`);
		check(ctx, daemons() === 0, `no login: ${daemons()} cp-daemon processes left running`);
		check(ctx, !existsSync(daemonPaths(CP_HOME).config), "no login: wrote data/daemon.json");
		check(ctx, !/: doctor: /.test(none.out), "no login: a doctor ran");
		// #402 review: a failing `pi --list-models` with no auth.json provider is no login too: exit 4, nothing started.
		const restore = makePiStub();
		writeFileSync(join(PI_STUB, "version"), "1.0.4\n");
		writeFileSync(join(PI_STUB, "list-fails"), "");
		const failed = await bootstrap(ctx, "pi --list-models fails", [], { ...process.env, PATH: `${PI_STUB}:${process.env.PATH ?? ""}` });
		restore();
		check(ctx, failed.status === 4 && /^fail: login: `pi --list-models` exited 1 and no provider is in /m.test(failed.out), `list fails: expected exit 4 naming it, got ${failed.status}`);
		check(ctx, daemons() === 0 && !existsSync(daemonPaths(CP_HOME).config), "list fails: started cp-daemon or wrote data/daemon.json");
		writeFileSync(models, saved);
		const phase = "the printed re-run, logged in";
		await verify(ctx, phase, await rerun(ctx, phase, lines[0]?.split("then re-run: ")[1] ?? "false"));
	},
	async recovery(ctx) {
		const offline = `${ctx.remote}.offline`;
		renameSync(ctx.remote, offline);
		const clone = await bootstrap(ctx, "clone, remote unreachable", []);
		renameSync(offline, ctx.remote);
		const cloneRetry = retryOf(clone.out, "fail: bootstrap: git clone ");
		check(ctx, clone.status === 1 && cloneRetry !== undefined, `clone: expected a named git clone failure with its rerun, got exit ${clone.status}`);
		check(ctx, !existsSync(APP), `clone: left ${APP} behind`);
		// npm ci with an empty offline cache fails after the clone: a partial install, resumed by the printed reruns.
		const cache = mkdtempSync(join(tmpdir(), "empty-npm-cache-"));
		const npm = await rerun(ctx, "printed rerun, npm offline", cloneRetry ?? "false", { ...process.env, npm_config_cache: cache, npm_config_offline: "true" });
		const npmRetry = retryOf(npm.out, "fail: bootstrap: npm ci failed");
		check(ctx, npm.status === 1 && npmRetry !== undefined && existsSync(APP), `npm ci: expected a named npm ci failure after the clone, got exit ${npm.status}`);
		// pi absent and npm's prefix root-owned: install-tools refuses (never sudo) and the install names its rerun.
		const refusal = await rerun(ctx, "printed rerun, pi absent, /usr/local prefix", npmRetry ?? "false", { ...process.env, PATH: NO_PI_PATH, NPM_CONFIG_PREFIX: "/usr/local" });
		const installRetry = retryOf(refusal.out, "fix the above, then rerun the install: ");
		check(ctx, refusal.status === 1 && /^changed: bootstrap: npm ci in /m.test(refusal.out), `npm retry: expected npm ci to land, then a refusal; got exit ${refusal.status}`);
		check(ctx, refusal.out.includes("✗ pi: missing, and npm's global prefix /usr/local is not writable") && installRetry !== undefined, "unwritable prefix: no actionable pi refusal naming the install's rerun");
		check(ctx, !existsSync(daemonPaths(CP_HOME).config), "unwritable prefix: wrote data/daemon.json");
		// pi absent, a writable per-user prefix: install-tools installs it (from npm's cache: --network none).
		const prefix = mkdtempSync(join(tmpdir(), "npm-prefix-"));
		const tools = await timed(ctx, "install-tools, pi absent", ["-c", `"${process.execPath}" ${join(APP, "scripts/install-tools.ts")} pi`], { ...process.env, PATH: `${prefix}/bin:${NO_PI_PATH}`, NPM_CONFIG_PREFIX: prefix }, "");
		check(ctx, tools.status === 0 && tools.out.includes(`-> ${prefix}/bin/pi`), `pi absent: install-tools exited ${tools.status} without installing pi into ${prefix}`);
		await verify(ctx, "printed install rerun", await rerun(ctx, "printed install rerun", installRetry ?? "false"));
		// An existing checkout that is dirty, ahead or from another origin is refused or left as is, never overwritten.
		const cpInstall = `sh ${join(APP, "bin/cp-install")} --home ${CP_HOME} --app ${APP} --dry-run`;
		writeFileSync(join(APP, "sandbox-dirty"), "x\n");
		const dirty = await bootstrap(ctx, "dirty checkout", ["--dry-run"]);
		check(ctx, dirty.status === 1 && dirty.out.includes("has uncommitted changes"), `dirty: bootstrap exited ${dirty.status} without refusing`);
		const dirtyInstall = await timed(ctx, "cp-install --dry-run, dirty checkout", ["-c", cpInstall], process.env, "");
		check(ctx, dirtyInstall.out.includes("has uncommitted changes; left as is") && existsSync(join(APP, "sandbox-dirty")), "dirty: cp-install did not leave the checkout as is");
		rmSync(join(APP, "sandbox-dirty"));
		git(["commit", "-q", "--allow-empty", "-m", "local"], APP);
		const ahead = await bootstrap(ctx, "checkout ahead of origin/main", ["--dry-run"]);
		check(ctx, ahead.status === 1 && ahead.out.includes("has commits not on origin/main"), `ahead: bootstrap exited ${ahead.status} without refusing`);
		git(["reset", "-q", "--hard", "origin/main"], APP);
		const origin = await timed(ctx, "cp-install, another origin", ["-c", cpInstall], { ...process.env, CP_REPO_URL: "/elsewhere/picp.git" }, "");
		check(ctx, origin.status === 1 && origin.out.includes("has origin"), `origin: cp-install exited ${origin.status} without refusing`);
	},
	async root(ctx) {
		// uid 0 inside the container (never host sudo): every target stays per-user, under root's own HOME.
		check(ctx, process.getuid?.() === 0, "root: the scenario is not running as uid 0");
		const before = systemSnapshot();
		const out = await install(ctx, "fresh install as root");
		const system = out.split("\n").filter((line) => line.startsWith("changed: ") && /\s\/(etc|usr|opt|var)\//.test(line));
		check(ctx, system.length === 0, `root: changed system paths: ${system.join(" | ")}`);
		// #402 review: the files themselves, not only the install's own lines.
		const after = systemSnapshot();
		const moved = [...new Set([...before, ...after])].filter((entry) => before.has(entry) !== after.has(entry));
		check(ctx, before.size > 1000 && moved.length === 0, `root: /etc /usr /opt /var changed (${moved.length} of ${before.size}): ${moved.slice(0, 10).join(" | ")}`);
	},
	async compat(ctx) {
		// #375 PR3: package.json piCompat through the real installer, with a stub as the only pi on PATH.
		const stub = (version: string, extra: { broken?: boolean; updateTo?: string } = {}): NodeJS.ProcessEnv => {
			writeFileSync(join(PI_STUB, "version"), `${version}\n`);
			rmSync(join(PI_STUB, "broken"), { force: true });
			rmSync(join(PI_STUB, "update-to"), { force: true });
			rmSync(join(PI_STUB, "updates"), { force: true });
			if (extra.broken) writeFileSync(join(PI_STUB, "broken"), "");
			if (extra.updateTo) writeFileSync(join(PI_STUB, "update-to"), `${extra.updateTo}\n`);
			return { ...process.env, PATH: `${PI_STUB}:${process.env.PATH ?? ""}` };
		};
		makePiStub();
		const updates = (): string => (existsSync(join(PI_STUB, "updates")) ? readFileSync(join(PI_STUB, "updates"), "utf8").trim() : "");
		const range = "pi >= 1.0.1, tested up to 1.0.4, major 1";
		const refusals = [
			{ name: "old pi, --no-pi-upgrade", env: () => stub("0.99.0", { updateTo: "1.0.4" }), extra: ["--no-pi-upgrade"], says: "pi 0.99.0 is older than 1.0.1" },
			{ name: "next-major pi", env: () => stub("2.0.0"), extra: [], says: "pi 2.0.0 is a newer major than the tested 1.0.4" },
			{ name: "fake-incompatible pi", env: () => stub("1.0.4", { broken: true }), extra: [], says: "pi 1.0.4 failed the capability probe" },
		];
		for (const { name, env, extra, says } of refusals) {
			const run = await bootstrap(ctx, name, extra, env());
			check(ctx, run.status === 1 && run.out.includes(says) && run.out.includes(range), `${name}: expected exit 1 naming "${says}" and the range, got exit ${run.status}`);
			check(ctx, updates() === "", `${name}: pi was updated (${updates()})`);
			check(ctx, !existsSync(daemonPaths(CP_HOME).config) && daemons() === 0, `${name}: wrote data/daemon.json or started cp-daemon`);
		}
		const forced = await verify(ctx, "next-major pi, --force", await bootstrap(ctx, "next-major pi, --force", ["--force"], stub("2.0.0")));
		check(ctx, /^skip: pi: warning: --force: proceeding with an incompatible pi: pi 2\.0\.0/m.test(forced), "--force: no warning line for the incompatible pi");
		const newer = await verify(ctx, "newer pi, same major", await bootstrap(ctx, "newer pi, same major", [], stub("1.9.0")));
		check(ctx, /^skip: pi: warning: pi 1\.9\.0 is newer than the tested 1\.0\.4/m.test(newer) && updates() === "", "newer: expected a warning and no update (never a downgrade)");
		const old = await verify(ctx, "old pi, --yes", await bootstrap(ctx, "old pi, --yes", [], stub("0.99.0", { updateTo: "1.0.4" })));
		check(ctx, updates() === "update --self" && /^ok: pi: updated 0\.99\.0 -> 1\.0\.4 /m.test(old), `old, --yes: expected one \`pi update --self\` and an updated line, got "${updates()}"`);
	},
	async onboarding(ctx) {
		// #375 PR4 (P2, P3, P5): a fresh install is never silent while it waits and ends in one summary block.
		const out = await install(ctx, "fresh install, summary");
		const lines = out.split("\n");
		check(ctx, lines.some((line) => line.startsWith("… daemon: starting cp-daemon; waiting up to ")), "progress: no `… daemon:` line before the readiness wait");
		check(ctx, lines.some((line) => line.startsWith("… doctor: waiting ")), "progress: no `… doctor:` line before the doctor wait");
		check(ctx, !out.includes("health.json is absent or unreadable"), "fresh install: the expected not-yet-run watchdog was reported as a warning");
		check(ctx, out.includes("the watchdog has not finished its first run yet"), "fresh install: doctor did not say the first watchdog run is still due");
		check(ctx, lines.filter((line) => /^(ready|incomplete): /.test(line)).length === 1 && /^ready: cp-daemon runs and \/doctor passed; the dashboard: http:\/\/127\.0\.0\.1:\d+\//m.test(out), "summary: expected exactly one `ready:` line with the dashboard URL");
		const head = lines.findIndex((line) => /^optional steps left \(\d+\):$/.test(line));
		const items = head < 0 ? [] : lines.slice(head + 1).filter((line, n, rest) => rest.slice(0, n + 1).every((item) => item.startsWith("  - ")));
		check(ctx, items.some((line) => line.includes("push: ") && line.includes("--push-origin")), `summary: no optional push step naming --push-origin in ${JSON.stringify(items)}`);
		check(ctx, items.some((line) => line.includes("reboot: no systemd here") && line.includes("--crontab")), `summary: no reboot step offering --crontab in ${JSON.stringify(items)}`);
	},
	async prompt(ctx) {
		// #375 PR4: through a terminal with complete flags and no --yes, the one prompt is the below-min pi update.
		const restore = makePiStub();
		writeFileSync(join(PI_STUB, "version"), "0.99.0\n");
		writeFileSync(join(PI_STUB, "update-to"), "1.0.4\n");
		const env = { ...process.env, PATH: `${PI_STUB}:${process.env.PATH ?? ""}` };
		const flags = ["--home", CP_HOME, "--app", APP, "--parent-model", ctx.model, "--viewer-host", "127.0.0.1", "--no-update"];
		const ask = "update --self now? [y/N] ";
		const run = await verify(ctx, "curl | sh with a terminal, pi below min", await bootstrapTty(ctx, "curl | sh with a terminal, pi below min", flags, env, [{ after: ask, type: "y\n" }]));
		const updates = existsSync(join(PI_STUB, "updates")) ? readFileSync(join(PI_STUB, "updates"), "utf8").trim() : "";
		restore();
		check(ctx, run.includes(`pi 0.99.0 is older than 1.0.1 (pi >= 1.0.1, tested up to 1.0.4, major 1). Run "${PI_STUB}/pi" ${ask.trim()}`), "prompt: the below-min question did not render on the terminal");
		check(ctx, updates === "update --self" && /^ok: pi: updated 0\.99\.0 -> 1\.0\.4 /m.test(run), `prompt: the typed y did not run one \`pi update --self\` (got "${updates}")`);
		check(ctx, run.split("\n").filter((line) => line.includes("[y/N]") || /\(empty .*\): $/.test(line)).length === 1, "prompt: complete flags asked more than the one pi question");
	},
	async "node-floor"(ctx) {
		// #404 review: the entry points never rely on import.meta.main (node 24.2+); the whole install runs on 24.0.0.
		const env = { ...process.env, PATH: `/opt/node24.0/bin:${process.env.PATH ?? ""}` };
		const version = exec("node", ["--version"], { env }).out.trim();
		check(ctx, version === "v24.0.0", `node-floor: node on PATH is ${version}, expected v24.0.0`);
		const probe = exec("node", [join(SRC, "src/pi-compat-probe.ts"), join(HOME, ".npm-global/bin/pi"), SRC], { env });
		check(ctx, probe.status === 0 && /"extension":\{"ok":true/.test(probe.out), `node-floor: the pi probe helper printed no passing result: ${probe.out.trim().slice(0, 300)}`);
		await verify(ctx, "fresh install on node 24.0.0", await bootstrap(ctx, "fresh install on node 24.0.0", [], env));
		const pinned = (JSON.parse(readFileSync(daemonPaths(CP_HOME).config, "utf8")) as { node?: string }).node;
		check(ctx, pinned === "/opt/node24.0/bin/node", `node-floor: data/daemon.json pins node ${pinned}`);
	},
};

/** The rerun command a failure line printed (`… rerun: CMD` or `… rerun the install: CMD`). */
const retryOf = (out: string, marker: string): string | undefined => out.split("\n").find((line) => line.includes(marker))?.match(/rerun(?: the install)?: (.+)$/)?.[1];

/**
 * Stands in for a provider login: every model the routing defaults and profiles name, served by the mock.
 * Without one, doctor's worker-model checks fail and so does the install (a recorded pain point).
 */
function standIns(models: { providers: Record<string, unknown> }): { providers: Record<string, unknown> } {
	const routing = JSON.parse(readFileSync(join(SRC, "defaults/routing.default.json"), "utf8")) as { rubric: Array<{ model: string; fallbacks?: string[] }> };
	const refs = new Set(routing.rubric.flatMap((row) => [row.model, ...(row.fallbacks ?? [])]));
	for (const name of readdirSync(join(SRC, "profiles"))) {
		const text = readFileSync(join(SRC, "profiles", name), "utf8");
		for (const [, list] of text.matchAll(/^(?:model|fallbacks):\s*\[?([^\]\n]+)/gm)) for (const ref of list?.split(",") ?? []) refs.add(ref.trim());
	}
	const mock = Object.values(models.providers)[0] as { baseUrl: string; apiKey: string; models: Array<Record<string, unknown>> };
	const providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<Record<string, unknown>> }> = {};
	for (const ref of refs) {
		const [name, id] = [ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1)];
		providers[name] ??= { baseUrl: mock.baseUrl, api: "openai-completions", apiKey: mock.apiKey, models: [] };
		providers[name].models.push({ ...mock.models[0], id, name: `${ref} (sandbox stand-in)`, reasoning: true });
	}
	return { providers: { ...models.providers, ...providers } };
}

async function inside(scenario: Scenario): Promise<number> {
	const { MockProvider } = await import("./mock-provider.ts");
	const start = performance.now();
	const result: ScenarioResult = { scenario, seconds: 0, phases: [], failures: [], observed: [] };
	const provider = await MockProvider.start();
	try {
		// The parent never prompts during install; a repeating text step answers anything that does reach it.
		const model = provider.addScript(MODEL_SCRIPT, [{ kind: "text", text: "ok" }], { onExhausted: "repeat" });
		exec("mkdir", ["-p", join(HOME, ".pi/agent")]);
		writeFileSync(join(HOME, ".pi/agent/models.json"), `${JSON.stringify(standIns(provider.modelsJson()), null, 2)}\n`);
		const work = mkdtempSync(join(tmpdir(), "sandbox-"));
		const seed = join(work, "seed");
		const remote = join(work, "remote.git");
		exec("cp", ["-a", SRC, seed]);
		git(["init", "-q", "-b", "main"], seed);
		git(["add", "-A"], seed);
		git(["commit", "-qm", "sandbox snapshot"], seed);
		git(["clone", "-q", "--bare", seed, remote], work);
		git(["remote", "add", "origin", remote], seed);
		git(["fetch", "-q", "origin"], seed);
		const ctx: Ctx = { result, remote, seed, model };
		await scenarios[scenario](ctx);
	} catch (error) {
		result.failures.push(`harness: ${(error as Error).stack ?? String(error)}`);
	} finally {
		await provider.stop();
	}
	result.seconds = since(start);
	process.stdout.write(`${RESULT_MARK}${JSON.stringify(result)}\n`);
	return result.failures.length === 0 ? 0 : 1;
}

// ---- CLI: npm run e2e:install -- [--scenario fresh|prerequisites|rerun|all] [--verbose] ----------------------

// Not import.meta.main: that is node 24.2+, and engines admits every 24.x (#375).
if (process.argv[1] !== undefined && entryRealpath(process.argv[1]) === entryPath(import.meta.url)) {
	const { values } = parseArgs({ options: { scenario: { type: "string", default: "all" }, inside: { type: "boolean" }, verbose: { type: "boolean" } } });
	const wanted = values.scenario === "all" ? [...SCENARIOS] : [values.scenario];
	const unknown = wanted.filter((name) => !(SCENARIOS as readonly string[]).includes(name ?? ""));
	if (unknown.length > 0) {
		process.stderr.write(`install-sandbox: unknown scenario ${unknown.join(", ")} (known: ${SCENARIOS.join(", ")}, all)\n`);
		process.exit(2);
	}
	if (values.inside) process.exit(await inside(wanted[0] as Scenario));
	const why = dockerUnavailable();
	if (why) {
		process.stderr.write(`install-sandbox: ${why}\n`);
		process.exit(1);
	}
	process.stdout.write(`image ${IMAGE} built in ${await buildImage()}s\n`);
	let failed = false;
	for (const scenario of wanted as Scenario[]) {
		const run = runScenario(scenario);
		failed ||= run.exit !== 0 || !run.result || run.result.failures.length > 0;
		process.stdout.write(`${formatRun(run, values.verbose === true)}\n`);
	}
	process.exit(failed ? 1 : 0);
}
