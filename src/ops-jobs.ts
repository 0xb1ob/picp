/**
 * Ops jobs (remote-host pulls, deploys, process control): an `ops:<class>` label selects `profiles/ops.md`, fixes the
 * risk by class, and `resource:<name>` labels lease a remote resource for as long as the job is live (until teardown).
 */
import type { Delivery, FleetRecord, Job, JobKind, Risk } from "./contracts.ts";
import { DispatchError } from "./dispatch.ts";
import { parseJobLabels } from "./ledger.ts";

export const OPS_PROFILE_NAME = "ops";
export const OPS_CLASSES = ["pull", "deploy", "process"] as const;
export type OpsClass = (typeof OPS_CLASSES)[number];
const OPS_LABEL = "ops:";
const RESOURCE_LABEL = "resource:";

/** The job's `ops:<class>`, or undefined for a non-ops job; two classes or an unknown one refuse. */
export function opsClass(job: Pick<Job, "id" | "labels">): OpsClass | undefined {
	const found = (job.labels ?? []).filter((label) => label.startsWith(OPS_LABEL)).map((label) => label.slice(OPS_LABEL.length));
	if (found.length === 0) return undefined;
	const cls = found[0] as OpsClass;
	if (found.length > 1 || !OPS_CLASSES.includes(cls)) {
		throw new DispatchError(`${job.id}: an ops job carries exactly one ops:<${OPS_CLASSES.join("|")}> label (found ${found.map((v) => `ops:${v}`).join(", ")}) — fix it with cp_job update add_labels/remove_labels`);
	}
	return cls;
}

/**
 * The request an ops job dispatches with: the `ops` profile, risk high for deploy/process (always) and low for a pull
 * (unless named). A non-ops job's request is returned as is; the ops profile without an `ops:` label refuses.
 */
export function opsRequest<R extends { profile?: string; risk?: Risk }>(request: R, job: Pick<Job, "id" | "labels">, kind: JobKind, delivery: Delivery): R & { profile?: string; risk?: Risk } {
	const cls = opsClass(job);
	if (!cls) {
		if (request.profile === OPS_PROFILE_NAME) throw new DispatchError(`${job.id}: the ops profile needs an ops:<${OPS_CLASSES.join("|")}> label so its risk is known — add it with cp_job update add_labels`);
		return request;
	}
	if (kind !== "research" || delivery !== "local") throw new DispatchError(`${job.id}: an ops job is kind:research delivery:local (its files go in the artifact dir); this one is kind:${kind} delivery:${delivery}`);
	if (request.profile !== undefined && request.profile !== OPS_PROFILE_NAME) throw new DispatchError(`${job.id}: an ops:${cls} job runs the ops profile, not ${request.profile} — drop profile`);
	return { ...request, profile: OPS_PROFILE_NAME, risk: cls === "pull" ? (request.risk ?? parseJobLabels(job.labels).risk ?? "low") : "high" };
}

/** A `resource:<name>` label is refused while another live (not torn down) job holds the same label. */
export function assertResourcesFree(job: Pick<Job, "id" | "labels">, fleet: readonly FleetRecord[], jobs: readonly Pick<Job, "id" | "labels">[]): void {
	const wanted = (job.labels ?? []).filter((label) => label.startsWith(RESOURCE_LABEL));
	if (wanted.length === 0) return;
	const live = new Set(fleet.filter((record) => record.job_id !== job.id && record.phase !== "done").map((record) => record.job_id));
	for (const other of jobs) {
		const held = live.has(other.id) ? wanted.find((label) => (other.labels ?? []).includes(label)) : undefined;
		if (held) throw new DispatchError(`${job.id}: ${held} is leased by live job ${other.id} — it is released when ${other.id} is torn down; dispatch ${job.id} after that`);
	}
}
