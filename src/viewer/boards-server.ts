/**
 * The opt-in boards-only listener (`CP_BOARDS_PORT`): `GET|HEAD` of `/boards/board.css`, `/boards/<slug>/…` and the
 * bare-slug 308, through `serveBoard`'s confinement under `BOARD_CSP`; `/boards/` only with the index on. Any Host,
 * no cookie, no `dispatch`: every other path and method is 404, so no dashboard route is reachable from this port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createServer as createNetServer, isIP } from "node:net";
import { dirname, join } from "node:path";
import type { BoardsListenerState } from "./api-types.ts";
import { escapeHtml } from "./app-page.ts";
import { type BoardsAddress, boardsAddress } from "./bind-host.ts";
import { BOARD_CSP, type Board, type BoardWarn, listBoards, onceWarner } from "./boards.ts";
import { hostHeaderFor, send, serveBoard } from "./server.ts";
import type { ViewerState } from "./sessions.ts";

const CSP = { "content-security-policy": BOARD_CSP };

function notFound(res: ServerResponse): void {
	send(res, 404, "text/plain; charset=utf-8", "not found\n", CSP);
}

function indexHtml(boards: Board[]): string {
	const items = boards.map((board) => `<li><a href="/boards/${escapeHtml(board.slug)}/">${escapeHtml(board.title)}</a> `
		+ `<small>${escapeHtml(board.created_at)}</small>${board.description ? `<p>${escapeHtml(board.description)}</p>` : ""}</li>`);
	const list = items.length ? `<ul>${items.join("")}</ul>` : "<p>No boards published.</p>";
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
		+ `<title>Boards</title><link rel="stylesheet" href="/boards/board.css"></head><body><h1>Boards</h1>${list}</body></html>`;
}

export function boardsHandle(req: IncomingMessage, res: ServerResponse, state: ViewerState, index: boolean, warn: BoardWarn): void {
	if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
	let url: URL;
	try {
		// Parsed exactly as `dispatch` parses it, so dot-segment and %2e normalisation match the dashboard's boards.
		url = new URL(req.url ?? "/", "http://boards.invalid");
	} catch {
		return notFound(res);
	}
	if (url.pathname === "/boards/") {
		if (index) send(res, 200, "text/html; charset=utf-8", indexHtml(listBoards(state, warn)), CSP);
		else notFound(res);
		return;
	}
	if (url.pathname.startsWith("/boards/")) return serveBoard(res, url.pathname, state, warn);
	notFound(res);
}

/** `index` is read per request, so a Settings save turns the `/boards/` list on or off without a rebind. */
export function createBoardsServer(state: ViewerState, index: () => boolean, log: (line: string) => void): Server {
	const warn = onceWarner(log);
	const own = { home: state.home, stateDir: state.stateDir };
	return createServer((req, res) => boardsHandle(req, res, own, index(), warn));
}

/** `data/daemon.json` beside the state dir (cp-daemon's `daemonPaths`); the viewer imports no daemon module. */
export const daemonConfigFile = (stateDir: string): string => join(dirname(stateDir), "data", "daemon.json");

/** The `boards_*` keys of `data/daemon.json`; `address` absent when no port is set. */
export interface DaemonBoards { address?: BoardsAddress; host: string }

/**
 * `data/daemon.json`'s boards keys under `boardsAddress`'s rules, the ones cp-daemon's `boardsEnv` hands the viewer.
 * Undefined when the file is absent; an unreadable file or a bad key throws, naming the file.
 */
