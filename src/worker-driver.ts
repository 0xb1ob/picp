/**
 * The worker seam (N3b): what dispatch, intake, the observers and teardown read from a worker. pi's `WorkerProcess`
 * satisfies it; a native driver satisfies it too by running as a child that speaks the same RPC lines
 * (src/drivers/claude.ts). pi stays the default: a worker is native only when `cp_dispatch` names `driver`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import type { WorkerProcess } from "./worker-process.ts";

export type WorkerDriverHandle = Pick<WorkerProcess, "pid" | "closed" | "exit" | "alive" | "busy" | "settledCount" | "onEvent" | "send" | "getState" | "shutdown" | "kill" | "stderrTail">;

export const NATIVE_DRIVERS = ["claude"] as const;
export type NativeDriver = (typeof NATIVE_DRIVERS)[number];

/** The named refusal for every follow-up into a native worker (cp_send, cp_revive, a recovery) until N3c. */
export function nativeFollowUpRefusal(jobId: string, what: string): string {
	return `${jobId} runs on the native claude driver: ${what} is refused, native follow-ups land in N3c; nothing was queued. Tear it down and dispatch a fresh job instead.`;
}

export const nativeConfigFile = (home: string): string => join(home, LAYOUT.data, "native.json");

/** `data/native.json` (`workers.native_claude_research`): absent means off; another key or a non-boolean throws. */
export function loadNativeConfig(file: string): { claude_research: boolean } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claude_research: false };
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => key !== "claude_research");
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the only key is "claude_research"`);
	const value = (raw as { claude_research?: unknown }).claude_research;
	if (value !== undefined && typeof value !== "boolean") throw new Error(`${file}: claude_research must be true or false`);
	return { claude_research: value === true };
}
