/**
 * C8 `/doctor` Codex lines (CX-8d) through `/doctor --json` in real pi parents: fake-codex and the fake `systemd-run`
 * first on PATH, then a PATH with no `codex`. No model turn runs; the Codex home is a temp dir holding a sentinel.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { type DoctorReport, LAYOUT } from "../../src/contracts.ts";
import { whichAll } from "../../src/doctor.ts";
import { AUTH_SENTINEL, type FakeCodexScript, fakeSpawns, installCodexStub, writeCodexScript } from "../harness/codex-mock.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, type RpcRecord, startPiChild } from "../harness/index.ts";

type Finding = DoctorReport["findings"][number];
const NO_KEYS = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", CP_GATEWAY_ADMIN_KEY: "" };

async function bench(t: TestContext) {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agent = createAgentDir({ provider });
	const root = mkdtempSync(join(tmpdir(), "cp-codex-doctor-"));
	t.after(async () => { agent.cleanup(); await provider.stop(); home.cleanup(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
	const [bin, state, codexHome] = ["codex-release/bin", "state", "codex-home"].map((name) => join(root, name)) as [string, string, string];
	for (const dir of [bin, state, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(codexHome, "auth.json"), `${AUTH_SENTINEL}\n`, { mode: 0o600 });
	const script = join(root, "script.json");
	writeCodexScript(script, { turns: [] });
	installCodexStub(bin, { script, stateDir: state });
	/** A real parent on this home; `doctor()` answers one `/doctor --json` report per call. */
	const parent = (env: NodeJS.ProcessEnv) => {
		const model = provider.addScript(`cx8d-${Math.random().toString(36).slice(2, 8)}`, [{ kind: "text", text: "idle" }]);
		agent.writeModels(provider);
		const child = startPiChild({ cwd: home.path, model, extensions: [COMMAND_POST_EXTENSION], env: { ...agent.env, CP_HOME: home.path, CP_CODEX_HOME: codexHome, ...NO_KEYS, ...env } });
		t.after(() => child.close());
		const used = new Set<RpcRecord>();
		const doctor = async (): Promise<Finding[]> => {
			child.send({ id: `doctor-${used.size}`, type: "prompt", message: "/doctor --json" });
			const record = await child.waitFor((r) => r.type === "extension_ui_request" && r.method === "notify" && !used.has(r) && String(r.message).trimStart().startsWith("{"), 120_000);
			used.add(record);
			return (JSON.parse(String(record.message)) as DoctorReport).findings.filter((finding) => finding.check.startsWith("codex."));
		};
		return { child, doctor };
	};
	const native = (value: object | null) => (value === null ? rmSync(join(home.path, LAYOUT.data, "native.json"), { force: true }) : writeFileSync(join(home.path, LAYOUT.data, "native.json"), JSON.stringify(value)));
	return { home: home.path, bin, state, codexHome, parent, native, knobs: (knobs: FakeCodexScript["knobs"]) => writeCodexScript(script, { knobs, turns: [] }) };
}

const one = (findings: Finding[], check: string) => {
	const found = findings.filter((finding) => finding.check === check);
	assert.equal(found.length, 1, `${check}: ${JSON.stringify(findings)}`);
	return found[0] as Finding;
};

