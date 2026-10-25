/**
 * The Actions REST transport: workflow runs for one exact head plus each run attempt's jobs, the only CI evidence.
 * Fail closed: a denied, malformed, partial, capped or late read throws `ActionsCiError`, never a shorter green list.
 * Requests are built from validated ids only; URLs inside a response (jobs_url, check_runs_url …) are never followed.
 */
import type { CiRun, CommandRunner } from "./merge-ask.ts";
import type { CommandRunner as StatusRunner } from "./merges.ts";

/** Total budget for one observation (every page of runs and jobs); a time budget, not a GitHub call quota. */
export const ACTIONS_CI_TIMEOUT_MS = 30_000;
/** One jobs-page `gh` call's own cap: a hung call must not spend the whole budget and leave no room to retry (#420). */
export const ACTIONS_ATTEMPT_TIMEOUT_MS = 12_000;
export const ACTIONS_PER_PAGE = 100;
export const ACTIONS_MAX_PAGES = 10;
/** GitHub returns at most this many runs for a filtered list; a total at or past it cannot be proven complete. */
export const ACTIONS_FILTERED_RUN_CEILING = 1000;
/** Runs whose jobs are read at once; keeps one observation inside its budget without hammering the API. */
export const ACTIONS_JOBS_CONCURRENCY = 4;

export interface ActionsStep {
	name: string;
	status: string;
	conclusion: string | null;
}

export interface ActionsJob {
	id: number;
	runId: number;
	runAttempt: number;
	name: string;
	status: string;
	conclusion: string | null;
	steps: ActionsStep[];
}

/** A `CiRun` with the identity always present and its attempt's jobs read in full. */
export interface ActionsRun extends CiRun {
	databaseId: number;
	attempt: number;
	event?: string;
	triggeringActor?: string;
	jobs: ActionsJob[];
}

export type ActionsCiErrorCategory = "denied" | "rate_limited" | "transport" | "malformed" | "incomplete" | "deadline";

/** Bounded: a category, the endpoint, an HTTP status and at most a token-free 60-byte body preview, never a raw body. */
export class ActionsCiError extends Error {
	readonly category: ActionsCiErrorCategory;
	readonly endpoint: string;
	readonly detail: string;
	constructor(category: ActionsCiErrorCategory, endpoint: string, detail = "") {
		super(`Actions CI read ${category}: gh api ${endpoint.slice(0, 200)}${detail ? ` (${detail})` : ""}`);
		this.name = "ActionsCiError";
		this.category = category;
		this.endpoint = endpoint;
		this.detail = detail;
	}
}

