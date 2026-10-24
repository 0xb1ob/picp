import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../../src/command-post.ts";
import { DEFAULT_ORIGIN, EMPTY_USAGE, isoTimestamp, paths } from "../../src/contracts.ts";
import { dispatchS29 } from "../harness/dispatch-s29.ts";
import { COMMAND_POST_EXTENSION, createScratchHome, createScratchLedger, createScratchRepo, enableTreehouse, git, readFleet, readRunEvents, REPO_ROOT, type ScriptStep, startPiChild, waitFor } from "../harness/index.ts";

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
		if (["stale", "missing", "failed"].includes(state)) {
			assert.ok(existsSync(log), `npm ci must execute for ${state}`);
			assert.equal(readFileSync(log, "utf8"), `${result?.worktree} ci\n`);
		}
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
		for (const name of ["writing-plans", "pi-caveman", "tdd-x", "pi-subagents", "pi-goal-x", "rpiv-ask-user-question"]) {
			const dir = join(b.agent.path, "skills", name); mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
		}
		const job = await b.ledger.create({ title: skill, project: "demo", delivery: "local", kind: skill === "planner" ? "research" : "ship" });
		const model = b.provider.addScript(`skill-${skill}`, [{ kind: "text", text: "received" }]);
		const names = skill === "empty" ? [] : skill === "planner" || skill === "implementer" ? ["writing-plans", "pi-caveman", "tdd-x"] : [skill === "ambiguous" ? "dup" : skill];
		const ends = await b.run([{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, ...(names.length ? { skills: names } : {}), queue: false, when_ready: false } }] }]);
		if (["empty", "planner", "implementer"].includes(skill)) {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			assert.deepEqual(readFleet(b.home).jobs[0]?.skills?.map((entry) => entry.name) ?? [], names, "resolved skills persist in fleet");
			const brief = readFileSync(join(b.home, paths.briefFile(job.id)), "utf8");
			for (const name of names) assert.ok(brief.includes(join(b.agent.path, "skills", name, "SKILL.md")), name);
			const requests = await waitFor(() => b.provider.requests(`skill-${skill}`), (requests) => requests.length > 0);
			const system = JSON.stringify(requests[0]?.body.messages?.filter((message) => message.role === "system"));
			for (const name of names) assert.ok(system.includes(join(b.agent.path, "skills", name)), `spawn loads ${name} into the system skill catalog`);
			if (skill === "planner") assert.match(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill === "implementer") assert.doesNotMatch(brief, /`pi-caveman` was attached by explicit operator mention/);
			if (skill !== "empty") assert.match(brief, /No human answers inside a worker/);
			if (skill !== "empty") {
				assert.match(brief, /`writing-plans` was attached by explicit operator mention/);
				assert.doesNotMatch(brief, /`tdd-x` was attached by explicit operator mention/);
				assert.match(brief, /a skill grants no new tools, scope or authority/);
			}
		} else {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), skill === "ambiguous" ? /ambiguous/ : skill === "unknown" ? /not installed/ : skill === "rpiv-ask-user-question" ? /hangs a headless worker/ : /recursion guard/);
		}
	});
}

