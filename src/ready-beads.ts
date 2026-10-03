/** Ready tracker work is evidence, never a job or an authority grant. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FleetRecord } from "./contracts.ts";
import { type Ledger, parseJobLabels } from "./ledger.ts";
import { type CommandRunner, runCommand } from "./merge-ask.ts";
import type { ProjectRegistry } from "./projects.ts";
import { projectTracker } from "./trackers/config.ts";
import { notImplemented } from "./trackers/adapter.ts";
import { BR_SHOW_RE, unshellQuote } from "./verify-external-ref.ts";

export interface ReadyBeads {
	project: string;
	ids: string[];
	error?: string;
}

/** One bounded command per project per invocation, shared by all mandate views. */
export async function readReadyBeads(registry: ProjectRegistry, ledger: Ledger, project?: string, exec: CommandRunner = runCommand): Promise<ReadyBeads[]> {
	const results: ReadyBeads[] = [];
	for (const entry of registry.list().filter((entry) => project ? entry.name === project : !entry.archived)) {
		try {
			// Only the project's own connection or clone DB; a project with neither has no beads (never the home's).
			const tracker = projectTracker(registry.home, entry.name, () => registry.pathOf(entry.name));
			if (!tracker) continue;
			if (tracker.adapter === "github") {
				results.push({ project: entry.name, ids: [], error: notImplemented("github") });
				continue;
			}
			const db = tracker.db;
			const clone = registry.pathOf(entry.name);
			const cwd = existsSync(clone) ? clone : dirname(db);
			// runCommand bounds output at 4 MiB; never silently truncate the ready set.
			const parsed: unknown = JSON.parse(await exec("br", ["--db", db, "ready", "--json", "--limit", "0"], { cwd, timeoutMs: 10_000 }));
			// Read the ledger only after `br ready` answers: a job created or linked while
			// br ran (up to 10 s, and no fleet change to cancel the idle probe) must count.
			const jobs = await ledger.list({ all: true });
			const tracked = new Set(jobs.filter((job) => parseJobLabels(job.labels).project === entry.name).flatMap((job) => {
				const ids: string[] = [];
				const match = BR_SHOW_RE.exec(job.external_ref ?? "");
				if (match && (!match[1] || resolve(cwd, unshellQuote(match[1])) === db)) ids.push(match[2]!);
				// A tracker link is a job too, even when it carries no `external_ref`
				// (cp-yxgl did exactly that), and a non-closed one means the bead is
				// already owned — a blocked pipeline job waiting on its planner is not
				// "no job".
				if (job.status !== "closed" && job.tracker?.item_id) ids.push(job.tracker.item_id);
				return ids;
			}));
			if (!Array.isArray(parsed)) throw new Error("br ready must return an array");
			const ids = new Set<string>();
			for (const row of parsed) {
				if (!row || typeof row !== "object" || typeof row.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(row.id) ||
					typeof row.issue_type !== "string" || (row.labels !== undefined && (!Array.isArray(row.labels) || !row.labels.every((label: unknown) => typeof label === "string")))) {
					throw new Error("br ready returned an invalid bead");
				}
				if (row.issue_type !== "epic" && !row.labels?.includes("deferred") && !tracked.has(row.id)) ids.add(row.id);
			}
			results.push({ project: entry.name, ids: [...ids] });
		} catch (error) {
			results.push({ project: entry.name, ids: [], error: String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 300) });
		}
	}
	return results;
}

export function formatReadyBeads(rows: readonly ReadyBeads[]): string[] {
	return rows.flatMap((row) => row.error ? [`[${row.project}] ready beads unavailable: ${row.error}`] : row.ids.length ?
		[`[${row.project}] ${row.ids.length} ready beads have no job: ${row.ids.slice(0, 5).join(", ")} \u2014 create jobs under the active grant, or raise one grant covering them`] : []);
}

/**
 * Observe transitions, not reads. A new working period invalidates an in-flight idle probe, and the
 * fleet is re-read at emit time: a worker recorded through another store (or any path that skipped
 * this callback) while the probe ran keeps the notice silent.
 */
export function idleBeadObserver(read: () => Promise<ReadyBeads[]>, emit: (text: string) => void, fleetNow: () => readonly FleetRecord[]) {
	let generation = 0;
	const working = (jobs: readonly FleetRecord[]) => jobs.some((job) => job.phase === "waiting" || job.phase === "launching");
	// A fleet read that throws propagates to the caller (it logs); it never reads as idle.
	const stillIdle = (own: number) => generation === own && !working(fleetNow());
	return async (before: readonly FleetRecord[], after: readonly FleetRecord[]): Promise<void> => {
		if (working(after)) { generation++; return; }
		if (!working(before)) return;
		const own = ++generation;
		let rows: ReadyBeads[];
		try {
			rows = await read();
		} catch (error) {
			if (stillIdle(own)) emit(`fleet idle; ready beads unavailable: ${String(error).slice(0, 300)}`);
			return;
		}
		if (!stillIdle(own)) return;
		const count = rows.reduce((sum, row) => sum + row.ids.length, 0);
		const lines = formatReadyBeads(rows);
		if (lines.length) emit(`${count ? `fleet idle with ${count} ready beads\n` : "fleet idle; ready beads could not be read\n"}${lines.join("\n")}`);
	};
}
