/**
 * The installed `claude` CLI and its version floor, without the Agent SDK: the parent asks this on every native
 * selection, and importing claude-spike.ts (the SDK) there blocked its event loop for seconds (F4).
 */
import { execFile, execFileSync } from "node:child_process";
import { whichAll } from "../doctor.ts";

/** The lowest `claude --version` this spike measured working (docs/native-drivers.md "Spike result"). */
export const CLAUDE_VERSION_FLOOR = "2.1.318";
/** The async probe's bound: a wedged CLI is a `version` refusal, never a parent that waits forever. */
export const CLAUDE_VERSION_TIMEOUT_MS = 10_000;

export class ClaudeSpikeError extends Error {
	/** Set by `resolveClaude`: no CLI on PATH, or one that cannot prove the floor. */
	cli?: "missing" | "version";
}

export function parseClaudeVersion(output: string): string | undefined {
	return /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

/** Undefined when `version` meets `floor`; otherwise the refusal naming the remedy. No auto-update. */
export function claudeVersionRefusal(version: string | undefined, floor = CLAUDE_VERSION_FLOOR): string | undefined {
	if (version === undefined) return "claude --version printed no version: reinstall Claude Code, then run `claude update`";
	const [a, b] = [version, floor].map((v) => v.split(".").map(Number));
	const cmp = (a ?? []).map((n, i) => n - ((b ?? [])[i] ?? 0)).find((d) => d !== 0) ?? 0;
	return cmp < 0 ? `claude ${version} is below the native driver floor ${floor}: run \`claude update\`` : undefined;
}

function claudePath(env: NodeJS.ProcessEnv): string {
	const path = whichAll("claude", env)[0];
	if (path === undefined) throw Object.assign(new ClaudeSpikeError("claude is not on PATH: install Claude Code, then run `claude update`"), { cli: "missing" as const });
	return path;
}

const versionFailed = (path: string, error: unknown): ClaudeSpikeError =>
	Object.assign(new ClaudeSpikeError(`${path} --version failed (${(error as Error).message}): run \`claude update\``), { cli: "version" as const });

function checked(path: string, raw: string): { path: string; version: string } {
	const version = parseClaudeVersion(raw);
	const refusal = claudeVersionRefusal(version);
	if (refusal !== undefined || version === undefined) throw Object.assign(new ClaudeSpikeError(refusal), { cli: "version" as const });
	return { path, version };
}

/** The first `claude` on PATH and its version; throws with a named remedy when missing or too old. Worker-side. */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): { path: string; version: string } {
	const path = claudePath(env);
	let raw = "";
	try {
		raw = execFileSync(path, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "" }, stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		throw versionFailed(path, error);
	}
	return checked(path, raw);
}

/** `resolveClaude` off the event loop, bounded by `CLAUDE_VERSION_TIMEOUT_MS`: the parent's form. */
export async function resolveClaudeAsync(env: NodeJS.ProcessEnv = process.env): Promise<{ path: string; version: string }> {
	const path = claudePath(env);
	const raw = await new Promise<string>((resolve, reject) => {
		const child = execFile(path, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "" }, timeout: CLAUDE_VERSION_TIMEOUT_MS }, (error, stdout) =>
			error ? reject(versionFailed(path, error)) : resolve(stdout));
		child.stdin?.end();
	});
	return checked(path, raw);
}
