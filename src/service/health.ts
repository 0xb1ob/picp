/**
 * cp-daemon's health job (a oneshot child, every 5 min; cp-daemon v1 P3): the watchdog. It records each check's
 * state in `state/health.json` and pushes nothing: the dashboard (Overview `health failing`, and the parent's
 * `service_health` escalation, src/service-alerts.ts) is where a failure or a recovery shows.
 *
 *   parent      no responsive host, `hello.parent` null, or the lock not held by a live pid (2 runs in a row;
 *               never while `state/update.json` `phase` is not idle, a `held` rollback excepted) → `health: parent down`
 *   viewer      `/api/identity` not 200 for this home within 3 s (2 runs; never mid-update) → `health: viewer down`
 *   supervisor  cp-daemon's parent supervisor `failed` (`state/daemon-runtime.json`) → `health: crash-looping`
 *   disk        free < 5 GiB or < 10 % of the home's filesystem                → `health: disk low`
 *   git         `git ls-remote --exit-code origin HEAD` in the app fails (hourly) → `health: git credential`
 *   gh          `gh auth status --hostname github.com` fails (hourly)          → `health: gh credential`
 *   update      `last_result` a failure, or `fetch_failed` 3 times; keyed `result:to` (`drain_timeout:since`, one
 *               key per episode), so a new failure is a new key                 → `health: update failed`
 *   relay       a parent→operator relay unacked 10 min (`state/operator/relay-outbox.json` vs `relay-acks.jsonl`), or an open
 *               escalation 20 min old no ack, discard or open ask accounts for; keyed `relay:<id>` / `escalation:<id>`
 *                                                                               → `health: relay unseen`
 *
 * Its record is `state/health.json` (this unit is its only writer). It never reads push keys or subscriptions and
 * never sends a push. No authority: it reads and probes; it never starts or stops anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { configureLayout, isoTimestamp, layoutForHome } from "../contracts.ts";
import { isPidAlive } from "../fleet.ts";
import { PACKAGE_ROOT, resolveHome } from "../home.ts";
import { atomicWriteJson } from "../json-store.ts";
import { currentHost, ParentHostClient, parentHostPaths } from "../parent-host.ts";
import { hostHeaderFor } from "../viewer/server.ts";
import { viewerAddress } from "../viewer/cli.ts";
import { daemonPaths } from "./daemon-files.ts";
import { EscalationStore } from "../escalation.ts";
import { OPERATOR_RELAY_OUTBOX_CAP, OperatorRelayAcks, OperatorRelayOutbox, oldestUnacked, operatorRelayAcksFile, operatorRelayOutboxFile, pendingRelays } from "../operator-outbox.ts";
import { OperatorAsks } from "../operator-asks.ts";

export const HEALTH_CHECKS = ["parent", "viewer", "supervisor", "disk", "git", "gh", "update", "relay"] as const;
export type HealthCheck = (typeof HEALTH_CHECKS)[number];
/** cp-6fyl PR2: a relay the operator session has not acked this long, or an open escalation unseen this long (the 600 s backstop plus one alarm window). */
export const RELAY_UNSEEN_SECONDS = 600;
export const ESCALATION_UNSEEN_SECONDS = 1200;
/** Runs in a row a failure must last before it counts (a restart blip is not an outage). */
const CONSECUTIVE: Partial<Record<HealthCheck, number>> = { parent: 2, viewer: 2 };
export const UPDATE_FAILURES = ["failed", "drain_timeout", "rolled_back", "rollback_failed", "config_invalid", "migration_required"];
const DETAIL_MAX = 200;

/** One probe's answer: ok, failing (with its dedupe key), or no signal this run (the check keeps its state). */
export type Observation = { ok: true } | { ok: false; key: string; detail: string } | { skip: string };

export interface CheckRecord {
	status: "ok" | "fail";
	key: string | null;
	since: string;
	detail: string;
	fails: number;
	checked_at: string;
}
export interface HealthRecord { schema_version: 1; last_run_at: string; checks: Partial<Record<HealthCheck, CheckRecord>> }

export const healthFile = (stateDir: string): string => join(stateDir, "health.json");