for (const state of ["json", "path-only", "alias", "malformed", "nopath", "foreign", "missing-executable"] as const) {
	test(`S31 leases: ${state} through dispatch and teardown`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const worktree = join(b.home, "external-lease");
		git(b.clone, "worktree", "add", "--quiet", worktree, "--detach");
		const foreign = createScratchRepo({ name: "foreign" }); t.after(() => foreign.cleanup());
		const printed = state === "foreign" ? foreign.path : state === "alias" ? join(b.home, "printed-alias") : worktree;
		if (state === "alias") symlinkSync(worktree, printed);
		const bin = join(b.home, "bin"); mkdirSync(bin);
		const log = join(b.home, "treehouse-calls");
		const output = state === "path-only" ? printed : state === "malformed" ? "{ not json }" : state === "nopath" ? "no path here" : JSON.stringify({ path: printed, lease_id: "identity-31" });
		writeFileSync(join(bin, "treehouse"), state === "missing-executable" ? "#!/cp-missing-interpreter\n" : `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in\nget) printf '%s\\n' '${output}';;\nreturn) exit 0;;\nesac\n`, { mode: 0o700 });
		if (state === "missing-executable") {
			symlinkSync(process.execPath, join(bin, "node"));
			symlinkSync("/usr/bin/git", join(bin, "git"));
			symlinkSync(execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(), join(bin, "pi"));
		}
		const job = await b.ledger.create({ title: state, project: "demo", delivery: "local", kind: "ship" });
		const model = b.provider.addScript(`lease-${state}`, [{ kind: "text", text: "received" }]);
		const quote = `Force teardown ${job.id} and discard its unreported result.`;
		const calls: ScriptStep[] = [{ kind: "tool_calls", calls: [{ name: "cp_dispatch", args: { job_id: job.id, task: "Inspect fixture.", model, queue: false, when_ready: false } }] }];
		if (["json", "path-only", "alias"].includes(state)) calls.push({ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id, force: true, operator_quote: quote } }] });
		const ends = await b.run(calls, { PATH: state === "missing-executable" ? bin : `${bin}:${process.env.PATH}` }, quote);
		if (!["json", "path-only", "alias"].includes(state)) {
			assert.equal(ends[0]?.isError, true, JSON.stringify(ends));
			assert.match(JSON.stringify(ends[0]?.result), state === "foreign" ? /belongs to another repo/ : state === "missing-executable" ? /not on PATH.*no fallback/is : /printed no path/);
			if (state === "foreign") assert.ok(readFileSync(log, "utf8").includes(`return --force --if-lease-id identity-31 ${printed}`));
		} else {
			assert.equal(ends[0]?.result.details?.receipt, "accepted", JSON.stringify(ends));
			assert.equal(ends[0]?.result.details?.worktree, printed);
			assert.notEqual(ends[1]?.isError, true, JSON.stringify(ends));
			assert.ok(readFileSync(log, "utf8").includes(`return --force ${state !== "path-only" ? "--if-lease-id identity-31 " : ""}${printed}`));
			if (state === "alias") assert.notEqual(printed, realpathSync(printed), "fixture distinguishes printed path from realpath");
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

for (const path of ["relative", "home", "cwd"] as const) {
	test(`S31 legacy teardown refuses ${path} lease paths`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
		const job = await b.ledger.create({ title: path, project: "demo", delivery: "local", kind: "ship" });
		const worktree = path === "relative" ? "relative/lease" : path === "home" ? b.home : join(b.home, "legacy-cwd");
		if (path === "cwd") mkdirSync(worktree);
		const at = isoTimestamp();
		await post.fleet.add({ job_id: job.id, project: "demo", kind: "ship", delivery: "local", origin: DEFAULT_ORIGIN, phase: "failed", failure: { class: "crash", message: "legacy exit", at }, worktree, branch: job.id, dispatched_at: at, usage: EMPTY_USAGE, worker: { pid: 2147483647, session_id: "legacy", session_file: join(b.home, "legacy.jsonl"), profile: "implementer", role: "implementer", model: "mock/legacy", started_at: at, exited_at: at, exit_code: 1 } });
		if (path === "cwd") {
			const model = b.provider.addScript("legacy-cwd-parent", [{ kind: "tool_calls", calls: [{ name: "cp_teardown", args: { job_id: job.id, force: true, operator_quote: "Force close this legacy fixture." } }] }, { kind: "text", text: "observed" }]);
			b.agent.writeModels(b.provider);
			const child = startPiChild({ cwd: worktree, model, env: { ...b.agent.env, CP_HOME: b.home }, extensions: [COMMAND_POST_EXTENSION] });
			t.after(() => child.close());
			await child.prompt("Force close this legacy fixture."); await child.waitForSettled(60_000);
			assert.match(JSON.stringify(child.eventsOfType("tool_execution_end")), /current directory .* is inside it/);
		} else {
			await assert.rejects(post.tearDown(job.id, { force: true }), path === "relative" ? /lease path must be absolute/ : /command post home .* is inside it/);
		}
	});
}