export interface ActionsRepo {
	owner: string;
	repo: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

function repoPath(repo: ActionsRepo | undefined): string {
	if (!repo) return "repos/{owner}/{repo}";
	if (!NAME.test(repo.owner) || !NAME.test(repo.repo) || repo.owner.startsWith(".") || repo.repo.startsWith(".")) {
		throw new Error(`refusing an Actions read for a malformed repo ${JSON.stringify(`${repo.owner}/${repo.repo}`.slice(0, 80))}`);
	}
	return `repos/${repo.owner}/${repo.repo}`;
}

function positive(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * `repos/<o>/<r>/actions/runs?head_sha=<sha>[&branch=<b>]&per_page=100&page=<n>`;
 * `{owner}/{repo}` when no repo is given.
 */
export function actionsRunsPath(input: { repo?: ActionsRepo; sha: string; branch?: string; page: number }): string {
	if (!SHA.test(input.sha)) throw new Error(`refusing an Actions read for a malformed head sha ${JSON.stringify(input.sha.slice(0, 80))}`);
	if (input.branch !== undefined && (!BRANCH.test(input.branch) || input.branch.includes(".."))) {
		throw new Error(`refusing an Actions read for a malformed branch ${JSON.stringify(input.branch.slice(0, 80))}`);
	}
	if (!positive(input.page)) throw new Error(`refusing an Actions read for page ${input.page}`);
	const branch = input.branch === undefined ? "" : `&branch=${encodeURIComponent(input.branch)}`;
	return `${repoPath(input.repo)}/actions/runs?head_sha=${input.sha}${branch}&per_page=${ACTIONS_PER_PAGE}&page=${input.page}`;
}

/** `repos/<o>/<r>/actions/runs?branch=<b>&per_page=100&page=1`: the newest runs of a branch, on any sha. */
export function actionsBranchRunsPath(input: { repo?: ActionsRepo; branch: string }): string {
	if (!BRANCH.test(input.branch) || input.branch.includes("..")) {
		throw new Error(`refusing an Actions read for a malformed branch ${JSON.stringify(input.branch.slice(0, 80))}`);
	}
	return `${repoPath(input.repo)}/actions/runs?branch=${encodeURIComponent(input.branch)}&per_page=${ACTIONS_PER_PAGE}&page=1`;
}

/** `repos/<o>/<r>/actions/runs?per_page=1&page=1`: the newest run on any head, for /doctor's access probe only. */
export function actionsLatestRunPath(repo: ActionsRepo): string {
	return `${repoPath(repo)}/actions/runs?per_page=1&page=1`;
}

/** `repos/<o>/<r>/actions/runs/<id>/attempts/<attempt>/jobs?per_page=100&page=<n>`. */
export function actionsJobsPath(input: { repo?: ActionsRepo; runId: number; attempt: number; page: number }): string {
	if (!positive(input.runId) || !positive(input.attempt) || !positive(input.page)) {
		throw new Error(`refusing an Actions jobs read for run ${input.runId} attempt ${input.attempt} page ${input.page}`);
	}
	return `${repoPath(input.repo)}/actions/runs/${input.runId}/attempts/${input.attempt}/jobs?per_page=${ACTIONS_PER_PAGE}&page=${input.page}`;
}

interface Page<T> {
	total: number;
	items: T[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return typeof value === "string" ? value : undefined;
}

function pageOf(stdout: string, endpoint: string, key: string): Page<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new ActionsCiError("malformed", endpoint, "not JSON");
	}
	const body = record(parsed);
	const total = body?.total_count;
	const list = body?.[key];
	if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(list)) {
		throw new ActionsCiError("malformed", endpoint, `missing total_count or ${key}`);
	}
	if (list.length > ACTIONS_PER_PAGE) throw new ActionsCiError("malformed", endpoint, "page longer than per_page");
	const items = list.map((entry) => record(entry));
	if (items.some((entry) => entry === undefined)) throw new ActionsCiError("malformed", endpoint, `${key} entry is not an object`);
	return { total, items: items as Record<string, unknown>[] };
}

type RunRow = Omit<ActionsRun, "jobs">;

/** One page of `actions/runs`: every row must name a run id, attempt and exactly `sha` (any valid sha when absent). */
export function parseRunsPage(stdout: string, sha: string | undefined, endpoint = "actions/runs"): Page<RunRow> {
	const page = pageOf(stdout, endpoint, "workflow_runs");
	const items = page.items.map((row): RunRow => {
		const { id, run_attempt: attempt, head_sha: headSha } = row;
		const status = nullableString(row.status);
		const conclusion = nullableString(row.conclusion);
		if (typeof id !== "number" || !positive(id) || typeof attempt !== "number" || !positive(attempt)) {
			throw new ActionsCiError("malformed", endpoint, "run without id or run_attempt");
		}
		if (typeof headSha !== "string" || (sha === undefined ? !SHA.test(headSha) : headSha.toLowerCase() !== sha.toLowerCase())) {
			throw new ActionsCiError("malformed", endpoint, `run ${id} is not on the requested head`);
		}
		if (status === undefined || conclusion === undefined) throw new ActionsCiError("malformed", endpoint, `run ${id} without status`);
		const actor = record(row.triggering_actor)?.login;
		return {
			status: status ?? "unknown",
			conclusion: conclusion === "" ? null : conclusion,
			headSha,
			databaseId: id,
			attempt,
			...(typeof row.name === "string" ? { workflowName: row.name } : {}),
			...(typeof row.event === "string" ? { event: row.event } : {}),
			...(typeof actor === "string" ? { triggeringActor: actor } : {}),
		};
	});
	return { total: page.total, items };
}

