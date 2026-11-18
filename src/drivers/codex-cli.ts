/**
 * The installed `codex` CLI: its path, version floor and sign-in, from exit codes and `--version` only. picp never
 * opens the Codex home or its `auth.json`; `codex login status` answers yes or no.
 */
import { execFile, execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { whichAll } from "../doctor.ts";

/** The lowest `codex --version` the C0 probes ran on (docs/native-drivers.md "Codex CLI workers"). */
export const CODEX_VERSION_FLOOR = "0.170.0";
export const CODEX_VERSION_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 10_000;

export class CodexSpikeError extends Error {
	/** No CLI on PATH, one below the floor, one that is not signed in, or no OS containment for it. */
	cli?: "missing" | "version" | "auth" | "containment";
}

export function parseCodexVersion(output: string): string | undefined {
	return /^codex-cli (\d+\.\d+\.\d+)/m.exec(output)?.[1];
}

/** Undefined when `version` meets `floor`; otherwise the refusal naming the remedy. No auto-update. */
export function codexVersionRefusal(version: string | undefined, floor = CODEX_VERSION_FLOOR): string | undefined {
	if (version === undefined) return "codex --version printed no version: reinstall the Codex CLI, then run `codex update`";
	const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
	const cmp = (a ?? []).map((n, i) => n - ((b ?? [])[i] ?? 0)).find((d) => d !== 0) ?? 0;
	return cmp < 0 ? `codex ${version} is below the Codex driver floor ${floor}: run \`codex update\`` : undefined;
}

/** The operator's Codex home, which the CLI reads and picp only passes as `CODEX_HOME`. */
export const defaultCodexHome = (): string => join(userInfo().homedir, ".codex");

function codexPath(env: NodeJS.ProcessEnv): string {
	const path = whichAll("codex", env)[0];
	if (path === undefined) throw Object.assign(new CodexSpikeError("codex is not on PATH: install the Codex CLI, then run `codex update`"), { cli: "missing" as const });
	return path;
}

const versionFailed = (path: string, error: unknown): CodexSpikeError =>
	Object.assign(new CodexSpikeError(`${path} --version failed (${(error as Error).message}): run \`codex update\``), { cli: "version" as const });

function checked(path: string, raw: string): { path: string; version: string } {
	const version = parseCodexVersion(raw);
	const refusal = codexVersionRefusal(version);
	if (refusal !== undefined || version === undefined) throw Object.assign(new CodexSpikeError(refusal), { cli: "version" as const });
	return { path, version };
}

/** The first `codex` on PATH and its version; throws with a named remedy when missing or too old. */
export function resolveCodex(env: NodeJS.ProcessEnv = process.env): { path: string; version: string } {
	const path = codexPath(env);
	let raw = "";
	try {
		raw = execFileSync(path, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "" }, stdio: ["ignore", "pipe", "ignore"], timeout: CODEX_VERSION_TIMEOUT_MS });
	} catch (error) {
		throw versionFailed(path, error);
	}
	return checked(path, raw);
}

/** `resolveCodex` off the event loop, bounded by `CODEX_VERSION_TIMEOUT_MS`. */
export async function resolveCodexAsync(env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; version: string }> {
	const path = codexPath(env);
	const raw = await new Promise<string>((resolve, reject) => {
		const child = execFile(path, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "" }, timeout: CODEX_VERSION_TIMEOUT_MS }, (error, stdout) =>
			error ? reject(versionFailed(path, error)) : resolve(stdout));
		child.stdin?.end();
	});
	return checked(path, raw);
}

/** Undefined when `codex login status` exits 0 for this Codex home; its output is never read. */
export async function codexLoginRefusal(path: string, dirs: { codexHome: string; home: string; pathEnv: string }): Promise<string | undefined> {
	const code = await new Promise<number | null | string>((done) => {
		const child = execFile(path, ["login", "status"], { env: { PATH: dirs.pathEnv, HOME: dirs.home, CODEX_HOME: dirs.codexHome }, timeout: LOGIN_TIMEOUT_MS }, (error) =>
			done(error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : String((error as Error).message)));
		child.stdin?.end();
		child.stdout?.resume();
		child.stderr?.resume();
	});
	return code === 0 ? undefined : "codex is not signed in: run `codex login`";
}
