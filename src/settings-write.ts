/**
 * Settings writes (cp-7bsr PR2): one audited, deterministic transaction that changes or restores catalog
 * settings in their **owner files** — no overlay, no projection, no stored copy. The owners' loaders stay
 * authoritative; this module only patches the keys it is asked to and reads the result back through
 * `readSettings`.
 *
 * Synchronous on purpose: between taking `state/settings.lock` and releasing it nothing awaits, so nothing
 * else in the operator's process interleaves. Order: lock → finalise a dangling intent (`recovered`) →
 * snapshot and If-Match (412) → plan and validate every key (400/403/409) → `intent` line → owner writes
 * (rolled back from the prior bytes on failure) → read-back → `applied`/`failed`. The journal
 * `data/settings-audit.jsonl` is a log, never read back as configuration.
 */

import { randomBytes, createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	BudgetConfigSchema,
	DEFAULT_BUDGET_CONFIG,
	DEFAULT_GATE_CONFIG,
	GateConfigSchema,
	isoTimestamp,
	LAYOUT,
	MandateDefaultsSchema,
	QualityConfigSchema,
	SETTING_FIELDS,
	SETTING_FILE_OWNERS,
	SETTING_SECTIONS,
	type SettingField,
	type SettingFileOwner,
	type SettingKey,
	type SettingsSnapshot,
	type SettingValue,
	validate,
	validateSettingValue,
} from "./contracts.ts";
import { atomicWriteText, durableAppend } from "./json-store.ts";
import { SCAFFOLD_MANDATE_DEFAULTS } from "./mandate-defaults.ts";
import { readSettings } from "./settings.ts";
import { acquireSettingsLock } from "./settings-lock.ts";

export const settingsAuditFile = (home: string): string => join(home, LAYOUT.data, "settings-audit.jsonl");

/**
 * Restore per key: `delete` where an absent key is the owner's default; `default` writes the catalog default
 * (= the scaffold value) where an absent key refuses or disables; `installer_seed` restores what cp-install
 * seeds on an installed home (`data/daemon.json` generated_by cp-install: enabled true, interval_min 15),
 * else the catalog behaviour (enabled false; interval deleted).
 */
export const RESTORE_ACTIONS: Readonly<Partial<Record<SettingKey, "delete" | "default" | "installer_seed">>> = Object.freeze({
	"grants.expiry_hours": "default",
	"grants.spend_usd": "default",
	"grants.spend_tokens": "default",
	"grants.token_ceiling": "default",
	"grants.job_cap": "default",
	"grants.dispatch_parallelism": "default",
	"grants.allowed_actions": "default",
	"grants.ask_on": "default",
	"grants.exclude_paths": "default",
	"budgets.per_job_tokens": "default",
	"budgets.per_job_cost_usd": "default",
	"budgets.warn_ratio": "default",
	"budgets.spawn_cap": "default",
	"sessions.wall_clock_seconds": "default",
	"sessions.parent_compact_at_tokens": "default",
	"sessions.operator_compact_at_tokens": "delete",
	"review.timeout_ms": "delete",
	"review.quality_verify": "delete",
	"review.quality_completeness": "delete",
	"review.quality_voters": "delete",
	"review.quality_threshold": "delete",
	"capacity.five_hour": "delete",
	"capacity.seven_day": "delete",
	"capacity.balance_margin": "delete",
	"maintenance.update_enabled": "installer_seed",
	"maintenance.update_interval_min": "installer_seed",
});

/** What cp-install writes to `data/update.json` (src/service/install.ts step 7). */
export const INSTALLER_UPDATE_SEED = Object.freeze({ enabled: true, interval_min: 15 });

export type SettingsWriteRequest =
	| { mode: "set"; changes: Record<string, unknown> }
	| { mode: "restore"; keys?: string[]; section?: string; all?: true };

