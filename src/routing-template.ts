/**
 * routing-template-v1: once per home, a data/routing.json with an earlier shipped rubric's row structure becomes the
 * shipped template; each surviving row keeps its own model, fallbacks, thinking, driver and note (docs/contracts.md).
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type DoctorFinding, LAYOUT, type RoutingConfig, RoutingConfigSchema, type RoutingRule, validate,
} from "./contracts.ts";
import { atomicWriteText, durableAppend } from "./json-store.ts";
import { boundedList, loadRoutingConfig } from "./routing.ts";
import { routingRowRefusals } from "./routing-row-checks.ts";
import type { ScaffoldStep } from "./scaffold.ts";
import { acquireSettingsLock } from "./settings-lock.ts";
import { DurableWakeupOutbox } from "./wakeup-outbox.ts";

export const ROUTING_TEMPLATE_MIGRATION = "routing-template-v1";
const STEP = "routing.template";
const TEMPLATE_PATH = "defaults/routing.default.json";
const SHAPE_KEYS = ["id", "role", "scope", "risk", "project"] as const;
const CARRIED_KEYS = ["model", "fallbacks", "thinking", "driver", "note"] as const;
type Row = Record<string, unknown>;
interface Shipped { version: string; rows: readonly Row[] }

const ROWS_8DD7D2C: readonly Row[] = [
	{ id: "risky-any", role: "planner", risk: "high" },
	{ id: "risky-ship", role: "implementer", risk: "high" },
	{ id: "reviews", role: "gate-reviewer" },
	{ id: "research-big", role: "planner", scope: ["L"] },
	{ id: "big-ship", role: "implementer", scope: ["M", "L"] },
	{ id: "small-ship", role: "implementer", scope: ["S"] },
	{ id: "planner-default", role: "planner" },
];
/** Earlier shipped templates' row structure, newest first (`git log -- defaults/routing.default.json`). */
export const EARLIER_SHIPPED_ROUTING: readonly Shipped[] = [
	{ version: "8dd7d2c (#703)", rows: ROWS_8DD7D2C },
	{ version: "ea63179 (initial release)", rows: ROWS_8DD7D2C.slice(0, 6) },
];
/** The earlier row each template row keeps its values from. */
const SOURCE: Readonly<Record<string, string>> = {
	reviews: "reviews",
	"implementer-small": "small-ship",
	"implementer-default": "big-ship",
	"planner-default": "planner-default",
};

interface JournalLine {
	migration: string;
	at: string;
	outcome: "intent" | "done";
	from?: string;
	backup?: string;
	ids?: string[];
	text?: string;
	notice?: string;
	before_sha256?: string;
	after_sha256?: string;
	notice_queued?: boolean;
}
interface Migration {
	from: string;
	ids: string[];
	text: string;
	carried: string[];
	dropped: string[];
	fellBack: string[];
	blocked: string[];
}
type Shape =
	| { kind: "current" }
	| { kind: "earlier"; version: string }
	| { kind: "edited"; against: string; differs: string[]; retired: boolean };

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const pick = (row: Row, names: readonly string[]): Row =>
	Object.fromEntries(names.filter((name) => name in row).map((name) => [name, structuredClone(row[name])]));
const shown = (value: unknown): string =>
	(value === undefined ? "absent" : typeof value === "string" ? value : JSON.stringify(value));
const sameShape = (row: Row, shipped: Row): boolean =>
	SHAPE_KEYS.every((name) => isDeepStrictEqual(row[name], shipped[name]));
const isRecipe = (row: Row): boolean => row.driver === "claude"
	&& isDeepStrictEqual(pick(row, SHAPE_KEYS), { id: "native-research", role: "planner", scope: ["S"] });
const isAppended = (row: Row, appended: readonly string[]): boolean => appended.includes(String(row.id))
	&& /^(.+)-default(?:-migrated)?$/.exec(String(row.id))?.[1] === row.role
	&& !("scope" in row || "risk" in row || "project" in row);

/** This migration's journal lines in file order; a torn line (a crash mid-append) is not a fact. */
export function readTemplateJournal(home: string): JournalLine[] {
	const file = join(home, LAYOUT.routingMigrationsFile);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").flatMap((line) => {
		try {
			const parsed = JSON.parse(line) as JournalLine;
			return parsed?.migration === ROUTING_TEMPLATE_MIGRATION ? [parsed] : [];
		} catch {
			return [];
		}
	});
}

