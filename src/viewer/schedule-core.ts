/**
 * The dependency-free core of saved schedules, shared by `src/scheduler.ts`
 * (which re-exports all of it) and the viewer's Schedules page: the cron, watch and manual triggers, the optional
 * manual-only `job.skill`, the
 * `state/schedules.json` schema and reader, and the cron engine. It lives under
 * `src/viewer/` because viewer modules may import only `node:` and `./` (see
 * tests/viewer-workbench.test.ts); nothing here writes, spawns or touches typebox.
 * JOB_KINDS, DELIVERIES, MANDATE_ID_PATTERN and SCHEMA_VERSION are mirrored from
 * src/contracts; tests/viewer-schedules.test.ts pins the mirror to them.
 */
import { existsSync, readFileSync } from "node:fs";

export class SchedulerError extends Error {}

// ---------------------------------------------------------------------------
// Schema: `{schema_version: 1, schedules: Schedule[]}`, no extra keys anywhere.
// ---------------------------------------------------------------------------

export const SCHEDULE_JOB_KINDS = ["ship", "research"] as const;
export const SCHEDULE_DELIVERIES = ["pr", "local", "pipeline", "answer", "board"] as const;
export const SCHEDULE_MANDATE_ID = /^md-[a-z0-9]{4,16}$/;
export const SCHEDULE_ID = /^sch-[0-9a-f]{6}$/;
export const SCHEDULE_SCHEMA_VERSION = 1;
/** Skills a manual schedule may name: its fire records a deferred anchor and wakes the parent to expand it. */
export const SCHEDULE_SKILLS = ["cp-self-review"] as const;

export interface Schedule {
	id: string;
	name: string;
	project: string;
	mandate_id: string;
	/** `manual`: no tick ever fires it; only Run now does. */
	trigger: { type: "cron"; cron: string; tz: string } | { type: "watch"; script_path: string; every_seconds: number; on: "exit0" | "changed" } | { type: "manual" };
	job: { title: string; kind: (typeof SCHEDULE_JOB_KINDS)[number]; delivery: (typeof SCHEDULE_DELIVERIES)[number]; description?: string; script_path?: string; skill?: (typeof SCHEDULE_SKILLS)[number] };
	enabled: boolean;
	created_at: string;
	/** Cron: the instant slots were last evaluated up to. Watch: when the script last ran. */
	last_checked_at?: string;
	last_output_sha?: string;
	last_fire?: { at: string; slot: string; job_id: string; missed: boolean };
	last_skip?: { at: string; reason: string };
}

type Check = (value: unknown, path: string, errors: string[]) => void;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const line = (max: number): Check => (v, path, errors) => {
	if (typeof v !== "string" || v.length < 1 || v.length > max || !/^[^\r\n]+$/.test(v)) errors.push(`${path}: must be one line of 1-${max} characters`);
};
const string: Check = (v, path, errors) => { if (typeof v !== "string") errors.push(`${path}: must be a string`); };
const boolean: Check = (v, path, errors) => { if (typeof v !== "boolean") errors.push(`${path}: must be a boolean`); };
const pattern = (re: RegExp): Check => (v, path, errors) => { if (typeof v !== "string" || !re.test(v)) errors.push(`${path}: must match ${re.source}`); };
const oneOf = (values: readonly unknown[]): Check => (v, path, errors) => { if (!values.includes(v)) errors.push(`${path}: must be one of ${values.join(", ")}`); };
/** An object with exactly these keys; a key whose name ends in `?` is optional. */
const object = (shape: Record<string, Check>): Check => (v, path, errors) => {
	if (!isObject(v)) { errors.push(`${path || "/"}: must be an object`); return; }
	const fields = new Map(Object.entries(shape).map(([key, check]) => [key.replace(/\?$/, ""), { check, optional: key.endsWith("?") }]));
	for (const key of Object.keys(v)) if (!fields.has(key)) errors.push(`${path}/${key}: unexpected property`);
	for (const [key, { check, optional }] of fields) {
		if (v[key] === undefined) { if (!optional) errors.push(`${path}/${key}: is required`); continue; }
		check(v[key], `${path}/${key}`, errors);
	}
};

const cronTrigger = object({ type: oneOf(["cron"]), cron: line(200), tz: line(64) });
const manualTrigger = object({ type: oneOf(["manual"]) });
const watchTrigger = object({
	type: oneOf(["watch"]), script_path: line(1000), on: oneOf(["exit0", "changed"]),
	every_seconds: (v, path, errors) => { if (!Number.isInteger(v) || (v as number) < 30 || (v as number) > 86_400) errors.push(`${path}: must be an integer 30-86400`); },
});
const schedule = object({
	id: pattern(SCHEDULE_ID), name: line(80), project: line(64), mandate_id: pattern(SCHEDULE_MANDATE_ID),
	trigger: (v, path, errors) => (isObject(v) && v.type === "watch" ? watchTrigger : isObject(v) && v.type === "manual" ? manualTrigger : cronTrigger)(v, path, errors),
	job: object({
		title: line(200), kind: oneOf(SCHEDULE_JOB_KINDS), delivery: oneOf(SCHEDULE_DELIVERIES),
		"description?": (v, path, errors) => { if (typeof v !== "string" || v.length > 4000) errors.push(`${path}: must be a string of at most 4000 characters`); },
		"script_path?": line(1000), "skill?": oneOf(SCHEDULE_SKILLS),
	}),
	enabled: boolean, created_at: string, "last_checked_at?": string, "last_output_sha?": string,
	"last_fire?": object({ at: string, slot: string, job_id: string, missed: boolean }),
	"last_skip?": object({ at: string, reason: string }),
});
const scheduleFile = object({
	schema_version: oneOf([SCHEDULE_SCHEMA_VERSION]),
	schedules: (v, path, errors) => { if (!Array.isArray(v)) errors.push(`${path}: must be an array`); else v.forEach((item, i) => schedule(item, `${path}/${i}`, errors)); },
});