/** One page of attempt jobs: each job must belong to `runId`/`attempt` (and `sha` when the job names a head). */
export function parseJobsPage(stdout: string, run: { runId: number; attempt: number; sha?: string }, endpoint = "actions/jobs"): Page<ActionsJob> {
	const page = pageOf(stdout, endpoint, "jobs");
	const items = page.items.map((row): ActionsJob => {
		const { id, run_id: runId, run_attempt: runAttempt, head_sha: headSha } = row;
		const status = nullableString(row.status);
		const conclusion = nullableString(row.conclusion);
		if (typeof id !== "number" || !positive(id) || runId !== run.runId) throw new ActionsCiError("malformed", endpoint, "job not of the run");
		if (runAttempt !== undefined && runAttempt !== run.attempt) throw new ActionsCiError("malformed", endpoint, `job ${id} not of attempt ${run.attempt}`);
		if (run.sha !== undefined && headSha !== undefined && (typeof headSha !== "string" || headSha.toLowerCase() !== run.sha.toLowerCase())) {
			throw new ActionsCiError("malformed", endpoint, `job ${id} is not on the requested head`);
		}
		if (status === undefined || conclusion === undefined) throw new ActionsCiError("malformed", endpoint, `job ${id} without status`);
		const steps = Array.isArray(row.steps) ? row.steps : [];
		return {
			id,
			runId: run.runId,
			runAttempt: run.attempt,
			name: typeof row.name === "string" ? row.name : "",
			status: status ?? "unknown",
			conclusion: conclusion === "" ? null : conclusion,
			steps: steps.flatMap((step): ActionsStep[] => {
				const value = record(step);
				if (!value) return [];
				const stepConclusion = nullableString(value.conclusion);
				return [{ name: typeof value.name === "string" ? value.name : "", status: typeof value.status === "string" ? value.status : "unknown", conclusion: stepConclusion ?? null }];
			}),
		};
	});
	return { total: page.total, items };
}

export interface ActionsReadOptions {
	cwd: string;
	exec: CommandRunner;
	/** The repo to address; absent means gh resolves `{owner}/{repo}` from `cwd`'s remote. */
	repo?: ActionsRepo;
	/** Total budget for the whole observation, every page included. */
	timeoutMs?: number;
	now?: () => number;
	/** The pause between retries; tests pass a no-op. */
	sleep?: (ms: number) => Promise<void>;
	/** Where a failed (or slow) observation's call trace goes; stderr by default. */
	log?: (line: string) => void;
}

interface Budget {
	start: number;
	deadline: number;
	now: () => number;
	/** One entry per settled gh call: start offset, endpoint, wall and monotonic duration, cap and exit status. */
	calls: string[];
	/** Calls not settled yet, so a failure also names the parallel or hung ones. */
	pending: Set<string>;
}

function budgetOf(options: ActionsReadOptions): Budget {
	const now = options.now ?? Date.now;
	const start = now();
	return { start, deadline: start + (options.timeoutMs ?? ACTIONS_CI_TIMEOUT_MS), now, calls: [], pending: new Set() };
}

/** One observation; a failure, or a success that spent over half the budget, logs every gh call and the budget left. */
async function observe<T>(options: ActionsReadOptions, read: (budget: Budget) => Promise<T>): Promise<T> {
	const budget = budgetOf(options);
	const trace = (outcome: string) => {
		const calls = [...budget.calls, ...budget.pending].join("; ").slice(0, 4000) || "none";
		(options.log ?? console.error)(`actions-ci: observation ${outcome} with ${budget.deadline - budget.now()}ms of budget left; calls: ${calls}`);
	};
	try {
		const result = await read(budget);
		if (budget.now() - budget.start > (budget.deadline - budget.start) / 2) trace("slow");
		return result;
	} catch (error) {
		trace(`failed (${(error as Error).message.slice(0, 300)})`);
		throw error;
	}
}


/** Pauses before each retry of a transient read; the sum stays well inside one tick's budget. */
export const ACTIONS_RETRY_DELAYS_MS = [250, 750];

const TOKEN = /gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|\b(?:bearer|token)\s+\S+/gi;

