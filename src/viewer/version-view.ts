/**
 * "Are we running the latest?" (cp-kz20): `GET /api/version`, the cp-bridge footer line and `/cp-version` all read
 * this one module. Three layers:
 *
 *  1. upstream — the checkout's HEAD against the local `refs/remotes/origin/main` the updater fetches
 *     (`state/update.json` says when, and why it did not apply); this module never fetches;
 *  2. processes — viewer, parent host, CP parent and operator session, each by the commit its record carries
 *     (`parent.lock`, the highest `parent-host.<gen>.json`, `operator/dashboard.json`) against that HEAD;
 *  3. the page's own bundle — compared by the client against `bundle.script`.
 *
 * Records are read for `pid`, `started_at` and `commit` only, never spread: the host and dashboard records hold
 * tokens. Git runs through the bounded `runGit` and is cached for `GIT_CACHE_MS` per repository.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_ROOT } from "../home.ts";
import type { ProcessRole, ProcessVersion, UpstreamVersion, VersionLevel, VersionResponse } from "./api-types.ts";
import { runGit } from "./git-read.ts";
import { type Commit, commitField, type GitRunner, headCommit, LOADED_AT, LOADED_COMMIT } from "./loaded-commit.ts";
import { pidAlive } from "./overview-health.ts";
import { type Json, readObject, resolveStateDir, str } from "./sessions.ts";

export const GIT_CACHE_MS = 10_000;
/** 6 × the updater's 5-min tick: an older fetch no longer says what upstream is. */
export const UPSTREAM_FRESH_MS = 30 * 60_000;
const DETAIL_MAX = 160;
const COUNT_MAX_BYTES = 64 * 1024;
/** Results a run records only after its `git fetch origin main` succeeded (src/service/update.ts). */
const FETCHED = new Set(["updated", "up_to_date", "skipped_ahead", "skipped_bad_sha", "skipped_busy", "drain_timeout"]);
/** `UPDATE_FAILURES` (src/service/health.ts), which pushes them; not imported, health.ts imports the viewer server. */
const ALERT_RESULTS = new Set(["failed", "rolled_back", "rollback_failed", "drain_timeout", "migration_required", "config_invalid"]);
export const FIXES: Record<ProcessRole, string> = {
	viewer: "cp-daemon reload (or restart cp-operator if it serves this viewer)",
	host: "drain, then restart the parent host (cp-daemon reload)",
	parent: "drain, then cp_parent rotate",
	operator: "Restart session (⋮), or /quit then cp-operator -c",
};

export interface ProcessRecord { pid: number | null; started_at: string | null; commit: string | null }
export interface GitFacts { deployed: Commit | null; behind: number | null; ahead: number | null; reason: string | null }

const short = (sha: string) => sha.slice(0, 7);
const pick = (raw: Json | undefined): ProcessRecord | undefined => raw && {
	pid: Number.isInteger(raw.pid) && (raw.pid as number) > 0 ? (raw.pid as number) : null,
	started_at: str(raw.started_at) ?? null,
	commit: commitField(raw.commit) ?? null,
};

/** `down`: no record or a dead pid; `current`/`stale` by commit; a record without one is `stale` only when it started before the last update. */
export function classifyProcess(role: ProcessRole, record: ProcessRecord | undefined, alive: boolean, deployed: Commit | null, updatedAt: string | null): ProcessVersion {
	const base = { role, commit: record?.commit ?? null, started_at: record?.started_at ?? null, pid_alive: alive };
	if (!record) return { ...base, state: "down", why: "no record", fix: null };
	if (!alive) return { ...base, state: "down", why: record.pid ? `pid ${record.pid} not running` : "no pid recorded", fix: null };
	if (!deployed) return { ...base, state: "unknown", why: "checkout HEAD unreadable", fix: null };
	if (record.commit === deployed.sha) return { ...base, state: "current", why: `on ${short(deployed.sha)}`, fix: null };
	if (record.commit) return { ...base, state: "stale", why: `on ${short(record.commit)}, checkout at ${short(deployed.sha)}`, fix: FIXES[role] };
	const started = Date.parse(record.started_at ?? "");
	if (updatedAt && started < Date.parse(updatedAt)) return { ...base, state: "stale", why: `no commit recorded; started before the update at ${updatedAt}`, fix: FIXES[role] };
	return { ...base, state: "unknown", why: "no commit recorded (started before version records)", fix: FIXES[role] };
}