/** The schedule file contract: its errors (at most 10), or none when `value` is a valid file. */
export function scheduleFileErrors(value: unknown): string[] {
	const errors: string[] = [];
	scheduleFile(value, "", errors);
	return errors.slice(0, 10);
}

/** `state/schedules.json`: [] when absent, a SchedulerError naming the file when it is not valid. */
export function readScheduleFile(file: string): Schedule[] {
	if (!existsSync(file)) return [];
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new SchedulerError(`${file} is not valid JSON (${(error as Error).message}); refusing to guess`); }
	const errors = scheduleFileErrors(raw);
	if (errors.length) throw new SchedulerError(`${file} violates the schedule contract:\n  ${errors.join("\n  ")}`);
	return (raw as { schedules: Schedule[] }).schedules;
}

// ---------------------------------------------------------------------------
// Cron: five fields (minute hour day-of-month month day-of-week), numbers,
// `*`, ranges, lists and `/step`. Day-of-month and day-of-week restricted
// together match either one, as in classic cron. No names, no `L`/`W`/`#`.
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
/** Catch-up never looks back (and the next slot never looks ahead) further than this. */
const CRON_LOOKBACK_MS = 366 * 24 * 60 * MINUTE;

export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

function parseField(text: string, min: number, max: number, what: string): Set<number> {
	const out = new Set<number>();
	for (const part of text.split(",")) {
		const match = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
		if (!match) throw new SchedulerError(`cron ${what} ${JSON.stringify(part)}: use *, N, N-M, lists and /step`);
		const step = match[3] ? Number(match[3]) : 1;
		const lo = match[1] !== undefined ? Number(match[1]) : min;
		const hi = match[2] !== undefined ? Number(match[2]) : match[1] !== undefined && !match[3] ? lo : max;
		if (step < 1 || lo < min || hi > max || lo > hi) throw new SchedulerError(`cron ${what} ${JSON.stringify(part)} is outside ${min}-${max}`);
		for (let value = lo; value <= hi; value += step) out.add(value);
	}
	return out;
}

export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new SchedulerError(`cron ${JSON.stringify(expression)} needs 5 fields: minute hour day-of-month month day-of-week`);
	const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
	const days = parseField(dow, 0, 7, "day-of-week");
	if (days.delete(7)) days.add(0);
	return {
		minute: parseField(minute, 0, 59, "minute"), hour: parseField(hour, 0, 23, "hour"), dom: parseField(dom, 1, 31, "day-of-month"),
		month: parseField(month, 1, 12, "month"), dow: days, domStar: dom.startsWith("*"), dowStar: dow.startsWith("*"),
	};
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws on a time zone this runtime does not know. */
export function assertTimeZone(tz: string): void {
	try { formatter(tz); } catch { throw new SchedulerError(`unknown time zone ${JSON.stringify(tz)}: use an IANA name such as Europe/Warsaw or UTC`); }
}

function formatter(tz: string): Intl.DateTimeFormat {
	let found = formatters.get(tz);
	if (!found) {
		found = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
		formatters.set(tz, found);
	}
	return found;
}

function localParts(at: number, tz: string) {
	const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
	return { minute: Number(parts.minute), hour: Number(parts.hour) % 24, day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAYS.indexOf(parts.weekday ?? "") };
}

/** `at`'s wall-clock minute in `tz` (the year from UTC): equal for the two instants of a DST fall-back repeated minute. */
export function localMinuteKey(at: Date, tz: string): string {
	const p = localParts(at.getTime(), tz);
	return `${at.getUTCFullYear()}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Whether the local hour `p` can hold a slot (day, month and hour match); the minute is checked separately. */
function hourMatches(spec: CronSpec, p: ReturnType<typeof localParts>): boolean {
	const day = spec.domStar || spec.dowStar ? spec.dom.has(p.day) && spec.dow.has(p.weekday) : spec.dom.has(p.day) || spec.dow.has(p.weekday);
	return day && spec.month.has(p.month) && spec.hour.has(p.hour);
}

/** The latest cron slot in (after, upTo], in `tz`'s wall clock, or undefined. */
export function latestCronSlot(spec: CronSpec, tz: string, after: Date, upTo: Date): Date | undefined {
	const floor = Math.max(after.getTime(), upTo.getTime() - CRON_LOOKBACK_MS);
	// ponytail: walks back minute by minute inside a matching hour and hour by hour outside one (~30k steps for a yearly miss); compute the previous slot arithmetically if that ever shows up in a profile.
	for (let t = Math.floor(upTo.getTime() / MINUTE) * MINUTE; t > floor;) {
		const p = localParts(t, tz);
		if (!hourMatches(spec, p)) {
			t -= (p.minute + 1) * MINUTE; // to the previous local hour's :59
			continue;
		}
		if (spec.minute.has(p.minute)) return new Date(t);
		t -= MINUTE;
	}
	return undefined;
}

/** The first cron slot strictly after `after` (within a year), in `tz`'s wall clock, or undefined. The same walk as latestCronSlot, forwards. */
export function nextCronSlot(spec: CronSpec, tz: string, after: Date): Date | undefined {
	const ceiling = after.getTime() + CRON_LOOKBACK_MS;
	for (let t = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE; t <= ceiling;) {
		const p = localParts(t, tz);
		if (!hourMatches(spec, p)) {
			t += (60 - p.minute) * MINUTE; // to the next local hour's :00
			continue;
		}
		if (spec.minute.has(p.minute)) return new Date(t);
		t += MINUTE;
	}
	return undefined;
}
