/**
 * cp-u3i2 PR 3: `/doctor`'s `storage.*` findings. Each test builds one home
 * shape and asserts the check id, the severity and that the finding names a
 * fix. This file is an R1 allowlist entry: it builds the old top-level
 * `state/` on purpose, to prove it is flagged.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type DoctorFinding, DoctorFindingSchema, LAYOUT, validate } from "../src/contracts.ts";
import type { CommandRunner } from "../src/doctor.ts";
import { storageFindings } from "../src/storage.ts";
import { createScratchHome } from "./harness/index.ts";

function home(t: { after(fn: () => void): void }): string {
	const scratch = createScratchHome();
	t.after(() => scratch.cleanup());
	mkdirSync(join(scratch.path, LAYOUT.state), { recursive: true });
	mkdirSync(join(scratch.path, LAYOUT.data), { recursive: true });
	return scratch.path;
}

const noRun: CommandRunner = () => assert.fail("run must not be called");

function checked(findings: DoctorFinding[]): DoctorFinding[] {
	for (const finding of findings) {
		assert.ok(validate(DoctorFindingSchema, finding).ok, `${finding.check} violates DoctorFindingSchema`);
		if (finding.severity !== "ok") assert.ok(finding.fix, `${finding.check} has no fix`);
		assert.notEqual(finding.severity, "error", "storage findings are warn-only");
	}
	return findings;
}

test("a home with only .pi-command-post/, .beads/ and .gitignore is one ok storage finding", (t) => {
	const dir = home(t);
	mkdirSync(join(dir, ".beads"));
	writeFileSync(join(dir, ".gitignore"), ".pi-command-post/\n.beads/\n");
	writeFileSync(join(dir, LAYOUT.fleetFile), "{}");
	writeFileSync(join(dir, LAYOUT.state, "parent.lock"), "");
	assert.deepEqual(checked(storageFindings(dir, noRun)).map((f) => [f.check, f.severity]), [["storage", "ok"]]);
});

test("storage.home: a leftover top-level state/ in a home without .git is a warn", (t) => {
	const dir = home(t);
	mkdirSync(join(dir, "state"));
	const [finding] = checked(storageFindings(dir, noRun));
	assert.equal(finding?.check, "storage.home");
	assert.equal(finding?.severity, "warn");
	assert.equal(finding?.detail, "state");
	assert.match(finding?.fix ?? "", /old layout/);
});

test("storage.alias: a flat-named home inside another home warns and names the parent; a standard home does not", (t) => {
	const parent = createScratchHome();
	t.after(() => parent.cleanup());
	const flat = join(parent.path, ".pi-command-post");
	mkdirSync(flat, { recursive: true });
	assert.deepEqual(checked(storageFindings(flat, noRun)).map((f) => f.check), ["storage"], "a parent that is not a home: no alias");

	writeFileSync(join(parent.path, ".gitignore"), ".pi-command-post/\n.beads/\n");
	const [alias] = checked(storageFindings(flat, noRun));
	assert.equal(alias?.check, "storage.alias");
	assert.equal(alias?.severity, "warn");
	assert.equal(alias?.what, `this home is another home's runtime root; use ${parent.path} as the home`);
	assert.doesNotMatch(alias?.what ?? "", /CP_HOME/, "the diagnostic names no one source: CP_HOME, a setting or a launch directory can all get here");
	assert.match(alias?.detail ?? "", /\.gitignore lists \.pi-command-post\//);
	assert.match(alias?.fix ?? "", new RegExp(`point this session at ${parent.path}`));

	// A repository's .git/info/exclude line is the same evidence as a .gitignore entry.
	rmSync(join(parent.path, ".gitignore"));
	mkdirSync(join(parent.path, ".git", "info"), { recursive: true });
	writeFileSync(join(parent.path, ".git", "info", "exclude"), ".pi-command-post/\n");
	assert.match(checked(storageFindings(flat, noRun))[0]?.detail ?? "", /\.git\/info\/exclude lists/);
});

test("storage.home: a checkout home lists untracked, unignored paths through git", (t) => {
	const dir = home(t);
	mkdirSync(join(dir, ".git"));
	const calls: string[] = [];
	const run = (stdout: string, status = 0): CommandRunner => (command, args, cwd) => {
		calls.push(`${cwd}: ${command} ${args.join(" ")}`);
		return { status, stdout, stderr: status ? "fatal: broken" : "" };
	};
	assert.deepEqual(checked(storageFindings(dir, run(""))).map((f) => f.check), ["storage"]);
	assert.deepEqual(calls, [`${dir}: git ls-files --others --exclude-standard --directory`]);

	const [leftover] = checked(storageFindings(dir, run("data/\nstate/\nprojects/\n")));
	assert.equal(leftover?.check, "storage.home");
	assert.match(leftover?.what ?? "", /^3 home entries/);
	assert.equal(leftover?.detail, "data/; state/; projects/");

	const [unlisted] = checked(storageFindings(dir, run("", 128)));
	assert.equal(unlisted?.check, "storage.home");
	assert.match(unlisted?.what ?? "", /could not be listed/);
	assert.match(unlisted?.detail ?? "", /fatal: broken/);
});

test("storage.state: operator material at the top of state/ is a warn; records are not", (t) => {
	const dir = home(t);
	for (const name of ["drain.json", "bridge-retry.jsonl", "parent-host.3.sock", "parent-host.log", "x.tmp"]) {
		writeFileSync(join(dir, LAYOUT.state, name), "");
	}
	mkdirSync(join(dir, LAYOUT.state, "runs"));
	assert.deepEqual(checked(storageFindings(dir, noRun)).map((f) => f.check), ["storage"]);

	writeFileSync(join(dir, LAYOUT.state, "handoff.md"), "# notes\n");
	const [finding] = checked(storageFindings(dir, noRun));
	assert.equal(finding?.check, "storage.state");
	assert.equal(finding?.detail, "handoff.md");
	assert.ok(finding?.fix?.includes(join(dir, LAYOUT.operatorWorkspace)));
});

test("storage.handoffs_dir: invalid JSON and a directory outside the home warn; inside the home is fine", (t) => {
	const dir = home(t);
	const settings = join(dir, LAYOUT.data, "operator.json");
	const only = () => checked(storageFindings(dir, noRun));

	writeFileSync(settings, JSON.stringify({ handoffs_dir: join(dir, LAYOUT.operatorWorkspace, "handoffs") }));
	assert.deepEqual(only().map((f) => f.check), ["storage"]);

	writeFileSync(settings, "{not json");
	assert.deepEqual(only().map((f) => [f.check, f.severity]), [["storage.handoffs_dir", "warn"]]);
	assert.match(only()[0]?.what ?? "", /not valid JSON/);

	writeFileSync(settings, JSON.stringify({ handoffs_dir: "/tmp/handoffs" }));
	const [outside] = only();
	assert.equal(outside?.check, "storage.handoffs_dir");
	assert.equal(outside?.detail, "/tmp/handoffs");
	assert.match(outside?.fix ?? "", /operator\/handoffs/);
});