export interface SettingsApplyInput {
	request: SettingsWriteRequest;
	/** The `If-Match` revision; null only for a dry run. */
	expected_revision: string | null;
	dry_run: boolean;
	request_id: string;
	peer: string | null;
	actor: "dashboard";
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

export interface SettingsWriteSeams {
	writeText?: (file: string, text: string, options: { mode?: number; syncDir: boolean }) => void;
	append?: (file: string, text: string) => void;
	readBack?: (home: string, env: NodeJS.ProcessEnv) => SettingsSnapshot;
	isPidAlive?: (pid: number) => boolean;
	onBeforeReclaim?: () => void;
}

export interface PlannedChange { key: SettingKey; file_key: string; action: "set" | "delete"; old: SettingValue; old_source: string; new: SettingValue }

export interface SettingsApplyResult {
	status: number;
	state: "planned" | "unchanged" | "applied" | "stale" | "refused" | "failed";
	error?: string;
	errors?: string[];
	revision?: string;
	snapshot?: SettingsSnapshot;
	changes?: PlannedChange[];
	audit_warning?: string;
	audit?: string;
}

type Change = { key: SettingKey; file_key: string; action: "set" | "delete"; old: SettingValue; old_source: string; new: SettingValue; expected: SettingValue };
type Write = { owner: SettingFileOwner; path: string; file: string; prior: Buffer | null; next: string; mode: number | undefined; changes: Change[] };

export type SettingsAuditLine =
	| { v: 1; type: "intent"; id: string; at: string; actor: string; peer: string | null; request_id: string; mode: "set" | "restore"; base_revision: string; writes: Array<{ owner: SettingFileOwner; path: string; prior_sha256: string | null; next_sha256: string; changes: PlannedChange[] }> }
	| { v: 1; type: "applied"; id: string; at: string; revision: string }
	| { v: 1; type: "failed"; id: string; at: string; reason: string; rolled_back: Array<{ owner: SettingFileOwner; ok: boolean; error?: string }> }
	| { v: 1; type: "recovered"; id: string; at: string; owners: Array<{ owner: SettingFileOwner; state: "applied" | "not_written" | "changed_since" }> }
	| { v: 1; type: "refused"; id: null; at: string; actor: string; peer: string | null; request_id: string; status: number; reason: string };

const FIELD = new Map<string, SettingField>(SETTING_FIELDS.map((field) => [field.key, field]));
const AUDIT_TAIL_BYTES = 64 * 1024;
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const newId = (now: Date) => `st-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
const clone = <T>(value: T): T => structuredClone(value) as T;

class Refusal extends Error {
	readonly status: number;
	readonly errors?: string[];
	constructor(status: number, reason: string, errors?: string[]) {
		super(reason);
		this.status = status;
		this.errors = errors;
	}
}

/** The base document a `set` builds on when the owner file is absent: the owner's own absent-file behaviour. */
function baseDocument(owner: SettingFileOwner, path: string): Record<string, unknown> {
	switch (owner) {
		case "mandate-defaults":
			return { ...clone(SCAFFOLD_MANDATE_DEFAULTS) };
		case "budgets":
			return { ...DEFAULT_BUDGET_CONFIG };
		case "gate":
			return { ...DEFAULT_GATE_CONFIG };
		case "update":
			return { enabled: false };
		case "capacity":
			throw new Refusal(409, `${path} is absent: configure the gateway with cp-install --gateway-url first`);
		default:
			return {};
	}
}

const OWNER_SCHEMA: Partial<Record<SettingFileOwner, unknown>> = {
	"mandate-defaults": MandateDefaultsSchema,
	budgets: BudgetConfigSchema,
	gate: GateConfigSchema,
	quality: QualityConfigSchema,
};

function hasAt(doc: Record<string, unknown>, fileKey: string): { found: boolean; value?: unknown } {
	let node: unknown = doc;
	for (const part of fileKey.split(".")) {
		if (!isObject(node) || !(part in node)) return { found: false };
		node = node[part];
	}
	return { found: true, value: node };
}

function setAt(doc: Record<string, unknown>, fileKey: string, value: unknown): void {
	const parts = fileKey.split(".");
	let node = doc;
	for (const part of parts.slice(0, -1)) {
		if (!isObject(node[part])) node[part] = {};
		node = node[part] as Record<string, unknown>;
	}
	node[parts.at(-1) as string] = clone(value);
}

/** Delete a dotted key; a parent object left empty (`quota`) goes too. */
function deleteAt(doc: Record<string, unknown>, fileKey: string): void {
	const parts = fileKey.split(".");
	const parents: Array<[Record<string, unknown>, string]> = [];
	let node = doc;
	for (const part of parts.slice(0, -1)) {
		if (!isObject(node[part])) return;
		parents.push([node, part]);
		node = node[part] as Record<string, unknown>;
	}
	delete node[parts.at(-1) as string];
	for (const [parent, part] of parents.reverse()) {
		if (isObject(parent[part]) && Object.keys(parent[part] as object).length === 0) delete parent[part];
	}
}

/** True on a cp-install home; an unreadable `data/daemon.json` is a refusal, never a guess. */
function installedHome(home: string): boolean {
	const path = join(LAYOUT.data, "daemon.json");
	let text: string;
	try {
		text = readFileSync(join(home, path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw new Refusal(409, `${path} is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"}); fix it before restoring maintenance settings`);
	}
	try {
		const value: unknown = JSON.parse(text);
		return isObject(value) && value.generated_by === "cp-install";
	} catch {
		throw new Refusal(409, `${path} is not valid JSON; fix it before restoring maintenance settings`);
	}
}

