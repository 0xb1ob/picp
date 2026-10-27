import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	declarationTitles, deletedWithFeatureFindings, featureRemovedFindings, ledgerFindings, regressionFindings, retainedFindings,
} from "../scripts/test-migration-check.ts";

const exists = (path: string) => path === "src/kept.ts";

test("deleted-with-feature accepts a named remover and removed source modules, and needs no negative control", () => {
	assert.deepEqual(deletedWithFeatureFindings("tests/x.test.ts", "cp-remove-x (#12)", "tested `src/x.ts`", exists), []);
	assert.deepEqual(deletedWithFeatureFindings("tests/x.test.ts", "#12", "tested extensions/command-post/x.ts", exists), []);
});

test("deleted-with-feature rejects a phase-only owner, no cited module, and a module still in the tree", () => {
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "P1", "tested `src/x.ts`", exists).join("\n"), /must name the removing PR or job/);
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "#12", "feature retired", exists).join("\n"), /names no removed source module/);
	assert.match(deletedWithFeatureFindings("tests/x.test.ts", "#12", "src/x.ts, src/kept.ts", exists).join("\n"),
		/cites src\/kept\.ts, which still exists/);
});

test("retained accepts a note naming a kept test file, and rejects no note, the unit itself or a missing file", () => {
	const kept = (path: string) => path === "tests/decide.test.ts" || path === "tests/x.test.ts";
	assert.deepEqual(retainedFindings("tests/x.test.ts", "a", "moved verbatim to `tests/decide.test.ts` (owned by P10)", kept), []);
	assert.match(retainedFindings("tests/x.test.ts", "a", "", kept).join("\n"), /retained with no note naming where it is kept/);
	assert.match(retainedFindings("tests/x.test.ts", "a", "kept in tests/x.test.ts", kept).join("\n"), /names no kept test file in the tree \(got none\)/);
	assert.match(retainedFindings("tests/x.test.ts", "a", "moved to tests/gone.test.ts", kept).join("\n"), /\(got tests\/gone\.test\.ts\)/);
});

test("PR ledger rows live only in slice files, once per PR, in the 3-cell shape or a legacy 5-cell row", () => {
	assert.deepEqual(ledgerFindings([], [["P1", "scope", "0"], ["P0", "scope", "1", "400 → 400", "4,488 → 4,487"]]), []);
	const findings = ledgerFindings([["P2", "scope", "0"]], [["P2", "scope", "0"], ["P3", "scope"]]).join("\n");
	assert.match(findings, /PR ledger P2: belongs in its own slice file/);
	assert.match(findings, /PR ledger P2: more than one row/);
	assert.match(findings, /PR ledger P3: 2 cells, expected/);
});

const known = new Set(["S1"]);

test("a negative-control row needs only scenario, control in words and failing assertion; no patch, sha or hash", () => {
	const lean = regressionFindings(["NC-1", "tests/x.test.ts", "S1", "drop the head guard in src/x.ts", "expected refusal"], known);
	assert.deepEqual(lean, { path: "tests/x.test.ts", findings: [] });
	const legacy = ["NC-2", "tests/y.test.ts", "not-a-sha", "S1", "NC-2", "not-a-hash", "expected refusal", ""];
	assert.deepEqual(regressionFindings(legacy, known), { path: "tests/y.test.ts", findings: [] });
	const stripped = ["NC-3", "tests/y.test.ts", "", "S1", "drop the head guard in src/y.ts", "", "expected refusal", "pass"];
	assert.deepEqual(regressionFindings(stripped, known), { path: "tests/y.test.ts", findings: [] });
});

test("a legacy row with neither a patch id nor the control in words fails", () => {
	const empty = ["NC-4", "tests/y.test.ts", "", "S1", "", "", "expected refusal", "pass"];
	assert.match(regressionFindings(empty, known).findings.join("\n"), /regression NC-4: needs the control/);
});

test("a negative-control row rejects an unknown scenario, no control, no failing assertion and a wrong cell count", () => {
	const findings = regressionFindings(["NC-1", "tests/x.test.ts", "S9", "", ""], known).findings.join("\n");
	assert.match(findings, /unknown scenario S9/);
	assert.match(findings, /needs the control/);
	assert.match(findings, /needs a failing assertion/);
	assert.match(regressionFindings(["NC-1", "tests/x.test.ts", "S1", "c"], known).findings.join("\n"), /4 cells, expected/);
});

