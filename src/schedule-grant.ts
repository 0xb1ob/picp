/**
 * Per-fire grants: every schedule mints a fresh grant on every fire (docs/contracts.md, *Fresh grant per fire*). At
 * `cp_schedule add` (or `move`, or the one-shot migration) the seed schedule grant's bounds are snapshotted into the
 * schedule's `grant_template`, its approval quoting the seed's own objective verbatim; every fire — cron, watch, the
 * dashboard's Run now or `cp_schedule run_now` — then mints a fresh `schedule_grant` from that template, re-evaluated
 * against the live home defaults, inside the scheduler's serialized fire lane. There is no opt-out and no reuse of a
 * grant: merge and risk:high are always asked, exclusions only grow and the token cap only shrinks.
 */
import { isoTimestamp, type JobKind, type Mandate, type MandateDefaults, type ProjectMandateOverride, type ScheduleFire } from "./contracts.ts";
import type { IssueMandateInput, MandateStore, MandateUsageJob } from "./mandate.ts";
import { GRANT_TEMPLATE_ACTIONS, GRANT_TEMPLATE_FORCED_ASK_ON, GRANT_TEMPLATE_MAX_HOURS, type GrantTemplate, type Schedule } from "./viewer/schedule-core.ts";

export interface Refusal { refusal: string }
export const refused = <T extends object>(value: T | Refusal): value is Refusal => "refusal" in value;

/** The live inputs a fire re-reads: `data/mandate-defaults.json`, the project's `mandate` override and the token ceiling. */
export interface MintContext { defaults: MandateDefaults; projectOverride?: ProjectMandateOverride; ceiling: number }

/** Exclusion paths a grant can hold (MandateSchema `exclusions.paths` maxItems). */
const MAX_EXCLUDED_PATHS = 32;
/** A pause the scheduler re-mints past; any other pause (the operator's) sticks until the grant is resumed or the schedule moved. */
const CAP_PAUSES = ["spend_cap", "token_cap", "job_cap"];

/**
 * The seed's bounds as a template, with every normalization named in `notes` (never applied silently): `merge` leaves
 * allowed_actions, `merge` and `risk:high` join ask_on, and the lifetime is ceil((expiry − issued_at) / 1 h) bounded to
 * 1-168 h. Its status is not read (a migration derives from an expired, revoked or cap-paused seed alike). A seed that
 * is no schedule grant, is itself a fire grant, or carries a risk:high pre-approval or job_ids, is refused.
 */
export function templateFromSeed(seed: Mandate, approval: Omit<GrantTemplate["approval"], "approved_at">, at: string): { template: GrantTemplate; notes: string[] } | Refusal {
	if (!seed.schedule_grant) return { refusal: `${seed.id} is not a schedule grant` };
	if (seed.schedule_fire) return { refusal: `${seed.id} is a fire grant minted for ${seed.schedule_fire.schedule_id}; a fire grant is never reused as a seed, so issue a fresh schedule grant` };
	if (seed.risk_preapproval) return { refusal: `${seed.id} carries a risk:high pre-approval; a fire grant template never inherits one, so issue the seed without it` };
	if (seed.job_ids?.length) return { refusal: `${seed.id} names job_ids; a schedule grant never does` };
	if (seed.spend_cap.usd <= 0 || seed.spend_cap.tokens < 1) return { refusal: `${seed.id} has a zero USD or token cap; a fire grant needs both above zero` };
	const notes: string[] = [];
	const allowed = seed.allowed_actions.filter((action): action is GrantTemplate["allowed_actions"][number] => (GRANT_TEMPLATE_ACTIONS as readonly string[]).includes(action));
	if (allowed.length === 0) return { refusal: `${seed.id} allows only merge; a fire grant needs at least one of ${GRANT_TEMPLATE_ACTIONS.join(", ")}` };
	if (allowed.length < seed.allowed_actions.length) notes.push("merge removed from allowed_actions: a fire grant never auto-decides a merge");
	const added = GRANT_TEMPLATE_FORCED_ASK_ON.filter((item) => !seed.ask_on.includes(item));
	if (added.length > 0) notes.push(`${added.join(" and ")} added to ask_on: a fire grant always asks for them`);
	const lifetime = Math.ceil((Date.parse(seed.expiry) - Date.parse(seed.issued_at)) / 3_600_000);
	const hours = Math.min(GRANT_TEMPLATE_MAX_HOURS, Math.max(1, lifetime));
	notes.push(hours === lifetime ? `each fire grant lives ${hours} h from its fire (the seed's lifetime)` : `each fire grant lives ${hours} h from its fire (the seed's ${lifetime} h lifetime, bounded to 1-${GRANT_TEMPLATE_MAX_HOURS} h)`);
	const template: GrantTemplate = {
		seed_mandate_id: seed.id,
		channel: seed.issued_by.channel,
		objective: seed.objective,
		expiry_hours: hours,
		spend_usd: seed.spend_cap.usd,
		spend_tokens: seed.spend_cap.tokens,
		job_cap: seed.job_cap,
		...(seed.dispatch_parallelism ? { dispatch_parallelism: seed.dispatch_parallelism } : {}),
		allowed_actions: [...new Set(allowed)],
		ask_on: [...new Set([...seed.ask_on, ...GRANT_TEMPLATE_FORCED_ASK_ON])],
		...(seed.exclusions ? { exclusions: structuredClone(seed.exclusions) } : {}),
		approval: { ...approval, approved_at: at },
	};
	return { template, notes };
}

