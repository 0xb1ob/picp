/**
 * Per-view revisions from the stat identities of each view's source files, plus a 30 s clock bucket for the clocks a
 * view computes against `now`. One shared ticker per state dir tells subscribers which views changed; an unknown
 * top-level state entry marks every view changed (fails open), and a missed source is stale for at most CLOCK_MS.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { identity } from "./file-cache.ts";
import { OPERATOR_SESSIONS_FILE, readOperatorSessions } from "./operator-sessions.ts";
import { fleetJobs, isSafeId, PARENT_ID, resolveSessionFile, runtimeRoot, sessionLogFile, str, type ViewerState } from "./sessions.ts";

export const VIEW_NAMES = ["overview", "awaiting", "decided", "decisions", "sessions", "files", "map", "jobs", "job", "board", "reports", "report", "schedules", "stats"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];
export const CLOCK_MS = 30_000;
export const TICK_MS = 1_000;
export const HEARTBEAT_MS = 25_000;

type Views = readonly ViewName[];
const FLEET: Views = ["overview", "jobs", "job", "board", "map", "sessions", "decisions", "awaiting", "decided", "stats"];
const LEDGER: Views = ["overview", "jobs", "job", "board", "map", "decisions", "awaiting", "decided", "sessions", "schedules", "stats"];
const ASKS: Views = ["overview", "decisions", "awaiting", "decided", "sessions", "map"];
const MANDATES: Views = ["overview", "jobs", "board", "map", "decisions", "schedules"];
const HEALTH: Views = ["overview", "jobs", "job", "board"];
const CI: Views = [...HEALTH, "sessions"];
const SESSIONS: Views = ["sessions", "overview", "stats"];
const TRANSCRIPT: Views = ["sessions"];
const WORKER_TRANSCRIPT: Views = ["sessions", "job"];
const RUNS: Views = ["jobs", "job", "board", "overview", "sessions", "report"];
const REPORTS: Views = ["reports", "report", "board"];
const SCHEDULES: Views = ["schedules", "jobs"];

const FILES: Record<string, Views> = {
	"fleet.json": FLEET, "escalations.json": ASKS, "ci-watch.json": CI, "schedules.json": SCHEDULES, "schedule-policies.json": SCHEDULES, "schedule-runs.json": SCHEDULES,
	...Object.fromEntries(["awaiting-merge-watch.json", "main-ci.json", "health.json", "next-snapshot.json", "dispatch-queue.json",
		"native-wait.json", "quota-continuation.json", "parent.lock", "update.json"].map((name) => [name, HEALTH])),
};
/** Entries in the parent's own session dir that are not transcripts. */
const SESSION_FILES = ["cp-parent-control.json", "cp-parent-context.json", "cp-parent.sends.json", OPERATOR_SESSIONS_FILE];
/** Top-level state entries no streamed view reads (docs/storage.md); rewriting them must not refresh every view. */
const IGNORED = new Set(["viewer-dist", ".migrations", "daemon-runtime.json", "wakeups.json", "bridge-retry.jsonl", "tunnel-runtime.json", "repo-map", "tracker-tasks", "tracker-sync.json", "routing-migrations.jsonl"]);
const IGNORED_SUFFIX = /\.(log|lock|sock|reclaim|tmp)$/;

/** Each source's stat identity (`absent` when gone) and the views that read it, by a stable source key. */
export type Sources = Map<string, { id: string; views: Views }>;

const statId = (path: string): string => { try { return identity(statSync(path)); } catch { return "absent"; } };
const list = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

type Transcripts = Array<[key: string, path: string, views: Views]>;
/** Per state dir: live job ids and resolved transcripts, reused while their inputs' stat identities and bucket hold. */
const derived = new Map<string, { live?: [string, string[]]; transcripts?: [string, Transcripts] }>();

function liveIds(state: ViewerState): string[] {
	return fleetJobs(state).flatMap((job) => {
		const id = str(job.job_id), phase = str(job.phase);
		return id && isSafeId(id) && phase !== "done" && phase !== "failed" ? [id] : [];
	});
}

function transcripts(state: ViewerState, live: readonly string[]): Transcripts {
	const out: Transcripts = [];
	const parent = resolveSessionFile(state, PARENT_ID);
	if (parent) out.push(["transcript:parent", parent, TRANSCRIPT]);
	const operator = readOperatorSessions(join(state.stateDir, "sessions"))[0];
	if (operator) out.push(["transcript:operator", sessionLogFile(operator.file), TRANSCRIPT]);
	for (const id of live) {
		const file = resolveSessionFile(state, id);
		if (file) out.push([`transcript:${id}`, file, WORKER_TRANSCRIPT]);
	}
	return out;
}