const source = (...titles: string[]) => titles.map((title) => `test(${JSON.stringify(title)}, () => {});`).join("\n");
const titles = () => ({
	base: declarationTitles("a.test.ts", source("kept", "removed one", "removed two")),
	tree: declarationTitles("a.test.ts", source("kept")),
});
const lost = new Map([["tests/a.test.ts", { before: 3, after: 1 }]]);

test("feature-removed accepts one note per lost declaration naming the remover", () => {
	const rows = [["tests/a.test.ts", "removed one", "cp-remove-x"], ["tests/a.test.ts", "removed two", "#12"]];
	assert.deepEqual(featureRemovedFindings(rows, lost, titles), []);
});

test("feature-removed rejects an uncovered loss, a missing remover, a duplicate, an unknown or a still-declared title", () => {
	const findings = featureRemovedFindings([
		["tests/a.test.ts", "removed one", "P1"],
		["tests/a.test.ts", "removed one", "#12"],
		["tests/a.test.ts", "never existed", "#12"],
		["tests/a.test.ts", "kept", "#12"],
	], lost, titles).join("\n");
	assert.match(findings, /"removed one" must name the removing PR or job/);
	assert.match(findings, /"removed one" listed twice/);
	assert.match(findings, /"never existed" is not a baseline declaration/);
	assert.match(findings, /"kept" is still declared/);
	assert.match(featureRemovedFindings([["tests/a.test.ts", "removed one", "#12"]], lost, titles).join("\n"),
		/3 → 1 declarations with no deletion record \(1 feature-removed note\(s\)\)/);
});

const CHECKER = fileURLToPath(new URL("../scripts/test-migration-check.ts", import.meta.url));
const table = (name: string, ...lines: string[]) => [`<!-- manifest:${name} -->`, "| h | h |", "|---|---|", ...lines, `<!-- /manifest:${name} -->`].join("\n");

