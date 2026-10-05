/**
 * k52: the origin/main CI latch — every transition row, stale green on an old
 * sha, corrupt state, per-project scope and the tick's error/wake paths. `exec`
 * is always injected: nothing here touches a real git remote or GitHub.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Mandate } from "../src/contracts.ts";
import {
	checkMainCi,
	classifyMainTip,
	countedMainRuns,
	formatMainCiNotice,
	type MainCiObservation,
	MainCiStore,
	mainRedHold,
	mainRunsArgs,
	memoLogin,
	parseMainRuns,
	resolveMainCiScope,
	runMainCiTick,
} from "../src/main-ci.ts";
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
	attempt?: number;
	event?: string;
	triggeringActor?: string;
}
// cp-oc0m: every run is this machine's own push unless a test says otherwise.
const own = { event: "push", triggeringActor: "me" };
const green = (sha: string, id = 1, over: Partial<Run> = {}): Run => ({ status: "completed", conclusion: "success", headSha: sha, workflowName: "CI", databaseId: id, ...own, ...over });
const failed = (sha: string, id = 2, over: Partial<Run> = {}): Run => ({ status: "completed", conclusion: "failure", headSha: sha, workflowName: "CI", databaseId: id, ...own, ...over });
const running = (sha: string, id = 3, over: Partial<Run> = {}): Run => ({ status: "in_progress", conclusion: null, headSha: sha, workflowName: "Other", databaseId: id, ...own, ...over });

/** Only the fields `isActive` / `mandatedProjects` read. */
const mandate = (projects: string[], over: Partial<Pick<Mandate, "status" | "expiry">> = {}): Mandate => ({ status: "active", expiry: "2999-01-01T00:00:00.000Z", projects, ...over }) as Mandate;
const mandated = { mandates: () => [mandate(["demo"])], login: async () => "me" };

interface World {
	tip: string;
	runs: Run[] | string;
	fetchFails?: string;
	ghFails?: string;
	logFailed?: string;
	jobs?: unknown;
}

const RUNS_PREFIX = "gh api repos/{owner}/{repo}/actions/runs?branch=main&head_sha=";

function execFor(world: World, calls: string[] = []): CommandRunner {
	return async (command, args) => {
		const line = `${command} ${args.join(" ")}`;
		calls.push(line);
		if (line === "git fetch origin main") {
			if (world.fetchFails) throw new Error(world.fetchFails);
			return "";
		}
		if (line === "git rev-parse origin/main") return `${world.tip}\n`;
		if (line.startsWith(RUNS_PREFIX)) {
			assert.equal(args[1], `repos/{owner}/{repo}/actions/runs?branch=main&head_sha=${world.tip}&per_page=100`, "the query is scoped to the fetched tip");
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
	return checkMainCi({ project, cwd: ctx.clone, store: ctx.store, login: "me", exec: execFor(world) });
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
	ctx.store.setRed("demo", T1, { failing: "old", login: "me" });
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
	ctx.store.setRed("demo", T1, { login: "me" });
	assert.equal(await check(ctx, { tip: T2, runs: [green(T2), running(T2, 4)] }), undefined, "one workflow still running on the tip");
	const obs = await check(ctx, { tip: T2, runs: [green(T2), failed(T1)] });
	assert.equal(obs?.event, "main_ci_green");
	assert.equal(obs?.sha, T2);
	assert.equal(ctx.store.entry("demo"), undefined);
	assert.equal(await check(ctx, { tip: T2, runs: [green(T2)] }), undefined);
});

test("row 6: git or gh failures are inconclusive: latch unchanged, onError names the project", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1, { login: "me" });
	const before = readFileSync(ctx.store.file, "utf8");
	const worlds: World[] = [
		{ tip: T2, runs: [green(T2)], fetchFails: "fetch refused" },
		{ tip: "fatal: bad revision", runs: [green(T2)] },
		{ tip: T2, runs: [], ghFails: "gh boom" },
		{ tip: T2, runs: "not json" },
	];
	for (const world of worlds) {
		const errors: Array<[string | undefined, string]> = [];
		const out = await runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			...mandated,
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
		...mandated,
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
		mandates: () => [mandate(["ghost"])],
		login: async () => "me",
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
			...mandated,
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
	const base = {
		home: ctx.home,
		project: "demo",
		branch: "b",
		head: T2,
		ancestry: async () => true,
		runs: async () => ({ status: 0, stdout: JSON.stringify([green(T2)]) }),
		scope: async () => ({ enforce: true as const, login: "me" }),
	};
	assert.deepEqual(await mainRedHold(base), {});
	ctx.store.setRed("demo", T1, { failing: "structure", login: "me" });
	assert.match((await mainRedHold(base)).fact ?? "", /fix-forward/);
	assert.equal((await mainRedHold({ ...base, ancestry: async () => false })).hold, "main is red since 111111111111: structure; rebase onto origin/main and pass CI to merge");
	assert.ok((await mainRedHold({ ...base, runs: async () => ({ status: 0, stdout: "not json" }) })).hold);
	writeFileSync(ctx.store.file, "{not json");
	const open = await mainRedHold(base);
	assert.equal(open.hold, undefined);
	assert.match(open.fact ?? "", /main-ci\.json unreadable.*not blocking/);
});