/** A valid routing document against the shipped rubrics; `appended` are role-defaults-v1's done ids. */
function classify(doc: Row, template: readonly Row[], appended: readonly string[]): Shape {
	const top = [
		...Object.keys(doc).filter((name) => !["schema_version", "allow", "rubric"].includes(name))
			.map((name) => `${name} (not in a shipped file)`),
		...(doc.schema_version === 1 ? [] : [`schema_version ${shown(doc.schema_version)} (shipped 1)`]),
		...(isDeepStrictEqual(doc.allow, ["*/*"]) ? [] : [`allow ${JSON.stringify(doc.allow)} (shipped ["*/*"])`]),
	];
	const rubric = doc.rubric as Row[];
	const body = rubric.filter(isRecipe).length === 1 ? rubric.filter((row) => !isRecipe(row)) : rubric;
	let tail = 0;
	while (tail < body.length && isAppended(body[body.length - 1 - tail]!, appended)) tail += 1;
	const versions: readonly Shipped[] = [{ version: "the current template", rows: template }, ...EARLIER_SHIPPED_ROUTING];
	for (let k = tail; k >= 0; k -= 1) {
		const rows = body.slice(0, body.length - k);
		const hit = versions.find((v) => v.rows.length === rows.length && rows.every((row, i) => sameShape(row, v.rows[i]!)));
		if (hit?.rows === template) return { kind: "current" };
		if (hit && top.length === 0) return { kind: "earlier", version: hit.version };
	}
	const rows = body.slice(0, body.length - tail);
	const ids = rows.map((row) => String(row.id));
	const overlap = (v: Shipped): number => v.rows.filter((row) => ids.includes(String(row.id))).length;
	const against = versions.reduce((best, v) => (overlap(v) > overlap(best) ? v : best));
	const shippedIds = against.rows.map((row) => String(row.id));
	const differs = [...top];
	for (const row of rows) {
		const shipped = against.rows.find((each) => each.id === row.id);
		if (!shipped) differs.push(`${String(row.id)} (not a shipped row)`);
		else for (const prop of SHAPE_KEYS.slice(1)) {
			if (isDeepStrictEqual(row[prop], shipped[prop])) continue;
			differs.push(`${String(row.id)}: ${prop} ${shown(row[prop])} (shipped ${shown(shipped[prop])})`);
		}
	}
	for (const id of shippedIds) if (!ids.includes(id)) differs.push(`${id} (missing)`);
	const order = (a: string[], b: string[]) => a.filter((id) => b.includes(id));
	if (!isDeepStrictEqual(order(ids, shippedIds), order(shippedIds, ids))) differs.push("row order");
	const earlier = new Set(EARLIER_SHIPPED_ROUTING.flatMap((v) => v.rows.map((row) => String(row.id))));
	const retired = ids.some((id) => earlier.has(id) && !template.some((row) => row.id === id));
	return { kind: "edited", against: against.version, differs, retired };
}

/** Template ids, roles, scope, risk and project; each source row's own values; rule 5 only for a refused value. */
function plan(
	home: string, config: RoutingConfig, rubric: readonly Row[], from: string, templateText: string,
): Migration {
	const template = JSON.parse(templateText) as Row & { rubric: Row[] };
	const byId = new Map(rubric.map((row) => [String(row.id), row]));
	const used = new Set<string>();
	const carried: string[] = [], fellBack: string[] = [], blocked: string[] = [];
	const refusals = (row: Row) => routingRowRefusals(home, config, row as unknown as RoutingRule);
	const rows = template.rubric.map((shipped) => {
		const sourceId = SOURCE[String(shipped.id)];
		const source = sourceId === undefined ? undefined : byId.get(sourceId);
		if (!source || sourceId === undefined) {
			carried.push(`${String(shipped.id)} <- the template (no ${sourceId ?? "earlier"} row)`);
			return structuredClone(shipped);
		}
		used.add(sourceId);
		carried.push(`${String(shipped.id)} <- ${sourceId}`);
		const row: Row = { ...pick(shipped, SHAPE_KEYS), ...pick(source, CARRIED_KEYS) };
		for (const field of ["model", "thinking", "driver"] as const) {
			const refused = refusals(row).filter((each) => field === "driver" || each.field === field);
			if (refused.length === 0) continue;
			const was = shown(row[field]);
			if (field in shipped) row[field] = structuredClone(shipped[field]);
			else delete row[field];
			fellBack.push(`${String(shipped.id)}.${field} ${was} -> ${shown(row[field])} (${refused[0]!.message})`);
		}
		blocked.push(...refusals(row).map((each) => each.message));
		return row;
	});
	const doc = { schema_version: template.schema_version, allow: structuredClone(template.allow), rubric: rows };
	const valid = validate(RoutingConfigSchema, doc);
	if (!valid.ok) blocked.push(...valid.errors);
	const dropped = rubric.filter((row) => !used.has(String(row.id)))
		.map((row) => `${String(row.id)} (${String(row.model).slice(0, 128)}, ${String(row.driver ?? "pi")})`);
	const text = isDeepStrictEqual(doc, template) ? templateText : `${JSON.stringify(doc, null, 2)}\n`;
	return { from, ids: rows.map((row) => String(row.id)), text, carried, dropped, fellBack, blocked };
}

