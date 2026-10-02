import assert from "node:assert/strict";
import { test } from "node:test";
import { type DepsPorts, prepareNodeDeps } from "../src/worktree-deps.ts";

const lock = (version: string) => JSON.stringify({ packages: { "": {}, "node_modules/x": { version } } });
const hidden = (version: string) => JSON.stringify({ packages: { "node_modules/x": { version } } });

function ports(files: Record<string, string>, ok = true) {
	const calls: string[] = [];
	const fake: DepsPorts = {
		read: (path) => files[path],
		npmCi: async (cwd) => {
			calls.push(cwd);
			return ok ? { ok } : { ok, error: "EINTEGRITY" };
		},
	};
	return { fake, calls };
}

test("a stale node_modules runs npm ci in the worktree", async () => {
	const { fake, calls } = ports({ "/w/package-lock.json": lock("2.0.0"), "/w/node_modules/.package-lock.json": hidden("1.0.0") });
	const result = await prepareNodeDeps("/w", fake);
	assert.deepEqual(calls, ["/w"]);
	assert.equal(result.outcome, "installed");
});

test("a missing node_modules runs npm ci", async () => {
	const { fake, calls } = ports({ "/w/package-lock.json": lock("1.0.0") });
	assert.equal((await prepareNodeDeps("/w", fake)).outcome, "installed");
	assert.equal(calls.length, 1);
});

test("a matching node_modules does not", async () => {
	const { fake, calls } = ports({ "/w/package-lock.json": lock("1.0.0"), "/w/node_modules/.package-lock.json": hidden("1.0.0") });
	assert.equal((await prepareNodeDeps("/w", fake)).outcome, "current");
	assert.deepEqual(calls, []);
});

test("a project without package-lock.json is skipped", async () => {
	const { fake, calls } = ports({});
	assert.equal((await prepareNodeDeps("/w", fake)).outcome, "skipped");
	assert.deepEqual(calls, []);
});

test("a failed npm ci is an outcome with a brief note, never a throw", async () => {
	const { fake } = ports({ "/w/package-lock.json": lock("1.0.0") }, false);
	const result = await prepareNodeDeps("/w", fake);
	assert.equal(result.outcome, "failed");
	assert.match(result.detail, /EINTEGRITY/);
	assert.match(result.note ?? "", /stale.*npm ci/);
});