/** The keys a request names, checked: unknown 400, not editable 403. Section/all skip non-editable fields. */
function resolveKeys(request: SettingsWriteRequest): SettingKey[] {
	if (request.mode === "restore" && request.keys === undefined) {
		if (request.section !== undefined && !(SETTING_SECTIONS as readonly string[]).includes(request.section)) throw new Refusal(400, `unknown section ${request.section}`);
		return SETTING_FIELDS.filter((field) => field.editable && (request.all === true || field.section === request.section)).map((field) => field.key);
	}
	const keys = request.mode === "set" ? Object.keys(request.changes) : (request.keys ?? []);
	const unknown = keys.filter((key) => !FIELD.has(key));
	if (unknown.length) throw new Refusal(400, `unknown setting ${unknown.join(", ")}`, unknown.map((key) => `unknown setting ${key}`));
	const locked = keys.filter((key) => !FIELD.get(key)?.editable);
	if (locked.length) throw new Refusal(403, `not editable here: ${locked.join(", ")}`);
	if (request.mode === "set") {
		const errors = keys.flatMap((key) => {
			const checked = validateSettingValue(key, request.changes[key]);
			return checked.ok ? [] : checked.errors.map((error) => `${key}: ${error}`);
		});
		if (errors.length) throw new Refusal(400, "invalid setting value", errors);
	}
	return [...new Set(keys)] as SettingKey[];
}

