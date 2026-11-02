/**
 * R1 D2: the operator's one-job model pick. The bridge issues a proof from a human entry of its own session;
 * the parent re-reads that source, honours the model once (a durable claim) and never reuses it (docs/contracts.md).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Value } from "typebox/value";
import {
	type FleetRecord, isoTimestamp, layoutForHome, OPERATOR_PICK_VERSION, type OperatorModelPickClaim, OperatorModelPickClaimSchema,
	type OperatorModelPickProof, OperatorModelPickProofSchema, type OperatorModelPickReference, type OperatorPickErrorCode,
	type OperatorPickRecord, type OperatorPickSource, type RoutingConfig,
} from "./contracts.ts";
import { recordOperatorSession } from "./operator-session-log.ts";
import { routedModels, unroutedMessage } from "./routed-models.ts";
import { RoutingError } from "./routing.ts";
import { controlJournalFile, parseDashboardText } from "./viewer/control-files.ts";
import { readOperatorSessions } from "./viewer/operator-sessions.ts";

/** A verified pick: a module-created capability, never a JSON flag a caller could forge. */
export interface VerifiedPick { readonly model: string; readonly proof: OperatorModelPickProof }
const VERIFIED = new WeakSet<VerifiedPick>();

/** True only for a capability `verifyOperatorPick` created for exactly `model`. */
export function isVerifiedPick(pick: unknown, model: string | undefined): pick is VerifiedPick {
	return typeof pick === "object" && pick !== null && VERIFIED.has(pick as VerifiedPick) && (pick as VerifiedPick).model === model;
}

const stateDirOf = (home: string): string => join(resolve(home), layoutForHome("multi", home).state);
/** `<state>/operator/model-picks`: proofs at the top, `claims/` beside them. Owner-only. */
export const modelPicksDir = (home: string): string => join(stateDirOf(home), "operator", "model-picks");
const proofFile = (home: string, proofId: string): string => join(modelPicksDir(home), `${proofId}.json`);
const claimFile = (home: string, key: "proof" | "job", id: string): string => join(modelPicksDir(home), "claims", `${key}-${id}.json`);

/** A refusal: the named code, the reason, and PR1's routing.json guidance when the model is unrouted. */
export function operatorPickError(code: OperatorPickErrorCode, detail: string, config?: RoutingConfig, model?: string): RoutingError {
	const guidance = config && model && !routedModels(config).includes(model) ? ` ${unroutedMessage(config, model, "operator_quote")}` : "";
	return new RoutingError(`${code}: ${detail}; nothing was spawned.${guidance}`, { refusal: "unrouted" });
}

const TOKEN_CHAR = /[A-Za-z0-9_./:+-]/;
/** Case-sensitive whole-token match: a neighbouring ASCII alnum, `_ . / : + -` makes it a different token. */
export function quoteNamesModel(quote: string, model: string): boolean {
	if (!model.includes("/")) return false;
	for (let at = quote.indexOf(model); at >= 0; at = quote.indexOf(model, at + 1)) {
		const before = quote[at - 1], after = quote[at + model.length];
		if ((before === undefined || !TOKEN_CHAR.test(before)) && (after === undefined || !TOKEN_CHAR.test(after))) return true;
	}
	return false;
}

interface SessionEntry { type?: string; id?: string; customType?: string; content?: unknown; message?: { role?: string; content?: unknown; toolName?: string } }

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

