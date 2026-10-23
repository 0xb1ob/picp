import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { git, readRunEvents, treehouse } from "../harness/index.ts";

for (const committed of [false, true]) {
	test(`S29 cleanup: late filesystem fault ${committed ? "preserves committed work" : "removes the empty branch"}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t, { files: { "package-lock.json": "{\"packages\":{}}\n" } });
		const job = await b.ledger.create({ title: "late fault", project: "demo", delivery: "local", kind: "ship" });
		const bin = join(b.home, "bin");
		mkdirSync(bin);
		const npm = join(bin, "npm");
		const fleet = join(b.home, LAYOUT.fleetFile);
		writeFileSync(npm, `#!/bin/sh\n[ "$1" = ci ] || exit 97\n${committed ? 'git -c user.name=fixture -c user.email=fixture@example.test commit --allow-empty -m "work nobody may lose"\n' : ""}mkdir -p '${fleet}'\nexit 0\n`);
		chmodSync(npm, 0o700);
		const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", model, queue: false, when_ready: false } }] }], { PATH: `${bin}:${process.env.PATH}` });
		assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
		assert.match(JSON.stringify(ends[0]?.result), /EISDIR/);
		assert.equal((await b.ledger.show(job.id)).status, "open");
		const events = readRunEvents(b.home, job.id).filter((event) => event.type === "job_branch_cleaned");
		assert.equal(events.length, 1);
		const payload = events[0]!.payload as Record<string, unknown>;
		assert.equal(payload.branch, job.id);
		assert.equal(payload.deleted, !committed);
		if (committed) {
			assert.match(String(payload.reason), /has commits on it/);
			assert.equal(payload.at, undefined);
			assert.match(JSON.stringify(ends[0]?.result), /left in place/);
			assert.equal(git(b.clone, "log", "-1", "--format=%s", job.id), "work nobody may lose");
		} else {
			assert.equal(payload.at, git(b.clone, "rev-parse", "origin/main"));
			assert.equal(payload.reason, undefined);
			assert.equal(git(b.clone, "branch", "--list", job.id), "");
			assert.ok(!/leased/.test(treehouse(b.clone, "status")));
		}
	});
}

test("S29 cleanup: an existing branch refuses without taking a lease", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const job = await b.ledger.create({ title: "leftover", project: "demo", delivery: "local", kind: "ship" });
	git(b.clone, "branch", job.id, "origin/main");
	const tip = git(b.clone, "rev-parse", job.id);
	const model = b.provider.addScript("worker", [{ kind: "text", text: "must not start" }]);
	const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", model } }] }]);
	assert.equal(ends[0]?.isError, true);
	assert.match(JSON.stringify(ends[0]?.result), /branch_exists/);
	assert.equal(git(b.clone, "rev-parse", job.id), tip);
	assert.equal(existsSync(join(b.home, LAYOUT.fleetFile)), false);
	assert.ok(!/leased/.test(treehouse(b.clone, "status")));
	assert.equal(b.provider.remaining("worker"), 1);
});

for (const fault of ["unreadable", "delete failed"]) {
	test(`S29 cleanup: ${fault} preserves the ref and reports the reason`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t, { files: { "package-lock.json": "{\"packages\":{}}\n" } });
		const job = await b.ledger.create({ title: fault, project: "demo", delivery: "local", kind: "ship" });
		const bin = join(b.home, "bin");
		mkdirSync(bin);
		const fleet = join(b.home, LAYOUT.fleetFile);
		writeFileSync(join(bin, "npm"), `#!/bin/sh\nmkdir -p '${fleet}'\n`);
		const condition = fault === "unreadable" ? `[ "$1" = rev-parse ] && [ "$4" = refs/heads/${job.id} ]` : '[ "$1" = branch ] && [ "$2" = -D ]';
		writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ -d '${fleet}' ] && ${condition}; then echo 'fixture git fault' >&2; exit 1; fi\nexec /usr/bin/git "$@"\n`);
		for (const name of ["git", "npm"]) chmodSync(join(bin, name), 0o700);
		const model = b.provider.addScript("worker", [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Bump x.", model } }] }], { PATH: `${bin}:${process.env.PATH}` });
		assert.equal(ends[0]?.isError, true);
		assert.match(JSON.stringify(ends[0]?.result), /EISDIR/);
		assert.match(JSON.stringify(ends[0]?.result), /left in place/);
		const events = readRunEvents(b.home, job.id).filter((event) => event.type === "job_branch_cleaned");
		assert.equal(events.length, 1);
		const payload = events[0]!.payload as Record<string, unknown>;
		assert.equal(payload.deleted, false);
		assert.equal(payload.at, undefined);
		assert.match(String(payload.reason), fault === "unreadable" ? /tip could not be read/ : /delete failed/);
		assert.equal(git(b.clone, "rev-parse", job.id), git(b.clone, "rev-parse", "origin/main"));
	});
}
