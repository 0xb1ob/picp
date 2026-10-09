/**
 * cp-6fyl PR2: while this session holds the parent lock, turn cp-health's record (`state/health.json`) into
 * `service_health` escalations every minute (src/service-alerts.ts). Same shape as push-tick: never overlapping,
 * never throws into the parent. Nothing here pushes: Web Push is for open ask cards only (`PUSH_RULE`).
 */
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LAYOUT } from "../../src/contracts.ts";
import { serviceAlerts, syncServiceEscalations } from "../../src/service-alerts.ts";
import { readHealth } from "../../src/service/health.ts";
import type { ExtensionDeps } from "./shared.ts";

export const SERVICE_ALERT_TICK_MS = 60_000;

const log = (line: string): void => {
	process.stderr.write(`pi-command-post: ${line}\n`);
};

export function registerServiceAlertTick(pi: ExtensionAPI, deps: ExtensionDeps, holdsLock: () => boolean): void {
	let timer: NodeJS.Timeout | undefined;
	let running = false;
	const tick = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const post = deps.commandPost();
			const stateDir = join(post.home, LAYOUT.state);
			const record = readHealth(stateDir);
			if (!record) return; // never ran or unreadable: nothing was promised, so nothing is withdrawn
			const { raised, withdrawn } = await syncServiceEscalations(post.escalations, serviceAlerts(record, new Date()), stateDir);
			if (raised.length || withdrawn.length) log(`service health: raised ${raised.join(", ") || "none"}; withdrew ${withdrawn.join(", ") || "none"}`);
		} catch (error) {
			log(`service alert tick failed: ${(error as Error).message}`);
		} finally {
			running = false;
		}
	};
	pi.on("session_start", async () => {
		if (!holdsLock() || timer) return;
		timer = setInterval(() => void tick(), SERVICE_ALERT_TICK_MS);
		timer.unref();
		setTimeout(() => void tick(), 0).unref();
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