/** One owner's planned writes. Pure apart from reading the owner bytes and `data/daemon.json`. */
function planWrites(home: string, snapshot: SettingsSnapshot, request: SettingsWriteRequest): Write[] {
	const keys = resolveKeys(request);
	const writes: Write[] = [];
	let installed: boolean | undefined;
	for (const owner of SETTING_FILE_OWNERS) {
		const fields = keys.map((key) => FIELD.get(key) as SettingField).filter((field) => field.owner === owner);
		if (!fields.length) continue;
		const status = snapshot.owners.find((row) => row.owner === owner);
		if (!status) throw new Refusal(500, `no snapshot row for ${owner}`);
		if (status.state === "invalid" || status.state === "unstable") throw new Refusal(409, `${status.path} is ${status.state}${status.error ? ` (${status.error})` : ""}; fix ${status.path} by hand first`);
		const file = join(home, status.path);
		let prior: Buffer | null;
		try {
			prior = readFileSync(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Refusal(409, `${status.path} is unreadable; fix ${status.path} by hand first`);
			prior = null;
		}
		if ((prior === null ? null : sha256(prior)) !== status.sha256) throw new Refusal(409, `${status.path} changed while this request was planned; reload and retry`);
		if (prior === null && request.mode === "restore") continue; // restore never creates an owner file
		let doc: Record<string, unknown>;
		if (prior === null) doc = baseDocument(owner, status.path);
		else {
			let parsed: unknown;
			try {
				parsed = JSON.parse(prior.toString("utf8"));
			} catch {
				parsed = undefined;
			}
			if (!isObject(parsed)) throw new Refusal(409, `${status.path} is not a JSON object; fix ${status.path} by hand first`);
			doc = parsed;
		}
		const before = JSON.stringify(doc);
		const changes: Change[] = [];
		for (const field of fields) {
			const fileKey = field.file_key as string;
			const view = snapshot.fields.find((row) => row.key === field.key);
			const old = { old: view?.value ?? null, old_source: view?.source ?? "none" };
			const present = hasAt(doc, fileKey);
			let action: "set" | "delete" = "set";
			let value: SettingValue;
			if (request.mode === "set") value = request.changes[field.key] as SettingValue;
			else {
				const restore = RESTORE_ACTIONS[field.key];
				if (restore === "installer_seed") installed ??= installedHome(home);
				if (restore === "default") value = field.default;
				else if (restore === "installer_seed" && installed) value = INSTALLER_UPDATE_SEED[fileKey as keyof typeof INSTALLER_UPDATE_SEED];
				else if (restore === "installer_seed" && field.key === "maintenance.update_enabled") value = field.default;
				else {
					action = "delete";
					value = field.default;
				}
			}
			if (action === "delete") {
				if (!present.found) continue;
				deleteAt(doc, fileKey);
			} else {
				if (present.found && JSON.stringify(present.value) === JSON.stringify(value)) continue;
				setAt(doc, fileKey, value);
			}
			changes.push({ key: field.key, file_key: fileKey, action, ...old, new: value, expected: value });
		}
		const schema = OWNER_SCHEMA[owner];
		if (schema !== undefined) {
			const checked = validate(schema, doc);
			if (!checked.ok) throw new Refusal(400, `${status.path} would violate its owner schema`, checked.errors);
		}
		if (!changes.length || JSON.stringify(doc) === before) continue;
		let mode: number | undefined;
		try {
			mode = prior === null ? (owner === "update" ? 0o600 : undefined) : statSync(file).mode & 0o777;
		} catch {
			throw new Refusal(409, `${status.path} cannot be stat'ed; fix ${status.path} by hand first`);
		}
		writes.push({ owner, path: status.path, file, prior, next: `${JSON.stringify(doc, null, 2)}\n`, mode, changes });
	}
	return writes;
}

const publicChanges = (writes: Write[]): PlannedChange[] => writes.flatMap((write) => write.changes.map(({ expected: _expected, ...change }) => change));

/** The same planner a dry run and a real apply use: `{state: "planned"}` or the refusal, nothing written. */
export function planSettings(home: string, snapshot: SettingsSnapshot, request: SettingsWriteRequest): SettingsApplyResult {
	try {
		const writes = planWrites(home, snapshot, request);
		return { status: 200, state: "planned", revision: snapshot.revision, changes: publicChanges(writes) };
	} catch (error) {
		if (error instanceof Refusal) return { status: error.status, state: "refused", error: redact(error.message, home), ...(error.errors ? { errors: error.errors } : {}) };
		throw error;
	}
}

function redact(text: string, home: string): string {
	return text.split(home).join("<home>").slice(0, 1000);
}

/** The last ≤64 KiB of the audit file, as lines (the first may be a fragment when the file is larger). */
function tailLines(file: string): { lines: string[]; partialFirst: boolean } {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], partialFirst: false };
		throw error;
	}
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, AUDIT_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return { lines: buffer.toString("utf8").split("\n").filter((line) => line.trim()), partialFirst: size > length };
	} finally {
		closeSync(fd);
	}
}

