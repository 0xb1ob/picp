/** Retained from artifacts (P11): `ArtifactStore.remove` has no production caller, so no entry point reaches it. */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { createScratchHome } from "./harness/index.ts";

function bench(t: { after(fn: () => void): void }, options: { knowsJob?: (jobId: string) => boolean } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new ArtifactStore({ home: home.path, ...(options.knowsJob ? { knowsJob: options.knowsJob } : {}) });
	return { home: home.path, store };
}

test("info stats without reading, and remove drops the directory", (t) => {
	const { store } = bench(t);
	assert.deepEqual(store.info("cp-t19g"), {
		job_id: "cp-t19g",
		path: store.file("cp-t19g"),
		present: false,
		bytes: 0,
	});
	writeFileSync(store.path("cp-t19g"), "body\n");
	const info = store.info("cp-t19g");
	assert.equal(info.present, true);
	assert.equal(info.bytes, 5);

	assert.equal(store.remove("cp-t19g"), true);
	assert.equal(existsSync(store.dir("cp-t19g")), false);
	assert.equal(store.remove("cp-t19g"), false);
});
