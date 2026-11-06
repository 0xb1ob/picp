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


export const nativeConfigFile = (home: string): string => join(home, LAYOUT.data, "native.json");

/** The per-class switches (N4f): research, ship implementers and reviewers; each defaults to off. */
export const NATIVE_CLASSES = ["claude_research", "claude_ship", "claude_review"] as const;
export type NativeClass = (typeof NATIVE_CLASSES)[number];
export type NativeConfig = Record<NativeClass, boolean> & { max_concurrent: number };
const NATIVE_KEYS: readonly string[] = [...NATIVE_CLASSES, "max_concurrent"];
const MAX_CONCURRENT = 4;

/** `data/native.json`: absent means every class off; an unknown key, a non-boolean switch or a bad count throws. */
export function loadNativeConfig(file: string): NativeConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { claude_research: false, claude_ship: false, claude_review: false, max_concurrent: 1 };
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const extra = Object.keys(raw).filter((key) => !NATIVE_KEYS.includes(key));
	if (extra.length) throw new Error(`${file} has unknown key ${extra.join(", ")}; the keys are ${NATIVE_KEYS.join(", ")}`);
	const values = raw as Record<string, unknown>;
	for (const key of NATIVE_CLASSES) {
		if (values[key] !== undefined && typeof values[key] !== "boolean") throw new Error(`${file}: ${key} must be true or false`);
	}
	const count = values.max_concurrent ?? 1;
	if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_CONCURRENT) throw new Error(`${file}: max_concurrent must be an integer from 1 to ${MAX_CONCURRENT}`);
	return { claude_research: values.claude_research === true, claude_ship: values.claude_ship === true, claude_review: values.claude_review === true, max_concurrent: count as number };
}
