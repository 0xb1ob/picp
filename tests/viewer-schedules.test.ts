/**
 * The Schedules page: the read-only `/api/schedules` projection (absent file,
 * invalid file as a named error, cron and watch schedules with next fire,
 * mandate state and fired-job history), the scheduler's forward cron walk in a
 * time zone, and the screen rendered from a fixture.
 */
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { nextCronSlot, parseCron, scheduleFileErrors } from "../src/scheduler.ts";
import { SCHEDULE_DELIVERIES, SCHEDULE_JOB_KINDS, SCHEDULE_MANDATE_ID, SCHEDULE_SCHEMA_VERSION, SCHEDULE_SKILLS } from "../src/viewer/schedule-core.ts";
import { PARENT_SKILLS } from "../src/cp-bridge.ts";
import { SCHEDULE_ANSWER_MAX_BYTES, scheduleAnswer, schedulesView } from "../src/viewer/schedules-view.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import type { ScheduleControlStatusResponse, SchedulesResponse } from "../src/viewer/api-types.ts";
import type { ScheduleControlView } from "../viewer-app/schedule-control.ts";
import { ANSWER_MAX_BYTES, DELIVERIES, JOB_KINDS, LAYOUT, MANDATE_ID_PATTERN, SCHEMA_VERSION } from "../src/contracts.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const NOW = Date.parse("2026-09-28T01:41:00Z");

const cron = {
	id: "sch-aaaaaa", name: "weekly digest", project: "demo", mandate_id: "md-live1",
	trigger: { type: "cron", cron: "0 6 * * 1", tz: "Europe/Warsaw" },
	job: { title: "Digest", kind: "research", delivery: "answer" },
	enabled: true, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:40:00Z",
	last_fire: { at: "2026-09-21T04:00:10Z", slot: "2026-09-21T04:00:00.000Z", job_id: "cp-fire2", missed: true },
};
const watch = {
	id: "sch-bbbbbb", name: "dep watch", project: "demo", mandate_id: "md-paus1",
	trigger: { type: "watch", script_path: "scripts/x.sh", every_seconds: 300, on: "changed" },
	job: { title: "Bump deps", kind: "ship", delivery: "pr" },
	enabled: false, created_at: "2026-09-01T00:00:00Z", last_checked_at: "2026-09-28T01:00:00Z", last_output_sha: "abc",
	last_skip: { at: "2026-09-28T01:00:00Z", reason: "fire at 2026-09-28T01:00Z not recorded: md-paus1 is paused" },
};

function fixture(t: { after(fn: () => void): void }, schedules?: string): ViewerOptions {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const stateDir = join(home.path, LAYOUT.state);
	mkdirSync(join(stateDir, "mandates"), { recursive: true });
	if (schedules !== undefined) writeFileSync(join(stateDir, "schedules.json"), schedules);
	const mandate = (id: string, status: string) => writeFileSync(join(stateDir, "mandates", `${id}.json`), JSON.stringify({ id, status, expiry: "2026-12-01T00:00:00Z", issued_at: "2026-09-01T00:00:00Z", projects: ["demo"], spend_cap: { usd: 10 } }));
	mandate("md-live1", "active");
	mandate("md-paus1", "paused");
	writeFileSync(join(home.path, ".pi-command-post", "jobs.json"), JSON.stringify({ jobs: [
		{ id: "cp-fire1", title: "Digest (weekly digest 2026-09-14T04:00Z)", status: "closed", close_reason: "answered", labels: ["schedule:sch-aaaaaa", "delivery:answer"], created_at: "2026-09-14T04:00:10Z" },
		{ id: "cp-fire2", title: "Digest (weekly digest 2026-09-21T04:00Z)", status: "open", labels: ["schedule:sch-aaaaaa"], created_at: "2026-09-21T04:00:10Z" },
		{ id: "cp-other", title: "unrelated", status: "open", labels: [], created_at: "2026-09-21T04:00:10Z" },
	] }));
	mkdirSync(join(stateDir, "runs", "cp-fire1"), { recursive: true });
	const answer = join(stateDir, "artifacts", "cp-fire1", "report.md");
	mkdirSync(join(stateDir, "artifacts", "cp-fire1"), { recursive: true });
	writeFileSync(answer, `ANSWER-HEAD Sunny, 29 C\n${"x".repeat(9000)}ANSWER-TAIL`);
	writeFileSync(join(stateDir, "runs", "cp-fire1", "envelope.json"), JSON.stringify({ received_at: "2026-09-14T04:05:00Z", envelope: { pr_url: "https://github.com/acme/repo/pull/9", summary: "Warsaw: sunny, 29 C", artifact_path: answer } }));
	return { home: home.path, stateDir, host: "127.0.0.1", port: 0 };
}
const file = (...schedules: unknown[]) => JSON.stringify({ schema_version: SCHEMA_VERSION, schedules });

