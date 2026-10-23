import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_BUILTIN_EXTENSIONS, runOperator } from "../../src/viewer/operator.ts";
import { REPO_ROOT } from "../harness/index.ts";

const names = [
	"S27 launcher: once preserves resume arguments, exit status and marker ownership",
	"S27 launcher: other preserves resume arguments, exit status and marker ownership",
	"S27 launcher: never preserves resume arguments, exit status and marker ownership",
	"S27 launcher: gone preserves resume arguments, exit status and marker ownership",
	"S27 launcher: always preserves resume arguments, exit status and marker ownership",
];
for (const [index, mode] of (["once", "other", "never", "gone", "always"] as const).entries()) {
	test(names[index]!, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "cp-s27-agent-"));
		const session = join(dir, "2026-01-01T00-00-00-000Z_0123abcd.jsonl");
		if (mode !== "gone") writeFileSync(session, "");
		const marker = join(dir, "relaunch.json");
		const log = join(dir, "argv.log");
		const env = { PI_CODING_AGENT_DIR: dir, CP_OPERATOR_VIEWER: "service", CP_OPERATOR_WEB: "0", CP_OPERATOR_MODEL: "test-model",
			FAKE_RELAUNCH_LOG: log, FAKE_RELAUNCH_MODE: mode === "gone" ? "once" : mode, FAKE_RELAUNCH_SESSION: session };
		const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
		Object.assign(process.env, env);
		const lines: string[] = [];
		const stderr = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof stderr;
		t.after(() => {
			process.stderr.write = stderr;
			for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(dir, { recursive: true, force: true });
		});
		const code = await runOperator(mode === "never" ? ["--model", "x"] : [], { piBin: join(REPO_ROOT, "tests/fixtures/fake-relaunch-pi.mjs"),
			viewer: { host: "127.0.0.1", port: 1 }, relaunchFile: marker, relaunchLimit: { count: 2, windowMs: 600000 } });
		const runs = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const builtins = OPERATOR_BUILTIN_EXTENSIONS.flatMap((entry) => ["-e", entry]);
		assert.deepEqual(runs[0], [...builtins, "--model", mode === "never" ? "x" : "test-model"]);
		assert.equal(code, mode === "once" || mode === "gone" ? 2 : mode === "never" ? 1 : 0);
		assert.equal(runs.length, mode === "always" ? 3 : mode === "once" || mode === "gone" ? 2 : 1);
		assert.equal(existsSync(marker), mode === "other");
		for (const args of runs.slice(1)) assert.deepEqual(args, [...builtins, ...(mode === "gone" ? ["-c"] : ["--session", session])]);
		if (mode === "once") assert.ok(lines.includes(`cp-operator: restarting from the dashboard, resuming ${session}\n`));
		if (mode === "gone") assert.ok(lines.some((line) => line.includes(`${session} is gone, continuing the most recent session (-c)`)));
		if (mode === "always") assert.ok(lines.some((line) => line.startsWith(`cp-operator: not restarting: 2 restarts within 10 min; resume by hand: cp-operator --session ${session}`)));
	});
}
