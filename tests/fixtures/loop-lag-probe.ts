/** Fixture: from session start, writes the parent's worst event-loop lag so far to `CP_TEST_LAG_FILE` every tick. */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TICK_MS = 20;

export default function (pi: ExtensionAPI) {
	const file = process.env.CP_TEST_LAG_FILE;
	if (!file) return;
	let timer: ReturnType<typeof setInterval> | undefined;
	pi.on("session_start", () => {
		if (timer) return;
		let last = Date.now();
		let max = 0;
		let ticks = 0;
		timer = setInterval(() => {
			const now = Date.now();
			max = Math.max(max, now - last - TICK_MS);
			last = now;
			ticks += 1;
			writeFileSync(file, JSON.stringify({ max_lag_ms: max, ticks }));
		}, TICK_MS);
		timer.unref();
	});
}
