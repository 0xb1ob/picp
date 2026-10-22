import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	let sent = false;
	pi.on("agent_start", () => {
		if (sent) return;
		sent = true;
		for (const message of JSON.parse(readFileSync(process.env.CP_S03_ARRIVAL_FILE!, "utf8"))) {
			pi.sendMessage(message, { triggerTurn: false });
		}
	});
}
