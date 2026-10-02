/**
 * `/doctor`'s `push` findings. Silent (no finding at all) until push is set up — an unconfigured home is not a
 * fault. Never names an endpoint, a key or a payload: only counts, the origin and bounded error text.
 */

import { existsSync, statSync } from "node:fs";
import type { DoctorFinding } from "../contracts.ts";
import { listSubscriptions, pushConfigFile, pushDataDir, readDeliverySummary, readPushConfig, vapidKeyFile } from "../viewer/push-files.ts";
import { resolveStateDir } from "../viewer/sessions.ts";
import { PUSH_MAX_ATTEMPTS } from "./deliveries.ts";
import { readVapidKeys } from "./keys.ts";
import { PUSH_RULE } from "./sweep.ts";

const INIT = "npm run push:init -- --origin <dashboard https origin>";

/** Never throws: doctor reports a broken environment, it does not crash on one. */
export function pushFindings(home: string, now: Date = new Date()): DoctorFinding[] {
	try {
		return findingsFor(home, now);
	} catch (error) {
		return [{ check: "push", severity: "warn", what: "web push state could not be read", detail: String((error as Error).message).slice(0, 2000), fix: "check data/push/ and state/push-deliveries.json are readable by this user" }];
	}
}

function findingsFor(home: string, now: Date): DoctorFinding[] {
	const stateDir = resolveStateDir(home);
	const dataDir = pushDataDir(stateDir);
	const configFile = pushConfigFile(dataDir);
	if (!existsSync(configFile)) return [];
	const config = readPushConfig(dataDir);
	if (!config) return [{ check: "push", severity: "warn", what: "web push config is unreadable; no push is sent", detail: configFile, fix: `move ${configFile} aside, then ${INIT}` }];
	const keyFile = vapidKeyFile(dataDir);
	const findings: DoctorFinding[] = [];
	try {
		readVapidKeys(dataDir);
	} catch (error) {
		findings.push({
			check: "push",
			severity: "warn",
			what: "web push signing key is missing, unreadable or mismatched; no push is sent",
			detail: (error as Error).message.slice(0, 2000),
			fix: `move ${keyFile} aside if present, then npm run push:init -- --origin ${config.origin} (every device must turn notifications on again)`,
		});
	}
	if (existsSync(keyFile) && (statSync(keyFile).mode & 0o077) !== 0) {
		findings.push({ check: "push", severity: "warn", what: "web push signing key is readable by other users", fix: `chmod 600 ${keyFile}` });
	}
	const summary = readDeliverySummary(stateDir, now);
	if (summary === null) {
		findings.push({
			check: "push",
			severity: "warn",
			what: "push delivery ledger is unreadable; no push is sent",
			fix: "move state/push-deliveries.json aside; the next sweep starts a fresh baseline (items open then are not pushed)",
		});
	} else if (summary && summary.undelivered_24h > 0) {
		findings.push({
			check: "push",
			severity: "warn",
			what: `${summary.undelivered_24h} push(es) undelivered in the last 24 h${summary.last_error ? ` (last: ${summary.last_error})` : ""}`.slice(0, 200),
			fix: `check the dashboard is reachable at ${config.origin} and that the device still has notifications on; each push gets at most ${PUSH_MAX_ATTEMPTS} attempts`,
		});
	}
	const devices = listSubscriptions(dataDir);
	findings.unshift({
		check: "push",
		severity: "ok",
		what: `web push for ${config.origin}: ${devices.items.length} subscribed device(s)${devices.invalid > 0 ? `, ${devices.invalid} unreadable subscription file(s) ignored` : ""}`.slice(0, 200),
	}, { check: "push", severity: "ok", what: PUSH_RULE });
	return findings;
}
