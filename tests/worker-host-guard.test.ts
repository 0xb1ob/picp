import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_AUDIT_FILE, keyPathIn, remoteHostCall, workerHostGuard } from "../src/worker-host-guard.ts";

test("private ssh keys and *.pem files are refused; public keys, ssh config and ssh -i pass", () => {
	for (const command of ["cat ~/.ssh/id_ed25519", "base64 $HOME/.ssh/id_rsa", "cp /home/u/.ssh/id_ecdsa /tmp/k", "cat ~/.ssh/*", "openssl x509 -in cert.pem", "echo $(cat \"~/.ssh/deploy.key\")", "ssh box 'cat ~/.ssh/id_rsa'"]) {
		assert.ok(keyPathIn(command), command);
	}
	for (const command of ["cat ~/.ssh/id_ed25519.pub", "cat ~/.ssh/config", "ssh -i ~/.ssh/id_ed25519 box uptime", "scp -i key.pem box:/x .", "git push", "grep -rn \".pem\" src", "cat > r.md <<'EOF'\nnever read ~/.ssh/id_rsa\nEOF"]) {
		assert.equal(keyPathIn(command), undefined, command);
	}
	assert.match(workerHostGuard("read", { path: "/home/u/.ssh/id_rsa" }, "/nonexistent") ?? "", /never reads a private ssh key/);
	assert.equal(workerHostGuard("read", { path: "/home/u/.ssh/known_hosts" }, "/nonexistent"), undefined);
});

test("ssh/scp/sftp/rsync in command position are remote calls; prose, git and heredoc bodies are not", () => {
	for (const command of ["ssh box uptime", "cd x && scp box:/a .", "FOO=1 rsync -a box:/a .", "out=$(sftp box)"]) assert.ok(remoteHostCall(command), command);
	for (const command of ["echo ssh box", "git push origin x", "ssh-keygen -l -f k.pub", "cat > r.md <<'EOF'\nssh box\nEOF"]) assert.equal(remoteHostCall(command), false, command);
});

// Every allowed remote call is appended to <runDir>/host-audit.jsonl before it runs; an unwritable audit refuses the
// call (fail closed) instead of letting an unaudited ssh through.
test("an allowed remote call is audited, a local command is not, and an unwritable audit refuses", (t) => {
	const runDir = mkdtempSync(join(tmpdir(), "host-audit-"));
	t.after(() => rmSync(runDir, { recursive: true, force: true }));
	const at = () => new Date("2026-10-17T12:00:00Z");
	assert.equal(workerHostGuard("bash", { command: "ssh box 'schtasks /query'" }, runDir, at), undefined);
	assert.equal(workerHostGuard("bash", { command: "ls -la" }, runDir, at), undefined);
	const lines = readFileSync(join(runDir, HOST_AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(lines, [{ at: "2026-10-17T12:00:00.000Z", command: "ssh box 'schtasks /query'" }]);
	assert.match(workerHostGuard("bash", { command: "scp box:/a ." }, join(runDir, "missing"), at) ?? "", /host audit .* could not be written/);
});
