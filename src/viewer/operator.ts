/**
 * `bin/cp-operator` — the operator session. Runs pi with the bridge extension, pi's built-in MCP,
 * codemode and tool search, plus the installed pi-web-access (`operatorWeb`; fleet tools stay on the RPC parent) and, for that session's
 * lifetime, the read-only viewer as a child: `cp-view --require-tailnet --port
 * 8766` by default. `--host` and `--port` set both the viewer bind and the
 * address the parent uses for board links. The viewer this session started is stopped when the session exits,
 * and on SIGINT, SIGTERM and SIGHUP. A viewer already listening on the port is
 * reused only for the same home, never killed. A remote seat is ssh or tmux onto this session.
 * With `CP_OPERATOR_VIEWER=service` (the installed `cp-operator` wrapper) `cp-view.service`
 * serves the dashboard and no session viewer starts; `data/operator.json` `model` (dashboard Settings), else its
 * `CP_OPERATOR_MODEL`, becomes pi's `--model` (`operatorModelArgs`: never over an explicit model flag or a resumed session).
 * Restart session (cp-aqxl): pi gets `CP_OPERATOR_RELAUNCH_FILE`; when pi exits leaving a marker there that names its
 * own pid (the dashboard restart), pi is relaunched here with exactly `--session <file>`, at most 3 times per 10 min.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { resolveOperatorTarget } from "../../extensions/cp-bridge/index.ts";
import { layoutForHome } from "../contracts.ts";
import { operatorPiArgs } from "../cp-bridge.ts";
import { operatorModelSetting } from "../operator-compact.ts";
import { tryResolveWorkerPackages, type WorkerPackageResolution } from "../worker-packages.ts";
import { relaunchFileFor, superviseOperatorPi } from "../operator-relaunch.ts";
import { PACKAGE_ROOT } from "../home.ts";
import { viewerAddress } from "./cli.ts";
import { hostHeaderFor } from "./server.ts";

export const OPERATOR_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * pi's built-in MCP, codemode and tool search (cp-fl8b): `--no-extensions` turns built-ins off and
 * `-e builtin:<name>` loads one (pi docs/settings.md "Resources"). Codemode and tool search are what
 * reach MCP tools of the default `codemode` and the `deferred` exposure.
 */
export const OPERATOR_BUILTIN_EXTENSIONS: readonly string[] = ["builtin:mcp", "builtin:codemode", "builtin:tool-search"];

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

/**
 * `--model <m>` ahead of `piArgs`, unless they already pick a model or resume a session. `<m>` is the
 * `data/operator.json` `model` (dashboard Settings, `configured`), else the wrapper's `CP_OPERATOR_MODEL` pin.
 */
export function operatorModelArgs(piArgs: readonly string[], env: NodeJS.ProcessEnv = process.env, configured?: string): string[] {
	const model = configured ?? env.CP_OPERATOR_MODEL?.trim();
	if (!model || piArgs.some((arg) => MODEL_CHOOSING_FLAGS.includes(arg.split("=", 1)[0] as string))) return [...piArgs];
	return ["--model", model, ...piArgs];
}

/** `data/operator.json` `model` of `home`; unreadable is one stderr line and undefined (the env pin applies). */
export function configuredOperatorModel(home: string | undefined): string | undefined {
	if (!home) return undefined;
	const file = join(home, layoutForHome("multi", home).data, "operator.json");
	try { return operatorModelSetting(file); }
	catch (error) {
		process.stderr.write(`cp-operator: operator model setting unreadable (${file}: ${(error as Error).message}); falling back to CP_OPERATOR_MODEL\n`);
		return undefined;
	}
}

/** Run one operator session to its exit code, with the viewer's lifetime bound to it. */
export async function runOperator(argv: readonly string[], options: { piBin?: string; viewer?: ViewerOptions; relaunchFile?: string; relaunchLimit?: { count: number; windowMs: number } } = {}): Promise<number> {
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
	// Restart session: pi gets the marker path; a marker naming the exited child relaunches it here (src/operator-relaunch.ts).
	const relaunchFile = options.relaunchFile ?? defaultRelaunchFile();
	const model = configuredOperatorModel(options.viewer?.home ?? targetHome());
	let current: ChildProcess | undefined;
	let signalled = false;
	const onSignal = (signal: NodeJS.Signals) => {
		signalled = true;
		viewer.stop();
		if (current && current.exitCode === null && current.signalCode === null) current.kill(signal);
	};
	for (const signal of OPERATOR_SIGNALS) process.on(signal, onSignal);
	try {
		return await superviseOperatorPi({
			spawnPi: (args, env) => spawn(options.piBin ?? "pi", operatorPiArgs(PACKAGE_ROOT, operatorModelArgs(args, process.env, model), [...OPERATOR_BUILTIN_EXTENSIONS, ...web.extensions]), {
				stdio: "inherit",
				env: { ...process.env, ...env, CP_VIEWER_HOST: host, CP_VIEWER_PORT: String(port), CP_OPERATOR_WEB_STATUS: web.status ?? "" },
			}),
			firstArgs: piArgs,
			...(relaunchFile ? { relaunchFile } : {}),
			...(options.relaunchLimit ? { limit: options.relaunchLimit } : {}),
			onChild: (child) => { current = child; },
			stopped: () => signalled,
		});
	} finally {
		for (const signal of OPERATOR_SIGNALS) process.off(signal, onSignal);
		process.off("exit", stopViewer);
		viewer.stop();
	}
}

/** The selected home's `state/operator/relaunch.json`; no home resolves: undefined, pi runs once. */
function defaultRelaunchFile(): string | undefined {
	try {
		const target = resolveOperatorTarget();
		return relaunchFileFor(target.home, target.mode);
	} catch (error) {
		process.stderr.write(`cp-operator: Restart session unavailable (no home resolved: ${(error as Error).message})\n`);
		return undefined;
	}
}

/** The selected home, or undefined: no home resolved is already one stderr line from `defaultRelaunchFile`. */
function targetHome(): string | undefined {
	try { return resolveOperatorTarget().home; } catch { return undefined; }
}

if (import.meta.main) {
	runOperator(process.argv.slice(2)).then((code) => process.exit(code));
}
