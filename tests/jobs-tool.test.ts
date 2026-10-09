/**
 * The ledger's two surfaces (spec 2026-09-04 §Model surface, §Operator surface).
 *
 * `runJobAction` is exercised directly over a scratch ledger; `registerJobs` is
 * exercised through a fake `pi` that captures what was registered, so the tool
 * and the command are proven to be wired to the same policy without a process.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LAYOUT, validate, WORKER_FORBIDDEN_TOOLS } from "../src/contracts.ts";
import { formatJobLine, JOB_ACTIONS, type JobActionInput, JobActionSchema, parseJobsArgs, portsFor, registerJobs, runJobAction } from "../extensions/command-post/jobs.ts";
import { JOB_PHASES } from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { Ledger } from "../src/ledger.ts";
import { verifyExternalRef } from "../src/verify-external-ref.ts";
import { createScratchLedger } from "./harness/index.ts";
import type { Runtime } from "../src/contracts.ts";

const MULTI_RUNTIME: Runtime = { mode: "multi", home: "/h", source: "checkout", reason: "test" };

function ports(t: { after(fn: () => void): void }, live: Set<string> = new Set(), reports: Map<string, "reported" | "unreported" | "none"> = new Map()) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	return {
		scratch,
		ports: {
			ledger: scratch.ledger,
			escalations: () => new EscalationStore({ home: scratch.path }),
			hasLiveWorker: (id: string) => live.has(id),
			reportState: (id: string) => reports.get(id) ?? "none",
			resolveProject: (given: string | undefined) => {
				if (!given) throw new Error("cp_job create needs `project`");
				return given;
			},
		},
	};
}

test("cp_job amend freezes authorized scope in order and refuses unverified quotes and closed jobs", async (t) => {
	const { ports: base, scratch } = ports(t);
	const p = { ...base, operatorTexts: ["Approved: also document the default."] };
	const created = await runJobAction({ action: "create", title: "amend me", project: "demo", delivery: "pr" }, p);
	const id = (created.details.job as { id: string }).id;
	const file = join(scratch.path, "amendment.md");
	writeFileSync(file, "Document the default.");
	const input = { action: "amend", job_id: id, task_file: file, quote: "also document the default", reason: "operator expanded coverage" } as JobActionInput;
	const result = await runJobAction(input, p);
	assert.ok(result, "amend must record the scope addition");
	const journal = join(scratch.path, LAYOUT.runs, id, "task-addenda.jsonl");
	const first = readFileSync(journal, "utf8");
	writeFileSync(file, "Changed after approval.");
	await runJobAction({ ...input, task_file: undefined, text: "Also cover it in tests." }, p);
	const raw = readFileSync(journal, "utf8");
	assert.ok(raw.startsWith(first), "existing records are never rewritten");
	const records = raw.trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records.map(({ n, text, by }) => ({ n, text, by })), [
		{ n: 1, text: "Document the default.", by: "operator-quote" },
		{ n: 2, text: "Also cover it in tests.", by: "operator-quote" },
	]);
	assert.equal(records[0].source_path, file);
	assert.equal(records[0].quote, "also document the default");
	assert.equal(records[0].reason, "operator expanded coverage");
	assert.ok(Number.isFinite(Date.parse(records[0].added_at)));
	assert.ok(!JSON.stringify(result).includes("Document the default."), "tool results carry metadata, not the task body");
	await assert.rejects(runJobAction({ ...input, quote: "made up authorization" }, p), /quote not found in operator messages/);
	await assert.rejects(runJobAction(input, base), /quote not found in operator messages/);
	await runJobAction({ action: "close", job_id: id, reason: "finished" }, p);
	await assert.rejects(runJobAction(input, p), /closed/);
	assert.equal(readFileSync(journal, "utf8"), raw, "refusals append nothing");
	assert.equal(existsSync(join(scratch.path, LAYOUT.runs, id, "original-task.md")), false, "amendment never rewrites the original");
});

test("cp_job is forbidden to workers and exposes exactly the spec's actions", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_job"));
	assert.deepEqual(
		[...JOB_ACTIONS],
		["create", "show", "list", "ready", "blocked", "claim", "update", "comment", "amend", "dep_add", "dep_remove", "close", "drop"],
	);
});

test("create -> show -> list -> ready -> claim -> comment -> close through the action runner", async (t) => {
	const { ports: p } = ports(t);
	const created = await runJobAction({ action: "create", title: "fix it", project: "demo", delivery: "pr", kind: "ship" }, p);
	const id = (created.details.job as { id: string }).id;
	assert.match(id, /^cp-[a-z0-9]{4}$/);
	assert.match(created.text, new RegExp(`^created ${id}`));

	const shown = await runJobAction({ action: "show", job_id: id }, p);
	assert.match(shown.text, /fix it/);
	assert.match(shown.text, /project:demo/);

	const ready = await runJobAction({ action: "ready" }, p);
	assert.deepEqual((ready.details.jobs as Array<{ id: string }>).map((j) => j.id), [id]);

	const claimed = await runJobAction({ action: "claim", job_id: id }, p);
	assert.equal((claimed.details.job as { status: string }).status, "in_progress");
	await assert.rejects(runJobAction({ action: "claim", job_id: id }, p), /already in_progress .* cp_dispatch/);

	const commented = await runJobAction({ action: "comment", job_id: id, text: "blocker: waiting" }, p);
	assert.equal((commented.details.job as { comments: unknown[] }).comments.length, 1);

	const listed = await runJobAction({ action: "list", status: "in_progress" }, p);
	assert.match(listed.text, new RegExp(id));

	const closed = await runJobAction({ action: "close", job_id: id, reason: "merged: https://x/pr/1" }, p);
	assert.equal((closed.details.job as { status: string }).status, "closed");
	assert.deepEqual((await runJobAction({ action: "list" }, p)).details.jobs, []);
	assert.equal(((await runJobAction({ action: "list", all: true }, p)).details.jobs as unknown[]).length, 1);
});

test("conflicting and duplicate reserved labels refuse with no write or receipt; normal intake still dedupes", async (t) => {
	const { ports: base, scratch } = ports(t);
	const receipts: string[] = [];
	const p = { ...base, noteCreated: (id: string) => receipts.push(id) };
	const input = { action: "create", title: "safe", project: "demo", delivery: "local", kind: "research", risk: "low" } as const;
	for (const label of ["project:demo", "project:other", "delivery:local", "delivery:board", "kind:research", "kind:ship", "risk:low", "risk:high"]) {
		const before = readFileSync(scratch.ledger.file, "utf8");
		await assert.rejects(runJobAction({ ...input, labels: [label] }, p), /labels/);
		assert.equal(readFileSync(scratch.ledger.file, "utf8"), before);
	}
	assert.deepEqual(receipts, []);
	assert.deepEqual((await runJobAction({ action: "list" }, p)).details.jobs, []);
	const created = await runJobAction({ ...input, labels: ["phase:7"] }, p);
	const id = (created.details.job as { id: string }).id;
	const before = readFileSync(scratch.ledger.file, "utf8");
	await assert.rejects(runJobAction({ ...input, labels: ["delivery:board"] }, p), /labels/);
	assert.equal(readFileSync(scratch.ledger.file, "utf8"), before, "idempotent intake also validates extras before any receipt");
	assert.deepEqual(receipts, [id]);
	assert.equal((await runJobAction(input, p)).details.existing, true);
	assert.match((await runJobAction({ action: "list" }, p)).text, /safe/);
});

test("list marks legacy label faults and preserves search and narrow repair", async (t) => {
	const { ports: p, scratch } = ports(t);
	const good = await scratch.ledger.create({ title: "good", project: "demo", delivery: "local" });
	const bad = { ...good, id: "cp-legacy", title: "legacy", external_ref: "br show old --json", labels: [...good.labels, "delivery:board"] };
	const doc = scratch.document();
	doc.jobs.unshift(bad);
	writeFileSync(scratch.ledger.file, JSON.stringify(doc));
	const before = readFileSync(scratch.ledger.file, "utf8");
	const listed = await runJobAction({ action: "list", project: "demo" }, p);
	assert.match(listed.text, /legacy \[label error:/);
	assert.match(listed.text, /good/);
	assert.equal(scratch.ledger.findDuplicate({ title: "good", project: "demo" })?.id, good.id);
	assert.equal((await runJobAction({ action: "create", title: "good", project: "demo", delivery: "local" }, p)).details.existing, true);
	assert.equal(readFileSync(scratch.ledger.file, "utf8"), before, "read and duplicate lookup never rewrite legacy labels");
	await assert.rejects(runJobAction({ action: "create", title: "legacy", project: "demo", delivery: "local" }, p), /cp-legacy: label error/);
	await runJobAction({ action: "update", job_id: bad.id, remove_labels: ["delivery:board"] }, p);
	assert.doesNotMatch((await runJobAction({ action: "list" }, p)).text, /label error/);
});

test("riskkw-f10: cp_job create records risk as a label", async (t) => {
	const { ports: p } = ports(t);
	const input = { action: "create", title: "r", project: "demo", delivery: "pr", risk: "low" } as const;
	assert.equal(validate(JobActionSchema, input).ok, true);
	const created = await runJobAction(input, p);
	const job = created.details.job as { id: string; labels: string[] };
	assert.ok(job.labels.includes("risk:low"), job.labels.join(", "));
	assert.match(created.text, /risk: low recorded/);
	assert.match((await runJobAction({ action: "show", job_id: job.id }, p)).text, /risk:low/);
	await assert.rejects(runJobAction({ action: "update", job_id: job.id, risk: "high" } as JobActionInput, p), /risk is create only/);
	await assert.rejects(runJobAction({ ...input, risk: "high" }, p), /records risk:low; change it with cp_job update/);
	for (const again of [input, { action: "create", title: "r", project: "demo", delivery: "pr" } as const]) {
		const hit = await runJobAction(again, p);
		assert.equal((hit.details.job as { id: string }).id, job.id);
		assert.equal(hit.details.existing, true);
	}
});

test("a schedule: label is refused on create and update unless a parent-expanded schedule has a deferred anchor; fan-out create is idempotent", async (t) => {
	const { ports: p, scratch } = ports(t);
	const create: JobActionInput = { action: "create", title: "L1 [x]", project: "demo", delivery: "local", kind: "research", labels: ["schedule:sch-abc123"] };
	await assert.rejects(runJobAction(create, p), /cp_job create refused: .*schedule:sch-abc123/);
	await assert.rejects(runJobAction({ ...create, labels: ["schedule:nope"] }, p), /cp_job create refused: .*schedule:nope/);
	const plain = await runJobAction({ action: "create", title: "plain", project: "demo", delivery: "local", kind: "research" }, p);
	const plainId = (plain.details.job as { id: string }).id;
	await assert.rejects(runJobAction({ action: "update", job_id: plainId, add_labels: ["schedule:sch-abc123"] }, p), /cp_job update refused: .*schedule:sch-abc123/);
	// A parent-expanded schedule without an open anchor is still refused.
	const schedule = { id: "sch-abc123", name: "self-review", project: "demo", mandate_id: "md-abcd", trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" }, enabled: true, created_at: "2026-01-01T00:00:00Z" };
	mkdirSync(join(scratch.path, LAYOUT.state), { recursive: true });
	writeFileSync(join(scratch.path, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	await assert.rejects(runJobAction(create, p), /no open run of schedule sch-abc123/);
	const anchor = await scratch.ledger.create({ title: "Self-review (run now)", project: "demo", delivery: "local", kind: "research", labels: ["schedule:sch-abc123"] });
	await scratch.ledger.update(anchor.id, { status: "deferred" });
	const first = await runJobAction(create, p);
	const again = await runJobAction(create, p);
	assert.equal((again.details.job as { id: string }).id, (first.details.job as { id: string }).id);
	assert.equal(again.details.existing, true);
	await runJobAction({ action: "update", job_id: plainId, add_labels: ["schedule:sch-abc123"] }, p);
});

test("cp_job on a cp-org-pr-review run: risk:high from the label or the parameter counts against max_reviewers; an idempotent re-create past the cap returns the job", async (t) => {
	const { ports: p, scratch } = ports(t);
	const label = "schedule:sch-0a0b0c";
	const schedule = { id: "sch-0a0b0c", name: "org", project: "demo", mandate_id: "md-abcd", trigger: { type: "manual" }, job: { title: "Org review", kind: "research", delivery: "local", skill: "cp-org-pr-review", description: "org: acme\nmax_reviewers: 2" }, enabled: true, created_at: "2026-01-01T00:00:00Z" };
	mkdirSync(join(scratch.path, LAYOUT.state), { recursive: true });
	writeFileSync(join(scratch.path, LAYOUT.state, "schedules.json"), JSON.stringify({ schema_version: 1, schedules: [schedule] }));
	const anchor = await scratch.ledger.create({ title: "Org review (run now)", project: "demo", delivery: "local", kind: "research", labels: [label] });
	await scratch.ledger.update(anchor.id, { status: "deferred" });
	const job = (title: string, extra: Partial<JobActionInput> = {}): JobActionInput => ({ action: "create", title: `${title} [${anchor.id}]`, project: "demo", delivery: "local", kind: "research", labels: [label], ...extra } as JobActionInput);
	const id = (result: { details: Record<string, unknown> }) => (result.details.job as { id: string }).id;
	const r1 = id(await runJobAction(job("R1/2", { risk: "high" }), p));
	await runJobAction(job("R2/2", { labels: [label, "risk:high"] }), p); // the raw label, no risk parameter
	await assert.rejects(runJobAction(job("R3/2", { labels: [label, "risk:high"] }), p), /already has 2 reviewer job\(s\) \(max_reviewers 2\)/);
	await assert.rejects(runJobAction(job("R3/2", { risk: "high" }), p), /already has 2 reviewer job\(s\)/);
	const s1 = id(await runJobAction(job("S1"), p));
	await assert.rejects(runJobAction(job("extra"), p), /already has 3 job\(s\) \(max_reviewers 2 plus one synthesis\)/);
	// Past the cap, the same create is the same job (findDuplicate runs before the cap), with its risk unchanged.
	const again = await runJobAction(job("R1/2", { risk: "high" }), p);
	assert.deepEqual([id(again), again.details.existing], [r1, true]);
	assert.equal(id(await runJobAction(job("S1"), p)), s1);
	// Raising the synthesis to risk:high would make a third reviewer: refused; a no-op re-add on a reviewer is not.
	await assert.rejects(runJobAction({ action: "update", job_id: s1, add_labels: ["risk:high"] }, p), /cp_job update refused: .*already has 2 reviewer job\(s\)/);
	await runJobAction({ action: "update", job_id: r1, add_labels: ["risk:high"] }, p);
	await runJobAction({ action: "update", job_id: r1, remove_labels: ["risk:high"] }, p);
	await runJobAction({ action: "update", job_id: s1, add_labels: ["risk:high"] }, p);
});

test("intake: three-item list with one dep; re-run creates nothing", async (t) => {
	const created: string[] = [];
	const { ports: base, scratch } = ports(t);
	const p = {
		...base,
		noteCreated: (id: string) => {
			if (!created.includes(id)) created.push(id);
		},
	};
	const one = (await runJobAction({ action: "create", title: "one", project: "demo", delivery: "pr", kind: "ship" }, p)).details.job as { id: string };
	const two = (await runJobAction({ action: "create", title: "two", project: "demo", delivery: "local", kind: "research" }, p)).details.job as { id: string };
	const three = (
		await runJobAction(
			{ action: "create", title: "three", project: "demo", delivery: "pr", kind: "ship", external_ref: "br show cp-nz95 --json" },
			p,
		)
	).details.job as { id: string; external_ref?: string };
	await runJobAction({ action: "dep_add", job_id: three.id, blocker_id: one.id }, p);
	const listed = (await runJobAction({ action: "list" }, p)).details.jobs as Array<{ id: string; blocked_by: string[] }>;
	assert.equal(listed.length, 3);
	assert.deepEqual(
		listed.find((j) => j.id === three.id)?.blocked_by,
		[one.id],
	);
	assert.equal(three.external_ref, "br show cp-nz95 --json");
	assert.deepEqual(created, [one.id, two.id, three.id]);

	const againOne = await runJobAction({ action: "create", title: "One", project: "demo", delivery: "pr", kind: "ship" }, p);
	const againTwo = await runJobAction({ action: "create", title: "two", project: "demo", delivery: "local", kind: "research" }, p);
	const againThree = await runJobAction(
		{ action: "create", title: "other title", project: "demo", delivery: "pr", external_ref: "br show cp-nz95 --json" },
		p,
	);
	assert.equal((againOne.details.job as { id: string }).id, one.id);
	assert.equal(againOne.details.existing, true);
	assert.equal((againTwo.details.job as { id: string }).id, two.id);
	assert.equal((againThree.details.job as { id: string }).id, three.id);
	assert.equal(scratch.document().jobs.length, 3);
	assert.equal(((await runJobAction({ action: "blocked" }, p)).details.jobs as unknown[]).length, 1);
});

test("cp_job script create dedupes only identical actions and shows the declaration", async (t) => {
	const { ports: p, scratch } = ports(t);
	const input = { action: "create", title: "run", project: "demo", kind: "ship", delivery: "local", script_path: "scripts/run.sh" } as const;
	const created = await runJobAction(input, p);
	assert.deepEqual((created.details.job as { script: unknown }).script, { path: "scripts/run.sh" });
	assert.match((await runJobAction({ action: "show", job_id: (created.details.job as { id: string }).id }, p)).text, /script:\s+scripts\/run.sh/);
	assert.equal((await runJobAction(input, p)).details.existing, true);
	for (const changed of [{ script_path: "scripts/other.sh" }, { script_path: undefined }, { kind: "research" as const }]) {
		await assert.rejects(runJobAction({ ...input, ...changed }, p), /different action|ship.*local/i);
	}
	await assert.rejects(runJobAction({ ...input, title: "other", external_ref: "ENG-1", script_path: "../bad.sh" }, p), /script path/i);
	const refJob = await runJobAction({ ...input, title: "other", external_ref: "ENG-1" }, { ...p, verifyRef: async () => ({ status: "unverifiable" }) });
	assert.deepEqual((refJob.details.job as { script: unknown }).script, { path: "scripts/run.sh" });
	await assert.rejects(runJobAction({ ...input, title: "new title", external_ref: "ENG-1", script_path: "scripts/different.sh" }, p), /different action/i);
	assert.equal(scratch.document().jobs.length, 2);
	await assert.rejects(runJobAction({ action: "show", job_id: (created.details.job as { id: string }).id, script_path: "scripts/run.sh" }, p), /create only/i);
});

test("cp_job create stores a non-url external_ref and show prints it as the ref line", async (t) => {
	const { ports: p } = ports(t);
	const created = await runJobAction(
		{ action: "create", title: "port the thing", project: "demo", delivery: "pr", external_ref: "br show cp-nz95 --json" },
		p,
	);
	const id = (created.details.job as { id: string }).id;
	const shown = await runJobAction({ action: "show", job_id: id }, p);
	assert.match(shown.text, /ref:\s+br show cp-nz95 --json/);
	assert.ok(!shown.text.includes("priority:"), "the detail no longer has a priority line");
});

test("refusals at the boundary: pipeline/answer deliveries, a live worker on close/drop, missing arguments", async (t) => {
	const live = new Set<string>();
	const { ports: p } = ports(t, live);
	await assert.rejects(runJobAction({ action: "create", title: "x", project: "demo", delivery: "pipeline" }, p), /cp_pipeline start/);
	await assert.rejects(runJobAction({ action: "create", title: "x", project: "demo", delivery: "answer" }, p), /cp_ask/);
	const created = await runJobAction({ action: "create", title: "x", project: "demo", delivery: "pr" }, p);
	const id = (created.details.job as { id: string }).id;
	live.add(id);
	await assert.rejects(runJobAction({ action: "close", job_id: id, reason: "r" }, p), /a worker holds this job; cp_teardown/);
	await assert.rejects(runJobAction({ action: "drop", job_id: id, reason: "r" }, p), /a worker holds this job; cp_teardown/);
	live.delete(id);
	await assert.rejects(runJobAction({ action: "close", job_id: id } as JobActionInput, p), /cp_job close needs reason/);
	await assert.rejects(runJobAction({ action: "show" } as JobActionInput, p), /cp_job show needs job_id/);
	await assert.rejects(runJobAction({ action: "dep_add", job_id: id } as JobActionInput, p), /cp_job dep_add needs blocker_id/);
	const dropped = await runJobAction({ action: "drop", job_id: id, reason: "not needed" }, p);
	assert.equal((dropped.details.job as { close_reason: string }).close_reason, "dropped: not needed");
});

test("dependencies through the runner: dep_add gates ready, blocked lists blockers, dep_remove frees", async (t) => {
	const { ports: p } = ports(t);
	const a = (await runJobAction({ action: "create", title: "a", project: "demo", delivery: "pr" }, p)).details.job as { id: string };
	const b = (await runJobAction({ action: "create", title: "b", project: "demo", delivery: "pr" }, p)).details.job as { id: string };
	await runJobAction({ action: "dep_add", job_id: b.id, blocker_id: a.id }, p);
	assert.deepEqual(((await runJobAction({ action: "ready" }, p)).details.jobs as Array<{ id: string }>).map((j) => j.id), [a.id]);
	const blocked = await runJobAction({ action: "blocked" }, p);
	assert.deepEqual(blocked.details.jobs, [{ id: b.id, blockers: [a.id] }]);
	assert.match(blocked.text, new RegExp(`${b.id}.*blocked by ${a.id}`));
	await runJobAction({ action: "dep_remove", job_id: b.id, blocker_id: a.id }, p);
	assert.deepEqual((await runJobAction({ action: "blocked" }, p)).details.jobs, []);
	const updated = await runJobAction({ action: "update", job_id: b.id, status: "deferred", add_labels: ["phase:7"] }, p);
	assert.equal((updated.details.job as { status: string }).status, "deferred");
});

test("issue #2: dep_remove refuses a blocker whose worker never reported, warns on an open one", async (t) => {
	const reports = new Map<string, "reported" | "unreported" | "none">();
	const { ports: p } = ports(t, new Set(), reports);
	const create = async (title: string) => ((await runJobAction({ action: "create", title, project: "demo", delivery: "pr" }, p)).details.job as { id: string }).id;
	const a = await create("a");
	const b = await create("b");
	await runJobAction({ action: "dep_add", job_id: b, blocker_id: a }, p);

	reports.set(a, "unreported");
	await assert.rejects(runJobAction({ action: "dep_remove", job_id: b, blocker_id: a }, p), /dep_remove refused: .* filed no report/);
	assert.deepEqual((await runJobAction({ action: "blocked" }, p)).details.jobs, [{ id: b, blockers: [a] }]);

	reports.set(a, "none");
	const freed = await runJobAction({ action: "dep_remove", job_id: b, blocker_id: a }, p);
	assert.match(freed.text, /warning: .* still open and was never dispatched/);
	assert.ok((freed.details as { warning?: string }).warning);

	const c = await create("c");
	const d = await create("d");
	await runJobAction({ action: "dep_add", job_id: d, blocker_id: c }, p);
	await runJobAction({ action: "close", job_id: c, reason: "done" }, p);
	reports.set(c, "unreported");
	const closed = await runJobAction({ action: "dep_remove", job_id: d, blocker_id: c }, p);
	assert.equal((closed.details as { warning?: string }).warning, undefined);
	assert.doesNotMatch(closed.text, /warning/);
});

test("parseJobsArgs: ready by default, list flags, show needs an id, import-beads", () => {
	assert.deepEqual(parseJobsArgs(""), { kind: "ready" });
	assert.deepEqual(parseJobsArgs("ready --project demo"), { kind: "ready", project: "demo" });
	assert.deepEqual(parseJobsArgs("list --all --status closed --project demo"), { kind: "list", all: true, status: "closed", project: "demo" });
	assert.deepEqual(parseJobsArgs("list"), { kind: "list", all: false });
	assert.deepEqual(parseJobsArgs("show cp-a1b2"), { kind: "show", jobId: "cp-a1b2" });
	assert.deepEqual(parseJobsArgs("import-beads"), { kind: "import-beads" });
	assert.throws(() => parseJobsArgs("show"), /needs a job id/);
	assert.throws(() => parseJobsArgs("list --status bogus"), /--status must be one of/);
	assert.throws(() => parseJobsArgs("frobnicate"), /usage: \/cp-jobs/);
});

test("formatJobLine is one line: id, status, project, delivery/kind, title", () => {
	const line = formatJobLine({
		id: "cp-a1b2",
		title: "fix the thing",
		status: "open",
		labels: ["project:demo", "delivery:pr", "kind:ship"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T10:00:00Z",
		updated_at: "2026-09-04T10:00:00Z",
	});
	assert.match(line, /^cp-a1b2\s+open\s+demo\s+pr\/ship\s+fix the thing$/);
	assert.ok(!line.includes("\n"));
});

test("portsFor's hasLiveWorker: launching has no worker; waiting/held do, done/failed do not", (t) => {
	const { scratch } = ports(t);
	const live: Record<string, string | undefined> = {
		"cp-waiting": "waiting",
		"cp-held": "held",
		"cp-done": "done",
		"cp-failed": "failed",
	};
	const fakePost = {
		ledger: () => scratch.ledger,
		escalations: new EscalationStore({ home: scratch.path }),
		fleet: { get: (id: string) => (live[id] ? { phase: live[id] } : undefined) },
	} as never;
	const p = portsFor(fakePost, MULTI_RUNTIME);
	assert.deepEqual(
		JOB_PHASES.map((phase) => p.hasLiveWorker(`cp-${phase}`)),
		[false, true, true, false, false],
		"launching has no process; waiting and held hold one; done and failed do not",
	);
	assert.equal(p.hasLiveWorker("cp-never-dispatched"), false, "no fleet record at all is not a live worker");
});

test("registerJobs wires cp_job and /cp-jobs to the same ledger", async (t) => {
	const { scratch } = ports(t);
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: ExtensionContext) => Promise<{ content: Array<{ text: string }> }> }>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		registerTool: (spec: { name: string }) => tools.set(spec.name, spec as never),
		registerCommand: (name: string, spec: unknown) => commands.set(name, spec as never),
	} as unknown as ExtensionAPI;
	const emitted: string[] = [];
	const fakePost = {
		ledger: () => scratch.ledger,
		escalations: new EscalationStore({ home: scratch.path }),
		fleet: { get: () => undefined },
	};
	registerJobs(pi, {
		commandPost: () => fakePost as never,
		runtime: () => MULTI_RUNTIME,
		emit: (_ctx, _source, text) => {
			emitted.push(text);
		},
	});
	assert.ok(tools.has("cp_job"));
	assert.ok(commands.has("cp-jobs"));

	const entries: unknown[] = [
		{ type: "message", message: { role: "toolResult", content: "approve this amendment" } },
		{ type: "custom_message", message: { role: "user", content: "approve this amendment" } },
	];
	const ctx = { modelRegistry: undefined, hasUI: false, sessionManager: { getEntries: () => entries } } as unknown as ExtensionContext;
	const result = await tools.get("cp_job")!.execute("t1", { action: "create", title: "via tool", project: "demo", delivery: "local" }, new AbortController().signal, () => {}, ctx);
	assert.match(result.content[0]?.text ?? "", /^created cp-/);
	const id = scratch.document().jobs[0]!.id;
	const amendment = { action: "amend", job_id: id, text: "New coverage.", quote: "approve this amendment", reason: "operator expanded scope" };
	assert.equal(validate(JobActionSchema, amendment).ok, true);
	const amend = () => tools.get("cp_job")!.execute("t2", amendment, new AbortController().signal, () => {}, ctx);
	await assert.rejects(amend(), /quote not found in operator messages/);
	entries.push({ type: "message", message: { role: "user", content: "approve this amendment" } });
	assert.match((await amend()).content[0]?.text ?? "", /addendum 1 by operator-quote/);

	await commands.get("cp-jobs")!.handler("", ctx);
	assert.match(emitted[0] ?? "", /via tool/, "the command reads what the tool wrote");
	await commands.get("cp-jobs")!.handler("import-beads", ctx);
	assert.match(emitted[1] ?? "", /no \.beads\/issues\.jsonl under/, "a home without .beads/ is told so, not crashed");
});

test("create resolves project through the runtime: required", async (t) => {
	const multi = ports(t);
	await assert.rejects(runJobAction({ action: "create", title: "x", delivery: "pr" }, multi.ports), /needs `project`/);
	const created = await runJobAction({ action: "create", title: "x", project: "demo", delivery: "pr" }, multi.ports);
	assert.ok((created.details.job as { labels: string[] }).labels.includes("project:demo"));
});

test("the cp_job schema refuses the retired type and priority arguments, on create and on update", () => {
	// CHANGELOG.md claims cp_job create/update no longer accept these. An open
	// schema would accept the call and drop the field silently, which is the
	// trap: the caller believes it stuck. The schema is closed, so it refuses.
	const create = { action: "create", title: "t", project: "demo", delivery: "pr" };
	const update = { action: "update", job_id: "cp-a", status: "deferred" };
	assert.equal(validate(JobActionSchema, create).ok, true, "the supported create shape still validates");
	assert.equal(validate(JobActionSchema, update).ok, true, "the supported update shape still validates");
	for (const [what, base] of [["create", create], ["update", update]] as const) {
		for (const retired of [{ type: "epic" }, { priority: 2 }, { type: "task", priority: 0 }]) {
			const result = validate(JobActionSchema, { ...base, ...retired });
			assert.equal(result.ok, false, `${what} accepted ${JSON.stringify(retired)}`);
			if (result.ok) continue;
			// typebox names the fault structurally, not per key: the point this pins
			// is that the call is refused rather than accepted-and-ignored.
			assert.ok(
				result.errors.some((error) => /additional propert/i.test(error)),
				`${what}: refused for the wrong reason: ${result.errors.join(" | ")}`,
			);
		}
	}
	assert.equal(validate(JobActionSchema, { ...create, nonsense: 1 }).ok, false, "any unnamed argument is a refusal, not a silent drop");
});

test("create verifies the selected project's pinned database before recording array beads", async (t) => {
	const { ports: p, scratch } = ports(t);
	const db = join(scratch.path, "selected project", ".beads", "beads.db");
	p.ledger = new Ledger({ home: scratch.path, beadsDbFor: (project) => project === "demo" ? db : undefined });
	let state = "closed";
	const verifyRef = (ref: string) => verifyExternalRef(ref, {
		cwd: "/wrong-project",
		exec: async (_command, args) => {
			assert.deepEqual(args, ["--db", db, "--no-auto-flush", "--no-auto-import", "show", "cp-array", "--json"]);
			return JSON.stringify([{ title: "Array bead", status: state }]);
		},
	});
	const input = { action: "create", title: "array", project: "demo", delivery: "pr", external_ref: "br show cp-array --json" } as const;
	await assert.rejects(runJobAction(input, { ...p, verifyRef }), /closed.*Array bead/);
	assert.equal((await p.ledger.list()).length, 0);
	assert.equal(p.escalations().list().length, 1);
	state = "open";
	const result = await runJobAction(input, { ...p, verifyRef });
	assert.match((result.details.job as { notes: string }).notes, /verified: br open/);
});

test("a bare ref is not pinned to or verified against the home database, while explicit pins win", async (t) => {
	const { ports: p, scratch } = ports(t);
	mkdirSync(join(scratch.path, ".beads"));
	writeFileSync(join(scratch.path, ".beads", "beads.db"), "");
	p.ledger = new Ledger({ home: scratch.path, beadsDbFor: () => undefined });
	const ref = "br show cp-home --json";
	let verified = 0;
	const result = await runJobAction({ action: "create", title: "home", project: "demo", delivery: "pr", external_ref: ref }, {
		...p, verifyRef: async (resolved) => {
			verified++;
			return { status: "found", kind: "br", state: "open", title: "Home", url: resolved };
		},
	});
	assert.equal(verified, 0, "no br call against the home (or cwd) database");
	assert.equal((result.details.job as { external_ref: string }).external_ref, ref);
	assert.match((result.details.job as { notes: string }).notes, /no beads database is configured for project demo/);
	assert.equal(p.ledger.normalizeRef("br --db '/explicit/beads.db' show cp-home --json", "demo"), "br --db '/explicit/beads.db' show cp-home --json");
	const projectLedger = new Ledger({ home: scratch.path, beadsDbFor: () => "/project/beads.db" });
	assert.equal(projectLedger.normalizeRef(ref, "demo"), "br --db '/project/beads.db' show cp-home --json");
});

// -- external_ref verification (pi-command-post-autonomy-programme-cur.4.5) ------------------

test("cp_job create refuses a merged-PR ref at an issue url, and two bad refs in one project escalate once", async (t) => {
	const { ports: p } = ports(t);
	const mergedPr = async () =>
		({ status: "found", kind: "pr", state: "merged", title: "landed already", url: "https://github.com/o/example-infra/issues/12" }) as const;
	await assert.rejects(
		runJobAction(
			{ action: "create", title: "fix #12", project: "demo", delivery: "pr", external_ref: "https://github.com/o/example-infra/issues/12" },
			{ ...p, verifyRef: mergedPr },
		),
		/refused.*pr.*merged.*landed already/is,
	);
	const mergedPr2 = async () =>
		({ status: "found", kind: "pr", state: "merged", title: "also landed", url: "https://github.com/o/example-infra/issues/14" }) as const;
	await assert.rejects(
		runJobAction(
			{ action: "create", title: "fix #14", project: "demo", delivery: "pr", external_ref: "https://github.com/o/example-infra/issues/14" },
			{ ...p, verifyRef: mergedPr2 },
		),
		/refused/,
	);
	assert.deepEqual((await runJobAction({ action: "list", all: true }, p)).details.jobs, [], "zero jobs were recorded for either bad ref");
	const open = p.escalations().open();
	assert.equal(open.length, 1, "one escalation, not two");
	assert.equal(open[0]?.kind, "conflicting_acceptance");
	assert.match(open[0]?.question ?? "", /issues\/12/);
	assert.match(open[0]?.question ?? "", /issues\/14/);
	assert.match(open[0]?.question ?? "", /landed already/);
	assert.match(open[0]?.question ?? "", /also landed/);
});

test("cp_job create: an open issue ref creates the job as today, with the verified fact as a note", async (t) => {
	const { ports: p } = ports(t);
	const openIssue = async () =>
		({ status: "found", kind: "issue", state: "open", title: "real bug", url: "https://github.com/o/r/issues/9" }) as const;
	const created = await runJobAction(
		{ action: "create", title: "fix #9", project: "demo", delivery: "pr", external_ref: "https://github.com/o/r/issues/9" },
		{ ...p, verifyRef: openIssue },
	);
	const job = created.details.job as { status: string; notes?: string };
	assert.equal(job.status, "open");
	assert.match(job.notes ?? "", /issue open "real bug"/);
	assert.equal(p.escalations().open().length, 0);
});

test("cp_job create: gh unreachable records a note and proceeds, no refusal", async (t) => {
	const { ports: p } = ports(t);
	const unreachable = async () => ({ status: "unreachable", message: "connect ETIMEDOUT" }) as const;
	const created = await runJobAction(
		{ action: "create", title: "fix #9", project: "demo", delivery: "pr", external_ref: "https://github.com/o/r/issues/9" },
		{ ...p, verifyRef: unreachable },
	);
	const job = created.details.job as { status: string; notes?: string };
	assert.equal(job.status, "open");
	assert.match(job.notes ?? "", /could not be verified.*ETIMEDOUT/is);
	assert.equal(p.escalations().open().length, 0);
});

test("cp_job create: a br show ref with status closed refuses", async (t) => {
	const { ports: p } = ports(t);
	const ref = "br --db '/project/.beads/beads.db' show cp-1 --json";
	const closedBeads = async () => ({ status: "found", kind: "br", state: "closed", title: "already done", url: ref }) as const;
	await assert.rejects(
		runJobAction(
			{ action: "create", title: "redo it", project: "demo", delivery: "pr", external_ref: ref },
			{ ...p, verifyRef: closedBeads },
		),
		/closed.*already done/is,
	);
	assert.deepEqual((await runJobAction({ action: "list", all: true }, p)).details.jobs, []);
});

test("picp-t4n: an answered legacy override admits only its deferred bead and records the es", async (t) => {
	const { ports: p, scratch } = ports(t);
	const ref = "br --db '/project/.beads/beads.db' show picp-80q --json";
	const input = { action: "create", title: "parent-context plan", project: "demo", delivery: "local", kind: "research", external_ref: ref } as const;
	let state = "deferred";
	const verifyRef = (url: string) => verifyExternalRef(url, { exec: async (command, args) => {
		assert.equal(command, "br");
		assert.deepEqual(args, ["--db", "/project/.beads/beads.db", "--no-auto-flush", "--no-auto-import", "show", "picp-80q", "--json"]);
		return JSON.stringify([{ status: state, title: "Parent context" }]);
	} });
	const overrides = p.escalations();
	const es = await overrides.raise({
		job_ids: ["verify-demo"], kind: "conflicting_acceptance",
		question: `external_ref check failed — ${ref}: ${ref} is deferred, not open: "Parent context"`,
		options: [{ id: "override", label: "override", consequence: "admit this bead", cost: "operator accepts deferral" }], recommended: "override",
	});
	await overrides.answer(es.id, { answer: "override", by: "operator-quote", basis: { operator_quote: `${es.id}: override.` } });
	const answered = overrides.get(es.id);
	// A deferred approval cannot authorize the same bead after it closes.
	state = "closed";
	await assert.rejects(runJobAction(input, { ...p, verifyRef }), /closed, not open/);
	state = "deferred";
	const result = await runJobAction(input, { ...p, verifyRef });
	const job = result.details.job as { id: string; status: string; external_ref: string; notes: string; tracker?: unknown };
	assert.equal(job.status, "open");
	assert.equal(job.external_ref, ref);
	assert.equal(job.tracker, undefined);
	assert.match(job.notes, /verified: br deferred/);
	assert.ok(job.notes.includes(`deferred-bead admission override: ${es.id}`));
	assert.deepEqual(overrides.get(es.id), answered, "admission never rewrites the answered escalation");
	assert.equal(state, "deferred", "the tracker is read only");
	assert.equal((await runJobAction(input, { ...p, verifyRef })).details.existing, true);
});

test("picp-t4n: aggregated overrides bind exact pinned deferred refs, never another bead, DB, project or mismatch", async (t) => {
	const { ports: p, scratch } = ports(t);
	const db = "/project/beads.db";
	p.ledger = new Ledger({ home: scratch.path, knownProjects: ["demo"], beadsDbFor: () => db });
	const refs = ["br show picp-80q --json", "br show picp-other --json"];
	const input = { action: "create", title: "plan", project: "demo", delivery: "local", kind: "research" } as const;
	const verifyRef = async (url: string) => ({ status: "found", kind: "br", state: "deferred", title: "Deferred bead", url }) as const;
	const create = (external_ref: string) => runJobAction({ ...input, title: external_ref, external_ref }, { ...p, verifyRef });
	for (const ref of [...refs, refs[0]!]) await assert.rejects(create(ref), /deferred, not open/);
	const store = p.escalations();
	const es = store.open()[0]!;
	assert.equal(store.open().length, 1);
	assert.deepEqual(es.deferred_refs, refs.map((ref) => p.ledger.normalizeRef(ref, "demo")));
	await store.answer(es.id, { answer: "override", by: "operator-quote", basis: { operator_quote: `${es.id}: override.` } });
	for (const external_ref of ["br show picp-80q-extra --json", "br --db '/other/beads.db' show picp-80q --json"]) {
		await assert.rejects(create(external_ref), /deferred, not open/);
	}
	await assert.rejects(runJobAction({ ...input, project: "other", external_ref: refs[0] }, { ...p, verifyRef }), /deferred, not open/);
	for (const verification of [
		{ status: "found", kind: "br", state: "closed", title: "Closed bead", url: refs[0]! },
		{ status: "found", kind: "pr", state: "merged", title: "Landed", url: "https://github.com/o/r/issues/12" },
		{ status: "not_found", url: "/missing.md" },
	] as const) {
		await assert.rejects(runJobAction({ ...input, external_ref: verification.url }, { ...p, verifyRef: async () => verification }), /cp_job create refused/);
	}
	// An override grants no delivery, schedule, script, label or archived-project exception.
	for (const change of [{ delivery: "pipeline" }, { delivery: "answer" }, { labels: ["schedule:sch-abc123"] }, { script_path: "../bad.sh" }, { labels: ["bad,label"] }]) {
		await assert.rejects(runJobAction({ ...input, external_ref: refs[0], ...change } as JobActionInput, { ...p, verifyRef }), /pipeline|answer|schedule|script|label/);
	}
	const archived = new Ledger({ home: scratch.path, knownProjects: ["demo"], archivedProjects: ["demo"], beadsDbFor: () => db });
	await assert.rejects(runJobAction({ ...input, external_ref: refs[0] }, { ...p, ledger: archived, verifyRef }), /archived/);
	assert.equal(scratch.document().jobs.length, 0, "all gates refuse before creating any job");
	for (const ref of refs) {
		const result = await create(ref);
		const job = result.details.job as { external_ref: string; notes: string };
		assert.equal(job.external_ref, p.ledger.normalizeRef(ref, "demo"));
		assert.ok(job.notes.includes(`deferred-bead admission override: ${es.id}`));
	}
	assert.equal(scratch.document().jobs.length, 2);
});

test("picp-t4n: a capped question cannot authorize an undisclosed deferred ref", async (t) => {
	const { ports: p, scratch } = ports(t);
	let title = "x".repeat(450);
	const verifyRef = async (url: string) => ({ status: "found", kind: "br", state: "deferred", title, url }) as const;
	const create = (id: string) => runJobAction({ action: "create", title: id, project: "demo", delivery: "local", external_ref: `br --db '/project/beads.db' show ${id} --json` }, { ...p, verifyRef });
	for (const id of ["picp-one", "picp-two"]) await assert.rejects(create(id), /deferred, not open/);
	const store = p.escalations();
	const open = store.open();
	assert.equal(open.length, 2, "each complete refusal gets a question when aggregation would truncate it");
	for (const es of open) {
		assert.equal(es.deferred_refs?.length, 1);
		assert.ok(es.question.endsWith(`"${title}"`));
		await store.answer(es.id, { answer: "override", by: "operator-quote" });
	}
	await create("picp-one");
	await create("picp-two");
	title = "x".repeat(1100);
	await assert.rejects(create("picp-long"), /deferred, not open/);
	const capped = store.open()[0]!;
	assert.equal(capped.question.length, 1000);
	assert.equal(capped.deferred_refs, undefined, "an incomplete refusal records no authority-bearing ref");
	await store.answer(capped.id, { answer: "override", by: "operator-quote" });
	await assert.rejects(create("picp-long"), /deferred, not open/);
	assert.equal(scratch.document().jobs.length, 2);
});

test("picp-t4n: only an answered override on this admission escalation counts", async (t) => {
	for (const disposition of ["open", "relay", "withdrawn", "superseded", "wrong-kind", "wrong-anchor", "legacy-substring", "legacy-unpinned"]) {
		await t.test(disposition, async (t) => {
			const { ports: p, scratch } = ports(t);
			const ref = disposition === "legacy-unpinned" ? "br show picp-80q --json" : "br --db '/project/beads.db' show picp-80q --json";
			if (disposition === "legacy-unpinned") p.ledger = new Ledger({ home: scratch.path, beadsDbFor: () => "/new-project/beads.db" });
			const mismatch = `${ref} is deferred, not open: "Bead"`;
			const store = p.escalations();
			const es = await store.raise({
				job_ids: [disposition === "wrong-anchor" ? "verify-other" : "verify-demo"],
				kind: disposition === "wrong-kind" ? "plan_approval" : "conflicting_acceptance",
				question: disposition === "legacy-substring" ? `different question; external_ref check failed — ${ref}: ${mismatch}` : `external_ref check failed — ${ref}: ${mismatch}`,
				...(disposition.startsWith("legacy-") ? {} : { deferred_refs: [ref] }),
				options: [{ id: "relay", label: "relay", consequence: "refuse", cost: "none" }, { id: "override", label: "override", consequence: "admit", cost: "operator accepts deferral" }], recommended: "relay",
			});
			if (disposition === "withdrawn") await store.withdraw(es.id);
			else if (disposition === "superseded") store.supersede(() => "replaced");
			else if (disposition !== "open") await store.answer(es.id, { answer: disposition === "relay" ? "relay" : "override", by: "operator-quote" });
			await assert.rejects(runJobAction({ action: "create", title: "plan", project: "demo", delivery: "local", external_ref: ref }, {
				...p, verifyRef: async (url) => ({ status: "found", kind: "br", state: "deferred", title: "Bead", url }),
			}), /deferred, not open/);
			assert.equal(scratch.document().jobs.length, 0);
		});
	}
});

test("cp_job create auto-links a job whose br ref names a bead on the active connection, and says why otherwise (laf)", async (t) => {
	const { ports: p } = ports(t);
	const conn = { id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" } as const;
	const found = async (url: string) => ({ status: "found", kind: "br", state: "open", title: "bead", url }) as const;
	const linked = await runJobAction(
		{ action: "create", title: "fix b-1", project: "demo", kind: "ship", delivery: "pr", external_ref: "br --db '/dbs/demo.db' show b-1 --json" },
		{ ...p, trackers: () => [conn], verifyRef: found },
	);
	assert.equal((linked.details.job as { tracker?: { item_id: string } }).tracker?.item_id, "b-1");
	assert.match(linked.text, /tracker: linked to demo-beads\/b-1/);
	const again = await runJobAction(
		{ action: "create", title: "fix b-1", project: "demo", kind: "ship", delivery: "pr", external_ref: "br --db '/dbs/demo.db' show b-1 --json" },
		{ ...p, trackers: () => [conn], verifyRef: found },
	);
	assert.match(again.text, /tracker: linked to demo-beads\/b-1/, "the idempotent hit reports the link it already has");
	const url = await runJobAction(
		{ action: "create", title: "fix 9", project: "demo", delivery: "pr", external_ref: "https://github.com/o/r/issues/9" },
		{ ...p, trackers: () => [conn], verifyRef: async () => ({ status: "found", kind: "issue", state: "open", title: "bug", url: "https://github.com/o/r/issues/9" }) as const },
	);
	assert.match(url.text, /tracker: not linked to a tracker bead: external_ref is not a br show command/);
	assert.equal((url.details.job as { tracker?: unknown }).tracker, undefined);
});
