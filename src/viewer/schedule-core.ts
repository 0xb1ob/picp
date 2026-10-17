/**
 * The dependency-free core of saved schedules, shared by `src/scheduler.ts`
 * (which re-exports all of it) and the viewer's Schedules page: the cron, watch and manual triggers, the optional
 * manual-only `job.skill`, the
 * `state/schedules.json` schema and reader, and the cron engine. It lives under
 * `src/viewer/` because viewer modules may import only `node:` and `./` (see
 * tests/viewer-workbench.test.ts); nothing here writes, spawns or touches typebox.
 * JOB_KINDS, DELIVERIES and MANDATE_ID_PATTERN are mirrored from src/contracts;
 * schedules have their own v2 file version (tests/viewer-schedules.test.ts).
 */
import { existsSync, readFileSync } from "node:fs";

export class SchedulerError extends Error {}

// ---------------------------------------------------------------------------
// Schema: `{schema_version: 1|2, schedules: Schedule[]}`, no extra keys anywhere.
// ---------------------------------------------------------------------------

export const SCHEDULE_JOB_KINDS = ["ship", "research"] as const;
export const SCHEDULE_DELIVERIES = ["pr", "local", "pipeline", "answer", "board"] as const;
export const SCHEDULE_MANDATE_ID = /^md-[a-z0-9]{4,16}$/;
export const SCHEDULE_ID = /^sch-[0-9a-f]{6}$/;
export const SCHEDULE_SCHEMA_VERSION = 2;
/**
 * Skills a manual schedule may name (the expander registry): its fire records a deferred anchor and wakes the parent to
 * expand it with `skills/<name>/SKILL.md`. Each is also a `PARENT_SKILLS` entry (src/cp-bridge.ts); tests pin the two.
 */
export const SCHEDULE_SKILLS = ["cp-self-review", "cp-pr-review", "cp-org-pr-review"] as const;
/** The anchor job each skill's schedule must record: its kind and delivery (no `script_path`). */
export const SCHEDULE_SKILL_ANCHOR: Record<(typeof SCHEDULE_SKILLS)[number], { kind: (typeof SCHEDULE_JOB_KINDS)[number]; delivery: (typeof SCHEDULE_DELIVERIES)[number] }> = {
	"cp-self-review": { kind: "research", delivery: "local" },
	"cp-pr-review": { kind: "research", delivery: "local" },
	"cp-org-pr-review": { kind: "research", delivery: "local" },
};

/** cp-org-pr-review: at most this many reviewers per fire (the default too); `max_reviewers:` may only lower it. */
export const ORG_REVIEW_MAX_REVIEWERS = 3;
export const ORG_REVIEW_MAX_TEAMS = 10;
export const ORG_REVIEW_MAX_HOLDS = 50;
/** A cp-org-pr-review schedule's description config (skills/cp-org-pr-review/SKILL.md); `user` null is the gh-authenticated user. */
export interface OrgReviewConfig { org: string; user: string | null; teams: string[]; holds: string[]; max_reviewers: number }
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const TEAM_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const HOLD_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/;
const ORG_REVIEW_KEYS = ["org", "user", "team", "hold", "max_reviewers", "pr"] as const;

/**
 * A cp-org-pr-review description's config lines: a trimmed line starting `<key>:` (key case-insensitive) for org, user,
 * team, hold or max_reviewers; every other line is prose, ignored by code and never forwarded to a reviewer. Throws a
 * SchedulerError naming the first fault: exactly one `org:` login, at most one `user:` login, 0-10 bare distinct team
 * slugs, 0-50 distinct PR urls in the org for `hold:`, `max_reviewers:` an integer 1-3 (default 3), and no `pr:` line.
 */
