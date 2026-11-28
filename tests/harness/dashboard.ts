/**
 * The dashboard as an operator's browser runs it: `bin/cp-view` on a scratch home, the served app in a linkedom tab.
 * The first browser harness: origin/main had none (baseline viewer tests used linkedom, P12 built none); P18 reuses it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { type ClientRequest, request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { LAYOUT } from "../../src/contracts.ts";
import { type ControlPorts, type DashboardControl, startDashboardControl } from "../../src/dashboard-control.ts";
import { call, type Init, type Reply } from "./remote.ts";
import { createScratchHome, REPO_ROOT } from "./index.ts";

type Context = { after(fn: () => unknown): void };
const CLOCK_HOOK = ["process-clock.ts", "parent-lifeline.ts"].map((f) => `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness", f)).href}`).join(" ");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${typeof last === "string" ? last : JSON.stringify(last)}`);
}

export const freePort = (): Promise<number> => new Promise((done) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => done(port));
	});
});

/** One running `bin/cp-view`; `at` pins its clock (`CP_TEST_CLOCK_FILE`) so dated fixtures read the same every run. */
export async function startViewer(t: Context, { home, requireTailnet = true, at, env = {} }: { home: string; requireTailnet?: boolean; at?: string; env?: Record<string, string> }) {
	const clock = join(home, "clock-offset-ms");
	const pin = (iso: string) => writeFileSync(clock, String(Date.parse(iso) - Date.now()));
	pin(at ?? new Date().toISOString());
	for (let attempt = 1; ; attempt++) {
		const port = await freePort();
		const argv = ["--home", home, "--host", "127.0.0.1", "--port", String(port), ...(requireTailnet ? ["--require-tailnet"] : [])];
		const child: ChildProcess = spawn(join(REPO_ROOT, "bin/cp-view"), argv, { env: { ...process.env, HOME: home, CP_HOME: home, NODE_OPTIONS: CLOCK_HOOK, CP_TEST_CLOCK_FILE: clock, CP_TEST_LIFELINE: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let output = "";
		child.stdout!.on("data", (chunk) => (output += chunk));
		child.stderr!.on("data", (chunk) => (output += chunk));
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
		// Another server can take the freed port first: only this home's identity counts, and our EADDRINUSE exit retries.
		const state = await until(async () => child.exitCode !== null || child.signalCode !== null ? "exited" : await call(port, "/api/identity").then((reply) => realpathSync(reply.body.home as string) === realpathSync(home) ? "ours" : "other").catch(() => "other"), (s) => s !== "other", `cp-view on ${port}\n${output}`, 60_000);
		if (state === "exited") {
			if (attempt < 3) continue;
			throw new Error(`cp-view exited before serving, ${attempt} ports tried\n${output}`);
		}
		const origin = `http://127.0.0.1:${port}`;
		return { port, origin, pid: child.pid as number, pin, output: () => output, stop: async () => { child.kill("SIGKILL"); await exited; }, get: (path: string, init: Init = {}) => call(port, path, init), open: (hash: string, hold?: RegExp) => openTab(t, port, hash, new Map(), hold) };
	}
}

/** A scratch home (its state dir made) with a running viewer. */
export async function dashboard(t: Context, options: { requireTailnet?: boolean; at?: string; env?: Record<string, string>; seed?: (stateDir: string, home: string) => void } = {}) {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	const stateDir = join(scratch.path, LAYOUT.state);
	mkdirSync(stateDir, { recursive: true });
	options.seed?.(stateDir, scratch.path);
	return { home: scratch.path, stateDir, ...(await startViewer(t, { home: scratch.path, ...options })) };
}

/** The operator session's real dashboard-control server (src/dashboard-control.ts) with pi's ports recorded. */
export async function operatorSession(t: Context, stateDir: string, isIdle = () => true, extra: Partial<ControlPorts> = {}) {
	const injected: Array<[string, string | undefined]> = [];
	const sessionFile = join(stateDir, "operator-session.jsonl");
	writeFileSync(sessionFile, "", { flag: "a" });
	const ports: ControlPorts = { inject: (text, deliverAs) => { injected.push([text, deliverAs]); }, abort: () => {}, isIdle, hasPendingMessages: () => false, sessionFile: () => sessionFile, ...extra };
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {} }) as DashboardControl;
	if (control.state !== "listening") throw new Error(`dashboard control did not start: ${JSON.stringify(control)}`);
	t.after(() => control.stop());
	return { injected, control };
}

/**
 * `read`: the app has parsed the reply's JSON and its state updates have run (set one macrotask after `json()`).
 * `bytes`: the body as sent (content-length, else the decoded length); `ms`: request start to response headers.
 */
type Requested = { method: string; path: string; headers: Record<string, string>; body: string | null; status: number; read: boolean; bytes: number; ms: number };

/** One real stream of a `liveStream` tab: its URL path, the bytes and events it carried, and `refresh` data seen. */
export type StreamLog = { path: string; bytes: number; events: number; comments: number; data: string[] };

/**
 * `liveStream`: the app's EventSource connects to the viewer and speaks what the server sends (default: a fake that
 * speaks only on `refresh()`/`signal()`); `origin`: a viewer not on 127.0.0.1:`port`; `getOnly`: a write is never sent.
 */
export type TabOptions = { liveStream?: boolean; origin?: string; getOnly?: boolean };

/**
 * Opens the served app at `hash`; `hold`-matched requests wait for `release()`; `headers` ride on every request (a
 * remote device's cookie); `wide` makes min-width media queries match, a desktop tab with no layout.
 */
export async function openTab(t: Context, port: number, hash: string, storage: Map<string, string> = new Map(), hold?: RegExp, extra: Record<string, string> = {}, wide = false, options: TabOptions = {}) {
	let release = () => {};
	const held = new Promise<void>((done) => (release = done));
	const origin = options.origin ? new URL(options.origin).origin : `http://127.0.0.1:${port}`;
	const load = (path: string) => options.origin
		? fetch(new URL(path, origin), { headers: extra }).then(async (reply) => ({ status: reply.status, text: await reply.text() }))
		: call(port, path, { headers: extra });
	const page = await load("/");
	if (page.status !== 200) throw new Error(`GET / answered ${page.status}: ${page.text.slice(0, 200)}`);
	const script = /<script type="module" src="([^"]+)"/.exec(page.text)?.[1];
	if (!script) throw new Error("the served page names no app script");
	const code = (await load(script)).text;
	const { window, document, Event, CustomEvent, EventTarget: DomEventTarget, HTMLElement } = parseHTML(page.text) as unknown as Record<string, any>;
	HTMLElement.prototype.scrollIntoView ??= () => {}; // linkedom has no layout
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let shifted = 0;
	class TabDate extends Date {
		constructor(...at: unknown[]) { super(...((at.length ? at : [Date.now() + shifted]) as [number])); }
		static override now() { return Date.now() + shifted; }
	}
	let closed = false;
	const requests: Requested[] = [];
	const started: string[] = []; // every request as the app makes it, before a `hold` answers
	const location = { hash, pathname: "/", search: "", origin, host: new URL(origin).host, protocol: "http:", get href() { return `${origin}/${location.hash}`; }, assign() {}, replace() {}, reload() {} };
	const confirms: string[] = [];
	const sources = new Set<EventTarget>(); // the app's streams: fake ones speak only when the test calls `refresh()`
	const streams: StreamLog[] = [];
	const refused: string[] = []; // writes a `getOnly` tab answered itself
	let answerConfirm = true;
	const browserFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		if (closed) return new Promise<Response>(() => {});
		const url = new URL(String(input instanceof Request ? input.url : input), origin);
		started.push(`${(init.method ?? "GET").toUpperCase()} ${url.pathname}`);
		if (hold?.test(url.pathname)) await held;
		const headers = new Headers({ ...extra, ...Object.fromEntries(new Headers(init.headers)) });
		const method = (init.method ?? "GET").toUpperCase();
		if (options.getOnly && method !== "GET" && method !== "HEAD") {
			refused.push(`${method} ${url.pathname}`);
			return new Response(null, { status: 405 });
		}
		headers.set("sec-fetch-site", "same-origin");
		if (method !== "GET" && method !== "HEAD") headers.set("origin", origin);
		const sentAt = performance.now();
		const response = await fetch(url, { ...init, headers });
		const length = response.headers.get("content-length");
		const row: Requested = { method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(headers), body: typeof init.body === "string" ? init.body : null, status: response.status, read: false, bytes: Number(length ?? 0), ms: performance.now() - sentAt };
		if (length === null) void response.clone().arrayBuffer().then((body) => { row.bytes = body.byteLength; }, () => {});
		requests.push(row);
		const json = response.json.bind(response);
		response.json = () => json().finally(() => void setTimeout(() => { row.read = true; }, 0));
		return response;
	};
	const track = <A extends unknown[]>(start: (fn: () => void, ms?: number, ...rest: A) => ReturnType<typeof setTimeout>) => (fn: () => void, ms?: number, ...rest: A) => {
		const handle = start(() => { if (!closed) fn(); }, ms, ...rest);
		timers.add(handle);
		return handle;
	};
	const sandbox: Record<string, unknown> = {
		window, document, location, navigator: { userAgent: "node", language: "en", clipboard: { writeText: async () => {} } },
		Event, CustomEvent, EventTarget: DomEventTarget, HTMLElement, KeyboardEvent: Event, MouseEvent: Event, InputEvent: Event,
		fetch: browserFetch, Headers, Request, Response, URL, URLSearchParams, AbortController, AbortSignal, FormData, Blob, File,
		TextEncoder, TextDecoder, console, queueMicrotask, structuredClone, atob, btoa, crypto, performance, Date: TabDate,
		setTimeout: track(setTimeout), setInterval: track(setInterval), clearTimeout, clearInterval,
		requestAnimationFrame: (fn: (at: number) => void) => track(setTimeout)(() => fn(performance.now()), 16), cancelAnimationFrame: clearTimeout,
		localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)), removeItem: (k: string) => void storage.delete(k) },
		matchMedia: (query: string) => ({ matches: wide && /min-width/.test(query), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
		EventSource: options.liveStream
			? liveEventSource(origin, extra, sources, streams, () => closed)
			: class extends EventTarget { onmessage = null; onerror = null; constructor() { super(); sources.add(this); } close() { sources.delete(this); } },
		confirm: (text: string) => (confirms.push(text), answerConfirm),
	};
	for (const [key, value] of Object.entries({ location, localStorage: sandbox.localStorage, matchMedia: sandbox.matchMedia, confirm: sandbox.confirm, navigator: sandbox.navigator, scrollTo() {}, requestAnimationFrame: sandbox.requestAnimationFrame })) {
		Object.defineProperty(window, key, { configurable: true, value });
	}
	sandbox.self = sandbox.globalThis = window;
	createContext(sandbox);
	runInContext(code, sandbox, { filename: script });
	const close = () => {
		closed = true;
		for (const handle of timers) clearTimeout(handle);
		timers.clear();
		if (options.liveStream) for (const source of [...sources]) (source as unknown as { close(): void }).close();
	};
	t.after(close);
	const root = document.getElementById("app") as Element;
	const text = () => root.textContent ?? "";
	return {
		window, document, root, requests, started, confirms, storage, close, text, release, streams, refused,
		/** Streams connected to the viewer right now (a `liveStream` tab; a fake stream never connects). */
		openStreams: () => [...sources].filter((source) => (source as { readyState?: number }).readyState === 1).length,
		/** The page's global scope: a test adds what linkedom lacks (a ResizeObserver) before the screen mounts. */
		globals: sandbox,
		/** Every open stream fires `type` ("open", "error"), as a browser's EventSource does on connect or loss. */
		signal: (type: string) => { for (const source of [...sources]) source.dispatchEvent(new globalThis.Event(type)); },
		/** The app's own `navigator` (linkedom's window keeps its own): set `clipboard` to stage a copy. */
		navigator: sandbox.navigator as { clipboard?: unknown },
		/** Moves this tab's clock (its `Date`) forward by `ms`; the viewer's own clock is `pin`. */
		shift: (ms: number) => void (shifted += ms),
		/** Every open stream says `refresh`, as the server's does on a change: the mounted page re-reads its data. */
		refresh: () => { for (const source of [...sources]) source.dispatchEvent(new globalThis.Event("refresh")); },
		$: (selector: string) => root.querySelector(selector) as Element | null,
		$$: (selector: string) => [...root.querySelectorAll(selector)] as Element[],
		/** Waits until `selector` matches (and `ok` holds for it). */
		find: (selector: string, ok: (el: Element) => boolean = () => true, ms?: number) => until(() => [...root.querySelectorAll(selector)].find((el: Element) => ok(el)) ?? null, Boolean, `${selector} in ${hash}`, ms) as Promise<Element>,
		waitText: (pattern: RegExp, ms?: number) => until(text, (value) => pattern.test(value), `${pattern} in ${hash}`, ms),
		go: (next: string) => { location.hash = next; window.dispatchEvent(new Event("hashchange")); },
		click: (el: Element) => el.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })),
		key: (el: Element, key: string) => { const event = new Event("keydown", { bubbles: true, cancelable: true }); Object.defineProperty(event, "key", { value: key }); el.dispatchEvent(event); return event; },
		type: (el: Element, value: string) => { (el as unknown as { value: string }).value = value; el.dispatchEvent(new Event("input", { bubbles: true })); },
		decline: () => { answerConfirm = false; },
		accept: () => { answerConfirm = true; },
		reopen: (next = hash) => (close(), openTab(t, port, next, storage, undefined, extra, wide, options)),
	};
}