/** The record, or undefined when absent or unreadable (a fresh start: nothing was promised). */
export function readHealth(stateDir: string): HealthRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(healthFile(stateDir), "utf8")) as HealthRecord;
		return raw?.schema_version === 1 && raw.checks && typeof raw.checks === "object" ? raw : undefined;
	} catch {
		return undefined;
	}
}

const clip = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Fold one observation into a check's record (pure). */
export function observe(name: HealthCheck, prior: CheckRecord | undefined, seen: Observation, at: string): CheckRecord | undefined {
	if ("skip" in seen) return prior;
	const base: CheckRecord = prior ?? { status: "ok", key: null, since: at, detail: "ok", fails: 0, checked_at: at };
	if (seen.ok) return { ...base, status: "ok", key: null, detail: "ok", fails: 0, since: base.status === "ok" ? base.since : at, checked_at: at };
	const fails = base.fails + 1;
	if (fails < (CONSECUTIVE[name] ?? 1)) return { ...base, fails, checked_at: at };
	return { ...base, status: "fail", key: seen.key, detail: clip(seen.detail, DETAIL_MAX), fails, since: base.status === "fail" ? base.since : at, checked_at: at };
}

export type HealthProbes = Record<HealthCheck, (prior: CheckRecord | undefined) => Promise<Observation> | Observation>;

export interface HealthRunOptions {
	stateDir: string;
	probes: HealthProbes;
	now?: () => Date;
	log?: (line: string) => void;
}

/** One watchdog run: probe every check and write `state/health.json`. Nothing is pushed. */
export async function runHealth(options: HealthRunOptions): Promise<HealthRecord> {
	const log = options.log ?? ((line: string) => console.error(`health: ${line}`));
	const at = isoTimestamp((options.now ?? (() => new Date()))());
	const prior = readHealth(options.stateDir);
	const record: HealthRecord = { schema_version: 1, last_run_at: at, checks: { ...prior?.checks } };
	for (const name of HEALTH_CHECKS) {
		let seen: Observation;
		try {
			seen = await options.probes[name](record.checks[name]);
		} catch (error) {
			seen = { skip: `probe failed: ${(error as Error).message}` };
		}
		if ("skip" in seen && record.checks[name] === undefined) continue;
		if ("skip" in seen) log(`${name}: skipped (${seen.skip})`);
		const next = observe(name, record.checks[name], seen, at);
		if (next) record.checks[name] = next;
	}
	atomicWriteJson(healthFile(options.stateDir), record);
	return record;
}

export interface HostProbeOptions {
	home: string;
	app?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seams. */
	run?: (command: string, args: readonly string[], timeoutMs: number) => { status: number; stdout: string };
	fetch?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;
	now?: () => Date;
}

