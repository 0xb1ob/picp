/**
 * Sessions chat v2 browser capture: the production app on loopback (production CSP, synthetic APIs), isolated headless
 * Chrome over CDP, PNGs plus manifest.json. `m3-transcript` serves the other screens' APIs from the real viewer.
 * `--stage <one of STAGES below> [--chrome <path>] --out <dir>`
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LAYOUT } from "../../src/contracts.ts";
import type { ControlStatusResponse, JobResponse, JobTranscriptResponse, PrChip, SessionEntry, SessionsResponse } from "../../src/viewer/api-types.ts";
import { APP_CSP, appPage } from "../../src/viewer/app-page.ts";
import { buildViewer } from "../../src/viewer/build.ts";
import { dispatch } from "../../src/viewer/server.ts";
import { overview } from "../../src/viewer/overview-view.ts";

const STAGES = ["pr1", "pr2", "pr3", "pr4", "pr5", "chips", "rollup", "notice", "m3-transcript", "m3-jobs", "m3-context", "m3-composer", "nav-simplify", "p3-quota", "m3-shell",
	"m3-fidelity-transcript", "m3-fidelity-surfaces", "m3-fidelity-composer", "full-match-shell", "full-match-transcript", "full-match-jobs"];
const { values: args } = parseArgs({ options: { stage: { type: "string" }, chrome: { type: "string", default: "/usr/bin/google-chrome" }, out: { type: "string" } } });
if (!args.stage || !STAGES.includes(args.stage)) throw new Error(`--stage must be one of ${STAGES.join(", ")} (later stages land with their PRs)`);
if (!args.out) throw new Error("--out <dir> is required");
const out = resolve(args.out);
const GENERATED = "2026-10-15T16:00:00Z";

const say = (id: string, at: string, who: string, text: string, over: Partial<SessionEntry> = {}): SessionEntry =>
	({ id, at, kind: "say", who, text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const tool = (id: string, at: string, name: string, text: string, summary?: string): SessionEntry => ({ ...say(id, at, "Assistant", text), kind: "tool", name, ...(summary ? { summary } : {}) });
/** Full match S2 shows job suffixes, so its ids end in four characters like real picp ids; S3 reuses its data. */
const S2 = args.stage === "full-match-transcript" || args.stage === "full-match-jobs";
const JOB = S2 ? "cp-sessions-v2-m4xq" : "cp-sessions-v2-pr2";
/** A cp-bridge wake as the transcript carries it: first line parsed off, `paths:` resolved (one left unresolved). */
const wake: SessionEntry = say("w1", "2026-10-15T08:03:30Z", "cp-bridge", [
	"PR #319 is waiting on CI. The diff review passed on 3f2a9c1; CI is still running on that head, so nothing is merged yet.",
	"The review left two low-confidence notes. They do not block the merge.", "paths:",
	`- /home/u/.pi-command-post/state/runs/${JOB}/artifact.md`, `- /home/u/.pi-command-post/state/runs/${JOB}`, `- /home/u/.pi-command-post/state/artifacts/${JOB}/report.md`,
].join("\n"), { kind: "system", tag: "bridge", bridge: { kind: "wake", job: JOB, id: null, receipt: "owner_observed" }, paths: [
	{ path: `/home/u/.pi-command-post/state/runs/${JOB}/artifact.md`, href: `#job/${JOB}`, read: null },
	{ path: `/home/u/.pi-command-post/state/runs/${JOB}`, href: `#job/${JOB}`, read: null },
	{ path: `/home/u/.pi-command-post/state/artifacts/${JOB}/report.md`, href: null, read: null },
] });
const TABLE = "| Job | Project | State | Head | Note |\n|---|---|---|---|---|\n"
	+ "| cp-sessions-v2-pr1 | picp | held | 3f2a9c1 | Themes, cards and dates for the Sessions transcript |\n"
	+ "| cp-very-long-job-identifier-that-keeps-going-to-force-a-scroll | demo-app | working | 9b77e02 | long cells scroll inside the table |\n"
	+ "| cp-ab12 | picp | done | 1c0ffee | merged |";
const entries: SessionEntry[] = [
	say("e1", "2026-10-14T09:12:00Z", "Operator", "Morning. Where is the Sessions redesign?"),
	say("e2", "2026-10-14T09:12:40Z", "Assistant", "PR 1 of 5 is in flight: tokens, cards and date separators. Status by job:\n\n" + TABLE),
	tool("t1", "2026-10-14T09:13:00Z", "bash", "git log --oneline -3"),
	tool("t2", "2026-10-14T09:13:05Z", "read", "viewer-app/screens/sessions.css"),
	say("e3", "2026-10-14T09:14:00Z", "Assistant", "The theme lives on `.shell-sessions` only, so Overview keeps its palette:\n\n```css\n.shell-sessions { color-scheme: light; background: var(--background); }\n```"),
	say("e4", "2026-10-15T08:02:00Z", "Operator", "Long words must wrap: https://github.com/example/picp/pull/1234/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef", { project: "picp" }),
	say("e5", "2026-10-15T08:03:00Z", "Assistant", "They do; an inline `code-identifier-that-is-quite-long` chip wraps too.\n\nA second paragraph keeps the card readable on a phone without a horizontal page scroll, even when the reply runs to several lines of plain prose like this one."),
	wake,
	tool("k1", "2026-10-15T08:03:31Z", "thinking", "Let me verify the precedence claim before answering.", "Let me verify the precedence claim: docs say parent.json overrides CP_PARENT_MODEL"),
	tool("k2", "2026-10-15T08:03:35Z", "bash", "Arguments\n{\"command\":\"rg -n Models docs\"}\n\nResult\n## Models", "## Models"),
	tool("k3", "2026-10-15T08:03:38Z", "read", "Arguments\n{\"path\":\"src/service/supervise.ts\"}\n\nResult\n…", "src/service/supervise.ts"),
	tool("k4", "2026-10-15T08:03:40Z", "cp_integrate", `Arguments\n{"job_id":"${JOB}"}\n\nResult\nnext: wait`, `${JOB} · next: wait`),
	tool("k5", "2026-10-15T08:03:44Z", "fetch_content", "Arguments\n{\"url\":\"https://example.com/notes\"}\n\nResult\n…", "https://example.com/notes"),
	say("e6", "2026-10-15T08:04:00Z", "Assistant", "Anything else before I open the draft?"),
	tool("o1", "2026-10-15T08:04:10Z", "bash", "Arguments\n{\"command\":\"git status\"}\n\nResult\nclean", "git status"),
	tool("o2", "2026-10-15T08:04:12Z", "cp_parent", "Arguments\n{\"action\":\"status\"}\n\nResult\nrunning", "status · running"),
];
type Worker = SessionsResponse["workers"][number];
const workers: Worker[] = [
	{ id: "cp-sessions-v2-pr3", kind: "worker", job_id: "cp-sessions-v2-pr3", phase: "waiting", run_phase: "working", model: "fixture-model", live: true, last_activity: "2026-10-15T08:04:30Z" },
	{ id: "cp-held-review-with-a-long-job-id", kind: "worker", job_id: "cp-held-review-with-a-long-job-id", phase: "held", run_phase: "idle", model: "fixture-model", live: false, last_activity: "2026-10-15T07:40:00Z" },
];
const sessions: SessionsResponse = {
	generated_at: GENERATED, selected: "you", session_id: "op-session", entries, title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false,
	parent: { id: "cp-parent", kind: "parent", live: true, last_activity: "2026-10-15T08:04:20Z" }, workers, transcript: true, operator_sessions: [{ id: "op.jsonl", at: GENERATED }], operator_session: "op.jsonl",
};
/** PR 4: one open ask carded in the transcript, so its literal options become quick replies; a second one hides them. */
const asked = (id: string, question: string) => ({ id, project: "picp", question, created_at: "2026-10-15T08:04:40Z", recommendation: "Merge after CI",
	options: [{ label: "Merge after CI", consequence: "Lands once the pushed head is green", reply: "" }, { label: "Hold for review", consequence: "Waits for a second review pass", reply: "" },
		{ label: "Close the PR without merging and file the remaining work as a new job", consequence: "Nothing lands; a long label wraps inside its chip", reply: "" }],
	source_escalation: null, job_ids: [], context: null, evidence_paths: [], reason: null, source_created_at: null, mandate_id: null, mandate_status: null, spend: null, spend_cap: null,
	mandate_objective: null, jobs: [], escalation: null, evidence: [] }) as unknown as NonNullable<SessionsResponse["open_asks"]>[number];
const askCard = (ask: ReturnType<typeof asked>, at: string): SessionEntry => ({ ...say(`c-${ask.id}`, at, "Operator → you", ask.question), kind: "ask", ask_id: ask.id,
	ask: { id: ask.id, question: ask.question, options: ask.options, recommendation: ask.recommendation, state: "open", answer: null, answered_at: null, reason: null } });
