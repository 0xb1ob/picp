import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DispatchError } from "../../src/dispatch.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { git, REPO_ROOT, treehouse } from "../harness/index.ts";

test("a failing branch cleanup never masks the original error", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "masked", project: "demo", delivery: "local", kind: "ship" });
	const bin = join(b.home, "bin");
	mkdirSync(bin);
	const log = join(b.home, "git-calls");
	writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n"switch --no-track -c "*) /usr/bin/git "$@" || exit $?; printf dirty > dirty.txt; exit 0;;\n"branch -D "*) echo 'fixture delete failure' >&2; exit 1;;\nesac\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "must not start" }]);
	b.agent.writeModels(b.provider);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const previousPath = process.env.PATH;
	let failure: unknown;
	try {
		process.env.PATH = `${bin}:${previousPath}`;
		failure = await post.dispatch({ jobId: job.id, task: "Bump x.", model, fetch: false }).catch((error: unknown) => error);
	} finally {
		process.env.PATH = previousPath;
	}
	assert.ok(failure instanceof DispatchError);
	assert.equal(failure.message.split("\n")[0], "preflight refused the leased worktree:");
	assert.match(failure.message, /left in place/);
	assert.match(readFileSync(log, "utf8"), new RegExp(`branch -D ${job.id}`));
	assert.equal(git(b.clone, "rev-parse", job.id), git(b.clone, "rev-parse", "origin/main"));
	assert.equal(post.fleet.get(job.id), undefined);
	assert.ok(!/leased/.test(treehouse(b.clone, "status")));
	assert.equal(b.provider.remaining("worker"), 1);
});

test("a successful dispatch deletes no branch at all", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "happy", project: "demo", delivery: "local", kind: "ship" });
	const bin = join(b.home, "bin");
	mkdirSync(bin);
	const log = join(b.home, "git-calls");
	writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
	const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", model, queue: false, when_ready: false } }] }], { PATH: `${bin}:${process.env.PATH}` });
	assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
	const result = ends[0]?.result.details;
	assert.equal(result?.state, "dispatched");
	assert.equal("mandate_id" in result!, false);
	const calls = readFileSync(log, "utf8");
	assert.doesNotMatch(calls, /branch -D /);
	assert.doesNotMatch(calls, /switch --detach/);
	assert.equal(git(String(result?.worktree), "symbolic-ref", "--short", "HEAD"), job.id);
});
