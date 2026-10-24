import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { paths } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { createScratchRepo, git, readRunEvents, type ScriptStep, waitFor } from "../harness/index.ts";

for (const state of ["stale", "missing", "current", "no-lock", "failed"] as const) {
	test(`S31 dependencies: ${state} reaches a worker with its persisted outcome`, { timeout: 120_000 }, async (t) => {
		const lock = JSON.stringify({ packages: { "": {}, "node_modules/x": { version: "2.0.0" } } });
		const b = await dispatchS29(t, { files: { ".gitignore": "node_modules/\n", ...(state === "no-lock" ? {} : { "package-lock.json": lock }) } });
		const bin = join(b.home, "bin");
		mkdirSync(bin);
		const log = join(b.home, "npm-calls");
		writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> '${log}'\n${state === "failed" ? "echo EINTEGRITY >&2; exit 1" : "exit 0"}\n`, { mode: 0o700 });
		writeFileSync(join(bin, "git"), `#!/bin/sh\n/usr/bin/git "$@" || exit $?\ncase "$*" in\n"switch --no-track -c "*) ${state === "stale" || state === "current" ? `mkdir -p node_modules; printf '%s' '${JSON.stringify({ packages: { "node_modules/x": { version: state === "stale" ? "1.0.0" : "2.0.0" } } })}' > node_modules/.package-lock.json` : ":"};;\nesac\n`, { mode: 0o700 });
		const job = await b.ledger.create({ title: state, project: "demo", delivery: "local", kind: "ship" });
		const model = b.provider.addScript(`worker-${state}`, [{ kind: "text", text: "received" }]);
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect dependencies.", model, queue: false, when_ready: false } }] }], { PATH: `${bin}:${process.env.PATH}` });
		assert.notEqual(ends[0]?.isError, true, JSON.stringify(ends));
		const result = ends[0]?.result.details;
		assert.equal(result?.state, "dispatched");
		assert.equal(result?.receipt, "accepted");
		const expected = state === "stale" || state === "missing" ? "installed" : state === "no-lock" ? "skipped" : state;
		const event = readRunEvents(b.home, job.id).find((event) => event.type === "deps_prepared");
		assert.equal((event?.payload as { outcome?: string } | undefined)?.outcome, expected, `dependency outcome for ${state}`);
		if (["stale", "missing", "failed"].includes(state)) assert.equal(readFileSync(log, "utf8"), `${result?.worktree} ci\n`);
		else assert.equal(existsSync(log), false, "current and no-lock dispatches must not run npm");
		await waitFor(() => b.provider.requests(`worker-${state}`), (requests) => requests.length > 0);
		const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
		if (state === "failed") {
			assert.match(brief, /Dependencies in this worktree may be stale/);
			assert.match(brief, /EINTEGRITY/);
		} else assert.doesNotMatch(brief, /Dependencies in this worktree may be stale/);
	});
}

