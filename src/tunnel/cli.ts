/**
 * `cp-tunnel` (remote dashboard PR 2d): the remote dashboard's switch. Nothing is exposed until `up` runs.
 *
 *   up [--quick | --hostname HOST --token-file FILE] [--remote-port N] [--level full|view] [--push-origin accept|keep]
 *   pair [--level full|view]   devices   revoke <name-or-id>   status   down          (all take --home DIR, else CP_HOME)
 *
 * `up` writes `data/tunnel.json` (a new revision, under `data/tunnel.lock`); cp-daemon's controller runs cloudflared
 * (`daemon-tunnel.ts`) and the viewer opens the remote listener (`remote-runtime.ts`). Success is printed only when the
 * controller runs that revision with an origin and the viewer's owner-socket ack names the same revision, origin and
 * generation. Bare `up` reuses the saved mode, else quick. cloudflared is a compatible one on PATH, else the pinned,
 * checksum-verified release under `<home>/bin` (`provisionCloudflared`). A named token is copied to the 0600
 * `data/tunnel/token` and travels only as that path. No sudo, no system unit, no kill: cp-daemon owns the process.
 *
 * Push (named only): pointing Web Push at the tunnel origin needs consent — `--push-origin accept`, or "y" at the
 * terminal prompt; anything else keeps the existing config bytes. `initPush` keeps the VAPID keys. Quick never touches push.
 *
 * Secrets: stdout carries the plain origin and lists, never a pairing link. The link and its QR go to the controlling
 * terminal only (`showPairingOnTty`); without one, pairing is refused before any code is issued.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { initPush } from "../push/keys.ts";
import { atomicWrite, daemonPaths, pidAlive, readDaemonConfig, readDaemonState } from "../service/daemon-files.ts";
import { HOSTNAME_RE, readTunnelConfig, readTunnelRuntime, type TunnelConfig, type TunnelMode, tunnelConfigFile } from "../service/daemon-tunnel-files.ts";
import { askTty } from "../service/install.ts";
import { type DeviceControlReply, deviceControlRequest } from "../viewer/device-control.ts";
import { readPushConfig } from "../viewer/push-files.ts";
import { cloudflaredBinDir, defaultProvisionPorts, type Provisioned, provisionCloudflared } from "./cloudflared.ts";
import { type ShowResult, showPairingOnTty } from "./qr.ts";

export const DEFAULT_REMOTE_PORT = 8767;
/** Quick registration plus the daemon's 5 s tick and the viewer's 2 s check. */
export const UP_WAIT_MS = 120_000;
/** SIGTERM, the 10 s grace, SIGKILL and its bounded 10 s exit wait, plus a tick. */
export const DOWN_WAIT_MS = 45_000;
export const POLL_MS = 500;
const TOKEN_MAX_BYTES = 4096;
const USAGE = "usage: cp-tunnel up [--quick | --hostname HOST --token-file FILE] [--remote-port N] [--level full|view] [--push-origin accept|keep] | pair [--level full|view] | devices | revoke <name-or-id> | status | down   [--home DIR]";

export interface TunnelCliPorts {
	env: NodeJS.ProcessEnv;
	out(line: string): void;
	err(line: string): void;
	now(): number;
	sleep(ms: number): Promise<void>;
	provision(binDir: string): Promise<Provisioned>;
	control(stateDir: string, op: string, args?: Record<string, unknown>): Promise<DeviceControlReply>;
	daemonRunning(home: string): boolean;
	/** `cp-daemon start`: its exit code. */
	startDaemon(home: string): number;
	/** The controlling terminal as a pairing display, or why there is none (checked before a code is issued). */
	tty(): ((link: string) => ShowResult) | string;
	/** One line typed at the terminal, or undefined when there is none. */
	ask(question: string): string | undefined;
}

type Args = { verb: string; target?: string; home?: string; quick: boolean; hostname?: string; tokenFile?: string; port?: string; level?: string; push?: string };