export function readDaemonBoards(stateDir: string): DaemonBoards | undefined {
	const file = daemonConfigFile(stateDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${file} is not a JSON object`);
	const { boards_port: port, boards_host: host, boards_index: index } = raw as Record<string, unknown>;
	if (index !== undefined && typeof index !== "boolean") throw new Error(`${file}: boards_index must be true or false`);
	if (host !== undefined && (typeof host !== "string" || isIP(host) === 0 || host.includes("%"))) {
		throw new Error(`${file}: boards_host must be an IP address`);
	}
	const bind = host as string | undefined;
	const at = port === undefined ? undefined : String(port);
	const env = { CP_BOARDS_PORT: at, CP_BOARDS_HOST: bind, CP_BOARDS_INDEX: "0" };
	if (index === true) env.CP_BOARDS_INDEX = "1";
	try {
		return { address: boardsAddress(env), host: bind ?? "127.0.0.1" };
	} catch (error) {
		throw new Error(`${file}: ${(error as Error).message.replace("CP_BOARDS_PORT", "boards_port")}`);
	}
}

/** One exclusive bind of host:port, closed at once: the error code (EADDRINUSE, EADDRNOTAVAIL, EACCES) or undefined. */
export function probeBind(port: number, host: string): Promise<string | undefined> {
	return new Promise((done) => {
		const probe = createNetServer();
		probe.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? error.message));
		probe.listen({ port, host, exclusive: true }, () => probe.close(() => done(undefined)));
	});
}

export interface BoardsListener {
	status(): BoardsListenerState;
	/** Start, stop or move the listener to `address` (undefined: off); calls run one at a time, in order. */
	apply(address: BoardsAddress | undefined): Promise<BoardsListenerState>;
	/** `apply` what `data/daemon.json` names now; an absent or unreadable file is `failed` and moves nothing. */
	reload(): Promise<BoardsListenerState>;
	/**
	 * Why a Settings set of `boards.port`/`boards.host` (merged with `data/daemon.json`) cannot bind here: the dashboard's
	 * own port (400) or a port held on that address (409). Unreadable files and bad values are the session's to refuse.
	 */
	refusal(changes: Record<string, unknown>): Promise<{ status: number; reason: string } | undefined>;
}

const closeServer = (server: Server): Promise<void> => new Promise((done) => {
	server.close(() => done());
	server.closeAllConnections();
});

/** The boards-only listener beside the dashboard on `dashboardPort`; a clash or listen error is logged, never fatal. */
export function boardsListener(
	state: ViewerState,
	dashboardPort: number,
	out: (line: string) => void,
	err: (line: string) => void,
): BoardsListener {
	let open: { server: Server; host: string; port: number } | undefined;
	let index = false;
	let current: BoardsListenerState = { state: "off" };
	let queue: Promise<unknown> = Promise.resolve();
	const step = async (address: BoardsAddress | undefined): Promise<BoardsListenerState> => {
		if (open && address && address.host === open.host && address.port === open.port) {
			index = address.index;
			return (current = { state: "listening", host: open.host, port: open.port, index });
		}
		if (open) {
			const was = hostHeaderFor(open.host, open.port);
			await closeServer(open.server);
			open = undefined;
			out(`cp-view: boards listener stopped (was ${was})\n`);
		}
		if (!address) return (current = { state: "off" });
		const { host, port } = address;
		if (port === dashboardPort) {
			err(`cp-view: boards listener not started: CP_BOARDS_PORT ${port} is the dashboard port\n`);
			return (current = { state: "failed", host, port, error: `${port} is the dashboard port` });
		}
		index = address.index;
		const where = hostHeaderFor(host, port);
		const server = createBoardsServer(state, () => index, err);
		const failed = await new Promise<string | undefined>((done) => {
			server.on("error", (error: NodeJS.ErrnoException) => {
				if (open?.server === server) err(`cp-view: boards listener on ${where} error: ${error.code ?? error.message}\n`);
				done(error.code ?? error.message);
			});
			server.listen(port, host, () => done(undefined));
		});
		if (failed) {
			err(`cp-view: boards listener on ${where} failed: ${failed}; the dashboard keeps serving\n`);
			return (current = { state: "failed", host, port, index, error: failed });
		}
		open = { server, host, port };
		const said = `index ${index ? "on" : "off"}`;
		out(`cp-view: boards http://${where}/boards/<slug>/ (boards only: public to anyone who can reach it; ${said})\n`);
		return (current = { state: "listening", host, port, index });
	};
	const apply = (address: BoardsAddress | undefined): Promise<BoardsListenerState> => {
		const run = queue.then(() => step(address));
		queue = run.catch(() => undefined);
		return run;
	};
	return {
		status: () => ({ ...current }),
		apply,
		reload: () => {
			// The reason reaches the browser: the home path never does.
			const failed = (why: string): Promise<BoardsListenerState> =>
				Promise.resolve({ state: "failed", error: `${why.split(state.home).join("<home>")}; the listener is unchanged` });
			let boards: DaemonBoards | undefined;
			try {
				boards = readDaemonBoards(state.stateDir);
			} catch (error) {
				return failed((error as Error).message);
			}
			return boards ? apply(boards.address) : failed(`${daemonConfigFile(state.stateDir)} is absent`);
		},
		refusal: async (changes) => {
			if (!("boards.port" in changes) && !("boards.host" in changes)) return undefined;
			let boards: DaemonBoards | undefined;
			try {
				boards = readDaemonBoards(state.stateDir);
			} catch {
				return undefined;
			}
			if (!boards) return undefined;
			const port = "boards.port" in changes ? changes["boards.port"] : boards.address?.port;
			const host = "boards.host" in changes ? changes["boards.host"] : boards.host;
			if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
			if (typeof host !== "string" || isIP(host) === 0 || host.includes("%")) return undefined;
			if (port === dashboardPort) {
				return { status: 400, reason: `boards.port: ${port} is the dashboard port; pick another port` };
			}
			// The live listener's own port would read as held; a move on it closes first and reports a failed rebind.
			if (current.state === "listening" && port === current.port) return undefined;
			const code = await probeBind(port, host);
			if (!code) return undefined;
			const held = `boards.port ${port} on ${host} is in use or unavailable here (${code})`;
			return { status: 409, reason: `${held}; pick another port or address` };
		},
	};
}