const fullMatch = args.stage === "full-match-shell" || S2;
if (args.stage === "pr4" || args.stage === "pr5" || args.stage === "m3-context" || args.stage === "m3-shell" || args.stage === "m3-fidelity-transcript" || args.stage === "m3-fidelity-surfaces"
	|| args.stage === "m3-fidelity-composer" || fullMatch) {
	const ask = asked("ask-pr4a", "PR #321 is green on its pushed head. Merge it, or hold it for another review?");
	sessions.entries = [...entries, askCard(ask, "2026-10-15T08:04:40Z")];
	sessions.open_asks = [ask];
	sessions.operator_context = { tokens: 61_000, window: 200_000, percent: 30.5, level: "ok", reason: null, model: "fixture-model", last_compact_at: null, thinking: null } as SessionsResponse["operator_context"];
}
/** M3 shell: committed captures name picp only, so the table's second project reads picp too. */
const picpOnly = args.stage === "m3-shell" || args.stage === "m3-fidelity-transcript" || args.stage === "m3-fidelity-surfaces" || args.stage === "m3-fidelity-composer" || fullMatch;
if (picpOnly) sessions.entries = sessions.entries.map(e => ({ ...e, text: e.text.replaceAll("demo-app", "picp") }));
/** M3 fidelity B: an own message before the ask, so one capture holds a bubble, a reply, the ask and both sends. */
if (args.stage === "m3-fidelity-transcript") sessions.entries.splice(-1, 0, say("e7", "2026-10-15T08:04:30Z", "Operator", "Hold the merge until I have read the review."));
/** Full match S2: four-character suffixes, a recorded multi-line context, and a PR chip whose CI slot is unrecorded. */
if (S2) {
	const ids: Record<string, string> = { "cp-sessions-v2-pr3": "cp-transcript-steps-t7ah", "cp-held-review-with-a-long-job-id": "cp-held-review-k2pq" };
	sessions.workers = sessions.workers.map(w => ({ ...w, id: ids[w.id] ?? w.id, job_id: w.job_id && (ids[w.job_id] ?? w.job_id) }));
	sessions.open_asks = sessions.open_asks!.map(a => ({ ...a, context: "- CI is green on the pushed head 3f2a9c1.\n- One review attempt passed; its two notes do not block the merge.\n- The PR changes viewer-app files only." }));
	const url = "https://github.com/o/picp/pull/321";
	sessions.pr_chips = { [url]: { kind: "pr", url, number: 321, repo: "o/picp", job_id: JOB, head_sha: "3f2a9c1e".padEnd(40, "0"), state: "open", merge_sha: null,
		closed_by: null, job_status: null, ci: null, review: "pass" } };
	sessions.entries.splice(-1, 0, say("e8", "2026-10-15T08:04:35Z", "Assistant", `**[picp]** ${url} passed its review; CI has not reported on that head yet.`));
}
/** Chips: every PR state, CI and review value, the three issue forms, a long repo name, and a `#7` code span. */
if (args.stage === "chips") {
	const gh = "https://github.com/o/picp", long = "https://github.com/an-organisation-with-a-long-name/a-repository-name-that-keeps-going-for-wrapping";
	const pr = (n: number, over: Partial<PrChip>, base = gh): PrChip => ({ kind: "pr", url: `${base}/pull/${n}`, number: n, repo: base.slice(19), job_id: `cp-chip-${n}`, head_sha: "3f2a9c1e".padEnd(40, "0"),
		state: "open", merge_sha: null, closed_by: null, job_status: null, ci: null, review: null, ...over });
	const issue = (n: number, over: Partial<PrChip>): PrChip => ({ ...pr(n, { kind: "issue", head_sha: null, job_id: null, state: null }), url: `${gh}/issues/${n}`, ...over });
	const chips = [pr(355, { state: "draft", ci: "green", review: "running" }), pr(356, { state: "merged", merge_sha: "9b77e02".padEnd(40, "1"), ci: "green", review: "pass" }),
		pr(357, { state: "open", ci: "pending", review: "revise" }), pr(358, { state: "closed", ci: "red", head_sha: null }), pr(359, { state: "unknown", ci: "unreadable" }),
		pr(1234567, { state: "open", ci: "red", review: "revise" }, long),
		issue(328, { state: "closed", closed_by: { url: `${gh}/pull/356`, number: 356 }, job_id: "cp-issue-328", job_status: "closed" }), issue(330, { state: "open", job_id: "cp-issue-330", job_status: "in_progress" }), issue(329, {})];
	sessions.pr_chips = Object.fromEntries(chips.map(c => [c.url, c]));
	const links = Object.fromEntries(chips.filter(c => c.repo === "o/picp").map(c => [`#${c.number}`, c.url]));
	sessions.entries = [...entries,
		say("p1", "2026-10-15T08:04:30Z", "Assistant", `**[picp]** CI is green on ${gh}/pull/355 and its review is running; #357 waits on CI after a revise.`, { links }),
		say("p2", "2026-10-15T08:04:35Z", "Assistant", "**[picp]** #356 merged and closes #328. #330 is still open, #329 has no record, and `#7` in code stays text.\n\n- #358 closed unmerged\n- #359 has a stale receipt", { links }),
		say("p3", "2026-10-15T08:04:38Z", "Assistant", `Another repo: ${long}/pull/1234567 is red.`),
	];
}
/** Rollup: three turns about one PR (a job's CI wake, its review relay, a job-less HELD PR LANDED), then another job and you. */
if (args.stage === "rollup") {
	const url = "https://github.com/o/picp/pull/360", a = "cp-rollup-pr-a-long-job-identifier", b = "cp-other-job";
	sessions.pr_chips = { [url]: { kind: "pr", url, number: 360, repo: "o/picp", job_id: a, head_sha: "3f2a9c1e".padEnd(40, "0"), state: "merged", merge_sha: "9b77e02".padEnd(40, "1"),
		closed_by: null, job_status: null, ci: "green", review: "pass" } };
	const notice = (id: string, at: string, job: string | null, text: string) => say(id, at, "cp-bridge", text, { kind: "system", tag: "bridge", bridge: { kind: job ? "wake" : "held_pr_landed", job, id: null, receipt: null } });
	sessions.entries = [...entries,
		notice("u1", "2026-10-15T08:04:20Z", a, "CI finished green on the pushed head 3f2a9c1."),
		say("v1", "2026-10-15T08:04:25Z", "Assistant", `**[picp]** ${a}: CI is green on ${url}; starting the review.`),
		notice("u2", "2026-10-15T08:04:40Z", a, "Review attempt 1 started on 3f2a9c1."),
		say("v2", "2026-10-15T08:04:45Z", "Assistant", `**[picp]** ${a}: review is running on ${url}. Nothing to decide yet.`),
		notice("u3", "2026-10-15T08:05:10Z", null, "HELD PR LANDED"),
		say("v3", "2026-10-15T08:05:15Z", "Assistant", `**[picp]** ${url} merged as 9b77e02 after a passing review; the worktree is torn down and the job is closed.`),
		notice("u4", "2026-10-15T08:05:30Z", b, "Worker reported done."),
		say("v4", "2026-10-15T08:05:35Z", "Assistant", `**[picp]** ${b} finished; no PR for this one.`),
		say("v5", "2026-10-15T08:05:50Z", "Operator", "Thanks. Anything else waiting?"),
	];
}
/** Notice: a bridge wake naming a draft PR chips it like the relay's turn card below it. */
if (args.stage === "notice") {
	const url = "https://github.com/o/picp/pull/381", job = "cp-e2e-migration-p2-tyir";
	sessions.pr_chips = { [url]: { kind: "pr", url, number: 381, repo: "o/picp", job_id: job, head_sha: "5cda64f5989e".padEnd(40, "0"), state: "draft", merge_sha: null,
		closed_by: null, job_status: null, ci: "green", review: "pass" } };
	sessions.entries = [...entries,
		say("u1", "2026-10-15T08:04:20Z", "cp-bridge", `[picp] CI GREEN — ${job}: cp_review attempt 2 started on 5cda64f5989e — handled in code, no parent turn. ${url}`,
			{ kind: "system", tag: "bridge", bridge: { kind: "wake", job, id: null, receipt: null } }),
		say("v1", "2026-10-15T08:04:25Z", "Assistant", `**[picp]** ${job}: review is running on ${url}.`),
	];
}
const body = (text: string) => ({ kind: "message" as const, text });
const control: ControlStatusResponse = {
	generated_at: GENERATED, enabled: true, running: true, reason: null, token: "fixture-token", busy: true, pending: true, session_file: "op.jsonl", recent: [], images: true, files: true,
	sends: [
		{ id: "dc-queued", at: "2026-10-15T08:05:00Z", state: "queued", reason: null, ask_id: null, editable: true, body: body("Queued while the session is busy: open it as a draft.") },
		{ id: "dc-failed", at: "2026-10-15T08:06:00Z", state: "failed", reason: "Session stopped before delivery", ask_id: null, body: body("This one failed to deliver.") },
	],
	offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: false, herdr: false }, resume: { tmux: false, herdr: false },
};
/** A done job for the card's "Open job transcript →"; shaped as in tests/viewer-job-detail-render-retained.test.ts. */
const job = { generated_at: GENERATED, awaiting_count: 0, description: null, mandate: null, timeline: [], timeline_truncated: false, files_href: null, artifact_href: null, artifact_name: null, run_href: null, reports: [], asks: [], questions: [], warnings: [],
	job: { id: JOB, project: "picp", title: "Sessions chat v2 PR 2", phase: "done", model: null, script_path: null, elapsed_seconds: null, limit_seconds: null, head: null, ci: null, review: null, review_attempts: 0, routing: null, note: null, ledger_status: "closed", ledger_disagrees: false, mandate_id: null, cost_usd: null, pr_url: null, pr_status: null, finished_at: GENERATED, finished_today: false, merge_sha: null, failure: null, summary: "Steps card and the Job transcript link.", blockers: [], context: null } } as unknown as JobResponse;
const jobTranscript: JobTranscriptResponse = { entries: [say("j1", "2026-10-15T08:00:00Z", "Worker", "Reading the task file."), tool("j2", "2026-10-15T08:00:05Z", "read", "Arguments\n{}\n\nResult\nok", "Read the plan")], truncated: false, warning: null, from: null, to: null };
/** GETs the app makes but this fixture leaves empty: answered 404, like a viewer without that feature. */
const ABSENT = new Set(["/api/version", "/api/push", "/api/devices/notices", "/api/skills"]);

