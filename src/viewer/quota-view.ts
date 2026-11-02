import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JobQuotaContinuation } from "./api-types.ts";
import { obj, readObject, str, type ViewerState } from "./sessions.ts";

/** Production's adapter capabilityVersion, inlined so the viewer stays import-free; P3-quota-ui pins equality. */
export const PRODUCTION_QUOTA_CAPABILITY = "none";

/** Read-only P3 projection: production capability, effective policy (job ?? home ?? off), latest intent. */
export function quotaView(state: ViewerState, id: string, now = Date.now()): JobQuotaContinuation {
	const version: string = PRODUCTION_QUOTA_CAPABILITY;
	const base = { supported: version !== "none", capability_version: version };
	const file = join(state.stateDir, "quota-continuation.json");
	if (!existsSync(file)) return { ...base, policy: { enabled: false, source: "default" }, intent: null };
	const doc = readObject(file);
	const jobs = obj(obj(doc?.policy)?.jobs);
	if (doc?.schema_version !== 1 || !Array.isArray(doc.intents) || !jobs) return { ...base, policy: null, intent: null };
	const enabled = (value: unknown): boolean | undefined => {
		const flag = obj(value)?.enabled;
		return typeof flag === "boolean" ? flag : undefined;
	};
	const job = enabled(jobs[id]);
	const home = enabled(obj(doc.policy)?.home);
	const policy = job !== undefined ? { enabled: job, source: "job" as const } : home !== undefined ? { enabled: home, source: "home" as const } : { enabled: false, source: "default" as const };
	const latest = doc.intents.map(obj).findLast((row) => row?.job_id === id);
	const signal = obj(latest?.signal);
	const resetsAt = str(signal?.resetsAtUtc);
	const intent = latest && resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? {
		continuation_id: str(latest.continuation_id) ?? "", generation: typeof latest.generation === "number" ? latest.generation : 0,
		state: str(latest.state) ?? "unknown", delivery: str(latest.delivery) ?? "unknown", resets_at: resetsAt,
		overdue: latest.state === "pending" && latest.delivery === "waiting" && Date.parse(resetsAt) <= now,
		reason: str(latest.reason) ?? null, capability_version: str(latest.capability_version) ?? "unknown",
	} : null;
	return { ...base, policy, intent };
}
