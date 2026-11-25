/**
 * The opt-in boards-only listener (`CP_BOARDS_PORT`): `GET|HEAD` of `/boards/board.css`, `/boards/<slug>/…` and the
 * bare-slug 308, through `serveBoard`'s confinement under `BOARD_CSP`; `/boards/` only with the index on. Any Host,
 * no cookie, no `dispatch`: every other path and method is 404, so no dashboard route is reachable from this port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { escapeHtml } from "./app-page.ts";
import { BOARD_CSP, type Board, type BoardWarn, listBoards, onceWarner } from "./boards.ts";
import { send, serveBoard } from "./server.ts";
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

export function createBoardsServer(state: ViewerState, index: boolean, log: (line: string) => void): Server {
	const warn = onceWarner(log);
	return createServer((req, res) => boardsHandle(req, res, { home: state.home, stateDir: state.stateDir }, index, warn));
}
