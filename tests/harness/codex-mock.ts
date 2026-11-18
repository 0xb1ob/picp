/**
 * Harness for tests/fixtures/fake-codex.ts: a `codex` stub on PATH, its script and state, the fake's logs, and one
 * fixture (worktree, artifact, run dir, a synthetic Codex home) that drives `runCodexSpike` against it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CodexSpikeOptions, type CodexSpikeResult, runCodexSpike } from "../../src/drivers/codex-spike.ts";

export const FAKE_CODEX_CLI = fileURLToPath(new URL("../fixtures/fake-codex.ts", import.meta.url));
export const FAKE_SYSTEMD_RUN = fileURLToPath(new URL("../fixtures/fake-systemd-run.ts", import.meta.url));
export const FAKE_CODEX_MODEL = "gpt-picp-fake";
export const AUTH_SENTINEL = "SYNTHETIC-CODEX-AUTH-SENTINEL";

export type FakeCodexStep =
	| { kind: "shell"; command: string; hook?: "run" | "skip" | "kill" | "stall" | "unlink"; background?: boolean }
	| { kind: "tool"; tool: string; arguments: unknown; hook?: "run" | "skip" | "kill" | "stall" | "unlink" }
	| { kind: "patch"; patch: string }
	| { kind: "message"; text: string }
	| { kind: "hold"; marker: string };
export interface FakeCodexScript { knobs?: Record<string, unknown>; turns?: FakeCodexStep[][] }

export function writeCodexScript(file: string, script: FakeCodexScript): void {
	writeFileSync(file, `${JSON.stringify(script)}\n`);
}

/**
 * Writes `<binDir>/codex` and `<binDir>/systemd-run` (the fake user scope); the fake variables live in the stubs, so
 * none passes the product's env allow-list.
 */
export function installCodexStub(binDir: string, files: { script: string; stateDir: string }): string {
	const paths = [process.execPath, FAKE_CODEX_CLI, FAKE_SYSTEMD_RUN, files.script, files.stateDir];
	if (paths.some((path) => path.includes("'"))) throw new Error("the codex stub needs paths without a single quote");
	mkdirSync(binDir, { recursive: true });
	const vars = `FAKE_CODEX_SCRIPT='${files.script}' FAKE_CODEX_STATE='${files.stateDir}'`;
	const file = join(binDir, "codex");
	writeFileSync(file, `#!/bin/sh\nexport ${vars}\nexec '${process.execPath}' '${FAKE_CODEX_CLI}' "$@"\n`, { mode: 0o755 });
	const unit = 'unit=; for a in "$@"; do case "$a" in --unit=*) unit="${a#--unit=}";; esac; done';
	writeFileSync(join(binDir, "systemd-run"), `#!/bin/sh\n${unit}\nexport ${vars} FAKE_SCOPE="$unit"\nexec '${process.execPath}' '${FAKE_SYSTEMD_RUN}' "$@"\n`, { mode: 0o755 });
	return file;
}

const lines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : []);
export const fakeSpawns = (state: string) => lines<{ pid: number; argv: string[]; env: string[] }>(join(state, "spawns.jsonl"));
export const fakeRpcMethods = (state: string) => lines<{ pid: number; method: string }>(join(state, "rpc.jsonl")).map((entry) => entry.method);
export const fakeExecuted = (state: string) => lines<{ command: string }>(join(state, "executed.jsonl")).map((entry) => entry.command);
export const fakePids = (state: string) => lines<{ pid: number }>(join(state, "pids.jsonl")).map((entry) => entry.pid);
export const fakeHooks = (state: string) => lines<{ tool: string; mode: string; status: string; stderr: string }>(join(state, "hooks.jsonl"));
export const fakeScopes = (state: string) => lines<{ unit: string; started?: true; killed?: number; collected?: true; refused?: true }>(join(state, "scopes.jsonl"));
export const fakeThreadTotal = (state: string, threadId: string) =>
	(JSON.parse(readFileSync(join(state, "threads", `${threadId}.json`), "utf8")) as { total: { totalTokens: number } }).total;

export interface CodexFixture {
	root: string;
	worktree: string;
	artifactPath: string;
	runDir: string;
	codexHome: string;
	stateDir: string;
	script: string;
	/** The synthetic Codex home's listing; a case asserts it unchanged. */
	homeListing: () => string[];
	setScript: (script: FakeCodexScript) => void;
	options: (extra?: Partial<CodexSpikeOptions>) => CodexSpikeOptions;
	run: (extra?: Partial<CodexSpikeOptions>) => Promise<CodexSpikeResult>;
}

/** A fresh fixture under the temp dir, removed after the test; `run` uses the stub first on PATH. */
export function codexFixture(t: { after: (fn: () => void) => void }, jobId: string, script: FakeCodexScript): CodexFixture {
	const root = mkdtempSync(join(tmpdir(), "cp-codex-e2e-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const [worktree, bin, stateDir, codexHome, artifacts] = ["repo", "bin", "state", "codex-home", "artifacts"].map((name) => join(root, name)) as [string, string, string, string, string];
	for (const dir of [worktree, bin, stateDir, codexHome, artifacts]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(worktree, "README.md"), "codex spike readme\n");
	writeFileSync(join(codexHome, "auth.json"), `${AUTH_SENTINEL}\n`, { mode: 0o600 });
	const scriptFile = join(root, "script.json");
	writeCodexScript(scriptFile, script);
	installCodexStub(bin, { script: scriptFile, stateDir });
	const artifactPath = join(artifacts, "report.md");
	const runDir = join(root, "run");
	const options = (extra: Partial<CodexSpikeOptions> = {}): CodexSpikeOptions => ({
		job: { job_id: jobId, kind: "research", role: "planner", delivery: "local", runDir, worktree, artifactPath },
		prompt: "Research the repo and report.",
		model: FAKE_CODEX_MODEL,
		codexHome,
		hostEnv: { PATH: `${bin}:${process.env.PATH ?? ""}`, LANG: "C.UTF-8", OPENAI_API_KEY: "host-openai-sentinel", CODEX_SANDBOX: "host-sentinel" },
		timeoutMs: 60_000,
		...extra,
	});
	return {
		root, worktree, artifactPath, runDir, codexHome, stateDir, script: scriptFile,
		homeListing: () => readdirSync(codexHome).sort(),
		setScript: (next) => writeCodexScript(scriptFile, next),
		options,
		run: (extra = {}) => runCodexSpike(options(extra)),
	};
}

export const CODEX_SPIKE_DRIVER = fileURLToPath(new URL("../fixtures/codex-spike-driver.ts", import.meta.url));

/** Runs `runCodexSpike` in a child node process (so a test can SIGKILL the driver); `options` must be JSON. */
export function spawnSpikeDriver(options: CodexSpikeOptions): ChildProcess {
	return spawn(process.execPath, [CODEX_SPIKE_DRIVER, JSON.stringify(options)], { stdio: ["ignore", "inherit", "inherit"] });
}