const scratch = mkdtempSync(join(tmpdir(), "cp-sessions-v2-fixture-"));
const profile = mkdtempSync(join(tmpdir(), "cp-sessions-v2-chrome-"));
const streams = new Set<ServerResponse>();
const posts: string[] = [], unexpected: string[] = [];
let chrome: ChildProcess | undefined;
const server = createServer();
const deadline = <T>(what: string, ms: number, run: Promise<T>) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
try {
	if (args.stage === "p3-quota") {
		// P3: two failed jobs and their intents on the scratch home; the real viewer projects them (overdue, held).
		const put = (file: string, value: unknown) => { mkdirSync(join(scratch, file, ".."), { recursive: true }); writeFileSync(join(scratch, file), JSON.stringify(value)); };
		const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
		const ids = ["cp-quota-due", "cp-quota-held"];
		put(".pi-command-post/jobs.json", { jobs: ids.map(id => ({ id, title: `${id} fixture`, status: "in_progress", labels: ["project:demo", "kind:ship"] })) });
		put(LAYOUT.fleetFile, { jobs: ids.map(job_id => ({ job_id, project: "demo", kind: "ship", phase: "failed", dispatched_at: ago(60), failure: { class: "model_call_failed", message: "quota continuation pending", at: ago(50) } })) });
		const intent = (job_id: string, delivery: string, reason?: string) => ({ continuation_id: `${job_id}:quota:1`, job_id, generation: 1, state: "pending", delivery, capability_version: "mock-quota-reset/1",
			signal: { resetsAtUtc: ago(30), resetsAtEpochSeconds: Math.floor(Date.parse(ago(30)) / 1000) }, attempts: delivery === "waiting" ? 0 : 1, ...(reason ? { reason } : {}) });
		put(join(LAYOUT.state, "quota-continuation.json"), { schema_version: 1, eligibility: {}, policy: { home: { enabled: true, changed_at: ago(90), actor: "operator" }, jobs: {} },
			intents: [intent("cp-quota-due", "waiting"), intent("cp-quota-held", "ambiguous", "revive refused: cannot revive cp-quota-held (tool_child_alive)")] });
	}
	const app = await buildViewer({ stateDir: join(scratch, LAYOUT.state) });
	const empty = overview({ home: scratch, stateDir: join(scratch, LAYOUT.state) }, Date.parse(GENERATED));
	const routes: Record<string, unknown> = { "/api/sessions": sessions, "/api/overview": empty, "/api/operator/control": control, [`/api/job/${JOB}`]: job, [`/api/job/${JOB}/transcript`]: jobTranscript };
	if (args.stage === "pr5" || args.stage === "m3-composer") routes["/api/skills"] = { generated_at: GENERATED, skipped: [], omitted: 0, skills: [
		{ name: "cp-pr-review", description: "Review a pull request against its task file", source: "agent" }, { name: "cp-memory", description: "Capture and curate lessons", source: "home" }] };
	// M3 slice 2: the chat's Jobs drawer lists these; a long title and id wrap, the done job opens beside the chat.
	const row = (id: string, project: string, phase: string, title: string, over: object = {}) => ({ ...job.job, id, project, phase, title, finished_at: null, ...over });
	if (args.stage === "m3-jobs" || args.stage === "m3-composer" || args.stage === "m3-fidelity-surfaces" || args.stage === "m3-fidelity-composer") routes["/api/jobs"] = { generated_at: GENERATED, awaiting_count: 0, projects: [], warnings: [], jobs: [
		row("cp-m3-live-with-a-very-long-job-identifier", "picp", "working", "Repair the queue so a very long job title keeps wrapping inside its drawer row instead of clipping", { cost_usd: 1.42, model: "fixture-model" }),
		row("cp-m3-held", picpOnly ? "picp" : "demo-app", "held", "Settings copy pass", { cost_usd: 0.31 }),
		row("cp-m3-park", "picp", "awaiting_merge", "Parked with the team", { pr_url: "https://github.com/o/picp/pull/712", pr_status: "open" }),
		row(JOB, "picp", "done", "Sessions chat v2 PR 2", { finished_today: true, finished_at: GENERATED, cost_usd: 2.05, pr_url: "https://github.com/o/picp/pull/700", pr_status: "merged" }),
	] };
	// Full match S2: the chat's context joins /api/jobs by exact worker id; one recorded clock and a long title.
	if (args.stage === "full-match-transcript") routes["/api/jobs"] = { generated_at: GENERATED, awaiting_count: 0, projects: [], warnings: [], jobs: [
		row("cp-transcript-steps-t7ah", "picp", "working", "Restyle the transcript steps so a long job title keeps wrapping inside its context card", { elapsed_seconds: 540, limit_seconds: 7200, cost_usd: 1.42, model: "fixture-model" })] };
	// Full match S3: every real group (team and queued too), seven done today for Show more, unrecorded costs and times.
	if (args.stage === "full-match-jobs") {
		const done = (id: string, title: string, at: string, cost: number | null, over: object = {}) => row(id, "picp", "done", title, { finished_today: true, finished_at: at, cost_usd: cost, model: "fixture-model", ...over });
		routes["/api/jobs"] = { generated_at: GENERATED, awaiting_count: 0, projects: [], warnings: [], jobs: [
			row("cp-transcript-steps-t7ah", "picp", "working", "Restyle the Jobs drawer toolbar, columns and rows so a long job title keeps to one line", { elapsed_seconds: 540, limit_seconds: 7200, cost_usd: 1.54, model: "fixture-model" }),
			row("cp-held-review-k2pq", "picp", "held", "Settings copy pass", { elapsed_seconds: 3720, cost_usd: 0.31, model: "fixture-model" }),
			row("cp-parked-team-p4rk", "picp", "awaiting_merge", "Parked with the team", { pr_url: "https://github.com/o/picp/pull/712", pr_status: "open" }),
			row("cp-queued-next-q8en", "picp", "queued", "Queued behind the drawer slice"),
			done(JOB, "Sessions chat v2 PR 2", "2026-10-15T15:47:00Z", 2.05, { pr_url: "https://github.com/o/picp/pull/700", pr_status: "merged" }),
			done("cp-parent-perf-audit-68u3", "Audit cp-parent turn latency, responsiveness, and performance", "2026-10-15T12:25:00Z", 5.22),
			done("cp-tool-addition-400-research-with-a-very-long-identifier-tp0b", "Research the tool_addition 400 and draft an issue", "2026-10-15T12:11:00Z", 4.5),
			done("cp-threads-aware-cdc2", "Pass dashboard thread tags through messages and bind created jobs to their thread", "2026-10-15T10:45:00Z", 2.49, { pr_url: "https://github.com/o/picp/pull/158", pr_status: "merged" }),
			done("cp-sweep-held-ci-hsze", "Sweep item 14 B1: bounded red-CI repair while the integration hold parks", "2026-10-15T10:26:00Z", 2.67, { pr_url: "https://github.com/o/picp/pull/157", pr_status: "merged" }),
			done("cp-viewer-fonts-f0nt", "Self-host the viewer fonts", "2026-10-15T09:58:00Z", null, { model: null }),
			row("cp-flaky-shard-fl4k", "picp", "failed", "Rerun the flaky shard", { finished_today: true, finished_at: "2026-10-15T09:40:00Z", cost_usd: 0.12 }),
		] };
	}
	// Every chat's context now reads /api/jobs; stages without their own list (or the real viewer's) get an empty one.
	if (!routes["/api/jobs"] && !["m3-transcript", "nav-simplify", "p3-quota", "m3-shell"].includes(args.stage)) routes["/api/jobs"] = { generated_at: GENERATED, awaiting_count: 0, projects: [], warnings: [], jobs: [] };
	// M3 slice 4: the composer menu attaches the done job's own P1 reference, as its job page's Ask would.
	if (args.stage === "m3-composer") routes[`/api/job/${JOB}`] = { ...job, ask_reference: { kind: "job", project: "picp", job_id: JOB }, evidence_lookup: { supported: true, why: "fixture" } };
	server.on("request", (req, res) => {
		const path = new URL(req.url ?? "/", "http://fixture").pathname;
		const send = (status: number, type: string, data: string | Uint8Array) => { res.writeHead(status, { "content-type": type, "content-security-policy": APP_CSP, "cache-control": "no-store" }); res.end(data); };
		if (req.method !== "GET") { posts.push(`${req.method} ${path}`); return send(405, "application/json", '{"error":"fixture is read-only"}'); }
		// PR 5: a message arrives while the reader is scrolled up — appended here, announced on the stream like the viewer's.
		if (path === "/fixture/new-message") {
			sessions.entries = [...sessions.entries, say("n1", "2026-10-15T08:07:00Z", "Assistant", "New while you were reading: PR #321 merged.")];
			for (const stream of streams) stream.write("event: refresh\ndata: sessions\n\n");
			return send(200, "application/json", "{}");
		}
		if (path === "/") return send(200, "text/html; charset=utf-8", appPage(app));
		const asset = app.assets[path];
		if (asset) return send(200, asset.mime, asset.bytes);
		if (path === "/api/stream") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
			res.write(": open\n\n"); streams.add(res); req.on("close", () => streams.delete(res));
			return;
		}
		if (path in routes) return send(200, "application/json", JSON.stringify(routes[path]));
		// M3: every other screen reads the real viewer's APIs on this scratch home (empty state, same palette check).
		if ((args.stage === "m3-transcript" || args.stage === "nav-simplify" || args.stage === "p3-quota" || args.stage === "m3-shell") && path.startsWith("/api/") && !ABSENT.has(path)) {
			return dispatch(req, res, { home: scratch, stateDir: join(scratch, LAYOUT.state), host: "127.0.0.1", port: (server.address() as AddressInfo).port, app });
		}
		if (!ABSENT.has(path) && path !== "/favicon.ico" && !path.startsWith("/manifest") && !path.endsWith(".png")) unexpected.push(path);
		send(404, "application/json", '{"error":"not in fixture"}');
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	chrome = spawn(args.chrome!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
		"--disable-background-networking", "--disable-sync", "--disable-breakpad", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
	const exited = new Promise<never>((_, reject) => { chrome!.once("error", reject); chrome!.once("exit", code => reject(new Error(`Chrome exited (${code}) before the capture finished`))); });
	exited.catch(() => {});
	const port = await deadline("Chrome startup", 20_000, Promise.race([exited, (async () => {
		for (;;) {
			try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n"); } catch { await new Promise(r => setTimeout(r, 100)); }
		}
	})()]));
	const ws = new WebSocket(`ws://127.0.0.1:${port[0]}${port[1]}`);
	await deadline("CDP connect", 10_000, new Promise((done, fail) => { ws.onopen = done; ws.onerror = () => fail(new Error("CDP socket failed")); }));
	let next = 0;
	const waiting = new Map<number, { done: (v: any) => void; fail: (e: Error) => void }>();
	ws.onmessage = event => {
		const message = JSON.parse(String(event.data));
		const wait = waiting.get(message.id);
		if (!wait) return;
		waiting.delete(message.id);
		if (message.error) wait.fail(new Error(`CDP ${message.error.message}`)); else wait.done(message.result);
	};
	let session: string | undefined;
	const cdp = (method: string, params: object = {}): Promise<any> => deadline(method, 15_000, new Promise((done, fail) => {
		const id = ++next; waiting.set(id, { done, fail }); ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
	}));
	const version = await cdp("Browser.getVersion");
	const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
	session = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
	await cdp("Page.enable");
	await cdp("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
	const evaluate = async (expression: string) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
	const until = async (what: string, expression: string) => {
		const stop = Date.now() + 15_000;
		while (!(await evaluate(expression))) { if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); }
	};
	const shots: object[] = [];
	mkdirSync(out, { recursive: true });
	/** `steps`: [script, ready expression] pairs run in order after load — real clicks on real handlers, each awaited. */
	type Step = [string | { cdp: string; params: object }, string];
	const capture = async (name: string, hash: string, width: number, height: number, theme: "light" | "dark", ready: string, scroll?: "top" | "bottom", steps: Step[] = []) => {
		await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
		await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await cdp("Page.navigate", { url: "about:blank" });
		await cdp("Page.navigate", { url: `${origin}/${hash}` });
		await until(name, `document.readyState === "complete" && !!document.querySelector(${JSON.stringify(ready)}) && document.fonts.status === "loaded"`);
		// Pending bubbles land after the first scroll-to-latest, so the fixture settles the scroller itself.
		if (scroll) await evaluate(`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop = ${scroll === "top" ? 0 : "t.scrollHeight"}; })()`);
		for (const [run, done] of steps) {
			await new Promise(r => setTimeout(r, 150));
			await (typeof run === "string" ? evaluate(run) : cdp(run.cdp, run.params));
			await until(`${name}: ${done}`, done);
		}
		await new Promise(r => setTimeout(r, 300));
		const facts = await evaluate(`(() => { const shell = document.querySelector(".shell"); const css = shell && getComputedStyle(shell);
			return { overflow: document.documentElement.scrollWidth - innerWidth, shell: shell?.className ?? null, background: css?.getPropertyValue("--background").trim() ?? null,
				color_scheme: css?.colorScheme ?? null, days: [...document.querySelectorAll(".session-day")].map(d => d.textContent),
				pending: document.querySelectorAll(".session-pending").length, pills: [...document.querySelectorAll(".session-steps > .session-tools")].map(b => b.textContent),
				open_cards: document.querySelectorAll(".session-steps-open").length, job_tab: document.querySelector(".job-detail")?.dataset.tab ?? null,
				step_names: [...document.querySelectorAll(".session-steps-open .session-steps-rows .session-tool summary > code")].map(c => c.textContent + " " + c.clientWidth + "/" + c.scrollWidth + "px"),
				clipped: [...document.querySelectorAll(".session-steps-open .session-steps-rows .session-tool summary > code")].filter(c => c.scrollWidth > c.clientWidth).map(c => c.textContent),
				summary_x: [...document.querySelectorAll(".session-steps-open .session-steps-rows")].map(card => [...new Set([...card.querySelectorAll(".session-tool > summary > span")].map(s => Math.round(s.getBoundingClientRect().left)))]),
				replies: [...document.querySelectorAll(".session-replies .session-reply")].map(b => b.textContent + (b.disabled ? " (disabled)" : "")),
				heading: document.querySelector(".session-heading")?.innerText ?? null, composer: document.querySelector(".operator-composer textarea")?.placeholder ?? null,
				columns: [".shell-sidebar", ".session-sidebar", ".session-panel"].map(s => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0)),
				chats: [...document.querySelectorAll(".session-sidebar .session-choice strong")].map(e => e.getAttribute("aria-label") ?? e.textContent),
				page_scroll: document.documentElement.scrollHeight - innerHeight, scroll_top: Math.round(document.querySelector(".session-transcript")?.scrollTop ?? -1),
				jump: !!document.querySelector(".session-new"), overlap: Math.round((document.querySelector(".session-transcript")?.getBoundingClientRect().bottom ?? 0) - (document.querySelector(".operator-composer")?.getBoundingClientRect().top ?? Infinity)),
				small_targets: [...document.querySelectorAll(".session-bar-icon, .session-bar-more > summary, .session-bar-sheet button, .session-bar-views > a, .operator-composer-box button, .operator-composer-more > summary, .session-pending-actions button")]
					.filter(e => e.getClientRects().length && e.getBoundingClientRect().height < 44).map(e => e.className || e.textContent),
				small_fields: [...document.querySelectorAll("textarea, select, input")].filter(e => e.getClientRects().length && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.getAttribute("aria-label")) }; })()`);
		if (facts.overflow > 0) throw new Error(`${name}: the page scrolls sideways by ${facts.overflow}px`);
		if (stage === "chips") {
			const chips = await evaluate(`[...document.querySelectorAll(".pr-chip")].map(c => { const body = c.closest(".session-body"); return { text: c.textContent, wide: !!body && c.getBoundingClientRect().width > body.getBoundingClientRect().width + 0.5 }; })`);
			if (chips.length !== 9) throw new Error(`${name}: ${chips.length} chips rendered, not 9`);
			const wide = chips.filter((c: { wide: boolean }) => c.wide).map((c: { text: string }) => c.text);
			if (wide.length) throw new Error(`${name}: chips wider than their bubble: ${wide.join(", ")}`);
		}
		if (stage === "notice") {
			const display = await evaluate(`[".session-bridge a.pr-chip", ".session-bubble a.pr-chip"].map(s => { const c = document.querySelector(s); return c ? getComputedStyle(c).display : "missing"; })`);
			if (display.join() !== "inline-flex,inline-flex") throw new Error(`${name}: notice and card chips display ${display.join(", ")}, not inline-flex`);
		}
		if (stage === "rollup") {
			const card = await evaluate(`(() => { const t = document.querySelector(".session-rollup-toggle"), m = document.querySelector(".session-rollup-meta"); return { cards: document.querySelectorAll(".session-rollup").length, toggle: t ? t.getBoundingClientRect().height : 0, chips: document.querySelectorAll(".session-rollup .pr-chip").length, meta: m ? m.getBoundingClientRect().height : 0, wraps: m ? m.scrollWidth > m.clientWidth : true }; })()`);
			if (card.cards !== 1 || card.chips < 1) throw new Error(`${name}: ${card.cards} rollups (${card.chips} chips), not one with its PR chip`);
			if (!name.includes("open") && card.chips !== 1) throw new Error(`${name}: the rollup shows its PR chip ${card.chips} times, not once`);
			if (card.meta > 48 || card.wraps) throw new Error(`${name}: the rollup meta line is ${card.meta}px tall or overflows, not one line`);
			if (width < 900 && card.toggle < 44) throw new Error(`${name}: the rollup toggle is ${card.toggle}px tall, under 44`);
		}
		if (facts.clipped.length) throw new Error(`${name}: step names clipped: ${facts.clipped.join(", ")}`);
		if (facts.summary_x.some((xs: number[]) => xs.length > 1)) throw new Error(`${name}: step summaries start at ${JSON.stringify(facts.summary_x)}, not one x per card`);
		if (stage === "pr5" && facts.page_scroll > 0) throw new Error(`${name}: the page scrolls by ${facts.page_scroll}px`);
		if (stage === "pr5" && facts.overlap > 0) throw new Error(`${name}: the transcript runs ${facts.overlap}px under the composer`);
		if (stage === "pr5" && width < 900 && facts.small_targets.length) throw new Error(`${name}: targets under 44 px: ${facts.small_targets.join(", ")}`);
		if (stage === "pr5" && width < 900 && facts.small_fields.length) throw new Error(`${name}: fields under 16 px: ${facts.small_fields.join(", ")}`);
		const png = (await cdp("Page.captureScreenshot", { format: "png" })).data as string;
		const file = join(out, `${name}.png`);
		writeFileSync(file, Buffer.from(png, "base64"));
		shots.push({ file, hash, width, height, theme, scroll: scroll ?? null, steps: steps.map(([run]) => typeof run === "string" ? run : `${run.cdp} ${JSON.stringify(run.params)}`), ...facts });
		await evaluate("localStorage.clear()");
	};
	const transcript = "#sessions?view=you&transcript=1";
	const loaded = ".session-entries .session-pending";
	const stage = args.stage!;
	for (const [device, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
		for (const theme of ["dark", "light"] as const) {
			// Scroll only the transcript to the rollup: the card's head sits above the bottom-pinned view.
			const toRollup: Step = [`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(".session-rollup").getBoundingClientRect().top - t.getBoundingClientRect().top - 48; })()`, "true"];
			await capture(`${stage}-${device}-${theme}-${width}x${height}`, transcript, width, height, theme, loaded, "bottom", stage === "rollup" ? [toRollup] : []);
			if (stage === "pr1") await capture(`pr1-${device}-${theme}-top-${width}x${height}`, transcript, width, height, theme, loaded, "top");
			if (stage === "chips") await capture(`chips-${device}-${theme}-first-${width}x${height}`, transcript, width, height, theme, loaded, "bottom",
				[[`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(".pr-chip").closest(".session-entry, .session-bubble").getBoundingClientRect().top - t.getBoundingClientRect().top - 24; })()`, "true"]]);
			if (stage === "rollup") await capture(`rollup-open-${device}-${theme}-${width}x${height}`, transcript, width, height, theme, loaded, "bottom",
				[[`document.querySelector(".session-rollup-toggle").click()`, `document.querySelector(".session-rollup-toggle").getAttribute("aria-expanded") === "true"`], toRollup]);
		}
	}
	if (stage === "pr1") {
		await capture("pr1-overview-light-control-1440x1000", "#overview", 1440, 1000, "light", ".shell");
		const leak = shots.at(-1) as { background: string };
		if (leak.background !== "#0d0d0d") throw new Error(`Overview left the dark palette (${leak.background})`);
	} else if (stage !== "chips" && stage !== "rollup") {
		const wakeRun = ".session-steps:has(.session-bridge)";
		const notice = `document.querySelector("${wakeRun} .session-notice-line").click()`, pill = `document.querySelector("${wakeRun} > .session-tools").click()`;
		// Scroll only the transcript: scrollIntoView would also pan the phone's visual viewport.
		const centre = [`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector("${wakeRun}").getBoundingClientRect().top - t.getBoundingClientRect().top - 140; })()`, "true"] as [string, string];
		for (const theme of ["dark", "light"] as const) {
			await capture(`${stage}-steps-${theme}-1440x1100`, transcript, 1440, 1100, theme, loaded, "bottom", [[`${notice}; ${pill}`, `!!document.querySelector(".session-steps-open .session-notice-rest")`], centre]);
			if (stage === "pr2") await capture(`pr2-job-transcript-phone-${theme}-390x844`, transcript, 390, 844, theme, loaded, "bottom", [[pill, `!!document.querySelector(".session-steps-link")`],
				[`document.querySelector(".session-steps-link").click()`, `document.querySelector(".job-detail")?.dataset.tab === "transcript" && !!document.querySelector(".jt-say")`]]);
		}
		if (stage === "pr2") {
			await capture("pr2-notice-only-phone-dark-390x844", transcript, 390, 844, "dark", loaded, "bottom", [[notice, `!!document.querySelector(".session-steps .session-notice-rest") && !document.querySelector(".session-steps-open")`], centre]);
			await capture("pr2-tools-on-desktop-dark-1440x1000", transcript, 1440, 1000, "dark", loaded, "bottom", [[`document.querySelector(".session-tools-toggle").click()`, `!document.querySelector(".session-steps > .session-tools") && document.querySelectorAll(".session-steps-open").length === 3`]]);
			await capture("pr2-job-default-phone-dark-390x844", `#job/${JOB}`, 390, 844, "dark", ".job-detail[data-tab=details]");
		}
	}
	if (stage === "pr3") {
		const base = shots.find(s => (s as { file: string }).file.endsWith("pr3-desktop-dark-1440x1000.png")) as { columns: number[] };
		// Combine (m3-shell) replaced the 208 px rail + 281 px Chats with one 261 px column.
		if (base.columns.join() !== "0,261,1179") throw new Error(`pr3: rail, Chats and conversation are ${base.columns.join(" + ")} px, not 0 + 261 + 1179`);
		// Step names at phone width too: cp_integrate and fetch_content fit their column (the run fails on a clipped one).
		await capture("pr3-steps-phone-dark-390x844", transcript, 390, 844, "dark", loaded, "bottom", [[`document.querySelector(".session-steps:has(.session-bridge) > .session-tools").click()`, `!!document.querySelector(".session-steps-open")`],
			[`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(".session-steps-open").getBoundingClientRect().top - t.getBoundingClientRect().top - 60; })()`, "true"]]);
		const chats = (name: string, theme: "dark" | "light", steps: [string, string][]) => capture(`pr3-${name}-desktop-${theme}-1440x1000`, transcript, 1440, 1000, theme, loaded, "bottom", steps);
		sessions.workers = [];
		await chats("fleet-empty", "light", []);
		sessions.workers = workers;
		if (posts.length) throw new Error(`pr3 sent ${posts.join(", ")}: the Chats list must request nothing`);
	}
	if (stage === "pr4") {
		const chips = `document.querySelectorAll(".session-replies .session-reply").length === 3`, at = (selector: string): [string, string] =>
			[`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector("${selector}").getBoundingClientRect().top - t.getBoundingClientRect().top - 260; })()`, "true"];
		for (const theme of ["dark", "light"] as const) {
			await capture(`pr4-replies-desktop-${theme}-1440x1000`, transcript, 1440, 1000, theme, loaded, "bottom", [["true", chips], at(".session-replies")]);
			await capture(`pr4-replies-phone-${theme}-390x844`, transcript, 390, 844, theme, loaded, "bottom", [["true", chips], at(".session-replies")]);
		}
		// Step names at phone width: cp_integrate and fetch_content fit, every summary at one x (the run fails otherwise).
		await capture("pr4-steps-phone-dark-390x844", transcript, 390, 844, "dark", loaded, "bottom", [[`document.querySelector(".session-steps:has(.session-bridge) > .session-tools").click()`, `!!document.querySelector(".session-steps-open")`], at(".session-steps-open")]);
		// The ⋮ menu carries the transcript file picker and Tools N above the shell's rows.
		await capture("pr4-header-menu-desktop-dark-1440x1000", transcript, 1440, 1000, "dark", loaded, "bottom", [[`document.querySelector(".page-header .shell-more > summary").click()`,
			`!!document.querySelector(".shell-more[open] .session-menu .session-file-picker") && !!document.querySelector(".shell-more[open] .session-menu .session-tools-toggle")`]]);
		// A chip is one exact answer POST; this read-only fixture refuses it, so the failure line shows and the chips re-enable.
		await capture("pr4-reply-failed-desktop-dark-1440x1000", transcript, 1440, 1000, "dark", loaded, "bottom", [["true", chips], [`document.querySelector(".session-reply").click()`, `!!document.querySelector(".session-replies-failed") && !document.querySelector(".session-reply").disabled`], at(".session-replies")]);
		if (posts.join() !== "POST /api/operator/message") throw new Error(`pr4: a chip click sent ${posts.join(", ") || "nothing"}, not one answer`);
		const [entriesBefore, asksBefore] = [sessions.entries, sessions.open_asks!];
		const second = asked("ask-pr4b", "Also rotate the fixture token?");
		sessions.entries = [...entriesBefore, askCard(second, "2026-10-15T08:04:50Z")]; sessions.open_asks = [...asksBefore, second];
		await capture("pr4-two-asks-desktop-dark-1440x1000", transcript, 1440, 1000, "dark", loaded, "bottom", [["true", `!document.querySelector(".session-replies")`]]);
		sessions.entries = entriesBefore; sessions.open_asks = asksBefore;
		sessions.operator_sessions = [{ id: "op-newer.jsonl", at: GENERATED }, { id: "op.jsonl", at: "2026-10-15T08:00:00Z" }];
		await capture("pr4-history-desktop-light-1440x1000", transcript, 1440, 1000, "light", loaded, "bottom", [["true", `!document.querySelector(".session-replies") && /Historical transcript/.test(document.querySelector(".session-heading").innerText)`]]);
		sessions.operator_sessions = [{ id: "op.jsonl", at: GENERATED }];
		routes["/api/operator/control"] = { ...control, running: false, offline: true, busy: false, pending: false, token: null, inbox_token: "i".repeat(64) };
		await capture("pr4-offline-phone-dark-390x844", transcript, 390, 844, "dark", loaded, "bottom");
		routes["/api/operator/control"] = control;
	}
	if (stage === "pr5") {
		const phone = (name: string, steps: Step[], scroll: "top" | "bottom" = "bottom", height = 844) => capture(`pr5-${name}-phone-dark-390x${height}`, transcript, 390, height, "dark", loaded, scroll, steps);
		const more = `document.querySelector(".session-bar-more > summary").click()`, opened = `!!document.querySelector(".session-bar-more[open] .session-bar-sheet")`;
		// Every action the phone moved out of the composer and heading: one ⋯ sheet, the state line first.
		await phone("menu", [[more, opened]]);
		await capture("pr5-menu-phone-light-390x844", transcript, 390, 844, "light", loaded, "bottom", [[more, opened]]);
		// Escape closes the sheet and hands focus back to ⋯ (the Sessions screen's document handler, not a reload).
		await phone("menu-escape", [[`(() => { const s = document.querySelector(".session-bar-more > summary"); s.focus(); s.click(); })()`, opened],
			[`document.querySelector(".session-bar-more").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
				`!document.querySelector(".session-bar-more[open]") && document.activeElement === document.querySelector(".session-bar-more > summary")`]]);
		await phone("pending-edit", [[`document.querySelector(".session-pending-edit").click()`, `!!document.querySelector(".session-pending-editor textarea")`],
			[`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop = t.scrollHeight; })()`, "true"]]);
		await phone("skills", [[`(() => { const i = document.querySelector(".operator-composer textarea"); i.focus(); i.value = "Run @cp"; i.setSelectionRange(7, 7); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
			`document.querySelectorAll(".operator-composer-skills [role=option]").length === 2`]]);
		// The keyboard shortens the layout viewport; the composer stays on screen, then the full height comes back unscrolled.
		const keyboard = { cdp: "Emulation.setDeviceMetricsOverride", params: { width: 390, height: 480, deviceScaleFactor: 1, mobile: true } };
		const focus: Step = [`document.querySelector(".operator-composer textarea").focus()`, `document.activeElement?.matches(".operator-composer textarea")`];
		await phone("keyboard", [focus, [keyboard, `innerHeight === 480 && document.querySelector(".operator-composer").getBoundingClientRect().bottom <= 480`]]);
		await phone("keyboard-restored", [focus, [keyboard, "innerHeight === 480"], [{ ...keyboard, params: { ...keyboard.params, height: 844 } },
			`innerHeight === 844 && document.querySelector(".operator-composer").getBoundingClientRect().bottom <= 844 && scrollY === 0`]]);
		// Scrolled up, a new message lands: the reader keeps their place and Jump to latest appears (no auto-scroll).
		const reader = `document.querySelector(".session-transcript").scrollTop`;
		await phone("new-message", [[`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop = 400; window.cpReader = t.scrollTop; })()`, "!!document.querySelector('.session-new')"],
			[`fetch("/fixture/new-message")`, `/New while you were reading/.test(document.querySelector(".session-entries").textContent) && Math.abs(${reader} - window.cpReader) < 2 && !!document.querySelector(".session-new")`]], "top");
		sessions.entries = sessions.entries.filter(e => e.id !== "n1");
		await phone("jump-latest", [[`document.querySelector(".session-transcript").scrollTop = 400`, "!!document.querySelector('.session-new')"],
			[`document.querySelector(".session-new").click()`, `!document.querySelector(".session-new")`]], "top");
		if (posts.length) throw new Error(`pr5 sent ${posts.join(", ")}: menus, filters, edits and the keyboard must request nothing`);
	}
	if (stage === "m3-transcript") {
		// All eight other screens on both devices and both scheme preferences: one dark palette, layouts unchanged.
		const screens = [["overview", ".overview"], ["decisions", ".decisions"], ["jobs", ".jobs-screen"], ["stats", ".stats"], ["settings", ".settings-screen"],
			["reports", ".jobs-screen"], ["files", ".files"], ["map", ".map-screen"]] as const;
		for (const [device, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
			for (const theme of ["dark", "light"] as const) for (const [id, root] of screens) await capture(`m3-${id}-${device}-${theme}-${width}x${height}`, `#${id}`, width, height, theme, `.shell-main > ${root}`);
		}
		const off = (shots as Array<{ file: string; background: string; color_scheme: string }>).filter(s => s.background !== "#0d0d0d" || s.color_scheme !== "dark");
		if (off.length) throw new Error(`m3: not the dark palette: ${off.map(s => `${s.file} ${s.background} ${s.color_scheme}`).join(", ")}`);
	}
	if (stage === "m3-jobs") {
		// Real clicks and a CDP Ctrl+J (modifiers 2) on the chat; each capture fails on a target under 44 px or off screen.
		const listed = `document.querySelectorAll(".workspace-jobs[open] .workspace-jobs-row").length === 4`;
		const key: Step = [{ cdp: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: 2 } }, listed];
		const open: Step = [`document.querySelector(".workspace-jobs-open").click()`, listed];
		const pick: Step = [`[...document.querySelectorAll(".workspace-jobs-row")].find(b => b.textContent.includes("${JOB}")).click()`,
			`!document.querySelector(".workspace-jobs") && !!document.querySelector(".workspace-job .job-detail-embedded .job-badges")`];
		const escape: Step = [{ cdp: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } },
			`!document.querySelector(".workspace-job") && document.activeElement === document.querySelector(".workspace-jobs-open")`];
		// The last step waits until no surface target is under 44 px or off screen; a clipped one times the capture out.
		const fits: Step = ["true", `[...document.querySelectorAll(".workspace-close, .workspace-full, .workspace-jobs-row, .workspace-jobs .jobs-segments button, .workspace-jobs select")]
			.filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.left >= -0.5 && r.right <= innerWidth + 0.5; })`];
		const shots3: [string, number, number, Step[]][] = [
			["drawer-desktop-dark-1440x1000", 1440, 1000, [key]], ["job-desktop-dark-1440x1000", 1440, 1000, [open, pick]],
			["escape-desktop-dark-1440x1000", 1440, 1000, [open, pick, escape]], ["job-desktop-dark-900x1000", 900, 1000, [open, pick]],
			["drawer-desktop-dark-900x1000", 900, 1000, [open]], ["drawer-phone-dark-899x1000", 899, 1000, [open]],
			["drawer-phone-dark-390x844", 390, 844, [open]], ["job-phone-dark-390x844", 390, 844, [open, pick]],
		];
		for (const [name, width, height, steps] of shots3) await capture(`m3-jobs-${name}`, transcript, width, height, "dark", loaded, "bottom", [...steps, fits]);
		if (posts.length) throw new Error(`m3-jobs sent ${posts.join(", ")}: the drawer and pane only read`);
	}
	if (stage === "m3-context") {
		// Real clicks open the context (inspector from 900 px, sheet below) and the phone's Conversations drawer.
		const asked = `!!document.querySelector(".workspace-context .workspace-context-ask")`;
		const context: Step = [`document.querySelector(".workspace-context-open[aria-expanded=false]")?.click()`, asked];
		const drawer: Step = [`document.querySelector(".workspace-sessions-open").click()`, `!!document.querySelector(".workspace-sessions[open] .session-choice")`];
		const fits: Step = ["true", `[...document.querySelectorAll(".workspace-close, .workspace-context-open, .workspace-sessions-open, .workspace-context button, .workspace-context a, .workspace-sessions .session-choice")]
			.filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5; })`];
		const shots3: [string, number, number, Step[]][] = [
			["inspector-desktop-dark-1440x1000", 1440, 1000, [context]], ["inspector-desktop-dark-900x1000", 900, 1000, [context]],
			["sheet-phone-dark-899x1000", 899, 1000, [context]], ["sheet-phone-dark-390x844", 390, 844, [context]], ["conversations-phone-dark-390x844", 390, 844, [drawer]],
		];
		for (const [name, width, height, steps] of shots3) await capture(`m3-context-${name}`, transcript, width, height, "dark", loaded, "bottom", [...steps, fits]);
		if (posts.length) throw new Error(`m3-context sent ${posts.join(", ")}: the context and drawer only read`);
	}
	if (stage === "m3-composer") {
		// Real clicks and input: the `/` menu, the typed list, /status and a P1 reference. Five menu buttons: 2 commands,
		// the 2 in-flight `/api/jobs` rows above (working, held) and JOB done today; cp-m3-park is With the team.
		const slash: Step = [`document.querySelector(".operator-composer-slash").click()`, `document.querySelectorAll("#operator-composer-command-menu button").length === 5`];
		const typed: Step = [`(() => { const i = document.querySelector(".operator-composer textarea"); i.focus(); i.value = "/"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
			`document.querySelectorAll(".operator-composer-skills [role=option]").length === 2`];
		const status: Step = [`[...document.querySelectorAll("#operator-composer-command-menu button")].find(b => b.textContent.startsWith("/status")).click()`,
			`document.querySelector(".operator-composer textarea").value === "What is running and what needs me?"`];
		const refer: Step = [`[...document.querySelectorAll("#operator-composer-command-menu button")].find(b => b.textContent.startsWith("${JOB}")).click()`, `!!document.querySelector(".evidence-chip")`];
		const fits: Step = ["true", `[...document.querySelectorAll(".operator-composer-slash, #operator-composer-command-menu button, .operator-composer-skills [role=option]")]
			.filter(e => e.getClientRects().length).every(e => { const r = e.getBoundingClientRect(); return (innerWidth >= 900 || r.height >= 44) && r.top >= 0 && r.left >= -0.5 && r.right <= innerWidth + 0.5; })`];
		const shots4: [string, number, number, Step[]][] = [
			["menu-desktop-dark-1440x1000", 1440, 1000, [slash]], ["typed-desktop-dark-1440x1000", 1440, 1000, [typed]],
			["status-desktop-dark-1440x1000", 1440, 1000, [slash, status]], ["reference-desktop-dark-1440x1000", 1440, 1000, [slash, refer]],
			["menu-desktop-dark-900x1000", 900, 1000, [slash]], ["menu-phone-dark-899x1000", 899, 1000, [slash]],
			["menu-phone-dark-390x844", 390, 844, [slash]], ["typed-phone-dark-390x844", 390, 844, [typed]], ["reference-phone-dark-390x844", 390, 844, [slash, refer]],
		];
		for (const [name, width, height, steps] of shots4) await capture(`m3-composer-${name}`, transcript, width, height, "dark", loaded, "bottom", [...steps, fits]);
		if (posts.length) throw new Error(`m3-composer sent ${posts.join(", ")}: commands and references never send`);
	}
	if (stage === "nav-simplify") {
		// Chat, Jobs and More are the only visible primary items either side of 900 px; More shows all seven rows at every width.
		const fits = (lit: string, rows: number): Step => ["true", `(() => { const shown = [...document.querySelectorAll(".shell-sidebar-nav > a, .shell-tabs a")].filter(a => a.getClientRects().length);
			return shown.map(a => a.textContent).join() === "Chat,Jobs,More" && shown.find(a => a.getAttribute("aria-current") === "page")?.textContent === "${lit}"
				&& [...document.querySelectorAll(".more-menu > a")].filter(a => a.getClientRects().length).length === ${rows}; })()`];
		const shots5: [string, string, string, number, number, number][] = [
			["more-phone-dark-390x844", "#more", ".more-menu", 390, 844, 7], ["more-phone-dark-899x1000", "#more", ".more-menu", 899, 1000, 7],
			["more-desktop-dark-900x1000", "#more", ".more-menu", 900, 1000, 7], ["more-desktop-dark-1440x1000", "#more", ".more-menu", 1440, 1000, 7],
			["jobs-phone-dark-390x844", "#jobs", ".jobs-heading", 390, 844, 0], ["jobs-desktop-dark-1440x1000", "#jobs", ".jobs-heading", 1440, 1000, 0],
			["history-desktop-dark-1440x1000", "#jobs?view=history", ".jobs-history-link", 1440, 1000, 0], ["map-phone-dark-390x844", "#map", ".map-screen", 390, 844, 0],
			["overview-phone-dark-390x844", "#overview", ".overview", 390, 844, 0], ["overview-desktop-dark-1440x1000", "#overview", ".overview", 1440, 1000, 0],
			["chat-desktop-dark-1440x1000", transcript, loaded, 1440, 1000, 0],
		];
		for (const [name, hash, ready, width, height, rows] of shots5) {
			const lit = hash.startsWith("#sessions") ? "Chat" : hash.startsWith("#jobs") || hash === "#map" ? "Jobs" : "More";
			await capture(`nav-${name}`, hash, width, height, "dark", ready, hash === transcript ? "bottom" : undefined, [fits(lit, rows)]);
		}
		if (posts.length) throw new Error(`nav-simplify sent ${posts.join(", ")}: navigation only reads`);
	}
	if (stage === "p3-quota") {
		// The Job page's Quota continuation fact centred on screen; each capture fails unless it reads its state and fits.
		const fact = (text: string): Step[] => [[`document.querySelector(".job-fact-quota").scrollIntoView({ block: "center" })`, "true"],
			["true", `(() => { const f = document.querySelector(".job-fact-quota"), r = f.getBoundingClientRect();
			return f.textContent.includes("unsupported in production") && f.textContent.includes(${JSON.stringify(text)}) && r.left >= -0.5 && r.right <= innerWidth + 0.5; })()`]];
		for (const [device, width, height] of [["phone", 390, 844], ["desktop", 1440, 1000]] as const) {
			await capture(`p3-quota-overdue-${device}-dark-${width}x${height}`, "#job/cp-quota-due", width, height, "dark", ".job-fact-quota", undefined, fact("waiting · overdue"));
			await capture(`p3-quota-held-${device}-dark-${width}x${height}`, "#job/cp-quota-held", width, height, "dark", ".job-fact-quota", undefined, fact("held for the operator"));
		}
		if (posts.length) throw new Error(`p3-quota sent ${posts.join(", ")}: the Job page only reads`);
	}
	if (stage === "m3-shell") {
		// Combine: [shell rail, chat column, conversation] widths; Context open at 1440 leaves 1440 - 261 - 340.
		const context: Step = [`document.querySelector(".workspace-context-open[aria-expanded=false]")?.click()`, `!!document.querySelector("aside.workspace-context .workspace-context-ask")`];
		const family = `(() => { const s = document.querySelector(".stats select"); return !!s && getComputedStyle(s).fontFamily === getComputedStyle(document.body).fontFamily; })()`;
		const shots6: [string, string, string, number, number, Step[], string][] = [
			["desktop-dark-1440x1000", transcript, loaded, 1440, 1000, [context], "0,261,839"], ["900-dark-900x1000", transcript, loaded, 900, 1000, [], "0,261,639"],
			["899-dark-899x1000", transcript, loaded, 899, 1000, [], "0,0,899"], ["phone-dark-390x844", transcript, loaded, 390, 844, [], "0,0,390"],
			["more-dark-1440x1000", "#more", ".more-menu", 1440, 1000, [], "208,0,0"], ["stats-dark-1440x1000", "#stats", ".stats select", 1440, 1000, [["true", family]], "208,0,0"],
		];
		for (const [name, hash, ready, width, height, steps, want] of shots6) {
			await capture(`m3-shell-${name}`, hash, width, height, "dark", ready, hash === transcript ? "bottom" : undefined, steps);
			const got = (shots.at(-1) as { columns: number[] }).columns.join();
			if (got !== want) throw new Error(`m3-shell-${name}: rail, chat column and conversation are ${got} px, not ${want}`);
		}
		const lit = await evaluate(`[...document.querySelectorAll(".shell-sidebar-nav > a")].filter(a => a.getClientRects().length).map(a => a.textContent).join()`);
		if (lit !== "Chat,Jobs,More") throw new Error(`m3-shell: Stats shows ${lit} as navigation, not Chat,Jobs,More`);
		if (posts.length) throw new Error(`m3-shell sent ${posts.join(", ")}: layout and navigation only read`);
	}
	if (stage === "m3-fidelity-transcript") {
		// Computed styles on each capture: an unboxed reply, the neutral own bubble, an inline steps rail with 28 px rows,
		// and the pending sends and open ask still boxed apart. Negative control: a filled reply or rail fails here.
		const open: Step = [`document.querySelector(".session-steps:has(.session-bridge) > .session-tools").click()`, `!!document.querySelector(".session-steps-open .session-steps-rows")`];
		const centre: Step = [`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(".session-steps-open").getBoundingClientRect().top - t.getBoundingClientRect().top - 120; })()`, "true"];
		const look = `(() => { const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
			const reply = cs(".session-other > .session-body"), own = cs(".session-own:not(.session-pending) > .session-body"), p = cs(".session-other > .session-body p");
			const rail = cs(".session-steps-open > .session-steps-card"), row = document.querySelector(".session-steps-open .session-steps-rows .session-tool > summary");
			const box = s => { const c = cs(s); return c && [c.backgroundColor, c.borderTopStyle, c.borderTopWidth].join(" "); };
			return { reply: reply && [reply.backgroundColor, reply.borderRadius, reply.padding, reply.borderTopWidth].join(" "), own: own && [own.backgroundColor, own.color, own.borderRadius].join(" "),
				text: p && p.fontSize + "/" + p.lineHeight, rail: rail && [rail.backgroundColor, rail.borderRadius, rail.padding, rail.borderLeftStyle, rail.borderLeftWidth].join(" "),
				row: row && Math.round(row.getBoundingClientRect().height) + " " + getComputedStyle(row).fontSize + "/" + getComputedStyle(row).lineHeight,
				queued: box(".session-pending:not(.session-pending-failed) > .session-body"), failed: box(".session-pending-failed > .session-body"),
				ask: box(".session-message.session-notice:has(.session-oneline)" + (innerWidth < 900 ? "" : " > .session-body")) }; })()`;
		const shotsB: [string, number, number, Step[]][] = [["desktop", 1440, 1000, []], ["phone", 390, 844, []], ["steps-desktop", 1440, 1000, [open, centre]], ["steps-phone", 390, 844, [open, centre]]];
		for (const [name, width, height, steps] of shotsB) {
			await capture(`m3-fidelity-transcript-${name}`, transcript, width, height, "dark", loaded, "bottom", steps);
			const got = await evaluate(look), want = { reply: "rgba(0, 0, 0, 0) 0px 0px 0px", own: "rgb(42, 42, 42) rgb(237, 237, 237) 16px 16px 4px", text: width < 900 ? "15px/23px" : "14px/22px",
				rail: steps.length ? "rgba(0, 0, 0, 0) 0px 2px 0px 2px 12px solid 2px" : null, row: steps.length ? "28 12.5px/18px" : null,
				queued: "rgb(22, 22, 22) dashed 1px", failed: "rgb(22, 22, 22) solid 1px", ask: "rgb(22, 22, 22) solid 1px" };
			const off = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${JSON.stringify(got[k])} (want ${JSON.stringify(v)})`);
			if (off.length) throw new Error(`m3-fidelity-transcript-${name}: ${off.join("; ")}`);
		}
		if (posts.length) throw new Error(`m3-fidelity-transcript sent ${posts.join(", ")}: the transcript only reads`);
	}
	if (stage === "m3-fidelity-surfaces") {
		// A real reply-link click keeps Chat mounted and opens the embedded Transcript; then the surfaces' measured boxes.
		// Negative control: without the reply callback the click leaves for the job route and the log steps time out.
		const log: Step[] = [[`document.querySelector(".session-steps:has(.session-bridge) > .session-tools").click()`, `!!document.querySelector(".session-steps-link")`],
			[`document.querySelector(".session-steps-link").click()`, `!!document.querySelector(".sessions > .workspace-job .job-detail-embedded[data-tab=transcript] .jt-say") && location.hash === ${JSON.stringify(transcript)}`]];
		const jobs: Step = [`document.querySelector(".workspace-jobs-open").click()`, `document.querySelectorAll(".workspace-jobs[open] .workspace-jobs-row").length === 4`];
		const context: Step = [`document.querySelector(".workspace-context-open").click()`, `!!document.querySelector("dialog.workspace-context-sheet[open] .workspace-context-ask")`];
		const drawer: Step = [`document.querySelector(".workspace-sessions-open").click()`, `!!document.querySelector(".workspace-sessions[open] .session-choice")`];
		const box = (selector: string) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
			return [r.left, r.top, r.width, r.height].map(Math.round).join(" ") + " " + getComputedStyle(e).backgroundColor; })()`;
		const shotsC: [string, number, number, Step[], string, string][] = [
			["log-desktop", 1440, 1000, log, ".workspace-job", "919 0 521 1000 rgb(13, 13, 13)"], ["log-phone", 390, 844, log, ".workspace-job", "0 0 390 844 rgb(13, 13, 13)"],
			["jobs-desktop", 1440, 1000, [jobs], ".workspace-jobs", "579 0 861 1000 rgb(22, 22, 22)"], ["jobs-phone", 390, 844, [jobs], ".workspace-jobs", "0 96 390 748 rgb(18, 18, 18)"],
			["context-phone", 390, 844, [context], ".workspace-context-sheet", "0 96 390 748 rgb(18, 18, 18)"],
			["conversations-phone", 390, 844, [drawer], ".workspace-sessions", "0 0 317 844 rgb(18, 18, 18)"],
		];
		for (const [name, width, height, steps, selector, want] of shotsC) {
			await capture(`m3-fidelity-surfaces-${name}`, transcript, width, height, "dark", loaded, "bottom", steps);
			const got = await evaluate(box(selector));
			if (got !== want) throw new Error(`m3-fidelity-surfaces-${name}: ${selector} is ${got}, not ${want}`);
		}
		if (posts.length) throw new Error(`m3-fidelity-surfaces sent ${posts.join(", ")}: the log and surfaces only read`);
	}
	if (stage === "m3-fidelity-composer") {
		// Design frames 1/4/5/6/7/10: the box in the transcript column with `.cb` padding, a 20 px avatar and text 28 px in,
		// the raised padding-6 menu from the box's edge, the ask fill. Negative control: a surface/padding-4 menu fails.
		const slash: Step = [`document.querySelector(".operator-composer-slash").click()`, `document.querySelectorAll("#operator-composer-command-menu button").length === 5`];
		const context: Step = [`document.querySelector(".workspace-context-open[aria-expanded=false]")?.click()`, `!!document.querySelector(".workspace-context .workspace-context-ask")`];
		const reply: Step = [`(() => { const t = document.querySelector(".session-transcript"), m = [...document.querySelectorAll(".session-message.session-other")].at(-1);
			t.scrollTop += m.getBoundingClientRect().top - t.getBoundingClientRect().top - 120; })()`, "true"];
		const look = `(() => { const q = s => document.querySelector(s), r = s => q(s)?.getBoundingClientRect(), cs = s => q(s) && getComputedStyle(q(s)), n = Math.round;
			const box = r(".operator-composer-box"), list = r(".session-entries"), pad = cs(".session-entries"), avatar = r(".session-other > .session-who > .session-avatar");
			const left = list.left + parseFloat(pad.paddingLeft), right = list.right - parseFloat(pad.paddingRight), menu = r("#operator-composer-command-menu"), ask = cs(".workspace-context-ask");
			return { composer: [n(box.left - left), n(right - box.right), n(box.width), cs(".operator-composer-box").padding].join(" "),
				avatar: avatar.width + "x" + avatar.height + " inset " + n(r(".session-other > .session-body").left - r(".session-message.session-other").left),
				menu: menu ? [n(menu.left - box.left), n(menu.width), cs("#operator-composer-command-menu").backgroundColor, cs("#operator-composer-command-menu").padding].join(" ") : null,
				ask: ask ? [ask.backgroundColor, ask.borderRadius, ask.padding].join(" ") : null }; })()`;
		const shotsD: [string, number, number, Step[], object][] = [
			["desktop", 1440, 1000, [], { composer: "0 0 664 14px 12px 10px 16px", avatar: "20x20 inset 28" }],
			["phone", 390, 844, [reply], { composer: "0 0 362 0px", avatar: "20x20 inset 34" }],
			["menu-desktop", 1440, 1000, [slash], { menu: "0 534 rgb(27, 27, 27) 6px" }], ["menu-phone", 390, 844, [slash], { menu: "0 362 rgb(27, 27, 27) 6px" }],
			["ask-desktop", 1440, 1000, [context], { ask: "rgb(31, 26, 18) 12px 12px" }], ["ask-phone", 390, 844, [context], { ask: "rgb(31, 26, 18) 12px 12px" }],
		];
		for (const [name, width, height, steps, want] of shotsD) {
			await capture(`m3-fidelity-composer-${name}`, transcript, width, height, "dark", loaded, "bottom", steps);
			const got = await evaluate(look);
			const off = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${JSON.stringify(got[k])} (want ${JSON.stringify(v)})`);
			if (off.length) throw new Error(`m3-fidelity-composer-${name}: ${off.join("; ")}`);
		}
		if (posts.length) throw new Error(`m3-fidelity-composer sent ${posts.join(", ")}: the menu and context only read`);
	}
	if (stage === "full-match-shell") {
		// Full match S1 (frames 1/6/11) per capture. Negative controls: a closed inspector fails `inspector` at 1440; a 48 px
		// bar or 14 px sides fail `phone`, a one-row composer `field`, an idle worker counted as working `strip`.
		const look = `(() => { const q = s => document.querySelector(s), h = s => Math.round(q(s)?.getBoundingClientRect().height ?? 0), cs = s => q(s) && getComputedStyle(q(s)), r = s => q(s).getBoundingClientRect();
			const shown = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
			return { inspector: !!q("aside.workspace-context"), sheet: !!q("dialog[open]"), heading: h(".session-heading"), bar: h(".session-bar"),
				rail: shown(".session-sidebar .shell-icon-nav > a").map(a => a.textContent).join(), drawer: shown(".workspace-sessions[open] .shell-icon-nav > a").map(a => a.textContent).join(),
				sides: innerWidth < 900 ? cs(".operator-composer").paddingLeft + " " + cs(".session-entries").paddingLeft : null,
				field: innerWidth < 900 ? (() => { const t = r(".operator-composer textarea"), f = r(".operator-composer-footer"), b = q(".operator-composer-box"), p = cs(".operator-composer-box");
					const inner = b.clientWidth - parseFloat(p.paddingLeft) - parseFloat(p.paddingRight);
					return [p.borderTopLeftRadius, t.bottom <= f.top + 0.5 ? "field over footer" : "one row", t.width >= inner - 32 ? "full width" : "narrow"].join(" "); })() : null,
				strip: innerWidth < 900 ? shown(".session-strip-count, .session-strip-job").map(e => e.textContent).join(" ") : null,
				jobs: shown(".session-heading .workspace-jobs-open kbd").length ? q(".workspace-jobs-open").textContent + " " + q(".workspace-jobs-open").title : null,
				drawer_width: Math.round(q(".workspace-sessions[open]")?.getBoundingClientRect().width ?? 0),
				small: shown(".session-filter-menu > summary, .workspace-jobs-open, .workspace-context-open, .session-bar-icon, .workspace-sessions .shell-icon-nav > a, .workspace-sessions .shell-rail-search")
					.filter(e => { const r = e.getBoundingClientRect(); return (innerWidth < 900 && r.height < 44) || r.left < -0.5 || r.right > innerWidth + 0.5; }).map(e => e.className).join() }; })()`;
		const drawer: Step = [`document.querySelector(".workspace-sessions-open").click()`, `!!document.querySelector(".workspace-sessions[open] .shell-icon-nav")`];
		const filter: Step = [`document.querySelector(".session-filter-menu > summary").click()`, `!!document.querySelector(".session-filter-menu[open] select")`];
		const header: Step = [`(() => { document.querySelector(".workspace-context-open").click(); document.querySelector(".workspace-jobs-open").focus(); })()`,
			`!document.querySelector("aside.workspace-context") && document.activeElement === document.querySelector(".workspace-jobs-open")`];
		// The committed six are desktop, phone, 899, 900, drawer and header-jobs; 1279 and filter stay in the artifacts.
		const shotsS: [string, number, number, Step[], object][] = [
			["desktop", 1440, 1000, [], { inspector: true, sheet: false, heading: 48, rail: "Chat,Jobs,More", jobs: "Jobs⌘J Jobs (Ctrl/⌘ J)", small: "" }],
			["header-jobs", 1440, 1000, [header], { inspector: false, sheet: false, heading: 48, jobs: "Jobs⌘J Jobs (Ctrl/⌘ J)", small: "" }],
			["1279", 1279, 1000, [], { inspector: true, sheet: false, heading: 48, small: "" }],
			["900", 900, 1000, [], { inspector: true, sheet: false, heading: 48, small: "" }],
			["phone", 390, 844, [], { inspector: false, sheet: false, heading: 45, bar: 53, sides: "10px 14px", field: "18px field over footer full width",
				strip: "1 working · pr3", small: "" }],
			["899", 899, 1000, [], { inspector: false, sheet: false, heading: 45, bar: 53, small: "" }],
			["drawer", 390, 844, [drawer], { drawer: "Chat,Jobs,More", drawer_width: 317, small: "" }],
			["filter", 390, 844, [filter], { sheet: false, small: "" }],
		];
		for (const [name, width, height, steps, want] of shotsS) {
			await capture(`full-match-shell-${name}`, transcript, width, height, "dark", loaded, "bottom", steps);
			const got = await evaluate(look);
			const off = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${JSON.stringify(got[k])} (want ${JSON.stringify(v)})`);
			if (off.length) throw new Error(`full-match-shell-${name}: ${off.join("; ")}`);
		}
		if (posts.length) throw new Error(`full-match-shell sent ${posts.join(", ")}: the shell only reads`);
	}
	if (stage === "full-match-transcript") {
		// Full match S2 (frames 1/5/7/12, C1) per capture. Negative controls: a missing join fails `clock`, time-last rows
		// `time_first`, no disclosure `earlier`, a title-first card `head`, a closed context `context`, no clock `strip`.
		const look = `(() => { const q = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
			const box = s => { const r = q(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(" ") : null; };
			const over = e => { const range = document.createRange(); range.selectNodeContents(e); return range.getBoundingClientRect().width - e.getBoundingClientRect().width; };
			const row = q(".session-steps-open .session-steps-rows .session-tool > summary"), cell = (i) => row?.children[i]?.getBoundingClientRect().left ?? 0;
			const chip = q(".session-bubble a.pr-chip, .session-message a.pr-chip"), strip = q(".session-strip-job"), job = q(".workspace-context-job");
			return { options: all(".workspace-context-option").length, clock: q(".workspace-context-job dd")?.textContent ?? null, job: q(".workspace-context-job code")?.textContent ?? null,
				head: job ? [...job.firstElementChild.children].map(c => c.className || c.tagName).join() + "|" + job.children[1].className : null,
				context: [...document.querySelectorAll(".workspace-context-why[open] li")].length + (q(".workspace-context-why[open]") ? " open" : " closed"),
				earlier: q(".session-steps-earlier")?.textContent ?? null, time_first: !!row && row.children[0].classList.contains("session-time") && cell(0) < cell(1),
				chip: chip ? [...chip.children].slice(1).map(c => c.textContent).join(" | ") : null,
				strip: innerWidth < 900 && strip ? q(".session-strip-count").textContent + " " + strip.textContent + (over(strip) > 0.01 ? " (clipped " + over(strip).toFixed(2) + "px)" : "") : null,
				measure: { ask: box(".workspace-context-ask"), option: box(".workspace-context-option"), job: box(".workspace-context-job"), sheet: box("dialog.workspace-context[open]"),
					cols: row ? [...row.children].map(c => Math.round(c.getBoundingClientRect().left - row.getBoundingClientRect().left)).join(" ") : null, step: box(".session-steps-rows .session-tool > summary"),
					bridge: box(".session-bridge-line"), bridge_chip_border: q(".session-bridge-chip") ? getComputedStyle(q(".session-bridge-chip")).borderTopWidth : null, chip: box("a.pr-chip"), strip: box(".session-strip") },
				outside: all(".workspace-context button, .workspace-context a, .session-steps-earlier, .session-steps-link, .pr-chip, .session-strip-job")
					.filter(e => { const r = e.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5; }).map(e => e.className).join() }; })()`;
		const context: Step = [`document.querySelector(".workspace-context-open[aria-expanded=false]")?.click()`, `!!document.querySelector(".workspace-context .workspace-context-option")`];
		const joined: Step = ["true", `document.querySelector(".workspace-context-job dd")?.textContent === "9m / 2h 0m"`];
		const why = `document.querySelector(".workspace-context-why > summary")`;
		const toggled: Step[] = [[`${why}.click()`, `!document.querySelector(".workspace-context-why").open`], [`${why}.click()`, `document.querySelector(".workspace-context-why").open`]];
		const steps: Step = [`document.querySelector('.session-steps > .session-tools[title="${JOB}"]').click()`, `!!document.querySelector(".session-steps-earlier")`];
		// Scroll only the transcript (scrollIntoView would pan the page and hide the header and strip).
		const into = (s: string, gap: number) => `(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(${JSON.stringify(s)}).getBoundingClientRect().top - t.getBoundingClientRect().top - ${gap}; })()`;
		const toEarlier: Step = [into(".session-steps-open", 12), "true"], toChip: Step = [into(".session-message a.pr-chip", 200), "true"];
		const head = "workspace-context-job-glyph,CODE,workspace-context-job-status|workspace-context-job-title";
		const card = { options: 3, clock: "9m / 2h 0m", job: "t7ah", head, context: "3 open", outside: "" }, disclosed = { earlier: "2 earlier ▸", time_first: true, outside: "" };
		// The committed five: desktop, steps, phone-ask, phone and pr-chip (dark, picp only).
		const shotsT: [string, number, number, Step[], object][] = [
			["desktop", 1440, 1000, [joined, ...toggled], card], ["steps", 1440, 1000, [steps, toEarlier], disclosed],
			["phone-ask", 390, 844, [context, joined], card], ["phone", 390, 844, [steps, toEarlier], { ...disclosed, strip: "1 working · t7ah · 9m" }],
			["pr-chip", 1440, 1000, [toChip], { chip: "#321 | ✓ Review | ○ CI | ○ Merge", outside: "" }],
		];
		for (const [name, width, height, run, want] of shotsT) {
			await capture(`full-match-transcript-${name}`, transcript, width, height, "dark", loaded, "bottom", run);
			const got = await evaluate(look);
			console.log(`measured ${name} ${JSON.stringify(got)}`);
			const off = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${JSON.stringify(got[k])} (want ${JSON.stringify(v)})`);
			if (off.length) throw new Error(`full-match-transcript-${name}: ${off.join("; ")}`);
		}
		if (posts.length) throw new Error(`full-match-transcript sent ${posts.join(", ")}: the captures only read`);
	}
	if (stage === "full-match-jobs") {
		// Full match S3 (frames 3/9, C1). Negative controls: dropped team/queued groups fail `groups`, an ignored query
		// `rows`, Show more without focus `focus`, unknown CI painted passed `chip`, phone targets under 44 px `small`,
		// a green Working label `tones` (Working stays neutral; only Merged is blue).
		const look = `(() => { const q = s => document.querySelector(s), all = s => [...document.querySelectorAll(s)].filter(e => e.getClientRects().length);
			const box = s => { const r = q(s)?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(" ") : null; };
			const mid = e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2);
			const tops = all(".workspace-jobs-head > h2, .workspace-jobs-project > summary, .workspace-jobs .jobs-segments button, .workspace-jobs-head > .workspace-full, .workspace-jobs-head > .workspace-close").map(mid);
			const row = q(".workspace-jobs-row"), chip = q(".session-message a.pr-chip"), find = all(".workspace-jobs-find")[0], head = q(".workspace-jobs-head");
			const color = s => { const e = all(s)[0]; return e ? getComputedStyle(e).color : null; };
			return { drawer: box("dialog.workspace-jobs[open]"), one_row: innerWidth >= 900 ? Math.max(...tops) - Math.min(...tops) <= 2 : null,
				query_row: innerWidth >= 900 && find ? find.getBoundingClientRect().top > Math.max(...all(".workspace-jobs .jobs-segments button").map(b => b.getBoundingClientRect().bottom)) && find.getBoundingClientRect().width > head.getBoundingClientRect().width - 40 : null,
				pill: all(".workspace-jobs-project > summary").map(s => s.textContent).join(), pill_dot: color(".workspace-jobs-project-dot") === null ? null : getComputedStyle(q(".workspace-jobs-project-dot")).backgroundColor,
				select_shown: [...document.querySelectorAll(".workspace-jobs select")].filter(e => e.checkVisibility()).length, segs: all(".workspace-jobs .jobs-segments button").map(b => b.textContent).join(),
				statuses: all(".workspace-jobs-status").slice(0, 6).map(s => s.textContent).join(),
				tones: [color(".workspace-jobs-row[data-job=cp-transcript-steps-t7ah] .workspace-jobs-status"), color(".workspace-jobs-status-merged"), color(".workspace-jobs-row[data-job=cp-parent-perf-audit-68u3] .workspace-jobs-status")].join(" | "),
				cols: all(".workspace-jobs-cols span").map(s => s.textContent).join(), groups: all(".workspace-jobs-list h3").map(h => h.textContent).join(),
				rows: all(".workspace-jobs-row").length, more: q(".workspace-jobs-more")?.textContent ?? null, focus: document.activeElement?.dataset?.job ?? null,
				one_line: row ? Math.round(row.querySelector("b").getBoundingClientRect().height) <= 22 : null, meta: all(".workspace-jobs-meta")[0]?.textContent ?? null,
				meta_mono: row ? getComputedStyle(row.querySelector(".workspace-jobs-meta > code")).fontFamily.includes("Mono") : null,
				chip: chip ? [...chip.querySelectorAll(".pr-chip-slot")].map(s => s.textContent + "/" + s.getAttribute("title")).join(" | ") + (chip.querySelector(".pr-chip-ci-unknown .pr-chip-glyph")?.textContent === "○" ? "" : " (unknown CI not hollow)") : null,
				measure: { head: box(".workspace-jobs-head"), pill: box(".workspace-jobs-project > summary"), seg: box(".workspace-jobs .jobs-segments"), find: find ? box(".workspace-jobs-find") : null,
					full: box(".workspace-jobs-head > .workspace-full"), cols: box(".workspace-jobs-cols"), h3: box(".workspace-jobs-list h3"), row: box(".workspace-jobs-row"), more: box(".workspace-jobs-more"), chip: box(".session-message a.pr-chip") },
				small: innerWidth < 900 ? all(".workspace-close, .workspace-full, .workspace-jobs-search, .workspace-jobs-row, .workspace-jobs .jobs-segments button, .workspace-jobs-project > summary, .workspace-jobs-more, .workspace-jobs-find")
					.filter(e => e.getBoundingClientRect().height < 44).map(e => e.className || e.textContent).join() : "",
				outside: all(".workspace-jobs button, .workspace-jobs a, .workspace-jobs summary, .workspace-jobs input, .pr-chip").filter(e => { const r = e.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5; }).map(e => e.className || e.textContent).join() }; })()`;
		// Resting captures: the modal's initial focus ring on the pill is dropped before the shot.
		const open: Step = [`(() => { document.querySelector(".workspace-jobs-open").click(); setTimeout(() => document.activeElement?.blur(), 0); })()`,
			`!!document.querySelector(".workspace-jobs[open] .workspace-jobs-row") && document.activeElement === document.body`];
		const query: Step = [`(() => { const i = document.querySelector(".workspace-jobs-find input"); i.value = "toolbar"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
			`document.querySelectorAll(".workspace-jobs-row").length === 1`];
		const more: Step = [`document.querySelector(".workspace-jobs-more").click()`, `document.activeElement?.dataset?.job === "cp-viewer-fonts-f0nt"`];
		const toFocus: Step = [`(() => { const l = document.querySelector(".workspace-jobs-list"); l.scrollTop += document.activeElement.getBoundingClientRect().top - l.getBoundingClientRect().top - 200; })()`, "true"];
		const toChip: Step = [`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop += document.querySelector(".session-message a.pr-chip").getBoundingClientRect().top - t.getBoundingClientRect().top - 200; })()`, "true"];
		const groups = "In flight · 2,With the team · 1,Queued · 1,Done today · 7", cols = "Job,Title / context,Status,Done,Cost";
		const statuses = "Working,Held,With the team,Queued,Merged #700,Done", tones = "rgb(180, 180, 180) | rgb(147, 180, 245) | rgb(180, 180, 180)";
		// The committed five: desktop, desktop-query, phone, phone-more and pr-chip (dark, picp only).
		const shotsJ: [string, number, number, Step[], object][] = [
			["desktop", 1440, 1000, [open], { drawer: "579 0 861 1000", one_row: true, query_row: true, pill: "All projects▾", select_shown: 0, segs: "Today11,In flight2", statuses, tones, cols, groups, rows: 9, more: "Show 2 more", outside: "" }],
			["desktop-query", 1440, 1000, [open, query], { one_row: true, query_row: true, groups: "In flight · 1", rows: 1, outside: "" }],
			["phone", 390, 844, [open], { drawer: "0 96 390 748", cols: "", pill: "All projects▾", select_shown: 0, segs: "Today11,In flight2,All", statuses, tones, groups, rows: 9, more: "Show 2 more", one_line: true,
				meta: "t7ah · fixture-model · $1.54", meta_mono: true, small: "", outside: "" }],
			["phone-more", 390, 844, [open, more, toFocus], { rows: 11, more: null, focus: "cp-viewer-fonts-f0nt", small: "", outside: "" }],
			["pr-chip", 1440, 1000, [toChip], { chip: "✓ Review/review pass | ○ CI/CI unknown | ○ Merge/open", outside: "" }],
		];
		for (const [name, width, height, run, want] of shotsJ) {
			await capture(`full-match-jobs-${name}`, transcript, width, height, "dark", loaded, "bottom", run);
			const got = await evaluate(look);
			console.log(`measured ${name} ${JSON.stringify(got)}`);
			const off = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k} ${JSON.stringify(got[k])} (want ${JSON.stringify(v)})`);
			if (off.length) throw new Error(`full-match-jobs-${name}: ${off.join("; ")}`);
		}
		if (posts.length) throw new Error(`full-match-jobs sent ${posts.join(", ")}: the drawer only reads`);
	}
	if (unexpected.length) throw new Error(`unexpected routes: ${[...new Set(unexpected)].join(", ")}`);
	writeFileSync(join(out, "manifest.json"), `${JSON.stringify({ stage: args.stage, chrome: version.product, posts, shots }, null, 2)}\n`);
	await cdp("Browser.close").catch(() => {});
	ws.close();
	console.log(`${shots.length} screenshots in ${out} (${version.product})`);
} finally {
	for (const stream of streams) stream.end();
	server.close();
	if (chrome && chrome.exitCode === null) chrome.kill();
	await new Promise(r => setTimeout(r, 300));
	rmSync(profile, { recursive: true, force: true });
	rmSync(scratch, { recursive: true, force: true });
}
