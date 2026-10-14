/**
 * Remote dashboard PR 2d: the viewer's half of the tunnel. Off by default: a home with neither `data/tunnel.json` nor
 * `data/devices.json` (`remoteFeatureConfigured`) gets nothing from here — no store, no socket, no listener, no file.
 *
 * Once the feature is configured, every 2 s `check()`:
 *  1. starts the device store (finishing any pairing a crash left half-committed, `recover()`) and the CLI's owner
 *     socket (device-control.ts). Only the process holding that socket opens the remote listener, so `data/devices.json`
 *     keeps one writer even if two viewers run;
 *  2. opens the remote listener (remote-server.ts, 127.0.0.1:<port>) only while `data/tunnel.json` is enabled and the
 *     cloudflared controller reports `running` for that very revision, port and mode with an origin (`wantedListener`);
 *     the quick listener tells the app to poll (no SSE through a Quick Tunnel);
 *  3. closes it — every connection, SSE included — when that stops holding or the port, mode, origin or generation
 *     changes (a new generation ends the old sessions); a revision-only change is acknowledged in place.
 *
 * The readiness ack is the owner socket's `status` (`listening`): cp-tunnel reports success only when the controller's
 * runtime and this ack agree on revision, origin and generation.
 */
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { readTunnelConfig, readTunnelRuntime, remoteFeatureConfigured, type TunnelConfigRead, type TunnelMode, type TunnelRuntimeRead } from "../service/daemon-tunnel-files.ts";
import { type DeviceControl, startDeviceControl } from "./device-control.ts";
import { DeviceStore } from "./device-store.ts";
import type { DeviceBinding, DeviceRoutes } from "./devices-api.ts";
import { createRemoteViewer, REMOTE_HOST } from "./remote-server.ts";
import type { ViewerOptions } from "./server.ts";

export const REMOTE_CHECK_MS = 2_000;

/** What the remote listener serves: the tunnel's binding for one config revision, on one port, in one mode. */
export type RemoteListening = DeviceBinding & { revision: number; port: number; mode: TunnelMode };

/** The listener wanted now: the config enabled and the controller running exactly that revision, port and mode. */
export function wantedListener(config: TunnelConfigRead, runtime: TunnelRuntimeRead): RemoteListening | null {
	if (!config.ok || !runtime.ok || !config.config?.enabled || !runtime.runtime) return null;
	const { revision, port, mode } = config.config;
	const live = runtime.runtime;
	if (live.state !== "running" || live.origin === null || live.revision !== revision || live.port !== port || live.mode !== mode) return null;
	return { origin: live.origin, generation: live.generation, revision, port, mode };
}

/**
 * No-tailnet remote-only mode: cp-tunnel enabled this home's remote dashboard (`data/tunnel.json` `enabled`). Only then
 * may a `--require-tailnet` viewer that found no tailnet address run without its local listener (cli.ts `listenPlan`).
 */
export function remoteOnly(stateDir: string): boolean {
	const read = readTunnelConfig(join(dirname(stateDir), "data"));
	return read.ok && read.config?.enabled === true;
}

export interface RemoteRuntimePorts {
	configured(): boolean;
	readConfig(): TunnelConfigRead;
	readRuntime(): TunnelRuntimeRead;
	startControl(routes: DeviceRoutes): Promise<DeviceControl | { state: "refused"; reason: string }>;
	log(line: string): void;
}

export interface RemoteRuntime {
	check(): Promise<void>;
	listening(): RemoteListening | null;
	/** The device routes while this viewer owns the device store (its socket started); else undefined. */
	routes(): DeviceRoutes | undefined;
	/** The interval, unref'd. */
	start(): void;
	stop(): void;
}

