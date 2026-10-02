/**
 * W1a: boards served read-only by the live viewer — the slug rule, traversal
 * and symlink refusal, board.json parsing, the CSP header, 404s and the
 * sidebar's board list.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Board, deriveBoards, isBoardSlug, listBoards, onceWarner, parseBoard, readBoard, resolveBoardFile } from "../src/viewer/boards.ts";
import { createViewer, type ViewerOptions } from "../src/viewer/server.ts";
import { LAYOUT } from "../src/contracts.ts";

function fixture(t: { after(fn: () => void): void }): ViewerOptions {
	const dir = mkdtempSync(join(tmpdir(), "cp-boards-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const state = join(dir, LAYOUT.state);
	const boards = join(state, "boards");
	const make = (slug: string, meta: unknown): string => {
		const site = join(boards, slug, "site");
		mkdirSync(join(site, "img"), { recursive: true });
		writeFileSync(join(boards, slug, "board.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
		return site;
	};
	const site = make("alpha", { title: "Alpha", description: "d", job_ids: ["cp-1", 7], created_at: "2026-09-01T00:00:00Z" });
	writeFileSync(join(site, "index.html"), '<link rel="stylesheet" href="/boards/board.css"><h1>Alpha</h1>');
	writeFileSync(join(site, "img", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(site, ".hidden"), "no");
	writeFileSync(join(boards, "alpha", "board.json.bak"), "outside site/");
	writeFileSync(join(dir, "secret.txt"), "secret");
	symlinkSync(join(dir, "secret.txt"), join(site, "out.txt"));
	symlinkSync(join(site, "index.html"), join(site, "in.html"));
	make("beta", { title: "Beta", created_at: "2026-09-03T00:00:00Z" });
	make("broken", "{not json");
	// A board whose site/ is a symlink out, and a board dir that is a symlink out.
	const escape = make("escape", { title: "Escape", created_at: "2026-09-02T00:00:00Z" });
	rmSync(escape, { recursive: true });
	mkdirSync(join(dir, "elsewhere"));
	writeFileSync(join(dir, "elsewhere", "index.html"), "elsewhere");
	symlinkSync(join(dir, "elsewhere"), escape);
	mkdirSync(join(dir, "linked"));
	writeFileSync(join(dir, "linked", "board.json"), JSON.stringify({ title: "Linked", created_at: "2026-09-04T00:00:00Z" }));
	symlinkSync(join(dir, "linked"), join(boards, "linked"));
	// A board whose board.json is a symlink out (its site/ is real).
	const jsonout = make("jsonout", {});
	writeFileSync(join(jsonout, "index.html"), "jsonout");
	rmSync(join(boards, "jsonout", "board.json"));
	writeFileSync(join(dir, "elsewhere.json"), JSON.stringify({ title: "Out", created_at: "2026-09-05T00:00:00Z" }));
	symlinkSync(join(dir, "elsewhere.json"), join(boards, "jsonout", "board.json"));
	return { home: dir, stateDir: state, host: "127.0.0.1", port: 0 };
}

test("slug rule: lowercase [a-z0-9-], 1-64 chars, no leading hyphen", () => {
	for (const ok of ["a", "0", "q3-report", "a-", "x".repeat(64)]) assert.equal(isBoardSlug(ok), true, ok);
	for (const bad of ["", "-a", "A", "a_b", "a.b", "..", "a/b", "x".repeat(65), " a", "é"]) assert.equal(isBoardSlug(bad), false, bad);
});

test("board.json: tolerant parse; malformed or missing required fields is no board", (t) => {
	assert.deepEqual(parseBoard("x", { title: "T", job_ids: ["a", 1, null], created_at: "c" }), {
		slug: "x",
		title: "T",
		description: "",
		job_ids: ["a"],
		created_at: "c",
	});
	assert.equal(parseBoard("x", undefined), undefined);
	assert.equal(parseBoard("x", { title: "", created_at: "c" }), undefined);
	assert.equal(parseBoard("x", { title: "T" }), undefined);
	assert.equal(parseBoard("X", { title: "T", created_at: "c" }), undefined, "bad slug");
	const state = fixture(t);
	assert.equal(readBoard(state, "broken"), undefined, "unparseable board.json");
	assert.equal(readBoard(state, "linked"), undefined, "a board dir that is a symlink is refused");
	assert.equal(readBoard(state, "nope"), undefined);
	assert.equal(readBoard(state, "alpha")?.description, "d");
});

test("sidebar board list: valid boards only, newest first", (t) => {
	const board = (slug: string, created_at: string): Board => ({ slug, title: slug, description: "", job_ids: [], created_at });
	assert.deepEqual(
		deriveBoards([board("a", "2026-01-01"), undefined, board("c", "2026-03-01"), board("b", "2026-03-01")]).map((b) => b.slug),
		["b", "c", "a"],
	);
	assert.deepEqual(
		listBoards(fixture(t)).map((b) => [b.slug, b.title, b.created_at]),
		[
			["beta", "Beta", "2026-09-03T00:00:00Z"],
			["alpha", "Alpha", "2026-09-01T00:00:00Z"],
		],
	);
	assert.deepEqual(listBoards({ home: "/nonexistent", stateDir: "/nonexistent/state" }), []);
});

test("a board whose board.json or site/ resolves outside is skipped and logged once", (t) => {
	const state = fixture(t);
	const lines: string[] = [];
	const warn = onceWarner((line) => lines.push(line));
	for (let i = 0; i < 2; i += 1) {
		const slugs = listBoards(state, warn).map((b) => b.slug);
		assert.deepEqual(slugs, ["beta", "alpha"]);
	}
	assert.equal(lines.length, 2, lines.join(""));
	assert.ok(lines.some((l) => /board jsonout skipped: board\.json resolves outside/.test(l)), lines.join(""));
	assert.ok(lines.some((l) => /board escape skipped: site\/ resolves outside/.test(l)), lines.join(""));
	assert.equal(readBoard(state, "jsonout"), undefined);
	assert.equal(resolveBoardFile(state, "jsonout", ""), undefined);
});

test("traversal and symlinks: only real files inside the board's own site/ resolve", (t) => {
	const state = fixture(t);
	assert.ok(resolveBoardFile(state, "alpha", "")?.endsWith(join("site", "index.html")));
	assert.ok(resolveBoardFile(state, "alpha", "img/a.png"));
	assert.ok(resolveBoardFile(state, "alpha", "in.html"), "a symlink that stays inside site/ is fine");
	for (const rest of ["out.txt", "../board.json", "..%2Fboard.json", "%2e%2e/board.json", "img/..%2f..%2fboard.json", ".hidden", "img", "img/", "%E0%A4%A", "a%00.png", "nope.html"]) {
		assert.equal(resolveBoardFile(state, "alpha", rest), undefined, rest);
	}
	assert.equal(resolveBoardFile(state, "escape", ""), undefined, "site/ symlinked out");
	assert.equal(resolveBoardFile(state, "broken", ""), undefined);
	assert.equal(resolveBoardFile(state, "../alpha", ""), undefined);
});

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
	return new Promise((resolvePromise, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

test("server: boards under /boards/<slug>/ with a strict CSP; everything else 404s; sidebar lists boards", async (t) => {
	const lines: string[] = [];
	const options: ViewerOptions = { ...fixture(t), log: (line) => lines.push(line) };
	const server = createViewer(options);
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const port = options.port;

	const index = await get(port, "/boards/alpha/");
	assert.equal(index.status, 200);
	assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
	const csp = String(index.headers["content-security-policy"]);
	assert.match(csp, /default-src 'self'/);
	assert.match(csp, /script-src 'none'/);
	assert.match(csp, /style-src 'self' 'unsafe-inline'/, "inline <style> blocks and style attributes render");
	assert.equal(csp.match(/script-src [^;]*/)?.[0], "script-src 'none'", "scripts stay blocked, inline included");
	assert.match(csp, /object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
	assert.match(index.body.toString(), /<h1>Alpha<\/h1>/);

	const png = await get(port, "/boards/alpha/img/a.png");
	assert.equal(png.headers["content-type"], "image/png");
	assert.deepEqual([...png.body], [0x89, 0x50, 0x4e, 0x47]);

	const css = await get(port, "/boards/board.css");
	assert.equal(css.status, 200);
	assert.match(String(css.headers["content-type"]), /text\/css/);
	assert.ok(!/https?:\/\/|@import|url\(/.test(css.body.toString()), "the built-in stylesheet loads nothing external");

	const redirect = await get(port, "/boards/alpha");
	assert.equal(redirect.status, 308);
	assert.equal(redirect.headers.location, "/boards/alpha/");

	const indexRedirect = await get(port, "/boards/");
	assert.equal(indexRedirect.status, 302);
	assert.equal(indexRedirect.headers.location, "/#reports");

	for (const path of ["/boards/nope/", "/boards/nope", "/boards/broken/", "/boards/Alpha/", "/boards/-a/", "/boards/alpha/out.txt", "/boards/alpha/..%2Fboard.json", "/boards/escape/", "/boards/jsonout/", "/boards/jsonout", "/boards/linked/", "/boards/alpha/missing.html"]) {
		const reply = await get(port, path);
		assert.equal(reply.status, 404, path);
		assert.match(String(reply.headers["content-security-policy"]), /default-src 'self'/, path);
	}
	assert.equal((await get(port, "/boards/alpha/", "evil.example")).status, 421, "same host-bind check as the viewer");

	for (let i = 0; i < 2; i += 1) {
		const sidebar = JSON.parse((await get(port, "/api/sessions")).body.toString()) as { boards: Board[] };
		assert.deepEqual(
			sidebar.boards.map((b) => b.slug),
			["beta", "alpha"],
		);
	}
	assert.equal(lines.length, 2, `one line per skipped board across every request: ${lines.join("")}`);
});
