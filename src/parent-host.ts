/**
 * Parent host — a detached local child that owns the CP parent (item 23).
 *
 * The operator process used to own the parent's stdio directly (`CpBridge` →
 * `WorkerProcess`), so an operator relaunch killed the parent and every worker
 * under it. The host is its own session (`detached`), runs the unchanged
 * `CpBridge` facade — parent `WorkerProcess`, durable `ParentDelivery`/outbox
 * and relay stream — and exposes it on an owner-only Unix socket below
 * `state/`:
 *
 *  - frames are newline-delimited JSON carrying `v: PARENT_HOST_PROTOCOL`;
 *  - every request carries the private per-host token from the 0600 record
 *    (`state/parent-host.<gen>.json`); a wrong token closes the connection;
 *  - every call that reaches the parent over RPC runs on one serialization
 *    queue, so concurrent clients never mutate concurrently.
 *
 * One host per home, by generation: the current host is the highest
 * `parent-host.<gen>.json`, and nobody ever deletes it. A stale host (pid and
 * lock pid both dead) is superseded, never unlinked: the next host claims
 * `<gen + 1>` with an exclusive `link`, so racing attaches start at most one
 * host (losers exit 3) and a slow attach acting on an old classification can
 * only claim a generation that is taken or already superseded (it sees a higher
 * record and exits 3). Each generation binds its own socket; a socket is
 * unlinked only once nothing answers on it. Attach is first: a responsive host
 * is always joined; a live parent lock with no matching responsive host
 * refuses; a live but silent host is never replaced. A host crash leaves a
 * stale record; the next attach relaunches the same session and the parent's
 * `session_start` reconcile runs as for any parent restart.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureLayout, layoutForHome, type Mode } from "./contracts.ts";
import { type BridgeRelay, CpBridge, CpBridgeError, type ParentStartOptions, type RelayListener } from "./cp-bridge.ts";
import { SINGLE_MODE_REMOVED } from "./mode.ts";
import { isPidAlive } from "./fleet.ts";
import { deliverableRelay } from "./relay-scope.ts";
import type { ParentSendDelegation } from "./parent-outbox.ts";
import { readParentLock } from "./parent-lock.ts";

export const PARENT_HOST_PROTOCOL = 1;
const HOST_SCRIPT = fileURLToPath(import.meta.url);
/** Relays kept while no client is subscribed; send outcomes are also durable in the outbox. */
const RELAY_BACKLOG = 200;
const MAX_FRAME_CHARS = 1_000_000;
/** Linux `sun_path` is 108 bytes including the NUL. */
const MAX_SOCKET_PATH = 107;

export interface HostRecord {
	version: number;
	pid: number;
	socket: string;
	token: string;
	started_at: string;
}

export interface HostPaths {
	dir: string;
	log: string;
	/** `parent-host.stopped.json`: the generation a completed `stop` closed (cp-daemon P2). */
	stopped: string;
	record(gen: number): string;
	socket(gen: number): string;
}

export function parentHostPaths(home: string, mode: Mode): HostPaths {
	const dir = join(resolve(home), layoutForHome(mode, home).state);
	return {
		dir,
		log: join(dir, "parent-host.log"),
		stopped: join(dir, "parent-host.stopped.json"),
		record: (gen) => join(dir, `parent-host.${gen}.json`),
		socket: (gen) => {
			const socket = join(dir, `parent-host.${gen}.sock`);
			if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) throw new CpBridgeError(`parent host socket path is too long for a Unix socket (${socket})`);
			return socket;
		},
	};
}

export interface StopMarker { gen: number; at: string }

/** The generation an operator stop closed, so a supervisor never respawns it; undefined when absent, a refusal naming the file when unreadable. */
export function readStopMarker(paths: HostPaths): StopMarker | undefined {
	let parsed: Partial<StopMarker>;
	try {
		parsed = JSON.parse(readFileSync(paths.stopped, "utf8")) as Partial<StopMarker>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new CpBridgeError(`parent host stop marker unreadable: ${paths.stopped}: ${(error as Error).message}`);
	}
	if (!Number.isInteger(parsed.gen) || typeof parsed.at !== "string") throw new CpBridgeError(`parent host stop marker unreadable: ${paths.stopped} is not {gen, at}`);
	return parsed as StopMarker;
}