function parse(argv: string[]): Args | string {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: { home: { type: "string" }, quick: { type: "boolean" }, hostname: { type: "string" }, "token-file": { type: "string" }, "remote-port": { type: "string" }, level: { type: "string" }, "push-origin": { type: "string" } },
		});
		const [verb = "", target, ...rest] = positionals;
		if (rest.length > 0 || (target !== undefined && verb !== "revoke") || (verb === "revoke" && target === undefined)) return "wrong arguments";
		if (values.level !== undefined && values.level !== "full" && values.level !== "view") return "--level must be full or view";
		if (values["push-origin"] !== undefined && values["push-origin"] !== "accept" && values["push-origin"] !== "keep") return "--push-origin must be accept or keep";
		const upOnly = values.quick || values.hostname !== undefined || values["token-file"] !== undefined || values["remote-port"] !== undefined || values["push-origin"] !== undefined;
		if (upOnly && verb !== "up") return "--quick, --hostname, --token-file, --remote-port and --push-origin belong to up";
		if (values.level !== undefined && verb !== "up" && verb !== "pair") return "--level belongs to up and pair";
		return { verb, ...(target !== undefined ? { target } : {}), home: values.home, quick: values.quick === true, hostname: values.hostname, tokenFile: values["token-file"], port: values["remote-port"], level: values.level, push: values["push-origin"] };
	} catch (error) {
		return (error as Error).message;
	}
}

export async function cli(argv: string[], ports: TunnelCliPorts): Promise<number> {
	const args = parse(argv);
	if (typeof args === "string" || !["up", "pair", "devices", "revoke", "status", "down"].includes(args.verb)) {
		ports.err(`${typeof args === "string" ? `cp-tunnel: ${args}\n` : ""}${USAGE}`);
		return 2;
	}
	const homeArg = args.home ?? ports.env.CP_HOME;
	if (!homeArg) {
		ports.err("cp-tunnel: no home: pass --home DIR or set CP_HOME");
		return 2;
	}
	const home = resolve(homeArg);
	const paths = daemonPaths(home);
	const fail = (why: string): number => {
		ports.err(`cp-tunnel ${args.verb}: ${why}`);
		return 1;
	};
	const control = (op: string, body: Record<string, unknown> = {}) => ports.control(paths.stateDir, op, body);

	/** Show one pairing link on the terminal; the terminal is checked before the code exists. */
	const pair = async (level: string, route: "cli-up" | "cli-pair"): Promise<number> => {
		const display = ports.tty();
		if (typeof display === "string") return fail(`pairing display refused: ${display}; run cp-tunnel pair from an interactive terminal`);
		const reply = await control("pair", { level, route });
		if (!reply.ok) return fail(reply.error);
		const issued = reply.result as { link: string; level: string; expires_at: string };
		const shown = display(issued.link);
		if (!shown.ok) return fail(shown.reason);
		ports.err(`cp-tunnel: one ${issued.level === "view" ? "View-only" : "Full-control"} pairing link is on the terminal, valid until ${issued.expires_at}. A Full-control device is trusted like your terminal; use --level view for a less-trusted one.`);
		return 0;
	};

	switch (args.verb) {
		case "pair":
			return pair(args.level ?? "full", "cli-pair");
		case "devices": {
			const reply = await control("list");
			if (!reply.ok) return fail(reply.error);
			const { devices, pending_codes } = reply.result as { devices: Array<{ id: string; name: string; level: string; created_at: string; last_seen_at: string; revoked_at: string | null }>; pending_codes: number };
			if (devices.length === 0) ports.out("no paired devices");
			for (const device of devices) ports.out([device.id, JSON.stringify(device.name), device.level, `created ${device.created_at}`, `last seen ${device.last_seen_at}`, device.revoked_at ? `revoked ${device.revoked_at}` : "active"].join("  "));
			ports.out(`${pending_codes} unclaimed pairing code(s)`);
			return 0;
		}
		case "revoke": {
			const reply = await control("revoke", { target: args.target });
			if (!reply.ok) return fail(reply.error);
			const revoked = reply.result as { id: string; name: string; revoked_at: string; audit_error: string | null; cleanup_error: string | null };
			ports.out(`revoked ${revoked.id} ${JSON.stringify(revoked.name)} at ${revoked.revoked_at}`);
			for (const problem of [revoked.audit_error, revoked.cleanup_error]) if (problem) ports.err(`cp-tunnel revoke: the device is revoked, but: ${problem}`);
			return 0;
		}
		case "status":
			return status(paths.dataDir, paths.stateDir, control, ports);
		case "down":
			return down(home, paths, control, ports, fail);
		default:
			return up(home, args, paths, control, ports, fail, pair);
	}
}

type Paths = ReturnType<typeof daemonPaths>;
type Control = (op: string, body?: Record<string, unknown>) => Promise<DeviceControlReply>;
type Ack = { running: boolean; origin: string | null; generation: number | null; revision: number | null };

