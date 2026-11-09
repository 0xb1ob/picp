/** F4 fixture: one tool that blocks the parent's event loop for `SLOW_SYNC_MS` with synchronous work. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SLOW_SYNC_MS = 6_500;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "slow_sync_probe",
		label: "Slow sync probe",
		description: "Busy-waits synchronously (fixture for the loop_stall monitor)",
		parameters: Type.Object({}),
		async execute() {
			const until = Date.now() + SLOW_SYNC_MS;
			while (Date.now() < until) {
				// deliberately synchronous
			}
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	});
}
