/**
 * `/cp-quota` in the parent and `cp_parent quota` in the operator bridge: one status, policy and cancel surface for
 * quota continuation. Runs in the parent process, so a cancel serializes with the due pass; it never sends anything.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { JobIdSchema } from "./contracts.ts";
import type { QuotaContinuation, QuotaIntent } from "./quota-continuation.ts";
import { effectiveQuotaPolicy, type QuotaPolicySetting } from "./quota-continuation-policy.ts";

export const QUOTA_PREFIX = "QUOTA: ";
const USAGE = "usage: /cp-quota [status [job] | on [job] | off [job] | cancel <job> [reason]]";
/** Bounds one status reply; older intents stay in state/quota-continuation.json. */
const SHOWN_INTENTS = 20;

export const QuotaCommandSchema = Type.Object(
	{
		op: StringEnum(["status", "on", "off", "cancel"], { description: "status reads; on/off set the home default, or a job override with job_id; cancel stops one job's unsent continuation" }),
		job_id: Type.Optional(JobIdSchema),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "cancel: why, recorded with the actor" })),
	},
	{ additionalProperties: false },
);
export type QuotaCommand = Static<typeof QuotaCommandSchema>;

/** The `/cp-quota` argument line for one bridge request. */
export function quotaCommandArgs(input: QuotaCommand | undefined): string {
	if (!input) throw new Error("cp_parent quota needs quota: {op, job_id?, reason?}");
	if (input.op === "cancel" && !input.job_id) throw new Error("cp_parent quota cancel needs quota.job_id");
	return [input.op, input.job_id, input.op === "cancel" ? input.reason?.replace(/\s+/g, " ").trim() : undefined].filter(Boolean).join(" ");
}

const onOff = (enabled: boolean): string => (enabled ? "on" : "off");
const setting = (s: QuotaPolicySetting): string => `${onOff(s.enabled)} (set by ${s.actor} at ${s.changed_at})`;

function intentLine(intent: QuotaIntent, now: number): string {
	const overdue = intent.state === "pending" && intent.delivery === "waiting" && intent.signal.resetsAtEpochSeconds * 1000 <= now;
	const reason = intent.reason ? ` — ${intent.reason}` : "";
	return `${intent.continuation_id} ${intent.state}/${intent.delivery}${overdue ? " (overdue)" : ""}, resets ${intent.signal.resetsAtUtc}${reason}`;
}

/** Capability first: production decodes no reset signal, so a policy alone schedules nothing. */
export function quotaStatus(quota: QuotaContinuation, jobId?: string, now = Date.now()): string {
	const version = quota.capabilityVersion;
	const { policy, intents } = quota.snapshot();
	const lines = [
		version === "none"
			? "unsupported in production: no provider reset signal is verified (capability none); nothing is scheduled and a policy alone changes nothing"
			: `verified reset adapter ${version}`,
		`home default: ${policy.home ? setting(policy.home) : "off (built-in default)"}`,
	];
	if (jobId) {
		const effective = effectiveQuotaPolicy(policy, jobId);
		lines.push(`${jobId}: ${onOff(effective.enabled)} (${effective.source})`);
	} else {
		for (const [id, value] of Object.entries(policy.jobs)) lines.push(`job ${id}: ${setting(value)}`);
	}
	const mine = intents.filter((intent) => jobId === undefined || intent.job_id === jobId);
	if (mine.length > SHOWN_INTENTS) lines.push(`${mine.length - SHOWN_INTENTS} older intent(s) not shown`);
	lines.push(...(mine.length ? mine.slice(-SHOWN_INTENTS).map((intent) => intentLine(intent, now)) : ["no intents"]));
	return lines.join("\n");
}

/** One `/cp-quota` call; never throws, and an error reply always says what was not done. */
export function runQuotaCommand(quota: QuotaContinuation, args: string, actor = "operator"): { text: string; level: "info" | "error" } {
	const [op = "status", jobId, ...rest] = args.trim().split(/\s+/).filter(Boolean);
	const reply = (text: string, ok = true) => ({ text: `${QUOTA_PREFIX}${text}`, level: ok ? "info" as const : "error" as const });
	if (jobId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) return reply(`refused: ${JSON.stringify(jobId)} is not a job id; nothing changed — ${USAGE}`, false);
	try {
		if (op === "status" && rest.length === 0) return reply(quotaStatus(quota, jobId));
		if ((op === "on" || op === "off") && rest.length === 0) {
			const cancelled = quota.setPolicy({ ...(jobId ? { jobId } : {}), enabled: op === "on", actor });
			const effect = quota.capabilityVersion === "none" ? " — no effect while unsupported in production (capability none)" : "";
			return reply([`${jobId ? `job ${jobId}` : "home default"} set ${op} by ${actor}${effect}`,
				...cancelled.map((intent) => `cancelled ${intent.continuation_id}: ${intent.reason}`)].join("\n"));
		}
		if (op === "cancel" && jobId) {
			const result = quota.cancel(jobId, { actor, reason: rest.join(" ") || `cancelled by ${actor}` });
			if (!result.ok) return reply(`refused: ${result.reason}; nothing changed`, false);
			return reply(`cancelled ${result.intent.continuation_id} by ${actor}: ${result.intent.reason}. Nothing was sent; job, session and counters are kept.`);
		}
	} catch (error) {
		return reply(`failed: ${(error as Error).message}; nothing changed`, false);
	}
	return reply(`refused: ${JSON.stringify(args.trim())} — ${USAGE}`, false);
}
