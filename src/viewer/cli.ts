/**
 * `bin/cp-view` — start the read-only session viewer (cp-live-session-viewer).
 * `bin/cp-operator` runs it for the operator session's lifetime
 * (src/viewer/operator.ts); it also runs by hand in a terminal.
 *
 *   cp-view [--home DIR] [--host ADDR] [--port N] [--require-tailnet]
 *
 * Default host: CP_VIEWER_HOST, else the tailnet IPv4 (`tailscale ip -4`), else
 * 127.0.0.1 — or, with `--require-tailnet` (what `bin/cp-operator` and
 * cp-view.service pass), exit non-zero. A wildcard, public or non-IP host is always
 * refused (src/viewer/bind-host.ts), flag or not.
 * `--require-tailnet` is also the only way the operator's own full transcript is
 * served (`/api/sessions?view=you&transcript=1`, refused 403 without it).
 * Default port: 8766. Default home: CP_HOME, else this package's home.
 * Opt-in boards-only listener: CP_BOARDS_PORT, CP_BOARDS_HOST (default 127.0.0.1; a wildcard is allowed), and
 * CP_BOARDS_INDEX=1 for the `/boards/` list; a Settings save moves it live (boards-server.ts). A clash or listen error
 * never stops the dashboard.
 */

import type { ViewerApp } from "./app-page.ts";
import { boardsAddress, bindHostRefusal, tailscaleIp } from "./bind-host.ts";
import { boardsListener } from "./boards-server.ts";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeHome } from "../home.ts";
import { resolveStateDir } from "./sessions.ts";
import { remoteOnly, remoteRuntime } from "./remote-runtime.ts";
import { REMOTE_HOST } from "./remote-server.ts";
import { createViewer, hostHeaderFor, type ViewerOptions } from "./server.ts";
import { realpathSync as entryRealpath } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath as entryPath } from "node:url";

export const DEFAULT_PORT = 8766;

/**
 * The bind host when `--host` is absent: the tailnet IP, else 127.0.0.1 — or,
 * with `--require-tailnet`, a throw, so the process exits non-zero instead of
 * quietly serving on loopback.
 */
export function defaultHost(run: () => string | undefined = tailscaleIp, requireTailnet = false): string {
	const ip = run();
	if (ip) return ip;
	if (requireTailnet) throw new Error("cp-view: `tailscale ip -4` gave no address and --require-tailnet is set; exiting instead of serving on loopback (pin one: cp-install --viewer-host <ip>)");
	return "127.0.0.1";
}

