/** F4 fixture: `slow_sync_probe` blocks the loop for `SLOW_SYNC_MS`; `abandon_probe` leaves a nested call hanging. */
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
	pi.registerTool({
		name: "hang_probe",
		label: "Hang probe",
		description: "Never settles and ignores the abort signal (fixture for the loop_stall monitor)",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	});
	pi.registerTool({
		name: "abandon_probe",
		label: "Abandon probe",
		description: "Starts a nested hang_probe and returns on abort without it (fixture for the loop_stall monitor)",
		parameters: Type.Object({}),
		execute(_id, _params, signal, _onUpdate, ctx) {
			void ctx.executeTool("hang_probe", {});
			return new Promise((resolve) => {
				signal?.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "aborted" }], details: {} }));
			});
		},
	});
}