/** Undefined for a human-typed user entry; otherwise the author a refusal names (unknown is the main session's). */
function nonHumanAuthor(entry: SessionEntry): OperatorPickErrorCode | undefined {
	if (entry.type === "message" && entry.message?.role === "user") return undefined;
	const text = entry.type === "custom_message" ? textOf(entry.content) : textOf(entry.message?.content);
	if (entry.type === "custom_message" && entry.customType === "cp-bridge") return /^\[cp-bridge send\b/.test(text) ? "operator_pick_parent_authored" : "operator_pick_worker_authored";
	if (entry.message?.role === "toolResult" && entry.message.toolName === "cp_parent") return "operator_pick_parent_authored";
	return "operator_pick_main_session_authored";
}

const entryText = (entry: SessionEntry): string => (entry.type === "custom_message" ? textOf(entry.content) : textOf(entry.message?.content));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A dashboard entry counts only with one bridge request, a delivered outcome, no edit and the same text. */
function dashboardRefusal(stateDir: string, controlId: string, body: string, sessionFile: string): [OperatorPickErrorCode, string] | undefined {
	let rows: Array<Record<string, unknown>>;
	try {
		rows = readFileSync(controlJournalFile(stateDir), "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
		}).filter((row) => row.id === controlId);
	} catch {
		return ["operator_pick_missing", `dashboard audit for ${controlId} is unreadable`];
	}
	const requests = rows.filter((row) => row.type === "request" && row.by === "bridge");
	if (requests.length === 0) return ["operator_pick_missing", `no dashboard request ${controlId} in the audit`];
	if (requests.length > 1) return ["operator_pick_fabricated", `dashboard request ${controlId} is not unique`];
	if (!rows.some((row) => row.type === "outcome" && row.by === "bridge" && (row.state === "injected" || row.state === "delivered"))) {
		return ["operator_pick_missing", `dashboard request ${controlId} has no delivered outcome`];
	}
	if (rows.some((row) => row.type === "edited")) return ["operator_pick_edited", `dashboard request ${controlId} was edited`];
	if (requests[0]!.text !== body) return ["operator_pick_edited", `dashboard request ${controlId} text differs from the session entry`];
	if (typeof requests[0]!.session_file === "string" && requests[0]!.session_file !== sessionFile) {
		return ["operator_pick_fabricated", `dashboard request ${controlId} went to another session`];
	}
	return undefined;
}

/** The human source behind `entry`, or the refusal; `quote` must sit in its text minus the dashboard marker. */
function sourceOf(stateDir: string, sessionFile: string, entry: SessionEntry, quote: string): OperatorPickSource | [OperatorPickErrorCode, string] {
	const author = nonHumanAuthor(entry);
	if (author) return [author, `session entry ${entry.id} is not a human-typed user message`];
	const text = entryText(entry);
	const dashboard = parseDashboardText(text);
	if (dashboard) {
		const refused = dashboardRefusal(stateDir, dashboard.id, dashboard.body, sessionFile);
		if (refused) return refused;
	}
	if (!(dashboard?.body ?? text).includes(quote)) return ["operator_pick_fabricated", `the quote is not in session entry ${entry.id}`];
	return { kind: dashboard ? "dashboard" : "terminal", session_file: sessionFile, entry_id: entry.id!, text, sha256: sha256(text), ...(dashboard ? { control_id: dashboard.id } : {}) };
}