/** The newest `max` parseable audit lines, oldest first. A log for the dashboard, never configuration. */
export function readSettingsAudit(home: string, max = 20): SettingsAuditLine[] {
	let tail: ReturnType<typeof tailLines>;
	try {
		tail = tailLines(settingsAuditFile(home));
	} catch {
		return [];
	}
	const lines = tail.partialFirst ? tail.lines.slice(1) : tail.lines;
	const out: SettingsAuditLine[] = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line) as SettingsAuditLine);
		} catch {
			// a torn line is skipped here; the writer fails closed on it (recover)
		}
	}
	return out.slice(-max);
}

/** Step 2: a dangling `intent` (the last line, no terminal after it) is finalised once as `recovered`. */
function recover(home: string, append: (line: SettingsAuditLine) => void, at: string): void {
	const { lines } = tailLines(settingsAuditFile(home));
	const last = lines.at(-1);
	if (last === undefined) return;
	let line: SettingsAuditLine;
	try {
		line = JSON.parse(last) as SettingsAuditLine;
	} catch {
		throw new Refusal(503, `${join(LAYOUT.data, "settings-audit.jsonl")} ends in a line that is not JSON; inspect it before any settings write`);
	}
	if (line.type !== "intent") return;
	const owners = line.writes.map((write) => {
		let current: string | null;
		try {
			current = sha256(readFileSync(join(home, write.path)));
		} catch {
			current = null;
		}
		const state = current === write.next_sha256 ? "applied" : current === write.prior_sha256 ? "not_written" : "changed_since";
		return { owner: write.owner, state } as const;
	});
	append({ v: 1, type: "recovered", id: line.id, at, owners });
}