function noticeText(m: Migration, file: string, backup: string): string {
	return [
		`ROUTING TEMPLATE REPLACED — ${file} had the shipped ${m.from} rows; it now holds ${m.ids.join(", ")}.`,
		`Carried as they were (model, fallbacks, thinking, driver, note): ${m.carried.join("; ")}.`
			+ " Scope and risk are the template's.",
		`Dropped, kept only in the backup: ${boundedList(m.dropped, { max: 20, cap: 1200 }) || "none"}.`,
		`Fell back to the template: ${boundedList(m.fellBack, { max: 20, cap: 1200 }) || "none"}.`,
		`Backup: ${backup}. Undo: copy the backup over ${file}; routing-template-v1 never runs twice on a home.`,
	].join("\n").slice(0, 4000);
}

type Recorder = (line: Omit<JournalLine, "migration" | "at">) => void;

function finish(home: string, intent: JournalLine, record: Recorder): ScaffoldStep {
	const done = {
		outcome: "done" as const, from: intent.from, backup: intent.backup, ids: intent.ids,
		before_sha256: intent.before_sha256, after_sha256: intent.after_sha256,
	};
	try {
		const id = `${ROUTING_TEMPLATE_MIGRATION}:${String(intent.before_sha256).slice(0, 16)}`;
		new DurableWakeupOutbox({ home }).enqueue({ id, kind: "recovery", content: String(intent.notice) });
	} catch (error) {
		record({ ...done, notice_queued: false });
		const why = (error as Error).message;
		return { step: STEP, action: "created", detail: `${intent.notice} (the durable notice was not queued: ${why})` };
	}
	record(done);
	const detail = `replaced the ${intent.from} rows; backup ${intent.backup}`;
	return { step: STEP, action: "created", quiet: true, detail };
}

/** Scaffold step `routing.template`: quiet on success, because its one report is the durable `recovery` wake. */
export function routingTemplateStep(home: string, packageRoot: string, appended: readonly string[]): ScaffoldStep {
	const journal = readTemplateJournal(home);
	if (journal.some((line) => line.outcome === "done")) return { step: STEP, action: "present" };
	const file = join(home, LAYOUT.routingFile), source = join(packageRoot, TEMPLATE_PATH);
	if (!existsSync(file)) return { step: STEP, action: "skipped", detail: `no ${LAYOUT.routingFile}` };
	if (!existsSync(source)) return { step: STEP, action: "skipped", detail: `no shipped template at ${source}` };
	const record: Recorder = (line) => durableAppend(join(home, LAYOUT.routingMigrationsFile),
		`${JSON.stringify({ migration: ROUTING_TEMPLATE_MIGRATION, at: new Date().toISOString(), ...line })}\n`);
	try {
		const sha = sha256(readFileSync(file));
		const pending = journal.filter((line) => line.outcome === "intent").at(-1);
		let intent = pending && (pending.before_sha256 === sha || pending.after_sha256 === sha) ? pending : undefined;
		let next: Migration | undefined;
		if (!intent) {
			let doc: Row, config: RoutingConfig;
			try {
				doc = JSON.parse(readFileSync(file, "utf8")) as Row;
				config = loadRoutingConfig(home);
			} catch (error) {
				const why = (error as Error).message.split("\n")[0];
				return { step: STEP, action: "skipped", detail: `${why} (config.routing reports it)` };
			}
			const templateText = readFileSync(source, "utf8");
			const shape = classify(doc, (JSON.parse(templateText) as { rubric: Row[] }).rubric, appended);
			if (shape.kind !== "earlier") return { step: STEP, action: "present" };
			next = plan(home, config, doc.rubric as Row[], shape.version, templateText);
			if (next.blocked.length) {
				const why = boundedList(next.blocked, { cap: 600 });
				const reset = "/doctor config.routing.template gives the manual reset";
				return { step: STEP, action: "failed", detail: `${file} keeps the ${shape.version} rows: ${why}; ${reset}` };
			}
		}
		const lock = acquireSettingsLock(home);
		if (!lock.ok) return { step: STEP, action: "skipped", detail: `${lock.reason}; retried at the next session start` };
		try {
			if (sha256(readFileSync(file)) !== sha) {
				const detail = `${file} changed while this step ran; retried at the next session start`;
				return { step: STEP, action: "skipped", detail };
			}
			if (!intent && next) {
				const backup = `${file}.bak-${new Date().toISOString().replace(/[-:]|\.\d{3}/g, "")}`;
				const fields = {
					outcome: "intent" as const, from: next.from, backup, ids: next.ids, text: next.text,
					notice: noticeText(next, file, backup), before_sha256: sha, after_sha256: sha256(next.text),
				};
				record(fields);
				intent = { migration: ROUTING_TEMPLATE_MIGRATION, at: "", ...fields };
			}
			if (!intent) return { step: STEP, action: "present" };
			if (sha === intent.before_sha256) {
				const mode = statSync(file).mode & 0o777, backup = String(intent.backup);
				if (existsSync(backup)) {
					if (sha256(readFileSync(backup)) !== sha) {
						return { step: STEP, action: "failed", detail: `${backup} exists and differs from ${file}; nothing written` };
					}
				} else {
					const tmp = `${backup}.${process.pid}.tmp`;
					copyFileSync(file, tmp);
					chmodSync(tmp, mode);
					renameSync(tmp, backup);
				}
				atomicWriteText(file, String(intent.text), { mode, syncDir: true });
			}
			return finish(home, intent, record);
		} finally {
			lock.release();
		}
	} catch (error) {
		return { step: STEP, action: "failed", detail: (error as Error).message };
	}
}

