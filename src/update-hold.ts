/**
 * The update-pending dispatch hold (#396): while the updater waits on mid-turn workers, no fresh dispatch starts.
 * Reads `state/update.json` directly: the updater imports drain.ts, which imports this file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";

/** A hold older than this (from the record's `busy_since`) lapses: a stuck updater never holds dispatch for good. */
export const UPDATE_HOLD_MAX_MS = 2 * 3_600_000;
const HOLDING = ["skipped_busy", "drain_timeout"];

const readJson = (file: string): Record<string, unknown> | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

/** The pending update holding dispatch, or undefined. Unreadable files fail open (the updater is optional), logged. */
export function updatePending(home: string, now = Date.now()): { to: string; busy_since: string; until: string } | undefined {
	try {
		if (readJson(join(home, LAYOUT.data, "update.json"))?.enabled !== true) return undefined;
		const state = readJson(join(home, LAYOUT.state, "update.json"));
		const { last_result: result, busy_since: since, to } = state ?? {};
		if (typeof result !== "string" || !HOLDING.includes(result) || typeof since !== "string" || typeof to !== "string") return undefined;
		const until = Date.parse(since) + UPDATE_HOLD_MAX_MS;
		return Number.isFinite(until) && now < until ? { to, busy_since: since, until: new Date(until).toISOString() } : undefined;
	} catch (error) {
		console.error(`update hold: ignored (${(error as Error).message}); dispatch stays open`);
		return undefined;
	}
}

/** Refuses a fresh `what` while an eligible update waits on mid-turn workers; names the update, its bound and the opt-out. */
export function assertNoUpdatePending(home: string, what: string): void {
	const pending = updatePending(home);
	if (pending) {
		throw new Error(
			`refused: an auto-update to ${pending.to.slice(0, 12)} waits for mid-turn workers (busy since ${pending.busy_since}); no ${what} starts until it applies or the hold lapses at ${pending.until}. Promotions, reviews and merges stay open; data/update.json "enabled": false turns auto-update off`,
		);
	}
}