/** What came back, for the fault: the HTTP status gh named (exit 0 means a 2xx) and a token-free 60-byte preview. */
function evidence(status: string, body: string): string {
	const text = body.slice(0, 4096).replace(TOKEN, "[redacted]").replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, 60);
	return `${status}; ${text ? `body ${JSON.stringify(text)}` : "empty body"}`;
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/** One attempt: the body when it parses as JSON, else a fault, its exit status and whether a retry may cure it. */
async function attempt(options: ActionsReadOptions, endpoint: string, timeoutMs: number): Promise<string | { fault: ActionsCiError; retry: boolean; exit: string }> {
	let stdout: string;
	try {
		stdout = await options.exec("gh", ["api", endpoint], { cwd: options.cwd, timeoutMs });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const body = String((error as { stdout?: unknown })?.stdout ?? "");
		const { code: status, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
		const exit = signal ? `signal ${String(signal)}` : `exit ${status ?? "?"}`;
		const code = /\bHTTP (\d{3})\b/.exec(message)?.[1];
		if (/rate limit/i.test(message)) return { fault: new ActionsCiError("rate_limited", endpoint), retry: false, exit };
		// GitHub's own denials are JSON; an HTML 403/404 is a proxy or abuse page, not the token's answer.
		const html = body.trim() !== "" && !isJson(body);
		if ((code === "403" || code === "404") && !html) return { fault: new ActionsCiError("denied", endpoint, `HTTP ${code}`), retry: false, exit };
		// "status", not "HTTP": src/ci-access.ts reads any "HTTP 403" as the token's denial.
		return { fault: new ActionsCiError("transport", endpoint, evidence(code ? `status ${code}` : "no HTTP status", body)), retry: true, exit };
	}
	if (isJson(stdout)) return stdout;
	const run = /\/runs\/(\d+)\//.exec(endpoint)?.[1];
	return { fault: new ActionsCiError("malformed", endpoint, `transient read${run ? ` run ${run}` : ""}: not JSON; ${evidence("gh exit 0", stdout)}`), retry: true, exit: "exit 0" };
}

/** A non-JSON body, HTML error page or transport fault retries with backoff in the budget; the last fault throws. */
async function get(options: ActionsReadOptions, budget: Budget, endpoint: string): Promise<string> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (let tries = 0; ; tries++) {
		const remaining = budget.deadline - budget.now();
		if (remaining <= 0) throw new ActionsCiError("deadline", endpoint, "observation budget spent");
		const cap = /\/attempts\//.test(endpoint) ? Math.min(remaining, ACTIONS_ATTEMPT_TIMEOUT_MS) : remaining;
		const [started, mono] = [budget.now(), performance.now()];
		const inFlight = `+${started - budget.start}ms ${endpoint} cap ${cap}ms in flight`;
		budget.pending.add(inFlight);
		const result = await attempt(options, endpoint, cap).finally(() => budget.pending.delete(inFlight));
		// Wall vs monotonic time tells a late callback (event-loop stall) from a wall-clock step.
		const took = `${budget.now() - started}ms (monotonic ${Math.round(performance.now() - mono)}ms)`;
		budget.calls.push(`+${started - budget.start}ms ${endpoint} ${took} cap ${cap}ms ${typeof result === "string" ? "exit 0" : `${result.exit} ${result.fault.category}`}`);
		if (typeof result === "string") return result;
		const delay = ACTIONS_RETRY_DELAYS_MS[tries];
		const left = budget.deadline - budget.now();
		if (!result.retry || delay === undefined || left <= delay) {
			if (tries === 0) throw result.fault;
			throw new ActionsCiError(result.fault.category, endpoint, `${result.fault.detail}; ${tries + 1} attempts`);
		}
		await sleep(delay);
	}
}

/** Same id and same fields twice (a page boundary shift) is one item; the same id with different fields is unknown. */
function addUnique<T extends object>(into: Map<number, T>, key: number, item: T, endpoint: string): void {
	const seen = into.get(key);
	if (seen && JSON.stringify(seen) !== JSON.stringify(item)) throw new ActionsCiError("incomplete", endpoint, `conflicting duplicate ${key}`);
	into.set(key, item);
}

async function paged<T extends object>(
	options: ActionsReadOptions,
	budget: Budget,
	pathOf: (page: number) => string,
	parse: (stdout: string, endpoint: string) => Page<T>,
	keyOf: (item: T) => number,
): Promise<T[]> {
	const items = new Map<number, T>();
	for (let page = 1; page <= ACTIONS_MAX_PAGES; page++) {
		const endpoint = pathOf(page);
		const result = parse(await get(options, budget, endpoint), endpoint);
		if (result.total >= ACTIONS_FILTERED_RUN_CEILING) throw new ActionsCiError("incomplete", endpoint, `total_count ${result.total} past the API ceiling`);
		for (const item of result.items) addUnique(items, keyOf(item), item, endpoint);
		if (result.items.length < ACTIONS_PER_PAGE) {
			if (items.size !== result.total) throw new ActionsCiError("incomplete", endpoint, `read ${items.size} of total_count ${result.total}`);
			return [...items.values()];
		}
	}
	throw new ActionsCiError("incomplete", pathOf(ACTIONS_MAX_PAGES), `more than ${ACTIONS_MAX_PAGES} pages`);
}

