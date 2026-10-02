/**
 * cp-s560 W2d: the workbench's file and git explorer. Roots are `projects/*` clones and live pool
 * worktrees only; inside a root, traversal, symlinks out and every denied name 404 (checked on the
 * request path and its realpath), and no denied file reaches a patch; git takes only an enum view and a 40-hex sha.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { denied, gitView, listOrRead, roots } from "../src/viewer/explorer.ts";
import { createViewer } from "../src/viewer/server.ts";
import { createScratchHome, git } from "./harness/index.ts";
import { LAYOUT } from "../src/contracts.ts";

const KEYS = ["key.pem", "tls.key", "id_rsa", "id_rsa.pub", "cert.p12", "auth.json"];
const put = (path: string, body: string | Buffer) => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, body));

function fixture(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	const pool = mkdtempSync(join(tmpdir(), "cp-pool-"));
	const outside = mkdtempSync(join(tmpdir(), "cp-out-"));
	t.after(() => {
		home.cleanup();
		for (const dir of [pool, outside]) rmSync(dir, { recursive: true, force: true });
	});
	const repo = join(home.path, LAYOUT.projects, "demo");
	mkdirSync(join(repo, "src", "Secrets"), { recursive: true });
	git(repo, "init", "-b", "main", "--quiet");
	for (const [k, v] of [["user.name", "cp test"], ["user.email", "cp@test.invalid"], ["commit.gpgsign", "false"]] as const) git(repo, "config", k, v);
	put(join(repo, "src", "a.ts"), "export const a = 1;\n");
	put(join(repo, "bin.dat"), Buffer.from([1, 0, 2]));
	for (const rel of [".env", ".env.local", "secrets/db.txt", ".github/workflows/ci.yml", ...KEYS.map((n) => `src/${n}`)]) put(join(repo, rel), "k\n");
	symlinkSync("/etc", join(repo, "out"));
	symlinkSync(".git/config", join(repo, "cfg"));
	symlinkSync("secrets", join(repo, "hidden"));
	git(repo, "add", "src/a.ts");
	git(repo, "commit", "-m", "first", "--quiet");
	const sha = git(repo, "rev-parse", "HEAD");
	symlinkSync(outside, join(home.path, LAYOUT.projects, "evil"));
	for (const wt of ["wt-held", "wt-done"]) mkdirSync(join(pool, wt));
	const jobs = [
		{ job_id: "cp-held", project: "demo", phase: "held", worktree: join(pool, "wt-held") },
		{ job_id: "cp-done", project: "demo", phase: "done", worktree: join(pool, "wt-done") },
		{ job_id: "cp-away", project: "demo", phase: "waiting", worktree: outside },
		{ job_id: "cp-sec", project: "demo", kind: "ship", delivery: "pr", phase: "held", worktree: "/nonexistent/cp-sec" },
	];
	put(join(home.path, LAYOUT.state, "fleet.json"), JSON.stringify({ jobs }));
	return { state: { home: home.path, stateDir: join(home.path, LAYOUT.state) }, env: { CP_TREEHOUSE_ROOT: pool }, sha, repo };
}

test("roots: project clones and live pool worktrees only", (t) => {
	const { state, env } = fixture(t);
	assert.deepEqual(roots(state, env).map((r) => r.id), ["project:demo", "worktree:cp-held"]);
});

test("denied: .git, .env*, secrets segments and key-like files", () => {
	for (const name of [".git", ".GIT", ".env", ".env.local", "secrets", "Secrets", "a.pem", "b.KEY", "id_rsa", "id_rsa.pub", "c.p12", "auth.json"]) assert.ok(denied(name), name);
	for (const name of ["src", "workflows", ".github", "env.ts", "keys.ts", "secret.ts", "auth.ts"]) assert.ok(!denied(name), name);
});

test("listOrRead: serves text inside the root and refuses traversal, symlinks out and denied names", (t) => {
	const { state, env } = fixture(t);
	const read = (rel: string, root = "project:demo") => listOrRead(state, root, rel, env);
	assert.deepEqual(read("src/a.ts"), { kind: "file", size: 20, binary: false, too_large: false, text: "export const a = 1;\n" });
	assert.deepEqual(read("bin.dat"), { kind: "file", size: 3, binary: true, too_large: false });
	assert.equal(read(".github/workflows/ci.yml")?.kind, "file", "workflow files stay readable");
	const top = read("");
	assert.ok(top?.kind === "dir");
	const names = top.entries.map((e) => e.name);
	for (const hidden of [".git", ".env", ".env.local", "secrets"]) assert.ok(!names.includes(hidden), hidden);
	assert.deepEqual(names.slice(0, 2), [".github", "src"], "directories first");
	const src = read("src");
	assert.deepEqual(src?.kind === "dir" && src.entries.map((e) => e.name), ["a.ts"]);
	for (const rel of ["..", "a/../..", "src/../..", "%2e%2e", ".", "./src", ".git/config", ".git", ".env", ".env.local", "cfg", "out/passwd", "out", "hidden/db.txt", "secrets/db.txt", "src/Secrets", "src//a.ts", "src/", "/src", "src\0/a.ts", "src\\a.ts", ...KEYS.map((n) => `src/${n}`)]) {
		assert.equal(read(rel), undefined, JSON.stringify(rel));
	}
	for (const root of ["project:evil", "project:..", "project:demo:x", "project:demo/src", "worktree:cp-done", "worktree:cp-away", "worktree:../x", "demo", ""]) assert.equal(read("", root), undefined, root);
	assert.equal(read("", "worktree:cp-held")?.kind, "dir");
});

test("gitView: log and show by sha; a bad view or sha is 400, a bad root 404", async (t) => {
	const { state, env, sha } = fixture(t);
	const log = await gitView(state, "project:demo", "log", undefined, env);
	assert.equal(log.status, 200);
	assert.deepEqual((log.body as { commits: Array<{ sha: string; subject: string }> }).commits.map((c) => [c.sha, c.subject]), [[sha, "first"]]);
	const show = await gitView(state, "project:demo", "show", sha, env);
	assert.match((show.body as { text: string }).text, /^\+export const a = 1;$/m);
	for (const view of ["status", "refs"]) assert.equal((await gitView(state, "project:demo", view, undefined, env)).status, 200, view);
	for (const [view, bad] of [["show", "HEAD"], ["show", "--output=x"], ["show", undefined], ["config", undefined], ["constructor", undefined]] as const) {
		assert.equal((await gitView(state, "project:demo", view, bad, env)).status, 400, `${view} ${bad}`);
	}
	assert.equal((await gitView(state, "project:evil", "log", undefined, env)).status, 404);
});

test("server: /api/git status omits denied untracked names", async (t) => {
	const { state, repo } = fixture(t);
	git(repo, "add", "-f", "--all");
	git(repo, "commit", "-m", "baseline", "--quiet");
	put(join(repo, ".env.secret"), "secret\n");
	put(join(repo, "ordinary.txt"), "visible\n");
	const options = { ...state, host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	const response = JSON.parse((await get(options.port, "/api/git?root=project:demo&view=status")).body);
	assert.equal(response.ok, true);
	assert.deepEqual(response.lines.filter((line: string) => line.startsWith("?? ")), ["?? ordinary.txt"]);
});

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let body = "";
			res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject).end();
	});
}

const SECRET_FILES = [".env", "sub/.ENV.prod", "secrets/db.txt", "deep/Secrets/x.txt", "k.pem", "sub/tls.key", "id_rsa", "sub/id_rsa.pub", "c.p12", "sub/auth.json"];

test("server: /api/roots, /api/files and /api/git status codes; no denied file reaches /api/git show or /api/diff", async (t) => {
	const { state, sha, repo } = fixture(t);
	const options = { ...state, host: "127.0.0.1", port: 0 };
	const server = createViewer(options);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	options.port = (server.address() as AddressInfo).port;
	t.after(() => server.close());
	assert.ok(JSON.parse((await get(options.port, "/api/roots")).body).roots.some((r: { id: string }) => r.id === "project:demo"));
	assert.equal((await get(options.port, "/api/files?root=project:demo&path=src/a.ts")).status, 200);
	for (const path of ["src/../../x", "%2e%2e", ".env", ".git/config", "secrets/db.txt", "cfg"]) {
		assert.equal((await get(options.port, `/api/files?root=project:demo&path=${encodeURIComponent(path)}`)).status, 404, path);
	}
	assert.equal((await get(options.port, `/api/git?root=project:demo&view=show&sha=${sha}`)).status, 200);
	for (const q of ["view=show&sha=HEAD", "view=nope"]) assert.equal((await get(options.port, `/api/git?root=project:demo&${q}`)).status, 400, q);
	assert.equal((await get(options.port, "/api/git?root=project:evil&view=log")).status, 404);
	// A head commit touching every denied pattern plus one ordinary file, named by a held job's envelope.
	for (const rel of SECRET_FILES) put(join(repo, rel), `SEKRIT ${rel}\n`);
	put(join(repo, "src", "b.ts"), "export const visible = 2;\n");
	git(repo, "add", "-f", "src/b.ts", ...SECRET_FILES);
	git(repo, "commit", "-m", "secrets", "--quiet");
	const head = git(repo, "rev-parse", "HEAD");
	put(join(state.stateDir, "runs", "cp-sec", "envelope.json"), JSON.stringify({ envelope: { head_sha: head, base_sha: sha } }));
	const show = JSON.parse((await get(options.port, `/api/git?root=project:demo&view=show&sha=${head}`)).body);
	const diff = JSON.parse((await get(options.port, "/api/diff?id=cp-sec")).body);
	assert.deepEqual([show.ok, diff.available], [true, true], JSON.stringify(diff));
	for (const [what, text] of [["git show", show.text], ["/api/diff", diff.text]] as const) {
		assert.match(text, /^\+export const visible = 2;$/m, `${what} still shows the ordinary file`);
		assert.doesNotMatch(text, /SEKRIT/, `${what} leaks a denied file's content`);
		for (const rel of SECRET_FILES) assert.ok(!text.includes(rel), `${what} names ${rel}`);
	}
});
