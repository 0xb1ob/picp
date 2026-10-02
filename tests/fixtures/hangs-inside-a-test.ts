/**
 * Fixture for tests/test-runner-bounds.test.ts. Deliberately NOT named
 * `*.test.ts`: the suite glob must not pick it up, because it is designed to
 * fail.
 *
 * The other class of hang: the await never settles, so the test itself is stuck
 * rather than the process outliving it. This one `--test-timeout` does bound —
 * which is exactly why the repo needs a finite value instead of the default.
 */

import { test } from "node:test";

test("never resolves", async () => {
	await new Promise(() => {});
});
