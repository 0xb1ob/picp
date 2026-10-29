/**
 * Durable dedupe of the parent's idle wake: a restart (manual or auto-update) wakes the parent, whose
 * "nothing ready" answer relays once per identical `cp_next` state, not once per process.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { atomicWriteJson } from "./json-store.ts";
import type { NextResult } from "./next.ts";

const IDLE_KINDS: readonly string[] = ["wait", "paused", "no_mandate"];
const MAX_AGE_MS = 24 * 3_600_000;

export const idleWakeFile = (home: string): string => join(home, LAYOUT.state, "parent-idle-wake.json");

/** A stable key for a `cp_next` answer with nothing to act on; undefined when any grant or run has something. */
export function idleNextKey(details: unknown): string | undefined {
	const result = details as NextResult | undefined;
	if (!result?.action) return undefined;
	const views = [result, ...(result.others ?? [])];
	const busy = (view: NextResult) => !IDLE_KINDS.includes(view.action?.kind) || (view.ready?.length ?? 0) > 0 || view.escalation_id !== undefined
		|| view.warning !== undefined || (view.blocked ?? []).some((row) => row.escalation_ids?.length);
	if (views.some(busy)) return undefined;
	// Spend and the reasons' figures (queued counts, run times) are left out: they move without anything to do.
	const rows = views.map((view) => [view.mandate?.id ?? view.run?.id ?? null, view.mandate?.status ?? null, view.action.kind, view.action.reason.replace(/\d+/g, "#")]);
	return JSON.stringify({ rows, lined_up: (result.lined_up?.jobs ?? []).map((job) => job.id) });
}

/**
 * The bridge's gate before relaying a wake: true (journaled `idle_wake_deduped`) when `key` repeats the idle wake
 * stored in the last 24 h. A relayed idle wake stores its key; any other wake (`key` undefined) clears it.
 * Fails open and never throws: an unreadable file relays and is overwritten.
 */
export function idleWakeGate(home: string | undefined, key: string | undefined, journal: (event: string, payload: Record<string, unknown>) => void): boolean {
	if (!home) return false;
	const file = idleWakeFile(home);
	try {
		if (key === undefined) {
			rmSync(file, { force: true });
			return false;
		}
		let saved: { key?: unknown; at?: unknown } | undefined;
		try { saved = JSON.parse(readFileSync(file, "utf8")) as typeof saved; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") journal("idle_wake_state_unreadable", { file, error: (error as Error).message }); }
		if (saved?.key === key && typeof saved.at === "string" && Date.now() - Date.parse(saved.at) < MAX_AGE_MS) {
			journal("idle_wake_deduped", { key, since: saved.at });
			return true;
		}
		atomicWriteJson(file, { key, at: new Date().toISOString() });
	} catch (error) {
		journal("idle_wake_state_unwritable", { file, error: (error as Error).message });
	}
	return false;
}
