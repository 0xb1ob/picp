import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import type { JobsResponse, MapResponse, SchedulesResponse, StatsResponse } from "../../src/viewer/api-types.ts";
import { createViewer } from "../../src/viewer/server.ts";
import { createScratchHome } from "../harness/index.ts";

const RUNS = 1000;
const REVOKED = 600;
/** The operator's target per warm request; a contended runner may instead stay under half the uncached cost. */
const BUDGET_MS = 300;
const BUDGET_RATIO = 0.5;

/** A home shaped like the slow one: 1000 runs with events and session tails, 600 revoked grants and one live grant. */
function seed(home: ReturnType<typeof createScratchHome>, now: number) {
	const put = (file: string, value: unknown) => {
		const path = join(home.path, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	};
	const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
	const lines = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const ids = Array.from({ length: RUNS }, (_, i) => `cp-run-${i}`);
	const open = (i: number) => i % 10 === 0;
	put(LAYOUT.jobsFile, { jobs: ids.map((id, i) => ({ id, title: `${id} ${"long title ".repeat(8)}`, status: open(i) ? "in_progress" : "closed",
		labels: ["project:demo", "kind:ship", "delivery:pr"], created_at: at(i + 30), ...(open(i) ? {} : { closed_at: at(i) }) })) });
	put(LAYOUT.fleetFile, { jobs: ids.map((id, i) => ({ job_id: id, project: "demo", kind: "ship", delivery: "pr", phase: open(i) ? "held" : "done",
		dispatched_at: at(i + 20), ...(open(i) ? {} : { closed_at: at(i) }), worker: { role: "implementer", model: "mock/worker" } })) });
	for (const [i, id] of ids.entries()) {
		const session = join(home.path, LAYOUT.sessions, `${id}.jsonl`);
		put(join(LAYOUT.runs, id, "status.json"), { phase: "idle", model: "mock/worker", session_file: session, started_at: at(i + 20),
			usage: { cost_usd: 1, total_tokens: 1000, input: 600, output: 400, cache_read: 0, cache_write: 0 } });
		put(join(LAYOUT.runs, id, "review-1", "status.json"), { model: "mock/reviewer", usage: { cost_usd: 0.25, total_tokens: 50 } });
		put(join(LAYOUT.runs, id, "events.jsonl"), lines([
			{ source: "cp", job_id: id, ts: at(i + 20), type: "spawned", payload: { model: "mock/worker" } },
			{ source: "cp", job_id: id, ts: at(i + 20), type: "routing_resolved", payload: { mandate_id: "md-live", scope: "S", risk: "low" } },
			...Array.from({ length: 40 }, (_, n) => ({ source: "pi", ts: at(i + 19), type: "tool_execution_end", payload: { output: "x".repeat(2000), n } })),
			{ source: "pi", ts: at(i + 10), type: "message_end", payload: { message: { role: "assistant", usage: { input: 600, output: 400 } } } },
			{ source: "cp", job_id: id, ts: at(i + 5), type: "ci_observed", payload: { event: "ci_green", head_sha: "a".repeat(40) } },
		]));
		put(join(LAYOUT.sessions, `${id}.jsonl`), lines([
			{ type: "session", id, timestamp: at(i + 20) },
			...Array.from({ length: 40 }, () => ({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(2000) }] } })),
			{ type: "message", message: { role: "assistant", model: "mock/worker", usage: { input: 600, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 } } },
		]));
	}
	// As on the slow home: nearly every grant names its jobs (638 of 668 there), a few are project-wide.
	for (let i = 0; i < REVOKED; i++) put(join(LAYOUT.mandates, `md-old-${i}.json`), { id: `md-old-${i}`, status: "revoked", projects: ["demo"],
		...(i < 30 ? {} : { job_ids: [ids[i]!, ids[i + 1]!] }), issued_at: at(5000), revoked_at: at(4000), expiry: "2099-01-01T00:00:00Z",
		spend_cap: { usd: 1000 }, objective: `old ${i}` });
	put(join(LAYOUT.mandates, "md-live.json"), { id: "md-live", status: "active", projects: ["demo"], issued_at: at(3000), expiry: "2099-01-01T00:00:00Z",
		spend_cap: { usd: 5000 }, objective: "the live grant" });
	put(join(LAYOUT.state, "schedules.json"), { schema_version: 1, schedules: [] });
	return { ids, put, at };
}


/**
 * The slow-dashboard report: /api/stats, /api/jobs and /api/map took 1-5 s warm on a ~1000-run home, uncached.
 * Through the real HTTP entry point each warm request stays in budget; then one run's usage and one appended
 * event must show on the next request (the caches key on file identity, never on time alone).
 */
test("viewer endpoints stay fast when warm on a 1000-run home, and still see edits", async (t) => {
	const home = createScratchHome(); t.after(() => home.cleanup());
	const now = Date.now();
	const { ids, put, at } = seed(home, now);
	const options = { home: home.path, stateDir: join(home.path, LAYOUT.state), host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((r) => server.listen(0, options.host, r));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const get = async (path: string) => {
		const start = performance.now();
		const res = await fetch(`${base}${path}`);
		const body = await res.text();
		assert.equal(res.status, 200, `${path}: ${body.slice(0, 200)}`);
		return { body, ms: performance.now() - start };
	};
	for (const path of ["/api/stats", "/api/jobs", "/api/map", "/api/schedules", "/api/overview"]) {
		const cold = await get(path);
		const warm = [await get(path), await get(path), await get(path)];
		const best = Math.min(...warm.map((w) => w.ms));
		t.diagnostic(`${path}: cold ${cold.ms.toFixed(0)} ms, warm ${best.toFixed(0)} ms (best of 3), ${cold.body.length} B`);
		assert.ok(best < BUDGET_MS || best < cold.ms * BUDGET_RATIO, `${path} warm ${best.toFixed(0)} ms (budget ${BUDGET_MS} ms or half of cold ${cold.ms.toFixed(0)} ms)`);
	}
	const jobs = JSON.parse((await get("/api/jobs")).body) as JobsResponse;
	assert.equal(jobs.jobs.length, RUNS);
	const map = JSON.parse((await get("/api/map")).body) as MapResponse;
	assert.equal(map.revoked_count, REVOKED);
	assert.equal(map.nodes.length, RUNS);
	assert.equal((JSON.parse((await get("/api/schedules")).body) as SchedulesResponse).error, null);
	const stats = JSON.parse((await get("/api/stats")).body) as StatsResponse;
	assert.ok((stats.kpis.tokens ?? 0) > 0, "seeded usage reaches the stats");

	const target = ids[1]!;
	put(join(LAYOUT.runs, target, "status.json"), { phase: "idle", model: "mock/worker", started_at: at(21),
		usage: { cost_usd: 7, total_tokens: 1000, input: 600, output: 400, cache_read: 0, cache_write: 0 } });
	const edited = JSON.parse((await get("/api/jobs")).body) as JobsResponse;
	assert.notEqual(edited.jobs.find((j) => j.id === target)?.cost_usd, jobs.jobs.find((j) => j.id === target)?.cost_usd, "a status.json edit shows");
	appendFileSync(join(home.path, LAYOUT.runs, target, "events.jsonl"), JSON.stringify({ source: "pi", ts: at(1), type: "message_end",
		payload: { message: { role: "assistant", usage: { input: 5000, output: 5000 } } } }) + "\n");
	const after = JSON.parse((await get("/api/stats")).body) as StatsResponse;
	assert.notDeepEqual(after.kpis, stats.kpis, "an appended event shows in the stats");
});