/** The ref comparison, plus whether the updater's last run proves that ref fresh. */
export function classifyUpstream(git: GitFacts, update: Json | undefined, enabled: boolean, now: number): UpstreamVersion {
	const result = str(update?.last_result) ?? null;
	const lastRun = str(update?.last_run_at) ?? null;
	const fresh = result !== null && FETCHED.has(result) && lastRun !== null && now - Date.parse(lastRun) <= UPSTREAM_FRESH_MS;
	const detail = str(update?.detail);
	const failures = update?.fetch_failures;
	const updater = update ? {
		enabled, result, since: str(update.since) ?? null, last_run_at: lastRun,
		detail: detail ? (detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail) : null,
		fetch_failures: Number.isInteger(failures) && (failures as number) > 0 ? (failures as number) : 0,
	} : null;
	const { behind, ahead } = git;
	const state = behind === null || ahead === null ? "unknown" : behind && ahead ? "diverged" : behind ? "behind" : ahead ? "ahead" : "current";
	return { state, behind, ahead, reason: git.reason, checked_at: fresh && state !== "unknown" ? lastRun : null, updater };
}

/** One level and a short label: alert > warn > unknown > ok. `sessionStale` names the operator session's own staleness. */
export function overall(deployed: Commit | null, upstream: UpstreamVersion, processes: ProcessVersion[], sessionStale = "session stale — restart"): { level: VersionLevel; label: string } {
	if (!deployed) return { level: "unknown", label: "version unknown (checkout HEAD unreadable)" };
	const result = upstream.updater?.result ?? null;
	const alert = [
		...(processes.some((p) => p.role === "operator" && p.state === "stale") ? [sessionStale] : []),
		...(result && ALERT_RESULTS.has(result) ? [`update ${result}`] : []),
		...((upstream.updater?.fetch_failures ?? 0) >= 3 ? [`fetch failing ×${upstream.updater?.fetch_failures}`] : []),
	];
	const quiet = !result || result === "up_to_date" || result === "updated" || ALERT_RESULTS.has(result);
	const warn = [
		...(upstream.behind ? [`${upstream.behind} behind${quiet ? "" : ` (${result})`}`] : []),
		...processes.filter((p) => p.role !== "operator" && p.state === "stale").map((p) => `${p.role} stale`),
	];
	if (alert.length || warn.length) return { level: alert.length ? "alert" : "warn", label: [...warn.slice(0, 1), ...alert, ...warn.slice(1)].join(" · ") };
	const sha = short(deployed.sha);
	const unknown = processes.find((p) => p.state === "unknown");
	if (upstream.state === "unknown") return { level: "unknown", label: `${sha} · upstream unknown` };
	if (!upstream.checked_at) return { level: "unknown", label: `${sha} · upstream unchecked` };
	if (unknown) return { level: "unknown", label: `${sha} · ${unknown.role} unknown` };
	return { level: "ok", label: upstream.ahead ? `${upstream.ahead} ahead · ${sha}` : `latest · ${sha}` };
}

async function readGitFacts(repo: string, git: GitRunner): Promise<GitFacts> {
	const [deployed, counts] = await Promise.all([
		headCommit(repo, git),
		git(repo, ["log", "--format=%m", "--left-right", "HEAD...refs/remotes/origin/main"], { maxBytes: COUNT_MAX_BYTES }),
	]);
	if (!counts.ok) return { deployed, behind: null, ahead: null, reason: `no comparison with origin/main: ${(counts.reason ?? "git failed").slice(0, DETAIL_MAX)}` };
	const marks = counts.stdout.split("\n");
	return { deployed, ahead: marks.filter((m) => m === "<").length, behind: marks.filter((m) => m === ">").length, reason: counts.truncated ? "counts capped (64 KiB of log)" : null };
}

