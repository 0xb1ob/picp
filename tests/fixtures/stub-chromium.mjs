#!/usr/bin/env node
// A `chromium` stand-in (WP2): writes an 8-byte PNG header to `--screenshot=<path>` and, beside it, `<path>.env`
// holding the PLAYWRIGHT_BROWSERS_PATH it saw (or nothing), the way a headless screenshot lands a file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const shot = process.argv.slice(2).find((arg) => arg.startsWith("--screenshot="))?.slice("--screenshot=".length);
if (!shot) {
	process.stderr.write("stub-chromium: no --screenshot=<path>\n");
	process.exit(2);
}
const file = resolve(shot);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
writeFileSync(`${file}.env`, process.env.PLAYWRIGHT_BROWSERS_PATH ?? "");
process.stdout.write(`Written to file ${file}\n`);
