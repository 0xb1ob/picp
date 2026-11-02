/**
 * M2 PR2: the one-shot startup move of the legacy answers journal into permanent response reports, run before any
 * answer producer writes. Neither journal: nothing to do; archive only: already migrated; live only: migrate, verify,
 * rename; both: a named conflict and no producer writes (docs/contracts.md, *Answer migration*).
 */
import { lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { canonicalResponse, cleanResponseTexts, publishResponseReport, readResponseReport, type ResponsePayload } from "./response-reports.ts";
import { resolveStateDir } from "./viewer/sessions.ts";
import { SERVICE_HEALTH_JOB_ID } from "./contracts.ts";
import type { EscalationStore } from "./escalation.ts";

export const ANSWER_MIGRATION_CONFLICT = "answer migration conflict: live and migrated journals both exist";
const JOURNAL_MAX_BYTES = 16 * 1024 * 1024;
const ID = /^ans-[a-f0-9]{12}$/;
// Every writer stamped whole seconds (isoTimestamp, the viewer ack); Date.toISOString's milliseconds are accepted too.
const AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
const MIGRATION_QUESTION = "answer migration ";

export class AnswerMigrationError extends Error {
	readonly code: "conflict" | "failed";
	constructor(code: "conflict" | "failed", message: string) {
		super(message);
		this.name = "AnswerMigrationError";
		this.code = code;
	}
}

export type AnswerMigration = { state: "none" | "already_migrated" } | { state: "migrated"; reports: number };

export function answerJournals(home: string): { live: string; archive: string } {
	const dir = join(resolveStateDir(home), "operator");
	return { live: join(dir, "answers.jsonl"), archive: join(dir, "answers.jsonl.migrated") };
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new AnswerMigrationError("failed", `answer migration cannot inspect ${path}: ${(error as Error).message}`);
	}
}

const isText = (value: unknown): value is string => typeof value === "string";
const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).sort().join() === [...keys].sort().join();
const POSTED = ["type", "by", "id", "at", "project", "question", "answer", "evidence_paths", "job_id"];
const SOURCE = ["kind", "schedule_id", "run_id", "source_key", "outcome"];

/** Strict: every line complete, known and consistent; acknowledgement lines are checked, then dropped. */
function parseJournal(text: string, fail: (why: string) => never): ResponsePayload[] {
	if (text && !text.endsWith("\n")) fail("its last line is torn (no trailing newline)");
	const posted = new Map<string, { row: string; payload: ResponsePayload }>();
	text.split("\n").slice(0, -1).forEach((row, index) => {
		const at = `line ${index + 1}`;
		let line: Record<string, unknown>;
		try { line = JSON.parse(row) as Record<string, unknown>; } catch { return fail(`${at} is not JSON`); }
		if (!line || typeof line !== "object" || Array.isArray(line) || !isText(line.id) || !ID.test(line.id) || !isText(line.at) || !AT.test(line.at)) fail(`${at} has no valid id and time`);
		const id = line.id as string;
		if (line.type === "acked") {
			if (line.by !== "viewer" || !hasKeys(line, ["type", "by", "id", "at", "peer"]) || !(line.peer === null || isText(line.peer))) fail(`${at} is not a valid acknowledgement`);
			if (!posted.has(id)) fail(`${at} acknowledges ${id}, which no earlier line posted`);
			return;
		}
		const source = line.source as Record<string, unknown> | undefined;
		const shaped = line.type === "posted" && (line.by === "bridge" ? hasKeys(line, POSTED)
			: line.by === "schedule" && hasKeys(line, [...POSTED, "source"]) && !!source && typeof source === "object" && hasKeys(source, SOURCE) && source.kind === "schedule" && SOURCE.every((key) => isText(source[key])));
		const evidence = line.evidence_paths;
		if (!shaped || !isText(line.project) || !isText(line.question) || !isText(line.answer) || !Array.isArray(evidence) || !evidence.every(isText) || !(line.job_id === null || isText(line.job_id))) fail(`${at} is not a valid posted answer`);
		const first = posted.get(id);
		if (first) return void (first.row !== row && fail(`${at} posts ${id} again with different content`));
		const time = (line.at as string).replace(/\.[0-9]{3}Z$/, "Z"); // a report's time is whole seconds
		posted.set(id, { row, payload: { project: line.project as string, question: line.question as string, answer: line.answer as string, evidence: evidence as string[], job: line.job_id as string | null, source: `legacy:${id}`, time } });
	});
	return [...posted.values()].map((entry) => entry.payload);
}

/**
 * Producers call this before every write. Throws `AnswerMigrationError`: `conflict` when both journals exist, `failed`
 * when migration could not complete; either way the live journal keeps its exact bytes and producers must not write.
 * The bridge and the parent may race: a gate that finds the other's rename done returns `already_migrated`.
 */
