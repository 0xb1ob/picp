/**
 * Remote dashboard PR 2: the daemon's `device-notify` role — the pairing-alert sender (`./device-notifications.ts`)
 * as its own supervised Node child, so a new pairing reaches every paired device whether or not a parent or operator
 * agent is running. It runs no agent, holds no parent lock and writes only its own ledger and lease.
 *
 * One sender per home: `state/device-notify.lock` names the holder's pid, and a second process refuses while that
 * pid is alive and still this script. A sweep runs at start and then every `DEVICE_NOTIFY_INTERVAL_MS` after the
 * previous one finished, so sweeps never overlap and a restart resumes whatever the ledger left unsettled.
 */
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonPaths, EXIT_CONFIG, pidAlive, psArgs, sameProcess } from "../service/daemon-files.ts";
import { readTunnelBinding } from "../service/daemon-tunnel-files.ts";
import { DEVICE_NOTIFY_INTERVAL_MS, runDeviceNotifySweep } from "./device-notifications.ts";
import { entryRealpath } from "../entry-guard.ts";
import { fileURLToPath as entryPath } from "node:url";

/** The `ps` needle that tells this sender from a reused pid. */
export const DEVICE_NOTIFY_NEEDLE = "push/device-notify.ts";
export const deviceNotifyLeaseFile = (stateDir: string): string => join(stateDir, "device-notify.lock");

export type SenderLease = { ok: true; release(): void } | { ok: false; holder: number | null };

/**
 * Take the lease: an atomic link of a complete record, so a reader never sees a torn one. A record whose holder is
 * not `isSender` (dead, reused, unreadable) is stale and replaced once.
 * shortcut: two senders replacing the same stale lease at once can both win; the daemon starts one per home, so upgrade
 * to an flock only if a second launcher ever appears.
 */
export function acquireSenderLease(stateDir: string, pid: number, isSender: (pid: number) => boolean): SenderLease {
	const file = deviceNotifyLeaseFile(stateDir);
	const holder = (): number | null => {
		try {
			const value = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
			return Number.isSafeInteger(value) ? (value as number) : null;
		} catch {
			return null;
		}
	};
	const tmp = `${file}.${pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`, { mode: 0o600 });
	try {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				linkSync(tmp, file);
				return { ok: true, release: () => void (holder() === pid && rmSync(file, { force: true })) };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const current = holder();
			if (current !== null && current !== pid && isSender(current)) return { ok: false, holder: current };
			rmSync(file, { force: true });
		}
		return { ok: false, holder: holder() };
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Run `sweep` now, then `intervalMs` after each one settles; `stop` cancels the next and waits out the current one.
 * A sweep that throws is handed to `onError` and the loop goes on: a refusal (an unreadable runtime) is retried, not fatal.
 */
export function startDeviceNotifyLoop(sweep: () => Promise<unknown>, intervalMs = DEVICE_NOTIFY_INTERVAL_MS, onError: (error: unknown) => void = () => {}): { stop(): Promise<void> } {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let current: Promise<unknown> = Promise.resolve();
	const run = (): void => {
		if (stopped) return;
		current = sweep()
			.catch(onError)
			.finally(() => {
				if (!stopped) timer = setTimeout(run, intervalMs);
			});
	};
	run();
	return {
		stop: async () => {
			stopped = true;
			clearTimeout(timer);
			await current;
		},
	};
}

// Not import.meta.main: that is node 24.2+, and engines admits every 24.x (#375).
if (process.argv[1] !== undefined && entryRealpath(process.argv[1]) === entryPath(import.meta.url)) {
	let last = "";
	// The same failure every five seconds is one log line, not a full daemon log.
	const log = (line: string): void => {
		if (line === last) return;
		last = line;
		process.stderr.write(`${new Date().toISOString()} cp-daemon device-notify[${process.pid}]: ${line}\n`);
	};
	const home = process.env.CP_HOME;
	if (!home) {
		log(`CP_HOME is not set; exiting ${EXIT_CONFIG}`);
		process.exit(EXIT_CONFIG);
	}
	const paths = daemonPaths(home);
	const lease = acquireSenderLease(paths.stateDir, process.pid, (pid) => sameProcess(pid, DEVICE_NOTIFY_NEEDLE, { alive: pidAlive, argsOf: psArgs }));
	if (!lease.ok) {
		log(`another pairing-alert sender (pid ${lease.holder ?? "unknown"}) holds ${deviceNotifyLeaseFile(paths.stateDir)}; exiting`);
		process.exit(1);
	}
	const binding = () => {
		const read = readTunnelBinding(paths.stateDir);
		if (!read.ok) throw new Error(`the tunnel runtime is unreadable: ${read.reason}`); // fail closed: no push on a guess
		return read.binding;
	};
	const loop = startDeviceNotifyLoop(async () => {
		const report = await runDeviceNotifySweep({ stateDir: paths.stateDir, dataDir: paths.dataDir, log, binding });
		if (report.attempted > 0 || report.ended > 0) log(`swept: ${report.attempted} attempted, ${report.delivered} delivered, ${report.retrying} retrying, ${report.failed} failed, ${report.ended} ended, ${report.waiting} waiting`);
	}, DEVICE_NOTIFY_INTERVAL_MS, (error) => {
		// One bounded line of the error's own message: never a stack, payload, endpoint or response body.
		const message = error instanceof Error ? error.message : "non-Error thrown";
		log(`sweep failed, retrying next round: ${message.replace(/\s+/g, " ").slice(0, 200)}`);
	});
	const shutdown = (): void => {
		void loop.stop().then(() => {
			lease.release();
			process.exit(0);
		});
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
