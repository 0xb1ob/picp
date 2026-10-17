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

test("refuses bundled short push flags that carry -f", () => {
	for (const command of ["git push -uf origin cp-x", "git push -fu origin cp-x", "git push -vf"]) {
		assert.equal(detectWorkerHistoryRewrite(command)?.action, "force-push", command);
	}
	assert.equal(detectWorkerHistoryRewrite("git push -uv origin cp-x"), undefined);
});

test("refuses git pull with rebase, by flag or by -c config", () => {
	for (const command of [
		"git pull --rebase", "git pull -r origin cp-x", "git pull --rebase=merges", "git pull -vr",
		"git -c pull.rebase=true pull", "git -c pull.rebase pull origin main", "git -c branch.cp-x.rebase=interactive pull",
		"git fetch origin && git pull --rebase origin main", "git pull --no-rebase -r",
	]) {
		assert.equal(detectWorkerHistoryRewrite(command)?.action, "pull-rebase", command);
	}
	for (const command of [
		"git pull", "git pull origin main", "git pull --no-rebase", "git pull --rebase=false",
		"git -c pull.rebase=false pull", "git -c pull.rebase=true pull --no-rebase", "git pull -r --no-rebase", "git pull -v",
	]) {
		assert.equal(detectWorkerHistoryRewrite(command), undefined, command);
	}
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
	assert.equal(detectWorkerHistoryRewrite('grep -n "git pull --rebase" docs/contracts.md'), undefined);
	assert.equal(detectWorkerHistoryRewrite("echo 'git push -uf origin x' && git -c core.editor=true pull"), undefined);
	assert.equal(detectWorkerHistoryRewrite("git commit -F - <<'EOF'\nnever git pull -r\ngit push -fu origin x\nEOF"), undefined);
	assert.equal(detectWorkerHistoryRewrite("cat <<EOF > notes.md\ngit -c pull.rebase=true pull\nEOF"), undefined);
});

test("the refusal names the merge alternative and a plain push", () => {
	for (const command of ["git rebase origin/main", "git push --force-with-lease", "git reset --hard origin/cp-x", "git pull -r", "git push -uf"]) {
		const finding = detectWorkerHistoryRewrite(command);
		assert.ok(finding, command);
		const refusal = workerHistoryRefusal(finding);
		assert.match(refusal, /git fetch origin && git merge origin\/<branch>/);
		assert.match(refusal, /git merge origin\/<base>/);
		assert.match(refusal, /plain `git push`/);
		assert.ok(refusal.includes(command), refusal);
	}
});
