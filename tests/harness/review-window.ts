import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DiffVerdict, DiffVerdictSchema, isoTimestamp, paths, SCHEMA_VERSION, validate } from "../../src/contracts.ts";

export function writeWindowPass(home: string, jobId: string, head: string, at: string, extra: Partial<DiffVerdict> = {}): DiffVerdict {
	const verdict: DiffVerdict = { schema_version: SCHEMA_VERSION, job_id: jobId, attempt: 1, verdict: "pass", cause: null,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false }, reasons: ["complete review"],
		decided_at: isoTimestamp(new Date(at)), head_sha: head, diff_stat: { files: 1, truncated: false }, ...extra };
	const parsed = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
	const file = join(home, verdict.equivalent_to ? paths.reviewEquivalenceFile(jobId, head) : paths.reviewFile(jobId, verdict.attempt));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(verdict));
	return verdict;
}

export function deadlineClock(at: string) {
	let time = Date.parse(at);
	const tasks = new Set<{ due: number; callback: () => void }>();
	return {
		now: () => new Date(time),
		tasks,
		schedule(delay: number, callback: () => void) {
			const task = { due: time + delay, callback };
			tasks.add(task);
			return () => { tasks.delete(task); };
		},
		tick(at: number) {
			time = at;
			for (const task of [...tasks]) if (task.due <= time) { tasks.delete(task); task.callback(); }
		},
	};
}
