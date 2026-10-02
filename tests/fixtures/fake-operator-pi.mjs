#!/usr/bin/env node
/**
 * Stand-in for the operator's `pi`: exits with FAKE_PI_EXIT_CODE (once
 * FAKE_PI_WAIT_FOR exists, when set), or stays up until a signal ends it
 * (default disposition, like a real session).
 */
import { existsSync, writeFileSync } from "node:fs";

const code = process.env.FAKE_PI_EXIT_CODE;
const waitFor = process.env.FAKE_PI_WAIT_FOR;
if (process.env.FAKE_PI_ADDRESS_FILE) {
	writeFileSync(process.env.FAKE_PI_ADDRESS_FILE, JSON.stringify({ host: process.env.CP_VIEWER_HOST, port: process.env.CP_VIEWER_PORT, args: process.argv.slice(2) }));
}
setInterval(() => {
	if (code !== undefined && (!waitFor || existsSync(waitFor))) process.exit(Number(code));
}, 20);
