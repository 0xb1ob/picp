/**
 * Full match S10b: `GET /api/threads` joins, read-only. A job joins the thread its ledger `origin.thread_id` names,
 * an ask the one its `source.thread_id` names (an answer goes with its ask by id). A disagreeing job/ask registry
 * `bind` makes it multi-origin; a thread the registry lacks is unresolvable. Both stay untagged and are counted.
 */
import { join } from "node:path";
import type { StartedFromChat, ThreadJoinDiagnostics, ThreadJoins, ThreadMember, ThreadsResponse } from "./api-types.ts";
import { DASHBOARD_ID_RE } from "./control-files.ts";
import { readQueueJournal } from "./control-queue.ts";
import { isThreadId, threadsView } from "./named-threads-view.ts";
import { asks } from "./overview-decisions.ts";
import { objectList } from "./overview-read.ts";
import { obj, runtimeRoot, type Json, type ViewerState } from "./sessions.ts";

/** Per thread and list; the rest is counted in `omitted`, never silently dropped. */
export const THREAD_JOINS_MAX = 100;

const origin = (value: unknown): { source_send_id: string; thread_id: string | null } | undefined => {
	const o = obj(value);
	const ok = !!o && Object.keys(o).length === 2 && typeof o.source_send_id === "string" && DASHBOARD_ID_RE.test(o.source_send_id) && (o.thread_id === null || isThreadId(o.thread_id));
	return ok ? (o as { source_send_id: string; thread_id: string | null }) : undefined;
};
const newest = <T extends { created_at: string }>(rows: T[]): T[] => rows.sort((a, b) => b.created_at.localeCompare(a.created_at));

/** The S8 projection plus per-thread jobs, asks and "Started from chat". Never writes. */
export function threadsJoinedView(state: ViewerState, now = new Date()): ThreadsResponse {
	const { stateDir } = state;
	const view = threadsView(stateDir, now);
	const diagnostics: ThreadJoinDiagnostics = { multi_origin: 0, unknown_thread: 0, malformed: 0, unreadable: [] };
	if (!view.available) return { ...view, joins: [], join_diagnostics: diagnostics };
	const joins = new Map<string, ThreadJoins>(view.threads.map((thread) => [thread.id, { thread_id: thread.id, jobs: [], asks: [], started_from_chat: [], omitted: 0 }]));
	const bound = new Map(view.bindings.filter((b) => b.kind === "job" || b.kind === "ask").map((b) => [`${b.kind}:${b.id}`, b.thread_id]));
	/** The one thread a record joins, or undefined (untagged, counted when ambiguous or unresolvable). */
	const threadOf = (kind: "job" | "ask", id: string, own: string | null | undefined): ThreadJoins | undefined => {
		const claims = new Set<string | null>();
		if (own !== undefined) claims.add(own);
		if (bound.has(`${kind}:${id}`)) claims.add(bound.get(`${kind}:${id}`)!);
		if (claims.size > 1) diagnostics.multi_origin += 1;
		const [thread] = claims;
		if (claims.size !== 1 || thread === null || thread === undefined) return undefined;
		if (!joins.has(thread)) diagnostics.unknown_thread += 1;
		return joins.get(thread);
	};
	const ledger = objectList(join(runtimeRoot(state.home), "jobs.json"), "jobs", (job) => typeof job.id === "string");
	if (ledger.availability === "unavailable") diagnostics.unreadable.push("ledger");
	let delivered: Set<string> | undefined;
	const wasDelivered = (id: string): boolean => {
		if (!delivered) {
			const journal = readQueueJournal(stateDir);
			if (journal.error) diagnostics.unreadable.push("dashboard journal");
			delivered = new Set([...journal.messages.values()].filter((m) => m.state === "delivered").map((m) => m.id));
		}
		return delivered.has(id);
	};
	for (const job of ledger.value as Json[]) {
		const recorded = job.origin === undefined ? undefined : origin(job.origin);
		if (job.origin !== undefined && !recorded) diagnostics.malformed += 1;
		const thread = threadOf("job", String(job.id), recorded?.thread_id);
		if (!thread) continue;
		const row: ThreadMember = { id: String(job.id), title: String(job.title ?? ""), state: String(job.status ?? ""), created_at: String(job.created_at ?? "") };
		thread.jobs.push(row);
		if (recorded && recorded.thread_id === thread.thread_id && wasDelivered(recorded.source_send_id)) {
			thread.started_from_chat.push({ job_id: row.id, title: row.title, state: row.state, created_at: row.created_at, source_send_id: recorded.source_send_id });
		}
	}
	const recordedAsks = asks(state);
	if (recordedAsks.availability === "unavailable") diagnostics.unreadable.push("asks");
	for (const ask of recordedAsks.value) {
		threadOf("ask", ask.ask.id, ask.source?.thread_id)?.asks.push({ id: ask.ask.id, title: ask.ask.question, state: ask.state, created_at: ask.ask.created_at });
	}
	for (const thread of joins.values()) {
		for (const key of ["jobs", "asks", "started_from_chat"] as const) {
			const rows = newest(thread[key] as Array<{ created_at: string }>);
			thread.omitted += Math.max(0, rows.length - THREAD_JOINS_MAX);
			(thread[key] as Array<ThreadMember | StartedFromChat>) = rows.slice(0, THREAD_JOINS_MAX) as Array<ThreadMember | StartedFromChat>;
		}
	}
	return { ...view, joins: [...joins.values()], join_diagnostics: diagnostics };
}
