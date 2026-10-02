/**
 * Tiny extension used by the doctor e2e: one file-reading tool that is not
 * command-post's, so `/doctor` must name it as outside guard coverage.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "lens_read",
		label: "Lens read",
		description: "Read a file (fixture standing in for pi-lens)",
		parameters: Type.Object({ path: Type.String() }),
		async execute() {
			return { content: [{ type: "text", text: "fixture" }], details: {} };
		},
	});
}
