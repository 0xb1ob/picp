/**
 * `bin/cp-operator` — the operator session. Runs pi with only the bridge
 * extension plus the installed pi-web-access (`operatorWeb`; fleet tools stay on the RPC parent) and, for that session's
 * lifetime, the read-only viewer as a child: `cp-view --require-tailnet --port
 * 8766` by default. `--host` and `--port` set both the viewer bind and the
 * address the parent uses for board links. The viewer this session started is stopped when the session exits,
 * and on SIGINT, SIGTERM and SIGHUP. A viewer already listening on the port is
 * reused only for the same home, never killed. A remote seat is ssh or tmux onto this session.
 * With `CP_OPERATOR_VIEWER=service` (the installed `cp-operator` wrapper) `cp-view.service`
 * serves the dashboard and no session viewer starts; its `CP_OPERATOR_MODEL` becomes pi's `--model`
 * (`operatorModelArgs`: never over an explicit model flag or a resumed session).
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { resolveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { operatorPiArgs } from "../cp-bridge.ts";
import { tryResolveWorkerPackages, type WorkerPackageResolution } from "../worker-packages.ts";
import { PACKAGE_ROOT } from "../home.ts";
import { viewerAddress } from "./cli.ts";
import { hostHeaderFor } from "./server.ts";

export const OPERATOR_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface ViewerOptions {
	home?: string;
	host?: string;
	port?: number;
	/** Test seam: the viewer argv. Default: this package's `cp-view` with the service flags. */
	command?: readonly string[];
}

export interface OperatorViewer {
	/** True when another viewer already held the port: this session neither started nor stops it. */
	reused: boolean;
	pid?: number;
	stop(): void;
}

/** Whether anything is listening on `port`, on any address (a bind on the wildcard collides with it). */
export function portInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
		probe.listen({ port, exclusive: true }, () => probe.close(() => resolve(false)));
	});
}

/**
 * The installed pi-web-access extension for the operator session (`CP_OPERATOR_WEB=0` opts out).
 * Missing, unusable or unresolvable is never fatal: no extension, plus a line the bridge shows.
 */
export async function operatorWeb(env: NodeJS.ProcessEnv = process.env, resolve: () => Promise<WorkerPackageResolution> = () => tryResolveWorkerPackages()): Promise<{ extensions: readonly string[]; status?: string }> {
	if (env.CP_OPERATOR_WEB === "0") return { extensions: [] };
	const found = await resolve();
	const extensions = found.packages["pi-web-access"]?.extensions ?? [];
	if (extensions.length > 0) return { extensions };
	return { extensions: [], status: `web search: unavailable (${found.withheld?.["pi-web-access"] ?? found.error ?? "pi-web-access is not installed"}); CP_OPERATOR_WEB=0 silences this` };
}

