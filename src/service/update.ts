/**
 * cp-daemon's update job (a oneshot child, every 5 min; cp-daemon v1 P4, cutover cp-txbb): apply a moved
 * `origin/main` of the command-post checkout when the fleet is idle, and roll back on failure.
 *
 *   guards    runs as cp-daemon's update job (`CP_DAEMON_JOB=update`: cp-daemon serializes runs) unless
 *             `--dry-run`; anything else with `data/daemon.json` present is refused, and without it (a legacy
 *             cp-update.service) records `migration_required` and changes nothing; `data/update.json` absent
 *             → off, invalid → `config_invalid`; a run interrupted mid-phase takes the rollback path first
 *   schedule  disabled → `skipped_disabled`; under `interval_min` since the last run → silent (4× after a
 *             `drain_timeout`)
 *   skips     dirty → `skipped_dirty`; not on main → `skipped_branch`; `git fetch origin main` fails →
 *             `fetch_failed` (counted); ahead of origin/main → `skipped_ahead`; nothing new → `up_to_date`;
 *             origin/main is the `bad_sha` → `skipped_bad_sha`; a live script pid, or a mid-turn worker (an idle
 *             held/waiting one does not block) → `skipped_busy`; after 4× interval_min of that, only a script
 *             still skips: the drain decides
 *   drain     host `drain 600`, wait ≤ 660 s for `drained`; a timeout → host `drainCancel` → `drain_timeout`
 *   update    host `stop`, cp-daemon `hold` (the viewer), `git merge --ff-only <to>`, `npm ci` only when
 *             package-lock.json changed, cp-daemon `reload` (a new inner: parent supervisor and viewer)
 *   verify    ≤ 120 s: a host running a parent whose `/doctor` is not an error, and the viewer's identity
 *             → `updated`; + ≤ 300 s while the parent is alive but busy (PARENT_UNSETTLED, or doctor queued
 *             behind a live parent per the status read), then accepted with `doctor deferred` in the detail
 *   rollback  a failure after the merge: drain again (a restarted parent reopened dispatch; live workers that
 *             will not settle defer it, phase stays `rolling_back`, retried after 4× the interval), stop,
 *             `git reset --keep <from>`, npm ci if the lock changed, restart, verify → `rolled_back` (`bad_sha`,
 *             never retried) or `rollback_failed` (sticky until a human removes state/update.json; `bad_sha`
 *             unchanged); a failure before the merge: reload → `failed`; a run that died after `drained`:
 *             restart it
 *
 * Its record is `state/update.json` (its only writer). It never pushes: after every failure it asks
 * cp-daemon for a health run, which sends the one notice. No authority: host ops `hello`, `drain`, `drainCancel`,
 * `stop`, `doctor`, `status` only; it never dispatches, decides or merges and never writes the fleet or the ledger.
 * Static imports only: the checkout moves under it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configureLayout, isoTimestamp, layoutForHome } from "../contracts.ts";
import { type DrainRecord, liveWorkerJobs, readDrain, restartActivity } from "../drain.ts";
import { FleetStore, isPidAlive } from "../fleet.ts";
import { PACKAGE_ROOT, resolveHome } from "../home.ts";
import { atomicWriteJson } from "../json-store.ts";
import { PARENT_UNSETTLED } from "../parent-diagnostics.ts";
import { currentHost, ParentHostClient, parentHostPaths } from "../parent-host.ts";
import { readStatusFile } from "../run-artifacts.ts";
import { UPDATE_FAILURES, viewerDown } from "./health.ts";
import { type DaemonControl, daemonControl } from "./daemon-control.ts";
import type { RunResult } from "./install.ts";

export type UpdateResult = "updated" | "up_to_date" | "skipped_disabled" | "skipped_dirty" | "skipped_branch" | "skipped_ahead" | "skipped_bad_sha" | "skipped_busy" | "fetch_failed" | "failed" | "drain_timeout" | "rolled_back" | "rollback_failed" | "config_invalid" | "migration_required";
export type UpdatePhase = "idle" | "draining" | "updating" | "verifying" | "rolling_back";

export interface UpdateState {
	schema_version: 1;
	phase: UpdatePhase;
	last_run_at?: string;
	last_result?: UpdateResult;
	/** When `last_result` first took its current value. */
	since?: string;
	detail?: string;
	from?: string;
	to?: string;
	/** package-lock.json differs between `from` and `to`. */
	lock?: boolean;
	/** A target that rolled back: never retried. */
	bad_sha?: string;
	fetch_failures: number;
	/** At a skip: commits HEAD is behind the local origin/main (doctor warns on a long skip with work waiting). */
	behind?: number;
	/** A rollback live workers held back: no run in flight, so cp-health keeps watching the parent and viewer. */
	held?: boolean;
	updated_at?: string;
}