export function remoteRuntime(options: ViewerOptions, overrides: Partial<RemoteRuntimePorts> = {}): RemoteRuntime {
	const dataDir = join(dirname(options.stateDir), "data");
	const log = overrides.log ?? options.log ?? ((line: string) => void process.stderr.write(line));
	const ports: RemoteRuntimePorts = {
		configured: () => remoteFeatureConfigured(dataDir),
		readConfig: () => readTunnelConfig(dataDir),
		readRuntime: () => readTunnelRuntime(options.stateDir),
		startControl: (routes) => startDeviceControl(options.stateDir, routes, log),
		log,
		...overrides,
	};
	let control: DeviceControl | undefined;
	let routes: DeviceRoutes | undefined;
	let open: { server: Server; listening: RemoteListening } | undefined;
	let running: Promise<void> | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let said = "";
	// One line per change of situation, not one per 2 s tick.
	const note = (line: string): void => {
		if (line !== said) ports.log(`viewer: remote: ${(said = line)}\n`);
	};

	const close = (why: string): void => {
		if (!open) return;
		const { server, listening } = open;
		open = undefined;
		server.close();
		server.closeAllConnections(); // open SSE streams and keep-alive sockets end with the listener
		note(`closed 127.0.0.1:${listening.port} (${why})`);
	};

	const listen = (server: Server, port: number): Promise<string | undefined> =>
		new Promise((done) => {
			server.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
			server.listen(port, REMOTE_HOST, () => done(undefined));
		});

	const step = async (): Promise<void> => {
		if (!control) {
			if (!ports.configured()) return;
			routes ??= { store: new DeviceStore(dataDir, options.stateDir), binding: () => (open ? { origin: open.listening.origin, generation: open.listening.generation } : null), listening: () => open?.listening ?? null };
			const started = await ports.startControl(routes);
			if (started.state !== "listening") return note(`device control not started, so no remote listener: ${started.reason}`);
			control = started;
			// Only the owner writes the store: a pairing a crash left half-committed is finished after the socket is ours.
			const recovered = routes.store.recover();
			if (!recovered.ok) note(`device store recovery refused (${recovered.reason}); every device request fails closed until it is fixed`);
			else if (recovered.recovered.length > 0) note(`finished ${recovered.recovered.length} interrupted pairing(s)`);
		}
		const config = ports.readConfig();
		const want = wantedListener(config, ports.readRuntime());
		const same = open && want && want.port === open.listening.port && want.mode === open.listening.mode && want.origin === open.listening.origin && want.generation === open.listening.generation;
		if (open && !same) close(want ? `now ${want.origin} generation ${want.generation} on ${want.port}` : "the tunnel is not running this config");
		if (!want) return;
		if (open) {
			open.listening = want; // revision-only: acknowledged in place
			return;
		}
		// Its own copy: the local flag never stands in for a tunnel request (the remote gate's device context does).
		const hostname = config.ok && want.mode === "named" ? config.config?.hostname : undefined;
		const server = createRemoteViewer({ ...options, requireTailnet: false, ...(want.mode === "quick" ? { refreshTransport: "poll" as const } : {}) }, { port: want.port, devices: routes as DeviceRoutes, ...(hostname ? { hostname } : {}) });
		const failed = await listen(server, want.port);
		if (failed) return note(`cannot listen on 127.0.0.1:${want.port} (${failed}); retrying`);
		open = { server, listening: want };
		note(`listening on 127.0.0.1:${want.port} for ${want.origin} (generation ${want.generation}, revision ${want.revision})`);
	};

	const check = (): Promise<void> => {
		// Never two checks at once: a slow socket start or bind is awaited, not overlapped.
		running ??= step()
			.catch((error: Error) => note(`check failed: ${error.message}`))
			.finally(() => (running = undefined));
		return running;
	};

	return {
		check,
		listening: () => open?.listening ?? null,
		routes: () => (control ? routes : undefined),
		start() {
			void check();
			timer ??= setInterval(() => void check(), REMOTE_CHECK_MS);
			timer.unref();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
			close("the viewer is stopping");
			control?.stop();
			control = undefined;
		},
	};
}