export async function startViewer(options: ViewerOptions = {}): Promise<OperatorViewer> {
	const port = options.port ?? viewerAddress().port;
	const home = resolve(options.home ?? resolveOperatorTarget().home);
	const explicitHost = options.host ?? process.env.CP_VIEWER_HOST;
	if (await portInUse(port)) {
		const host = explicitHost ?? viewerAddress(process.env, true).host;
		let identity: { viewer?: string; home?: string };
		try {
			const response = await fetch(`http://${hostHeaderFor(host, port)}/api/identity`, { signal: AbortSignal.timeout(2000), redirect: "error" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			identity = await response.json() as typeof identity;
			if (identity?.viewer !== "command-post" || typeof identity.home !== "string") throw new Error("not a viewer");
		} catch (error) {
			throw new Error(`cp-operator: cannot verify viewer on port ${port}: ${(error as Error).message}`);
		}
		if (identity.home !== home) throw new Error(`cp-operator: viewer on port ${port} belongs to another home; choose a different --port`);
		return { reused: true, stop() {} };
	}
	const [bin, ...args] = options.command ?? [process.execPath, join(PACKAGE_ROOT, "src/viewer/cli.ts"), "--require-tailnet", ...(explicitHost !== undefined ? ["--host", explicitHost] : []), "--port", String(port)];
	// Its own process group, so a terminal's Ctrl+C reaches the session, not the viewer; output would tear the TUI.
	const child = spawn(bin as string, [...args, "--home", home], { stdio: "ignore", detached: true });
	child.on("error", () => undefined);
	return {
		reused: false,
		...(child.pid !== undefined ? { pid: child.pid } : {}),
		stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		},
	};
}

/** Flags that pick the model, or resume a session (pi restores its recorded model): the installed model never overrides them. */
const MODEL_CHOOSING_FLAGS = ["--model", "--models", "--provider", "-c", "--continue", "-r", "--resume", "--session", "--session-id", "--fork"];

/** `--model $CP_OPERATOR_MODEL` (the wrapper's pin) ahead of `piArgs`, unless they already pick a model or resume a session. */
export function operatorModelArgs(piArgs: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
	const model = env.CP_OPERATOR_MODEL?.trim();
	if (!model || piArgs.some((arg) => MODEL_CHOOSING_FLAGS.includes(arg.split("=", 1)[0] as string))) return [...piArgs];
	return ["--model", model, ...piArgs];
}

/** Run one operator session to its exit code, with the viewer's lifetime bound to it. */
export async function runOperator(argv: readonly string[], options: { piBin?: string; viewer?: ViewerOptions } = {}): Promise<number> {
	const piArgs: string[] = [];
	const cli: { host?: string; port?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const key = arg.split("=", 1)[0];
		if (key === "--host" || key === "--port") {
			const value = arg.includes("=") ? arg.slice(key.length + 1) : argv[++i];
			if (!value) throw new Error(`${key} requires a value`);
			if (key === "--host") cli.host = value;
			else cli.port = value;
		} else piArgs.push(arg);
	}
	const web = await operatorWeb(); // before the viewer starts: nothing to clean up if it were to fail
	const address = viewerAddress({ ...process.env, ...(cli.host !== undefined ? { CP_VIEWER_HOST: cli.host } : {}), ...(cli.port !== undefined ? { CP_VIEWER_PORT: cli.port } : {}) }, options.viewer?.host === undefined);
	const host = options.viewer?.host ?? address.host;
	const port = options.viewer?.port ?? address.port;
	// cp-view.service serves this home's dashboard (the cp-operator wrapper sets it): no competing session viewer.
	const viewer: OperatorViewer = process.env.CP_OPERATOR_VIEWER === "service"
		? { reused: true, stop() {} }
		: await startViewer({ ...options.viewer, ...(options.viewer?.host !== undefined || cli.host !== undefined ? { host } : {}), port });
	const stopViewer = () => viewer.stop();
	process.on("exit", stopViewer);
	const pi = spawn(options.piBin ?? "pi", operatorPiArgs(PACKAGE_ROOT, operatorModelArgs(piArgs), web.extensions), {
		stdio: "inherit",
		env: { ...process.env, CP_VIEWER_HOST: host, CP_VIEWER_PORT: String(port), CP_OPERATOR_WEB_STATUS: web.status ?? "" },
	});
	const onSignal = (signal: NodeJS.Signals) => {
		viewer.stop();
		if (pi.exitCode === null && pi.signalCode === null) pi.kill(signal);
	};
	for (const signal of OPERATOR_SIGNALS) process.on(signal, onSignal);
	return new Promise((resolve) => {
		const done = (code: number) => {
			for (const signal of OPERATOR_SIGNALS) process.off(signal, onSignal);
			process.off("exit", stopViewer);
			viewer.stop();
			resolve(code);
		};
		pi.once("error", (error) => {
			process.stderr.write(`cp-operator: could not start pi: ${error.message}\n`);
			done(127);
		});
		pi.once("exit", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
	});
}

if (import.meta.main) {
	runOperator(process.argv.slice(2)).then((code) => process.exit(code));
}
