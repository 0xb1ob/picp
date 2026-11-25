/**
 * `/doctor` worker commit signing (signing.pi, signing.claude, signing.codex) through `/doctor --json` in a real pi
 * parent: a host that does not sign, one that signs with a readable ssh key file, one whose key file is missing.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DoctorReport } from "../../src/contracts.ts";
import { signingKey, signsConfig } from "../harness/commit-signing.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome } from "../harness/index.ts";
import { MockProvider, type RpcRecord, startPiChild } from "../harness/index.ts";

type Finding = DoctorReport["findings"][number];
const IDENTITY = "[user]\n\tname = ds1\n\temail = ds1@test.invalid\n";
const DEDICATED = "use a dedicated ssh-agent (or a gpg key) that holds only the signing key";
const checks = (found: Finding[]) => found.map((finding) => [finding.check, finding.severity]);

// Scenario: GIT_CONFIG_GLOBAL does not sign, then signs with a readable key file, then names a missing one: each
//   /doctor --json says unsigned (ok), signed (claude and codex warn, with the fix), then failing (warn).
test("DS-1: /doctor says per driver whether worker commits will be signed", { timeout: 300_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const host = mkdtempSync(join(tmpdir(), "cp-ds1-host-"));
	t.after(async () => {
		agent.cleanup();
		await provider.stop();
		home.cleanup();
		rmSync(host, { recursive: true, force: true });
	});
	const config = join(host, "gitconfig");
	writeFileSync(config, IDENTITY);
	const model = provider.addScript("ds1", [{ kind: "text", text: "idle" }]);
	agent.writeModels(provider);
	const env = { ...agent.env, CP_HOME: home.path, GIT_CONFIG_GLOBAL: config };
	const child = startPiChild({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION], env });
	t.after(() => child.close());
	const used = new Set<RpcRecord>();
	const doctor = async (): Promise<Finding[]> => {
		child.send({ id: `doctor-${used.size}`, type: "prompt", message: "/doctor --json" });
		const record = await child.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify"
			&& !used.has(r) && String(r.message).trimStart().startsWith("{"), 120_000);
		used.add(record);
		const report = JSON.parse(String(record.message)) as DoctorReport;
		return report.findings.filter((finding) => finding.check.startsWith("signing."));
	};
	const off = await doctor();
	assert.deepEqual(checks(off), [["signing.pi", "ok"], ["signing.claude", "ok"], ["signing.codex", "ok"]]);
	for (const finding of off) assert.match(finding.what, /commits unsigned; the host does not sign/);
	appendFileSync(config, signsConfig(signingKey(host).file));
	const ready = await doctor();
	assert.deepEqual(checks(ready), [["signing.pi", "ok"], ["signing.claude", "warn"], ["signing.codex", "warn"]]);
	for (const finding of ready) assert.match(finding.what, /commits signed \(ssh, key file\)/);
	for (const finding of ready.slice(1)) {
		assert.match(finding.what, /the key is reachable by the worker's shell/);
		assert.equal(finding.fix, DEDICATED);
	}
	assert.match(ready[1]?.detail ?? "", /best effort only/);
	assert.match(ready[2]?.detail ?? "", /tool-call guard refuses the key path, best effort only/);
	writeFileSync(config, `${IDENTITY}${signsConfig(join(host, "keys", "missing"))}`);
	const broken = await doctor();
	assert.deepEqual(checks(broken), [["signing.pi", "warn"], ["signing.claude", "warn"], ["signing.codex", "warn"]]);
	for (const finding of broken.slice(1)) {
		assert.match(finding.what, /commit_signing_unavailable: user\.signingkey names a key file that is missing/);
	}
	assert.ok(broken.every((finding) => (finding.fix ?? "").includes("SSH_AUTH_SOCK")), JSON.stringify(broken));
});