test("nextCronSlot walks forward in the schedule's time zone, across a DST change", () => {
	const spec = parseCron("0 6 * * 1");
	assert.equal(nextCronSlot(spec, "Europe/Warsaw", new Date(NOW))?.toISOString(), "2026-09-28T04:00:00.000Z", "06:00 CEST");
	assert.equal(nextCronSlot(spec, "Europe/Warsaw", new Date("2026-09-28T04:00:00Z"))?.toISOString(), "2026-10-05T04:00:00.000Z", "strictly after");
	assert.equal(nextCronSlot(spec, "Europe/Warsaw", new Date("2026-10-20T00:00:00Z"))?.toISOString(), "2026-10-26T05:00:00.000Z", "06:00 CET after the clocks go back");
	assert.equal(nextCronSlot(parseCron("*/15 * * * *"), "UTC", new Date("2026-09-28T01:41:30Z"))?.toISOString(), "2026-09-28T01:45:00.000Z");
});

test("the dependency-free schedule schema mirrors the contracts and refuses what the typebox schema refused", () => {
	assert.deepEqual([...SCHEDULE_JOB_KINDS], [...JOB_KINDS]);
	assert.deepEqual([...SCHEDULE_DELIVERIES], [...DELIVERIES]);
	assert.equal(SCHEDULE_MANDATE_ID.source, MANDATE_ID_PATTERN);
	assert.equal(SCHEDULE_SCHEMA_VERSION, SCHEMA_VERSION);
	assert.deepEqual(scheduleFileErrors(JSON.parse(file(cron, watch))), []);
	const bad = (patch: Record<string, unknown>) => scheduleFileErrors({ schema_version: SCHEMA_VERSION, schedules: [{ ...cron, ...patch }] });
	assert.match(bad({ extra: 1 }).join(), /\/schedules\/0\/extra: unexpected property/);
	assert.match(bad({ name: "two\nlines" }).join(), /\/schedules\/0\/name/);
	assert.match(bad({ mandate_id: "md-X" }).join(), /mandate_id/);
	assert.match(bad({ job: { ...cron.job, kind: "deploy" } }).join(), /job\/kind/);
	assert.match(bad({ trigger: { ...watch.trigger, every_seconds: 10 } }).join(), /every_seconds/);
	assert.match(bad({ trigger: { type: "cron", cron: "* * * * *" } }).join(), /trigger\/tz: is required/);
	assert.match(bad({ last_fire: { at: "x", slot: "x", job_id: "x" } }).join(), /last_fire\/missed: is required/);
	assert.match(scheduleFileErrors({ schema_version: 2, schedules: [] }).join(), /schema_version/);
	assert.match(scheduleFileErrors({ schema_version: SCHEMA_VERSION, schedules: {} }).join(), /schedules: must be an array/);
});

test("schedules view: no file is empty, an invalid file is a named error", (t) => {
	assert.deepEqual(schedulesView(fixture(t), () => {}, NOW), { generated_at: new Date(NOW).toISOString(), error: null, schedules: [] });
	const broken = schedulesView(fixture(t, "{not json"), () => {}, NOW);
	assert.match(broken.error ?? "", /schedules\.json is not valid JSON/);
	assert.deepEqual(broken.schedules, []);
	const invalid = schedulesView(fixture(t, file({ ...cron, id: "bad" })), () => {}, NOW);
	assert.match(invalid.error ?? "", /violates the schedule contract/);
});

