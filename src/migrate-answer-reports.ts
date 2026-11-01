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
const AT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

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
		posted.set(id, { row, payload: { project: line.project as string, question: line.question as string, answer: line.answer as string, evidence: evidence as string[], job: line.job_id as string | null, source: `legacy:${id}`, time: line.at as string } });
	});
	return [...posted.values()].map((entry) => entry.payload);
}

/**
 * Producers call this before every write. Throws `AnswerMigrationError`: `conflict` when both journals exist, `failed`
 * when migration could not complete; either way the live journal keeps its exact bytes and producers must not write.
 */
export function answerMigrationGate(home: string): AnswerMigration {
	const { live, archive } = answerJournals(home);
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
	// shortcut: renameSync replaces an archive that appears after the recheck; the drained writer boundary rules that out.
	try {
		renameSync(live, archive);
	} catch (error) {
		// Another producer process finished the same migration first.
		if (!present(live) && present(archive) && readFileSync(archive).equals(snapshot)) return { state: "migrated", reports: verified };
		throw new AnswerMigrationError("failed", `answer migration verified ${verified} reports but could not rename ${live}: ${(error as Error).message}; answer producers stay off`);
	}
	return { state: "migrated", reports: verified };
}

/** Parent-side, each tick: a gate error becomes one open `service_health` escalation per distinct message, never re-raised. */
export async function escalateAnswerMigration(store: EscalationStore, home: string): Promise<string | undefined> {
	let question: string;
	try {
		answerMigrationGate(home);
		return undefined;
	} catch (error) {
		if (!(error instanceof AnswerMigrationError)) throw error;
		question = `${error.message.slice(0, 900)} — diagnose by hand`;
	}
	if (store.list({ kind: "service_health" }).some((item) => item.question === question)) return undefined;
	const { live, archive } = answerJournals(home);
	const made = await store.raise({
		job_ids: [SERVICE_HEALTH_JOB_ID], kind: "service_health", question, recommended: "ack", evidence_paths: [live, archive],
		options: [{ id: "ack", label: "Acknowledged — I will diagnose the journals", consequence: "closes this alert; answer producers stay off until fixed", cost: "none" }],
	});
	return made.id;
}
