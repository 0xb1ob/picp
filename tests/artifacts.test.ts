/**
 * T19 acceptance (store half): `state/artifacts/<job-id>/report.md` with
 * `path | add | get`, where `get` writes to a file and never returns a body.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactError, ArtifactStore } from "../src/artifacts.ts";
import { paths } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

function bench(t: { after(fn: () => void): void }, options: { knowsJob?: (jobId: string) => boolean } = {}) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const store = new ArtifactStore({ home: home.path, ...(options.knowsJob ? { knowsJob: options.knowsJob } : {}) });
	return { home: home.path, store };
}

test("path predeclares the canonical report and creates its directory", (t) => {
	const { home, store } = bench(t);
	const path = store.path("cp-t19a");
	assert.equal(path, join(home, paths.artifactFile("cp-t19a")));
	assert.ok(existsSync(join(home, paths.artifactDir("cp-t19a"))), "artifact dir was not created");
	assert.equal(store.has("cp-t19a"), false, "an empty dir is not an artifact");
	// Idempotent: predeclaring twice is how a re-dispatch works.
	assert.equal(store.path("cp-t19a"), path);
});

test("path fails closed on an id that is not path-safe", (t) => {
	const { store } = bench(t);
	assert.throws(() => store.path("../escape"), /unsafe job id/);
	assert.equal(store.has("../escape"), false, "has() must be total, even on hostile ids");
});

test("add files a worker's report into the store by copy", (t) => {
	const { home, store } = bench(t);
	const source = join(home, "scratch/report.md");
	mkdirSync(join(home, "scratch"), { recursive: true });
	writeFileSync(source, "# findings\n\nlong body\n");

	const result = store.add("cp-t19b", source);
	assert.equal(result.copied, true);
	assert.equal(result.path, join(home, paths.artifactFile("cp-t19b")));
	assert.equal(result.bytes, statSync(source).size);
	assert.equal(result.source, source);
	assert.ok(result.modified_at?.endsWith("Z"));
	assert.equal(readFileSync(result.path, "utf8"), "# findings\n\nlong body\n");
	assert.equal(store.has("cp-t19b"), true);
	assert.deepEqual(store.list(), ["cp-t19b"]);
});

test("add of the predeclared path is a no-op, not a self-copy", (t) => {
	const { store } = bench(t);
	const path = store.path("cp-t19c");
	writeFileSync(path, "body\n");
	const result = store.add("cp-t19c", path);
	assert.equal(result.copied, false);
	assert.equal(result.bytes, 5);
	assert.equal(readFileSync(path, "utf8"), "body\n");
});

test("add resolves a relative source against the caller's cwd", (t) => {
	const { home, store } = bench(t);
	mkdirSync(join(home, "work"), { recursive: true });
	writeFileSync(join(home, "work/notes.md"), "notes\n");
	const result = store.add("cp-t19d", "notes.md", { cwd: join(home, "work") });
	assert.equal(result.source, join(home, "work/notes.md"));
	assert.equal(store.has("cp-t19d"), true);
});

test("add fails closed: unknown job, missing file, directory, empty file", (t) => {
	const { home, store } = bench(t, { knowsJob: (jobId) => jobId === "cp-known" });
	const source = join(home, "report.md");
	writeFileSync(source, "body\n");

	assert.throws(() => store.add("cp-stranger", source), (error: Error) => {
		assert.ok(error instanceof ArtifactError);
		assert.match(error.message, /unknown job cp-stranger/);
		return true;
	});
	assert.throws(() => store.add("cp-known", join(home, "nope.md")), /does not exist/);
	assert.throws(() => store.add("cp-known", home), /is not a file/);
	writeFileSync(join(home, "empty.md"), "");
	assert.throws(() => store.add("cp-known", join(home, "empty.md")), /is empty/);
	assert.equal(store.has("cp-known"), false, "nothing may be stored by a refused add");
});

test("get copies the body to a caller-named file and returns metadata only", (t) => {
	const { home, store } = bench(t);
	const path = store.path("cp-t19e");
	writeFileSync(path, "# findings\nbody\n");

	const out = join(home, "handoff/task.md");
	const result = store.get("cp-t19e", out);
	assert.equal(result.out, out);
	assert.equal(result.bytes, statSync(path).size);
	assert.equal(result.source, path);
	assert.equal(readFileSync(out, "utf8"), "# findings\nbody\n");
	// The result is metadata: no field carries the body.
	assert.ok(!JSON.stringify(result).includes("findings"));
});

test("get fails closed: no artifact, empty destination, into-the-store, directory", (t) => {
	const { home, store } = bench(t);
	assert.throws(() => store.get("cp-missing", join(home, "out.md")), /no artifact for cp-missing/);

	const path = store.path("cp-t19f");
	writeFileSync(path, "body\n");
	assert.throws(() => store.get("cp-t19f", "  "), /an output file is required/);
	assert.throws(() => store.get("cp-t19f", join(home, paths.artifactDir("cp-other"), "copy.md")), /artifact store/);
	mkdirSync(join(home, "dir"), { recursive: true });
	assert.throws(() => store.get("cp-t19f", join(home, "dir")), /is a directory/);
});

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
