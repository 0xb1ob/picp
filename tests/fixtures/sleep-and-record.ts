/**
 * Fixture for tests/test-concurrency-bound.test.ts. Deliberately NOT named
 * `*.test.ts`: the suite glob must not pick it up, and it is never run in
 * place — the parent test copies it under generated names into a scratch
 * directory, because `node --test` runs one OS-level worker per *file*, and
 * proving a concurrency bound needs several distinct files in flight at once.
 *
 * Each copy appends `start,<file>,<ts>` / `end,<file>,<ts>` to the path in
 * `CP_CONCURRENCY_LOG`, using its own filename (via `import.meta.url`) as the
 * label — not an env var, because every copy of this file shares the same
 * environment when `node --test` runs them together.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const logPath = process.env.CP_CONCURRENCY_LOG;
const label = fileURLToPath(import.meta.url).split("/").pop() ?? "unknown";

function record(event: "start" | "end") {
	if (!logPath) return;
	appendFileSync(logPath, `${event},${label},${Date.now()}\n`);
}

test(`sleeps under label ${label}`, async () => {
	record("start");
	await new Promise((resolve) => setTimeout(resolve, 400));
	record("end");
});