// --- cp-oc0m: only this machine's own runs, only mandated projects ---

test("cp-oc0m: a dynamic run (Dependabot Updates) never latches and never blocks a green clear", async (t) => {
	const ctx = setup(t);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { event: "dynamic", triggeringActor: "dependabot[bot]" })] }), undefined);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { event: "dynamic" })] }), undefined, "dynamic is ignored even when triggered by this login");
	assert.equal(ctx.store.entry("demo"), undefined);
	ctx.store.setRed("demo", T1, { login: "me" });
	const obs = await check(ctx, { tip: T2, runs: [green(T2), failed(T2, 5, { event: "dynamic" }), running(T2, 6, { event: "dynamic" })] });
	assert.equal(obs?.event, "main_ci_green");
	assert.equal(ctx.store.entry("demo"), undefined);
});

test("cp-oc0m: another user's or a bot's run never latches and never blocks a green clear; the login match is case-insensitive", async (t) => {
	const ctx = setup(t);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { triggeringActor: "someone" })] }), undefined);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { triggeringActor: "dependabot[bot]" })] }), undefined);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { triggeringActor: undefined })] }), undefined, "no triggering actor never counts");
	assert.equal(ctx.store.entry("demo"), undefined);
	ctx.store.setRed("demo", T1, { login: "me" });
	assert.equal((await check(ctx, { tip: T2, runs: [green(T2), failed(T2, 5, { triggeringActor: "other" })] }))?.event, "main_ci_green");
	assert.equal((await check(ctx, { tip: T2, runs: [failed(T2, 2, { triggeringActor: "ME" })] }))?.event, "main_ci_failed");
	assert.equal(ctx.store.entry("demo")?.login, "me");
});

test("cp-oc0m: a re-run counts by its own triggering actor", async (t) => {
	const ctx = setup(t);
	assert.equal(await check(ctx, { tip: T1, runs: [failed(T1, 2, { attempt: 2, triggeringActor: "other" })] }), undefined, "own run re-run by another user");
	assert.equal((await check(ctx, { tip: T1, runs: [failed(T1, 2, { attempt: 2, triggeringActor: "me" })] }))?.event, "main_ci_failed", "foreign run re-run by this login");
});

test("cp-oc0m: without an active mandate the tick runs no command at all, not even the login", async (t) => {
	const ctx = setup(t);
	const now = "2026-06-01T00:00:00.000Z";
	const cases: Mandate[][] = [
		[],
		[mandate(["demo"], { status: "revoked" })],
		[mandate(["demo"], { status: "paused" })],
		[mandate(["demo"], { expiry: "2026-05-31T00:00:00.000Z" })],
		[mandate(["other"])],
	];
	for (const mandates of cases) {
		const calls: string[] = [];
		const out = await runMainCiTick({
			home: ctx.home,
			projects: ["demo"],
			pathOf: () => ctx.clone,
			mandates: () => mandates,
			now: () => now,
			login: async () => assert.fail("no login without a mandated project"),
			exec: execFor({ tip: T1, runs: [failed(T1)] }, calls),
			onError: () => assert.fail("no error"),
			notify: () => assert.fail("no notice"),
			send: () => assert.fail("no wake"),
		});
		assert.deepEqual(out, []);
		assert.deepEqual(calls, []);
	}
});