/**
 * A template's approval, never invented wording: the seed grant's own objective, verbatim — the operator's text when
 * they issued the seed (`cp_mandate issue` is operator-only). `rule` names which path derived the template.
 */
export function synthesizedApproval(seed: Mandate, rule: "cp_schedule add" | "cp_schedule move" | "schedule migration"): Omit<GrantTemplate["approval"], "approved_at"> {
	return { operator_quote: seed.objective, decided_by: "operator-delegated", delegation_rule: `${rule}: the objective of seed grant ${seed.id}, quoted verbatim` };
}

/** A cp-pr-review description's `pr:` lines (trimmed, the prefix dropped); `prReviewTargets` validates them. */
export function prReviewLines(description: string): string[] {
	return description.split("\n").map((entry) => entry.trim()).filter((entry) => /^pr:/i.test(entry)).map((entry) => entry.slice(3).trim());
}

/**
 * The fewest jobs one fire of a skill schedule records under its fire grant: the skill's fan-out plus its deferred
 * anchor — cp-self-review six readers + one synthesis + the anchor = 8, cp-pr-review one reviewer per `pr:` line + one
 * synthesis + the anchor = N + 2 (skills/<name>/SKILL.md). Undefined for a schedule with no skill.
 */
export function skillJobFloor(job: Schedule["job"]): number | undefined {
	if (job.skill === "cp-self-review") return 6 + 1 + 1;
	if (job.skill === "cp-pr-review") return prReviewLines(job.description ?? "").length + 1 + 1;
	return undefined;
}

/** A skill schedule's template with its job cap raised to `skillJobFloor`, the raise named; never a refusal. */
export function withSkillJobFloor(template: GrantTemplate, job: Schedule["job"]): { template: GrantTemplate; note?: string } {
	const floor = skillJobFloor(job);
	if (floor === undefined || template.job_cap >= floor) return { template };
	return { template: { ...template, job_cap: floor }, note: `job cap raised from ${template.job_cap} to ${floor}: one ${job.skill} fire records ${floor - 1} jobs plus its deferred anchor under its own fire grant` };
}

/** The `issue()` input for one fire: the template's bounds re-evaluated against the live home (fail closed). */
export type FireBounds = Omit<IssueMandateInput, "id" | "schedule_fire" | "at">;

/**
 * Per fire: exclusions = template ∪ home `exclude_paths` ∪ project `exclude_paths`; tokens = min(template, live
 * token_ceiling), the clamp named; USD and job caps from the template; expiry = fire + the template's hours. A job kind
 * the template excludes, more exclusion paths than a grant holds, or a ceiling with nothing to spend refuses.
 */