/** One stat pass over every declared source of `state`; fleet and session records are parsed only when they move. */
export function sources(state: ViewerState, now = Date.now()): Sources {
	const out: Sources = new Map();
	const put = (key: string, path: string, views: Views) => out.set(key, { id: statId(path), views });
	const tree = (key: string, dir: string, views: Views) => {
		put(key, dir, views);
		for (const name of list(dir)) if (!IGNORED_SUFFIX.test(name)) put(`${key}/${name}`, join(dir, name), views);
	};
	put("jobs.json", join(runtimeRoot(state.home), "jobs.json"), LEDGER);
	for (const name of list(state.stateDir)) {
		const path = join(state.stateDir, name);
		const known = FILES[name] ?? (name.startsWith("native-availability") && name.endsWith(".json") ? HEALTH : undefined);
		if (known) put(name, path, known);
		else if (name === "operator") tree(name, path, ASKS);
		else if (name === "mandates") tree(name, path, MANDATES);
		else if (name === "sessions") {
			put(name, path, SESSIONS);
			for (const file of SESSION_FILES) put(`sessions/${file}`, join(path, file), SESSIONS);
		} else if (name === "runs") put(name, path, RUNS);
		else if (name === "artifacts" || name === "boards") put(name, path, REPORTS);
		else if (!IGNORED.has(name) && !IGNORED_SUFFIX.test(name)) put(name, path, VIEW_NAMES);
	}
	// The bucket bounds a missed input (a transcript's first record, a realpath) to one CLOCK_MS, as for any source.
	const bucket = Math.floor(now / CLOCK_MS), id = (key: string) => out.get(key)?.id ?? "absent";
	const memo = derived.get(state.stateDir) ?? {};
	derived.set(state.stateDir, memo);
	const liveKey = `${bucket}|${id("fleet.json")}`;
	if (memo.live?.[0] !== liveKey) memo.live = [liveKey, liveIds(state)];
	const live = memo.live[1];
	for (const job of live) tree(`runs/${job}`, join(state.stateDir, "runs", job), RUNS);
	const inputs = [liveKey, id("sessions"), id("sessions/cp-parent-control.json"), id(`sessions/${OPERATOR_SESSIONS_FILE}`), ...live.map((job) => id(`runs/${job}/status.json`))].join("|");
	if (memo.transcripts?.[0] !== inputs) memo.transcripts = [inputs, transcripts(state, live)];
	for (const [key, path, views] of memo.transcripts[1]) put(key, path, views);
	return out;
}

/** The views whose sources differ between two passes, a source that appeared or went included. */
export function changedViews(before: Sources, after: Sources): Set<ViewName> {
	const out = new Set<ViewName>();
	for (const [key, now] of after) if (before.get(key)?.id !== now.id) for (const view of now.views) out.add(view);
	for (const [key, was] of before) if (!after.has(key)) for (const view of was.views) out.add(view);
	return out;
}

/** Per view: the sha1 of its sources' sorted identities and the clock bucket of `now`. */
export function revisions(state: ViewerState, now = Date.now()): Map<ViewName, string> {
	const lines = new Map<ViewName, string[]>(VIEW_NAMES.map((view) => [view, []]));
	for (const [key, source] of sources(state, now)) for (const view of source.views) lines.get(view)!.push(`${key}=${source.id}`);
	const bucket = Math.floor(now / CLOCK_MS);
	return new Map(VIEW_NAMES.map((view) => [view, createHash("sha1").update(`${bucket}\n${lines.get(view)!.sort().join("\n")}`).digest("hex")]));
}

/** `?views=a,b` (1–14 known names, duplicates dropped) or the legacy `?view=a`, in VIEW_NAMES order; else undefined. */
export function streamViews(query: URLSearchParams): ViewName[] | undefined {
	const listed = query.get("views");
	const names = new Set(listed !== null ? listed.split(",") : query.has("view") ? [query.get("view")!] : []);
	if (names.size === 0 || ![...names].every((name) => (VIEW_NAMES as readonly string[]).includes(name))) return undefined;
	return VIEW_NAMES.filter((view) => names.has(view));
}

type Subscriber = { views: ReadonlySet<ViewName>; onChange: (changed: ViewName[]) => void };
type Watch = { subscribers: Set<Subscriber>; last: Sources; bucket: number; timer: ReturnType<typeof setInterval> };
const watches = new Map<string, Watch>();

/** Running tickers in this process: one per state dir with a subscriber. */
export const activeTicks = (): number => watches.size;

function tick(state: ViewerState, watch: Watch, now: () => number): void {
	const at = now(), bucket = Math.floor(at / CLOCK_MS);
	let changed: Set<ViewName>;
	try {
		const next = sources(state, at);
		changed = bucket !== watch.bucket ? new Set(VIEW_NAMES) : changedViews(watch.last, next);
		watch.last = next;
	} catch {
		changed = new Set(VIEW_NAMES); // An unreadable pass fails open: every view refetches.
	}
	watch.bucket = bucket;
	if (changed.size === 0) return;
	for (const subscriber of [...watch.subscribers]) {
		const mine = VIEW_NAMES.filter((view) => changed.has(view) && subscriber.views.has(view));
		if (mine.length) subscriber.onChange(mine);
	}
}

/**
 * Calls `onChange` with the changed views among `views`, checked every TICK_MS by one ticker per state dir that the
 * first subscriber starts (with its `now`) and the last one's returned stop ends.
 */
export function subscribe(state: ViewerState, views: Views, onChange: (changed: ViewName[]) => void, now: () => number = Date.now): () => void {
	let watch = watches.get(state.stateDir);
	if (!watch) {
		// A throwing first read leaves no ticker: the pass runs before the timer exists.
		const at = now(), last = sources(state, at);
		const created: Watch = { subscribers: new Set(), last, bucket: Math.floor(at / CLOCK_MS), timer: setInterval(() => tick(state, created, now), TICK_MS) };
		created.timer.unref();
		watches.set(state.stateDir, watch = created);
	}
	const subscriber: Subscriber = { views: new Set(views), onChange };
	const owner = watch;
	owner.subscribers.add(subscriber);
	return () => {
		owner.subscribers.delete(subscriber);
		if (owner.subscribers.size === 0 && watches.get(state.stateDir) === owner) { clearInterval(owner.timer); watches.delete(state.stateDir); }
	};
}
