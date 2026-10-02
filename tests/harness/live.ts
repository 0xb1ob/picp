/**
 * Live-suite scaffolding (T29). **Operator-run only** — nothing here executes
 * unless `CP_LIVE_TESTS=1`.
 *
 * The live suite spends real money on a real model, so this module exists to
 * make each scenario's *setup* uniform and its *cost* visible: one home, one
 * scratch project with a bare remote, one treehouse pool, one jobs ledger, and
 * a budget ledger that every scenario reports into. A live run that cannot say
 * what it spent is not a test, it is a bill.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandPost, type CommandPostOptions } from "../../src/command-post.ts";
import { paths, type RunStatus, validateRunStatus } from "../../src/contracts.ts";
import { readStatusFile } from "../../src/run-artifacts.ts";
import { initJobsDocument } from "../../src/ledger.ts";
import { createScratchHome, type ScratchHome } from "./state.ts";
import { createScratchRepo, type ScratchRepo } from "./scratch-repo.ts";
import { enableTreehouse, type TreehousePool, treehouseAvailable } from "./treehouse.ts";
import { REPO_ROOT } from "./pi-child.ts";

export const LIVE_TESTS_ENABLED = process.env.CP_LIVE_TESTS === "1";

/** Cheap by default: the suite proves plumbing, not model quality. */
export const LIVE_MODEL = process.env.CP_LIVE_MODEL ?? "anthropic/claude-haiku-4-5";

/**
 * Per-job ceiling. Breaching it fails the scenario rather than the wallet.
 *
 * Measured, not guessed (first live runs, haiku-4-5, tokens are cumulative per
 * job): a one-file ship job 26-31k, an implementer working from an artifact
 * 39-66k, a promoted `delivery:pr` fix 52-76k, a research job 43-78k for its
 * first report and **~94k once it takes the gate's revise round trip** — the
 * most expensive legitimate job in the suite.
 *
 * The ceiling exists to catch a runaway, so it sits above that spread with room
 * to spare. 60k and then 90k both sat *inside* it, and a budget that fails on
 * the work it is measuring is the one thing a budget must not do.
 */
export const LIVE_JOB_BUDGET = Number(process.env.CP_LIVE_TOKEN_BUDGET ?? 140_000);

/** Whole-suite ceiling, checked as scenarios report in. */
export const LIVE_TOTAL_BUDGET = Number(process.env.CP_LIVE_TOTAL_BUDGET ?? 600_000);

/**
 * Skip reason for a live test, or `false` to run it. Every live test states its
 * own requirements: `CP_LIVE_TESTS=1`, plus `treehouse` for anything that
 * takes a lease.
 */
export function liveSkip(options: { needsLedger?: boolean } = {}): string | false {
	if (!LIVE_TESTS_ENABLED) return "set CP_LIVE_TESTS=1 to run the live suite (operator-run only)";
	if (options.needsLedger !== false && !treehouseAvailable()) {
		return "treehouse must be installed";
	}
	return false;
}

// ---------------------------------------------------------------------------
// Budget ledger
// ---------------------------------------------------------------------------

export interface Spend {
	scenario: string;
	job_id: string;
	turns: number;
	tools: number;
	tokens: number;
	cost_usd: number;
}

const spends: Spend[] = [];

/**
 * Record and check one job's spend. Fails the scenario when a single job
 * breaches `LIVE_JOB_BUDGET` or when the suite total breaches
 * `LIVE_TOTAL_BUDGET` — a budget nobody asserts is a wish.
 */
export function recordSpend(scenario: string, home: string, jobId: string, options: { statusFile?: string } = {}): Spend {
	const status = options.statusFile ? readStatusAt(options.statusFile) : readStatusFile(home, jobId);
	const spend: Spend = {
		scenario,
		job_id: jobId,
		turns: status?.turns ?? 0,
		tools: status?.tool_calls ?? 0,
		tokens: status?.usage.total_tokens ?? 0,
		cost_usd: status?.usage.cost_usd ?? 0,
	};
	spends.push(spend);
	console.log(
		`[live ${scenario}] ${jobId} turns=${spend.turns} tools=${spend.tools} tokens=${spend.tokens} cost=$${spend.cost_usd.toFixed(4)} (job budget ${LIVE_JOB_BUDGET}, suite ${totalTokens()}/${LIVE_TOTAL_BUDGET})`,
	);
	assert.ok(
		spend.tokens <= LIVE_JOB_BUDGET,
		`${scenario}/${jobId} exceeded the per-job budget: ${spend.tokens} > ${LIVE_JOB_BUDGET} tokens`,
	);
	assert.ok(
		totalTokens() <= LIVE_TOTAL_BUDGET,
		`the live suite exceeded its total budget: ${totalTokens()} > ${LIVE_TOTAL_BUDGET} tokens`,
	);
	return spend;
}