export function liveFireBounds(template: GrantTemplate, context: MintContext, project: string, kind: JobKind, now: Date): { input: FireBounds; notes: string[] } | Refusal {
	if (template.exclusions?.job_kinds?.includes(kind)) return { refusal: `the template of ${template.seed_mandate_id} excludes ${kind} jobs` };
	const own = template.exclusions?.paths ?? [];
	const paths = [...new Set([...own, ...context.defaults.exclude_paths, ...(context.projectOverride?.exclude_paths ?? [])])];
	if (paths.length > MAX_EXCLUDED_PATHS) return { refusal: `the template's and the live exclude_paths are ${paths.length} paths, over the ${MAX_EXCLUDED_PATHS} a grant holds; none is dropped` };
	const tokens = Math.min(template.spend_tokens, context.ceiling);
	if (tokens < 1) return { refusal: `the home's token_ceiling is ${context.ceiling}: a fire grant would have nothing to spend` };
	const notes: string[] = [];
	if (tokens < template.spend_tokens) notes.push(`token cap clamped to the home's token_ceiling ${context.ceiling} (template ${template.spend_tokens})`);
	const live = paths.filter((path) => !own.includes(path));
	if (live.length > 0) notes.push(`exclusions add the live exclude_paths ${live.join(", ")}`);
	const exclusions = { ...template.exclusions, ...(paths.length > 0 ? { paths } : {}) };
	return {
		input: {
			projects: [project],
			objective: template.objective,
			expiry: isoTimestamp(new Date(now.getTime() + template.expiry_hours * 3_600_000)),
			spend_cap: { usd: template.spend_usd, tokens },
			job_cap: template.job_cap,
			channel: template.channel,
			schedule_grant: true,
			allowed_actions: [...template.allowed_actions],
			ask_on: [...template.ask_on],
			...(template.dispatch_parallelism ? { dispatch_parallelism: template.dispatch_parallelism } : {}),
			...(Object.keys(exclusions).length > 0 ? { exclusions } : {}),
		},
		notes,
	};
}

/**
 * Whether the schedule's current grant stops the next fire: only an operator act — a revoke carrying the operator's
 * verified quote (`revoked_by`, `cp_mandate revoke operator_quote`), or a pause by anything but a cap — sticks until the
 * schedule is moved to (or re-added under) a fresh schedule grant. A revoke without an operator quote (the system's or
 * the parent's), expired, cap-paused, active or missing (a crash between pointer move and issue) is minted past.
 */
export function pointerRefusal(grant: Mandate | undefined): string | undefined {
	if (!grant) return undefined;
	const resume = "cp_schedule move it to a fresh schedule grant (or remove and re-add it) to resume";
	if (grant.status === "revoked" && grant.revoked_by) return `${grant.id} was revoked by the operator (${grant.revoked_by.decided_by}); a schedule never re-mints past an operator revoke: ${resume}`;
	if (grant.status === "paused" && !CAP_PAUSES.includes(grant.pause_reason ?? "")) {
		return `${grant.id} is paused (${grant.pause_reason ?? "operator"}); a schedule never re-mints past an operator pause: resume the grant, or ${resume}`;
	}
	return undefined;
}

export interface MintPorts {
	mandates: MandateStore;
	usageJobs: () => readonly MandateUsageJob[];
	/** Rewrites the schedule's `mandate_id` (in the fire lane). */
	movePointer: (id: string) => Promise<void>;
	scheduleId: string;
	template: GrantTemplate;
	/** The pointer before this fire. */
	previousId: string;
	bounds: FireBounds;
	trigger: ScheduleFire["trigger"];
	at: string;
	/** Whether another schedule still names `id` (a pre-rule shared seed): such a grant is never revoked here. */
	named: (id: string) => boolean;
}

/**
 * Steps 6-9 of a fire: mint the id, move the schedule's pointer to it, then issue — so `usage_baseline` already
 * captures every earlier fire's fleet records (the pointer names the new grant) and spend from earlier fires is never
 * charged to it — then revoke the previous pointer, the seed and any orphan fire grant of this schedule (a crash after
 * an earlier issue), except a grant another schedule still names. A refused issue leaves the pointer on an id with no
 * file, which the next fire re-mints.
 */
export async function mintFireGrant(ports: MintPorts): Promise<{ grant: Mandate; revoked: string[] }> {
	const id = ports.mandates.mintId();
	await ports.movePointer(id);
	const grant = ports.mandates.issue({
		...ports.bounds,
		id,
		at: ports.at,
		schedule_fire: {
			schedule_id: ports.scheduleId,
			seed_mandate_id: ports.template.seed_mandate_id,
			previous_mandate_id: ports.previousId,
			fired_at: ports.at,
			approval: { ...ports.template.approval },
			trigger: ports.trigger,
		},
	}, ports.usageJobs());
	const revoked: string[] = [];
	for (const mandate of ports.mandates.list()) {
		if (mandate.id === grant.id || (mandate.status !== "active" && mandate.status !== "paused") || ports.named(mandate.id)) continue;
		if (mandate.id === ports.previousId || mandate.id === ports.template.seed_mandate_id || mandate.schedule_fire?.schedule_id === ports.scheduleId) {
			ports.mandates.revoke(mandate.id);
			revoked.push(mandate.id);
		}
	}
	return { grant, revoked };
}
