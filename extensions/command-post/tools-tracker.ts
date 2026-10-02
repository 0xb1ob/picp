/**
 * cp_tracker: connect, disconnect and list one tracker per project (B2), import ready beads under a
 * named-jobs mandate (B4), and host the write-back tick (B5) while this session holds the parent lock. The
 * policy is src/trackers/config.ts, import.ts and sync.ts; this only adapts it to a pi tool.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Delivery, JobKind } from "../../src/contracts.ts";
import { adapterFor } from "../../src/trackers/adapter.ts";
import { formatTrackers, TrackerStore } from "../../src/trackers/config.ts";
import { formatImport, importReady } from "../../src/trackers/import.ts";
import { backfillLinks, linkJob } from "../../src/trackers/link.ts";
import { formatSync, runSync } from "../../src/trackers/sync.ts";
import { SyncStore } from "../../src/trackers/sync-store.ts";
import type { ExtensionDeps } from "./shared.ts";

/** Write-back (B5) ticks every minute, only while this session holds the parent lock. */
export const TRACKER_SYNC_TICK_MS = 60_000;

export function registerTrackerTools(pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean): void {
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) return; // non-overlapping: a slow br never stacks ticks
		running = true;
		try {
			const post = deps.commandPost();
			const trackers = new TrackerStore({ home: post.home, registry: post.registry });
			// laf: link open jobs whose br ref names a bead first, so their write-back is derived this tick. Skips stay silent here.
			// sha: a backfill failure is one named line and never skips the write-back below.
			try {
				const filled = await backfillLinks(post.ledger(), trackers.list());
				for (const line of filled.linked) process.stderr.write(`pi-command-post: tracker linked ${line}\n`);
			} catch (error) {
				process.stderr.write(`pi-command-post: tracker backfill failed: ${(error as Error).message}\n`);
			}
			const report = await runSync({ home: post.home, ledger: post.ledger(), trackers });
			for (const row of report.attempted) {
				if (row.outcome !== "applied" && row.outcome !== "already") process.stderr.write(`pi-command-post: tracker write-back ${row.op} ${row.item_id} for ${row.job_id}: ${row.outcome}\n`);
			}
		} catch (error) {
			process.stderr.write(`pi-command-post: tracker write-back tick failed: ${(error as Error).message}\n`);
		} finally {
			running = false;
		}
	};
	// Registered after the session hooks, so the lock is already decided when this runs.
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), TRACKER_SYNC_TICK_MS);
		timer.unref();
		setTimeout(() => void tick(), 0).unref(); // catch-up pass, after startup returns
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});

	pi.registerTool({
		name: "cp_tracker",
		label: "Trackers",
		description:
			"Tracker connections, one per project, in data/trackers.json: `connect` a project to a beads database (endpoint: absolute path to " +
			"beads.db or its .beads directory; the database must exist and br must read it), `disconnect` it, or `list` them. Intake and " +
			"write capabilities are off unless intake:true / write:true are passed. github is refused as \"adapter not implemented (B6)\". " +
			"Switching trackers is disconnect, then connect; linked jobs keep their link. A project without a connection or its own " +
			"<clone>/.beads has no beads, never the home's. `import` (intake-enabled beads connection only) turns ready beads into " +
			"ordinary open jobs under a named-jobs (batch) mandate, enrolling each into its job_ids within its job and spend caps: only " +
			"the bead ids you pass, or ready children of an epic the mandate's objective records as `epic: <id>`; anything else is " +
			"refused by id. It never dispatches: run each printed cp_dispatch line through cp_next as usual. Write-back (write:true) runs " +
			"by itself: a linked kind:ship delivery:pr job with a matching merge receipt closes its bead with the PR URL, merge and " +
			"head commits; any other closed, undropped job closes its bead with `CP <id> done: <close_reason>`, and a dropped job or a " +
			"receipt-less ship/pr job only comments. `list` shows write-backs not yet done; an outage never gates a merge. " +
			"`link` records which bead a job closes: job_id with item_id, or job_id alone to use its br external_ref, or nothing to " +
			"backfill open jobs; cp_job create and cp_dispatch link automatically when the ref names a bead on the active connection.",
		promptSnippet: "Connect, disconnect, list, import from or link jobs to per-project tracker connections (cp_tracker)",
		promptGuidelines: [
			"Never hand-edit data/trackers.json; cp_tracker is the only writer.",
			"A reused connection id for another endpoint is refused: pass a new connection_id.",
			"cp_tracker import needs a named-jobs mandate (cp_mandate issue with job_ids); a project-wide grant is refused.",
			"Tracker write-back replaces a manual br close: do not close a linked bead by hand.",
			"A job whose bead should close on merge but is not linked: cp_tracker link job_id=<id> [item_id=<bead>]; closed jobs link only this way.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "connect", "disconnect", "import", "link"]),
			project: Type.Optional(Type.String({ description: "Registered project (connect/disconnect/import)" })),
			adapter: Type.Optional(StringEnum(["beads", "github"])),
			endpoint: Type.Optional(Type.String({ description: "beads: absolute path to beads.db or its .beads directory" })),
			connection_id: Type.Optional(Type.String({ description: "Default <project>-<adapter>" })),
			intake: Type.Optional(Type.Boolean({ description: "Allow import (B4); default off" })),
			write: Type.Optional(Type.Boolean({ description: "Allow write-back (B5); default off" })),
			mandate_id: Type.Optional(Type.String({ description: "import: the named-jobs (batch) mandate the jobs enroll into" })),
			kind: Type.Optional(StringEnum(["ship", "research"])),
			delivery: Type.Optional(StringEnum(["pr", "local"])),
			ids: Type.Optional(Type.Array(Type.String(), { maxItems: 64, description: "import: bead ids to import" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
			job_id: Type.Optional(Type.String({ description: "link: the job; omit to backfill every open unlinked job whose external_ref names a bead" })),
			item_id: Type.Optional(Type.String({ description: "link: the bead id; default from the job's br external_ref" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			deps.setLive(ctx);
			const post = deps.commandPost(ctx.modelRegistry);
			const store = new TrackerStore({ home: post.home, registry: post.registry });
			const need = (key: "project" | "adapter" | "endpoint" | "mandate_id" | "kind" | "delivery"): string => {
				const value = params[key];
				if (value === undefined || value === "") throw new Error(`cp_tracker ${params.action} needs ${key}`);
				return value;
			};
			let text: string;
			if (params.action === "list") {
				const counts = new Map<string, number>();
				for (const job of await post.ledger().list({ all: true })) {
					if (job.tracker) counts.set(job.tracker.connection_id, (counts.get(job.tracker.connection_id) ?? 0) + 1);
				}
				text = [formatTrackers(store.list(), (id) => counts.get(id) ?? 0), ...formatSync(new SyncStore(post.home).list())].join("\n");
			} else if (params.action === "connect") {
				const { connection, created } = await store.connect({
					project: need("project"), adapter: need("adapter") as "beads" | "github", endpoint: need("endpoint"),
					...(params.connection_id ? { connection_id: params.connection_id } : {}),
					...(params.intake !== undefined ? { intake: params.intake } : {}), ...(params.write !== undefined ? { write: params.write } : {}),
				});
				text = `${created ? "connected" : "already connected"} ${formatTrackers([connection], () => 0).replace(/ linked_jobs=\d+/, "")}`;
			} else if (params.action === "import") {
				const result = await importReady(
					{ home: post.home, store, adapter: adapterFor("beads"), ledger: post.ledger(), mandates: post.mandates, fleetJobs: post.fleet.read().jobs },
					{
						project: need("project"), mandateId: need("mandate_id"), kind: need("kind") as JobKind, delivery: need("delivery") as Delivery,
						...(params.ids ? { ids: params.ids } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}),
					},
				);
				text = formatImport(result);
			} else if (params.action === "link") {
				if (params.job_id) text = await linkJob(post.ledger(), store.list(), params.job_id, params.item_id);
				else if (params.item_id) throw new Error("cp_tracker link item_id needs job_id");
				else {
					const { linked, skipped } = await backfillLinks(post.ledger(), store.list());
					text = linked.length + skipped.length === 0
						? "nothing to link: no open unlinked job carries an external_ref"
						: [`linked ${linked.length}${linked.length ? ":" : ""}`, ...linked.map((l) => `  ${l}`), `skipped ${skipped.length}${skipped.length ? ":" : ""}`, ...skipped.map((s) => `  ${s}`)].join("\n");
				}
			} else {
				const connection = await store.disconnect(need("project"));
				text = `disconnected ${connection.id} (${connection.adapter} ${connection.endpoint}); linked jobs keep their link`;
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