for (const skill of ["empty", "planner", "implementer", "pi-subagents", "pi-goal-x", "rpiv-ask-user-question", "unknown", "ambiguous"] as const) {
	test(`S31 skills: ${skill}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		for (const root of [b.agent.path, b.home]) {
			const dir = join(root, "skills", "dup"); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "---\ndescription: duplicate\n---\n");
		}
		for (const name of ["writing-plans", "pi-caveman", "tdd-x"]) {
			const dir = join(b.agent.path, "skills", name); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
		}
		const job = await b.ledger.create({ title: skill, project: "demo", delivery: "local", kind: skill === "planner" ? "research" : "ship" });
		const model = b.provider.addScript(`skill-${skill}`, [{ kind: "text", text: "received" }]);
		const names = skill === "empty" ? [] : skill === "planner" || skill === "implementer" ? ["writing-plans", "pi-caveman", "tdd-x"] : [skill === "ambiguous" ? "dup" : skill];
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, ...(names.length ? { skills: names } : {}), queue: false, when_ready: false } }] }]);
		if (["empty", "planner", "implementer"].includes(skill)) {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
			for (const name of names) assert.ok(brief.includes(join(b.agent.path, "skills", name, "SKILL.md")), name);
			const requests = await waitFor(() => b.provider.requests(`skill-${skill}`), (requests) => requests.length > 0);
			for (const name of names) assert.ok(JSON.stringify(requests[0]?.body).includes(join(b.agent.path, "skills", name)), name);
			if (skill === "planner") assert.match(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill === "implementer") assert.doesNotMatch(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill !== "empty") assert.match(brief, /No human answers inside a worker/);
		} else {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), skill === "ambiguous" ? /ambiguous/ : skill === "unknown" ? /not installed/ : skill === "rpiv-ask-user-question" ? /hangs a headless worker/ : /recursion guard/);
		}
	});
}

for (const state of ["json", "path-only", "foreign", "missing-executable"] as const) {
	test(`S31 leases: ${state} through dispatch and teardown`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const worktree = join(b.home, "external-lease");
		git(b.clone, "worktree", "add", "--quiet", worktree, "--detach");
		const foreign = createScratchRepo({ name: "foreign" }); t.after(() => foreign.cleanup());
		const printed = state === "foreign" ? foreign.path : worktree;
		const bin = join(b.home, "bin"); mkdirSync(bin);
		const log = join(b.home, "treehouse-calls");
		writeFileSync(join(bin, "treehouse"), state === "missing-executable" ? "#!/cp-missing-interpreter\n" : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in\nget) printf '%s\\n' '${state === "path-only" ? printed : JSON.stringify({ path: printed, lease_id: "identity-31" })}';;\nreturn) exit 0;;\nesac\n`, { mode: 0o700 });
		if (state === "missing-executable") {
			symlinkSync(process.execPath, join(bin, "node"));
			symlinkSync("/usr/bin/git", join(bin, "git"));
			symlinkSync(execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(), join(bin, "pi"));
		}
		const job = await b.ledger.create({ title: state, project: "demo", delivery: "local", kind: "ship" });
		const model = b.provider.addScript(`lease-${state}`, [{ kind: "text", text: "received" }]);
		const quote = `Force teardown ${job.id} and discard its unreported result.`;
		const calls: ScriptStep[] = [{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, queue: false, when_ready: false } }] }];
		if (state === "json" || state === "path-only") calls.push({ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id, force: true, operator_quote: quote } }] });
		const ends = await b.run(calls, { PATH: state === "missing-executable" ? bin : `${bin}:${process.env.PATH}` }, quote);
		if (state === "foreign" || state === "missing-executable") {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), state === "foreign" ? /belongs to another repo/ : /not on PATH.*no fallback/is);
			if (state === "foreign") assert.ok(readFileSync(log, "utf8").includes(`return --force --if-lease-id identity-31 ${printed}`));
		} else {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			assert.equal(ends[0]?.result.details?.worktree, printed);
			assert.notEqual(ends[1]?.isError, true, JSON.stringify(ends));
			assert.ok(readFileSync(log, "utf8").includes(`return --force ${state === "json" ? "--if-lease-id identity-31 " : ""}${printed}`));
		}
	});
}

for (const root of ["unset", "set", "relative"] as const) {
	test(`S31 lease pool: ${root}`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const explicit = join(b.home, "explicit-pool");
		const ambient = join(b.home, "ambient-pool");
		mkdirSync(explicit); mkdirSync(ambient);
		const job = await b.ledger.create({ title: root, project: "demo", delivery: "local", kind: "ship" });
		const model = b.provider.addScript(`root-${root}`, [{ kind: "text", text: "received" }]);
		const quote = `Force teardown ${job.id} and discard its unreported result.`;
		const calls: ScriptStep[] = [{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, queue: false, when_ready: false } }] }];
		if (root !== "relative") calls.push({ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id, force: true, operator_quote: quote } }] });
		const ends = await b.run(calls, { CP_TREEHOUSE_ROOT: root === "set" ? explicit : root === "relative" ? "relative-pool" : "", TREEHOUSE_ROOT: ambient }, quote);
		if (root === "relative") {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), /CP_TREEHOUSE_ROOT must be an absolute path/);
		} else {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			const worktree = String(ends[0]?.result.details?.worktree);
			if (root === "set") assert.ok(worktree.startsWith(explicit), "explicit home pool wins over ambient TREEHOUSE_ROOT");
			assert.notEqual(ends[1]?.isError, true, JSON.stringify(ends));
			assert.ok(existsSync(join(worktree, "README.md")), "return recycles the directory and its repository content");
			const args = root === "set" ? ["--root", explicit, "status"] : ["status"];
			const status = execFileSync("treehouse", args, { cwd: b.clone, encoding: "utf8", env: { ...process.env, TREEHOUSE_ROOT: ambient } });
			assert.doesNotMatch(status, /leased/, "returned pool has no held lease");
		}
	});
}
