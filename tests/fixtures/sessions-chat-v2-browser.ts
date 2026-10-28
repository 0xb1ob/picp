/**
 * Sessions chat v2 browser capture: the production app on loopback (production CSP, synthetic APIs), isolated headless
 * Chrome over CDP, PNGs plus manifest.json.
 * `--stage pr1|pr2|pr3|pr4|pr5|chips|rollup|notice [--chrome /usr/bin/google-chrome] --out <dir>`
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
import { overview } from "../../src/viewer/overview-view.ts";

const STAGES = ["pr1", "pr2", "pr3", "pr4", "pr5", "chips", "rollup", "notice"];
const { values: args } = parseArgs({ options: { stage: { type: "string" }, chrome: { type: "string", default: "/usr/bin/google-chrome" }, out: { type: "string" } } });
if (!args.stage || !STAGES.includes(args.stage)) throw new Error(`--stage must be one of ${STAGES.join(", ")} (later stages land with their PRs)`);
if (!args.out) throw new Error("--out <dir> is required");
const out = resolve(args.out);
const GENERATED = "2026-10-15T16:00:00Z";

const say = (id: string, at: string, who: string, text: string, over: Partial<SessionEntry> = {}): SessionEntry =>
	({ id, at, kind: "say", who, text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const tool = (id: string, at: string, name: string, text: string, summary?: string): SessionEntry => ({ ...say(id, at, "Assistant", text), kind: "tool", name, ...(summary ? { summary } : {}) });
const JOB = "cp-sessions-v2-pr2";
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
if (args.stage === "pr4" || args.stage === "pr5") {
	const ask = asked("ask-pr4a", "PR #321 is green on its pushed head. Merge it, or hold it for another review?");
	sessions.entries = [...entries, askCard(ask, "2026-10-15T08:04:40Z")];
	sessions.open_asks = [ask];
	sessions.operator_context = { tokens: 61_000, window: 200_000, percent: 30.5, level: "ok", reason: null, model: "fixture-model", last_compact_at: null, thinking: null } as SessionsResponse["operator_context"];
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
	const app = await buildViewer({ stateDir: join(scratch, LAYOUT.state) });
	const empty = overview({ home: scratch, stateDir: join(scratch, LAYOUT.state) }, Date.parse(GENERATED));
	const routes: Record<string, unknown> = { "/api/sessions": sessions, "/api/overview": empty, "/api/operator/control": control, [`/api/job/${JOB}`]: job, [`/api/job/${JOB}/transcript`]: jobTranscript };
	if (args.stage === "pr5") routes["/api/skills"] = { generated_at: GENERATED, skipped: [], omitted: 0, skills: [
		{ name: "cp-pr-review", description: "Review a pull request against its task file", source: "agent" }, { name: "cp-memory", description: "Capture and curate lessons", source: "home" }] };
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
		if (leak.background !== "#111110") throw new Error(`Overview took the Sessions light palette (${leak.background})`);
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
		if (base.columns.join() !== "208,281,951") throw new Error(`pr3: rail, Chats and conversation are ${base.columns.join(" + ")} px, not 208 + 281 + 951`);
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
