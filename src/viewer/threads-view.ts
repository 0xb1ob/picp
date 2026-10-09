/**
 * cp-xmw2 S4: the operator threads with their derived state, read-only. A thread is `waiting` while one of its refs is
 * an open ask (asks.jsonl) or an unacknowledged answer (answers.jsonl); else `done` while its newest done line comes
 * after its newest bind (journal line order, never clocks); else `open`. A ref counts only for the thread its newest
 * bind names. With asks or answers unreadable `waiting` is null and the state falls back to done/open.
 */
import type { SourceAvailability, ThreadView } from "./api-types.ts";
import { readAnswers, readThreads, threadRefKey, THREADS_LIST_MAX } from "./control-files.ts";
import { asks } from "./overview-decisions.ts";
import { isLiveWorker, readStatus, str, type ViewerState } from "./sessions.ts";
import { objectList } from "./overview-read.ts";
import { join } from "node:path";

export interface ThreadsView {
	availability: SourceAvailability;
	/** Waiting, then open (newest `last_at` first), then done (newest `done_at` first); at most THREADS_LIST_MAX. */
	threads: ThreadView[];
	total: number;
	warning: string | null;
	/** The threads journal's read error, or null. */
	error: string | null;
	/** The source that makes `waiting` unknowable (asks or answers unreadable), or null. */
	blind: string | null;
	byId: Map<string, ThreadView>;
}

const RANK = { waiting: 0, open: 1, done: 2 } as const;

export function threadsView(state: ViewerState): ThreadsView {
	const journal = readThreads(state.stateDir);
	const empty = { threads: [], total: 0, blind: null, byId: new Map<string, ThreadView>() };
	if (journal.error) return { ...empty, availability: "unavailable", warning: `threads unavailable: ${journal.error}`, error: journal.error };
	if (!journal.exists) return { ...empty, availability: "missing", warning: null, error: null };
	const askSource = asks(state);
	const answers = readAnswers(state.stateDir);
	const blind = askSource.availability === "unavailable" ? "state/operator/asks.jsonl" : answers.error ? "state/operator/answers.jsonl" : null;
	const warnings = [
		...(journal.skipped ? [`${journal.skipped} unreadable line(s) in state/operator/threads.jsonl skipped`] : []),
		...(askSource.availability === "unavailable" ? ["asks unavailable: state/operator/asks.jsonl unreadable; waiting is unknown"] : []),
		...(answers.error ? [`answers unavailable: ${answers.error}; waiting is unknown`] : []),
	];
	const openAsks = new Set(askSource.value.filter((record) => record.state === "open").map((record) => record.ask.id));
	const unacked = new Set(answers.answers.filter((answer) => answer.acked_at === null).map((answer) => answer.id));
	// Live workers by job id; `null` counts while fleet.json is unreadable (a missing file is no live worker).
	const fleet = objectList(join(state.stateDir, "fleet.json"), "jobs", () => true);
	const live = new Set(fleet.value.filter((job) => job.executor !== "script" && isLiveWorker(str(readStatus(state, str(job.job_id) ?? "")?.phase), str(job.phase))).map((job) => str(job.job_id)));
	const all = journal.threads.map((thread): ThreadView => {
		const refs = thread.refs.filter((item) => journal.refs.get(threadRefKey(item.ref)) === thread.id).map((item) => item.ref);
		const count = (kind: string) => refs.filter((ref) => ref.kind === kind).length;
		const waiting = blind ? null : { asks: refs.filter((ref) => ref.kind === "ask" && openAsks.has(ref.id)).length, answers: refs.filter((ref) => ref.kind === "answer" && unacked.has(ref.id)).length };
		const done = thread.done_line !== null && (thread.last_bind_line === null || thread.done_line > thread.last_bind_line);
		const state = waiting && waiting.asks + waiting.answers > 0 ? "waiting" : done ? "done" : "open";
		const jobsWorking = fleet.availability === "unavailable" ? null : new Set(refs.filter((ref) => ref.kind === "job" && live.has(ref.id)).map((ref) => ref.id)).size;
		return { id: thread.id, tag: thread.tag, state, waiting, counts: { messages: count("dashboard"), asks: count("ask"), answers: count("answer"), jobs_working: jobsWorking }, opened_at: thread.opened_at, last_at: thread.last_at, done_at: state === "done" ? thread.done_at : null };
	});
	all.sort((a, b) => RANK[a.state] - RANK[b.state] || (a.state === "done" ? String(b.done_at).localeCompare(String(a.done_at)) : b.last_at.localeCompare(a.last_at)));
	return { availability: "ok", threads: all.slice(0, THREADS_LIST_MAX), total: all.length, warning: warnings.length ? warnings.join("; ") : null, error: null, blind, byId: new Map(all.map((view) => [view.id, view])) };
}
