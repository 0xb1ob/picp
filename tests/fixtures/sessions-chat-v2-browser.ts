/**
 * Sessions chat v2 real-browser capture: builds the production app in memory, serves it with synthetic APIs on loopback
 * under the production CSP, drives an isolated headless Chrome over native CDP and saves PNGs plus manifest.json.
 * `node tests/fixtures/sessions-chat-v2-browser.ts --stage pr1 [--chrome /usr/bin/google-chrome] --out <dir>`
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LAYOUT } from "../../src/contracts.ts";
import type { ControlStatusResponse, SessionEntry, SessionsResponse, ThreadsResponse } from "../../src/viewer/api-types.ts";
import { APP_CSP, appPage } from "../../src/viewer/app-page.ts";
import { buildViewer } from "../../src/viewer/build.ts";
import { overview } from "../../src/viewer/overview-view.ts";

const STAGES = ["pr1"];
const { values: args } = parseArgs({ options: { stage: { type: "string" }, chrome: { type: "string", default: "/usr/bin/google-chrome" }, out: { type: "string" } } });
if (!args.stage || !STAGES.includes(args.stage)) throw new Error(`--stage must be one of ${STAGES.join(", ")} (later stages land with their PRs)`);
if (!args.out) throw new Error("--out <dir> is required");
const out = resolve(args.out);
const GENERATED = "2026-10-15T16:00:00Z";

const say = (id: string, at: string, who: string, text: string, over: Partial<SessionEntry> = {}): SessionEntry =>
	({ id, at, kind: "say", who, text, name: null, send_id: null, tag: null, failed: false, trace: [], ...over });
const tool = (id: string, at: string, name: string, text: string): SessionEntry => ({ ...say(id, at, "Assistant", text), kind: "tool", name });
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
	say("e6", "2026-10-15T08:04:00Z", "Assistant", "Anything else before I open the draft?"),
];
const sessions: SessionsResponse = {
	generated_at: GENERATED, selected: "you", session_id: "op-session", entries, title: "Operator ↔ you", subtitle: "Full transcript", warnings: [], truncated: false,
	parent: { id: "cp-parent", live: true } as SessionsResponse["parent"], workers: [], transcript: true, operator_sessions: [{ id: "op.jsonl", at: GENERATED }], operator_session: "op.jsonl",
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
const threads: ThreadsResponse = { generated_at: GENERATED, availability: "ok", enabled: false, reason: "threads are off in this fixture", token: null, threads: [], total: 0, warning: null };
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
	const routes: Record<string, unknown> = { "/api/sessions": sessions, "/api/overview": empty, "/api/operator/control": control, "/api/threads": threads };
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
	const capture = async (name: string, hash: string, width: number, height: number, theme: "light" | "dark", ready: string, scroll?: "top" | "bottom") => {
		await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
		await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
		await cdp("Page.navigate", { url: "about:blank" });
		await cdp("Page.navigate", { url: `${origin}/${hash}` });
		await until(name, `document.readyState === "complete" && !!document.querySelector(${JSON.stringify(ready)}) && document.fonts.status === "loaded"`);
		// Pending bubbles land after the first scroll-to-latest, so the fixture settles the scroller itself.
		if (scroll) await evaluate(`(() => { const t = document.querySelector(".session-transcript"); t.scrollTop = ${scroll === "top" ? 0 : "t.scrollHeight"}; })()`);
		await new Promise(r => setTimeout(r, 300));
		const facts = await evaluate(`(() => { const shell = document.querySelector(".shell"); const css = shell && getComputedStyle(shell);
			return { overflow: document.documentElement.scrollWidth - innerWidth, shell: shell?.className ?? null, background: css?.getPropertyValue("--background").trim() ?? null,
				color_scheme: css?.colorScheme ?? null, days: [...document.querySelectorAll(".session-day")].map(d => d.textContent),
				pending: document.querySelectorAll(".session-pending").length }; })()`);
		if (facts.overflow > 0) throw new Error(`${name}: the page scrolls sideways by ${facts.overflow}px`);
		const png = (await cdp("Page.captureScreenshot", { format: "png" })).data as string;
		const file = join(out, `${name}.png`);
		writeFileSync(file, Buffer.from(png, "base64"));
		shots.push({ file, hash, width, height, theme, scroll: scroll ?? null, ...facts });
	};
	const transcript = "#sessions?view=you&transcript=1";
	const loaded = ".session-entries .session-pending";
	for (const [device, width, height] of [["desktop", 1440, 1000], ["phone", 390, 844]] as const) {
		for (const theme of ["dark", "light"] as const) {
			await capture(`pr1-${device}-${theme}-${width}x${height}`, transcript, width, height, theme, loaded, "bottom");
			await capture(`pr1-${device}-${theme}-top-${width}x${height}`, transcript, width, height, theme, loaded, "top");
		}
	}
	await capture("pr1-overview-light-control-1440x1000", "#overview", 1440, 1000, "light", ".shell");
	const leak = shots.at(-1) as { background: string };
	if (leak.background !== "#111110") throw new Error(`Overview took the Sessions light palette (${leak.background})`);
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
