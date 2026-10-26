/**
 * The dashboard as an operator's browser runs it: `bin/cp-view` on a scratch home, the served app in a linkedom tab.
 * The first browser harness: origin/main had none (baseline viewer tests used linkedom, P12 built none); P18 reuses it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
const CLOCK_HOOK = `--import ${pathToFileURL(join(REPO_ROOT, "tests/harness/process-clock.ts")).href}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
	let last: T | undefined;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
		last = await read();
		if (ok(last)) return last;
	}
	throw new Error(`timed out waiting for ${what}; last = ${typeof last === "string" ? last : JSON.stringify(last)}`);
}

const freePort = (): Promise<number> => new Promise((done) => {
	const probe = createServer().listen(0, "127.0.0.1", () => {
		const { port } = probe.address() as AddressInfo;
		probe.close(() => done(port));
	});
});

/** One running `bin/cp-view`; `at` pins its clock (`CP_TEST_CLOCK_FILE`) so dated fixtures read the same every run. */
export async function startViewer(t: Context, { home, requireTailnet = true, at, env = {} }: { home: string; requireTailnet?: boolean; at?: string; env?: Record<string, string> }) {
	const port = await freePort();
	const clock = join(home, "clock-offset-ms");
	const pin = (iso: string) => writeFileSync(clock, String(Date.parse(iso) - Date.now()));
	pin(at ?? new Date().toISOString());
	const argv = ["--home", home, "--host", "127.0.0.1", "--port", String(port), ...(requireTailnet ? ["--require-tailnet"] : [])];
	const child: ChildProcess = spawn(join(REPO_ROOT, "bin/cp-view"), argv, { env: { ...process.env, HOME: home, CP_HOME: home, NODE_OPTIONS: CLOCK_HOOK, CP_TEST_CLOCK_FILE: clock, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout!.on("data", (chunk) => (output += chunk));
	child.stderr!.on("data", (chunk) => (output += chunk));
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
	await until(() => call(port, "/healthz").then((reply) => reply.status, () => 0), (status) => status === 200, `cp-view on ${port}\n${output}`, 60_000);
	const origin = `http://127.0.0.1:${port}`;
	return { port, origin, pin, output: () => output, get: (path: string, init: Init = {}) => call(port, path, init), open: (hash: string, hold?: RegExp) => openTab(t, port, hash, new Map(), hold) };
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
export async function operatorSession(t: Context, stateDir: string, isIdle = () => true) {
	const injected: Array<[string, string | undefined]> = [];
	const sessionFile = join(stateDir, "operator-session.jsonl");
	writeFileSync(sessionFile, "", { flag: "a" });
	const ports: ControlPorts = { inject: (text, deliverAs) => { injected.push([text, deliverAs]); }, abort: () => {}, isIdle, hasPendingMessages: () => false, sessionFile: () => sessionFile };
	const control = await startDashboardControl({ stateDir, ports, deliveredWaitMs: 20, log: () => {} }) as DashboardControl;
	if (control.state !== "listening") throw new Error(`dashboard control did not start: ${JSON.stringify(control)}`);
	t.after(() => control.stop());
	return { injected, control };
}

/** `read`: the app has parsed the reply's JSON and its state updates have run (set one macrotask after `json()`). */
type Requested = { method: string; path: string; headers: Record<string, string>; body: string | null; status: number; read: boolean };

/**
 * Opens the served app at `hash`; `hold`-matched requests wait for `release()`; `headers` ride on every request (a
 * remote device's cookie); `wide` makes min-width media queries match, a desktop tab with no layout.
 */
export async function openTab(t: Context, port: number, hash: string, storage: Map<string, string> = new Map(), hold?: RegExp, extra: Record<string, string> = {}, wide = false) {
	let release = () => {};
	const held = new Promise<void>((done) => (release = done));
	const origin = `http://127.0.0.1:${port}`;
	const page = await call(port, "/", { headers: extra });
	if (page.status !== 200) throw new Error(`GET / answered ${page.status}: ${page.text.slice(0, 200)}`);
	const script = /<script type="module" src="([^"]+)"/.exec(page.text)?.[1];
	if (!script) throw new Error("the served page names no app script");
	const code = (await call(port, script, { headers: extra })).text;
	const { window, document, Event, CustomEvent, HTMLElement } = parseHTML(page.text) as unknown as Record<string, any>;
	HTMLElement.prototype.scrollIntoView ??= () => {}; // linkedom has no layout
	const timers = new Set<ReturnType<typeof setTimeout>>();
	let shifted = 0;
	class TabDate extends Date {
		constructor(...at: unknown[]) { super(...((at.length ? at : [Date.now() + shifted]) as [number])); }
		static override now() { return Date.now() + shifted; }
	}
	let closed = false;
	const requests: Requested[] = [];
	const location = { hash, pathname: "/", search: "", origin, host: `127.0.0.1:${port}`, protocol: "http:", get href() { return `${origin}/${location.hash}`; }, assign() {}, replace() {}, reload() {} };
	const confirms: string[] = [];
	const sources = new Set<EventTarget>(); // the app's streams: they speak only when the test calls `refresh()`
	let answerConfirm = true;
	const browserFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		if (closed) return new Promise<Response>(() => {});
		const url = new URL(String(input instanceof Request ? input.url : input), origin);
		if (hold?.test(url.pathname)) await held;
		const headers = new Headers({ ...extra, ...Object.fromEntries(new Headers(init.headers)) });
		const method = (init.method ?? "GET").toUpperCase();
		headers.set("sec-fetch-site", "same-origin");
		if (method !== "GET" && method !== "HEAD") headers.set("origin", origin);
		const response = await fetch(url, { ...init, headers });
		const row: Requested = { method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(headers), body: typeof init.body === "string" ? init.body : null, status: response.status, read: false };
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
		Event, CustomEvent, HTMLElement, KeyboardEvent: Event, MouseEvent: Event, InputEvent: Event,
		fetch: browserFetch, Headers, Request, Response, URL, URLSearchParams, AbortController, AbortSignal, FormData, Blob, File,
		TextEncoder, TextDecoder, console, queueMicrotask, structuredClone, atob, btoa, crypto, performance, Date: TabDate,
		setTimeout: track(setTimeout), setInterval: track(setInterval), clearTimeout, clearInterval,
		requestAnimationFrame: (fn: (at: number) => void) => track(setTimeout)(() => fn(performance.now()), 16), cancelAnimationFrame: clearTimeout,
		localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)), removeItem: (k: string) => void storage.delete(k) },
		matchMedia: (query: string) => ({ matches: wide && /min-width/.test(query), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
		EventSource: class extends EventTarget { onmessage = null; onerror = null; constructor() { super(); sources.add(this); } close() { sources.delete(this); } },
		confirm: (text: string) => (confirms.push(text), answerConfirm),
	};
	for (const [key, value] of Object.entries({ location, localStorage: sandbox.localStorage, matchMedia: sandbox.matchMedia, confirm: sandbox.confirm, navigator: sandbox.navigator, scrollTo() {}, requestAnimationFrame: sandbox.requestAnimationFrame })) {
		Object.defineProperty(window, key, { configurable: true, value });
	}
	sandbox.self = sandbox.globalThis = window;
	createContext(sandbox);
	runInContext(code, sandbox, { filename: script });
	const close = () => { closed = true; for (const handle of timers) clearTimeout(handle); timers.clear(); };
	t.after(close);
	const root = document.getElementById("app") as Element;
	const text = () => root.textContent ?? "";
	return {
		window, document, root, requests, confirms, storage, close, text, release,
		/** The page's global scope: a test adds what linkedom lacks (a ResizeObserver) before the screen mounts. */
		globals: sandbox,
		/** Every open stream fires `type` ("open", "error"), as a browser's EventSource does on connect or loss. */
		signal: (type: string) => { for (const source of [...sources]) source.dispatchEvent(new globalThis.Event(type)); },
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
		reopen: (next = hash) => (close(), openTab(t, port, next, storage, undefined, extra, wide)),
	};
}

export type Tab = Awaited<ReturnType<typeof openTab>>;
export type { Reply };
