/** Contract primitives: path-safe ids, timestamps, job kind/delivery, roles, usage, validate(). Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Versions and caps
// ---------------------------------------------------------------------------

/** Bumped when a persisted file layout changes incompatibly. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * job id. Also a directory name in state/runs and state/artifacts, so it
 * must be path-safe: no separators, no dots, no traversal.
 */
export const JOB_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";
const JOB_ID_RE = new RegExp(JOB_ID_PATTERN);

export const JobIdSchema = Type.String({
	pattern: JOB_ID_PATTERN,
	description: "job id, e.g. cp-t02-contracts-vuh",
});

export function isSafeJobId(value: string): boolean {
	return JOB_ID_RE.test(value);
}

/**
 * br ledger prefix for the ids a home mints (`cp-a1b`). It is also the first
 * component of every job id, and a job id **is** a git branch name, so it is
 * constrained harder than the id it prefixes: lowercase, alphanumeric, short.
 *
 * Why it is configurable at all (cp-b8el, cp-epy2 §4.2): br mints ids per
 * database with no knowledge of another database's, so two homes both minting
 * `cp-…` against the same remote can mint the same branch name for two
 * different jobs. One home per surface is the topology; a per-home prefix is
 * what keeps their branch namespaces disjoint. Unset means `cp`, which is
 * exactly what every existing home already has.
 */
export const LEDGER_PREFIX_PATTERN = "^[a-z][a-z0-9]{0,7}$";
const LEDGER_PREFIX_RE = new RegExp(LEDGER_PREFIX_PATTERN);

export function isSafeLedgerPrefix(value: string): boolean {
	return LEDGER_PREFIX_RE.test(value);
}

/**
 * The two env vars that matter only when one machine runs more than one home.
 * Both default to today's behaviour when unset or empty — that is the binding
 * constraint on them (cp-epy2 Constraint 4), not a nicety.
 */
export const ENV_LEDGER_PREFIX = "CP_LEDGER_PREFIX";
export const ENV_TREEHOUSE_ROOT = "CP_TREEHOUSE_ROOT";

/** ISO-8601 UTC, second precision — the only timestamp format we write. */
export const ISO_TIMESTAMP_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$";
const ISO_TIMESTAMP_RE = new RegExp(ISO_TIMESTAMP_PATTERN);

export const IsoTimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });

export function isoTimestamp(at: Date = new Date()): string {
	return `${at.toISOString().slice(0, 19)}Z`;
}

export function isIsoTimestamp(value: string): boolean {
	return ISO_TIMESTAMP_RE.test(value);
}

