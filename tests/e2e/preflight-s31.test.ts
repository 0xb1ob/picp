import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, type FleetRecord, isoTimestamp, LAYOUT } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { createScratchRepo, git, REPO_ROOT } from "../harness/index.ts";

for (const state of ["clean", "unregistered", "archived", "denied", "corrupt", "branch", "base", "detached", "off-base", "dirty-primary", "dirty-target", "foreign", "primary", "missing", "origin", "retry", "contention", "unreachable"] as const) {
	test(`S31 cp_check: ${state}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
		const args: Record<string, unknown> = { project: "demo", job_id: "cp-new", fetch: false };
		let code: string | undefined;
		let status = "fail";
		switch (state) {
			case "clean": status = "ok"; break;
			case "unregistered": args.project = "ghost"; code = "clone_not_canonical"; break;
			case "archived": await post.registry.setArchived("demo", true); code = "project_archived"; break;
			case "denied":
			case "corrupt": writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), state === "corrupt" ? "{ nope" : JSON.stringify({ deny_projects: ["demo"] })); code = "project_denied"; break;
			case "branch": git(b.clone, "branch", "cp-new"); code = "branch_exists"; break;
			case "base": args.base = "nope"; code = "base_missing"; break;
			case "detached": git(b.clone, "checkout", "--quiet", "--detach", "HEAD"); code = "primary_detached"; break;
			case "off-base": git(b.clone, "checkout", "--quiet", "-b", "side"); code = "primary_off_base"; break;
			case "dirty-primary": writeFileSync(join(b.clone, "dirty"), "x"); status = "ok"; code = "primary_dirty"; break;
			case "dirty-target": {
				const worktree = join(b.home, "dirty-target");
				git(b.clone, "worktree", "add", "--quiet", worktree, "-b", "cp-new");
				writeFileSync(join(worktree, "dirty"), "x"); args.worktree = worktree; code = "worktree_dirty"; break;
			}
			case "foreign": {
				const other = createScratchRepo({ name: "other" }); t.after(() => other.cleanup());
				const worktree = join(b.home, "foreign-target");
				git(other.path, "worktree", "add", "--quiet", worktree, "-b", "foreign");
				args.worktree = worktree; code = "worktree_foreign"; break;
			}
			case "primary": args.worktree = b.clone; code = "worktree_is_primary"; break;
			case "missing": args.worktree = join(b.home, "absent"); code = "worktree_missing"; break;
			case "origin": git(b.clone, "remote", "set-url", "origin", join(b.home, "absent.git")); args.fetch = true; code = "origin_mismatch"; break;
			case "retry":
			case "contention":
			case "unreachable": args.fetch = true; code = state === "retry" ? undefined : state === "contention" ? "fetch_contention" : "fetch_failed"; if (state === "retry") status = "ok"; break;
		}
		const bin = join(b.home, "bin"); mkdirSync(bin);
		if (["retry", "contention", "unreachable"].includes(state)) {
			const count = join(b.home, "fetch-count");
			writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ "$1" = fetch ]; then\necho fetch >> '${count}'\n${state === "retry" ? `attempt=$(wc -l < '${count}'); if [ "$attempt" -gt 2 ]; then exec /usr/bin/git "$@"; fi; if [ "$attempt" -eq 1 ]; then echo 'unable to update local ref' >&2; else echo 'cannot lock ref refs/remotes/origin/main: is at bad but expected good' >&2; fi` : `echo '${state === "unreachable" ? "fatal: could not read from remote repository." : "failed to lock ref refs/remotes/origin/main"}' >&2`}\nexit 1\nfi\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
		}
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_check", args }] }], { PATH: `${bin}:${process.env.PATH}` });
		const result = ends[0]?.result.details;
		assert.equal(result?.status, status, JSON.stringify(ends));
		const findings = result?.findings as Array<{ code: string; fix: string }>;
		if (code) assert.ok(findings.some((finding) => finding.code === code), `${state}: ${JSON.stringify(findings)}`);
		else assert.deepEqual(findings, []);
		if (["retry", "contention", "unreachable"].includes(state)) {
			assert.equal(readFileSync(join(b.home, "fetch-count"), "utf8").trim().split("\n").length, state === "unreachable" ? 1 : 3, `fetch attempts for ${state}`);
		}
		if (state === "contention") assert.doesNotMatch(findings.find((finding) => finding.code === code)?.fix ?? "", /reachable origin remote/);
		if (state === "unreachable") assert.match(findings.find((finding) => finding.code === code)?.fix ?? "", /reachable origin remote/);
		if (state === "clean") { assert.equal(result?.clone, b.clone); assert.equal(result?.base, "main"); }
		if (state === "origin") assert.ok(findings.some((finding) => finding.code === "fetch_failed"), "mismatched unreachable origin also fails fetch");
		if (state === "archived" || state === "denied") {
			if (state === "archived") await post.registry.setArchived("demo", false);
			else writeFileSync(join(b.home, LAYOUT.mandateDefaultsFile), "{}");
			const recovered = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_check", args }] }]);
			assert.equal(recovered[0]?.result.details?.status, "ok", "removing the refusal restores eligibility");
		}
	});
}

for (const state of ["same", "cross", "unknown-model", "own", "own-other-tree", "own-cross", "script-own", "script-other", "independent", "done"] as const) {
	test(`S31 occupancy: ${state}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
		const worktree = join(b.home, "held-worktree");
		git(b.clone, "worktree", "add", "--quiet", worktree, "-b", "cp-held");
		const at = isoTimestamp();
		const own = state.startsWith("own") || state === "script-own";
		const args: Record<string, unknown> = { project: "demo", job_id: own ? "cp-held" : "cp-next", model: state === "cross" || state === "own-cross" ? "mock/small" : "mock/big", fetch: false, worktree };
		if (state === "unknown-model") delete args.model;
		if (state === "own") delete args.worktree;
		if (state === "own-other-tree" || state === "independent") {
			const other = join(b.home, "other-worktree"); git(b.clone, "worktree", "add", "--quiet", other, "-b", "cp-other"); args.worktree = other;
		}
		const record: FleetRecord = { job_id: "cp-held", project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: state === "done" ? "done" : "held", reported_at: at, worktree, branch: "cp-held", dispatched_at: at, usage: EMPTY_USAGE, worker: { pid: process.pid, session_id: "s", session_file: join(b.home, "s.jsonl"), profile: "implementer", role: "implementer", model: "mock/big", started_at: at } };
		await post.fleet.add(record);
		if (state.startsWith("script")) {
			await post.fleet.remove("cp-held");
			await post.fleet.add({ ...record, executor: "script", worker: undefined, script_path: "scripts/run.sh", script_process: { pid: process.pid, started_at: at } } as unknown as Parameters<typeof post.fleet.add>[0]);
		}
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_check", args }] }]);
		const result = ends[0]?.result.details;
		const expected = state === "same" || state === "own" ? "promote" : state === "done" || state === "independent" ? "ok" : "fail";
		assert.equal(result?.status, expected, JSON.stringify(ends));
		if (expected === "promote") assert.match(JSON.stringify(result?.promote), /cp_send cp-held/);
		if (expected === "fail") assert.match(JSON.stringify(result?.findings), /occupied_refuse/);
	});
}
