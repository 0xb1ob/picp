import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHostAuthCopy, hostAuthCopyRefusal } from "../src/worker-credential-guard.ts";

// Synthetic commands only: nothing here reads or copies a real credential file.
test("a copy of the host auth.json is refused, by command position", () => {
	for (const command of [
		"cp ~/.pi/agent/auth.json /tmp/agent/",
		"mkdir -p /tmp/a && cp $HOME/.pi/agent/auth.json /tmp/a/auth.json",
		"cp -p ${HOME}/.pi/agent/models.json ${HOME}/.pi/agent/auth.json /tmp/a/",
		"cp /home/someone/.pi/agent/auth.json /tmp/a/",
		"for f in auth.json models.json; do cp ~/.pi/agent/$f /tmp/a/; done",
		"for f in models.json auth.json; do\n  cp -p $HOME/.pi/agent/${f} /tmp/a/\ndone",
	]) {
		assert.ok(detectHostAuthCopy(command), command);
	}
	const finding = detectHostAuthCopy(`cp ~/.pi/agent/auth.json /tmp/${"x".repeat(300)}`);
	assert.ok(finding && finding.matched.length <= 120);
	const refusal = hostAuthCopyRefusal(finding);
	assert.match(refusal, /models\.json/);
	assert.match(refusal, /blocked/);
});

test("a models.json copy, quoted mentions and heredoc bodies pass", () => {
	for (const command of [
		"cp ~/.pi/agent/models.json /tmp/a/models.json",
		"for f in models.json; do cp ~/.pi/agent/$f /tmp/a/; done",
		'grep -rn "cp ~/.pi/agent/auth.json" docs/',
		"echo 'cp ~/.pi/agent/auth.json /tmp/a'",
		"cat ~/.pi/agent/models.json | head",
		"git commit -F - <<'EOF'\nnever cp ~/.pi/agent/auth.json anywhere\nEOF",
		"gh pr create --title t --body-file - <<EOF\nwe did not run:\ncp $HOME/.pi/agent/auth.json /tmp/a\nEOF",
	]) {
		assert.equal(detectHostAuthCopy(command), undefined, command);
	}
	assert.equal(detectHostAuthCopy(""), undefined);
});
