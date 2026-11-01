/**
 * Quota-continuation policy (P3, variant C) and eligibility. The home default is off and a job override wins over it;
 * a setting applies only to interruptions observed after it, so opting in never replays an earlier failure.
 */

import type { Delivery, JobKind, Role, WorkerProfile } from "./contracts.ts";
import { scheduleIdOf } from "./mandate-accounting.ts";

export interface QuotaPolicySetting {
	enabled: boolean;
	changed_at: string;
	actor: string;
}

export interface QuotaPolicy {
	home?: QuotaPolicySetting;
	jobs: Record<string, QuotaPolicySetting>;
}

export interface EffectiveQuotaPolicy {
	enabled: boolean;
	source: "job" | "home" | "default";
	/** When the deciding setting took effect; absent for the built-in default. */
	changed_at?: string;
}

/** `job override ?? home default ?? false`. */
export function effectiveQuotaPolicy(policy: QuotaPolicy, jobId: string): EffectiveQuotaPolicy {
	const job = policy.jobs[jobId];
	const setting = job ?? policy.home;
	if (!setting) return { enabled: false, source: "default" };
	return { enabled: setting.enabled, source: job ? "job" : "home", changed_at: setting.changed_at };
}

export interface QuotaEligibilityInput {
	kind: JobKind;
	delivery: Delivery;
	/** The profile dispatch resolved, after any explicit override and the ops/QA defaults. */
	profile: WorkerProfile;
	labels?: readonly string[];
}

export interface QuotaEligibility {
	eligible: boolean;
	reason: string;
	kind: JobKind;
	delivery: Delivery;
	profile: string;
	role: Role;
}

/**
 * Only an ordinary ship implementer under a supported authority may be continued automatically. Planner, research,
 * Q&A, ops and any other profile, and every scheduled-run member, are excluded here and nowhere else.
 */
export function isQuotaContinuationEligible(input: QuotaEligibilityInput): QuotaEligibility {
	const { kind, delivery, profile } = input;
	const facts = { kind, delivery, profile: profile.frontmatter.name, role: profile.frontmatter.role };
	const refuse = (reason: string): QuotaEligibility => ({ eligible: false, reason, ...facts });
	if (kind !== "ship") return refuse(`a kind:${kind} job is never continued automatically`);
	if (facts.profile !== "implementer" || facts.role !== "implementer" || profile.frontmatter.readOnly === true) {
		return refuse(`profile ${facts.profile} (role ${facts.role}) is not the ordinary implementer`);
	}
	if (delivery !== "pr" && delivery !== "local") return refuse(`delivery:${delivery} is not an ordinary ship delivery`);
	const schedule = scheduleIdOf(input.labels);
	if (schedule) return refuse(`scheduled-run authority (${schedule}) is unsupported`);
	return { eligible: true, reason: "ordinary ship implementer", ...facts };
}
