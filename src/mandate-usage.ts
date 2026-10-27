/**
 * Live mandate cap crossings (mandate continuation friction, Task 4).
 *
 * Spend used to be seen only at the next parent action, from persisted fleet
 * usage. This runs once per model message whose usage advanced a job's run
 * total: live run usage is overlaid on the fleet (each job counted once), the
 * mandates are swept (a cap crossing pauses them, exactly as before), and the
 * parent gets one durable notice per threshold — 80% of a cap, and the cap
 * itself. The in-flight worker is never killed; a paused mandate refuses the
 * next dispatch and ship promotion. One model/tool event may overshoot a cap
 * before it is observed: this is a notice, not a strict monetary ceiling.
 */
import { isoTimestamp, type JobKind, type Mandate, type Usage } from "./contracts.ts";
import type { FleetStore } from "./fleet.ts";
import { liveGrants, MandateError, type MandateStore, type MandateUsageJob, mandateSpend, mandateTokens, matchingJobs } from "./mandate.ts";
import { continueForJob } from "./mandate-continuity.ts";
import { parseJobLabels } from "./ledger.ts";
import type { RunRegistry } from "./runs.ts";
import { boundedWakeupId, type DurableWakeupInput } from "./wakeup-outbox.ts";

export const MANDATE_USAGE_WARN_RATIO = 0.8;

export interface MandateUsageOptions {
	fleet: FleetStore;
	runs: RunRegistry;
	mandates: MandateStore;
	journal: (input: DurableWakeupInput) => void;
	now?: () => Date;
}

/**
 * The parent raising a grant's token cap on its own (a decide-yourself item, never an operator ask), journaled
 * on `token_raises` with its reason and bounded by the home's `token_ceiling`. A grant paused on its token cap resumes and is re-swept
 * (another cap still pauses it); the in-flight job is untouched. The USD cap has no parent path at all: a request
 * naming one is refused here, whatever the caller — only the operator widens it, with a new grant.
 */
export function raiseTokenCap(
	store: MandateStore,
	id: string,
	request: { tokens: number; reason: string; usd?: number },
	jobs: readonly MandateUsageJob[] = [],
): Mandate {
	if (request.usd !== undefined) {
		throw new MandateError(`${id}: the parent can never raise the USD cap \u2014 it is the operator's alone; cp_escalate budget_exhausted`);
	}
	const existing = store.require(id);
	if (existing.status === "revoked" || (existing.status === "expired" && existing.continuity?.phase !== "committed")) throw new MandateError(`${id} is ${existing.status}; its token cap cannot be raised`);
	const reason = request.reason.trim().slice(0, 400);
	if (reason.length === 0) throw new MandateError(`${id}: a token-cap raise needs a reason`);
	const from = existing.spend_cap.tokens;
	if (!Number.isInteger(request.tokens) || request.tokens <= from) {
		throw new MandateError(`${id}: the new token cap must be an integer above the current ${from}`);
	}
	const ceiling = store.tokenCeiling();
	if (request.tokens > ceiling) {
		throw new MandateError(
			`${id}: ${request.tokens} tokens is over the home's token_ceiling ${ceiling} (data/mandate-defaults.json) \u2014 ` +
				"past the ceiling it is the operator's call: cp_escalate budget_exhausted",
		);
	}
	const raised: Mandate = {
		...existing,
		spend_cap: { usd: existing.spend_cap.usd, tokens: request.tokens },
		token_raises: [...(existing.token_raises ?? []), { at: isoTimestamp(), from, to: request.tokens, reason }],
	};
	if (existing.status === "paused" && existing.pause_reason === "token_cap") {
		raised.status = "active";
		delete raised.paused_at;
		delete raised.pause_reason;
	}
	return store.save(raised, jobs);
}

/** New reviewer spend (`cp_review` spawning a reviewer): the `review` use of the one permission rule (src/mandate-permission.ts). */
export async function assertReviewAllowed(store: MandateStore, job: { jobId: string; project: string; kind?: JobKind }, jobs: readonly MandateUsageJob[] = []): Promise<void> {
	const continuation = await continueForJob(store, job.jobId, jobs, "review");
	try { store.assertPermitted("review", job, jobs); }
	catch (error) {
		if (continuation?.escalation_id) throw new MandateError(`${(error as Error).message}; confirm original admission with cp_decide ${continuation.escalation_id}, then retry cp_mandate continue`);
		throw error;
	}
}

export function continuationBudget(store: MandateStore | undefined, jobId: string, jobs: readonly MandateUsageJob[], use: "dispatch" | "review" = "review") {
	const job = store?.runContext().ledgerJob(jobId);
	if (!store || !job) return undefined;
	const labels = parseJobLabels(job.labels);
	if (!labels.project) return undefined;
	const subject = { jobId, project: labels.project, kind: labels.kind };
	if (!store.selection(use, subject, jobs)?.grant.continuity) return undefined;
	const grant = store.assertPermitted(use, subject, jobs).selected;
	if (!grant?.continuity) return undefined;
	const spent = mandateSpend(grant, store.withReviewerSpend(jobs, [grant]));
	const budget = { tokens: grant.spend_cap.tokens - spent.tokens, cost_usd: grant.spend_cap.usd - spent.usd };
	if (budget.tokens <= 0 || budget.cost_usd <= 0) throw new MandateError(`${jobId}: original shared budget exhausted`);
	return budget;
}