test("cp-oc0m: an unreadable login fails open — no command, file byte-identical, one onError", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1, { login: "me" });
	const before = readFileSync(ctx.store.file, "utf8");
	const calls: string[] = [];
	const errors: Array<[string | undefined, string]> = [];
	const out = await runMainCiTick({
		home: ctx.home,
		projects: ["demo"],
		pathOf: () => ctx.clone,
		mandates: () => [mandate(["demo"])],
		login: memoLogin(async () => {
			throw new Error("gh: not logged in");
		}, ctx.home),
		exec: execFor({ tip: T2, runs: [green(T2)] }, calls),
		onError: (project, message) => errors.push([project, message]),
		notify: () => assert.fail("no notice"),
		send: () => assert.fail("no wake"),
	});
	assert.deepEqual(out, []);
	assert.deepEqual(calls, []);
	assert.equal(errors.length, 1);
	assert.equal(errors[0]?.[0], undefined);
	assert.match(errors[0]?.[1] ?? "", /gh api user .*unreadable.*latches not enforced/);
	assert.equal(readFileSync(ctx.store.file, "utf8"), before);
});

test("cp-oc0m: a pre-change row is released on a mandated tick; a foreign row is replaced by an own red", async (t) => {
	const ctx = setup(t);
	ctx.store.setRed("demo", T1, { failing: "dependabot" });
	const sent: string[] = [];
	const out = await runMainCiTick({
		home: ctx.home,
		projects: ["demo"],
		pathOf: () => ctx.clone,
		...mandated,
		exec: execFor({ tip: T2, runs: [green(T2)] }),
		onError: () => assert.fail("no error"),
		notify: () => {},
		send: (_obs, text) => sent.push(text) > 0,
	});
	assert.equal(out.length, 1);
	assert.equal(out[0]?.event, "main_ci_released");
	assert.equal(out[0]?.sha, T1);
	assert.equal(ctx.store.entry("demo"), undefined);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /^MAIN CI LATCH RELEASED — demo: red since 111111111111 no longer counts \(latched before/);
	ctx.store.setRed("demo", T1, { login: "other" });
	const obs = await check(ctx, { tip: T2, runs: [failed(T2)] });
	assert.equal(obs?.event, "main_ci_failed");
	assert.equal(ctx.store.entry("demo")?.login, "me");
	assert.equal(ctx.store.entry("demo")?.red_since_sha, T2);
	ctx.store.setRed("demo", T1, { login: "other" });
	assert.equal(ctx.store.entry("demo")?.red_since_sha, T1, "setRed replaces a row for another login");
	assert.equal((await check(ctx, { tip: T2, runs: [running(T2)] }))?.event, "main_ci_released", "released even when the tip is inconclusive");
});

test("cp-oc0m: memoLogin asks gh once, retries after a failure, refuses a non-login", async () => {
	let calls = 0;
	const ok = memoLogin(async (command, args) => {
		calls += 1;
		assert.equal(`${command} ${args.join(" ")}`, "gh api user --jq .login");
		return "me\n";
	}, "/tmp");
	assert.equal(await ok(), "me");
	assert.equal(await ok(), "me");
	assert.equal(calls, 1);
	let attempts = 0;
	const flaky = memoLogin(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("timeout");
		return "me\n";
	}, "/tmp");
	await assert.rejects(flaky(), /gh api user --jq \.login unreadable: timeout/);
	assert.equal(await flaky(), "me");
	assert.equal(attempts, 2);
	await assert.rejects(memoLogin(async () => "not a login\n", "/tmp")(), /unreadable: answered "not a login", not a login/);
	assert.equal(await memoLogin(async () => "dependabot[bot]\n", "/tmp")(), "dependabot[bot]");
});

