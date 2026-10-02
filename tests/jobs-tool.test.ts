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

function ports(t: { after(fn: () => void): void }, live: Set<string> = new Set()) {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	return {
		scratch,
		ports: {
			ledger: scratch.ledger,
			escalations: () => new EscalationStore({ home: scratch.path }),
			hasLiveWorker: (id: string) => live.has(id),
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
