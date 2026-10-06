/**
 * S2: `cp_schedule run_now` fires a schedule only on one verbatim operator sentence that names it, from the session that
 * holds the parent lock, once per source message. The real host (registerScheduleTools), a real ledger, grant and scheduler.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerScheduleTools } from "../extensions/command-post/tools-schedule.ts";
import { isoTimestamp } from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import type { Ledger } from "../src/ledger.ts";
import { MandateStore } from "../src/mandate.ts";
import { sendMarker } from "../src/parent-outbox.ts";
import { Scheduler } from "../src/scheduler.ts";
import { createScratchHome, createScratchLedger } from "./harness/index.ts";

type Execute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;

async function bench(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const ledger = createScratchLedger({ knownProjects: ["demo"], home: home.path }).ledger as Ledger;
	const mandates = new MandateStore(home.path);
	const grant = mandates.issue({ projects: ["demo"], objective: "nightly", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 100, tokens: 1_000_000 }, job_cap: 10, schedule_grant: true });
	const fleet = new FleetStore({ home: home.path });
	const scheduler = new Scheduler({ home: home.path, ledger: () => ledger, mandates, usageJobs: () => fleet.read().jobs, cloneOf: () => home.path });
	const schedule = await scheduler.add({ name: "nightly", project: "demo", mandate_id: grant.id, manual: true, title: "Nightly fix", kind: "ship", delivery: "pr" });
	const post = { home: home.path, ledger: () => ledger, mandates, fleet, registry: { pathOf: () => home.path, archivedNames: () => [], get: (name: string) => (name === "demo" ? {} : undefined) }, dispatchQueue: { drain: async () => {} } };
	const lock = { held: true };
	const sent: Array<{ customType: string; content: string }> = [];
	let execute: Execute | undefined;
	registerScheduleTools(
		{ on: () => {}, registerTool: (tool: { name: string; execute: Execute }) => { if (tool.name === "cp_schedule") execute = tool.execute; }, sendMessage: (message: { customType: string; content: string }) => sent.push(message) } as never,
		{ commandPost: () => post, setLive: () => {} } as never,
		() => lock.held, () => {}, () => {},
	);
	const said: string[] = [];
	const run = async (quote: string, id = schedule.id, call = "call-1") => {
		const ctx = { sessionManager: { getEntries: () => said.map((content) => ({ type: "message", message: { role: "user", content } })) } };
		return (await execute!(call, { action: "run_now", id, operator_quote: quote }, undefined, undefined, ctx)).content[0]!.text;
	};
	const jobs = () => ledger.list({ labels: [`schedule:${schedule.id}`], all: true });
	const call = async (params: Record<string, unknown>, id = "call-x") => {
		const ctx = { sessionManager: { getEntries: () => said.map((content) => ({ type: "message", message: { role: "user", content } })) } };
		return (await execute!(id, params, undefined, undefined, ctx)).content[0]!.text;
	};
	return { ledger, mandates, scheduler, schedule, lock, said, run, call, jobs, sent };
}

test("run_now fires on a verified quote naming the schedule, records it verbatim, and refuses a replay of the same message", async (t) => {
	const { ledger, schedule, said, run, jobs, sent } = await bench(t);
	const quote = `Run ${schedule.id} now.`;
	said.push(`Please. ${quote}`);
	const text = await run(quote);
	assert.match(text, new RegExp(`schedule nightly \\(${schedule.id}\\) fired: created cp-\\S+ .*run now via cp_schedule on a verified operator quote \\(call-1\\)`));
	const [job] = await jobs();
	assert.ok(job);
	assert.match(job.notes ?? "", new RegExp(`run now via cp_schedule \\(call-1\\) for ${schedule.id} \\(nightly\\).*authorized by operator-quote; run-now quote sha [0-9a-f]{12}$`));
	const sha = /run-now quote sha ([0-9a-f]{12})/.exec(job.notes ?? "")![1];
	assert.deepEqual(job.comments.map((comment) => comment.text), [`run-now quote sha ${sha}: ${quote}`]);
	assert.equal(sent.length, 1, "a pr fire wakes the parent like any other fire");
	assert.equal(sent[0]!.customType, "cp-schedule");

	// (d) the same source message never authorizes a second run now, even after the first fire closed.
	await ledger.close(job.id, "done");
	assert.match(await run(quote, schedule.id, "call-2"), new RegExp(`skipped: run now not recorded: the operator message behind this quote already authorized run now ${job.id}`));
	assert.equal((await jobs()).length, 1, "no job created");
	// A new operator message naming the schedule (by name) does.
	said.push("Fire the nightly schedule again, please.");
	assert.match(await run("Fire the nightly schedule again, please.", schedule.id, "call-3"), /fired: created cp-/);
	assert.equal((await jobs()).length, 2);
});

test("run_now refusals are each named and create no job", async (t) => {
	const { scheduler, schedule, lock, said, run, jobs } = await bench(t);
	said.push(`Run ${schedule.id} now.`, "Go ahead with it.");
	// (b) not in any operator message
	await assert.rejects(run(`Run ${schedule.id} immediately.`), /quote not found/);
	// (c) verbatim, but names neither the id nor the name
	await assert.rejects(run("Go ahead with it."), new RegExp(`the quote names neither ${schedule.id} nor "nightly"`));
	// S3 amendment: the name only inside a longer word names nothing (whole tokens only)
	said.push("Run the nightlyish check now.");
	await assert.rejects(run("Run the nightlyish check now."), new RegExp(`the quote names neither ${schedule.id} nor "nightly"`));
	// (e) the session does not hold the parent lock
	lock.held = false;
	await assert.rejects(run(`Run ${schedule.id} now.`), /does not hold the parent lock/);
	lock.held = true;
	// unknown schedule, and a missing quote
	await assert.rejects(run(`Run ${schedule.id} now.`, "sch-ffffff"), /no schedule sch-ffffff/);
	await assert.rejects(run(""), /run_now needs operator_quote/);
	// (f) a disabled schedule
	await scheduler.setEnabled(schedule.id, false);
	await assert.rejects(run(`Run ${schedule.id} now.`), new RegExp(`schedule ${schedule.id} is disabled`));
	assert.deepEqual(await jobs(), []);
});

test("run_now: an open previous fire refuses; a delegated quote is recorded as operator-delegated with its send", async (t) => {
	const { schedule, said, run, jobs } = await bench(t);
	const send = "ps-20260701070300-0a1b2c3d";
	said.push(`Run nightly now.\n\n${sendMarker(send, { delegated: true, delegation_rule: "main session relays run-now asks" })}`);
	assert.match(await run("Run nightly now."), /fired/);
	const [job] = await jobs();
	assert.match(job!.notes ?? "", new RegExp(`authorized by operator-delegated \\(send ${send}, rule: main session relays run-now asks\\)`));
	// (g) a new sentence, but the previous fire is still open
	said.push(`Run ${schedule.id} once more.`);
	assert.match(await run(`Run ${schedule.id} once more.`, schedule.id, "call-2"), new RegExp(`run now not recorded: the previous fire ${job!.id} is still open`));
	assert.equal((await jobs()).length, 1);
});

test("fresh grant per fire: the removed refire/approval_quote params are refused as unknown; a plain add saves the template and run_now fires under a freshly minted grant", async (t) => {
	const { mandates, said, call } = await bench(t);
	const seed = mandates.issue({ projects: ["demo"], objective: "triage", expiry: isoTimestamp(new Date(Date.now() + 86_400_000)), spend_cap: { usd: 10, tokens: 500_000 }, job_cap: 2, schedule_grant: true });
	const add = { action: "add", name: "triage", project: "demo", mandate_id: seed.id, manual: true, title: "Triage", kind: "research", delivery: "answer" };
	await assert.rejects(call({ ...add, refire: true }), /cp_schedule add refused: unknown parameter refire; every fire mints a fresh grant/);
	await assert.rejects(call({ ...add, approval_quote: "Yes, refire triage." }), /cp_schedule add refused: unknown parameter approval_quote/);
	await assert.rejects(call({ ...add, refire: true, approval_quote: "Yes." }), /unknown parameter refire, approval_quote/);
	assert.equal(mandates.list().filter((m) => m.status === "active").length, 2, "a refused add touched no grant");
	const added = await call(add);
	assert.match(added, /fire grant template: each fire mints a fresh grant .*approved "triage" \(operator-delegated\)/);
	const id = /added (sch-[0-9a-f]{6})/.exec(added)![1]!;
	said.push("Run triage now.");
	const fired = await call({ action: "run_now", id, operator_quote: "Run triage now." }, "call-r");
	assert.match(fired, new RegExp(`minted fire grant md-[0-9a-f]{6} from the template of ${seed.id}`));
	const fire = mandates.list().find((m) => m.schedule_fire?.schedule_id === id)!;
	assert.equal(fire.schedule_fire?.approval.operator_quote, "triage", "the seed's objective, quoted verbatim");
	assert.equal(fire.schedule_fire?.trigger.via === "cp_schedule" && fire.schedule_fire.trigger.operator_quote, "Run triage now.");
	assert.equal(mandates.get(seed.id)?.status, "revoked");
});