/** The production probes for `home` (multi mode). */
export function hostProbes(options: HostProbeOptions): HealthProbes {
	const home = resolve(options.home);
	const env = options.env ?? process.env;
	const layout = layoutForHome("multi", home);
	const stateDir = join(home, layout.state);
	const run = options.run ?? ((command, args, timeoutMs) => {
		const out = spawnSync(command, [...args], { encoding: "utf8", timeout: timeoutMs, env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
		return { status: out.status ?? 1, stdout: out.stdout ?? "" };
	});
	const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
	const now = options.now ?? (() => new Date());
	const midUpdate = (): string | undefined => {
		const update = readJson(join(stateDir, "update.json"));
		// A rollback held back by a live worker (`held`) has no run in flight: the fleet runs on, so it is watched.
		return typeof update?.phase === "string" && update.phase !== "idle" && update.held !== true ? `update phase ${update.phase}` : undefined;
	};
	const hourly = (prior: CheckRecord | undefined) => prior !== undefined && now().getTime() - Date.parse(prior.checked_at) < 3_600_000;
	const failed = (detail: string): Observation => ({ ok: false, key: "down", detail });
	return {
		parent: async () => {
			const updating = midUpdate();
			if (updating) return { skip: updating };
			const { record } = currentHost(parentHostPaths(home, "multi"));
			if (!record || !isPidAlive(record.pid)) return failed("no parent host is running");
			const client = await ParentHostClient.connect(record, 3_000).catch(() => undefined);
			if (!client) return failed(`parent host pid ${record.pid} does not answer`);
			const parentPid = client.parentPid;
			client.disconnect();
			if (parentPid === undefined) return failed(`parent host pid ${record.pid} runs no parent`);
			const lock = readJson(join(home, layout.parentLock))?.pid;
			if (typeof lock !== "number" || !isPidAlive(lock)) return failed("state/parent.lock is not held by a live pid");
			return { ok: true };
		},
		viewer: async () => {
			const updating = midUpdate();
			if (updating) return { skip: updating };
			const down = await viewerDown(home, env, fetcher);
			return down ? failed(down) : { ok: true };
		},
		supervisor: () => {
			const units = readJson(daemonPaths(home).runtime)?.units as { parent?: { state?: string; result?: string } } | undefined;
			if (!units?.parent) return { skip: "no cp-daemon runtime record (state/daemon-runtime.json)" };
			const { state, result } = units.parent;
			return state === "failed" ? { ok: false, key: result || "failed", detail: `cp-daemon's parent supervisor is failed (${result ?? "failed"}); cp-daemon log` } : { ok: true };
		},
		disk: () => {
			const fs = statfsSync(home);
			const free = fs.bavail * fs.bsize;
			const share = fs.blocks > 0 ? fs.bavail / fs.blocks : 1;
			return free < 5 * 1024 ** 3 || share < 0.1 ? { ok: false, key: "low", detail: `${(free / 1024 ** 3).toFixed(1)} GiB free (${Math.round(share * 100)} %) under ${home}` } : { ok: true };
		},
		git: (prior) => {
			if (hourly(prior)) return { skip: "checked within the hour" };
			return run("git", ["-C", options.app ?? PACKAGE_ROOT, "ls-remote", "--exit-code", "origin", "HEAD"], 20_000).status === 0 ? { ok: true } : { ok: false, key: "failed", detail: `git ls-remote origin fails in ${options.app ?? PACKAGE_ROOT}: the updater cannot fetch` };
		},
		gh: (prior) => {
			if (hourly(prior)) return { skip: "checked within the hour" };
			return ghLoggedIn((...args) => run("gh", args, 10_000).status === 0) ? { ok: true } : { ok: false, key: "failed", detail: "gh auth status --active fails: run gh auth login" };
		},
		update: () => {
			const update = readJson(join(stateDir, "update.json"));
			const result = typeof update?.last_result === "string" ? update.last_result : undefined;
			if (!result) return { skip: "no update result recorded" };
			const to = typeof update?.to === "string" ? update.to : "";
			// One drain_timeout episode is one push: the updater keeps `since` while the result repeats, but `to` moves with origin/main (N7).
			const episode = result === "drain_timeout" && typeof update?.since === "string" ? update.since : to;
			if (UPDATE_FAILURES.includes(result) || (result === "fetch_failed" && Number(update?.fetch_failures) >= 3)) return { ok: false, key: `${result}:${episode}`, detail: `auto-update ${result}${to ? ` (${to.slice(0, 12)})` : ""}; see state/update.json and cp-daemon log` };
			return result === "updated" || result === "up_to_date" ? { ok: true } : { skip: `update ${result}` };
		},
		relay: () => relayObservation(home, stateDir, now()),
	};
}

/**
 * The last line of defense for the parent→operator relays (cp-6fyl PR2). Two failures, read from the host's outbox, the
 * operator's ack journal, the escalations and the asks — never from the parent or the operator session themselves:
 *  - a relay unacked and not discarded for `RELAY_UNSEEN_SECONDS` (key `relay:<id>`);
 *  - an open escalation older than `ESCALATION_UNSEEN_SECONDS` that no ack, discard or open ask accounts for (key `escalation:<id>`).
 * A missing outbox is no signal (an old host, or nothing relayed yet); an unreadable file is a failure, never an empty read.
 */
function relayObservation(home: string, stateDir: string, now: Date): Observation {
	const outboxFile = operatorRelayOutboxFile(stateDir);
	if (!existsSync(outboxFile)) return { skip: "no relay outbox" };
	try {
		const outbox = new OperatorRelayOutbox(outboxFile).read();
		const fold = new OperatorRelayAcks(operatorRelayAcksFile(stateDir)).fold();
		const oldest = oldestUnacked(outbox, fold, now);
		if (oldest && oldest.ageSeconds >= RELAY_UNSEEN_SECONDS) {
			const { entry } = oldest;
			// An ack-capable session wrote a `consumer` line at its start; an old bridge never does, and a dead one cannot ack.
			const newer = fold.consumer !== undefined && Date.parse(fold.consumer.at) >= Date.parse(entry.queued_at);
			const capable = newer || (fold.consumer !== undefined && isPidAlive(fold.consumer.pid));
			return { ok: false, key: `relay:${entry.id}`, detail: `${pendingRelays(outbox, fold).length} relay(s) unseen by the main session, oldest ${entry.id} ${Math.floor(oldest.ageSeconds / 60)} min (${entry.relay.kind})${capable ? "" : " — no ack-capable operator session; relaunch it (dashboard: Restart session)"}` };
		}
		const settled = [...fold.acked.keys(), ...fold.discarded.keys()];
		const represented = new Set(new OperatorAsks(join(stateDir, "operator", "asks.jsonl")).open().map((ask) => ask.source_escalation));
		const unseen = new EscalationStore({ home }).open()
			.filter((item) => now.getTime() - Date.parse(item.created_at) >= ESCALATION_UNSEEN_SECONDS * 1000 && !represented.has(item.id) && !settled.some((id) => id === `esc:${item.id}` || id.startsWith(`esc:${item.id}#`)))
			.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
		if (unseen) return { ok: false, key: `escalation:${unseen.id}`, detail: `escalation ${unseen.id} (${unseen.kind}) open ${Math.floor((now.getTime() - Date.parse(unseen.created_at)) / 60_000)} min and unseen by the main session` };
		if (outbox.entries.length > OPERATOR_RELAY_OUTBOX_CAP) return { ok: false, key: "over-cap", detail: `outbox over cap: ${outbox.entries.length} entries in ${outboxFile}` };
		return { ok: true };
	} catch (error) {
		return { ok: false, key: "unreadable", detail: (error as Error).message };
	}
}

/**
 * Is gh logged in for the *active* account? The one probe the watchdog and the installer share.
 * Plain `gh auth status` exits 1 when any stored account is invalid; only the active one matters.
 * A gh without `--active` refuses the flag, and `gh api user` answers for the active account instead.
 */
export function ghLoggedIn(ok: (...args: string[]) => boolean): boolean {
	return ok("auth", "status", "--active") || ok("api", "user", "--jq", ".login");
}

/** Why this home's viewer does not answer `/api/identity` for it within 3 s; undefined when it does. */
export async function viewerDown(home: string, env: NodeJS.ProcessEnv, fetcher: NonNullable<HostProbeOptions["fetch"]> = (url, init) => fetch(url, init)): Promise<string | undefined> {
	let address: { host: string; port: number };
	try {
		address = viewerAddress(env, true);
	} catch (error) {
		return (error as Error).message;
	}
	const url = `http://${hostHeaderFor(address.host, address.port)}/api/identity`;
	try {
		const reply = await fetcher(url, { headers: { host: hostHeaderFor(address.host, address.port) }, signal: AbortSignal.timeout(3_000) });
		const body = reply.status === 200 ? (await reply.json()) as { home?: unknown } : undefined;
		return body?.home === home ? undefined : `${url} answered ${reply.status}${body ? ` for home ${String(body.home)}` : ""}`;
	} catch (error) {
		return `${url} did not answer: ${(error as Error).message}`;
	}
}

function readJson(file: string): Record<string, unknown> | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

if (import.meta.main) {
	const home = resolveHome();
	configureLayout("multi", home);
	const layout = layoutForHome("multi", home);
	runHealth({ stateDir: join(home, layout.state), probes: hostProbes({ home }) }).then(
		(record) => {
			const failing = HEALTH_CHECKS.filter((name) => record.checks[name]?.status === "fail");
			console.error(`health: ${failing.length ? `failing: ${failing.join(", ")}` : "all ok"}`);
			process.exit(0);
		},
		(error: Error) => {
			console.error(`health: failed: ${error.stack ?? error.message}`);
			process.exit(1);
		},
	);
}
