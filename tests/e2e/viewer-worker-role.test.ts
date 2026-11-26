/**
 * The worker role label (src/viewer/worker-role.ts) through `bin/cp-view` on a scratch home: one fleet record per role,
 * read back from every payload that carries worker rows and from the badge on Overview, Jobs, Chats and job detail.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type Json, jsonl, viewer, write } from "../harness/conversations.ts";

const AT = "2026-11-26T08:00:00.000Z";
/** The marker src/send.ts writes per delivered send; a repair carries `purpose`. */
const sent = (purpose?: string, receipt = "delivered") => ({
	source: "cp", type: "prompt_sent", ts: AT,
	payload: { receipt, bytes: 9, busy_before: false, ...(purpose ? { purpose } : {}) },
});
const EXPECTED: Record<string, string> = {
	"cp-plan": "Planner", "cp-research": "Research", "cp-impl": "Implementer", "cp-repair": "Implementer · repair",
	"cp-review": "Reviewer", "cp-gate": "Gate reviewer", "cp-qa": "QA", "cp-ops": "Ops",
	"cp-custom": "—", "cp-bare": "—", "cp-done": "Implementer",
};
const LIVE = Object.fromEntries(Object.entries(EXPECTED).filter(([id]) => id !== "cp-done"));
const COLUMNS = ["Job", "Title", "Wall clock", "Context", "Review", "CI", "Role", "Model", "Cost"];
const labels = (rows: Json[], key: string) => Object.fromEntries(rows.map((row) => [row[key], row.worker_role?.label]));
const title = (label: string) => (label === "—" ? "Role not recorded" : `Role: ${label}`);
const titled = (shown: Record<string, string>) =>
	Object.fromEntries(Object.entries(shown).map(([id, label]) => [id, title(label)]));
/** Row id -> its role badge's title, the badge looked up as `selector`. */
const badges = (rows: Element[], id: (row: Element) => string | null | undefined, selector: string) =>
	Object.fromEntries(rows.map((row) => [id(row), row.querySelector(selector)?.getAttribute("title")]));

function seed(stateDir: string) {
	const job = (job_id: string, kind: string, delivery: string, phase: string, profile?: string) => ({
		job_id, project: "demo", kind, delivery, phase, dispatched_at: AT,
		worker: { ...(profile ? { profile } : {}), role: kind === "ship" ? "implementer" : "planner", model: "acme/x" },
	});
	write(join(stateDir, "fleet.json"), { jobs: [
		job("cp-plan", "research", "pipeline", "waiting", "planner"),
		job("cp-research", "research", "local", "waiting", "planner"),
		job("cp-impl", "ship", "pr", "waiting", "implementer"), job("cp-repair", "ship", "pr", "waiting", "implementer"),
		job("cp-review", "ship", "pr", "held", "implementer"), job("cp-gate", "research", "pipeline", "waiting", "planner"),
		job("cp-qa", "research", "answer", "waiting", "qa"), job("cp-ops", "research", "local", "waiting", "ops"),
		job("cp-custom", "ship", "pr", "waiting", "my-profile"), job("cp-bare", "ship", "pr", "waiting"),
		{ ...job("cp-done", "ship", "pr", "done", "implementer"), closed_at: AT },
	] });
	const run = (id: string, ...parts: string[]) => join(stateDir, "runs", id, ...parts);
	for (const id of Object.keys(EXPECTED)) {
		const phase = id === "cp-done" ? "exited" : id === "cp-review" || id === "cp-gate" ? "idle" : "working";
		write(run(id, "status.json"), { job_id: id, phase, started_at: AT });
	}
	write(run("cp-impl", "events.jsonl"), jsonl([sent("repair"), sent()]));
	write(run("cp-repair", "events.jsonl"), jsonl([sent(), sent("repair"), sent(undefined, "failed")]));
	write(run("cp-review", "review-1", "pending.json"), { job_id: "cp-review", surface: "review", attempt: 1 });
	write(run("cp-gate", "gate-1", "pending.json"), { job_id: "cp-gate", surface: "gate", attempt: 1 });
	write(run("cp-done", "events.jsonl"), jsonl([sent("repair")]));
	write(run("cp-done", "review-2", "pending.json"), { job_id: "cp-done", surface: "review", attempt: 2 });
}

