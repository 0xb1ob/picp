/**
 * Sessions chat v2 browser capture: the production app on loopback (production CSP, synthetic APIs), isolated headless
 * Chrome over CDP, PNGs plus manifest.json. `--stage pr1|pr2|pr3 [--chrome /usr/bin/google-chrome] --out <dir>`
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LAYOUT } from "../../src/contracts.ts";
import type { ControlStatusResponse, JobResponse, JobTranscriptResponse, SessionEntry, SessionsResponse, ThreadsResponse, ThreadView } from "../../src/viewer/api-types.ts";
import { APP_CSP, appPage } from "../../src/viewer/app-page.ts";
import { buildViewer } from "../../src/viewer/build.ts";
import { overview } from "../../src/viewer/overview-view.ts";

const STAGES = ["pr1", "pr2", "pr3"];
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
const TH = { v2: "th-0123456789ab", improv: "th-aaaaaaaaaaaa", long: "th-bbbbbbbbbbbb", done: "th-dddddddddddd" };
const entries: SessionEntry[] = [
	say("e1", "2026-10-14T09:12:00Z", "Operator", "Morning. Where is the Sessions redesign?", { thread: TH.done }),
	say("e2", "2026-10-14T09:12:40Z", "Assistant", "PR 1 of 5 is in flight: tokens, cards and date separators. Status by job:\n\n" + TABLE, { thread: TH.done }),
	tool("t1", "2026-10-14T09:13:00Z", "bash", "git log --oneline -3"),
	tool("t2", "2026-10-14T09:13:05Z", "read", "viewer-app/screens/sessions.css"),
	say("e3", "2026-10-14T09:14:00Z", "Assistant", "The theme lives on `.shell-sessions` only, so Overview keeps its palette:\n\n```css\n.shell-sessions { color-scheme: light; background: var(--background); }\n```"),
	say("e4", "2026-10-15T08:02:00Z", "Operator", "Long words must wrap: https://github.com/example/picp/pull/1234/files#diff-0123456789abcdef0123456789abcdef0123456789abcdef", { project: "picp", thread: TH.v2 }),
	say("e5", "2026-10-15T08:03:00Z", "Assistant", "They do; an inline `code-identifier-that-is-quite-long` chip wraps too.\n\nA second paragraph keeps the card readable on a phone without a horizontal page scroll, even when the reply runs to several lines of plain prose like this one.", { thread: TH.v2 }),
	wake,
	tool("k1", "2026-10-15T08:03:31Z", "thinking", "Let me verify the precedence claim before answering.", "Let me verify the precedence claim: docs say parent.json overrides CP_PARENT_MODEL"),
	tool("k2", "2026-10-15T08:03:35Z", "bash", "Arguments\n{\"command\":\"rg -n Models docs\"}\n\nResult\n## Models", "## Models"),
	tool("k3", "2026-10-15T08:03:38Z", "read", "Arguments\n{\"path\":\"src/service/supervise.ts\"}\n\nResult\n…", "src/service/supervise.ts"),
	tool("k4", "2026-10-15T08:03:40Z", "cp_integrate", `Arguments\n{"job_id":"${JOB}"}\n\nResult\nnext: wait`, `${JOB} · next: wait`),
	tool("k5", "2026-10-15T08:03:44Z", "fetch_content", "Arguments\n{\"url\":\"https://example.com/notes\"}\n\nResult\n…", "https://example.com/notes"),
	say("e6", "2026-10-15T08:04:00Z", "Assistant", "Anything else before I open the draft?", { thread: TH.improv }),
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
const body = (text: string) => ({ kind: "message" as const, text });
const control: ControlStatusResponse = {
	generated_at: GENERATED, enabled: true, running: true, reason: null, token: "fixture-token", busy: true, pending: true, session_file: "op.jsonl", recent: [],
	sends: [
		{ id: "dc-queued", at: "2026-10-15T08:05:00Z", state: "queued", reason: null, ask_id: null, editable: true, body: body("Queued while the session is busy: open it as a draft.") },
		{ id: "dc-failed", at: "2026-10-15T08:06:00Z", state: "failed", reason: "Session stopped before delivery", ask_id: null, body: body("This one failed to deliver.") },
	],
	offline: false, held: 0, inbox_token: null, start_unavailable: null, launchers: { tmux: false, herdr: false }, resume: { tmux: false, herdr: false },
};
const thread = (id: string, tag: string, state: ThreadView["state"], waiting: ThreadView["waiting"], working = 0): ThreadView => ({ id, tag, state, waiting,
	counts: { messages: 1, asks: 0, answers: 0, jobs_working: working }, opened_at: "2026-10-14T09:00:00Z", last_at: "2026-10-15T08:04:00Z", done_at: state === "done" ? "2026-10-15T08:00:00Z" : null });
const threads: ThreadsResponse = { generated_at: GENERATED, availability: "ok", enabled: true, reason: null, token: "fixture-token", threads: [
	thread(TH.v2, "sessions-v2", "waiting", { asks: 1, answers: 1 }), thread(TH.improv, "picp-improv", "open", { asks: 0, answers: 0 }, 1),
	thread(TH.long, "a-thread-tag-of-the-full-32-char", "open", { asks: 0, answers: 0 }), thread(TH.done, "old-release", "done", { asks: 0, answers: 0 }),
], total: 4, warning: null };
/** The same list with asks unreadable, as threadsView serves it: every `waiting` null, nothing in the waiting state. */
const blind: ThreadsResponse = { ...threads, warning: "asks unavailable: state/operator/asks.jsonl unreadable; waiting is unknown",
	threads: threads.threads.map(t => ({ ...t, waiting: null, state: t.state === "waiting" ? "open" : t.state })) };
