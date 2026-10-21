import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { validateJobsDocument } from "../src/contracts.ts";
import { createScratchLedger } from "./harness/index.ts";

// A retired tracker link is inert native metadata: native writes keep it, and the document
// still refuses two jobs linking one item (#384).
test("ordinary create is unchanged by tracker links, and the document refuses a duplicate key", async (t) => {
	const scratch = createScratchLedger({ knownProjects: ["demo"] });
	t.after(() => scratch.cleanup());
	const linked = await scratch.ledger.create({ title: "shared title", project: "demo", delivery: "pr" });
	await scratch.ledger.close(linked.id, "done");
	const seeded = scratch.document();
	const link = { connection_id: "demo-legacy", item_id: "b-1", linked_at: seeded.jobs[0]!.created_at };
	seeded.jobs[0]!.tracker = link;
	writeFileSync(scratch.ledger.file, JSON.stringify(seeded));
	const plain = await scratch.ledger.create({ title: "shared title", project: "demo", delivery: "pr" });
	assert.notEqual(plain.id, linked.id);
	assert.equal(plain.tracker, undefined);
	assert.deepEqual((await scratch.ledger.show(linked.id)).tracker, link, "a native write keeps the inert link");
	const doc = scratch.document();
	const duplicate = { ...doc, jobs: [...doc.jobs, { ...doc.jobs[0]!, id: "cp-dupe", status: "open" as const, closed_at: undefined, close_reason: undefined }] };
	const result = validateJobsDocument(JSON.parse(JSON.stringify(duplicate)));
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.errors.join("\n"), /cp-dupe and .* link the same tracker item demo-legacy\/b-1/);
});