/** Record generations present, highest first. */
function generations(dir: string): number[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return names.flatMap((name) => /^parent-host\.([1-9]\d*)\.json$/.exec(name)?.[1] ?? []).map(Number).sort((a, b) => b - a);
}

/** The current (highest) generation and its record; `gen: 0` when no host was ever claimed. */
export function currentHost(paths: HostPaths): { gen: number; record?: HostRecord } {
	const gen = generations(paths.dir)[0] ?? 0;
	const record = gen ? readHostRecord(paths.record(gen)) : undefined;
	return record ? { gen, record } : { gen };
}

/** Does anything accept a connection on `path`? A timeout counts as yes: never unlink on doubt. */
function socketAnswers(path: string): Promise<boolean> {
	return new Promise((done) => {
		const socket = createConnection(path);
		const finish = (answers: boolean) => {
			clearTimeout(timer);
			socket.destroy();
			done(answers);
		};
		const timer = setTimeout(() => finish(true), 2_000);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** Undefined when absent; a record this build cannot read refuses, naming the file. */
export function readHostRecord(file: string): HostRecord | undefined {
	let parsed: Partial<HostRecord>;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HostRecord>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new CpBridgeError(`parent host record unreadable: ${file}: ${(error as Error).message}; remove it if no host is running`);
	}
	if (!Number.isInteger(parsed.pid) || typeof parsed.socket !== "string" || typeof parsed.token !== "string") {
		throw new CpBridgeError(`parent host record unreadable: ${file} is not a record this build wrote; remove it if no host is running`);
	}
	return parsed as HostRecord;
}

function frame(socket: Socket, body: Record<string, unknown>, done?: () => void): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify({ v: PARENT_HOST_PROTOCOL, ...body })}\n`, done);
	else done?.();
}

/** A frame is a JSON object; anything else (`null`, an array, a scalar, not JSON) is undefined. */
function parseFrame(line: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Split a stream into lines; an oversized unterminated frame closes the connection. */
function onLines(socket: Socket, handle: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim()) handle(line);
		}
		if (buffer.length > MAX_FRAME_CHARS) socket.destroy(new Error("frame too large"));
	});
}

/**
 * The host process body for generation `gen`. Exits 3 when `gen` is already
 * claimed or a higher generation exists: this claim came from a stale reading.
 */
/** A mode read from argv or a client: only `multi` is left (cp-8knh); `single` gets the removal message. */
function multiMode(mode: string): Mode {
	if (mode !== "multi") throw new CpBridgeError(mode === "single" ? SINGLE_MODE_REMOVED : `mode must be multi, got ${mode}`);
	return "multi";
}

export async function runParentHost(home: string, modeArg: string, gen: number): Promise<void> {
	const mode = multiMode(modeArg);
	if (!Number.isInteger(gen) || gen < 1) throw new CpBridgeError(`host generation must be a positive integer, got ${gen}`);
	configureLayout(mode, home);
	const paths = parentHostPaths(home, mode);
	mkdirSync(paths.dir, { recursive: true });
	const token = randomBytes(32).toString("hex");
	const socketPath = paths.socket(gen);
	const record: HostRecord = { version: PARENT_HOST_PROTOCOL, pid: process.pid, socket: socketPath, token, started_at: new Date().toISOString() };
	const tmp = `${paths.record(gen)}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	let claimed = true;
	try {
		linkSync(tmp, paths.record(gen)); // exclusive and atomic: a complete record, or EEXIST
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		claimed = false;
	} finally {
		rmSync(tmp, { force: true });
	}
	if (!claimed) {
		console.error(`parent host ${process.pid}: generation ${gen} is already claimed; exiting`);
		process.exit(3);
	}
	const highest = generations(paths.dir)[0] ?? gen;
	if (highest > gen) {
		// A superseded generation (its record was cleaned): the current host is higher. Only our own record goes.
		rmSync(paths.record(gen), { force: true });
		console.error(`parent host ${process.pid}: generation ${highest} supersedes ${gen}; exiting`);
		process.exit(3);
	}
	// We are the current generation: superseded records and their sockets go, but only once nothing answers there.
	for (const lower of generations(paths.dir).filter((older) => older < gen)) {
		if (await socketAnswers(paths.socket(lower))) {
			console.error(`parent host ${process.pid}: something still answers on ${paths.socket(lower)}; left in place`);
			continue;
		}
		rmSync(paths.socket(lower), { force: true });
		rmSync(paths.record(lower), { force: true });
	}

	const bridge = new CpBridge();
	const connections = new Set<Socket>();
	const subscribers = new Set<Socket>();
	const backlog: BridgeRelay[] = [];
	bridge.onRelay((relay) => {
		if (subscribers.size === 0) {
			backlog.push(relay);
			if (backlog.length > RELAY_BACKLOG) backlog.shift();
		}
		for (const socket of subscribers) frame(socket, { relay });
	});
	let queue: Promise<unknown> = Promise.resolve();
	let stopping = false;
	const reads: Record<string, (args: unknown[]) => unknown> = {
		status: () => bridge.status(),
		sendReceipt: (args) => bridge.sendReceipt(String(args[0])) ?? null,
		confirmObserved: (args) => bridge.confirmObserved(String(args[0])),
		// Outside the queue: a drain waits minutes, and sends must still reach the parent meanwhile.
		drain: (args) => bridge.drain(typeof args[0] === "number" ? args[0] : undefined),
		drainCancel: () => bridge.drainCancel(),
	};
	const queued: Record<string, (args: unknown[]) => Promise<unknown>> = {
		observe: async (args) => bridge.observe(args[0]),
		start: (args) => bridge.start({ ...(args[0] as ParentStartOptions), home, mode }),
		send: (args) => bridge.send(String(args[0]), (args[1] ?? undefined) as number | undefined, (args[2] ?? {}) as ParentSendDelegation),
		statusWithContext: () => bridge.statusWithContext(),
		doctor: () => bridge.diagnostic("doctor"),
		version: () => bridge.diagnostic("version"),
		compact: (args) => bridge.compact(args[0] as string | undefined),
		rotate: () => bridge.rotate(),
		model: (args) => bridge.model(String(args[0])),
		stop: async (args) => {
			const options = args[0] ?? {};
			if (typeof options !== "object" || Array.isArray(options)) throw new CpBridgeError("stop options must be an object");
			const exit = await bridge.stop(options as { discardPending?: boolean });
			// Only a completed stop closes the host; a refused or failed one leaves it usable.
			// The marker lands first, so a supervisor watching this generation never respawns it.
			const marker = `${paths.stopped}.${process.pid}.tmp`;
			writeFileSync(marker, `${JSON.stringify({ gen, at: new Date().toISOString() })}\n`, { mode: 0o600 });
			renameSync(marker, paths.stopped);
			stopping = true;
			return exit ?? null;
		},
	};
	const shutdown = (): void => {
		server.close();
		for (const socket of connections) socket.destroy();
		// The record stays (its pid is now dead): the current generation is never deleted, only superseded.
		rmSync(socketPath, { force: true });
		process.exit(0);
	};
	const tokenOk = (given: unknown): boolean => {
		const a = Buffer.from(typeof given === "string" ? given : "");
		const b = Buffer.from(token);
		return a.length === b.length && timingSafeEqual(a, b);
	};
	const handle = async (socket: Socket, line: string): Promise<void> => {
		const message = parseFrame(line);
		if (!message) return frame(socket, { id: null, ok: false, error: "frame is not a JSON object" });
		const id = message.id ?? null;
		if (message.v !== PARENT_HOST_PROTOCOL) return frame(socket, { id, ok: false, error: `protocol v${String(message.v)} unsupported; host speaks v${PARENT_HOST_PROTOCOL}` });
		if (!tokenOk(message.token)) return frame(socket, { id, ok: false, error: "unauthenticated" }, () => socket.destroy());
		const op = String(message.op);
		const args = Array.isArray(message.args) ? message.args : [];
		const read = Object.hasOwn(reads, op) ? reads[op] : undefined;
		const call = Object.hasOwn(queued, op) ? queued[op] : undefined;
		try {
			let result: unknown;
			if (op === "hello") {
				const status = bridge.status();
				result = { pid: process.pid, protocol: PARENT_HOST_PROTOCOL, parent: status.alive ? status.pid : null };
			} else if (op === "subscribe") {
				subscribers.add(socket);
				for (const relay of backlog.splice(0)) {
					const current = deliverableRelay(home, relay);
					if (current) frame(socket, { relay: current });
				}
				result = true;
			} else if (read) {
				result = await read(args);
			} else if (call) {
				const run = queue.then(() => {
					if (stopping) throw new CpBridgeError("parent host is stopping");
					return call(args);
				});
				queue = run.catch(() => undefined);
				result = await run;
			} else {
				throw new CpBridgeError(`unknown parent host op ${op}`);
			}
			frame(socket, { id, ok: true, result }, op === "stop" ? shutdown : undefined);
		} catch (error) {
			frame(socket, { id, ok: false, error: (error as Error).message });
		}
	};
	const server = createServer((socket) => {
		connections.add(socket);
		socket.on("close", () => {
			connections.delete(socket);
			subscribers.delete(socket);
		});
		socket.on("error", () => socket.destroy()); // close follows and drops the subscriber
		onLines(socket, (line) => {
			// A failed request answers its own connection; it never reaches the process and its parent.
			handle(socket, line).catch((error: Error) => {
				console.error(`parent host ${process.pid}: request failed: ${error.stack ?? error.message}`);
				try { frame(socket, { id: null, ok: false, error: `parent host request failed: ${error.message}` }); } catch { socket.destroy(); }
			});
		});
	});
	const listen = () => new Promise<void>((done, fail) => {
		server.once("error", fail);
		const umask = process.umask(0o077); // owner-only from the bind, not after
		try {
			server.listen(socketPath, () => {
				server.off("error", fail);
				done();
			});
		} finally {
			process.umask(umask);
		}
	});
	try {
		await listen();
	} catch (error) {
		// Our generation's path, left by nobody we know: unlink it only once nothing answers on it.
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (await socketAnswers(socketPath))) throw error;
		rmSync(socketPath, { force: true });
		await listen();
	}
	chmodSync(socketPath, 0o600);
	console.error(`parent host ${process.pid}: generation ${gen} listening on ${socketPath}`);
}

