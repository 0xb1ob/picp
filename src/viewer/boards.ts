/**
 * Boards (W1a): read-only static pages the viewer serves under `/boards/<slug>/`.
 *
 * A board is `<stateDir>/boards/<slug>/` holding `board.json`
 * (`{title, description, job_ids, created_at}`) and `site/`, the only served
 * directory. Nothing here writes: boards are created by writing files.
 *
 * A URL reaches the filesystem only through `resolveBoardFile`, which refuses a
 * bad slug, dot segments, encoded slashes and anything whose real path is not
 * inside the board's own real `site/` — so a symlink out (of the file, of
 * `site/`, or of the board directory itself) is a 404, never a read. Listing
 * uses the same confinement: a board whose `board.json` or `site/` resolves
 * outside `state/boards/<slug>/` is not a board — skipped and warned about once.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { readObject, type ViewerState } from "./sessions.ts";

/** Lowercase `[a-z0-9-]`, 1-64 chars, no leading hyphen. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function isBoardSlug(slug: string): boolean {
	return SLUG.test(slug);
}

export interface Board {
	slug: string;
	title: string;
	description: string;
	job_ids: string[];
	created_at: string;
}

/** Board responses: own-origin CSS and images only, no script, no framing. */
export const BOARD_CSP =
	"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The built-in stylesheet, served at `/boards/board.css` (not a slug: it has a dot). */
export const BOARD_CSS = `*{box-sizing:border-box}
body{margin:0 auto;max-width:960px;padding:24px;font:15px/1.5 system-ui,sans-serif;background:#111;color:#ddd}
h1,h2,h3{line-height:1.2;color:#eee}a{color:#7af}img{max-width:100%;height:auto}
pre,code{font:13px monospace;background:#1a1a1a;border-radius:4px}pre{padding:8px;overflow-x:auto}code{padding:0 3px}
table{border-collapse:collapse}th,td{border:1px solid #333;padding:4px 8px;text-align:left}
blockquote{border-left:3px solid #444;margin:8px 0;padding-left:10px;color:#aaa}
`;

const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};
export function contentType(file: string): string {
	return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function boardsDir(state: ViewerState): string {
	return join(state.stateDir, "boards");
}

/**
 * `board.json`'s value as a board, or `undefined` when it is not an object or
 * lacks a string `title`/`created_at`. `description` defaults to "", and
 * `job_ids` keeps only its strings.
 */
export function parseBoard(slug: string, value: Record<string, unknown> | undefined): Board | undefined {
	if (!value || !isBoardSlug(slug)) return undefined;
	const { title, description, job_ids: jobIds, created_at: createdAt } = value;
	if (typeof title !== "string" || title.length === 0 || typeof createdAt !== "string") return undefined;
	return {
		slug,
		title,
		description: typeof description === "string" ? description : "",
		job_ids: Array.isArray(jobIds) ? jobIds.filter((id): id is string => typeof id === "string") : [],
		created_at: createdAt,
	};
}

export type BoardWarn = (slug: string, reason: string) => void;

/** A `BoardWarn` that writes each (slug, reason) to `sink` the first time only. */
export function onceWarner(sink: (line: string) => void): BoardWarn {
	const seen = new Set<string>();
	return (slug, reason) => {
		const key = `${slug}\0${reason}`;
		if (seen.has(key)) return;
		seen.add(key);
		sink(`cp-view: board ${slug} skipped: ${reason}\n`);
	};
}

/** `realpath(path)`, `null` when `path` does not exist, `undefined` when it cannot be resolved (dangling link). */
function realOf(path: string): string | null | undefined {
	try {
		lstatSync(path);
	} catch {
		return null;
	}
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/**
 * A board by slug, or `undefined`: bad slug, not a real directory, a
 * missing/malformed `board.json`, or a `board.json`/`site/` that resolves
 * outside the board's own directory (reported through `warn`).
 */
export function readBoard(state: ViewerState, slug: string, warn: BoardWarn = () => {}): Board | undefined {
	if (!isBoardSlug(slug)) return undefined;
	const dir = join(boardsDir(state), slug);
	let realDir: string;
	try {
		if (!lstatSync(dir).isDirectory()) return undefined;
		realDir = realpathSync(dir);
		if (realDir !== join(realpathSync(boardsDir(state)), slug)) return undefined;
	} catch {
		return undefined;
	}
	const json = realOf(join(dir, "board.json"));
	if (json === undefined || (json !== null && !json.startsWith(`${realDir}${sep}`))) {
		warn(slug, `board.json resolves outside state/boards/${slug}/`);
		return undefined;
	}
	const site = realOf(join(dir, "site"));
	if (site !== null && site !== join(realDir, "site")) {
		warn(slug, `site/ resolves outside state/boards/${slug}/`);
		return undefined;
	}
	return parseBoard(slug, json === null ? undefined : readObject(json));
}

/** Newest first by `created_at`, ties by slug. */
export function deriveBoards(boards: ReadonlyArray<Board | undefined>): Board[] {
	return boards
		.filter((board): board is Board => board !== undefined)
		.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.slug.localeCompare(b.slug));
}

export function listBoards(state: ViewerState, warn: BoardWarn = () => {}): Board[] {
	let names: string[];
	try {
		names = readdirSync(boardsDir(state));
	} catch {
		return [];
	}
	return deriveBoards(names.map((name) => readBoard(state, name, warn)));
}

/**
 * The file a `/boards/<slug>/<rest>` request names, or `undefined` for 404.
 * `rest` is the still-percent-encoded path after the slug; empty or a trailing
 * slash means `index.html`.
 */
export function resolveBoardFile(state: ViewerState, slug: string, rest: string, warn: BoardWarn = () => {}): string | undefined {
	if (!readBoard(state, slug, warn)) return undefined;
	const segments: string[] = [];
	for (const raw of rest.split("/")) {
		let segment: string;
		try {
			segment = decodeURIComponent(raw);
		} catch {
			return undefined;
		}
		if (segment.startsWith(".") || /[/\\\0]/.test(segment)) return undefined;
		if (segment !== "") segments.push(segment);
	}
	if (rest === "" || rest.endsWith("/")) segments.push("index.html");
	let realSite: string;
	let real: string;
	try {
		// The board dir and site/ must themselves be real directories under the real boards root.
		realSite = realpathSync(join(boardsDir(state), slug, "site"));
		if (realSite !== join(realpathSync(boardsDir(state)), slug, "site")) return undefined;
		real = realpathSync(join(realSite, ...segments));
		if (!statSync(real).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return real.startsWith(`${realSite}${sep}`) ? real : undefined;
}