test("S31 stale lease identity cannot return a recycled slot", { timeout: 120_000 }, async (t) => {
	const b = await dispatchS29(t);
	const post = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
	const job = await b.ledger.create({ title: "fence", project: "demo", delivery: "local", kind: "ship" });
	const model = b.provider.addScript("fenced-worker", [{ kind: "text", text: "received" }]); b.agent.writeModels(b.provider);
	const result = await post.dispatch({ jobId: job.id, task: "Inspect fixture.", model, fetch: false });
	assert.equal(result.state, "dispatched"); if (result.state !== "dispatched") return;
	const old = post.fleet.get(job.id)!;
	await post.manager.shutdown(job.id);
	execFileSync("treehouse", ["return", "--force", "--if-lease-id", old.lease_id!, result.worktree], { cwd: b.home });
	const fresh = JSON.parse(execFileSync("treehouse", ["get", "--lease", "--json", "--lease-holder", "cp-new-holder"], { cwd: b.clone, encoding: "utf8" })) as { path: string; lease_id: string };
	try {
	assert.equal(fresh.path, result.worktree, "fixture reuses the same slot");
	assert.notEqual(fresh.lease_id, old.lease_id);
	const refused = await post.tearDown(job.id, { force: true });
	assert.equal(refused.torn_down, false);
	assert.equal(refused.lease_returned, false);
	assert.equal(refused.failure?.code, "lease_return_failed");
	assert.match(execFileSync("treehouse", ["status"], { cwd: b.clone, encoding: "utf8" }), /leased/);
	} finally {
		execFileSync("treehouse", ["return", "--force", "--if-lease-id", fresh.lease_id, fresh.path], { cwd: b.home });
	}
});

for (const isolation of ["shared", "distinct"] as const) {
	test(`S31 two homes: ${isolation} pools`, { timeout: 120_000 }, async (t) => {
		const b = await dispatchS29(t);
		const other = createScratchHome();
		const ledger = createScratchLedger({ home: other.path, knownProjects: ["demo"] });
		const a = join(b.home, "pool-a"); const z = join(b.home, "pool-b"); mkdirSync(a); mkdirSync(z);
		const previous = process.env.CP_TREEHOUSE_ROOT;
		let first: CommandPost | undefined; let second: CommandPost | undefined;
		let pool: ReturnType<typeof enableTreehouse> | undefined;
		try {
			process.env.CP_TREEHOUSE_ROOT = a;
			first = b.ownPost(new CommandPost({ home: b.home, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } }));
			process.env.CP_TREEHOUSE_ROOT = isolation === "shared" ? a : z;
			second = new CommandPost({ home: other.path, packageRoot: REPO_ROOT, parentEnv: { ...process.env, ...b.agent.env } });
			await second.registry.register({ name: "demo", clone_url: first.registry.require("demo").clone_url, delivery: "local" });
			const clone = second.registry.pathOf("demo");
			execFileSync("git", ["clone", "--quiet", first.registry.require("demo").clone_url, clone]); pool = enableTreehouse(clone);
			const j1 = await b.ledger.create({ title: "home-a", project: "demo", delivery: "local", kind: "ship" });
			const j2 = await ledger.ledger.create({ title: "home-b", project: "demo", delivery: "local", kind: "ship" });
			const m1 = b.provider.addScript("home-a", [{ kind: "text", text: "received" }]);
			const m2 = b.provider.addScript("home-b", [{ kind: "text", text: "received" }]); b.agent.writeModels(b.provider);
			const r1 = await first.dispatch({ jobId: j1.id, task: "Inspect.", model: m1, fetch: false });
			const r2 = await second.dispatch({ jobId: j2.id, task: "Inspect.", model: m2, fetch: false });
			assert.equal(r1.state, "dispatched"); assert.equal(r2.state, "dispatched");
			if (r1.state !== "dispatched" || r2.state !== "dispatched") return;
			const p1 = dirname(dirname(realpathSync(r1.worktree))); const p2 = dirname(dirname(realpathSync(r2.worktree)));
			if (isolation === "shared") assert.equal(p1, p2, "same remote and basename share one pool");
			else {
				assert.notEqual(p1, p2, "distinct home roots isolate pools");
				assert.ok(r1.worktree.startsWith(a)); assert.ok(r2.worktree.startsWith(z));
				assert.equal(realpathSync(git(r1.worktree, "rev-parse", "--git-common-dir")), realpathSync(join(b.clone, ".git")));
				assert.equal(realpathSync(git(r2.worktree, "rev-parse", "--git-common-dir")), realpathSync(join(clone, ".git")));
			}
		} finally {
			if (previous === undefined) delete process.env.CP_TREEHOUSE_ROOT; else process.env.CP_TREEHOUSE_ROOT = previous;
			await second?.shutdown(); pool?.cleanup(); ledger.cleanup(); other.cleanup();
		}
	});
}