/**
 * A browser's EventSource over a real `http.request`: SSE frames become events with `.data`, comments are counted, a
 * dropped stream reconnects after the server's `retry:` and a non-200 or non-SSE answer closes it for good.
 */
function liveEventSource(origin: string, extra: Record<string, string>, sources: Set<EventTarget>, streams: StreamLog[], tabClosed: () => boolean) {
	return class LiveEventSource extends EventTarget {
		readyState = 0;
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: Event) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		readonly url: string;
		#log: StreamLog;
		#req: ClientRequest | null = null;
		#retry = 3000;
		#again: ReturnType<typeof setTimeout> | undefined;
		constructor(url: string) {
			super();
			this.url = new URL(url, origin).href;
			const at = new URL(this.url);
			this.#log = { path: `${at.pathname}${at.search}`, bytes: 0, events: 0, comments: 0, data: [] };
			streams.push(this.#log);
			sources.add(this);
			this.#connect();
		}
		close() {
			this.readyState = 2;
			clearTimeout(this.#again);
			this.#req?.destroy();
			this.#req = null;
			sources.delete(this);
		}
		#fire(type: string, data?: string) {
			if ((this.readyState === 2 && type !== "error") || tabClosed()) return;
			const event = new globalThis.Event(type);
			if (data !== undefined) Object.defineProperty(event, "data", { value: data });
			this.dispatchEvent(event);
			const handler = type === "open" ? this.onopen : type === "error" ? this.onerror : type === "message" ? this.onmessage : null;
			handler?.call(this, event);
		}
		#lost() {
			if (this.readyState === 2) return;
			this.readyState = 0;
			this.#req = null;
			this.#fire("error");
			this.#again = setTimeout(() => this.#connect(), this.#retry);
		}
		#connect() {
			if (this.readyState === 2 || tabClosed()) return;
			const req = httpRequest(this.url, { headers: { ...extra, accept: "text/event-stream", "cache-control": "no-cache" } }, (res) => {
				if (res.statusCode !== 200 || !String(res.headers["content-type"]).startsWith("text/event-stream")) {
					res.resume();
					this.close();
					this.#fire("error");
					return;
				}
				this.readyState = 1;
				this.#fire("open");
				let buffer = "", type = "", data: string[] = [];
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					this.#log.bytes += Buffer.byteLength(chunk);
					buffer += chunk;
					const lines = buffer.split(/\r\n|\r|\n/);
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (line === "") {
							if (data.length) {
								this.#log.events++;
								if (type === "refresh") this.#log.data.push(data.join("\n"));
								this.#fire(type || "message", data.join("\n"));
							}
							type = "";
							data = [];
						} else if (line.startsWith(":")) this.#log.comments++;
						else {
							const colon = line.indexOf(":");
							const field = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
							if (field === "event") type = value;
							else if (field === "data") data.push(value);
							else if (field === "retry" && /^\d+$/.test(value)) this.#retry = Number(value);
						}
					}
				});
				res.on("end", () => this.#lost());
				res.on("error", () => this.#lost());
			});
			req.on("error", () => this.#lost());
			req.end();
			this.#req = req;
		}
	};
}