// Scenario (C8 A1, P1): Given fake-codex on PATH, When /doctor runs with default knobs, then version 0.169.0, then a
//   signed-out login beside codex_research, then a codex reviews row with codex_review off, and last on a PATH with no
//   codex, Then each codex line names its fix: ok while codex is unused, warn once a switch or row uses it, no error.
//   Only `--version` and `login status` ever reach the CLI, and the Codex home listing is unchanged.
test("CX-8d: /doctor names a missing, below-floor and signed-out codex, its containment and a codex row whose switch is off", { timeout: 300_000 }, async (t) => {
	const h = await bench(t);
	const listing = readdirSync(h.codexHome).sort();
	const first = h.parent({ PATH: `${h.bin}${delimiter}${process.env.PATH ?? ""}` });

	const healthy = await first.doctor();
	assert.deepEqual(healthy.map((f) => [f.check, f.severity]), [["codex.containment", "ok"], ["codex.cli", "ok"], ["codex.login", "ok"], ["codex.workers", "ok"]]);
	assert.deepEqual([one(healthy, "codex.cli").what, one(healthy, "codex.cli").detail], ["codex 0.170.0", join(h.bin, "codex")]);
	assert.equal(one(healthy, "codex.containment").detail?.startsWith(join(h.bin, "systemd-run")), true);
	assert.equal(one(healthy, "codex.workers").what, "Codex workers: every codex switch off (shipped default)");

	h.knobs({ version: "0.169.0" });
	const old = await first.doctor();
	assert.deepEqual([one(old, "codex.cli").severity, one(old, "codex.cli").what, one(old, "codex.cli").fix], ["ok", "codex 0.169.0 is below the Codex driver floor 0.170.0: run `codex update`", "run `codex update`"]);
	assert.equal(old.some((f) => f.check === "codex.login"), false, "no login probe without a usable CLI");

	h.knobs({ loginStatus: 1 });
	h.native({ codex_research: true });
	const signedOut = await first.doctor();
	assert.deepEqual([one(signedOut, "codex.login").severity, one(signedOut, "codex.login").what], ["warn", "codex is not signed in: run `codex login`"]);
	assert.match(one(signedOut, "codex.login").fix ?? "", /codex login/);
	assert.deepEqual([one(signedOut, "codex.workers").severity, one(signedOut, "codex.workers").what], ["ok", "Codex workers: codex_research on"]);

	h.knobs({});
	const routingFile = join(h.home, LAYOUT.routingFile);
	const shipped = readFileSync(routingFile, "utf8");
	const routing = JSON.parse(shipped) as { rubric: Array<Record<string, unknown>> };
	Object.assign(routing.rubric.find((row) => row.id === "reviews")!, { model: "openai/gpt-5", driver: "codex" });
	writeFileSync(routingFile, JSON.stringify(routing));
	const dark = one(await first.doctor(), "codex.workers");
	assert.deepEqual([dark.severity, dark.what], ["warn", "Codex workers: 1 codex row(s) run pi because their class switch is off"]);
	assert.match(dark.fix ?? "", /^turn codex_review on in Settings → Native workers, or remove the driver from reviews$/);
	assert.match(dark.detail ?? "", /codex_research on, codex_ship off, codex_review off; codex_max_concurrent 1; rows naming codex: reviews/);
	await first.child.close();

	// Missing: every PATH dir keeps its tools but loses `codex` (the native-routing S1 shim pattern).
	writeFileSync(routingFile, shipped);
	const shim = join(h.home, "no-codex");
	mkdirSync(shim, { mode: 0o700 });
	for (const dir of whichAll("codex", process.env).map((file) => dirname(file))) {
		for (const name of readdirSync(dir)) if (name !== "codex" && !existsSync(join(shim, name))) symlinkSync(join(dir, name), join(shim, name));
	}
	const kept = (process.env.PATH ?? "").split(delimiter).filter((dir) => !existsSync(join(dir, "codex")));
	const missing = await h.parent({ PATH: [shim, ...kept].join(delimiter) }).doctor();
	assert.deepEqual([one(missing, "codex.cli").severity, one(missing, "codex.cli").what, one(missing, "codex.cli").fix],
		["warn", "codex is not on PATH: install the Codex CLI, then run `codex update`", "install the Codex CLI, then run `codex update`"]);
	assert.equal(missing.some((f) => f.check === "codex.login"), false);

	for (const findings of [healthy, old, signedOut, missing]) assert.ok(findings.every((f) => f.severity !== "error" && (f.severity === "ok" || f.fix)), JSON.stringify(findings));
	const argv = fakeSpawns(h.state).map((spawn) => spawn.argv.join(" "));
	assert.deepEqual([...new Set(argv)].sort(), ["--version", "login status"], "only the version and the login exit code are asked");
	assert.deepEqual(readdirSync(h.codexHome).sort(), listing, "the Codex home is never written");
});
