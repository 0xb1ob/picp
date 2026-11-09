/** The CI watch's start pass on a real parent keeps the event loop free with a backlog of held PRs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { COMMAND_POST_EXTENSION, REPO_ROOT, startPiChild, waitFor } from "../harness/index.ts";
import { json, run, SKIP, startStack } from "./landing-helpers.ts";

const LAG_PROBE = resolve(REPO_ROOT, "tests/fixtures/loop-lag-probe.ts");
const HELD = 40;
const LAG_BOUND_MS = 2_000;

// Scenario: a parent restarts with a backlog of held PRs whose CI went green
//   Given 40 held delivery:pr jobs on a GitHub project and a fake gh answering each PR and its green run
//   When the parent starts and its ci_watch_catchup pass reads them all
//   Then one cp-ci wake names all 40 green facts, and the loop never lagged 2 s (a sync git per job stalled it 6 s)
test("ci watch start pass: a held-PR backlog wakes once without blocking the event loop", { skip: SKIP, timeout: 600_000 }, async (t) => {
	const s = await startStack(t, { github: true });
	const head = "a".repeat(40);
	const held: Awaited<ReturnType<typeof s.seed>>[] = [];
	for (let i = 0; i < HELD; i++) held.push(await s.seed(`held backlog ${i}`, { prUrl: `https://github.com/example/demo/pull/${1000 + i}` }));
	s.setGh({
		runs: [run(7, head, "completed", "success")],
		routes: held.map((job, i) => ({ match: `pulls/${1000 + i}`, replies: [json({ number: 1000 + i, html_url: job.prUrl, state: "open", merged: false, head: { sha: head, ref: job.branch } })] })),
	});
	const model = s.provider.addScript("ci-start-lag", [{ kind: "text", text: "Observed." }], { onExhausted: "repeat" });
	s.agentDir.writeModels(s.provider);
	const lagFile = join(s.home, "loop-lag.json");
	const child = startPiChild({ cwd: s.home, model, env: { ...s.agentDir.env, CP_HOME: s.home, CP_TEST_LAG_FILE: lagFile }, extensions: [LAG_PROBE, COMMAND_POST_EXTENSION] });
	try {
		const banner = `CI/PR OBSERVED — ${HELD} new facts about ${HELD} held PR(s)`;
		const seen = await waitFor(() => JSON.stringify(s.provider.requests("ci-start-lag").map((request) => request.body.messages)), (text) => text.includes(banner), {
			timeoutMs: 300_000,
			what: "the start pass's coalesced cp-ci wake",
		});
		for (const job of held) assert.ok(seen.includes(`${job.jobId}: CI green on ${head.slice(0, 12)}`), `${job.jobId} is in the wake`);
		const lag = JSON.parse(readFileSync(lagFile, "utf8")) as { max_lag_ms: number; ticks: number };
		assert.ok(lag.ticks > 0, "the lag probe ran during the start pass");
		assert.ok(lag.max_lag_ms < LAG_BOUND_MS, `max event-loop lag ${lag.max_lag_ms} ms during the start pass, bound ${LAG_BOUND_MS} ms`);
	} finally {
		await child.close();
	}
});