export function orgReviewConfig(description: string): OrgReviewConfig {
	const fail = (why: string): never => { throw new SchedulerError(`cp-org-pr-review: ${why}`); };
	const values = Object.fromEntries(ORG_REVIEW_KEYS.map((key) => [key, [] as string[]])) as Record<(typeof ORG_REVIEW_KEYS)[number], string[]>;
	for (const raw of description.split("\n")) {
		const match = /^(org|user|team|hold|max_reviewers|pr)\s*:(.*)$/i.exec(raw.trim());
		if (match) values[(match[1] as string).toLowerCase() as (typeof ORG_REVIEW_KEYS)[number]].push((match[2] as string).trim());
	}
	if (values.pr.length) fail("pr: lines belong to cp-pr-review; use hold: <url> to exclude a PR from the org queue");
	if (values.org.length !== 1) fail(`needs exactly one description line "org: <github-org>"; found ${values.org.length}`);
	const org = values.org[0] as string;
	if (!GITHUB_LOGIN.test(org)) fail(`org: ${JSON.stringify(org)} is not a GitHub login`);
	if (values.user.length > 1) fail(`at most one user: line; found ${values.user.length}`);
	const user = values.user[0] ?? null;
	if (user !== null && !GITHUB_LOGIN.test(user)) fail(`user: ${JSON.stringify(user)} is not a GitHub login`);
	if (values.team.length > ORG_REVIEW_MAX_TEAMS) fail(`at most ${ORG_REVIEW_MAX_TEAMS} team: lines; found ${values.team.length}`);
	for (const team of values.team) {
		if (team.includes("/")) fail(`team: ${JSON.stringify(team)}: give the bare team slug (it is always in ${org})`);
		if (!TEAM_SLUG.test(team)) fail(`team: ${JSON.stringify(team)} is not a team slug`);
	}
	if (values.hold.length > ORG_REVIEW_MAX_HOLDS) fail(`at most ${ORG_REVIEW_MAX_HOLDS} hold: lines; found ${values.hold.length}`);
	for (const hold of values.hold) {
		const owner = HOLD_URL.exec(hold)?.[1];
		if (owner === undefined) fail(`hold: ${JSON.stringify(hold)} is not a PR url (https://github.com/<owner>/<repo>/pull/<n>)`);
		if ((owner as string).toLowerCase() !== org.toLowerCase()) fail(`hold: ${hold} is not in ${org}`);
	}
	for (const [key, list] of [["team", values.team], ["hold", values.hold]] as const) {
		const dupe = list.find((item, i) => list.indexOf(item) !== i);
		if (dupe !== undefined) fail(`${key}: ${dupe} is listed twice`);
	}
	if (values.max_reviewers.length > 1) fail(`at most one max_reviewers: line; found ${values.max_reviewers.length}`);
	let max = ORG_REVIEW_MAX_REVIEWERS;
	if (values.max_reviewers.length) {
		const given = values.max_reviewers[0] as string;
		if (!/^[0-9]+$/.test(given)) fail(`max_reviewers ${JSON.stringify(given)} is not an integer 1-${ORG_REVIEW_MAX_REVIEWERS}`);
		max = Number(given);
		if (max > ORG_REVIEW_MAX_REVIEWERS) fail(`max_reviewers ${max} is over the cap ${ORG_REVIEW_MAX_REVIEWERS}`);
		if (max < 1) fail(`max_reviewers ${max} is under 1`);
	}
	return { org, user, teams: values.team, holds: values.hold, max_reviewers: max };
}

/** `orgReviewConfig(description).max_reviewers`, or the cap on any fault: never throws (a floor or a label cap reads it). */
export function orgReviewMaxReviewers(description?: string): number {
	try { return orgReviewConfig(description ?? "").max_reviewers; } catch { return ORG_REVIEW_MAX_REVIEWERS; }
}
/** A grant template's lifetime bound in hours: each fire grant lives this long from its fire. */
export const GRANT_TEMPLATE_MAX_HOURS = 168;
/** What a fire grant may auto-decide: never `merge` (mirrors MANDATE_ACTIONS minus merge). */
export const GRANT_TEMPLATE_ACTIONS = ["plan", "implement", "review", "repair"] as const;
/** Mirrors MANDATE_ASK_ON; a template always holds `merge` and `risk:high`. */
export const GRANT_TEMPLATE_ASK_ON = ["plan_approval", "merge", "risk:high"] as const;
export const GRANT_TEMPLATE_FORCED_ASK_ON = ["merge", "risk:high"] as const;
/** Mirrors MANDATE_CHANNELS; tests/viewer-schedules.test.ts pins the three mirrors. */
export const MANDATE_CHANNEL_VALUES = ["operator_chat", "bridge"] as const;

/** A pause the scheduler re-mints past; any other pause is the operator's. */
const GRANT_CAP_PAUSES: readonly unknown[] = ["spend_cap", "token_cap", "job_cap"];
/**
 * The one rule for an operator stop on a schedule's pointer grant, shared by the fire path (`pointerRefusal`,
 * src/schedule-grant.ts) and the Schedules page. Stopped: a revoke recorded as the operator's (`revoked_by.by:
 * "operator"`), a legacy revoke with no `revoked_by` (no provenance, so the safe default), or a pause by anything but a
 * cap. Not stopped: a revoke recorded as the parent's or the system's, expiry, a cap pause, active or missing — the
 * next fire mints a fresh grant.
 */
export function operatorStop(grant: { status?: unknown; pause_reason?: unknown; revoked_by?: unknown } | undefined): "revoked" | "paused" | undefined {
	const by = (grant?.revoked_by as { by?: unknown } | undefined)?.by;
	if (grant?.status === "revoked" && by !== "parent" && by !== "system") return "revoked";
	if (grant?.status === "paused" && !GRANT_CAP_PAUSES.includes(grant.pause_reason ?? "")) return "paused";
	return undefined;
}

