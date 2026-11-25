/**
 * The opt-in boards-only listener (`CP_BOARDS_PORT`): `GET|HEAD` of `/boards/board.css`, `/boards/<slug>/…` and the
 * bare-slug 308, through `serveBoard`'s confinement under `BOARD_CSP`; `/boards/` only with the index on. Any Host,
 * no cookie, no `dispatch`: every other path and method is 404, so no dashboard route is reachable from this port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { type DaemonConfig, daemonPaths, readDaemonConfig } from "../service/daemon-files.ts";
import type { BoardsListenerState } from "./api-types.ts";
import { escapeHtml } from "./app-page.ts";
import type { BoardsAddress } from "./bind-host.ts";
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
	return createServer((req, res) => boardsHandle(req, res, { home: state.home, stateDir: state.stateDir }, index(), warn));
}

/** The Settings keys whose applied change moves the listener (`BoardsListener.reload`). */
export const BOARDS_LISTENER_KEYS: readonly string[] = ["boards.port", "boards.host", "boards.index"];

/** The address `data/daemon.json` names, as cp-daemon passes it on (`boardsEnv`); undefined when no port is set. */
export function boardsOfConfig(config?: DaemonConfig): BoardsAddress | undefined {
	if (config?.boards_port === undefined) return undefined;
	return { port: config.boards_port, host: config.boards_host ?? "127.0.0.1", index: config.boards_index === true };
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
	reload(home: string): Promise<BoardsListenerState>;
}

const closeServer = (server: Server): Promise<void> => new Promise((done) => {
	server.close(() => done());
	server.closeAllConnections();
});

/** The boards-only listener beside the dashboard on `dashboardPort`; a clash or listen error is logged, never fatal. */
export function boardsListener(state: ViewerState, dashboardPort: number, out: (line: string) => void, err: (line: string) => void): BoardsListener {
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
		out(`cp-view: boards http://${where}/boards/<slug>/ (boards only: public to anyone who can reach it; index ${index ? "on" : "off"})\n`);
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
		reload: (home) => {
			const file = daemonPaths(home).config;
			// The reason reaches the browser: the home path never does.
			const failed = (why: string): Promise<BoardsListenerState> => Promise.resolve({ state: "failed", error: `${why.split(home).join("<home>")}; the listener is unchanged` });
			let config: DaemonConfig | undefined;
			try {
				config = readDaemonConfig(file);
			} catch (error) {
				return failed((error as Error).message);
			}
			return config ? apply(boardsOfConfig(config)) : failed(`${file} is absent`);
		},
	};
}