test("schedules view: cron and watch schedules with next fire, mandate state and history", (t) => {
	const data = schedulesView(fixture(t, file(cron, watch)), () => {}, NOW);
	assert.equal(data.error, null);
	const [c, w] = data.schedules;
	assert.equal(c?.next_at, "2026-09-28T04:00:00.000Z");
	assert.equal(c?.mandate_status, "active");
	assert.deepEqual(c?.history.map((j) => j.id), ["cp-fire2", "cp-fire1"], "newest first, only this schedule's label");
	assert.equal(c?.history[1]?.close_reason, "answered");
	assert.equal(c?.history[1]?.pr_url, "https://github.com/acme/repo/pull/9");
	assert.equal(c?.history[1]?.summary, "Warsaw: sunny, 29 C");
	assert.equal(c?.history[1]?.reported_at, "2026-09-14T04:05:00Z");
	const answer = c?.history[1]?.answer;
	assert.equal(answer?.truncated, true, "capped");
	assert.equal(Buffer.byteLength(answer?.text ?? ""), SCHEDULE_ANSWER_MAX_BYTES);
	assert.equal(answer?.bytes, Buffer.byteLength(`ANSWER-HEAD Sunny, 29 C\n${"x".repeat(9000)}ANSWER-TAIL`));
	assert.match(answer?.text ?? "", /^ANSWER-HEAD/);
	assert.doesNotMatch(answer?.text ?? "", /ANSWER-TAIL/);
	assert.deepEqual([c?.history[0]?.summary, c?.history[0]?.reported_at, c?.history[0]?.answer], [null, null, null], "an unreported run");
	assert.equal(w?.next_at, "2026-09-28T01:05:00.000Z", "last_checked_at + every_seconds");
	assert.equal(w?.mandate_status, "paused");
	assert.equal("last_output_sha" in (w ?? {}), false, "the watch output hash is not served");
	assert.deepEqual(w?.history, []);
});

