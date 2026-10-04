import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWorkerMerge, workerMergeRefusal } from "../src/worker-merge-guard.ts";

test("refuses gh pr merge in command position, chained or with -R", () => {
	assert.ok(detectWorkerMerge("gh pr merge 12 --squash"));
	assert.ok(detectWorkerMerge("git push && gh pr merge 12"));
	assert.ok(detectWorkerMerge("gh -R o/r pr merge 12"));
});

test("--admin on a merge command is flagged and the refusal names cp_integrate", () => {
	const finding = detectWorkerMerge("gh pr merge 12 --admin --squash");
	assert.ok(finding?.admin);
	assert.match(workerMergeRefusal(finding), /cp_integrate/);
});

test("does not refuse gh pr create, view or run list", () => {
	assert.equal(detectWorkerMerge("gh pr create --draft --title t --body-file b.md"), undefined);
	assert.equal(detectWorkerMerge("gh pr view 12 --json state"), undefined);
	assert.equal(detectWorkerMerge("gh run list --branch b --limit 3"), undefined);
});

test("quoted or heredoc mentions are not a merge", () => {
	assert.equal(detectWorkerMerge('grep "gh pr merge" docs/x.md'), undefined);
	assert.equal(detectWorkerMerge("echo 'gh pr merge 12 --admin'"), undefined);
	assert.equal(detectWorkerMerge("git commit -F - <<'EOF'\nnever run\ngh pr merge 12\nEOF"), undefined);
});