/** Fleet usage with each job's live run total laid over it, whichever is further along. */
export function liveUsageJobs(fleet: FleetStore, runs: RunRegistry): MandateUsageJob[] {
	return fleet.read().jobs.map((job) => {
		const live = runs.get(job.job_id)?.status.usage;
		return live && live.total_tokens > (job.usage?.total_tokens ?? 0) ? { ...job, usage: live } : job;
	});
}

/**
 * `previous`/`current` are the job's run totals around one model message. A notice fires only on a
 * crossing inside that message — below 80% of a cap before it, at or above after; a cap notice only when
 * this sweep paused the mandate — so re-observation, revives and old capped grants say nothing, and a
 * message that crosses nothing writes nothing.
 */
export function observeMandateUsage(options: MandateUsageOptions, jobId: string, previous: Usage, current: Usage): void {
	const listed = options.mandates.list();
	const before = new Map(listed.map((mandate) => [mandate.id, mandate.status]));
	const jobs = options.mandates.withReviewerSpend(liveUsageJobs(options.fleet, options.runs), liveGrants(listed));
	const swept = options.mandates.sweep(isoTimestamp((options.now ?? (() => new Date()))()), jobs, listed);
	for (const mandate of swept) {
		if (before.get(mandate.id) !== "active" && !(before.get(mandate.id) === "expired" && mandate.continuity?.phase === "committed")) continue;
		if (!matchingJobs(mandate, jobs).some((job) => job.job_id === jobId)) continue;
		const spend = mandateSpend(mandate, jobs);
		const totals =
			`${spend.tokens} / ${mandate.spend_cap.tokens} non-cached tokens, $${spend.usd.toFixed(2)} / $${mandate.spend_cap.usd.toFixed(2)}, ` +
			`${spend.jobs} / ${mandate.job_cap} jobs`;
		// No `keys`: the notice is about the mandate, so its job being torn down never makes it stale.
		const notice = (key: string, headline: string, next: string): void =>
			options.journal({
				id: boundedWakeupId(`mandate-usage:${mandate.id}:${key}`),
				kind: "recovery",
				job_id: jobId,
				content: `${headline}\n  used ${totals}\n  ${jobId}'s in-flight worker continues. ${next}`,
			});
		// A raised grant starts a new round of token notices: the key names the cap it crossed.
		const round = mandate.token_raises?.length ? `@${mandate.spend_cap.tokens}` : "";
		if (mandate.status === "paused" && mandate.pause_reason === "token_cap") {
			const ceiling = options.mandates.tokenCeiling();
			if (mandate.spend_cap.tokens < ceiling) {
				notice(
					`token-cap${round}`,
					`MANDATE TOKEN CAP \u2014 ${mandate.id} paused (token_cap)`,
					`Decide it yourself, never ask the operator: cp_mandate raise_tokens ${mandate.id} with a reason, up to token_ceiling ${ceiling}.`,
				);
			} else {
				notice(
					`token-cap${round}`,
					`MANDATE TOKEN CEILING \u2014 ${mandate.id} paused at token_ceiling ${ceiling}`,
					"Past the ceiling it is the operator's: budget_exhausted is raised; a continuation needs an explicit new grant (cp_mandate issue).",
				);
			}
			continue;
		}
		if (mandate.status === "paused" && mandate.pause_reason === "spend_cap") {
			notice(
				"cap",
				`MANDATE CAP — ${mandate.id} paused (${mandate.pause_reason})`,
				"No new dispatch or ship promotion under it; a continuation needs an explicit new grant (cp_mandate issue).",
			);
			continue;
		}
		if (mandate.status !== "active" && !(mandate.status === "expired" && mandate.continuity?.phase === "committed")) continue;
		const axes: Array<[string, number, number, number]> = [
			["tokens", spend.tokens, mandateTokens(current) - mandateTokens(previous), mandate.spend_cap.tokens],
			["usd", spend.usd, current.cost_usd - previous.cost_usd, mandate.spend_cap.usd],
		];
		for (const [axis, used, delta, cap] of axes) {
			const line = cap * MANDATE_USAGE_WARN_RATIO;
			if (!(used >= line && used - delta < line)) continue;
			notice(
				axis === "tokens" ? `warn-tokens${round}` : `warn-${axis}`,
				`MANDATE ${Math.round(MANDATE_USAGE_WARN_RATIO * 100)}% — ${mandate.id} ${axis}`,
				axis === "tokens"
					? "At the token cap the mandate pauses new work; raising it within token_ceiling is yours to decide (cp_mandate raise_tokens)."
					: "At the USD cap the mandate pauses new work and budget_exhausted goes to the operator; nothing is raised automatically.",
			);
		}
	}
}