// Scenario: Given fleet records for a planner, a research planner, an implementer, one in a repair, a held implementer
//   whose diff review is pending, a planner whose gate is pending, qa, ops, an unknown and a missing profile and a
//   finished implementer, When each payload and screen is read, Then each row names the running process's role and an
//   unknown profile reads "—"; a repair marker before a plain send, or a finished job's leftovers, never claim one.
test("Worker role: each payload and list names a worker's role, unknown as —", { timeout: 120_000 }, async (t) => {
	const d = await viewer(t, { seed });
	const read = async (path: string) => {
		const got = await d.send(path);
		assert.equal(got.status, 200, path);
		return got.body;
	};

	const demo = (await read("/api/dashboard")).projects.find((p: Json) => p.name === "demo");
	assert.deepEqual(labels(demo.jobs, "job_id"), EXPECTED, "/api/dashboard rows");
	assert.deepEqual(labels((await read("/api/overview")).in_flight, "id"), LIVE, "/api/overview in_flight");
	assert.deepEqual(labels((await read("/api/jobs")).jobs, "id"), EXPECTED, "/api/jobs");
	const sidebar = await read("/api/sessions");
	assert.deepEqual(labels([...sidebar.active, ...sidebar.recent], "id"), EXPECTED, "/api/sessions sidebar rows");
	assert.deepEqual(labels((await read("/api/sessions?view=parent")).workers, "id"), LIVE, "/api/sessions workers");
	const repair = { label: "Implementer · repair", short: "Repair" };
	assert.deepEqual((await read("/api/job/cp-repair")).job.worker_role, repair);
	const bare = (await read("/api/job/cp-bare")).job.worker_role;
	assert.deepEqual(bare, { label: "—", short: "—" }, "a missing profile is never guessed");

	const overview = await d.open("#overview");
	await overview.find(".overview-flight .overview-role .role-badge");
	assert.deepEqual(overview.$$(".overview-flight-columns > span").map((s) => s.textContent), COLUMNS);
	const flight = overview.$$("article.overview-flight");
	const flightIds = (row: Element) => row.getAttribute("aria-label");
	assert.deepEqual(badges(flight, flightIds, ".overview-role .role-badge"), titled(LIVE), "Overview In flight");
	const jobs = await d.open("#jobs");
	await jobs.find(".job-role .role-badge");
	const idOf = (row: Element) => row.querySelector(".job-row-id code")?.textContent;
	assert.deepEqual(badges(jobs.$$("article.job-row"), idOf, ".job-role .role-badge"), titled(EXPECTED), "Jobs list");
	const repairRow = jobs.$('a[href="#job/cp-repair"]')!.closest(".job-row")!;
	const shown = [".role-badge-full", ".role-badge-short"].map((cell) => repairRow.querySelector(cell)?.textContent);
	assert.deepEqual(shown, [repair.label, repair.short], "full label and its short form");
	const chats = await d.open("#sessions?view=parent");
	await chats.find(".session-choice-nested .role-badge");
	const titleOf = (row: Element) => row.querySelector("strong")?.getAttribute("title");
	assert.deepEqual(badges(chats.$$(".session-choice-nested"), titleOf, ".role-badge"), titled(LIVE), "Chats Fleet");
	const unrolled = chats.$(".session-choice:not(.session-choice-nested) .role-badge");
	assert.equal(unrolled, null, "operator and parent rows carry no role");
	const detail = await (await d.open("#job/cp-review")).find(".job-badges .role-badge");
	assert.equal(detail.getAttribute("title"), "Role: Reviewer", "job detail header");

	// Served CSS: the full label wraps on a phone, Role sits beside Model on stacked rows, short labels from 1200 px.
	const css = (await d.get(/<link rel="stylesheet" href="([^"]+)"/.exec((await d.get("/")).text)![1]!)).text;
	assert.match(css, /\.role-badge\{[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
	assert.match(css, /\.overview-flight\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*"role model"\}/);
	assert.match(css, /@media ?\(min-width: ?1200px\) ?\{\.overview-role \.role-badge-short,\.job-role \.role-badge/);
});