export const DRAIN_TIMEOUT_S = 600;
/** `skipped_busy` for this many × interval_min: mid-turn workers no longer skip, the drain decides (cp-ccm0). */
export const BUSY_FORCE_FACTOR = 4;
export const DRAIN_WAIT_MS = 660_000;
export const VERIFY_MS = 120_000;
/** Extra wait while the parent is alive but busy: PARENT_UNSETTLED or a doctor queued behind a live parent; never for an absent parent or an observed failure. */
export const VERIFY_SETTLE_MS = 300_000;
/** Longer than a queued send's 120 s settle and parentDiagnostic's 120 s timeout. */
export const DOCTOR_PROBE_MS = 150_000;
export const STATUS_PROBE_MS = 3_000;
const POLL_MS = 5_000;
const DETAIL_MAX = 300;

export const updateStateFile = (stateDir: string): string => join(stateDir, "update.json");

/** The record, undefined when absent; unreadable throws. */
export function readUpdateState(stateDir: string): UpdateState | undefined {
	const file = updateStateFile(stateDir);
	if (!existsSync(file)) return undefined;
	let value: UpdateState | null;
	try {
		value = JSON.parse(readFileSync(file, "utf8")) as UpdateState | null;
	} catch (error) {
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (value?.schema_version !== 1 || typeof value.phase !== "string") throw new Error(`${file} is not an update record`);
	return value;
}

/** `data/update.json`: absent is off; anything but `{enabled: boolean, interval_min?: N > 0}` is why it is invalid. */
export function readUpdateConfig(dataDir: string): { enabled: boolean; interval_min: number } | string {
	const file = join(dataDir, "update.json");
	if (!existsSync(file)) return { enabled: false, interval_min: 15 };
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { enabled?: unknown; interval_min?: unknown } | null;
		const interval = raw?.interval_min ?? 15;
		if (typeof raw?.enabled === "boolean" && typeof interval === "number" && interval > 0) return { enabled: raw.enabled, interval_min: interval };
		return `${file} must be {"enabled": true|false, "interval_min": N > 0}`;
	} catch (error) {
		return `${file} is not JSON: ${(error as Error).message}`;
	}
}

/** One post-restart look at the parent: doctor passed, reported an error, the parent is alive but busy, or it is down. */
export type ParentProbe = { ok: true } | { error: string } | { busy: string } | { down: string };
/** undefined: healthy; a string: why not; `{note}`: healthy, with what was deferred. */
export type VerifyResult = string | undefined | { note: string };

