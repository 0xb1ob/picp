import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { SERVICE_WORKER_JS } from "../src/viewer/service-worker.ts";

type Listener = (event: Record<string, unknown>) => void;

/** Run the worker script against a fake `self`; returns its listeners and what it asked the browser to do. */
function worker(windows: { url: string; navigate?: (url: string) => Promise<unknown> }[] = []) {
	const listeners = new Map<string, Listener>();
	const calls: unknown[][] = [];
	const warnings: unknown[] = [];
	const clients = windows.map((w) => ({
		url: w.url,
		navigate: async (url: string) => { calls.push(["navigate", url]); return w.navigate ? w.navigate(url) : undefined; },
		focus: async () => { calls.push(["focus", w.url]); },
	}));
	const self = {
		location: { origin: "https://cp.example.com" },
		addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
		skipWaiting: async () => { calls.push(["skipWaiting"]); },
		registration: { showNotification: async (title: string, options: unknown) => { calls.push(["showNotification", title, options]); } },
		clients: {
			claim: async () => { calls.push(["claim"]); },
			matchAll: async (options: unknown) => { calls.push(["matchAll", options]); return clients; },
			openWindow: async (url: string) => { calls.push(["openWindow", url]); },
		},
	};
	runInNewContext(SERVICE_WORKER_JS, { self, URL, console: { warn: (...args: unknown[]) => warnings.push(args) } });
	const fire = async (type: string, event: Record<string, unknown> = {}) => {
		const pending: Promise<unknown>[] = [];
		listeners.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
		await Promise.all(pending);
	};
	return { listeners, calls, warnings, fire };
}

const pushEvent = (json: () => unknown) => ({ data: { json } });

test("service worker: a push shows [project] kind with the headline, and nothing else", async () => {
	const sw = worker();
	await sw.fire("push", pushEvent(() => ({ project: "demo", kind: "plan approval", headline: "Approve?" })));
	assert.deepEqual(JSON.parse(JSON.stringify(sw.calls)), [["showNotification", "[demo] plan approval", { body: "Approve?" }]]);
	const options = sw.calls[0]?.[2] as Record<string, unknown>;
	assert.equal("actions" in options, false);
});

test("service worker: an unreadable or empty payload still notifies, and the parse failure is warned", async () => {
	const sw = worker();
	await sw.fire("push", pushEvent(() => { throw new SyntaxError("bad json"); }));
	await sw.fire("push", {});
	await sw.fire("push", pushEvent(() => ({ kind: "merge ask" })));
	assert.deepEqual(JSON.parse(JSON.stringify(sw.calls)), [
		["showNotification", "Command post needs you", { body: "Open Awaiting you" }],
		["showNotification", "Command post needs you", { body: "Open Awaiting you" }],
		["showNotification", "[project unknown] merge ask", { body: "Open Awaiting you" }],
	]);
	assert.equal(sw.warnings.length, 1);
});

test("service worker: a click opens Awaiting you in a new window when none is open", async () => {
	const sw = worker([{ url: "https://elsewhere.example/" }]);
	let closed = false;
	await sw.fire("notificationclick", { notification: { close: () => { closed = true; } } });
	assert.ok(closed);
	assert.deepEqual(sw.calls.slice(1), [["openWindow", "https://cp.example.com/#awaiting"]]);
});

test("service worker: a click navigates and focuses an open dashboard window; a failed navigate still focuses", async () => {
	const sw = worker([{ url: "https://cp.example.com/#more" }]);
	await sw.fire("notificationclick", { notification: { close: () => {} } });
	assert.deepEqual(sw.calls.slice(1), [["navigate", "https://cp.example.com/#awaiting"], ["focus", "https://cp.example.com/#more"]]);
	const failing = worker([{ url: "https://cp.example.com/", navigate: async () => { throw new TypeError("not controlled"); } }]);
	await failing.fire("notificationclick", { notification: { close: () => {} } });
	assert.deepEqual(failing.calls.slice(1).map((call) => call[0]), ["navigate", "focus"]);
	assert.equal(failing.warnings.length, 1);
});

test("service worker: install and activate take over at once", async () => {
	const sw = worker();
	await sw.fire("install");
	await sw.fire("activate");
	assert.deepEqual(sw.calls, [["skipWaiting"], ["claim"]]);
});