/** One authenticated connection to a running host. Disconnecting never stops it. */
export class ParentHostClient {
	readonly #socket: Socket;
	readonly #token: string;
	readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	readonly #listeners = new Set<RelayListener>();
	#seq = 0;
	/** Resolves when the host closed this connection (or it was disconnected). */
	readonly closed: Promise<void>;
	hostPid = 0;
	/** The parent pid the host reported at attach; undefined when it runs none. */
	parentPid: number | undefined;

	private constructor(socket: Socket, token: string) {
		this.#socket = socket;
		this.#token = token;
		this.closed = new Promise((done) => {
			socket.on("close", () => {
				for (const pending of this.#pending.values()) pending.reject(new CpBridgeError("parent host connection closed"));
				this.#pending.clear();
				done();
			});
		});
		socket.on("error", () => socket.destroy()); // the close above rejects what was pending
		onLines(socket, (line) => this.#onFrame(line));
	}

	static async connect(record: HostRecord, timeoutMs = 2_000): Promise<ParentHostClient> {
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<never>((_, fail) => {
			timer = setTimeout(() => fail(new CpBridgeError(`parent host ${record.pid} did not answer on ${record.socket} within ${timeoutMs}ms`)), timeoutMs);
		});
		let socket: Socket | undefined;
		try {
			socket = await Promise.race([expired, new Promise<Socket>((done, fail) => {
				const s = createConnection(record.socket);
				s.once("connect", () => done(s));
				s.once("error", fail);
			})]);
			const client = new ParentHostClient(socket, record.token);
			const hello = (await Promise.race([expired, client.request("hello")])) as { pid: number; parent: number | null };
			client.hostPid = hello.pid;
			client.parentPid = hello.parent ?? undefined;
			return client;
		} catch (error) {
			socket?.destroy();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	#onFrame(line: string): void {
		const message = parseFrame(line) as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; relay?: BridgeRelay } | undefined;
		if (!message) {
			this.#socket.destroy(new Error("parent host sent a frame that is not a JSON object"));
			return;
		}
		if (message.relay) {
			for (const listener of this.#listeners) listener(message.relay);
			return;
		}
		const pending = typeof message.id === "number" ? this.#pending.get(message.id) : undefined;
		if (!pending) return;
		this.#pending.delete(message.id as number);
		if (message.ok === true) pending.resolve(message.result);
		else pending.reject(new CpBridgeError(String(message.error ?? "parent host request failed")));
	}

	request(op: string, ...args: unknown[]): Promise<unknown> {
		if (this.#socket.destroyed) return Promise.reject(new CpBridgeError("parent host connection closed"));
		const id = ++this.#seq;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			frame(this.#socket, { id, token: this.#token, op, args });
		});
	}

	/** Relays from the host; the first listener subscribes and drains the host's backlog. */
	async onRelay(listener: RelayListener): Promise<void> {
		this.#listeners.add(listener);
		if (this.#listeners.size === 1) await this.request("subscribe");
	}

	disconnect(): void {
		this.#socket.end();
	}
}

function spawnHost(paths: HostPaths, home: string, mode: Mode, gen: number): ChildProcess {
	mkdirSync(paths.dir, { recursive: true });
	const log = openSync(paths.log, "a", 0o600);
	try {
		const child = spawn(process.execPath, [HOST_SCRIPT, resolve(home), mode, String(gen)], { cwd: home, detached: true, stdio: ["ignore", log, log], env: process.env });
		child.on("error", (error) => appendFileSync(paths.log, `parent host spawn failed: ${error.message}\n`));
		child.unref();
		return child;
	} finally {
		closeSync(log);
	}
}

function refuseLiveLock(home: string, alive: (pid: number) => boolean, where: string, hostParent?: number): void {
	const lock = readParentLock(home);
	if (lock.state === "unreadable") throw new CpBridgeError(`parent lock unreadable: ${lock.reason}`);
	if (lock.state === "held" && alive(lock.record.pid) && lock.record.pid !== hostParent) {
		throw new CpBridgeError(`a parent already holds ${lock.path} (pid ${lock.record.pid}) with no matching responsive host in ${where}; refusing to attach or start a second one`);
	}
}

export interface AttachOptions {
	home: string;
	mode: Mode;
	/** How long to wait for a host that is starting. */
	timeoutMs?: number;
	/** Test seam. Production probes the process table. */
	isPidAlive?: (pid: number) => boolean;
}

/**
 * Attach first: join the home's responsive host, else start one — never a
 * second one, and never over a live lock or a live-but-silent host.
 */
export async function attachParentHost(options: AttachOptions): Promise<ParentHostClient> {
	const mode = multiMode(options.mode as string);
	configureLayout(mode, options.home);
	const paths = parentHostPaths(options.home, mode);
	const alive = options.isPidAlive ?? isPidAlive;
	const deadline = Date.now() + (options.timeoutMs ?? 15_000);
	let spawned: ChildProcess | undefined;
	let spawnedGen = 0;
	for (;;) {
		const { gen, record } = currentHost(paths);
		if (record) {
			const client = await ParentHostClient.connect(record).catch(() => undefined);
			if (client) {
				try {
					refuseLiveLock(options.home, alive, paths.dir, client.parentPid);
				} catch (error) {
					client.disconnect();
					throw error;
				}
				// Lost the race: stop our own late host before it could claim a home another host just left.
				if (spawned && client.hostPid !== spawned.pid) spawned.kill();
				return client;
			}
		}
		if ((!record || !alive(record.pid)) && spawnedGen !== gen + 1) {
			// No host, or a dead one: supersede it with generation gen + 1, only once the lock pid is dead too.
			refuseLiveLock(options.home, alive, paths.dir);
			spawned = spawnHost(paths, options.home, mode, gen + 1);
			spawnedGen = gen + 1;
		}
		if (Date.now() > deadline) {
			throw new CpBridgeError(record && alive(record.pid)
				? `parent host pid ${record.pid} is alive but not answering on ${record.socket}; refusing to replace it`
				: `parent host did not come up; see ${paths.log}`);
		}
		await new Promise((done) => setTimeout(done, 50));
	}
}

if (process.argv[1] === HOST_SCRIPT) {
	runParentHost(process.argv[2] ?? "", process.argv[3] ?? "", Number(process.argv[4])).catch((error: Error) => {
		console.error(`parent host ${process.pid} failed: ${error.stack ?? error.message}`);
		process.exit(1);
	});
}