test("cp-oc0m: mainRedHold enforces only an own row under an enforced scope; no row never asks the scope", async (t) => {
	const ctx = setup(t);
	const base = {
		home: ctx.home,
		project: "demo",
		branch: "b",
		head: T2,
		ancestry: async () => false,
		runs: async () => ({ status: 0, stdout: "[]" }),
		scope: async () => ({ enforce: true as const, login: "me" }),
	};
	assert.deepEqual(await mainRedHold({ ...base, scope: async () => assert.fail("no scope without a row") }), {});
	ctx.store.setRed("demo", T1, { failing: "structure", login: "me" });
	const off = await mainRedHold({ ...base, scope: async () => ({ enforce: false as const, reason: "no active mandate covers demo" }) });
	assert.equal(off.hold, undefined);
	assert.match(off.fact ?? "", /not enforced — no active mandate covers demo; not blocking/);
	assert.equal((await mainRedHold(base)).hold, "main is red since 111111111111: structure; rebase onto origin/main and pass CI to merge");
	assert.ok((await mainRedHold({ ...base, scope: async () => ({ enforce: true as const, login: "ME" }) })).hold, "case-insensitive");
	ctx.store.setRed("demo", T1, { login: "other" });
	const foreign = await mainRedHold(base);
	assert.equal(foreign.hold, undefined);
	assert.match(foreign.fact ?? "", /latched for other, not me; not blocking/);
	ctx.store.clear("demo");
	ctx.store.setRed("demo", T1);
	assert.match((await mainRedHold(base)).fact ?? "", /latched before own-run filtering, not me; not blocking/);
});

test("cp-oc0m: resolveMainCiScope — active mandate and readable login enforce; anything else fails open", async () => {
	const now = "2026-06-01T00:00:00.000Z";
	const login = async () => "me";
	assert.deepEqual(await resolveMainCiScope({ project: "demo", mandates: () => [mandate(["demo"])], now, login }), { enforce: true, login: "me" });
	assert.deepEqual(await resolveMainCiScope({ project: "demo", mandates: () => [mandate(["demo"], { status: "paused" })], now, login }), { enforce: false, reason: "no active mandate covers demo" });
	const failing = await resolveMainCiScope({ project: "demo", mandates: () => [mandate(["demo"])], now, login: memoLogin(async () => "", "/tmp") });
	assert.equal(failing.enforce, false);
	const broken = await resolveMainCiScope({ project: "demo", mandates: () => assert.fail("mandates unreadable"), now, login });
	assert.equal(broken.enforce, false);
});

test("cp-oc0m: the REST query, its parser and the counted filter", () => {
	assert.deepEqual(mainRunsArgs(T1).slice(0, 3), ["api", `repos/{owner}/{repo}/actions/runs?branch=main&head_sha=${T1}&per_page=100`, "--jq"]);
	const runs = parseMainRuns(JSON.stringify([{ ...failed(T1), attempt: 2 }, { status: "completed", conclusion: "success" }, { ...green(T1), event: 7, triggeringActor: null }]));
	assert.equal(runs.length, 2, "a row without headSha is not a fact");
	assert.deepEqual(runs[0], { status: "completed", conclusion: "failure", headSha: T1, databaseId: 2, attempt: 2, workflowName: "CI", event: "push", triggeringActor: "me" });
	assert.equal(runs[1]?.event, undefined);
	assert.equal(runs[1]?.triggeringActor, undefined);
	assert.deepEqual(parseMainRuns(""), []);
	assert.deepEqual(parseMainRuns("{}"), []);
	assert.throws(() => parseMainRuns("not json"));
	assert.deepEqual(
		countedMainRuns([failed(T1, 1), failed(T1, 2, { event: "dynamic" }), failed(T1, 3, { triggeringActor: "Me" }), failed(T1, 4, { triggeringActor: "x" })], "me").map((run) => run.databaseId),
		[1, 3],
	);
});

test("formatMainCiNotice: released wording", () => {
	assert.equal(
		formatMainCiNotice({ project: "demo", event: "main_ci_released", sha: T1, reason: "latched for other, this machine is me" }),
		"MAIN CI LATCH RELEASED — demo: red since 111111111111 no longer counts (latched for other, this machine is me). Call cp_integrate for held demo PRs.",
	);
});
