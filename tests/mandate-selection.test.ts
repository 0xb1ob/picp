import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mandate } from "../src/contracts.ts";
import { selectGrant, type GrantJob } from "../src/mandate-permission.ts";

const now = "2026-10-08T00:00:00Z";
const job: GrantJob = { jobId: "cp-target", project: "picp", jobKind: "ship", inFlight: false };
function grant(id: string, over: Partial<Mandate> = {}): Mandate {
	return { schema_version: 1, id, issued_by: { channel: "operator_chat" }, issued_at: "2026-10-07T00:00:00Z", expiry: "2026-10-09T00:00:00Z", projects: ["picp"], objective: "fix", allowed_actions: ["implement", "review", "repair", "merge"], spend_cap: { usd: 100, tokens: 100_000 }, job_cap: 3, ask_on: [], status: "active", decisions: [], escalations: [], ...over };
}
function permutations<T>(items: T[]): T[][] {
	return items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest])) : [[]];
}

test("active selection is named-first, earliest-issued, then code-point ID, in every permutation", () => {
	const broad = grant("md-000000", { issued_at: "2026-10-01T00:00:00Z" });
	const named = grant("md-a994c5", { job_ids: [job.jobId] });
	const tied = grant("md-b994c5", { job_ids: [job.jobId] });
	const later = grant("md-000001", { job_ids: [job.jobId], issued_at: now });
	for (const order of permutations([broad, named, tied, later])) {
		const before = [...order];
		assert.equal(selectGrant(order, "dispatch", job, now)?.grant.id, named.id);
		assert.deepEqual(order, before, "selection never mutates its input");
	}
	assert.equal(selectGrant([grant("md-000002", { job_ids: [] }), broad], "dispatch", job, now)?.grant.id, broad.id, "empty names are project-wide");
});

test("coverage and standing precede precedence, including schedule-only grants", () => {
	const broad = grant("md-e94d25");
	for (const over of [{ job_ids: ["cp-other"] }, { projects: ["other"] }, { exclusions: { job_kinds: ["ship" as const] } }, { status: "paused" as const }, { expiry: now }]) {
		assert.equal(selectGrant([grant("md-000001", { job_ids: [job.jobId], ...over }), broad], "dispatch", job, now)?.grant.id, broad.id);
	}
	const scheduled = grant("md-000001", { schedule_grant: true, job_ids: [job.jobId] });
	assert.equal(selectGrant([scheduled, broad], "dispatch", job, now)?.grant.id, broad.id);
	assert.equal(selectGrant([scheduled, broad], "dispatch", { ...job, scheduleId: "sch-123abc", scheduleMandate: scheduled.id }, now)?.grant.id, scheduled.id);
	assert.equal(selectGrant([scheduled, broad], "dispatch", { ...job, scheduleId: "sch-123abc", scheduleMandate: "md-other" }, now), undefined);
});

test("latest-speaking fallback keeps input-order ties; silent/none never acquire authority", () => {
	const expired = grant("md-111111", { expiry: now });
	const capped = grant("md-222222", { status: "paused", pause_reason: "spend_cap" });
	for (const order of [[expired, capped], [capped, expired]]) assert.equal(selectGrant(order, "dispatch", job, now)?.grant.id, order.at(-1)?.id);
	assert.equal(selectGrant([grant("md-111111", { status: "paused" }), grant("md-222222", { projects: ["other"] })], "dispatch", job, now), undefined);
	assert.equal(selectGrant([expired], "repair", { ...job, inFlight: true }, now)?.at.standing, "permit");
	assert.equal(selectGrant([expired], "implement", { ...job, inFlight: true }, now)?.at.standing, "refuse");
});