export interface VerifyPorts {
	/** One doctor probe answering within about `budgetMs` (+ a status read on timeout). */
	probeParent(budgetMs: number): Promise<ParentProbe>;
	viewerDown(): Promise<string | undefined>;
	now(): number;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

export interface UpdatePorts {
	run(command: string, args: readonly string[], cwd?: string): RunResult;
	/** One op on this home's current host (connect, request, disconnect); throws when none answers. */
	host(op: "drain" | "drainCancel" | "stop", ...args: unknown[]): Promise<unknown>;
	/** `state/drain.json`'s state; undefined when absent (unreadable throws). */
	drain(): DrainRecord["state"] | undefined;
	/** Jobs with any live worker or script pid (`liveWorkerJobs`): the rollback's no-host guard. */
	busy(): string[];
	/** Live script jobs, and live workers not idle (`restartActivity`): what a restart would cut mid-turn. */
	activity(): { working: string[]; scripts: string[] };
	/**
	 * Within `timeoutMs` (+ VERIFY_SETTLE_MS while the parent is alive but busy): undefined once a parent's `/doctor` is
	 * not an error and the viewer answers; `{note}` when a still-busy parent was accepted without doctor; else why not.
	 */
	verify(timeoutMs: number): Promise<VerifyResult>;
	/** cp-daemon's control socket: `hold` the viewer, `reload` the inner (parent supervisor and viewer), ask for a `health` run. */
	daemon: DaemonControl;
	now(): Date;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

export interface UpdateOptions {
	app: string;
	stateDir: string;
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	dryRun?: boolean;
}

class StepError extends Error {}
const short = (sha: string | undefined) => sha?.slice(0, 12) ?? "?";
const clip = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
};

/** One updater run: the recorded state, or undefined when it recorded nothing (schedule, sticky failure, dry run). */
export async function runUpdate(options: UpdateOptions, ports: UpdatePorts): Promise<UpdateState | undefined> {
	const dry = options.dryRun === true;
	const job = !dry && (options.env ?? process.env).CP_DAEMON_JOB !== "update" ? (existsSync(join(options.dataDir, "daemon.json")) ? "refused" : "legacy") : "daemon";
	if (job === "refused") throw new Error("refused: cp-update runs from cp-daemon (it serializes runs); by hand, use --dry-run");
	const at = isoTimestamp(ports.now());
	let prior: UpdateState = { schema_version: 1, phase: "idle", fetch_failures: 0 };
	let unreadable: string | undefined;
	try {
		prior = readUpdateState(options.stateDir) ?? prior;
	} catch (error) {
		unreadable = (error as Error).message;
	}
	let state = prior;
	const save = (patch: Partial<UpdateState>): void => {
		// An undefined patch value clears the field, in memory exactly as on disk.
		state = Object.fromEntries(Object.entries({ ...state, ...patch }).filter(([, value]) => value !== undefined)) as unknown as UpdateState;
		if (!dry) atomicWriteJson(updateStateFile(options.stateDir), state);
	};
	const finish = (result: UpdateResult, detail: string, patch: Partial<UpdateState> = {}): UpdateState => {
		save({ phase: "idle", last_run_at: at, last_result: result, since: prior.last_result === result && prior.since ? prior.since : at, detail: clip(detail), behind: undefined, held: undefined, ...patch });
		ports.log(`${result}: ${detail}${dry ? " (dry-run: nothing recorded)" : ""}`);
		// Never a push from here: the watchdog sends the one notice per distinct failure.
		if (!dry && (UPDATE_FAILURES.includes(result) || (result === "fetch_failed" && state.fetch_failures >= 3))) {
			ports.daemon.health().catch((error: Error) => ports.log(`cp-daemon health: ${error.message}`));
		}
		return state;
	};
	const git = (...args: string[]) => ports.run("git", args, options.app);
	const must = (...args: string[]): string => {
		const result = git(...args);
		if (result.status !== 0) throw new StepError(`git ${args.join(" ")} failed in ${options.app}: ${result.stderr.trim()}`);
		return result.stdout.trim();
	};
	const behind = (): number | undefined => {
		const result = git("rev-list", "--count", "HEAD..origin/main");
		return result.status === 0 ? Number(result.stdout.trim()) : undefined;
	};
	const npmCi = (): string | undefined => (ports.run("npm", ["ci"], options.app).status === 0 ? undefined : `npm ci failed in ${options.app}`);
	/** A new inner from the files on disk: the parent supervisor and the viewer restart; the hold is released. */
	const restartUnits = (): Promise<string | undefined> => ports.daemon.reload();
	const cancelDrain = async (): Promise<void> => {
		const answer = await ports.host("drainCancel").catch((error: Error) => ({ text: `drainCancel failed: ${error.message}` }));
		ports.log(`drain cancel: ${(answer as { text?: string } | null)?.text ?? "no answer"}`);
	};
	const stopFleet = async (): Promise<string | undefined> => {
		try {
			await ports.host("stop", {});
		} catch (error) {
			return `host stop failed: ${(error as Error).message}`;
		}
		return ports.daemon.hold();
	};
	/** Host `drain`, then ≤ 660 s for `drained`; still draining or timed out → `drainCancel`. Throws when no host drains. */
	const drainFleet = async (): Promise<"drained" | "timeout" | "gone"> => {
		await ports.host("drain", DRAIN_TIMEOUT_S);
		const deadline = ports.now().getTime() + DRAIN_WAIT_MS;
		for (let drain = ports.drain(); drain !== "drained"; drain = ports.drain()) {
			if (drain === undefined) return "gone";
			if (drain === "timeout" || ports.now().getTime() >= deadline) {
				await cancelDrain();
				return "timeout";
			}
			await ports.sleep(POLL_MS);
		}
		return "drained";
	};
	const failBeforeMerge = async (why: string, patch: Partial<UpdateState>): Promise<UpdateState> => {
		const restart = await restartUnits();
		return finish("failed", `${why}; nothing merged; ${restart ?? "cp-daemon reloaded (parent supervisor and viewer restarted)"}`, patch);
	};
	/**
	 * A restarted parent (verify, or a crash after the restart) reopened dispatch, so the fleet is drained again
	 * before it is stopped. With no host to drain nothing runs under it, unless `busy` says otherwise. Why the
	 * fleet cannot be stopped without killing a live worker, or undefined when it can.
	 */
	const holdFleet = async (): Promise<string | undefined> => {
		let outcome: string;
		try {
			outcome = await drainFleet();
		} catch (error) {
			const busy = ports.busy();
			return busy.length > 0 ? `no drain (${(error as Error).message}) and live worker(s) ${busy.join(", ")}` : undefined;
		}
		return outcome === "drained" ? undefined : outcome === "timeout" ? `the fleet did not drain within ${DRAIN_TIMEOUT_S}s (cancelled)` : "state/drain.json went away before it drained";
	};
	const rollback = async (from: string, to: string, lock: boolean, why: string): Promise<UpdateState> => {
		// No `bad_sha` here: only a verified rollback attributes the failure to `to`; rollback_failed keeps the prior one.
		const patch = { from, to };
		ports.log(`rolling back to ${short(from)}: ${why}`);
		// Not `held` while this run works: the watchdog stands down through the stop/restart window.
		save({ phase: "rolling_back", detail: clip(why), held: undefined });
		const held = await holdFleet();
		// Stays `rolling_back`: the next run (after 4× interval_min) drains and retries; no live worker is killed.
		if (held) return finish("rollback_failed", `${why}; ${held}; nothing stopped, ${short(to)} still runs; the rollback is retried`, { ...patch, phase: "rolling_back", held: true });
		const stop = await stopFleet();
		if (stop) ports.log(`rollback: ${stop}; continuing`);
		const reset = git("reset", "--quiet", "--keep", from);
		if (reset.status !== 0) return finish("rollback_failed", `${why}; git reset --keep ${short(from)} failed: ${reset.stderr.trim()}`, patch);
		const failed = (lock ? npmCi() : undefined) ?? (await restartUnits());
		const verified = failed ? undefined : await ports.verify(VERIFY_MS);
		const broken = failed ?? (typeof verified === "string" ? verified : undefined);
		if (broken) return finish("rollback_failed", `${why}; after the rollback: ${broken}`, patch);
		return finish("rolled_back", `${why}; back at ${short(from)}; ${short(to)} is never retried${typeof verified === "object" ? `; ${verified.note}` : ""}`, { ...patch, bad_sha: to });
	};

	// A legacy cp-update.service (no data/daemon.json): it never touches the checkout again; cp-install migrates.
	if (job === "legacy") return finish("migration_required", "this home still runs the legacy cp-* units; rerun cp-install to move it to cp-daemon (auto-update never reruns it)", { phase: prior.phase });
	if (unreadable) return finish("failed", `${unreadable}; a fresh record replaces it`);
	const config = readUpdateConfig(options.dataDir);
	const interval = (typeof config === "string" ? 15 : config.interval_min) * 60_000;
	const since = (last: string | undefined) => (last ? ports.now().getTime() - Date.parse(last) : Number.POSITIVE_INFINITY);
	if (prior.phase !== "idle") {
		if (dry) return void ports.log(`dry-run: a run was interrupted in phase ${prior.phase}; the next real run recovers it`);
		const { from, to, lock = true } = prior;
		if (!from || !to) return finish("failed", `a run was interrupted in phase ${prior.phase} with no from/to recorded`);
		if (prior.phase === "draining") {
			// Died before `updating`: nothing stopped. A drain that already reached `drained` latches dispatch until
			// the parent restarts (cancel refuses it), and drained means that restart kills nothing: do it.
			if (ports.drain() !== "drained") {
				await cancelDrain();
				return finish("failed", "a run was interrupted mid-drain; the drain was cancelled and nothing was stopped", { from, to });
			}
			// The restart runs even when the stop fails (a host already gone makes that restart spawn a fresh one); both errors are named.
			const errors = [await stopFleet(), await restartUnits()].filter((error): error is string => error !== undefined);
			return finish("failed", `a run was interrupted after the fleet drained; nothing merged; ${errors.length ? `${errors.join("; ")} (the drain may stay latched until the parent restarts: cp_parent stop + start)` : "the drained parent was restarted, dispatch reopens"}`, { from, to });
		}
		if (prior.phase === "updating" && git("rev-parse", "HEAD").stdout.trim() === from) return failBeforeMerge("a run was interrupted before the merge", { from, to });
		// A rollback that live workers held back waits like a drain timeout before it drains again.
		if (prior.phase === "rolling_back" && prior.last_result === "rollback_failed" && since(prior.last_run_at) < 4 * interval) return undefined;
		return rollback(from, to, lock, `a run left phase ${prior.phase}`);
	}
	if (prior.last_result === "rollback_failed") {
		ports.log(`rollback_failed stays until a human looks: check ${options.app}, then remove ${updateStateFile(options.stateDir)} to resume`);
		return undefined;
	}
	if (typeof config === "string") return finish("config_invalid", config);
	if (!config.enabled) return finish("skipped_disabled", "auto-update is off (data/update.json absent or enabled: false)");
	if (!dry && since(prior.last_run_at) < interval * (prior.last_result === "drain_timeout" ? 4 : 1)) return undefined;

	let from: string;
	let to: string;
	let lock: boolean;
	try {
		if (must("status", "--porcelain")) return finish("skipped_dirty", `${options.app} has local changes; nothing changed`, { behind: behind() });
		const branch = git("symbolic-ref", "--short", "-q", "HEAD").stdout.trim();
		if (branch !== "main") return finish("skipped_branch", `${options.app} is on ${branch || "a detached HEAD"}, not main`, { behind: behind() });
		const fetched = git("fetch", "--quiet", "origin", "main");
		if (fetched.status !== 0) return finish("fetch_failed", `git fetch origin main failed: ${fetched.stderr.trim()}`, { fetch_failures: prior.fetch_failures + 1 });
		state = { ...state, fetch_failures: 0 };
		const ahead = Number(must("rev-list", "--count", "origin/main..HEAD"));
		if (ahead > 0) return finish("skipped_ahead", `${options.app} has ${ahead} commit(s) not on origin/main`, { behind: behind() });
		from = must("rev-parse", "HEAD");
		to = must("rev-parse", "origin/main");
		if (from === to) return finish("up_to_date", `at ${short(to)}`, { from, to });
		if (to === prior.bad_sha) return finish("skipped_bad_sha", `origin/main ${short(to)} rolled back before; waiting for a newer commit`, { to, behind: behind() });
		const { working, scripts } = ports.activity();
		if (scripts.length > 0) return finish("skipped_busy", `live script job(s): ${scripts.join(", ")} (a drain never waits for a script); nothing drained`, { behind: behind() });
		const starved = prior.last_result === "skipped_busy" && prior.since !== undefined && since(prior.since) >= BUSY_FORCE_FACTOR * interval;
		if (working.length > 0 && !starved) return finish("skipped_busy", `mid-turn worker(s): ${working.join(", ")}; nothing drained (drained anyway after ${BUSY_FORCE_FACTOR}× interval_min busy)`, { behind: behind() });
		if (working.length > 0) ports.log(`busy since ${prior.since}: draining anyway; the drain waits for ${working.join(", ")} to settle`);
		lock = git("diff", "--quiet", from, to, "--", "package-lock.json").status !== 0;
	} catch (error) {
		return finish("failed", (error as Error).message);
	}
	if (dry) return void ports.log(`dry-run: would drain, then update ${short(from)} → ${short(to)}${lock ? " with npm ci" : ""}`);

	save({ phase: "draining", from, to, lock });
	try {
		const drained = await drainFleet();
		if (drained === "gone") return finish("failed", "state/drain.json went away before it drained (cancelled, or the parent restarted); nothing was stopped", { from, to });
		if (drained === "timeout") return finish("drain_timeout", `the fleet did not drain within ${DRAIN_TIMEOUT_S}s; the drain was cancelled and nothing was stopped`, { from, to });
	} catch (error) {
		await cancelDrain();
		return finish("failed", `drain failed: ${(error as Error).message}; nothing was stopped`, { from, to });
	}

	save({ phase: "updating" });
	const stop = await stopFleet();
	if (stop) return failBeforeMerge(stop, { from, to });
	const merged = git("merge", "--ff-only", "--quiet", to);
	if (merged.status !== 0) return failBeforeMerge(`git merge --ff-only ${short(to)} failed: ${merged.stderr.trim()}`, { from, to });
	const broken = (lock ? npmCi() : undefined) ?? (await restartUnits());
	if (broken) return rollback(from, to, lock, broken);
	save({ phase: "verifying" });
	const verified = await ports.verify(VERIFY_MS);
	if (typeof verified === "string") return rollback(from, to, lock, verified);
	return finish("updated", `${short(from)} → ${short(to)}${lock ? " (npm ci)" : ""}${verified ? `; ${verified.note}` : ""}`, { from, to, updated_at: at });
}

/** `promise` settled within `ms`: its value or its error; undefined on timeout. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<{ value: unknown } | { error: unknown } | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then((value) => ({ value }), (error: unknown) => ({ error })),
			new Promise<undefined>((done) => {
				timer = setTimeout(() => done(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One doctor probe, classified. An explicit rejection is busy only when it is exactly PARENT_UNSETTLED, never
 * otherwise; no answer within `budgetMs` (a doctor queued behind the host's serial queue) is busy only when the
 * host's non-queued `status` read confirms the same parent pid alive within `statusMs`.
 */
export async function probeDoctor(doctor: () => Promise<unknown>, status: () => Promise<unknown>, parentPid: number, budgetMs: number, statusMs = STATUS_PROBE_MS): Promise<ParentProbe> {
	const answer = await settleWithin(Promise.resolve().then(doctor), budgetMs);
	if (answer && "error" in answer) {
		const message = errorText(answer.error);
		return message === PARENT_UNSETTLED ? { busy: message } : { down: message };
	}
	if (answer) {
		const report = answer.value as { level?: unknown; text?: unknown } | null;
		return report?.level === "error" ? { error: String(report.text ?? "") } : { ok: true };
	}
	const read = await settleWithin(Promise.resolve().then(status), statusMs);
	const live = read && "value" in read ? (read.value as { alive?: unknown; pid?: unknown } | null) : undefined;
	if (live?.alive === true && live.pid === parentPid) return { busy: `doctor queued behind the host queue for ${budgetMs}ms; parent pid ${parentPid} alive` };
	const why = !read ? `did not answer within ${statusMs}ms` : "error" in read ? `failed: ${errorText(read.error)}` : live?.alive !== true ? "says no parent is alive" : `names pid ${String(live.pid)}, not ${parentPid}`;
	return { down: `doctor did not answer within ${budgetMs}ms and status ${why}` };
}

/**
 * Post-restart verify: ≤ `timeoutMs` for a parent whose doctor is not an error and a live viewer; only a busy parent
 * extends that by ≤ `settleMs`, after which it is accepted with a `doctor deferred` note. An absent parent, an
 * observed doctor failure or a down viewer is never extended and never accepted.
 */
export async function verifyRestart(ports: VerifyPorts, timeoutMs: number, settleMs = VERIFY_SETTLE_MS): Promise<VerifyResult> {
	const base = ports.now() + timeoutMs;
	const hard = base + settleMs;
	let parentOk = false;
	let lastBusy = false;
	let why = "no parent host answered";
	let viewerBad = false;
	const deadline = () => (!parentOk && lastBusy && !viewerBad ? hard : base);
	for (;;) {
		if (!parentOk) {
			const probe = await ports.probeParent(Math.min(DOCTOR_PROBE_MS, Math.max(1_000, deadline() - ports.now())));
			if ("error" in probe) return `the parent's /doctor reports an error: ${probe.error}`;
			if ("ok" in probe) parentOk = true;
			else {
				// A down after a busy falls back to the base deadline: the parent died or was replaced.
				lastBusy = "busy" in probe;
				why = "busy" in probe ? probe.busy : probe.down;
			}
		}
		// A busy parent is extended only while the viewer is probed healthy; a down viewer keeps the base deadline.
		viewerBad = false;
		if (parentOk || lastBusy) {
			const down = await ports.viewerDown();
			if (!down && parentOk) return undefined;
			if (down) {
				viewerBad = true;
				why = `viewer: ${down}`;
			}
		}
		if (ports.now() >= deadline()) {
			if (parentOk || !lastBusy || viewerBad) return `not healthy within ${Math.round(timeoutMs / 1000)}s: ${why}`;
			const note = `doctor deferred: parent busy ${Math.round((timeoutMs + settleMs) / 1000)}s`;
			ports.log(note);
			const down = await ports.viewerDown();
			return down ? `viewer: ${down}` : { note };
		}
		await ports.sleep(2_000);
	}
}

/** The production ports for `home` (multi mode, layout configured). */
export function hostUpdatePorts(home: string, env: NodeJS.ProcessEnv = process.env): UpdatePorts {
	const paths = parentHostPaths(home, "multi");
	const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
	return {
		run: (command, args, cwd) => {
			const result = spawnSync(command, [...args], { cwd, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
			return { status: result.status ?? 127, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
		},
		host: async (op, ...args) => {
			const { record } = currentHost(paths);
			if (!record || !isPidAlive(record.pid)) throw new Error("no parent host is running");
			const client = await ParentHostClient.connect(record, 5_000);
			try {
				return await client.request(op, ...args);
			} finally {
				client.disconnect();
			}
		},
		drain: () => readDrain(home)?.state,
		busy: () => liveWorkerJobs(new FleetStore({ home }).list()),
		activity: () => restartActivity(new FleetStore({ home }).list(), (jobId) => readStatusFile(home, jobId)?.phase),
		verify: (timeoutMs) =>
			verifyRestart(
				{
					// A thin socket adapter: every classification is probeDoctor's.
					probeParent: async (budgetMs) => {
						const { record } = currentHost(paths);
						if (!record) return { down: "no parent host answered" };
						let client: ParentHostClient;
						try {
							client = await ParentHostClient.connect(record, 3_000);
						} catch (error) {
							return { down: (error as Error).message };
						}
						try {
							const parentPid = client.parentPid;
							if (parentPid === undefined) return { down: `host pid ${client.hostPid} runs no parent yet` };
							return await probeDoctor(() => client.request("doctor"), () => client.request("status"), parentPid, budgetMs);
						} finally {
							client.disconnect();
						}
					},
					viewerDown: () => viewerDown(home, env),
					now: Date.now,
					sleep,
					log: (line) => console.error(`update: ${line}`),
				},
				timeoutMs,
			),
		daemon: daemonControl(home, (line) => console.error(`update: ${line}`)),
		now: () => new Date(),
		sleep,
		log: (line) => console.error(`update: ${line}`),
	};
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { "dry-run": { type: "boolean" } } });
	const home = resolveHome();
	configureLayout("multi", home);
	const layout = layoutForHome("multi", home);
	runUpdate({ app: PACKAGE_ROOT, stateDir: join(home, layout.state), dataDir: join(home, layout.data), dryRun: values["dry-run"] === true }, hostUpdatePorts(home)).then(
		() => process.exit(0),
		(error: Error) => {
			console.error(`update: failed: ${error.stack ?? error.message}`);
			process.exit(1);
		},
	);
}
