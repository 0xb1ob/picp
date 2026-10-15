/**
 * A fake GitHub Actions REST API for tests that state CI as `gh run list`-shaped rows: it answers the exact-head
 * runs and attempt-jobs endpoints `src/actions-ci.ts` builds, filtering by `head_sha` the way the real API does.
 */

export interface FakeRun {
	status: string;
	conclusion: string | null;
	headSha: string;
	workflowName?: string;
	databaseId?: number;
	attempt?: number;
	event?: string;
	triggeringActor?: string;
	/** REST job rows (`id`, `name`, `status`, `conclusion`, `steps`); `run_id`/`run_attempt` are filled in. */
	jobs?: Array<Record<string, unknown>>;
}

const RUNS = /\/actions\/runs\?(?:head_sha=([0-9a-f]+)(?:&branch=[^&]+)?|branch=[^&]+)&per_page=100&page=(\d+)$/i;
const JOBS = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/;

function idOf(run: FakeRun, index: number): number {
	return run.databaseId ?? 9000 + index;
}

/** The body for one Actions runs/jobs endpoint, or `undefined` when it is neither; a branch-only read lists every run. */
export function answerActions(endpoint: string, runs: readonly FakeRun[]): string | undefined {
	const listed = RUNS.exec(endpoint);
	if (listed) {
		const sha = listed[1]?.toLowerCase();
		const rows = runs.flatMap((run, index) => (sha === undefined || run.headSha.toLowerCase() === sha ? [{ run, id: idOf(run, index) }] : []));
		const page = Number(listed[2]) === 1 ? rows : [];
		const workflowRuns = page.map(({ run, id }) => ({
			id,
			run_attempt: run.attempt ?? 1,
			head_sha: run.headSha,
			status: run.status,
			conclusion: run.conclusion,
			...(run.workflowName !== undefined ? { name: run.workflowName } : {}),
			...(run.event !== undefined ? { event: run.event } : {}),
			triggering_actor: run.triggeringActor === undefined ? null : { login: run.triggeringActor },
		}));
		return JSON.stringify({ total_count: rows.length, workflow_runs: workflowRuns });
	}
	const jobs = JOBS.exec(endpoint);
	if (jobs) {
		const runId = Number(jobs[1]);
		const attempt = Number(jobs[2]);
		const run = runs.find((candidate, index) => idOf(candidate, index) === runId);
		const rows = (run?.jobs ?? []).map((job) => ({ run_id: runId, run_attempt: attempt, ...job }));
		return JSON.stringify({ total_count: rows.length, jobs: Number(jobs[3]) === 1 ? rows : [] });
	}
	return undefined;
}