test("a manual skill schedule: schema accepts it, the view has no next fire, the page says it fires only on Run now", async (t) => {
	const manual = {
		id: "sch-cccccc", name: "self-review", project: "demo", mandate_id: "md-live1",
		trigger: { type: "manual" }, job: { title: "Self-review", kind: "research", delivery: "local", skill: "cp-self-review" },
		enabled: true, created_at: "2026-09-01T00:00:00Z",
	};
	assert.deepEqual(scheduleFileErrors(JSON.parse(file(manual))), []);
	assert.match(scheduleFileErrors(JSON.parse(file({ ...manual, job: { ...manual.job, skill: "cp-other" } }))).join(), /job\/skill: must be one of cp-self-review/);
	assert.match(scheduleFileErrors(JSON.parse(file({ ...manual, trigger: { type: "manual", cron: "* * * * *" } }))).join(), /trigger\/cron: unexpected property/);
	for (const skill of SCHEDULE_SKILLS) assert.ok((PARENT_SKILLS as readonly string[]).includes(skill), `${skill} is a parent skill`);
	const data = schedulesView(fixture(t, file(manual)), () => {}, NOW);
	assert.deepEqual([data.error, data.schedules[0]?.next_at, data.schedules[0]?.next_note], [null, null, "manual: fires only on Run now"]);
	const built = await build({
		stdin: {
			contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Schedules, triggerText} from "./viewer-app/screens/Schedules.tsx"; export {triggerText}; export const screen=d=>render(h(Schedules,{data:d}));',
			loader: "tsx",
			resolveDir: REPO_ROOT,
		},
		bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" },
	});
	const { screen, triggerText } = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`)) as {
		screen(data: SchedulesResponse): string;
		triggerText(item: SchedulesResponse["schedules"][number]): string;
	};
	assert.equal(triggerText(data.schedules[0]!), "manual (Run now only), expanded by skill cp-self-review");
	const html = screen(data);
	assert.match(html, /Manual: fires only on Run now/);
	assert.match(html, /Each Run now records a deferred anchor job and wakes the parent to fan out the cp-self-review recipe under this grant\./);
	assert.doesNotMatch(html, /Next fire|Next check/);
});

test("schedules view: an answer is read only from the job's own artifact dir; a path outside it is refused", (t) => {
	const options = fixture(t, file(cron));
	const dir = join(options.stateDir, "artifacts", "cp-fire1");
	const outside = join(options.home, "outside.md");
	writeFileSync(outside, "OUTSIDE-SECRET");
	const envelope = (artifact_path: string) => writeFileSync(join(options.stateDir, "runs", "cp-fire1", "envelope.json"), JSON.stringify({ envelope: { summary: "s", artifact_path } }));
	const answer = () => schedulesView(options, () => {}, NOW).schedules[0]?.history.find((j) => j.id === "cp-fire1")?.answer;
	envelope(outside);
	assert.match(answer()?.text ?? "", /^ANSWER-HEAD/, "an outside artifact_path falls back to the intake copy in the job's dir");
	rmSync(join(dir, "report.md"));
	assert.equal(answer(), null, "and with no copy, the outside file is never read");
	symlinkSync(outside, join(dir, "report.md"));
	assert.equal(answer(), null, "a symlink out of the dir is refused");
	envelope(join(dir, "..", "..", "..", "..", "outside.md"));
	assert.equal(answer(), null, "so is a traversal");
	mkdirSync(join(options.stateDir, "artifacts", "cp-other"), { recursive: true });
	writeFileSync(join(options.stateDir, "artifacts", "cp-other", "report.md"), "OTHER-JOB");
	envelope(join(options.stateDir, "artifacts", "cp-other", "report.md"));
	assert.equal(answer(), null, "another job's artifact is refused");
	assert.equal(scheduleAnswer(options, "../artifacts/cp-other", undefined), null, "an unsafe id never reaches a path");
	assert.equal(SCHEDULE_ANSWER_MAX_BYTES, ANSWER_MAX_BYTES, "the viewer's cap mirrors the contract");
});

test("schedules view: a symlinked job artifact dir does not redefine the allowed root", (t) => {
	const options = fixture(t, file(cron));
	const external = join(options.home, "external-dir");
	mkdirSync(external, { recursive: true });
	writeFileSync(join(external, "outside.txt"), "SYNTHETIC_SECRET");
	const job = join(options.stateDir, "artifacts", "cp-link");
	symlinkSync(external, job);
	assert.equal(scheduleAnswer(options, "cp-link", join(external, "outside.txt")), null, "an artifact path in a symlinked dir is refused");
	writeFileSync(join(external, "report.md"), "SYNTHETIC_SECRET");
	assert.equal(scheduleAnswer(options, "cp-link", undefined), null, "so is the intake copy");
});

test("schedules view: a symlinked state dir or artifacts root still serves a real job dir's answer", (t) => {
	const options = fixture(t, file(cron));
	const answerOf = (state: ViewerOptions) => scheduleAnswer(state, "cp-fire1", join(options.stateDir, "artifacts", "cp-fire1", "report.md"));
	assert.match(answerOf(options)?.text ?? "", /^ANSWER-HEAD/, "baseline");
	const alias = join(options.home, "state-alias");
	symlinkSync(options.stateDir, alias);
	assert.match(answerOf({ ...options, stateDir: alias })?.text ?? "", /^ANSWER-HEAD/, "a symlinked state dir");
	const moved = join(options.home, "moved-artifacts");
	renameSync(join(options.stateDir, "artifacts"), moved);
	symlinkSync(moved, join(options.stateDir, "artifacts"));
	assert.match(scheduleAnswer(options, "cp-fire1", undefined)?.text ?? "", /^ANSWER-HEAD/, "a symlinked artifacts root");
	symlinkSync(join(moved, "cp-fire1"), join(moved, "cp-link"));
	assert.equal(scheduleAnswer(options, "cp-link", undefined), null, "a symlinked job dir is still refused");
});

test("schedules view: the 8 KiB cap trims back to a whole UTF-8 character", (t) => {
	const options = fixture(t, file(cron));
	// 1 + 3n bytes: the cap at 8192 falls inside the 2731st euro sign.
	writeFileSync(join(options.stateDir, "artifacts", "cp-fire1", "report.md"), `a${"€".repeat(3000)}`);
	const answer = scheduleAnswer(options, "cp-fire1", undefined);
	assert.equal(answer?.text, `a${"€".repeat(2730)}`);
	assert.equal(answer?.truncated, true);
	assert.equal(answer?.text.includes("\uFFFD"), false, "no replacement character");
});

test("GET /api/schedules serves the projection and the refresh stream accepts the view", async (t) => {
	const options = fixture(t, file(cron));
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, options.host, resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const url = `http://127.0.0.1:${options.port}`;
	const response = await fetch(`${url}/api/schedules`);
	assert.equal(response.status, 200);
	const data = (await response.json()) as SchedulesResponse;
	assert.deepEqual(data.schedules.map((s) => s.id), ["sch-aaaaaa"]);
	const stream = await fetch(`${url}/api/stream?view=schedules`, { method: "HEAD" });
	assert.equal(stream.status, 200);
	const post = await fetch(`${url}/api/schedules`, { method: "POST" });
	assert.equal(post.status, 405, "read-only");
});