/**
 * Why a schedule without a `grant_template` never fires. The migration's `why` (`migration: …`: a seed that is missing,
 * unparseable or yields no template) is saved in `last_skip` and repeated by every later refusal, never hidden.
 */
export function noTemplateReason(id: string, why = "saved before every fire minted its own grant"): string {
	return `schedule ${id} has no grant template (${why}), so no fire can mint a fresh grant: cp_schedule move it to a schedule grant to resume`;
}

/**
 * A schedule's saved grant bounds, snapshotted from its seed grant at add, move or migration (its approval quotes the
 * seed's own objective verbatim). Every fire mints a fresh fire grant from it (src/schedule-grant.ts).
 */
export interface GrantTemplate {
	seed_mandate_id: string;
	/** The seed's `issued_by.channel`, copied onto every fire grant (no new channel value). */
	channel: (typeof MANDATE_CHANNEL_VALUES)[number];
	objective: string;
	expiry_hours: number;
	spend_usd: number;
	spend_tokens: number;
	job_cap: number;
	dispatch_parallelism?: number;
	allowed_actions: Array<(typeof GRANT_TEMPLATE_ACTIONS)[number]>;
	ask_on: Array<(typeof GRANT_TEMPLATE_ASK_ON)[number]>;
	exclusions?: { paths?: string[]; subsystems?: string[]; job_kinds?: Array<(typeof SCHEDULE_JOB_KINDS)[number]> };
	approval: { operator_quote: string; decided_by: "operator-quote" | "operator-delegated"; approved_at: string; delegation_rule?: string; send_id?: string };
}

export interface Schedule {
	id: string;
	name: string;
	project: string;
	/** The schedule's current grant: its seed until the first fire, then the fire grant each fire mints, in the fire lane. */
	mandate_id?: string;
	/** `manual`: no tick ever fires it; only Run now does. */
	trigger: { type: "cron"; cron: string; tz: string } | { type: "watch"; script_path: string; every_seconds: number; on: "exit0" | "changed" } | { type: "manual" };
	job: { title: string; kind: (typeof SCHEDULE_JOB_KINDS)[number]; delivery: (typeof SCHEDULE_DELIVERIES)[number]; description?: string; script_path?: string; skill?: (typeof SCHEDULE_SKILLS)[number] };
	/**
	 * Every fire mints a fresh grant from this template; every add and move saves one. Optional only so a schedule the
	 * one-shot migration could not derive one for (seed missing or unreadable) stays readable, with its fires refused.
	 */
	grant_template?: GrantTemplate;
	enabled: boolean;
	created_at: string;
	/** Cron: the instant slots were last evaluated up to. Watch: when the script last ran. */
	last_checked_at?: string;
	last_output_sha?: string;
	last_fire?: { at: string; slot: string; job_id: string; missed: boolean };
	last_skip?: { at: string; reason: string };
}

export type Check = (value: unknown, path: string, errors: string[]) => void;
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const line = (max: number): Check => (v, path, errors) => {
	if (typeof v !== "string" || v.length < 1 || v.length > max || !/^[^\r\n]+$/.test(v)) errors.push(`${path}: must be one line of 1-${max} characters`);
};
const string: Check = (v, path, errors) => { if (typeof v !== "string") errors.push(`${path}: must be a string`); };
export const boolean: Check = (v, path, errors) => { if (typeof v !== "boolean") errors.push(`${path}: must be a boolean`); };
export const pattern = (re: RegExp): Check => (v, path, errors) => { if (typeof v !== "string" || !re.test(v)) errors.push(`${path}: must match ${re.source}`); };
export const oneOf = (values: readonly unknown[]): Check => (v, path, errors) => { if (!values.includes(v)) errors.push(`${path}: must be one of ${values.join(", ")}`); };
/** An object with exactly these keys; a key whose name ends in `?` is optional. */
export const object = (shape: Record<string, Check>): Check => (v, path, errors) => {
	if (!isObject(v)) { errors.push(`${path || "/"}: must be an object`); return; }
	const fields = new Map(Object.entries(shape).map(([key, check]) => [key.replace(/\?$/, ""), { check, optional: key.endsWith("?") }]));
	for (const key of Object.keys(v)) if (!fields.has(key)) errors.push(`${path}/${key}: unexpected property`);
	for (const [key, { check, optional }] of fields) {
		if (v[key] === undefined) { if (!optional) errors.push(`${path}/${key}: is required`); continue; }
		check(v[key], `${path}/${key}`, errors);
	}
};

