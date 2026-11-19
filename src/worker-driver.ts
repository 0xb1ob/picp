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

export const NATIVE_DRIVERS = ["claude", "codex"] as const;
export type NativeDriver = (typeof NATIVE_DRIVERS)[number];


export const nativeConfigFile = (home: string): string => join(home, LAYOUT.data, "native.json");

/** The per-class switches (N4f): research, ship implementers and reviewers; each defaults to off. */
export const NATIVE_CLASSES = ["claude_research", "claude_ship", "claude_review"] as const;
export type NativeClass = (typeof NATIVE_CLASSES)[number];
/** The Codex CLI's switches: `codex_research` (C1b) and `codex_review` (C6) select; `codex_ship` has no class yet. */
export const CODEX_CLASSES = ["codex_research", "codex_ship", "codex_review"] as const;
export type CodexClass = (typeof CODEX_CLASSES)[number];
export type NativeConfig = Record<NativeClass | CodexClass, boolean> & { max_concurrent: number; codex_max_concurrent: number };
const NATIVE_KEYS: readonly string[] = [...NATIVE_CLASSES, "max_concurrent", ...CODEX_CLASSES, "codex_max_concurrent"];
const MAX_CONCURRENT = 4;
const OFF: NativeConfig = {
	claude_research: false, claude_ship: false, claude_review: false, max_concurrent: 1,
	codex_research: false, codex_ship: false, codex_review: false, codex_max_concurrent: 1,
};

/** `data/native.json`: absent means every class off; an unknown key, a non-boolean switch or a bad count throws. */
export function loadNativeConfig(file: string): NativeConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...OFF };
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => !NATIVE_KEYS.includes(key));
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the keys are ${NATIVE_KEYS.join(", ")}`);
	const values = raw as Record<string, unknown>;
	for (const key of [...NATIVE_CLASSES, ...CODEX_CLASSES]) {
		if (values[key] !== undefined && typeof values[key] !== "boolean") throw new Error(`${file}: ${key} must be true or false`);
	}
	const counts = Object.fromEntries((["max_concurrent", "codex_max_concurrent"] as const).map((key) => {
		const count = values[key] === undefined ? 1 : values[key];
		if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_CONCURRENT) throw new Error(`${file}: ${key} must be an integer from 1 to ${MAX_CONCURRENT}`);
		return [key, count as number];
	})) as Pick<NativeConfig, "max_concurrent" | "codex_max_concurrent">;
	const on = Object.fromEntries([...NATIVE_CLASSES, ...CODEX_CLASSES].map((key) => [key, values[key] === true])) as Record<NativeClass | CodexClass, boolean>;
	return { ...on, ...counts };
}