/**
 * One gate attempt's spend. The reviewer is a worker of its own with its own
 * run dir (`state/runs/<job-id>/gate-<n>/status.json`); reading the *job's*
 * status.json for a gate — as this harness first did — reports the planner's
 * spend twice and the reviewer's not at all.
 */
export function recordGateSpend(scenario: string, home: string, jobId: string, attempt: number): Spend {
	return recordSpend(scenario, home, jobId, {
		statusFile: join(home, paths.gateRunDir(jobId, attempt), "status.json"),
	});
}

function readStatusAt(file: string): RunStatus | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const result = validateRunStatus(JSON.parse(readFileSync(file, "utf8")));
		return result.ok ? result.value : undefined;
	} catch {
		return undefined;
	}
}

export function totalTokens(): number {
	return spends.reduce((total, spend) => total + spend.tokens, 0);
}

export function totalCost(): number {
	return spends.reduce((total, spend) => total + spend.cost_usd, 0);
}

export function spendReport(): string {
	if (spends.length === 0) return "[live] nothing ran";
	const rows = spends.map(
		(spend) => `  ${spend.scenario.padEnd(28)} ${spend.job_id.padEnd(24)} ${String(spend.tokens).padStart(7)} tok  $${spend.cost_usd.toFixed(4)}`,
	);
	return [
		`[live] ${spends.length} job(s), ${totalTokens()} tokens, $${totalCost().toFixed(4)} total (model ${LIVE_MODEL})`,
		...rows,
	].join("\n");
}

/** A worker that is still burning tokens when we stop watching is a runaway. */
export function assertUnderJobBudget(home: string, jobId: string, what: string): void {
	const tokens = readStatusFile(home, jobId)?.usage.total_tokens ?? 0;
	assert.ok(tokens <= LIVE_JOB_BUDGET, `${what}: ${jobId} is over budget (${tokens} > ${LIVE_JOB_BUDGET}) — stopping`);
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export interface LiveFixtureOptions {
	/** Files for the scratch project. Defaults to a README and a version file. */
	files?: Record<string, string>;
	/** Treehouse pool size; one per concurrent lease the scenario takes. */
	maxTrees?: number;
	authorizer?: CommandPostOptions["authorizer"];
	/** Stands in for the human a planner asks (T31). Absent = nobody attached. */
	asker?: CommandPostOptions["asker"];
	/** Project name; also the br `project:` label and the clone directory. */
	project?: string;
}

export interface LiveFixture {
	home: ScratchHome;
	repo: ScratchRepo;
	pool: TreehousePool;
	post: CommandPost;
	project: string;
	clone: string;
	/** Tear everything down: workers first, then the pool, then the temp dirs. */
	cleanup(): Promise<void>;
}

/**
 * A home with a registered project, its canonical clone, a treehouse pool and an
 * initialised br workspace — the state a real command post is in before its
 * first dispatch.
 */
export async function createLiveFixture(options: LiveFixtureOptions = {}): Promise<LiveFixture> {
	const project = options.project ?? "demo";
	const home = createScratchHome();
	const repo = createScratchRepo({
		name: project,
		files: options.files ?? { "README.md": "# live suite\n", "src/version.txt": "1\n" },
	});
	initJobsDocument(home.path, "cp");

	const post = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		...(options.authorizer ? { authorizer: options.authorizer } : {}),
		...(options.asker ? { asker: options.asker } : {}),
	});
	await post.registry.register({ name: project, clone_url: repo.remote as string, delivery: "local" });
	const clone = post.registry.pathOf(project);
	execFileSync("git", ["clone", "--quiet", repo.remote as string, clone]);
	// House rule (tests/e2e/README.md): every suite that leases must point the
	// pool at a temp dir, or it leaks worktrees into the operator's ~/.treehouse.
	const pool = enableTreehouse(clone, { maxTrees: options.maxTrees ?? 2 });

	return {
		home,
		repo,
		pool,
		post,
		project,
		clone,
		async cleanup() {
			await post.shutdown();
			pool.cleanup();
			repo.cleanup();
			home.cleanup();
		},
	};
}

/** The branch a job pushed, as the bare remote sees it. */
export function remoteHas(fixture: LiveFixture, branch: string): boolean {
	const out = execFileSync("git", ["ls-remote", "--heads", "origin", branch], {
		cwd: fixture.clone,
		encoding: "utf8",
	});
	return out.trim().length > 0;
}

/** A PR url the *test* supplies (see the README): never one a model invented. */
export function fakePrUrl(project: string, jobId: string): string {
	return `https://github.com/pi-command-post-live/${project}/pull/${jobId.replace(/[^0-9]/g, "").slice(0, 4) || "1"}`;
}

export { join };