/**
 * Linkedom has no dialog or focus and calls a bubbled listener with the target as `this`: the tab gets showModal/close,
 * a tracked activeElement and listeners bound to their own element; the app's code is unchanged. Restored after `t`.
 */
export function browserShims(t: Context, tab: Tab) {
	const target = tab.window.EventTarget.prototype, element = tab.window.HTMLElement.prototype;
	const saved = [target, element].map((proto) => [proto, Object.getOwnPropertyDescriptors(proto)] as const);
	t.after(() => { for (const [proto, descriptors] of saved) Object.defineProperties(proto, descriptors); });
	const bound = new WeakMap<object, WeakMap<object, EventListener>>();
	const add = target.addEventListener, remove = target.removeEventListener;
	target.addEventListener = function (this: EventTarget, type: string, listener: EventListener, options?: unknown) {
		let own = bound.get(this);
		if (!own) bound.set(this, own = new WeakMap());
		if (!own.has(listener)) own.set(listener, listener.bind(this));
		add.call(this, type, own.get(listener)!, options);
	};
	target.removeEventListener = function (this: EventTarget, type: string, listener: EventListener, options?: unknown) {
		remove.call(this, type, bound.get(this)?.get(listener) ?? listener, options);
	};
	let focused: Element | null = tab.document.body;
	Object.defineProperty(tab.document, "activeElement", { configurable: true, get: () => focused });
	Object.assign(element, {
		focus(this: Element) { focused = this; },
		showModal(this: Element) { this.setAttribute("open", ""); },
		close(this: Element) { this.removeAttribute("open"); },
	});
	return () => focused;
}

/** Opens the context panel's "Asked you" disclosure (collapsed on every mount) inside `scope`, once it renders. */
export async function expandAsks(tab: Tab, scope = ".workspace-context") {
	const toggle = await tab.find(`${scope} .workspace-context-asked-toggle`);
	if (toggle.getAttribute("aria-expanded") !== "true") tab.click(toggle);
	await until(() => toggle.getAttribute("aria-expanded"), (open) => open === "true", "the expanded asks");
}

export type Tab = Awaited<ReturnType<typeof openTab>>;
export type { Reply };