/** Exclusive, owner-only create: content lands whole or not at all; `false` when the file already exists. */
function createOnce(file: string, value: unknown): boolean {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try {
		linkSync(temp, file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		try { unlinkSync(temp); } catch { /* the link holds the content; a stray temp is harmless */ }
	}
}

export interface IssueRequest {
	home: string; sessionFile: string | undefined; entries: readonly unknown[]; model: string; quote: string; entryId?: string;
	jobId?: string; controlId?: string; now?: Date;
}

/** Bridge side: write `<proof_id>.json` from a human entry of the operator's own session; any doubt refuses. */
export function issueOperatorPick(request: IssueRequest): { reference: OperatorModelPickReference; proof: OperatorModelPickProof } {
	const fail = (code: OperatorPickErrorCode, detail: string): never => { throw new Error(`${code}: ${detail}; no proof was written`); };
	if (!request.sessionFile) fail("operator_pick_missing", "this operator session has no session file");
	const entries = request.entries as SessionEntry[];
	const quoting = entries.filter((each) => entryText(each).includes(request.quote)).reverse();
	// No id: the newest human message quoting it, else the newest quoting entry (so its author is the named refusal).
	const entry = request.entryId !== undefined ? entries.find((each) => each.id === request.entryId) : quoting.find((each) => !nonHumanAuthor(each)) ?? quoting[0];
	if (!entry) fail("operator_pick_missing", request.entryId !== undefined ? `no entry ${request.entryId} in this operator session` : "no message in this operator session contains the quote");
	if (!quoteNamesModel(request.quote, request.model)) fail("operator_pick_fabricated", `the quote does not name ${request.model} as a whole provider/model token`);
	const source = sourceOf(stateDirOf(request.home), request.sessionFile!, entry!, request.quote);
	if (Array.isArray(source)) return fail(source[0], source[1]);
	if (request.controlId !== undefined && source.control_id !== request.controlId) fail("operator_pick_fabricated", `entry ${entry!.id} is not dashboard request ${request.controlId}`);
	recordOperatorSession(join(resolve(request.home), layoutForHome("multi", request.home).sessions), request.sessionFile);
	const proof: OperatorModelPickProof = {
		version: OPERATOR_PICK_VERSION, proof_id: `omp-${randomBytes(16).toString("hex")}`, issuer: "operator-bridge",
		issued_at: isoTimestamp(request.now ?? new Date()), model: request.model, quote: request.quote,
		...(request.jobId ? { job_id: request.jobId } : {}), source,
	};
	if (!createOnce(proofFile(request.home, proof.proof_id), proof)) fail("operator_pick_fabricated", `proof ${proof.proof_id} already exists`);
	return { reference: { version: OPERATOR_PICK_VERSION, proof_id: proof.proof_id, quote: proof.quote }, proof };
}

/** A JSON object file, or undefined when it is unreadable or not an object. */
function readRecord(file: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Parent side: re-read the proof and its registered source; read-only, so a preview may call it. */
export function verifyOperatorPick(home: string, ref: OperatorModelPickReference, expect: { model: string | undefined; jobId: string; config: RoutingConfig }): VerifiedPick {
	const { model, jobId, config } = expect;
	const fail = (code: OperatorPickErrorCode, detail: string): never => { throw operatorPickError(code, detail, config, model); };
	const upgrade = "update and restart the operator bridge (cp-operator) and the CP parent";
	if (ref.version !== OPERATOR_PICK_VERSION) fail("operator_pick_bridge_unsupported", `operator_quote version ${ref.version} is not ${OPERATOR_PICK_VERSION}; ${upgrade}`);
	if (!model) fail("operator_pick_fabricated", "operator_quote needs the explicit provider/model it quotes");
	const file = proofFile(home, ref.proof_id);
	if (!existsSync(file)) fail("operator_pick_missing", `no proof ${ref.proof_id} (only cp_parent model_pick issues one; an older bridge cannot — ${upgrade})`);
	const raw = readRecord(file);
	if (!raw) fail("operator_pick_missing", `proof ${ref.proof_id} is unreadable`);
	if (!Value.Check(OperatorModelPickProofSchema, raw)) fail("operator_pick_bridge_unsupported", `proof ${ref.proof_id} is not a version ${OPERATOR_PICK_VERSION} operator-bridge proof; ${upgrade}`);
	const proof = raw as OperatorModelPickProof;
	if (proof.proof_id !== ref.proof_id || proof.quote !== ref.quote) fail("operator_pick_fabricated", `operator_quote does not match proof ${ref.proof_id}`);
	if (proof.model !== model) fail("operator_pick_fabricated", `proof ${ref.proof_id} picks ${proof.model}, not ${model}`);
	if (proof.job_id !== undefined && proof.job_id !== jobId) fail("operator_pick_fabricated", `proof ${ref.proof_id} is bound to ${proof.job_id}, not ${jobId}`);
	if (!quoteNamesModel(proof.quote, model!)) fail("operator_pick_fabricated", `the quote does not name ${model} as a whole provider/model token`);
	if (existsSync(claimFile(home, "proof", proof.proof_id))) fail("operator_pick_consumed", `proof ${proof.proof_id} was already used`);
	if (existsSync(claimFile(home, "job", jobId))) fail("operator_pick_consumed", `${jobId} already had its one operator pick; omit model to let routing decide`);
	const stateDir = stateDirOf(home);
	const sessionFile = proof.source.session_file;
	if (!readOperatorSessions(join(resolve(home), layoutForHome("multi", home).sessions)).some((session) => session.file === sessionFile)) {
		if (basename(sessionFile).startsWith("cp-parent")) fail("operator_pick_parent_authored", `${sessionFile} is a CP parent session`);
		if (dirname(sessionFile) === join(resolve(home), layoutForHome("multi", home).sessions)) fail("operator_pick_worker_authored", `${sessionFile} is a worker session`);
		fail("operator_pick_missing", `${sessionFile} is not a registered operator session`);
	}
	let entry: SessionEntry | undefined;
	try {
		entry = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
		}).find((each) => each.id === proof.source.entry_id);
	} catch { /* named below */ }
	if (!entry) fail("operator_pick_missing", `entry ${proof.source.entry_id} is not in ${sessionFile}`);
	const source = sourceOf(stateDir, sessionFile, entry!, proof.quote);
	if (Array.isArray(source)) return fail(source[0] === "operator_pick_fabricated" ? "operator_pick_edited" : source[0], source[1]);
	if (source.text !== proof.source.text || source.sha256 !== proof.source.sha256 || source.kind !== proof.source.kind || source.control_id !== proof.source.control_id) {
		fail("operator_pick_edited", `session entry ${proof.source.entry_id} no longer matches proof ${proof.proof_id}`);
	}
	const pick: VerifiedPick = Object.freeze({ model: model!, proof });
	VERIFIED.add(pick);
	return pick;
}

