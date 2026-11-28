/**
 * One shared `/api/stream?views=` EventSource per page: a browser allows six HTTP/1.1 connections per host, and one
 * stream per resource held enough of them to stall a plain fetch (the composer's "Checking …" control read).
 */
import type { Stream } from "./resource.ts";

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const REOPEN_MS = 100;
const CLOSED = 2, OPEN = 1;

type Subscriber = { views: readonly string[]; target: EventTarget };
const subscribers = new Set<Subscriber>();
let source: EventSource | null = null, key = "", attempt = 0;
let reopen: ReturnType<typeof setTimeout> | undefined;

/** The views a resource's legacy stream URL names (`?view=a` or `?views=a,b`); none for a URL that names none. */
function viewsOf(streamUrl: string): string[] {
	const query = new URL(streamUrl, "http://page").searchParams;
	return (query.get("views") ?? query.get("view") ?? "").split(",").filter(Boolean);
}

const fire = (type: string, only?: ReadonlySet<string>) => {
	for (const subscriber of [...subscribers]) {
		if (!only || subscriber.views.some((view) => only.has(view))) subscriber.target.dispatchEvent(new Event(type));
	}
};

function onRefresh(event: Event): void {
	let named: ReadonlySet<string> | undefined;
	try {
		const views = (JSON.parse(String((event as MessageEvent).data)) as { views?: unknown }).views;
		if (Array.isArray(views)) named = new Set(views.map(String));
	} catch { /* unparsable data refreshes every subscriber */ }
	fire("refresh", named);
}
const onOpen = () => { attempt = 0; fire("open"); };
function onError(): void {
	fire("error");
	// A CONNECTING source is the browser's own retry; a CLOSED one (a non-200 from a proxy mid-restart) never retries.
	if (source?.readyState === CLOSED) schedule(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!);
}

function close(): void {
	source?.removeEventListener("open", onOpen);
	source?.removeEventListener("refresh", onRefresh);
	source?.removeEventListener("error", onError);
	source?.close();
	source = null; key = "";
}

function schedule(ms: number): void {
	clearTimeout(reopen);
	reopen = setTimeout(connect, ms);
}

function connect(): void {
	reopen = undefined;
	const views = [...new Set([...subscribers].flatMap((subscriber) => subscriber.views))].sort();
	close();
	if (views.length === 0) return;
	key = views.join(",");
	try {
		source = new EventSource(`/api/stream?views=${key}`);
	} catch {
		fire("error");
		return schedule(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!);
	}
	source.addEventListener("open", onOpen);
	source.addEventListener("refresh", onRefresh);
	source.addEventListener("error", onError);
}

/** Reopens once the subscribed view set settles, or closes the source when nobody reads it. */
function sync(): void {
	if (subscribers.size === 0) { clearTimeout(reopen); reopen = undefined; attempt = 0; close(); return; }
	const wanted = [...new Set([...subscribers].flatMap((subscriber) => subscriber.views))].sort().join(",");
	// The first open waits only for the mounts of the same turn; a later change in the view set waits REOPEN_MS.
	if (!source && reopen === undefined) schedule(0);
	else if (wanted !== key && source) schedule(REOPEN_MS);
}

/** A resource's `Stream` over the shared source: `refresh` only for its views, `open`/`error` always; `close` leaves. */
export function liveStreamFor(streamUrl: string): Stream {
	const target = new EventTarget();
	const subscriber: Subscriber = { views: viewsOf(streamUrl), target };
	subscribers.add(subscriber);
	// Joining a source that is already open: say so, as a fresh EventSource would.
	if (source?.readyState === OPEN && subscriber.views.every((view) => key.split(",").includes(view))) setTimeout(() => { if (subscribers.has(subscriber)) target.dispatchEvent(new Event("open")); }, 0);
	sync();
	return Object.assign(target, { close() { if (subscribers.delete(subscriber)) sync(); } });
}
