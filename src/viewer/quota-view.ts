import { existsSync } from "node:fs";
import { join } from "node:path";
import { effectiveQuotaPolicy, type QuotaPolicySetting } from "../quota-continuation-policy.ts";
import { PRODUCTION_QUOTA_RESET_ADAPTER } from "../quota-reset-signal.ts";
import type { JobQuotaContinuation } from "./api-types.ts";
import { obj, readObject, str, type ViewerState } from "./sessions.ts";

/** Read-only P3 projection: production capability, the job's effective policy and its latest intent. */
export function quotaView(state: ViewerState, id: string, now = Date.now()): JobQuotaContinuation {
	const version = PRODUCTION_QUOTA_RESET_ADAPTER.capabilityVersion;
	const base = { supported: version !== "none", capability_version: version };
	const file = join(state.stateDir, "quota-continuation.json");
	if (!existsSync(file)) return { ...base, policy: { enabled: false, source: "default" }, intent: null };
	const doc = readObject(file);
	const jobs = obj(obj(doc?.policy)?.jobs);
	if (doc?.schema_version !== 1 || !Array.isArray(doc.intents) || !jobs) return { ...base, policy: null, intent: null };
	const setting = (value: unknown): QuotaPolicySetting | undefined => {
		const row = obj(value);
		return typeof row?.enabled === "boolean" ? { enabled: row.enabled, changed_at: str(row.changed_at) ?? "", actor: str(row.actor) ?? "" } : undefined;
	};
	const job = setting(jobs[id]);
	const home = setting(obj(doc.policy)?.home);
	const { enabled, source } = effectiveQuotaPolicy({ ...(home ? { home } : {}), jobs: job ? { [id]: job } : {} }, id);
	const latest = doc.intents.map(obj).findLast((row) => row?.job_id === id);
	const signal = obj(latest?.signal);
	const resetsAt = str(signal?.resetsAtUtc);
	const intent = latest && resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? {
		continuation_id: str(latest.continuation_id) ?? "", generation: typeof latest.generation === "number" ? latest.generation : 0,
		state: str(latest.state) ?? "unknown", delivery: str(latest.delivery) ?? "unknown", resets_at: resetsAt,
		overdue: latest.state === "pending" && latest.delivery === "waiting" && Date.parse(resetsAt) <= now,
		reason: str(latest.reason) ?? null, capability_version: str(latest.capability_version) ?? "unknown",
	} : null;
	return { ...base, policy: { enabled, source }, intent };
}
