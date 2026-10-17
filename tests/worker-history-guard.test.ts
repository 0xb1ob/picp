import assert from "node:assert/strict";
import { test } from "node:test";
import { detectWorkerHistoryRewrite, workerHistoryRefusal } from "../src/worker-history-guard.ts";

test("refuses git rebase in any position, but never rebase --abort", () => {
	assert.equal(detectWorkerHistoryRewrite("git rebase origin/main")?.action, "rebase");
	assert.equal(detectWorkerHistoryRewrite("git fetch origin && git rebase origin/main")?.action, "rebase");
	assert.equal(detectWorkerHistoryRewrite("git -C /w rebase --continue")?.action, "rebase");
	assert.equal(detectWorkerHistoryRewrite("GIT_EDITOR=true /usr/bin/git rebase -i HEAD~2")?.action, "rebase");
	assert.equal(detectWorkerHistoryRewrite("git rebase --abort"), undefined);
});

test("refuses every forced push form", () => {
	for (const command of ["git push --force", "git push -f origin b", "git push --force-with-lease", "git push --force-with-lease=b:abc", "git push origin +b"]) {
		assert.equal(detectWorkerHistoryRewrite(command)?.action, "force-push", command);
	}
	assert.equal(detectWorkerHistoryRewrite("git push"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git push -u origin cp-x"), undefined);
});

test("refuses reset --hard onto a remote ref; a local reset stays allowed", () => {
	for (const command of ["git fetch origin && git reset --hard origin/cp-x", "git reset --hard @{u}", "git reset --hard FETCH_HEAD"]) {
		assert.equal(detectWorkerHistoryRewrite(command)?.action, "reset", command);
	}
	assert.equal(detectWorkerHistoryRewrite("git reset --hard"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git reset --hard HEAD~1"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git reset origin/cp-x"), undefined);
});

test("prose, quoted text and heredoc bodies are not commands", () => {
	assert.equal(detectWorkerHistoryRewrite('grep -n "git rebase" docs/contracts.md'), undefined);
	assert.equal(detectWorkerHistoryRewrite("echo 'git push --force'"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git commit -F - <<'EOF'\nnever run\ngit rebase origin/main\nEOF"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git merge origin/main && git push"), undefined);
});

test("the refusal names the merge alternative and a plain push", () => {
	for (const command of ["git rebase origin/main", "git push --force-with-lease", "git reset --hard origin/cp-x"]) {
		const finding = detectWorkerHistoryRewrite(command);
		assert.ok(finding, command);
		const refusal = workerHistoryRefusal(finding);
		assert.match(refusal, /git merge origin\/<base>/);
		assert.match(refusal, /plain `git push`/);
		assert.ok(refusal.includes(command), refusal);
	}
});
