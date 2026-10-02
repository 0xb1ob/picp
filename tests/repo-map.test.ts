import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoMap } from "../src/repo-map.ts";
import { createScratchRepo } from "./harness/scratch-repo.ts";
import type { GitRunner } from "../src/dispatch.ts";

const git: GitRunner = async (cwd, args) => {
	try {
		return { status: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (error) {
		return { status: 1, stdout: "", stderr: String(error) };
	}
};

test("repo map describes the committed tree and src exports, caches per project/commit", async (t) => {
	const repo = createScratchRepo({ withRemote: false, files: {
		"README.md": "hello\n",
		"src/app.ts": "export const x = 1;\nexport async function run() {}\n",
		"src/nested/types.ts": "export interface Options {}\nexport type Name = string;\nexport { x as renamed } from '../app';\nexport default class Client {}\n",
		"docs/deep/hidden.md": "not in the depth-two tree",
		"src/empty.ts": "", "src/no-newline.ts": "export const final = 1;",
		"src/node_modules/hidden.ts": "export const excluded = true;",
		"node_modules/secret.ts": "ignored", "state/private.ts": "ignored", "data/private.ts": "ignored", "projects/other.ts": "ignored",
	} });
	t.after(() => repo.cleanup());
	const options = { home: repo.path, project: "demo", worktree: repo.path, git };
	const commit = repo.head();
	repo.write("src/app.ts", "export const dirty = true;\n");
	const map = await repoMap(options);
	assert.match(map, /## Repo map/);
	assert.ok(map.includes(commit));
	assert.match(map, /Typecheck viewer-app with the root `npm run typecheck`/, "cp-ad1s row 12: the correct viewer-app typecheck command is named");
	assert.match(map, /src\/app\.ts.*2 lines.*x.*run/);
	const types = map.split("\n").find((line) => line.includes("src/nested/types.ts"))!;
	assert.match(types, /4 lines/);
	for (const symbol of ["Options", "Name", "renamed", "Client"]) assert.ok(types.includes(symbol));
	assert.ok(map.includes("docs/deep/"));
	assert.match(map, /src\/empty\.ts.*0 lines/);
	assert.match(map, /src\/no-newline\.ts.*1 lines.*final/);
	assert.doesNotMatch(map, /excluded/);
	assert.doesNotMatch(map, /hidden\.md|dirty|node_modules|private\.ts|other\.ts/);
	const cache = join(repo.path, ".pi-command-post/state/repo-map/demo", `${commit}.md`);
	// Legacy-layout negative fixture: the cache never lands under a top-level state/ (cp-u3i2).
	assert.equal(existsSync(join(repo.path, "state/repo-map")), false);
	assert.equal(readFileSync(cache, "utf8"), map);
	const before = statSync(cache).mtimeMs;
	const cached = await repoMap({ ...options, git: async (cwd, args) => {
		assert.ok(args[0] === "config" || args[0] === "rev-parse", "cache hit must not rescan git objects");
		return git(cwd, args);
	} });
	assert.equal(cached, map);
	assert.equal(statSync(cache).mtimeMs, before);
	repo.git("add", "src/app.ts");
	repo.git("commit", "-m", "new source");
	const next = await repoMap(options);
	assert.match(next, /dirty/);
	assert.notEqual(next, map);
	assert.ok(existsSync(join(repo.path, ".pi-command-post/state/repo-map/demo", `${repo.head()}.md`)));
});

test("repo map caps UTF-8 bytes and removes details from the largest directories first", async (t) => {
	const files: Record<string, string> = { "README.md": "demo", "src/tiny/\u6587\u5b57-keep.ts": "export const keep = 1;\n" };
	for (let n = 0; n < 150; n++) files[`src/large/module-${n}.ts`] = `export const symbol${n} = 1;\n`;
	files["src/large/\u6587\u5b57.ts"] = "export const unicode = 1;\n";
	const repo = createScratchRepo({ withRemote: false, files });
	t.after(() => repo.cleanup());
	const map = await repoMap({ home: repo.path, project: "demo", worktree: repo.path, git });
	assert.ok(Buffer.byteLength(map) <= 6144);
	assert.match(map, /[Tt]runcated/);
	assert.match(map, /src\/tiny\/\u6587\u5b57-keep\.ts.*keep/);
	assert.doesNotMatch(map, /\uFFFD/);
});

test("project-local opt-out bypasses both generation and a populated cache", async (t) => {
	const repo = createScratchRepo({ withRemote: false });
	t.after(() => repo.cleanup());
	const options = { home: repo.path, project: "demo", worktree: repo.path, git };
	repo.git("config", "--local", "command-post.repoMap", "false");
	assert.equal(await repoMap(options), "");
	assert.equal(existsSync(join(repo.path, ".pi-command-post/state/repo-map")), false);
	repo.git("config", "--local", "command-post.repoMap", "true");
	assert.match(await repoMap(options), /## Repo map/);
	repo.git("config", "--local", "command-post.repoMap", "false");
	assert.equal(await repoMap(options), "");
});

test("repo map reports failed git reads without caching a partial map", async (t) => {
	const repo = createScratchRepo({ withRemote: false });
	t.after(() => repo.cleanup());
	const map = await repoMap({ home: repo.path, project: "demo", worktree: repo.path, git: async (cwd, args) =>
		args[0] === "ls-tree" ? { status: 1, stdout: "", stderr: "injected failure" } : git(cwd, args) });
	assert.match(map, /## Repo map\n\nUnavailable:/);
	assert.equal(existsSync(join(repo.path, ".pi-command-post/state/repo-map")), false);
});
