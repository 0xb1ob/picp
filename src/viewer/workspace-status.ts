/** `GET /api/workspace/status` (full match S5): the chat footer's facts, read-only, from overview and Stats helpers. */
import { join } from "node:path";
import type { WorkspaceStatusResponse } from "./api-types.ts";
import { health, quota } from "./overview-health.ts";
import { objectList } from "./overview-read.ts";
import { isSafeId, type ViewerState } from "./sessions.ts";
import { bucketEdges, DAY_MS, parseStatsQuery } from "./stats-series.ts";
import { statsView } from "./stats-view.ts";

type Out = { status: 200; body: WorkspaceStatusResponse } | { status: 400; body: { error: string } };

/** `from`/`to` must be exactly one local calendar day in `tz` (23–25 h across DST); anything else is a 400. */
export function workspaceStatus(state: ViewerState, params: URLSearchParams, now: number): Out {
	const from = params.get("from"), to = params.get("to"), tz = params.get("tz");
	if (!from || !to || !tz) return { status: 400, body: { error: "from, to and tz are required" } };
	const range = new URLSearchParams({ range: "custom", from, to, tz });
	const q = parseStatsQuery(range, now);
	if ("error" in q) return { status: 400, body: { error: q.error } };
	const days = bucketEdges(q.from, q.to, DAY_MS, tz);
	if (days.length !== 1 || days[0]!.start !== q.from || days[0]!.end !== q.to) return { status: 400, body: { error: "from and to must span one local calendar day in tz" } };
	const stats = statsView(state, range, now, undefined, false);
	if (stats.status !== 200) return stats;
	const s = stats.body;
	const fleet = objectList(join(state.stateDir, "fleet.json"), "jobs", (j) => typeof j.job_id === "string" && isSafeId(j.job_id));
	const fleetRead = fleet.availability !== "unavailable";
	const observation = fleetRead ? quota(state, fleet.value) : null;
	const { merged, closed } = s.jobs_finished;
	const read = new Date(now).toISOString();
	return { status: 200, body: {
		generated_at: read, day: { from: s.range.from, to: s.range.to, tz },
		quota: { availability: !fleetRead ? "unavailable" : observation ? "ok" : "missing", observed_at: observation?.observed_at ?? null, observation },
		spend: { availability: s.availability === "unavailable" ? "unavailable" : s.kpis.spend_usd === null ? "missing" : "ok", observed_at: read, usd: s.kpis.spend_usd },
		working: { availability: fleet.availability, observed_at: read, count: health(state, fleet.value, now, fleetRead).workers.working },
		done: { availability: s.availability, observed_at: read, count: merged === null || closed === null ? null : merged + closed },
	} };
}
