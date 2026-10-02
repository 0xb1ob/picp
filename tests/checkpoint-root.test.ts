/** cp-u3i2: `CheckpointStore.list` reads the layout's checkpoints dir, never a literal `state/checkpoints`. */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointStore } from "../src/checkpoint.ts";
import { createScratchHome } from "./harness/index.ts";

test("a requested checkpoint lands under .pi-command-post/state/checkpoints and list() finds it", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new CheckpointStore(home.path);
	store.request({ jobId: "cp-a1", question: "ship?" });
	assert.ok(existsSync(join(home.path, ".pi-command-post/state/checkpoints/cp-a1.json")));
	assert.deepEqual(store.list().map((checkpoint) => checkpoint.job_id), ["cp-a1"]);
});
