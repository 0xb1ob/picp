/**
 * The parent supervisor cp-daemon runs (cp-daemon v1 P2, design A; `daemon-runtime.ts`): an attach-first
 * supervisor for this home's parent host. It never replaces the host's own
 * rules — `attachParentHost` joins a responsive host or claims the next
 * generation, a live foreign lock refuses, a live-but-silent host is never
 * replaced — it only decides when cp-daemon should try again:
 *
 *  - startup joins or spawns; a host running no parent gets `start` with
 *    `CP_PARENT_MODEL`, else `data/parent.json` `model` (dashboard Settings), else the saved
 *    `cp-parent-control.json` model, else the supervisor exits 78 (`RestartPreventExitStatus=78`: no crash loop).
 *    It never sends `modelExplicit`: the env pin is not an explicit choice, so `bridge.start` lets the
 *    `parent.json` model beat it (file beats env);
 *  - a live parent lock with no responsive host is retried every 60 s, logged once;
 *  - host lost: a blip reconnects, a newer generation is joined; while
 *    `state/drain.json` exists or the stop marker names the watched generation
 *    it waits without spawning; otherwise it exits 1 and cp-daemon restarts it
 *    with backoff (6 starts in 30 min make a crash loop `failed`);
 *  - SIGTERM disconnects and exits 0 (`KillMode=process`: host, parent and
 *    workers stay up). Stopping the fleet stays `cp_parent drain` + `stop`.
 *
 * No authority: the only host ops used are `hello` (attach) and `start`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configureLayout, LAYOUT } from "../contracts.ts";
import { drainFile } from "../drain.ts";
import { isPidAlive } from "../fleet.ts";
import { resolveHome } from "../home.ts";
import { attachParentHost, currentHost, type HostRecord, ParentHostClient, parentHostPaths, readStopMarker } from "../parent-host.ts";
import { parentModelSetting } from "../parent-context.ts";

export const EXIT_NO_MODEL = 78;
export const FOREIGN_LOCK_RETRY_MS = 60_000;
export const WAIT_POLL_MS = 10_000;

/** The slice of `ParentHostClient` the supervisor uses. */
export interface HostClient {
	hostPid: number;
	parentPid: number | undefined;
	closed: Promise<void>;
	request(op: string, ...args: unknown[]): Promise<unknown>;
	disconnect(): void;
}

export interface SupervisePorts {
	attach(): Promise<HostClient>;
	connect(record: HostRecord): Promise<HostClient>;
	current(): { gen: number; record?: HostRecord };
	/** The generation the last completed operator stop closed. */
	stoppedGen(): number | undefined;
	draining(): boolean;
	savedModel(): string | undefined;
	/** `data/parent.json` `model` (dashboard Settings). */
	configuredModel(): string | undefined;
	alive(pid: number): boolean;
	sleep(ms: number): Promise<void>;
	log(line: string): void;
}

export interface SuperviseOptions {
	home: string;
	/** `CP_PARENT_MODEL`; wins over the saved model. */
	model?: string;
	/** `CP_PARENT_PI_BIN`, passed through to `start` (tests). */
	piBin?: string;
}

/** Runs until the host is lost for good (1), no model is known (78), or startup fails (1). */
export async function supervise(options: SuperviseOptions, ports: SupervisePorts): Promise<number> {
	let client: HostClient | undefined;
	let foreignLogged = false;
	while (!client) {
		try {
			client = await ports.attach();
		} catch (error) {
			const message = (error as Error).message;
			if (!/already holds/.test(message)) {
				ports.log(`attach failed: ${message}`);
				return 1;
			}
			if (!foreignLogged) ports.log(`${message}; retrying every ${FOREIGN_LOCK_RETRY_MS / 1000}s`);
			foreignLogged = true;
			await ports.sleep(FOREIGN_LOCK_RETRY_MS);
		}
	}
	if (client.parentPid === undefined) {
		const configured = ports.configuredModel();
		const model = options.model?.trim() || configured || ports.savedModel();
		if (!model) {
			ports.log("no parent model (no CP_PARENT_MODEL, no data/parent.json model, no saved model): set one in dashboard Settings or with cp-install --parent-model (data/daemon.json), or start the parent once with cp_parent start; not restarting");
			client.disconnect();
			return EXIT_NO_MODEL;
		}
		const started = await client.request("start", { home: options.home, mode: "multi", model, ...(options.piBin ? { piBin: options.piBin } : {}) }) as { pid?: number; already?: boolean };
		// An already-running parent keeps whatever model it runs; only a fresh start names the model it was given.
		ports.log(`host pid ${client.hostPid}: ${started.already ? `parent already running pid ${started.pid ?? "?"}` : `started parent pid ${started.pid ?? "?"} (${configured ?? model})`}`);
	} else ports.log(`attached to host pid ${client.hostPid}, parent pid ${client.parentPid}`);
	let gen = ports.current().gen;
	for (;;) {
		await client.closed;
		ports.log(`lost host generation ${gen} (pid ${client.hostPid})`);
		const next = await reattach(gen, ports);
		if (!next) return 1;
		({ client, gen } = next);
	}
}

