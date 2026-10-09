/** Worker profiles and the spawn/trust policy (forbidden tools and flags, receipts). Import via src/contracts.ts. */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { type Role, RoleSchema, validate, type ValidationResult } from "./core.ts";
import { type ThinkingLevel, ThinkingLevelSchema } from "./routing.ts";
import type { Narrow, Replace } from "./internal.ts";

// ---------------------------------------------------------------------------
// Worker profiles — profiles/<name>.md frontmatter
// ---------------------------------------------------------------------------

// `ThinkingLevel`/`THINKING_LEVELS` moved up next to the other primitives (see
// the comment by `OriginSchema`) so `JobRoutingSchema` could use it too.

export const ProfileFrontmatterSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64 }),
		role: RoleSchema,
		description: Type.Optional(Type.String({ maxLength: 300 })),
		/** Allowlist passed to `pi --tools`. Empty array = no tools at all. */
		tools: Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 }),
		model: Type.String({ minLength: 1 }),
		thinking: Type.Optional(ThinkingLevelSchema),
		/**
		 * Ordered candidates tried after `model` when it is unusable
		 * (pi-command-post-0a9). Same three gates, same effort: fallback changes
		 * which model runs, never how hard it thinks.
		 */
		fallbacks: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 4 })),
		/** Template name in prompts/ used to assemble the first brief. */
		briefTemplate: Type.String({ minLength: 1 }),
		/** Refuse the profile if the job would let it write (research hygiene). */
		readOnly: Type.Optional(Type.Boolean()),
		/**
		 * Optional user-level packages this profile activates, overriding the role
		 * default in `ROLE_PACKAGES` (`src/worker-packages.ts`). `[]` means none.
		 * A name this home has not installed resolves to nothing, like any other
		 * unavailable package — activation never makes a package required.
		 */
		packages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16 })),
		budget: Type.Optional(
			Type.Object(
				{
					tokens: Type.Optional(Type.Integer({ minimum: 1 })),
					cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type ProfileFrontmatter = Replace<
	Static<typeof ProfileFrontmatterSchema>,
	{ role: Role; thinking?: ThinkingLevel; fallbacks?: string[] }
>;

export const WorkerProfileSchema = Type.Object(
	{
		frontmatter: ProfileFrontmatterSchema,
		/** Markdown body → worker `--append-system-prompt`. */
		systemPrompt: Type.String(),
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type WorkerProfile = Narrow<Static<typeof WorkerProfileSchema>, "frontmatter", ProfileFrontmatter>;

/**
 * Tools a worker may never hold: dispatch capability is the recursion guard,
 * and the parent's own fleet tools have no meaning inside a worktree.
 */
export const WORKER_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
	"cp_dispatch",
	"cp_send",
	"cp_teardown",
	"cp_check",
	"cp_gate",
	/**
	 * Same rule as `cp_gate`, same reason: reviewing spawns a fresh-context
	 * reviewer against a project clone. A worker holding this could review
	 * (and promote a revise to) a sibling job's branch.
	 */
	"cp_review",
	"cp_artifact",
	"cp_pipeline",
	/** A worker registering a project would clone repositories of its choosing. */
	"cp_project",
	/** `data/` is the parent's home only; a worker must never capture into it. */
	"cp_memory",
	/** The ledger is the parent's bookkeeping; a worker that could close or reopen jobs could hide its own failure. */
	"cp_job",
	/** A worker issuing itself a mandate would be the model answering its own checkpoint. */
	"cp_mandate",
	/** Reveals ready jobs and mandate caps across the fleet; the parent's continuation loop, not a worker's. */
	"cp_next",
	/** A saved schedule mints jobs under a mandate on its own clock; a worker holding it could file work for itself. */
	"cp_schedule",
	/** A worker composing an escalation would be the model answering its own ask. */
	"cp_escalate",
	/** A worker answering a checkpoint would be the model authorizing itself. */
	"cp_decide",
	/**
	 * cp-uug: integration is parent-side by construction, and that is the whole
	 * resolution of "who may wait for CI". `src/ci-wait.ts` refuses a worker's
	 * `gh run watch` by name; a worker holding this tool could reach the same
	 * capability *through* it, which is that loophole in a different shape. It
	 * would also be a second writer to a branch whose implementer is still live
	 * and promotable.
	 */
	"cp_integrate",
	/**
	 * Same rule: recording a merge moves the job's `pr` receipt to `merged`,
	 * which is exactly the point at which `decideReopen` stops the implementer
	 * being promotable. A worker must not be able to close its own write window.
	 */
	"cp_merged",
	/**
	 * A worker has no operator to answer an Awaiting-you item, and `list`/
	 * `withdraw` still touch parent-only state; a worker's questions go through
	 * T31 (`ask_operator`), not this surface.
	 */
	"cp_awaiting",
	/**
	 * Reviving a dead job's worker is an operator decision (cp-8km, Constraint 1:
	 * explicit, never automatic) — a worker holding this could relaunch a sibling
	 * job's dead process out from under the operator.
	 */
	"cp_revive",
	/**
	 * cp-u3o4: `cp_ask` creates a br issue and dispatches a worker for it, so it
	 * is dispatch capability wearing a smaller hat — the same recursion guard as
	 * `cp_dispatch`, for the same reason.
	 */
	"cp_ask",
	/** Tracker connections and imports are parent bookkeeping; a worker could feed itself work. */
	"cp_tracker",
]);

/**
 * Parent tools that move fleet or worker state, and therefore may only be
 * called by the process holding this home's `state/parent.lock` (cp-epy2
 * §4.2; cp-yu5k review, gap 2).
 *
 * The lock is taken at `session_start`, but a refusal there only ends the
 * *startup*: pi keeps the session, and every one of these tools would still
 * perform the whole-array `fleet.json` read-modify-write the lock exists to
 * serialize — or spawn a worker into a lease another parent believes it owns.
 * So the refusal is enforced per call as well, in the extension's `tool_call`
 * hook.
 *
 * What is deliberately NOT here: the read-only and non-fleet surfaces
 * (`cp_check`, `cp_status_block`, `cp_artifact`, `cp_awaiting`, `cp_memory`,
 * `cp_project`). A parent that cannot take the home should still be able to
 * *look* at it and tell the operator which session holds it — a session that
 * can say nothing is indistinguishable from a broken install.
 */
export const FLEET_MUTATING_TOOLS: readonly string[] = Object.freeze([
	"cp_dispatch",
	"cp_send",
	"cp_integrate",
	"cp_teardown",
	"cp_revive",
	"cp_merged",
	/** Both spawn a fresh-context reviewer and write that job's run state. */
	"cp_gate",
	"cp_review",
	/** Creates dep-linked issues and dispatches: the fleet moves either way. */
	"cp_pipeline",
	/** Writes state/escalations.json. */
	"cp_escalate",
	/** cp-u3o4: creates a br issue and dispatches a Q&A worker — a spawn is a spawn. */
	"cp_ask",
]);

/**
 * Brief placeholders. Templates may use no others (T6 validates).
 * T22 amendment: `lens` was added for the opt-in quality pass — one template,
 * one voter per lens, instead of a template per angle.
 * Resolved-base amendment: `base` carries the preflight-resolved base branch, so
 * a ship brief rebases and reports `base_sha` against the repository's own base
 * instead of a hardcoded `main`.
 */
export const BRIEF_PLACEHOLDERS = [
	"job_id",
	"branch",
	"base",
	"worktree",
	"task",
	"artifact_path",
	"original_task",
	"review_context",
	"project",
	"kind",
	"delivery",
	"lens",
] as const;
export type BriefPlaceholder = (typeof BRIEF_PLACEHOLDERS)[number];

// ---------------------------------------------------------------------------
// Worker spawn / trust policy (implemented by T3 + T7, asserted by their tests)
// ---------------------------------------------------------------------------

/**
 * Flags every worker spawn MUST carry, in addition to profile-derived ones.
 *
 *  --mode rpc        headless, id-correlated delivery
 *  --no-approve      never trust `.pi/` inside a leased clone we did not write
 *  --no-extensions   discovery off; only the -e worker-reporter we pass
 *  --no-skills       no ambient skills; the brief is the instruction set
 *
 * Context files (AGENTS.md/CLAUDE.md) stay ON: a worker doing a repo's work
 * needs the repo's contract. That is accepted prompt-injection surface and is
 * documented in docs/contracts.md#trust-policy.
 */
export const WORKER_REQUIRED_FLAGS: readonly string[] = Object.freeze([
	"--mode",
	"rpc",
	"--no-approve",
	"--no-extensions",
	"--no-skills",
]);

/**
 * Flags a headless bridge parent MUST carry so global extensions (pi-lens,
 * fetch tools) and implementation skills never load. Pass `-e` the
 * command-post extension and `--skill <home>/skills/<name>` for each `PARENT_SKILLS` entry (cp-memory and the schedule
 * expanders cp-self-review, cp-pr-review, cp-org-pr-review)
 * (`parentSkillPaths`, src/cp-bridge.ts) separately; discovery stays off.
 * `/doctor`'s `session.tools` check is then empty of foreign tools.
 */
export const PARENT_BRIDGE_FLAGS: readonly string[] = Object.freeze(["--no-extensions", "--no-skills"]);

/** Flags that must never be passed to a worker (operator-only surface). */
export const WORKER_FORBIDDEN_FLAGS: readonly string[] = Object.freeze(["--approve", "-a", "--continue", "-c"]);

/**
 * Delivery receipt of a message pushed into a worker (T15).
 *
 * The receipt is pi's per-input `data.disposition` (pi >= 0.99.1):
 *  - `delivered`: pi started a run, or an input handler consumed the message (`started`/`handled`);
 *  - `queued`: pi holds it in its steer/follow-up queue (`queued`);
 *  - `failed`: rejected, timed out, or the worker is gone.
 * Without a disposition (pi < 0.99.1) a bare prompt is `delivered` (pi rejects one during a run),
 * and a steer, a follow_up or a prompt with `streamingBehavior` is `queued`.
 */
export const SEND_RECEIPTS = ["delivered", "queued", "failed"] as const;
export type SendReceipt = (typeof SEND_RECEIPTS)[number];
export const SendReceiptSchema = StringEnum([...SEND_RECEIPTS]);

/**
 * Delivery receipt of a message between the main session and the CP parent
 * (cp-bridge). Five levels, never overloaded as `accepted`:
 *
 *  injected        — written into the channel (RPC prompt/follow_up accepted)
 *  turn_settled    — the turn that consumed it settled (`agent_settled`)
 *  http_accepted   — an HTTP transport returned 2xx. The RPC bridge never claims this.
 *  owner_observed  — the main session holds the reply or the relay text
 *  turn_failed     — settled, but the last assistant message stopped with `error`
 *                    (or none arrived); `reply` unset, never climbs to `owner_observed`
 *
 * A send reports the highest level reached and the list. A failure that never
 * entered the channel is `level: null`, not a sixth word.
 */
export const BRIDGE_RECEIPT_LEVELS = ["injected", "turn_settled", "http_accepted", "owner_observed", "turn_failed"] as const;
export type BridgeReceiptLevel = (typeof BRIDGE_RECEIPT_LEVELS)[number];

/**
 * Exactly one terminating tool per role. A worker cannot hold both: an
 * implementer must not be able to emit a verdict, and a reviewer must not be
 * able to emit a job envelope.
 */
export const TERMINATING_TOOL_BY_ROLE: Readonly<Record<Role, string>> = Object.freeze({
	planner: "report_result",
	implementer: "report_result",
	"gate-reviewer": "report_verdict",
});

export function terminatingToolForRole(role: Role): string {
	return TERMINATING_TOOL_BY_ROLE[role];
}

export function validateProfile(value: unknown): ValidationResult<ProfileFrontmatter> {
	const result = validate<ProfileFrontmatter>(ProfileFrontmatterSchema, value);
	if (!result.ok) return result;
	const profile = result.value;
	const errors: string[] = [];
	for (const tool of profile.tools) {
		if (WORKER_FORBIDDEN_TOOLS.includes(tool)) {
			errors.push(`/tools: "${tool}" is a parent-only tool — workers never get dispatch capability`);
		}
	}
	if (profile.role === "planner" && profile.readOnly === false) {
		errors.push("/readOnly: planner profiles are read-only by contract");
	}
	return errors.length === 0 ? result : { ok: false, errors };
}