const gitCache = new Map<string, { at: number; facts: Promise<GitFacts> }>();
/** HEAD and the origin/main counts for `repo`, at most once per `GIT_CACHE_MS` (an in-flight read is shared). */
export function gitFacts(repo: string, now: number, git: GitRunner = runGit): Promise<GitFacts> {
	const hit = gitCache.get(repo);
	if (hit && now - hit.at < GIT_CACHE_MS) return hit.facts;
	const facts = readGitFacts(repo, git);
	gitCache.set(repo, { at: now, facts });
	return facts;
}

function hostRecord(stateDir: string): Json | undefined {
	let names: string[];
	try { names = readdirSync(stateDir); } catch { return undefined; }
	const gen = Math.max(0, ...names.flatMap((name) => /^parent-host\.([1-9]\d*)\.json$/.exec(name)?.[1] ?? []).map(Number));
	return gen ? readObject(join(stateDir, `parent-host.${gen}.json`)) : undefined;
}

export interface VersionOptions {
	home: string;
	stateDir?: string;
	/** The checkout to compare against: default `CP_VERSION_REPO`, else this package's root. */
	repo?: string;
	/** The app script this server serves (`ViewerApp.script`). */
	script?: string | null;
	/** Test seams. */
	now?: () => number;
	git?: GitRunner;
	alive?: (pid: number) => boolean;
	self?: ProcessRecord;
	env?: NodeJS.ProcessEnv;
}

/** Never throws for missing or unreadable files: each is a `down`/`unknown` with a reason. */
export async function readVersion(options: VersionOptions): Promise<VersionResponse> {
	const now = (options.now ?? Date.now)();
	const stateDir = options.stateDir ?? resolveStateDir(options.home);
	const alive = options.alive ?? pidAlive;
	const repo = options.repo ?? (options.env ?? process.env).CP_VERSION_REPO ?? PACKAGE_ROOT;
	const [facts, loaded] = await Promise.all([gitFacts(repo, now, options.git), options.self ? undefined : LOADED_COMMIT]);
	const update = readObject(join(stateDir, "update.json"));
	const enabled = readObject(join(dirname(stateDir), "data", "update.json"))?.enabled === true;
	const updatedAt = str(update?.updated_at) ?? null;
	const self = options.self ?? { pid: process.pid, started_at: LOADED_AT, commit: loaded?.sha ?? null };
	const records: Array<[ProcessRole, ProcessRecord | undefined]> = [
		["viewer", self],
		["host", pick(hostRecord(stateDir))],
		["parent", pick(readObject(join(stateDir, "parent.lock")))],
		["operator", pick(readObject(join(stateDir, "operator", "dashboard.json")))],
	];
	const processes = records.map(([role, record]) => classifyProcess(role, record, role === "viewer" || (record?.pid ? alive(record.pid) : false), facts.deployed, updatedAt));
	const upstream = classifyUpstream(facts, update, enabled, now);
	return {
		generated_at: new Date(now).toISOString(),
		deployed: facts.deployed,
		upstream,
		processes,
		bundle: { script: options.script ?? null },
		overall: overall(facts.deployed, upstream, processes),
	};
}

/** The cp-bridge footer line: the operator layer is this session's own loaded commit, not its record. */
export function formatTerminal(view: VersionResponse, own: string | null | undefined): { level: VersionLevel; text: string } {
	const deployed = view.deployed;
	const state = !own || !deployed ? "unknown" : own === deployed.sha ? "current" : "stale";
	const processes = view.processes.map((p) => (p.role === "operator" ? { ...p, state, commit: own ?? null } as ProcessVersion : p));
	const stale = own && deployed ? `this session stale (on ${short(own)}, checkout at ${short(deployed.sha)}) — restart` : undefined;
	const { level, label } = overall(deployed, view.upstream, processes, stale);
	return { level, text: `version: ${label}` };
}