/** After a host loss: reconnect, join a newer generation, wait out a drain or stop, or give up (undefined). */
async function reattach(watched: number, ports: SupervisePorts): Promise<{ client: HostClient; gen: number } | undefined> {
	let waitingFor: string | undefined;
	for (;;) {
		const { gen, record } = ports.current();
		if (record && gen >= watched && ports.alive(record.pid)) {
			const client = await ports.connect(record).catch(() => undefined);
			if (client) {
				ports.log(gen > watched ? `attached to newer host generation ${gen} (pid ${client.hostPid})` : `reconnected to host generation ${gen}`);
				return { client, gen };
			}
		}
		const hold = ports.draining() ? "state/drain.json is present" : ports.stoppedGen() === watched ? `an operator stop closed generation ${watched}` : undefined;
		if (!hold) {
			ports.log(`host generation ${watched} is gone; exiting 1 so cp-daemon restarts the supervisor and it respawns the host`);
			return undefined;
		}
		if (waitingFor !== hold) ports.log(`${hold}: waiting without spawning (polling every ${WAIT_POLL_MS / 1000}s for a newer generation)`);
		waitingFor = hold;
		await ports.sleep(WAIT_POLL_MS);
	}
}

/** The production ports for `home` (multi mode, layout configured). */
export function hostPorts(home: string, overrides: Partial<SupervisePorts> = {}): SupervisePorts {
	configureLayout("multi", home);
	const paths = parentHostPaths(home, "multi");
	const controlFile = join(home, LAYOUT.sessions, "cp-parent-control.json");
	return {
		attach: () => attachParentHost({ home, mode: "multi" }),
		connect: (record) => ParentHostClient.connect(record),
		current: () => currentHost(paths),
		stoppedGen: () => readStopMarker(paths)?.gen,
		draining: () => existsSync(drainFile(home)),
		savedModel: () => {
			if (!existsSync(controlFile)) return undefined;
			let model: unknown;
			try {
				model = (JSON.parse(readFileSync(controlFile, "utf8")) as { model?: unknown }).model;
			} catch (error) {
				throw new Error(`parent control unreadable: ${controlFile}: ${(error as Error).message}`);
			}
			return typeof model === "string" && model.trim() ? model.trim() : undefined;
		},
		configuredModel: () => parentModelSetting(home),
		alive: isPidAlive,
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		log: (line) => console.error(`supervise: ${line}`),
		...overrides,
	};
}

if (import.meta.main) {
	const home = resolveHome();
	let active: HostClient | undefined;
	const track = (client: HostClient): HostClient => (active = client);
	const base = hostPorts(home);
	process.once("SIGTERM", () => {
		active?.disconnect();
		process.exit(0);
	});
	const ports: SupervisePorts = { ...base, attach: async () => track(await base.attach()), connect: async (record) => track(await base.connect(record)) };
	supervise({ home, ...(process.env.CP_PARENT_MODEL ? { model: process.env.CP_PARENT_MODEL } : {}), ...(process.env.CP_PARENT_PI_BIN ? { piBin: process.env.CP_PARENT_PI_BIN } : {}) }, ports).then(
		(code) => process.exit(code),
		(error: Error) => {
			console.error(`supervise: failed: ${error.stack ?? error.message}`);
			process.exit(1);
		},
	);
}