/** Serialize config changes: one cp-tunnel writes `data/tunnel.json` at a time. */
function withConfigLock(dataDir: string, change: (current: TunnelConfig | null) => TunnelConfig | string): TunnelConfig | string {
	const lock = join(dataDir, "tunnel.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return `cannot lock ${lock}: ${(error as Error).message}`;
		const holder = Number.parseInt((() => { try { return readFileSync(lock, "utf8"); } catch { return ""; } })(), 10);
		return pidAlive(holder) ? `cp-tunnel pid ${holder} is changing the tunnel; retry when it is done` : `${lock} is held by no running cp-tunnel: if none is running, remove it and retry`;
	}
	try {
		writeSync(fd, `${process.pid}\n`);
		const read = readTunnelConfig(dataDir);
		if (!read.ok) return `the saved config is unreadable (${read.reason}); fix or remove it`;
		const next = change(read.config);
		if (typeof next !== "string") atomicWrite(tunnelConfigFile(dataDir), next, 0o600);
		return next;
	} finally {
		closeSync(fd);
		rmSync(lock, { force: true });
	}
}

/** The named token into the 0600 `<dir>/token` (dir 0700); a failure is the reason, nothing half-written stays. */
function storeToken(dir: string, token: string): string | undefined {
	const file = join(dir, "token");
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
		renameSync(tmp, file);
		return undefined;
	} catch (error) {
		rmSync(tmp, { force: true });
		return `cannot store the token in ${dir}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
	}
}

/** Poll until `check` answers a value or the deadline passes; the last reason is the failure. */
async function until<T>(ports: TunnelCliPorts, ms: number, check: () => Promise<T | string>): Promise<T | string> {
	let last: T | string = "not checked";
	for (const deadline = ports.now() + ms; ; await ports.sleep(POLL_MS)) {
		last = await check();
		if (typeof last !== "string" || ports.now() >= deadline) return last;
	}
}

async function up(home: string, args: Args, paths: Paths, control: Control, ports: TunnelCliPorts, fail: (why: string) => number, pair: (level: string, route: "cli-up") => Promise<number>): Promise<number> {
	let daemon;
	try {
		daemon = readDaemonConfig(paths.config);
	} catch (error) {
		return fail((error as Error).message);
	}
	if (!daemon) return fail(`cp-daemon runs the tunnel, and this home has none (${paths.config} is absent): run cp-install first`);
	const saved = readTunnelConfig(paths.dataDir);
	if (!saved.ok) return fail(`the saved config is unreadable (${saved.reason}); fix or remove it`);
	const before = saved.config;
	if (args.quick && (args.hostname !== undefined || args.tokenFile !== undefined)) return fail("--quick takes no --hostname or --token-file");
	const mode: TunnelMode = args.quick ? "quick" : args.hostname !== undefined || args.tokenFile !== undefined ? "named" : (before?.mode ?? "quick");
	if (mode === "quick" && args.push === "accept") return fail("a quick tunnel's hostname changes on every start, so push is never pointed at it; use a named tunnel");
	const hostname = mode === "named" ? (args.hostname ?? before?.hostname)?.toLowerCase() : undefined;
	if (mode === "named" && (!hostname || !HOSTNAME_RE.test(hostname))) return fail(`a named tunnel needs --hostname HOST, a DNS name such as cp.example.com${hostname ? ` (not ${JSON.stringify(hostname)})` : ""}`);
	const port = args.port !== undefined ? Number(args.port) : (before?.port ?? DEFAULT_REMOTE_PORT);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail(`--remote-port must be 1024-65535, not ${args.port}`);
	if (port === daemon.port) return fail(`--remote-port ${port} is the local dashboard's port; pick another`);

	let tokenFile = mode === "named" ? before?.token_file : undefined;
	let token: string | undefined;
	if (mode === "named" && args.tokenFile !== undefined) {
		try {
			token = readFileSync(resolve(args.tokenFile), "utf8").trim();
		} catch (error) {
			return fail(`cannot read --token-file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
		}
		if (token.length === 0 || Buffer.byteLength(token) > TOKEN_MAX_BYTES || /\s/.test(token)) return fail(`--token-file must hold one tunnel token (no spaces, at most ${TOKEN_MAX_BYTES} bytes)`);
		tokenFile = join(paths.dataDir, "tunnel", "token");
	}
	if (mode === "named" && (!tokenFile || (token === undefined && !existsSync(tokenFile)))) return fail("a named tunnel needs --token-file FILE (the token Cloudflare shows for the tunnel)");

	const binary = await ports.provision(cloudflaredBinDir(home));
	if (!binary.ok) return fail(`no usable cloudflared: ${binary.reason}`);
	ports.err(`cp-tunnel: cloudflared ${binary.version} (${binary.source}: ${binary.path})`);
	// The token is stored under the config lock, after provisioning: a failed or racing up never leaves token and config disagreeing.
	const written = withConfigLock(paths.dataDir, (current) => {
		if (token !== undefined) {
			const stored = storeToken(join(paths.dataDir, "tunnel"), token);
			if (stored) return stored;
		}
		return { schema_version: 1, enabled: true, mode, port, binary: binary.path, ...(mode === "named" ? { hostname, token_file: tokenFile } : {}), revision: (current?.revision ?? 0) + 1 } as TunnelConfig;
	});
	if (typeof written === "string") return fail(written);

	if (!ports.daemonRunning(home)) {
		ports.err("cp-tunnel: cp-daemon is not running; starting it");
		if (ports.startDaemon(home) !== 0) return fail(`cp-daemon did not start; the tunnel is enabled and starts with it (cp-daemon start --home ${home}), or run cp-tunnel down`);
	}
	const ready = await until(ports, UP_WAIT_MS, async () => {
		const read = readTunnelRuntime(paths.stateDir);
		if (!read.ok) return `the runtime record is unreadable: ${read.reason}`;
		const live = read.runtime;
		if (!live || live.revision !== written.revision) return "cp-daemon has not applied this config yet";
		if (live.state !== "running" || !live.origin) return `cloudflared is ${live.state}${live.detail ? `: ${live.detail}` : ""}`;
		const ack = await control("status");
		if (!ack.ok) return `the viewer is not answering: ${ack.error}`;
		const seen = ack.result as Ack;
		if (!seen.running || seen.origin !== live.origin || seen.generation !== live.generation || seen.revision !== written.revision) return "the viewer has not opened the remote listener for this origin yet";
		return { origin: live.origin, generation: live.generation };
	});
	if (typeof ready === "string") return fail(`not ready within ${UP_WAIT_MS / 1000}s: ${ready}. The tunnel stays enabled and cp-daemon keeps trying (cp-daemon log, cp-tunnel status); cp-tunnel down turns it off`);
	ports.out(ready.origin);
	ports.err(
		mode === "quick"
			? `cp-tunnel: quick tunnel up (generation ${ready.generation}). Its hostname changes whenever cloudflared restarts (up, a daemon restart or reload, a crash), and every device paired on the old hostname must pair again. Quick tunnels have no uptime guarantee; the dashboard polls instead of streaming. For a stable hostname: cp-tunnel up --hostname HOST --token-file FILE`
			: `cp-tunnel: named tunnel up on ${ready.origin}`,
	);
	if (mode === "named") pushConsent(paths.dataDir, ready.origin, args.push, ports);
	return pair(args.level ?? "full", "cli-up");
}

/** Named only: Web Push follows the tunnel origin only with consent; keep leaves the config bytes as they are. */
function pushConsent(dataDir: string, origin: string, flag: string | undefined, ports: TunnelCliPorts): void {
	const existing = readPushConfig(dataDir);
	if (existing?.origin === origin) return ports.err(`cp-tunnel: push already uses ${origin}`);
	const question = existing ? `Push notifications use ${existing.origin}. Switch them to ${origin}? The keys stay; browsers subscribed on the old origin must subscribe again. [y/N] ` : `Set up push notifications for ${origin}? [y/N] `;
	const consent = flag ?? (ports.ask(question)?.trim().toLowerCase().startsWith("y") ? "accept" : "keep");
	if (consent !== "accept") return ports.err(`cp-tunnel: push kept ${existing ? `on ${existing.origin}` : "unset"}; cp-tunnel up --push-origin accept points it at ${origin}`);
	try {
		const result = initPush({ dataDir, origin, ...(existing ? { subject: existing.subject } : {}) });
		ports.err(`cp-tunnel: push now uses ${result.origin} (${result.created ? "new keys" : "keys kept"}). On iPhone and iPad, Add to Home Screen first, then enable notifications there.`);
	} catch (error) {
		ports.err(`cp-tunnel: push not changed: ${(error as Error).message}`);
	}
}

async function status(dataDir: string, stateDir: string, control: Control, ports: TunnelCliPorts): Promise<number> {
	const config = readTunnelConfig(dataDir);
	const runtime = readTunnelRuntime(stateDir);
	if (!config.ok) ports.out(`config: unreadable (${config.reason})`);
	else if (!config.config) ports.out("config: none (the remote dashboard is off; cp-tunnel up turns it on)");
	else ports.out(`config: ${config.config.enabled ? "enabled" : "disabled"}, ${config.config.mode}${config.config.hostname ? ` ${config.config.hostname}` : ""}, port ${config.config.port}, revision ${config.config.revision}`);
	if (!runtime.ok) ports.out(`cloudflared: runtime unreadable (${runtime.reason})`);
	else if (runtime.runtime) ports.out(`cloudflared: ${runtime.runtime.state}${runtime.runtime.pid ? ` pid ${runtime.runtime.pid}` : ""}, origin ${runtime.runtime.origin ?? "none"}, generation ${runtime.runtime.generation}, revision ${runtime.runtime.revision ?? "none"}${runtime.runtime.detail ? ` (${runtime.runtime.detail})` : ""}`);
	const ack = await control("status");
	if (!ack.ok) ports.out(`viewer: ${ack.error}`);
	else {
		const seen = ack.result as Ack;
		ports.out(seen.running ? `viewer: remote listener open for ${seen.origin} (generation ${seen.generation}, revision ${seen.revision})` : "viewer: remote listener closed");
	}
	return 0;
}

async function down(home: string, paths: Paths, control: Control, ports: TunnelCliPorts, fail: (why: string) => number): Promise<number> {
	const written = withConfigLock(paths.dataDir, (current) => (current ? { ...current, enabled: false, revision: current.revision + 1 } : "no tunnel is configured"));
	if (typeof written === "string") return fail(written);
	if (!ports.daemonRunning(home)) {
		ports.out(`tunnel disabled; cp-daemon is not running, so it stays off when it starts`);
		return 0;
	}
	const stopped = await until(ports, DOWN_WAIT_MS, async () => {
		const read = readTunnelRuntime(paths.stateDir);
		if (!read.ok) return `the runtime record is unreadable: ${read.reason}`;
		const live = read.runtime;
		if (live && (live.revision !== written.revision || live.state !== "stopped" || live.pid !== undefined)) return `cloudflared is still ${live.state}${live.pid ? ` (pid ${live.pid})` : ""}`;
		const ack = await control("status");
		if (ack.ok && (ack.result as Ack).running) return "the viewer's remote listener is still open";
		return true;
	});
	if (typeof stopped === "string") return fail(`not confirmed within ${DOWN_WAIT_MS / 1000}s: ${stopped} (cp-daemon log)`);
	ports.out("tunnel down: cloudflared exited and the remote listener is closed; the local dashboard is unchanged. Devices stay paired: cp-tunnel up resumes (a quick tunnel needs new pairings).");
	return 0;
}

if (import.meta.main) {
	const ports: TunnelCliPorts = {
		env: process.env,
		out: (line) => void process.stdout.write(`${line}\n`),
		err: (line) => void process.stderr.write(`${line}\n`),
		now: Date.now,
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		provision: (binDir) => provisionCloudflared(binDir, { ...defaultProvisionPorts(), log: (line) => void process.stderr.write(`cp-tunnel: ${line}\n`) }),
		control: (stateDir, op, body) => deviceControlRequest(stateDir, op, body),
		daemonRunning: (home) => {
			try {
				const state = readDaemonState(daemonPaths(home));
				return state?.state === "running" && pidAlive(state.pid);
			} catch {
				return false;
			}
		},
		// The existing start path (systemd or detached), its output on stderr so stdout stays the origin.
		startDaemon: (home) => spawnSync(process.execPath, [join(import.meta.dirname, "../service/daemon.ts"), "start", "--home", home], { stdio: ["ignore", 2, 2] }).status ?? 1,
		tty: () => {
			let fd: number;
			try {
				fd = openSync("/dev/tty", "w");
			} catch (error) {
				return `no controlling terminal (/dev/tty: ${(error as NodeJS.ErrnoException).code ?? "unknown"})`;
			}
			return (link) => showPairingOnTty(link, () => fd);
		},
		ask: askTty,
	};
	cli(process.argv.slice(2), ports).then(
		(code) => process.exit(code),
		(error: Error) => {
			process.stderr.write(`cp-tunnel: ${error.message}\n`);
			process.exit(1);
		},
	);
}