/** A repo whose `tests/a.test.ts` case has 1 assertion at the baseline, 3 at deletion; scenario S1's body holds 1. */
function claimFixture() {
	const dir = mkdtempSync(join(tmpdir(), "claim-count-"));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
	const write = (path: string, body: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), body); };
	git("init", "-q");
	write("tests/a.test.ts", `test("case one", () => { assert.ok(1); });\n`);
	git("add", "-A");
	git("commit", "-qm", "baseline");
	const base = git("rev-parse", "HEAD");
	write("tests/a.test.ts", `test("case one", () => { assert.ok(1); assert.equal(1, 1); t.assert.ok(2); });\n`);
	write("tests/e2e/x.test.ts", `test("x works", () => {\n\tassert.ok(1); assert.ok(2); expect(3);\n});\ntest("x small", () => { assert.ok(1); });\n`);
	git("add", "-A");
	git("commit", "-qm", "grow");
	git("rm", "-q", "tests/a.test.ts");
	git("commit", "-qm", "delete");
	const ledger = (note?: string) => {
		write("docs/testing-migration.md", [`Baseline sha: \`${base}\``, table("prs"), table("ledger"), table("feature-removed"),
			table("baseline", "| tests/a.test.ts | deleted | P1 | |")].join("\n") + "\n");
		write("docs/testing-migration/p1.md", [table("ledger", "| P1 | scope | 1 |"), table("incoming", "| tests/e2e/x.test.ts | P1 |"),
			table("scenarios", "| S1 | tests/e2e/x.test.ts | x small |"), table("regressions", "| NC-1 | tests/a.test.ts | S1 | revert | fails |"),
			table("assertions", ...(note === undefined ? [] : [`| tests/a.test.ts | case one | S1 | mapped | ${note} |`]))].join("\n") + "\n");
	};
	/** Commits the ledger with this row (none when undefined) and returns the commit, a `--claim-since` ref. */
	const commitLedger = (note?: string) => {
		ledger(note);
		git("add", "docs");
		git("commit", "-qm", "ledger");
		return git("rev-parse", "HEAD");
	};
	const empty = commitLedger();
	const check = (note: string, since = empty) => {
		ledger(note);
		const run = spawnSync(process.execPath, [CHECKER, "--claim-since", since], { cwd: dir, encoding: "utf8" });
		return { status: run.status, out: run.stdout + run.stderr };
	};
	return { check, commitLedger, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const SHORT = "reworded; covered-by: tests/e2e/x.test.ts:4";
const SHORT_FINDING = /tests\/a\.test\.ts: "case one" cites 1 e2e line\(s\) holding 1 assertion\(s\) for 3 at deletion/;

test("CLI: a new or edited row whose cited e2e bodies hold fewer assertions than the case had at deletion fails", () => {
	const fixture = claimFixture();
	try {
		const added = fixture.check(SHORT);
		assert.equal(added.status, 1, added.out);
		assert.match(added.out, new RegExp(`FAIL ${SHORT_FINDING.source}; cite the e2e lines`));
		const edited = fixture.check(SHORT, fixture.commitLedger("covered-by: tests/e2e/x.test.ts:2"));
		assert.equal(edited.status, 1, edited.out);
		assert.match(edited.out, SHORT_FINDING);
		const uncited = fixture.check("control NC-1");
		assert.equal(uncited.status, 1, uncited.out);
		assert.match(uncited.out, new RegExp(`FAIL ${SHORT_FINDING.source}`), "a new row with no covered-by is held to its scenario body");
	} finally {
		fixture.done();
	}
});

test("CLI: a short row unchanged since --claim-since only warns; an unchanged row citing no covered-by line is not counted", () => {
	const fixture = claimFixture();
	try {
		const existing = fixture.check(SHORT, fixture.commitLedger(SHORT));
		assert.equal(existing.status, 0, existing.out);
		assert.match(existing.out, new RegExp(`WARN ${SHORT_FINDING.source}`));
		assert.match(existing.out, /claim count: 1 short case\(s\), 1 unchanged since \w+ warned/);
		const legacy = fixture.check("control NC-1", fixture.commitLedger("control NC-1"));
		assert.equal(legacy.status, 0, legacy.out);
		assert.match(legacy.out, /claim count: 0 short case\(s\)/);
	} finally {
		fixture.done();
	}
});

test("CLI: one cite into a body holding several assertions, or a new short row marked Narrowed:, passes", () => {
	const fixture = claimFixture();
	try {
		for (const note of ["covered-by: tests/e2e/x.test.ts:2", "covered-by: tests/e2e/x.test.ts:4. Narrowed: the equal check has no consumer"]) {
			const run = fixture.check(note);
			assert.equal(run.status, 0, run.out);
			assert.doesNotMatch(run.out, /WARN|cites/);
			assert.match(run.out, /manifest ok/);
		}
	} finally {
		fixture.done();
	}
});

test("CLI: a narrowed row fails without a Narrowed: marker naming the uncovered part, and passes with one", () => {
	const fixture = claimFixture();
	try {
		const ledger = join(fixture.git("rev-parse", "--show-toplevel"), "docs/testing-migration/p1.md");
		const narrowed = (note: string) => {
			fixture.check(note);
			writeFileSync(ledger, readFileSync(ledger, "utf8").replace("| mapped |", "| narrowed |"));
			const run = spawnSync(process.execPath, [CHECKER, "--claim-since", "HEAD"], { cwd: join(ledger, "../../.."), encoding: "utf8" });
			return { status: run.status, out: run.stdout + run.stderr };
		};
		const bare = narrowed(SHORT);
		assert.equal(bare.status, 1, bare.out);
		assert.match(bare.out, /tests\/a\.test\.ts: "case one" is narrowed with no `Narrowed:` naming the uncovered part/);
		assert.doesNotMatch(bare.out, SHORT_FINDING, "a narrowed row is exempt from the claim count");
		const marked = narrowed(`${SHORT}. Narrowed: the equal check has no consumer`);
		assert.equal(marked.status, 0, marked.out);
		assert.match(marked.out, /manifest ok/);
	} finally {
		fixture.done();
	}
});

test("CLI: an unreachable --claim-since falls back to the merge-base with origin/main, else skips the gate loudly", () => {
	const fixture = claimFixture();
	const gone = "0".repeat(40);
	try {
		fixture.commitLedger(SHORT);
		fixture.git("update-ref", "refs/remotes/origin/main", "HEAD");
		const existing = fixture.check(SHORT, gone);
		assert.equal(existing.status, 0, existing.out);
		assert.match(existing.out, new RegExp(`WARN claim count: base ${gone} unreachable; rows as at the merge-base with origin/main`));
		assert.match(existing.out, new RegExp(`WARN ${SHORT_FINDING.source}`));
		const added = fixture.check("control NC-1", gone);
		assert.equal(added.status, 1, added.out);
		assert.match(added.out, new RegExp(`FAIL ${SHORT_FINDING.source}`));
		fixture.git("update-ref", "-d", "refs/remotes/origin/main");
		const skipped = fixture.check(SHORT, gone);
		assert.equal(skipped.status, 0, skipped.out);
		assert.match(skipped.out, /WARN claim-count gate skipped: base 0+ unreachable and no merge-base with origin\/main/);
		assert.match(skipped.out, /claim count: 1 short case\(s\), 1 unchanged since \(gate skipped\) warned/);
	} finally {
		fixture.done();
	}
});