export function answerMigrationGate(home: string): AnswerMigration {
	const { live, archive } = answerJournals(home);
	try {
		return migrate(home, live, archive);
	} catch (error) {
		if (error instanceof AnswerMigrationError && !present(live) && present(archive)) return { state: "already_migrated" };
		throw error;
	}
}

function migrate(home: string, live: string, archive: string): AnswerMigration {
	const conflict = () => new AnswerMigrationError("conflict", `${ANSWER_MIGRATION_CONFLICT} (${live} and ${archive}); answer producers stay off until a human diagnoses them, neither file is touched`);
	const hasLive = present(live), hasArchive = present(archive);
	if (hasLive && hasArchive) throw conflict();
	if (!hasLive) return { state: hasArchive ? "already_migrated" : "none" };
	const fail = (why: string): never => { throw new AnswerMigrationError("failed", `answer migration failed, ${live} left unchanged: ${why}`); };
	let snapshot = Buffer.alloc(0);
	try {
		if (lstatSync(live).size > JOURNAL_MAX_BYTES) fail(`it is over ${JOURNAL_MAX_BYTES} bytes`);
		snapshot = readFileSync(live);
	} catch (error) {
		if (error instanceof AnswerMigrationError) throw error;
		fail((error as Error).message);
	}
	const records = parseJournal(snapshot.toString("utf8"), fail);
	for (const record of records) {
		const texts = [record.question, record.answer, ...record.evidence];
		let cleaned: string[] = [];
		try { cleaned = cleanResponseTexts(texts); } catch (error) { fail(`${record.source}: ${(error as Error).message}`); }
		if (cleaned.some((text, i) => text !== texts[i])) fail(`${record.source} holds secret-shaped text the journal should never have kept`);
	}
	const step = (source: string, fn: () => void) => { try { fn(); } catch (error) { fail(`${source}: ${(error as Error).message}`); } };
	for (const record of records) step(record.source, () => publishResponseReport(home, record));
	let verified = 0;
	for (const record of records) step(record.source, () => {
		const stored = readResponseReport(home, record.source);
		if (!stored || canonicalResponse(stored.payload) !== canonicalResponse(record)) throw new Error("the published report does not read back exactly");
		verified++;
	});
	if (verified !== records.length) fail(`verified ${verified} of ${records.length} reports`);
	step("recheck", () => { if (!readFileSync(live).equals(snapshot)) throw new Error("the journal changed while migrating"); });
	if (present(archive)) throw conflict();
	// shortcut: Node has no RENAME_NOREPLACE, so an archive appearing after this check is replaced; accepted by decision.
	// The fail-closed both-files gate above covers every observed state; a racing writer is drained before migration.
	try {
		renameSync(live, archive);
	} catch (error) {
		throw new AnswerMigrationError("failed", `answer migration verified ${verified} reports but could not rename ${live}: ${(error as Error).message}; answer producers stay off`);
	}
	return { state: "migrated", reports: verified };
}

const lastFailure = new Map<string, string>();

/**
 * Parent-side, each tick: a conflict raises one open `service_health` escalation at once; a failure only once the next
 * tick's recheck still sees it (a racing gate may be mid-migration). A passing gate withdraws every open one it raised.
 */
export async function escalateAnswerMigration(store: EscalationStore, home: string): Promise<{ raised?: string; withdrawn: string[] }> {
	const ours = () => store.list({ kind: "service_health" }).filter((item) => item.question.startsWith(MIGRATION_QUESTION));
	let failure: AnswerMigrationError;
	try {
		answerMigrationGate(home);
		lastFailure.delete(home);
		const withdrawn: string[] = [];
		for (const item of ours()) if (item.status === "open") withdrawn.push((await store.withdraw(item.id)).id);
		return { withdrawn };
	} catch (error) {
		if (!(error instanceof AnswerMigrationError)) throw error;
		failure = error;
	}
	if (failure.code === "failed" && lastFailure.get(home) !== failure.message) {
		lastFailure.set(home, failure.message);
		return { withdrawn: [] };
	}
	const question = `${failure.message.slice(0, 900)} \u2014 diagnose by hand`;
	if (ours().some((item) => item.question === question && item.status !== "withdrawn")) return { withdrawn: [] };
	const { live, archive } = answerJournals(home);
	const made = await store.raise({
		job_ids: [SERVICE_HEALTH_JOB_ID], kind: "service_health", question, recommended: "ack", evidence_paths: [live, archive],
		options: [{ id: "ack", label: "Acknowledged \u2014 I will diagnose the journals", consequence: "closes this alert; answer producers stay off until fixed", cost: "none" }],
	});
	return { raised: made.id, withdrawn: [] };
}
