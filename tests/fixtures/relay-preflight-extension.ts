/**
 * Preflight probe for the operator relay outbox (cp-6fyl PR1). Loaded into a
 * real pinned pi by tests/relay-preflight.test.ts; every hook it observes is
 * appended to PROBE_LOG as one JSON line.
 *
 * PROBE_MODE=followup: a `cp-bridge` custom message with `details.relay_ids`
 * is sent with `deliverAs: "followUp"` both while the agent is busy
 * (agent_start of run 1) and from idle (first agent_settled).
 * PROBE_MODE=settle: the first `agent_before_settle` appends a custom message
 * and returns `continue: true`.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const log = (record: Record<string, unknown>) => appendFileSync(process.env.PROBE_LOG!, `${JSON.stringify(record)}\n`);
	const mode = process.env.PROBE_MODE;
	const relay = (id: string) => pi.sendMessage(
		{ customType: "cp-bridge", content: `relay ${id}`, display: true, details: { relay_ids: [id] } },
		{ deliverAs: "followUp", triggerTurn: true },
	);
	let starts = 0;
	let settles = 0;
	let beforeSettles = 0;
	pi.on("agent_start", async () => {
		starts += 1;
		log({ hook: "agent_start", n: starts });
		if (mode === "followup" && starts === 1) relay("busy-1");
	});
	pi.on("agent_settled", async (_event, ctx) => {
		settles += 1;
		log({ hook: "agent_settled", n: settles, idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
		if (mode === "followup" && settles === 1) relay("idle-1");
	});
	pi.on("message_start", async (event) => {
		const message = event.message as { role?: string; customType?: string; details?: unknown };
		log({ hook: "message_start", role: message.role, customType: message.customType, details: message.details });
	});
	pi.on("context", async (event) => {
		const bridged = (event.messages as Array<{ customType?: string; details?: { relay_ids?: string[] } }>)
			.filter((message) => message.customType === "cp-bridge")
			.map((message) => message.details?.relay_ids ?? null);
		log({ hook: "context", relay_ids: bridged });
	});
	pi.on("agent_before_settle", async () => {
		beforeSettles += 1;
		log({ hook: "agent_before_settle", n: beforeSettles });
		if (mode === "settle" && beforeSettles === 1) {
			return {
				entries: [{ type: "custom_message" as const, customType: "cp-ask-guard", content: "PROBE: open a cp_parent ask or reply NO-ASK", display: true }],
				continue: true,
			};
		}
		return undefined;
	});
}