export function applySettings(home: string, input: SettingsApplyInput, seams: SettingsWriteSeams = {}): SettingsApplyResult {
	const env = input.env ?? process.env;
	const now = input.now ?? (() => new Date());
	const at = () => isoTimestamp(now());
	if (input.dry_run) {
		const snapshot = readSettings(home, env);
		return { ...planSettings(home, snapshot, input.request), snapshot };
	}
	if (input.expected_revision === null) return { status: 428, state: "refused", error: "If-Match is required: send the revision you last read" };
	const auditFile = settingsAuditFile(home);
	const appendText = seams.append ?? ((file: string, text: string) => durableAppend(file, text, { mode: 0o600 }));
	const append = (line: SettingsAuditLine) => appendText(auditFile, `${JSON.stringify(line)}\n`);
	const writeText = seams.writeText ?? ((file: string, text: string, options: { mode?: number; syncDir: boolean }) => atomicWriteText(file, text, options));
	const lock = acquireSettingsLock(home, { isPidAlive: seams.isPidAlive, onBeforeReclaim: seams.onBeforeReclaim, now });
	if (!lock.ok) return { status: 409, state: "refused", error: redact(lock.reason, home) };
	const refused = (status: number, reason: string, extra: Partial<SettingsApplyResult> = {}): SettingsApplyResult => {
		let audit: string | undefined;
		try {
			append({ v: 1, type: "refused", id: null, at: at(), actor: input.actor, peer: input.peer, request_id: input.request_id, status, reason });
		} catch (error) {
			audit = `unwritten: ${redact(message(error), home)}`;
		}
		return { status, state: status === 412 ? "stale" : "refused", error: reason, ...extra, ...(audit ? { audit } : {}) };
	};
	try {
		try {
			recover(home, append, at());
		} catch (error) {
			if (error instanceof Refusal) return { status: error.status, state: "refused", error: error.message };
			return { status: 503, state: "refused", error: `audit unwritable; nothing written (${redact(message(error), home)})` };
		}
		const snapshot = readSettings(home, env);
		if (input.expected_revision !== snapshot.revision) return refused(412, "the settings changed since this page read them; review the fresh snapshot", { revision: snapshot.revision, snapshot });
		let writes: Write[];
		try {
			writes = planWrites(home, snapshot, input.request);
		} catch (error) {
			if (error instanceof Refusal) return refused(error.status, redact(error.message, home), error.errors ? { errors: error.errors } : {});
			throw error;
		}
		if (!writes.length) return { status: 200, state: "unchanged", revision: snapshot.revision, snapshot };
		const id = newId(now());
		try {
			append({
				v: 1, type: "intent", id, at: at(), actor: input.actor, peer: input.peer, request_id: input.request_id, mode: input.request.mode, base_revision: snapshot.revision,
				writes: writes.map((write) => ({ owner: write.owner, path: write.path, prior_sha256: write.prior === null ? null : sha256(write.prior), next_sha256: sha256(write.next), changes: publicChanges([write]) })),
			});
		} catch (error) {
			return { status: 503, state: "refused", error: `audit unwritable; nothing written (${redact(message(error), home)})` };
		}
		const rollback = (touched: Write[]) => touched.map((write) => {
			try {
				if (write.prior === null) rmSync(write.file, { force: true });
				else atomicWriteText(write.file, write.prior.toString("utf8"), { mode: write.mode, syncDir: true });
				return { owner: write.owner, ok: true };
			} catch (error) {
				return { owner: write.owner, ok: false, error: redact(message(error), home) };
			}
		});
		const fail = (status: number, reason: string, touched: Write[]): SettingsApplyResult => {
			const rolled_back = rollback(touched);
			let audit: string | undefined;
			try {
				append({ v: 1, type: "failed", id, at: at(), reason, rolled_back });
			} catch (error) {
				audit = `unwritten: ${redact(message(error), home)}`;
			}
			return { status, state: "failed", error: reason, ...(audit ? { audit } : {}) };
		};
		for (const [index, write] of writes.entries()) {
			try {
				writeText(write.file, write.next, { mode: write.mode, syncDir: true });
			} catch (error) {
				// The failed owner is restored too: its rename may have landed before the directory fsync failed.
				return fail(500, `writing ${write.path} failed: ${redact(message(error), home)}; earlier owners rolled back`, writes.slice(0, index + 1));
			}
		}
		const after = (seams.readBack ?? readSettings)(home, env);
		const mismatch = writes.flatMap((write) => {
			const owner = after.owners.find((row) => row.owner === write.owner);
			const bad = owner?.state === "valid" ? [] : [`${write.path} reads back ${owner?.state ?? "missing"}`];
			for (const change of write.changes) {
				const view = after.fields.find((row) => row.key === change.key);
				if (view?.status !== "ok" || JSON.stringify(view.value) !== JSON.stringify(change.expected)) bad.push(`${change.key} reads back ${JSON.stringify(view?.value ?? null)} (${view?.status ?? "missing"})`);
			}
			return bad;
		});
		if (mismatch.length) return fail(500, `read-back disagrees: ${mismatch.join("; ")}; every owner rolled back`, writes);
		let audit_warning: string | undefined;
		try {
			append({ v: 1, type: "applied", id, at: at(), revision: after.revision });
		} catch (error) {
			audit_warning = `applied, but the audit line is unwritten (${redact(message(error), home)}); the next settings write records it as recovered`;
		}
		return { status: 200, state: "applied", revision: after.revision, snapshot: after, changes: publicChanges(writes), ...(audit_warning ? { audit_warning } : {}) };
	} finally {
		lock.release();
	}
}