/** Doctor `config.routing.template`: today's rows, an earlier shipped set, or an edited rubric and its manual reset. */
export function routingTemplateFindings(
	home: string, packageRoot: string, appended: readonly string[],
): DoctorFinding[] {
	const check = "config.routing.template";
	const file = LAYOUT.routingFile, source = join(packageRoot, TEMPLATE_PATH);
	let doc: Row, config: RoutingConfig, templateText: string;
	try {
		doc = JSON.parse(readFileSync(join(home, file), "utf8")) as Row;
		config = loadRoutingConfig(home);
		templateText = readFileSync(source, "utf8");
	} catch {
		return []; // no file or an invalid one is config.routing's finding; no template, nothing to compare
	}
	const template = (JSON.parse(templateText) as { rubric: Row[] }).rubric;
	const shape = classify(doc, template, appended);
	const done = readTemplateJournal(home).find((line) => line.outcome === "done");
	const replaced = done && `routing-template-v1 replaced the ${done.from} rows at ${done.at}; backup ${done.backup}`;
	const full = `cd ${home} && cp -p ${file} ${file}.bak-$(date -u +%Y%m%dT%H%M%SZ) && cp ${source} ${file}`;
	const short = `from the home: cp -p ${file} ${file}.bak-<UTC> && cp app/${TEMPLATE_PATH} ${file}`;
	const reset = full.length <= 330 ? full : short;
	const fix = `back up, then reset by hand: ${reset}`;
	if (shape.kind === "current") {
		const what = `${file} has the shipped rows: ${template.map((row) => String(row.id)).join(", ")}`;
		return [{ check, severity: "ok", what, ...(replaced ? { detail: replaced } : {}) }];
	}
	if (shape.kind === "earlier") {
		const what = `${file} still has the shipped ${shape.version} rows`;
		if (done) {
			const detail = `${replaced}; the old rows are back and the migration never runs twice`;
			return [{ check, severity: "warn", what, detail, fix }];
		}
		const blocked = plan(home, config, doc.rubric as Row[], shape.version, templateText).blocked;
		if (blocked.length) {
			const detail = boundedList(blocked, { cap: 1500 });
			return [{ check, severity: "warn", what: `${what}; not replaced`, detail, fix }];
		}
		return [{
			check, severity: "warn", what: `${what}; the next session start replaces it`,
			detail: "routing-template-v1 keeps each surviving row's model, fallbacks, thinking, driver and note",
			fix: "start a new pi session on this home (a busy state/settings.lock defers it to the start after)",
		}];
	}
	const what = `${file} is not an unedited shipped rubric (closest: ${shape.against}); left as it is`.slice(0, 200);
	const differs = boundedList(shape.differs, { cap: 1400 });
	if (shape.retired) {
		const restore = "or restore the named rows' id, order, role, scope, risk and project and start a new session";
		return [{ check, severity: "warn", what, detail: differs, fix: `${fix}; ${restore}` }];
	}
	const detail = `${differs}. To adopt the shipped rows, back up, then reset by hand: ${reset}`.slice(0, 2000);
	return [{ check, severity: "ok", what, detail }];
}
