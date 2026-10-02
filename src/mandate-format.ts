/** `cp_mandate show`'s rendering of one grant. Split out of src/mandate.ts (its size ceiling), which re-exports it. */
import type { Mandate } from "./contracts.ts";
import { mandateSpend, type MandateUsageJob } from "./mandate-accounting.ts";

export function formatMandate(mandate: Mandate, jobs: readonly MandateUsageJob[] = []): string {
	const spend = mandateSpend(mandate, jobs);
	const lines = [
		`${mandate.id}: ${mandate.status}`,
		`  issued-by: ${mandate.issued_by.channel} at ${mandate.issued_at}`,
		`  expiry: ${mandate.expiry}`,
		`  projects: ${mandate.projects.join(", ")}`,
		`  objective: ${mandate.objective}`,
		...(mandate.schedule_grant ? ["  schedule grant: covers only the jobs of the one schedule naming it"] : []),
		...(mandate.job_ids && mandate.job_ids.length > 0 ? [`  jobs: ${mandate.job_ids.join(", ")}`] : []),
		`  allowed: ${mandate.allowed_actions.join(", ")}`,
		...(mandate.dispatch_parallelism ? [`  dispatch-parallelism: ${mandate.dispatch_parallelism}`] : []),
		`  ask_on: ${mandate.ask_on.length > 0 ? mandate.ask_on.join(", ") : "(none)"}`,
		`  spend: $${spend.usd.toFixed(2)} / $${mandate.spend_cap.usd.toFixed(2)}; ${spend.tokens} / ${mandate.spend_cap.tokens} non-cached tokens`,
		...(mandate.usage_baseline?.length ? [`  counted from ${mandate.issued_at}: earlier usage of ${mandate.usage_baseline.length} covered job(s) excluded`] : []),
		...(mandate.token_raises ?? []).map((raise) => `  token cap raised: ${raise.at} ${raise.from} -> ${raise.to} (${raise.reason})`),
		`  job cap: ${spend.jobs} / ${mandate.job_cap}`,
	];
	if (mandate.pause_reason) lines.push(`  pause-reason: ${mandate.pause_reason}`);
	if (mandate.provenance && Object.keys(mandate.provenance).length > 0) {
		const bySource = Object.entries(mandate.provenance).map(([field, source]) => `${field}:${source}`);
		lines.push(`  field sources: ${bySource.join(", ")}`);
	}
	if (mandate.exclusions) {
		const bits: string[] = [];
		if (mandate.exclusions.paths?.length) bits.push(`paths ${mandate.exclusions.paths.join(", ")}`);
		if (mandate.exclusions.subsystems?.length) bits.push(`subsystems ${mandate.exclusions.subsystems.join(", ")}`);
		if (mandate.exclusions.job_kinds?.length) bits.push(`kinds ${mandate.exclusions.job_kinds.join(", ")}`);
		if (bits.length > 0) lines.push(`  exclusions: ${bits.join("; ")}`);
	}
	if (mandate.decisions.length === 0) {
		lines.push("  decisions: (none)");
	} else {
		lines.push("  decisions:");
		for (const decision of mandate.decisions) {
			lines.push(`    - ${decision.at} ${decision.kind} ${decision.job_id}: ${decision.clause}`);
		}
	}
	if (mandate.escalations.length === 0) {
		lines.push("  escalations: (none)");
	} else {
		lines.push("  escalations:");
		for (const escalation of mandate.escalations) {
			lines.push(`    - ${escalation.at} ${escalation.kind}: ${escalation.reason}`);
		}
	}
	return lines.join("\n");
}