export const cronTrigger = object({ type: oneOf(["cron"]), cron: line(200), tz: line(64) });
export const manualTrigger = object({ type: oneOf(["manual"]) });
export const watchTrigger = object({
	type: oneOf(["watch"]), script_path: line(1000), on: oneOf(["exit0", "changed"]),
	every_seconds: (v, path, errors) => { if (!Number.isInteger(v) || (v as number) < 30 || (v as number) > 86_400) errors.push(`${path}: must be an integer 30-86400`); },
});
export const text = (max: number): Check => (v, path, errors) => { if (typeof v !== "string" || v.length < 1 || v.length > max) errors.push(`${path}: must be a string of 1-${max} characters`); };
export const number = (min: number, max: number, integer: boolean, exclusiveMin = false): Check => (v, path, errors) => {
	if (typeof v !== "number" || !Number.isFinite(v) || (integer && !Number.isInteger(v)) || (exclusiveMin ? v <= min : v < min) || v > max) errors.push(`${path}: must be ${integer ? "an integer" : "a number"} ${exclusiveMin ? `over ${min}` : `${min}`}-${max}`);
};
/** A non-empty list of distinct `values`, at most `max` long; `required` must all be in it. */
export const subset = (values: readonly string[], max: number, required: readonly string[] = []): Check => (v, path, errors) => {
	if (!Array.isArray(v) || v.length < 1 || v.length > max || new Set(v).size !== v.length || v.some((item) => !values.includes(item))) errors.push(`${path}: must be 1-${max} distinct of ${values.join(", ")}`);
	else if (required.some((item) => !v.includes(item))) errors.push(`${path}: must include ${required.join(", ")}`);
};
export const lines = (max: number, items: number): Check => (v, path, errors) => {
	if (!Array.isArray(v) || v.length > items) errors.push(`${path}: must be an array of at most ${items}`);
	else v.forEach((item, i) => line(max)(item, `${path}/${i}`, errors));
};
export const ISO_SECOND = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const grantTemplate = object({
	seed_mandate_id: pattern(SCHEDULE_MANDATE_ID), channel: oneOf(MANDATE_CHANNEL_VALUES), objective: text(2000),
	expiry_hours: number(1, GRANT_TEMPLATE_MAX_HOURS, true), spend_usd: number(0, Number.MAX_SAFE_INTEGER, false, true),
	spend_tokens: number(1, Number.MAX_SAFE_INTEGER, true), job_cap: number(1, Number.MAX_SAFE_INTEGER, true), "dispatch_parallelism?": number(1, 32, true),
	allowed_actions: subset(GRANT_TEMPLATE_ACTIONS, 8), ask_on: subset(GRANT_TEMPLATE_ASK_ON, 16, GRANT_TEMPLATE_FORCED_ASK_ON),
	// The Mandate exclusions shape exactly (empty lists allowed), so every seed's exclusions snapshot unchanged.
	"exclusions?": object({ "paths?": lines(200, 32), "subsystems?": lines(80, 32), "job_kinds?": (v, path, errors) => {
		if (!Array.isArray(v) || v.length > 4) errors.push(`${path}: must be an array of at most 4`);
		else v.forEach((item, i) => oneOf(SCHEDULE_JOB_KINDS)(item, `${path}/${i}`, errors));
	} }),
	approval: object({
		operator_quote: text(4000), decided_by: oneOf(["operator-quote", "operator-delegated"]), approved_at: pattern(ISO_SECOND),
		"delegation_rule?": text(300), "send_id?": pattern(/^ps-[0-9]{14}-[0-9a-f]{8}$/),
	}),
});
const schedule = (version: number) => object({
	id: pattern(SCHEDULE_ID), name: line(80), project: line(64), [version === 1 ? "mandate_id" : "mandate_id?"]: pattern(SCHEDULE_MANDATE_ID),
	trigger: (v, path, errors) => (isObject(v) && v.type === "watch" ? watchTrigger : isObject(v) && v.type === "manual" ? manualTrigger : cronTrigger)(v, path, errors),
	job: object({
		title: line(200), kind: oneOf(SCHEDULE_JOB_KINDS), delivery: oneOf(SCHEDULE_DELIVERIES),
		"description?": (v, path, errors) => { if (typeof v !== "string" || v.length > 4000) errors.push(`${path}: must be a string of at most 4000 characters`); },
		"script_path?": line(1000), "skill?": oneOf(SCHEDULE_SKILLS),
	}),
	"grant_template?": grantTemplate,
	enabled: boolean, created_at: string, "last_checked_at?": string, "last_output_sha?": string,
	"last_fire?": object({ at: string, slot: string, job_id: string, missed: boolean }),
	"last_skip?": object({ at: string, reason: string }),
});
const scheduleFile: Check = (value, path, errors) => object({
	schema_version: oneOf([1, SCHEDULE_SCHEMA_VERSION]),
	schedules: (v, p, e) => { if (!Array.isArray(v)) e.push(`${p}: must be an array`); else v.forEach((item, i) => schedule(isObject(value) && value.schema_version === 1 ? 1 : 2)(item, `${p}/${i}`, e)); },
})(value, path, errors);
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