/** A done job for the card's "Open job transcript →"; shaped as in tests/viewer-job-detail-render.test.ts. */
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
	const routes: Record<string, unknown> = { "/api/sessions": sessions, "/api/overview": empty, "/api/operator/control": control, "/api/threads": threads, [`/api/job/${JOB}`]: job, [`/api/job/${JOB}/transcript`]: jobTranscript };
	server.on("request", (req, res) => {
		const path = new URL(req.url ?? "/", "http://fixture").pathname;
		const send = (status: number, type: string, data: string | Uint8Array) => { res.writeHead(status, { "content-type": type, "content-security-policy": APP_CSP, "cache-control": "no-store" }); res.end(data); };
		if (req.method !== "GET") { posts.push(`${req.method} ${path}`); return send(405, "application/json", '{"error":"fixture is read-only"}'); }
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
	const capture = async (name: string, hash: string, width: number, height: number, theme: "light" | "dark", ready: string, scroll?: "top" | "bottom", steps: [string, string][] = []) => {
		await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
		await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await cdp("Page.navigate", { url: "about:blank" });
		await cdp("Page.navigate", { url: `${origin}/${hash}` });
		await until(name, `document.readyState === "complete" && !!document.querySelector(${JSON.stringify(ready)}) && document.fonts.status === "loaded"`);
		// Pending bubbles land after the first scroll-to-latest, so the fixture settles the scroller itself.
		if (scroll) await evaluate(`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop = ${scroll === "top" ? 0 : "t.scrollHeight"}; })()`);
		for (const [run, done] of steps) { await new Promise(r => setTimeout(r, 150)); await evaluate(run); await until(`${name}: ${done}`, done); }
		await new Promise(r => setTimeout(r, 300));
		const facts = await evaluate(`(() => { const shell = document.querySelector(".shell"); const css = shell && getComputedStyle(shell);
			return { overflow: document.documentElement.scrollWidth - innerWidth, shell: shell?.className ?? null, background: css?.getPropertyValue("--background").trim() ?? null,
				color_scheme: css?.colorScheme ?? null, days: [...document.querySelectorAll(".session-day")].map(d => d.textContent),
				pending: document.querySelectorAll(".session-pending").length, pills: [...document.querySelectorAll(".session-steps > .session-tools")].map(b => b.textContent),
				open_cards: document.querySelectorAll(".session-steps-open").length, job_tab: document.querySelector(".job-detail")?.dataset.tab ?? null,
				step_names: [...document.querySelectorAll(".session-steps-open .session-steps-rows .session-tool summary > code")].map(c => c.textContent + " " + c.clientWidth + "/" + c.scrollWidth + "px"),
				clipped: [...document.querySelectorAll(".session-steps-open .session-steps-rows .session-tool summary > code")].filter(c => c.scrollWidth > c.clientWidth).map(c => c.textContent),
				columns: [".shell-sidebar", ".session-sidebar", ".session-panel"].map(s => Math.round(document.querySelector(s)?.getBoundingClientRect().width ?? 0)),
				chats: [...document.querySelectorAll(".session-sidebar .session-choice strong, .session-sidebar .session-thread-choice, .session-thread-waiting")].map(e => e.getAttribute("aria-label") ?? e.textContent) }; })()`);
		if (facts.overflow > 0) throw new Error(`${name}: the page scrolls sideways by ${facts.overflow}px`);
		if (facts.clipped.length) throw new Error(`${name}: step names clipped: ${facts.clipped.join(", ")}`);
		const png = (await cdp("Page.captureScreenshot", { format: "png" })).data as string;
		const file = join(out, `${name}.png`);
		writeFileSync(file, Buffer.from(png, "base64"));
		shots.push({ file, hash, width, height, theme, scroll: scroll ?? null, steps: steps.map(([run]) => run), ...facts });
		await evaluate("localStorage.clear()");
	};
	const transcript = "#sessions?view=you&transcript=1";
	const loaded = ".session-entries .session-pending";
	const stage = args.stage!;
	for (const [device, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
		for (const theme of ["dark", "light"] as const) {
			await capture(`${stage}-${device}-${theme}-${width}x${height}`, transcript, width, height, theme, loaded, "bottom");
			if (stage === "pr1") await capture(`pr1-${device}-${theme}-top-${width}x${height}`, transcript, width, height, theme, loaded, "top");
		}
	}
	if (stage === "pr1") {
		await capture("pr1-overview-light-control-1440x1000", "#overview", 1440, 1000, "light", ".shell");
		const leak = shots.at(-1) as { background: string };
		if (leak.background !== "#111110") throw new Error(`Overview took the Sessions light palette (${leak.background})`);
	} else {
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
		const rows: [string, string] = ["true", `!!document.querySelector(".session-thread-row")`];
		const pick = (label: string): [string, string] => [`[...document.querySelectorAll(".session-sidebar .session-thread-choice")].find(b => (b.getAttribute("aria-label") ?? "").startsWith(${JSON.stringify(label)})).click()`,
			`!!document.querySelector('.session-sidebar .session-thread-choice[aria-pressed="true"][aria-label^=${JSON.stringify(label)}]')`];
		const chats = (name: string, theme: "dark" | "light", steps: [string, string][]) => capture(`pr3-${name}-desktop-${theme}-1440x1000`, transcript, 1440, 1000, theme, loaded, "bottom", [rows, ...steps]);
		for (const theme of ["dark", "light"] as const) await chats("thread-selected", theme, [pick("sessions-v2:")]);
		await chats("thread-done", "dark", [[`document.querySelector(".session-sidebar details > summary").click()`, `document.querySelector(".session-sidebar details").open`], pick("old-release:")]);
		const plus = `document.querySelector(".session-chats-new").click()`, dialog = `!!document.querySelector(".new-thread input")`;
		const typed: [string, string] = [`(() => { const i = document.querySelector(".new-thread input"); i.value = "fresh-idea"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`, `!document.querySelector(".new-thread-create").disabled`];
		await chats("new-thread-dialog", "dark", [[plus, dialog], typed]);
		await chats("thread-new", "dark", [[plus, dialog], [`document.querySelector(".new-thread-close").click()`, `!document.querySelector(".new-thread")`], [plus, dialog], typed,
			[`document.querySelector(".new-thread-create").click()`, `!document.querySelector(".new-thread") && !!document.querySelector('.session-thread-choice[aria-pressed="true"][aria-label^="fresh-idea:"]')`]]);
		routes["/api/threads"] = blind;
		await chats("waiting-unknown", "dark", []);
		routes["/api/threads"] = threads;
		sessions.workers = [];
		await chats("fleet-empty", "light", []);
		sessions.workers = workers;
		if (posts.length) throw new Error(`pr3 sent ${posts.join(", ")}: New thread and Cancel must request nothing`);
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