/** Admission: spend the proof, then the job, before any side effect; a partial claim stays spent. */
export function claimOperatorPick(home: string, pick: VerifiedPick, jobId: string, now: Date = new Date()): OperatorPickRecord {
	if (!isVerifiedPick(pick, pick.model)) throw operatorPickError("operator_pick_fabricated", "the pick was not verified by this parent");
	const { proof } = pick;
	const claim: OperatorModelPickClaim = {
		version: OPERATOR_PICK_VERSION, proof_id: proof.proof_id, job_id: jobId, attempt_id: `att-${randomBytes(8).toString("hex")}`,
		source_sha256: proof.source.sha256, claimed_at: isoTimestamp(now),
	};
	if (!createOnce(claimFile(home, "proof", proof.proof_id), claim)) throw operatorPickError("operator_pick_consumed", `proof ${proof.proof_id} was already used`);
	if (!createOnce(claimFile(home, "job", jobId), claim)) throw operatorPickError("operator_pick_consumed", `${jobId} already had its one operator pick`);
	const { text: _text, ...source } = proof.source;
	return { proof_id: proof.proof_id, attempt_id: claim.attempt_id, model: proof.model, quote: proof.quote, source };
}

/** The job's spent pick, if any, backed by its proof and proof claim; anything else fails closed. */
export function pickedJobClaim(home: string, jobId: string): OperatorModelPickClaim | undefined {
	const file = claimFile(home, "job", jobId);
	if (!existsSync(file)) return undefined;
	const raw = readRecord(file);
	const claim = Value.Check(OperatorModelPickClaimSchema, raw) && (raw as OperatorModelPickClaim).job_id === jobId ? (raw as OperatorModelPickClaim) : undefined;
	const proof = claim && readRecord(proofFile(home, claim.proof_id));
	const twin = claim && readRecord(claimFile(home, "proof", claim.proof_id));
	const backed = claim && Value.Check(OperatorModelPickProofSchema, proof) && (proof as OperatorModelPickProof).source.sha256 === claim.source_sha256 &&
		JSON.stringify(twin) === JSON.stringify(claim);
	if (!backed) throw new RoutingError(`${jobId}: operator pick claim ${file} is unreadable or not backed by its proof; refusing rather than guessing (inspect it by hand)`);
	return claim;
}

/** Freeze the picked attempt (worker + routing) once, before a later attempt replaces the fleet record. */
export function snapshotPickedAttempt(home: string, record: FleetRecord): void {
	const pick = record.routing?.operator_pick;
	if (!pick) return;
	const file = join(resolve(home), layoutForHome("multi", home).runs, record.job_id, "attempts", `${pick.attempt_id}.json`);
	const snapshot = { version: 1, job_id: record.job_id, attempt_id: pick.attempt_id, worker: record.worker, routing: record.routing };
	if (createOnce(file, snapshot)) return;
	if (JSON.stringify(readRecord(file)) !== JSON.stringify(snapshot)) {
		throw new RoutingError(`${record.job_id}: attempt snapshot ${file} differs from the picked record; refusing to replace it`);
	}
}