export function viewerAddress(env: NodeJS.ProcessEnv = process.env, requireTailnet = false, run: () => string | undefined = tailscaleIp): { host: string; port: number } {
	const port = env.CP_VIEWER_PORT === undefined ? DEFAULT_PORT : Number(env.CP_VIEWER_PORT);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CP_VIEWER_PORT must be 1-65535, got ${env.CP_VIEWER_PORT}`);
	return { host: env.CP_VIEWER_HOST ?? defaultHost(run, requireTailnet), port };
}

/**
 * The viewer's address, `local: false` in remote-only mode: `--require-tailnet` found no tailnet address and cp-tunnel
 * enabled the remote dashboard. Otherwise the refusal stands — never a loopback fallback.
 */
export function listenPlan(home: string, env: NodeJS.ProcessEnv, requireTailnet: boolean, run: () => string | undefined = tailscaleIp): { host: string; port: number; local: boolean } {
	try {
		return { ...viewerAddress(env, requireTailnet, run), local: true };
	} catch (error) {
		if (!requireTailnet || !remoteOnly(resolveStateDir(home))) throw error;
		return { ...viewerAddress({ ...env, CP_VIEWER_HOST: REMOTE_HOST }), local: false }; // a bad CP_VIEWER_PORT still refuses
	}
}

/** Logs event-loop lag (`cp-view: loop-lag p50= p99= max=`, ms) to stderr every `CP_VIEW_LAG_LOG` ms; off unless set. */
export function startLagLog(env: NodeJS.ProcessEnv, err: (line: string) => void): void {
	const raw = env.CP_VIEW_LAG_LOG;
	if (raw === undefined || raw === "") return;
	const every = Number(raw);
	if (!Number.isInteger(every) || every < 1) {
		err(`cp-view: CP_VIEW_LAG_LOG must be a positive integer of milliseconds, got ${JSON.stringify(raw)}; no lag log\n`);
		return;
	}
	const delay = monitorEventLoopDelay({ resolution: 10 });
	delay.enable();
	const ms = (ns: number) => (ns / 1e6).toFixed(1);
	setInterval(() => {
		err(`cp-view: loop-lag p50=${ms(delay.percentile(50))} p99=${ms(delay.percentile(99))} max=${ms(delay.max)}\n`);
		delay.reset();
	}, every).unref();
}

export async function main(argv: readonly string[]): Promise<void> {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			home: { type: "string" },
			host: { type: "string" },
			port: { type: "string" },
			"require-tailnet": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		process.stdout.write("usage: cp-view [--home DIR] [--host ADDR] [--port N] [--require-tailnet]\n");
		return;
	}
	const home = resolve(values.home ?? describeHome().home);
	const requireTailnet = values["require-tailnet"] === true;
	const address = listenPlan(home, { ...process.env, ...(values.port !== undefined ? { CP_VIEWER_PORT: values.port } : {}) }, requireTailnet && values.host === undefined);
	const boards = boardsAddress(process.env);
	const { port } = address;
	const host = values.host ?? address.host;
	// Unflagged, the viewer still serves transcripts and explorer data to whoever reaches it: never a wildcard, public or non-IP bind.
	const refusal = bindHostRefusal(host);
	if (refusal) throw new Error(`cp-view: refusing to serve the viewer on ${host}: ${refusal}`);
	const stateDir = resolveStateDir(home);
	let app: ViewerApp | undefined;
	let appBuildError: string | undefined;
	try {
		const { buildViewer } = await import("./build.ts");
		app = await buildViewer({ stateDir });
		process.stdout.write(`cp-view: built ${app.bytes} bytes in ${app.duration_ms}ms\n`);
	} catch (error) {
		appBuildError = "Viewer build unavailable";
		process.stderr.write(`cp-view: startup build failed; / returns 503; health and APIs remain available: ${error instanceof Error ? error.message : "unknown build error"}\n`);
	}
	const out = (line: string) => process.stdout.write(line), err = (line: string) => process.stderr.write(line);
	startLagLog(process.env, err);
	const boardsCtl = boardsListener({ home, stateDir }, port, out, err);
	const built = { ...(app ? { app } : {}), ...(appBuildError ? { appBuildError } : {}) };
	const options = { home, stateDir, host, port, requireTailnet, boards: boardsCtl, ...built };
	const remote = remoteRuntime(options);
	if (boards) void boardsCtl.apply(boards);
	if (!address.local) {
		process.stdout.write(`cp-view: remote-only (no tailnet address; cp-tunnel enabled the remote dashboard): no local listener, state ${stateDir}\n`);
		remote.start();
		setInterval(() => undefined, 1 << 30); // the runtime's own timer is unref'd: this keeps the process serving
		return;
	}
	// The device routes (Devices: list, local-only Add, revoke; pairing notices) appear on the local listener only while
	// this viewer owns the device store; until then, and on a home without the remote feature, they answer 404 as before.
	const local: ViewerOptions = { ...options, get devices() { return remote.routes(); } };
	createViewer(local).listen(port, host, () => {
		process.stdout.write(`cp-view: http://${hostHeaderFor(host, port)}/ (read-only, state ${stateDir})\n`);
		// Remote dashboard: inert until cp-tunnel configures this home (remote-runtime.ts).
		remote.start();
	});
}

// Not import.meta.main: that is node 24.2+, and engines admits every 24.x (#375).
if (process.argv[1] !== undefined && (() => { try { return entryRealpath(process.argv[1]) === entryPath(import.meta.url); } catch { return false; } })()) await main(process.argv.slice(2));