async function jobsWithin(options: ActionsReadOptions, budget: Budget, run: { runId: number; attempt: number; sha?: string }): Promise<ActionsJob[]> {
	return paged(
		options,
		budget,
		(page) => actionsJobsPath({ repo: options.repo, runId: run.runId, attempt: run.attempt, page }),
		(stdout, endpoint) => parseJobsPage(stdout, run, endpoint),
		(job) => job.id,
	);
}

/** Every job of one run attempt, all pages; any failed page throws rather than returning a partial list. */
export async function readActionsJobs(options: ActionsReadOptions, run: { runId: number; attempt: number; sha?: string }): Promise<ActionsJob[]> {
	return observe(options, (budget) => jobsWithin(options, budget, run));
}

/**
 * Every workflow run on exactly `sha` (optionally one branch), each with its attempt's jobs, within one total budget.
 * Zero runs is a valid observation; a queued or skipped run may have zero jobs. Never collapses runs by workflow name.
 */
export async function readActionsCi(options: ActionsReadOptions & { sha: string; branch?: string }): Promise<ActionsRun[]> {
	return observe(options, async (budget) => {
		const runs = await paged(
			options,
			budget,
			(page) => actionsRunsPath({ repo: options.repo, sha: options.sha, branch: options.branch, page }),
			(stdout, endpoint) => parseRunsPage(stdout, options.sha, endpoint),
			(run) => run.databaseId,
		);
		// Jobs pages are read in small parallel batches: serial reads of every run spent the one budget (#420).
		const observed: ActionsRun[] = [];
		for (let at = 0; at < runs.length; at += ACTIONS_JOBS_CONCURRENCY) {
			const batch = runs.slice(at, at + ACTIONS_JOBS_CONCURRENCY);
			const jobs = await Promise.all(batch.map((run) => jobsWithin(options, budget, { runId: run.databaseId, attempt: run.attempt, sha: options.sha })));
			batch.forEach((run, index) => observed.push({ ...run, jobs: jobs[index] as ActionsJob[] }));
		}
		return observed;
	});
}

/**
 * The branch's newest runs on any sha other than `head`, one validated page. Evidence only that `head` is a fresh
 * push still waiting for its run (main's `superseded`) — never CI evidence for `head`. A failed read throws.
 */
export async function readOlderBranchRuns(options: ActionsReadOptions & { branch: string; head: string }): Promise<CiRun[]> {
	const endpoint = actionsBranchRunsPath({ repo: options.repo, branch: options.branch });
	const runs = parseRunsPage(await observe(options, (budget) => get(options, budget, endpoint)), undefined, endpoint).items;
	return runs.filter((run) => run.headSha.toLowerCase() !== options.head.toLowerCase());
}

/** Runs `read(budgetMs)`; an empty or non-JSON 200 ("transient read") gets one retry inside the ORIGINAL deadline. */
export async function retryTransientRead<T>(read: (timeoutMs: number) => Promise<T>, options: { timeoutMs?: number; now?: () => number } = {}): Promise<T> {
	const now = options.now ?? Date.now;
	const total = options.timeoutMs ?? ACTIONS_CI_TIMEOUT_MS;
	const deadline = now() + total;
	return read(total).catch((error: unknown) => {
		if (!(error instanceof ActionsCiError) || !/transient read/.test(error.detail)) throw error;
		const left = deadline - now();
		if (left <= 0) throw error;
		return read(left);
	});
}

/** A `{ status, stdout, stderr }` runner (src/merges.ts) as the throwing `CommandRunner` these readers take. */
export function statusRunner(run: StatusRunner): CommandRunner {
	return async (command, args, options) => {
		const result = await run(options.cwd, command, args, { timeoutMs: options.timeoutMs });
		if (result.status !== 0) {
			const message = `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`;
			throw Object.assign(new Error(message), { stdout: result.stdout, code: result.status });
		}
		return result.stdout;
	};
}