test("Schedules renders an enabled cron, a disabled watch, an inactive mandate, the error and the empty state", async (t) => {
	const built = await build({
		stdin: {
			contents: 'import {h} from "preact"; import render from "preact-render-to-string"; import {Schedules} from "./viewer-app/screens/Schedules.tsx"; export const screen=d=>render(h(Schedules,{data:d})); export const controlled=(d,c)=>render(h(Schedules,{data:d,control:c}));',
			loader: "tsx",
			resolveDir: REPO_ROOT,
		},
		bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" },
	});
	const { screen, controlled } = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles![0]!.contents).toString("base64")}`)) as {
		screen(data: SchedulesResponse): string;
		controlled(data: SchedulesResponse, control: ScheduleControlView): string;
	};
	const empty = screen({ generated_at: new Date(NOW).toISOString(), error: null, schedules: [] });
	assert.match(empty, /No schedules\. Ask the operator session to add one \(cp_schedule\)\./);
	assert.match(empty, /fire in the always-on parent; a slot missed while it was down fires once when it returns/);
	assert.match(screen({ generated_at: new Date(NOW).toISOString(), error: "state/schedules.json violates the schedule contract", schedules: [] }), /role="alert"[^>]*>Schedules unavailable: state\/schedules\.json violates/);

	const html = screen(schedulesView(fixture(t, file(cron, watch)), () => {}, NOW));
	assert.match(html, /weekly digest/);
	assert.match(html, /cron 0 6 \* \* 1 \(Europe\/Warsaw\)/);
	assert.match(html, /Next fire /);
	assert.match(html, /watch scripts\/x\.sh every 300 s, fires on changed output/);
	assert.match(html, />disabled</);
	assert.match(html, /fires are skipped while this grant is paused/);
	assert.match(html, /this page's run history \(not the operator session\)/);
	assert.doesNotMatch(html, /an answer card in the operator session/);
	assert.match(html, /Warsaw: sunny, 29 C/);
	assert.match(html, /<pre class="schedule-answer">ANSWER-HEAD Sunny, 29 C/);
	assert.match(html, /truncated at 8 KiB/);
	assert.match(html, /reported /);
	assert.match(html, /a pull request/);
	assert.match(html, /href="#job\/cp-fire2"/);
	assert.match(html, /\(missed\)/);
	assert.match(html, /md-paus1 is paused/, "last skip reason");
	assert.match(html, /href="https:\/\/github\.com\/acme\/repo\/pull\/9"/);
	assert.doesNotMatch(html, /<button|<form|<input|<script|style=|onclick=/i, "read-only, no inline style");
	assert.match(html, /<a class="schedule-add" href="#sessions\?view=you&amp;transcript=1&amp;draft=Add\+a\+schedule/, "Add prefills the composer");

	// cp-hhuf P6: with a ready control, each card has its buttons; the latest request's state shows under them.
	const data = schedulesView(fixture(t, file(cron, watch)), () => {}, NOW);
	const ready: ScheduleControlStatusResponse = {
		generated_at: new Date(NOW).toISOString(), enabled: true, reason: null, token: "t".repeat(64), parent: { running: true, pid: 1, reason: "running" }, error: null,
		requests: [{ id: "sc-20260701070000-00000001", at: new Date(NOW).toISOString(), op: "enable", schedule_id: "sch-bbbbbb", state: "refused", reason: "enable sch-bbbbbb refused: md-paus1 is paused", job_id: null }],
	};
	const noop = { sending: null, failed: null, request: () => {} };
	const live = controlled(data, { status: ready, ...noop });
	const [cronCard = "", watchCard = ""] = live.split('<article class="job-row schedule-card">').slice(1);
	assert.match(cronCard, /<button type="button" class="schedule-primary">Run now<\/button><button type="button">Disable<\/button><button type="button" class="schedule-remove">Remove…<\/button>/);
	assert.match(watchCard, /<button type="button">Enable<\/button><button type="button" class="schedule-remove">Remove…<\/button>/);
	assert.doesNotMatch(watchCard, /Run now/, "no run now on a disabled schedule");
	assert.match(watchCard, /Refused: enable sch-bbbbbb refused: md-paus1 is paused/);
	assert.match(live, /Controls ready/);
	assert.doesNotMatch(live, /<form|<input|<script|style=|onclick=/i);
	const down = controlled(data, { status: { ...ready, parent: { running: false, pid: null, reason: "no parent lock" }, reason: "Parent not running: no parent lock" }, ...noop });
	assert.match(down, /Parent not running: no parent lock/);
	assert.match(down, /<button type="button" disabled>Disable<\/button>/);
	assert.doesNotMatch(down, /<button type="button">/, "every button disabled while the parent is down");
});