/** kind axis: does the job change code? */
export const JOB_KINDS = ["ship", "research"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JobKindSchema = StringEnum([...JOB_KINDS]);

/**
 * delivery axis: how the result lands.
 *
 * `answer` (cp-u3o4) is the Q&A path: a `kind:research` job whose result is a
 * short answer an operator reads once, not a plan an implementer acts on. It
 * is an addition to this axis and nothing else — a Q&A job is an ordinary
 * research job (same envelope rules, same read-only teardown gate, same
 * artifact store); what differs is only where the result is *shown*. Every
 * PR-specific branch in this repo tests `delivery === "pr"`, so `answer`
 * flows the `local`-like path (`next: "teardown"`, no hold, no CI watch, no
 * merge ask) without any of them having to know it exists.
 */
export const DELIVERIES = ["pr", "local", "pipeline", "answer", "board"] as const;
export type Delivery = (typeof DELIVERIES)[number];
export const DeliverySchema = StringEnum([...DELIVERIES]);

/**
 * Exactly three roles. Adding a fourth is a contract change, not a config.
 *
 * The role that plans is called `planner`: its brief produces an implementation
 * plan and the gate scores that plan against the implementation-plan rubric.
 * It was called `researcher` until Phase 7 (D5) — see `LEGACY_ROLE_ALIASES`.
 */
export const ROLES = ["planner", "implementer", "gate-reviewer"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = StringEnum([...ROLES]);

/**
 * Roles retired by a rename, accepted on READ and never written again.
 *
 * `researcher` was renamed to `planner` (Phase 7/D5, no behaviour change), and
 * a home that ran the old build still has the old word on disk: in
 * `state/fleet.json`, in `state/runs/<id>/status.json` and in every line of
 * `state/runs/<id>/questions.jsonl`. Rejecting those files would strand a live
 * fleet on an upgrade, so the read path maps the legacy word forward exactly
 * once, in `normalizeLegacyRoles` below, and every write goes out as `planner`.
 */
export const LEGACY_ROLE_ALIASES: Readonly<Record<string, Role>> = Object.freeze({
	researcher: "planner",
});

/**
 * The one normaliser: rewrite every legacy `role` value in a just-parsed JSON
 * value to its current name, in place, and hand the same value back.
 *
 * It walks plain objects and arrays only, and it only touches a property
 * literally named `role` whose string value is a known alias — so it can never
 * rewrite a title, a brief, a reason or a model name that happens to contain
 * the old word. Called from the validators that read role-bearing files
 * (`validateFleetFile`, `validateRunStatus`, `validateQuestionRecord`,
 * `validateRoutingConfig`) before the schema sees the value, which is why no
 * caller has to know the rename happened.
 */
export function normalizeLegacyRoles<T>(value: T): T {
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		for (const [key, child] of Object.entries(record)) {
			if (key === "role" && typeof child === "string") {
				const mapped = LEGACY_ROLE_ALIASES[child];
				if (mapped) record[key] = mapped;
				continue;
			}
			walk(child);
		}
	};
	walk(value);
	return value;
}

/** Origin is retained for later Slack scoping; terminal is the only value today. */
export const OriginSchema = Type.String({ minLength: 1, maxLength: 64, default: "terminal" });
export const DEFAULT_ORIGIN = "terminal";

export const UsageSchema = Type.Object(
	{
		input: Type.Integer({ minimum: 0 }),
		output: Type.Integer({ minimum: 0 }),
		cache_read: Type.Integer({ minimum: 0 }),
		cache_write: Type.Integer({ minimum: 0 }),
		total_tokens: Type.Integer({ minimum: 0 }),
		cost_usd: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type Usage = Static<typeof UsageSchema>;

export const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cache_read: 0,
	cache_write: 0,
	total_tokens: 0,
	cost_usd: 0,
};

// ---------------------------------------------------------------------------
// Project registry (T10) — data/projects.json
// ---------------------------------------------------------------------------

/**
 * Project name = directory name under `projects/`, br label value, and fleet
 * record key. It is NARROWER than command-post's `^[A-Za-z0-9._-]+$` on
 * purpose: br labels accept only alphanumerics, hyphen and underscore, so a
 * dotted name would produce a `project:` label br refuses. One name, three
 * uses, one pattern.
 */
export const PROJECT_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";
const PROJECT_NAME_RE = new RegExp(PROJECT_NAME_PATTERN);

export function isSafeProjectName(value: string): boolean {
	return PROJECT_NAME_RE.test(value);
}

export class ContractError extends Error {}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Schema check with model-facing error strings. The strings are handed back to
 * a worker verbatim for bounded repair, so they name the path and the fix.
 */
export function validate<T>(schema: unknown, value: unknown, limit = 10): ValidationResult<T> {
	// typebox schemas are structurally typed; the cast keeps callers untyped-schema friendly
	const s = schema as never;
	if (Value.Check(s, value)) {
		return { ok: true, value: value as T };
	}
	const errors: string[] = [];
	for (const error of Value.Errors(s, value)) {
		const at = error.instancePath === "" ? "(root)" : error.instancePath;
		errors.push(`${at}: ${error.message}`);
		if (errors.length >= limit) break;
	}
	if (errors.length === 0) errors.push("(root): value does not match the schema");
	return { ok: false, errors };
}

/** True when `child` is `parent` or lives beneath it (string-level, no fs access). */
export function isInside(child: string, parent: string): boolean {
	const normalizedParent = parent.endsWith("/") ? parent.slice(0, -1) : parent;
	return child === normalizedParent || child.startsWith(`${normalizedParent}/`);
}
