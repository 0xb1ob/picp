/**
 * k52: the origin/main CI latch — every transition row, stale green on an old
 * sha, corrupt state, per-project scope and the tick's error/wake paths. `exec`
 * is always injected: nothing here touches a real git remote or GitHub.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkMainCi, classifyMainTip, formatMainCiNotice, type MainCiObservation, MainCiStore, mainRedHold, runMainCiTick } from "../src/main-ci.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { createScratchHome } from "./harness/index.ts";

const T1 = "1111111111111111111111111111111111111111";
const T2 = "2222222222222222222222222222222222222222";

interface Run {
	status: string;
	conclusion: string | null;
	headSha: string;
	workflowName?: string;
	databaseId?: number;
}
const green = (sha: string, id = 1): Run => ({ status: "completed", conclusion: "success", headSha: sha, workflowName: "CI", databaseId: id });
const failed = (sha: string, id = 2): Run => ({ status: "completed", conclusion: "failure", headSha: sha, workflowName: "CI", databaseId: id });
const running = (sha: string, id = 3): Run => ({ status: "in_progress", conclusion: null, headSha: sha, workflowName: "Other", databaseId: id });

interface World {
	tip: string;
	runs: Run[] | string;
	fetchFails?: string;
	ghFails?: string;
	logFailed?: string;
	jobs?: unknown;
}

function execFor(world: World, calls: string[] = []): CommandRunner {
	return async (command, args) => {
		const line = `${command} ${args.join(" ")}`;
		calls.push(line);
		if (line === "git fetch origin main") {
			if (world.fetchFails) throw new Error(world.fetchFails);
			return "";
		}
		if (line === "git rev-parse origin/main") return `${world.tip}\n`;
		if (line.startsWith("gh run list --branch main")) {
			if (world.ghFails) throw new Error(world.ghFails);
			return typeof world.runs === "string" ? world.runs : JSON.stringify(world.runs);
		}
		if (line.endsWith("--log-failed")) return world.logFailed ?? "";
		if (line.endsWith("--json jobs")) return JSON.stringify(world.jobs ?? { jobs: [] });
		throw new Error(`unexpected command: ${line}`);
	};
}

function setup(t: { after(fn: () => void): void }) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const clone = join(home.path, "clone");
	mkdirSync(clone, { recursive: true });
	return { home: home.path, clone, store: new MainCiStore({ home: home.path }) };
}

async function check(ctx: ReturnType<typeof setup>, world: World, project = "demo"): Promise<MainCiObservation | undefined> {
	return checkMainCi({ project, cwd: ctx.clone, store: ctx.store, exec: execFor(world) });
}

test("row 1: a failure on the fetched tip latches once, naming the sha, workflow and failing test line", async (t) => {
	const ctx = setup(t);
	const obs = await check(ctx, { tip: T1, runs: [failed(T1)], logFailed: "tests\tstep\t2026-01-01T00:00:00Z AssertionError: cap 1665 > 1660\n" });
	assert.equal(obs?.event, "main_ci_failed");
	assert.equal(obs?.sha, T1);
	assert.equal(obs?.workflow, "CI");
	assert.equal(obs?.failing, "AssertionError: cap 1665 > 1660");
	assert.equal(ctx.store.entry("demo")?.red_since_sha, T1);
	assert.equal(ctx.store.entry("demo")?.failing, "AssertionError: cap 1665 > 1660");
});

test("row 1: no matching log line falls back to the failing job name", async (t) => {
	const ctx = setup(t);
	const obs = await check(ctx, { tip: T1, runs: [failed(T1)], logFailed: "nothing useful", jobs: { jobs: [{ name: "ok", conclusion: "success" }, { name: "structure checks", conclusion: "failure" }] } });
	assert.equal(obs?.failing, "structure checks");
});

test("row 1: a failure fires at once even while another workflow on the tip is still running", async (t) => {
	const ctx = setup(t);
	const obs = await check(ctx, { tip: T1, runs: [running(T1), failed(T1)] });
	assert.equal(obs?.event, "main_ci_failed");
});

test("row 2: nothing latched, and green / pending / no run on the tip emits nothing", async (t) => {
	const ctx = setup(t);
	for (const runs of [[green(T1)], [running(T1)], [], [failed(T2)]]) assert.equal(await check(ctx, { tip: T1, runs }), undefined);
	assert.equal(ctx.store.entry("demo"), undefined);
});

test("row 3: a repeat red, or red on a new tip, emits nothing and keeps red_since byte-identical", async (t) => {
	const ctx = setup(t);
	await check(ctx, { tip: T1, runs: [failed(T1)] });
	const before = readFileSync(ctx.store.file, "utf8");
	const row = ctx.store.entry("demo");
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1)] }), undefined);
	assert.equal(await check(ctx, { tip: T2, runs: [failed(T2), failed(T1)] }), undefined);
	assert.equal(readFileSync(ctx.store.file, "utf8"), before);
	assert.deepEqual(ctx.store.entry("demo"), row);
	assert.equal(row?.red_since_sha, T1);
});

test("row 5: stale green on an old sha never clears the latch", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1, { failing: "old" });
	const before = readFileSync(ctx.store.file, "utf8");
	// origin/main is T2 now; T1 (the latched sha) goes green.
	assert.equal(await check(ctx, { tip: T2, runs: [green(T1)] }), undefined);
	assert.equal(await check(ctx, { tip: T2, runs: [green(T1), running(T2)] }), undefined);
	// runs[0] is a green re-run on T1 while the tip T2 has a failure.
	assert.equal(await check(ctx, { tip: T2, runs: [green(T1, 9), failed(T2)] }), undefined);
	assert.equal(readFileSync(ctx.store.file, "utf8"), before);
	assert.equal(ctx.store.entry("demo")?.red_since_sha, T1);
});

test("row 4: green on every run for the current tip clears once with one main_ci_green", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1);
	assert.equal(await check(ctx, { tip: T2, runs: [green(T2), running(T2, 4)] }), undefined, "one workflow still running on the tip");
	const obs = await check(ctx, { tip: T2, runs: [green(T2), failed(T1)] });
	assert.equal(obs?.event, "main_ci_green");
	assert.equal(obs?.sha, T2);
	assert.equal(ctx.store.entry("demo"), undefined);
	assert.equal(await check(ctx, { tip: T2, runs: [green(T2)] }), undefined);
});

test("row 6: git or gh failures are inconclusive: latch unchanged, onError names the project", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1);
	const before = readFileSync(ctx.store.file, "utf8");
	const worlds: World[] = [
		{ tip: T2, runs: [green(T2)], fetchFails: "fetch refused" },
		{ tip: "fatal: bad revision", runs: [green(T2)] },
		{ tip: T2, runs: [], ghFails: "gh boom" },
		{ tip: T2, runs: "not json" },
	];
	for (const world of worlds) {
		const errors: Array<[string, string]> = [];
		const out = await runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			exec: execFor(world),
			onError: (project, message) => errors.push([project, message]),
			notify: () => assert.fail("no notice"),
			send: () => assert.fail("no wake"),
		});
		assert.deepEqual(out, []);
		assert.equal(errors.length, 1);
		assert.equal(errors[0]?.[0], "demo");
	}
	assert.equal(readFileSync(ctx.store.file, "utf8"), before);
});

test("row 7: an unreadable main-ci.json is never overwritten and is reported", async (t) => {
	const ctx = setup(t);
	mkdirSync(join(ctx.store.file, ".."), { recursive: true });
	writeFileSync(ctx.store.file, "{not json");
	const errors: string[] = [];
	const out = await runMainCiTick({
		home: ctx.home,
		projects: ["demo"],
		pathOf: () => ctx.clone,
		exec: execFor({ tip: T1, runs: [failed(T1)] }),
		onError: (_project, message) => errors.push(message),
		notify: () => assert.fail("no notice"),
		send: () => assert.fail("no wake"),
	});
	assert.deepEqual(out, []);
	assert.equal(readFileSync(ctx.store.file, "utf8"), "{not json");
	assert.match(errors[0] ?? "", /main-ci\.json/);
	assert.throws(() => ctx.store.setRed("demo", T1), /not overwritten/);
	assert.throws(() => ctx.store.clear("demo"), /not overwritten/);
});

test("per project: one project's latch is independent of another's", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("a", T1, { failing: "a broke" });
	const a = ctx.store.entry("a");
	assert.equal(await check(ctx, { tip: T2, runs: [green(T2)] }, "b"), undefined);
	assert.equal((await check(ctx, { tip: T2, runs: [failed(T2)] }, "b"))?.event, "main_ci_failed");
	assert.deepEqual(ctx.store.entry("a"), a);
	assert.equal(ctx.store.entry("b")?.red_since_sha, T2);
});

test("row 8: a project with no clone dir is skipped without any command", async (t) => {
	const ctx = setup(t);
	const calls: string[] = [];
	const out = await runMainCiTick({
		home: ctx.home,
		projects: ["ghost"],
		pathOf: () => join(ctx.home, "no-such-clone"),
		exec: execFor({ tip: T1, runs: [failed(T1)] }, calls),
		onError: () => assert.fail("no error"),
		notify: () => assert.fail("no notice"),
		send: () => assert.fail("no wake"),
	});
	assert.deepEqual(out, []);
	assert.deepEqual(calls, []);
});

test("tick: one red transition sends exactly one wake; a refused send is reported", async (t) => {
	const ctx = setup(t);
	const sent: string[] = [];
	const errors: string[] = [];
	const tick = (send: boolean) =>
		runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			exec: execFor({ tip: T1, runs: [failed(T1)] }),
			onError: (_project, message) => errors.push(message),
			notify: () => {},
			send: (_obs, text) => {
				sent.push(text);
				return send;
			},
		});
	await tick(true);
	await tick(true);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /MAIN IS RED — demo: CI failed on 111111111111/);
	assert.deepEqual(errors, []);
	ctx.store.clear("demo");
	await tick(false);
	assert.match(errors[0] ?? "", /not sent/);
});

test("formatMainCiNotice: red and green wording", () => {
	const red = formatMainCiNotice({ project: "demo", event: "main_ci_failed", sha: T1, reason: "CI failed", workflow: "CI", failing: "AssertionError: x" });
	assert.match(red, /^MAIN IS RED — demo: CI failed on 111111111111 \(CI\) — failing: AssertionError: x/);
	assert.match(red, /cp_integrate returns wait for every demo PR except one based on the current main with green CI/);
	assert.equal(formatMainCiNotice({ project: "demo", event: "main_ci_green", sha: T2, reason: "ok" }), "MAIN IS GREEN AGAIN — demo: CI passed on 222222222222. Call cp_integrate for held demo PRs.");
});

test("classifyMainTip ignores every run not on the tip", () => {
	assert.equal(classifyMainTip(T2, [green(T1), failed(T1)]).status, "unknown");
	assert.equal(classifyMainTip(T2, [failed(T1), green(T2)]).status, "green");
});

test("mainRedHold: fails open with a fact on unreadable state, holds a latched project", async (t) => {
	const ctx = setup(t);
	const base = { home: ctx.home, project: "demo", branch: "b", head: T2, ancestry: async () => true, runs: async () => ({ status: 0, stdout: JSON.stringify([green(T2)]) }) };
	assert.deepEqual(await mainRedHold(base), {});
	ctx.store.setRed("demo", T1, { failing: "structure" });
	assert.match((await mainRedHold(base)).fact ?? "", /fix-forward/);
	assert.equal((await mainRedHold({ ...base, ancestry: async () => false })).hold, "main is red since 111111111111: structure; rebase onto origin/main and pass CI to merge");
	assert.ok((await mainRedHold({ ...base, runs: async () => ({ status: 0, stdout: "not json" }) })).hold);
	writeFileSync(ctx.store.file, "{not json");
	const open = await mainRedHold(base);
	assert.equal(open.hold, undefined);
	assert.match(open.fact ?? "", /main-ci\.json unreadable.*not blocking/);
});
