#!/usr/bin/env node
/**
 * `npm run push:init -- --origin https://<dashboard host> [--home <home>] [--subject mailto:<address>]`
 *
 * Generate this home's Web Push (VAPID) key pair once, and record the dashboard's HTTPS origin. Writes
 * `data/push/vapid.key` (0600) and `data/push/config.json`; never overwrites keys and never prints key material.
 * Policy lives in src/push/keys.ts. Exit codes: 0 configured, 2 bad arguments or a refused config.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeHome } from "../src/home.ts";
import { initPush, PushConfigError } from "../src/push/keys.ts";
import { pushDataDir } from "../src/viewer/push-files.ts";
import { resolveStateDir } from "../src/viewer/sessions.ts";

const USAGE = "usage: npm run push:init -- --origin https://<dashboard host> [--home <home>] [--subject mailto:<address>]";

function main(): number {
	let values: { home?: string | undefined; origin?: string | undefined; subject?: string | undefined; help?: boolean | undefined };
	try {
		({ values } = parseArgs({ options: { home: { type: "string" }, origin: { type: "string" }, subject: { type: "string" }, help: { type: "boolean" } }, strict: true }));
	} catch (error) {
		console.error(`push-init: ${(error as Error).message}\n${USAGE}`);
		return 2;
	}
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	if (!values.origin) {
		console.error(`push-init: --origin is required\n${USAGE}`);
		return 2;
	}
	const home = resolve(values.home ?? describeHome().home);
	const dataDir = pushDataDir(resolveStateDir(home));
	try {
		const result = initPush({ dataDir, origin: values.origin, ...(values.subject ? { subject: values.subject } : {}) });
		const where = `keys in ${resolve(dataDir, "push")}, never printed`;
		if (result.created) console.log(`web push configured for ${result.origin} (${where})`);
		else if (result.originChanged) console.log(`web push origin changed to ${result.origin}; keys kept (${where})`);
		else if (result.configWritten) console.log(`web push config updated for ${result.origin}; keys kept (${where})`);
		else console.log(`web push already configured for ${result.origin} (${where})`);
		return 0;
	} catch (error) {
		if (error instanceof PushConfigError) {
			console.error(`push-init: ${error.message}`);
			return 2;
		}
		throw error;
	}
}

process.exit(main());
