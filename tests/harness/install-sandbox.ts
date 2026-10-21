/**
 * Disposable Docker sandbox for the real install entry points (#375; tests/e2e/README.md "Installer sandbox").
 * Host: builds tests/fixtures/install/Dockerfile, streams a tar of this checkout's files into a `--network none`
 * container and reads back one result line. Inside (`--inside`): the scenario runs bin/cp-bootstrap end to end.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { daemonPaths } from "../../src/service/daemon-files.ts";

export const SCENARIOS = ["fresh", "prerequisites", "rerun"] as const;
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
		run = spawnSync("docker", ["run", "-i", "--rm", "--init", "--network", "none", "--name", name, "-e", "npm_config_prefer_offline=true", IMAGE, "sh", "-c", inner], { input: files(), encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 << 20 });
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
async function bootstrap(ctx: Ctx, phase: string, extra: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; out: string }> {
	const flags = ["--home", CP_HOME, "--app", APP, "--yes", "--parent-model", ctx.model, "--viewer-host", "127.0.0.1", "--no-update", ...extra];
	const start = performance.now();
	const child = spawn("sh", ["-s", "--", ...flags], { env: { ...env, CP_REPO_URL: ctx.remote }, stdio: ["pipe", "pipe", "pipe"] });
	const lines: Array<{ at: number; text: string }> = [];
	let partial = "";
	const take = (chunk: Buffer): void => {
		const parts = (partial + chunk.toString("utf8")).split("\n");
		partial = parts.pop() ?? "";
		for (const text of parts) lines.push({ at: since(start), text });
	};
	child.stdout.on("data", take);
	child.stderr.on("data", take);
	child.stdin.end(readFileSync(join(SRC, "bin/cp-bootstrap"), "utf8"));
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
	const run = await bootstrap(ctx, phase, extra);
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
		// bin/cp-install has no early node check yet (PR2): pinned here as observed, only "nothing started".
		for (const { name, path } of cases) {
			const run = exec("sh", [join(SRC, "bin/cp-install"), "--home", CP_HOME, "--app", APP, "--yes"], { env: { ...process.env, PATH: path, CP_REPO_URL: ctx.remote } });
			ctx.result.phases.push({ phase: `cp-install, ${name}`, seconds: run.seconds, exit: run.status });
			process.stdout.write(`--- cp-install, ${name} (exit ${run.status})\n${run.out}\n`);
			check(ctx, run.status !== 0, `cp-install, ${name}: exited 0`);
			check(ctx, !existsSync(daemonPaths(CP_HOME).config), `cp-install, ${name}: wrote data/daemon.json`);
			ctx.result.observed.push(`cp-install, ${name}: exit ${run.status}${existsSync(APP) ? `, ${APP} cloned before refusing` : ""}: ${run.out.trim().split("\n").at(-1)}`);
			exec("rm", ["-rf", APP]);
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
};

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

if (import.meta.main) {
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
