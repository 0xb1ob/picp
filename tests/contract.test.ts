/**
 * T27 acceptance: the operating contract fits the fresh-home test and matches
 * the code.
 *
 * A contract is prose, so it cannot be unit-tested for judgment — but the two
 * ways it actually rots *are* mechanical: it names commands that no longer
 * exist, and it keeps prose about transport that was deleted. Both are checked
 * here, so the next task that renames a tool cannot leave AGENTS.md lying.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommandPost } from "../src/command-post.ts";
import { ESCALATION_KIND_SURFACES, ESCALATION_KINDS } from "../src/contracts.ts";
import { commandPostSource, createScratchHome, REPO_ROOT } from "./harness/index.ts";

const AGENTS = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
const CONTRACTS = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
const README = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
const EXTENSION = commandPostSource();

function registered(pattern: RegExp): string[] {
	const names = new Set<string>();
	for (const match of EXTENSION.matchAll(pattern)) {
		const name = match[1];
		if (name) names.add(name);
	}
	return [...names];
}

const COMMANDS = registered(/pi\.registerCommand\("([a-z-]+)"/g);
const TOOLS = registered(/name:\s*"(cp_[a-z_]+)"/g);

test("every slash command the contract names is registered", () => {
	assert.ok(COMMANDS.length >= 7, `only found ${COMMANDS.join(",")}`);
	const named = new Set([...AGENTS.matchAll(/`\/([a-z-]+)[^`]*`/g)].map((match) => match[1] as string));
	assert.ok(named.size > 0, "the contract names no commands at all");
	for (const command of named) {
		assert.ok(COMMANDS.includes(command), `AGENTS.md names /${command}, which no extension registers`);
	}
	// The reverse direction is deliberately not asserted: /cp-version is a
	// diagnostic, not an operating instruction, and the contract stays slim.
	for (const required of ["status", "watch", "doctor", "memory", "cp-awaiting"]) {
		assert.ok(named.has(required), `AGENTS.md never mentions /${required}`);
	}
});

test("AGENTS.md stays at or under the 250-line diet cap", () => {
	const lines = AGENTS.split("\n").length;
	assert.ok(lines <= 250, `AGENTS.md is ${lines} lines, over the 250-line cap`);
});

test("every cp_ tool the contract names is registered", () => {
	const named = new Set([...AGENTS.matchAll(/`(cp_[a-z_]+)[^`]*`/g)].map((match) => match[1] as string));
	for (const tool of named) {
		assert.ok(TOOLS.includes(tool), `AGENTS.md names ${tool}, which no extension registers`);
	}
	for (const required of ["cp_dispatch", "cp_send", "cp_teardown", "cp_check", "cp_gate", "cp_pipeline", "cp_artifact"]) {
		assert.ok(named.has(required), `AGENTS.md never mentions ${required}`);
	}
});

test("deleted transport prose stays deleted", () => {
	// The rebuild's whole point: no panes, no broker, no mail, no jobs.tsv, and
	// no `bin/cmdp` shell CLI. A contract that still says otherwise teaches the
	// parent to look for machinery that is not there.
	for (const banned of ["muxa", "jobs.tsv", "bin/cmdp ", "--serve", "muxa who", "broker", "pane"]) {
		assert.ok(!AGENTS.includes(banned), `AGENTS.md still mentions "${banned}"`);
	}
	// `stalled` is retired as a phase; the contract may only say it does not exist.
	const stalled = AGENTS.split("\n").filter((line) => line.includes("stalled"));
	for (const line of stalled) {
		assert.match(line, /no `?stalled`?/, `AGENTS.md line reintroduces stalled: ${line}`);
	}
});

test("this package ships no CLI at all (T30)", () => {
	// The CLI is gone: `/watch` covers everything it did except an unbounded live
	// tail, which is `tail -f` on the run log. The naming incident it used to
	// carry is kept as a lesson in docs/build-history.md — ~/.local/bin precedes /bin, so a
	// binary called `cp` hijacks every `cp -R` on the machine — but there is now no
	// binary to name at all, which is the strongest version of that fix.
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		bin?: Record<string, string>;
	};
	assert.equal(manifest.bin, undefined, "package.json declares a bin again");
	const binDir = join(REPO_ROOT, "bin");
	if (existsSync(binDir)) {
		// cp-view is the read-only web session viewer: it reads state/ and drives nothing. cp-install
		// (cp-daemon P2) installs the always-on units and the wrapper; cp-bootstrap (P2i) fetches the
		// code and runs cp-install. cp-daemon (cp-wfo4) supervises those same units without systemd. None
		// of them touches the fleet.
		assert.deepEqual(readdirSync(binDir).sort(), ["cp-bootstrap", "cp-daemon", "cp-install", "cp-operator", "cp-view"], "bin/ may hold only the installer, the service daemon, the operator launcher and the read-only viewer, not a fleet CLI");
	}
	// Explaining that the CLI is gone is fine; *inviting* someone to run it is
	// not, so the ban is on invocations rather than on the word.
	for (const text of [AGENTS, README]) {
		assert.ok(!/`cp watch/.test(text), "a doc still invokes `cp watch`");
		for (const invocation of [/cmdp watch/, /cmdp scaffold/, /cmdp home/, /bin\/cmdp/, /\$ ?cmdp/]) {
			assert.ok(!invocation.test(text), `a doc still tells the operator to run ${invocation.source}`);
		}
	}
});

test("the contract covers each operating step, and defers policy to code", () => {
	for (const heading of [
		"## Each session",
		"## The loop",
		"## Classify",
		"## Intake",
		"## Dispatch",
		"## Envelopes",
		"## Pipeline",
		"## Teardown",
		"## Integration",
		"## Jobs",
		"## Status block",
		"## Memory",
		"## Escalation",
	]) {
		assert.ok(AGENTS.includes(heading), `AGENTS.md is missing ${heading}`);
	}
	// The fresh-home test: the contract points at the contracts doc rather than
	// restating rules that live in code.
	assert.match(AGENTS, /docs\/contracts\.md/);
	assert.match(AGENTS, /src\/contracts\.ts/);
	// Ported invariants a fresh home must still be told, in the contract's own words.
	assert.match(AGENTS, /Evidence is not authorization/);
	assert.match(AGENTS, /never read an artifact body/i);
	assert.match(AGENTS, /branch on \*\*`cause`\*\*/);
	assert.match(AGENTS, /same worker, same worktree, same model/i);
	assert.match(AGENTS, /Capture is not promotion/);
	// cp-autonomous-memory-curation: the documented contract must keep saying that
	// curation is the parent's own pass. A rewrite that quietly reinstates the
	// human approval step would leave the shipped behaviour undocumented, which is
	// exactly the half-migrated state this job existed to remove.
	assert.match(AGENTS, /Curation is your job, not the operator's/);
	assert.match(AGENTS, /you do not ask\s+permission to promote/);
	assert.match(AGENTS, /nothing you promote is permanent/i);
});

test("every operator-facing ask in AGENTS.md has an escalation kind", () => {
	assert.equal(ESCALATION_KIND_SURFACES.length, ESCALATION_KINDS.length);
	for (const kind of ESCALATION_KINDS) {
		assert.ok(
			ESCALATION_KIND_SURFACES.some((row) => row.kind === kind),
			`${kind} has no surface mapping`,
		);
		assert.ok(CONTRACTS.includes(kind), `docs/contracts.md never lists kind ${kind}`);
	}
	for (const row of ESCALATION_KIND_SURFACES) {
		assert.ok(AGENTS.includes(row.agents), `AGENTS.md never mentions ask "${row.agents}" for ${row.kind}`);
		assert.ok(CONTRACTS.includes(row.surface) || CONTRACTS.includes(row.kind), `docs/contracts.md missing surface ${row.surface}`);
	}
	assert.ok(AGENTS.includes("cp_escalate"));
	assert.doesNotMatch(AGENTS, /should I\?/, "AGENTS.md still invites prose should-I asks");
});

test("the parent is not told to close a job after teardown", () => {
	const qa = AGENTS.slice(AGENTS.indexOf("### A small question"), AGENTS.indexOf("## Dispatch"));
	assert.doesNotMatch(qa, /cp_job close/);
	const pipeline = AGENTS.slice(AGENTS.indexOf("## Pipeline"), AGENTS.indexOf("## Teardown"));
	assert.doesNotMatch(pipeline, /then close the job/i);
	assert.doesNotMatch(pipeline, /close research/);
	assert.doesNotMatch(AGENTS, /cp_teardown[^\n]*→[^\n]*cp_job close/);
});

test("the ported operating policy the rewrite dropped is back (T28 audit)", () => {
	// Each of these was in command-post's AGENTS.md, is general (it passes the
	// fresh-home test), and cannot be expressed as code because it governs how the
	// parent *decides* and *speaks*. The T27 rewrite lost them; the audit restored
	// them, and this test is what stops the next rewrite from losing them again.
	assert.match(AGENTS, /Dispatch every \*\*independent\*\* job immediately/);
	assert.match(AGENTS, /Serialize only for a real\s+dependency or shared mutable state/);
	assert.match(AGENTS, /Parallel PRs from one base/);
	assert.match(AGENTS, /Freeze scope once validation starts/);
	assert.match(AGENTS, /delivery path owns the rigor/);
	assert.match(AGENTS, /Never merge red/);
	assert.match(AGENTS, /full PR URLs/);
	assert.match(AGENTS, /Never paste a\s+worker's output/);
	assert.match(AGENTS, /two ping-pongs/);
	// delivery:pr holds until the PR lands, not until the envelope arrives.
	assert.match(AGENTS, /tear down only after the hold ends/);
});

test("the parity audit accounts for every capability, with real evidence", () => {
	const parity = readFileSync(join(REPO_ROOT, "docs/parity.md"), "utf8");
	// Every verdict used must be one the document defines.
	const verdicts = new Set([...parity.matchAll(/\|\s\*\*([a-z ]+)\*\*\s\|/g)].map((match) => match[1] as string));
	for (const verdict of verdicts) {
		assert.ok(
			["ported", "mechanised", "deleted", "out of scope", "gap"].includes(verdict),
			`docs/parity.md uses an undefined verdict: ${verdict}`,
		);
	}
	// Evidence must exist: a citation to a test that does not exist is worse than
	// no citation, because it reads as coverage.
	for (const match of parity.matchAll(/`((?:tests|src|bin|extensions|profiles|prompts|skills|docs)\/[\w./-]+)`/g)) {
		assert.ok(existsSync(join(REPO_ROOT, match[1] as string)), `docs/parity.md cites a missing path: ${match[1]}`);
	}
	// The audit's headline claim, and the sections that must stay present.
	assert.match(parity, /Zero capabilities are unaccounted for/);
	for (const section of [
		"## 1. Commands",
		"## 2. Transport (muxa)",
		"## 3. Operating contract",
		"## 4. Reports",
		"## 5. Gaps filed as jobs",
		"## 6. Deliberate improvements",
	]) {
		assert.ok(parity.includes(section), `docs/parity.md is missing ${section}`);
	}
	// Out-of-scope rows must point at the README that declared them.
	assert.match(parity, /README\.md out-of-scope/);
});

test("PLAN.md is a pointer, not a task ledger", () => {
	const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
	assert.ok(plan.split("\n").length <= 40, `PLAN.md is ${plan.split("\n").length} lines`);
	assert.doesNotMatch(plan, /br ready/, "PLAN.md still treats `br ready` as the feature ledger");
	assert.match(plan, /\.beads\//);
	assert.match(plan, /src\/contracts\.ts/);
	assert.match(plan, /docs\/contracts\.md/);
	assert.match(plan, /docs\/build-history\.md/);
});

test("CHANGELOG has a versioned section", () => {
	const log = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
	assert.match(log, /^## \[[0-9]+\.[0-9]+\.[0-9]+\]/m);
});

test("both documents link only to files that exist", () => {
	for (const [name, text] of [
		["AGENTS.md", AGENTS],
		["README.md", README],
	] as const) {
		for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
			const target = match[1] as string;
			if (/^https?:/.test(target) || target.startsWith("<")) continue;
			assert.ok(existsSync(join(REPO_ROOT, target)), `${name} links to a missing path: ${target}`);
		}
	}
});

test("the status block convention survives with all four tables", () => {
	const block = AGENTS.slice(AGENTS.indexOf("## Status block"));
	for (const table of ["In progress", "Blocked", "Awaiting you", "Shipped"]) {
		assert.ok(block.includes(`**${table}**`), `the status block is missing ${table}`);
	}
	// The ported rules that made the block useful rather than decorative,
	// preserved through cp-8aj's move to a rendered (not hand-typed) block.
	assert.match(block, /always present/);
	assert.match(block, /never a human decision/);
	assert.match(block, /cp_status_block/);
	// Opt-in: the block is rendered when asked for or useful, never as an
	// end-of-turn ritual restating the live status line.
	assert.match(block, /\*\*opt-in\*\*/);
	assert.match(block, /ordinary\s+operator-facing turns do not call it/);
	// ...and opt-in weakens no gate.
	assert.match(block, /stays open until the operator answers it/);
	assert.match(block, /new\s+since the block you last rendered this session/);
	assert.match(block, /not `\/status`/);
});

test("the two releasing events are runtime, not a parent duty — in the contract and in the runtime prompt", () => {
	// The events are stated where the parent reads about them, as facts about what
	// has already happened rather than as a turn it owes.
	const wakeups = AGENTS.slice(AGENTS.indexOf("- A **`cp-ci`** message"), AGENTS.indexOf("- **`cp-wedged` and"));
	assert.match(wakeups, /deferred merge row is\s+re-gated by this wake-up itself/);
	assert.match(wakeups, /`cp_review` verdict of `pass` → `proceed`\s+re-gates the deferred rows by itself/);
	// ...and the obsolete duties are gone from the tool's own prompt guidance,
	// which is what actually reaches a parent session's model. Prose asserting
	// prose is not evidence: this pins the runtime source.
	const guidelines = EXTENSION.slice(EXTENSION.indexOf('name: "cp_status_block"'), EXTENSION.indexOf('name: "cp_status_block"') + 4000);
	assert.doesNotMatch(guidelines, /cp-ci wake-up turn with cp_status_block/);
	assert.doesNotMatch(guidelines, /passing cp_review verdict \(pass -> proceed\) with cp_status_block/);
	assert.match(guidelines, /raises itself/);
	assert.match(guidelines, /opt-in: ordinary turns do not call it/);
	// The manual fallback for an unknown CI state that clears with no event.
	assert.match(guidelines, /invoke cp_status_block manually/);
	assert.match(AGENTS, /invoke `cp_status_block` yourself when you have reason to think\s+observability came back/);

	// The stale mandate wording must not come back: the block is neither required
	// on every turn nor printed on every turn, and "unknown CI needs nothing from
	// you" is exactly the claim the manual fallback replaced. The runtime prompt
	// source is scanned too — the guidance the model actually reads is where a
	// mandate would do its damage.
	const contracts = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	const stale: Array<[string, RegExp]> = [
		["an every-turn mandate", /((at the end of|End|end|ends) (of )?every (operator-facing )?turn|every (operator-facing )?turn ends with)/i],
		["an every-turn print claim", /printed (under the table )?every\s+turn/],
		["unknown CI needing nothing", /unknown CI state\s+(still )?needs nothing from\s+you/],
	];
	for (const [what, pattern] of stale) {
		for (const [name, text] of [["AGENTS.md", AGENTS], ["docs/contracts.md", contracts], ["extensions/command-post/index.ts", EXTENSION]] as const) {
			assert.doesNotMatch(text, pattern, `${name} still carries ${what}`);
		}
	}
	assert.doesNotMatch(AGENTS, /Every operator-facing turn ends with a \*\*STATUS BLOCK\*\*/);
	assert.doesNotMatch(contracts, /is still\s+printed every turn/);
	// The runtime rule is written down where both readers look, and it names the
	// module that enforces it.
	assert.match(contracts, /### The deferred-row recheck is runtime/);
	assert.match(contracts, /src\/deferred-recheck\.ts/);
	assert.ok(existsSync(join(REPO_ROOT, "src/deferred-recheck.ts")));
	// The unknown-CI fallback is stated as a manual render, in both documents.
	assert.match(contracts, /fallback is an \*\*explicit\*\*\s+`cp_status_block` invocation/);
});

test("the integration contract is written down where both readers look (cp-uug)", () => {
	// The rules a fresh home cannot infer from the tool's own refusals: what the
	// merge order is and why, that merge authority is per PR *and per head sha*,
	// and that no standing form of it exists. Losing any of these silently is
	// exactly how the pre-cp-vk1 "confirm the PR merged" advice ended up naming no
	// mechanism at all.
	const section = AGENTS.slice(AGENTS.indexOf("## Integration"));
	assert.ok(section.startsWith("## Integration"), "AGENTS.md has no Integration section");
	assert.match(section, /cp_integrate/);
	assert.match(section, /Branch on `next`/);
	assert.match(AGENTS, /Merge, then tear down, then delete the head/);
	assert.match(section, /per PR and per head sha/i);
	assert.match(section, /mergeStateStatus/);
	assert.match(section, /--admin.*never passed|never.*passed.*--admin|never is forced|nothing is forced/i);
	assert.match(section, /merge pending/i);
	assert.match(section, /no session-wide or blanket merge\s+authority/i);

	const contracts = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	assert.ok(contracts.includes("## Integration (`cp_integrate`, cp-uug)"), "docs/contracts.md has no Integration section");
	// The scoping sentence cp-kzc's prohibition needed: it binds *workers*, and
	// the parent's own code reading CI is not an exemption from it.
	assert.match(contracts, /The prohibition is on \*workers\*/);
	assert.match(contracts, /`src\/ci-wait\.ts` is not edited, not relaxed and not made role-aware/);
});

test("a cp-ci wake-up is the CI read, and no doc sends the parent back to gh (cp-3zbp)", () => {
	// Observed on cp-e1e6 / PR #117: after a green cp-ci on 9fbf218e1593 the parent
	// re-proved every fact it had been handed — gh run list, two gh pr views (the
	// first a 403 on statusCheckRollup), a hand-rolled merge-base, and a second
	// status block restating one open row. The cause was prose: "verify CI against
	// that head sha yourself, check ancestry", written before the watcher *was* the
	// GitHub read. Ancestry and merge permission belong to cp_integrate.
	const contracts = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	const slice = (text: string, from: string, to: string): string => {
		const start = text.indexOf(from);
		const end = text.indexOf(to, start + 1);
		assert.ok(start >= 0 && end > start, `cannot locate the section between "${from}" and "${to}"`);
		return text.slice(start, end);
	};
	const sections: ReadonlyArray<readonly [string, string]> = [
		["AGENTS.md §cp-ci", slice(AGENTS, "- A **`cp-ci`** message", "- **`cp-wedged` and `cp-unreported`")],
		["docs/contracts.md §The CI/PR watch", slice(contracts, "### The CI/PR watch", "### Reconcile")],
	];
	for (const [name, text] of sections) {
		assert.doesNotMatch(text, /verify(?:ies)? CI (?:against|yourself|itself)/i, `${name} still tells the parent to re-verify CI`);
		assert.doesNotMatch(text, /check(?:s)? ancestry/i, `${name} still asks for a hand-rolled ancestry check`);
		assert.match(text, /cp_integrate/, `${name} does not name the one follow-on step`);
		assert.match(text, /evidence, (?:not|never)\s+\*?\*?authorization/i, `${name} dropped the standing rule`);
	}
	// The same instruction lived in the ship-envelope paragraph, and in the
	// status-block section's stale-base note.
	assert.doesNotMatch(AGENTS, /You verify CI yourself/, "AGENTS.md still asks the parent to re-take the CI read");
	assert.doesNotMatch(AGENTS, /Check ancestry before you merge/, "AGENTS.md still asks for a hand-rolled ancestry check");
	// And the positive half: the bullet must say the message *is* the read.
	const [, bullet] = sections[0] as readonly [string, string];
	assert.match(bullet, /do not re-prove it/i);
	assert.match(bullet, /never merge red/i);
	// The re-query commands are named only as things not to run.
	for (const line of bullet.split("\n")) {
		if (!/gh (?:run list|pr checks|pr view)/.test(line)) continue;
		assert.match(line, /no `gh|anyway/, `AGENTS.md's cp-ci bullet invites a re-query: ${line.trim()}`);
	}
});

test("cp_review is the standing rule for every kind:ship delivery:pr job (cp-dlw7)", () => {
	// The old wording described PipelineRecord.review.enabled (an automation flag)
	// as if it were the whole policy: "opt-in per job — never automatic, never a
	// merge blocker". Read as policy, it said ordinary ship PRs need no review at
	// all, and "never a merge blocker" was quoted as a reason not to run the tool.
	// This test fails while that default still stands anywhere the parent reads.
	const contracts = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	const fanOut = AGENTS.slice(AGENTS.indexOf("## Fan out"), AGENTS.indexOf("## While they work"));
	assert.ok(fanOut.startsWith("## Fan out"), "AGENTS.md has no Fan out section");

	// The obligation, stated where the parent reads it.
	assert.match(fanOut, /every `kind:ship` `delivery:pr` job gets a `cp_review`/i);
	assert.match(fanOut, /not opt-in/i);
	// Timing: after the implementer's envelope, on a PR the implementer opened.
	assert.match(fanOut, /after its envelope/i);
	assert.match(fanOut, /a worker can never\s+hold `cp_review`|cannot call `cp_review`/i);
	// The excluded deliveries have no PR, so no review.
	assert.match(fanOut, /`delivery:local` and `delivery:answer`[^.]*no review/i);

	// One pass per branch patch, persisted against each pushed head. The pre-integrate
	// call is a catch-up only when the current head has neither a direct nor an
	// equivalent pass; identical rebases must not spend the five-review budget.
	const integration = AGENTS.slice(AGENTS.indexOf("## Integration"), AGENTS.indexOf("## Reporting to the operator"));
	for (const [name, text] of [
		["AGENTS.md §Fan out", fanOut],
		["AGENTS.md §Integration", integration],
		["docs/contracts.md", contracts.slice(contracts.indexOf("### Diff review is mandatory for a PR"), contracts.indexOf("### Review until clean"))],
	] as const) {
		assert.match(text, /(one|a) pass(ing review)? per (current )?(pushed )?head|one passing review per\s+pushed head|unit is the branch patch|one passing review per branch patch/i, `${name} does not define the review unit`);
		assert.match(text, /only (if|when)[^.]*no pass(ing)?|only when[^.]*neither form of\s+pass/i, `${name} does not make the pre-integrate review conditional on there being no pass for this head`);
		assert.match(text, /(never |not |nothing )re-?review(s|ing)? (an |that |it )?unchanged|nothing re-reviews it/i, `${name} does not forbid re-reviewing an unchanged head`);
		assert.doesNotMatch(text, /always review again before/i, `${name} reads as a second mandatory review before integrate`);
	}
	// A moved head with an identical patch inherits the pass; changed content is reviewed.
	assert.match(fanOut, /pure rebases[^.]*reviewed-by-equivalence|patch-identical equivalence/i);
	assert.match(fanOut, /changed patch[^.]*delta review/i);

	// The old default, gone from both documents' policy prose.
	assert.doesNotMatch(AGENTS, /opt-in per job/i, "AGENTS.md still calls the diff review opt-in per job");
	assert.doesNotMatch(AGENTS, /never a merge blocker/i, "AGENTS.md still offers 'never a merge blocker' as a reason to skip cp_review");
	assert.doesNotMatch(AGENTS, /Do not invent extra review gates/i, "AGENTS.md still forbids cp_review on ordinary ship PRs");
	assert.doesNotMatch(contracts, /The opt-in rule is `PipelineRecord\.review\.enabled`/, "docs/contracts.md still states the opt-in default");
	assert.doesNotMatch(contracts, /Diff review is an opt-in, post-implementation stage/, "docs/contracts.md still calls the stage itself opt-in");

	// What the change deliberately keeps.
	for (const [name, text] of [
		["AGENTS.md §Fan out", fanOut],
		["docs/contracts.md §Diff review is mandatory", contracts.slice(contracts.indexOf("### Diff review is mandatory for a PR"))],
	] as const) {
		assert.match(text, /never authorization/i, `${name} dropped: a review is not authorization`);
		assert.match(text, /CI remains authoritative/i, `${name} dropped: CI remains authoritative`);
		assert.match(text, /never merge red|nothing merges red/i, `${name} dropped: never merge red`);
	}
	assert.ok(contracts.includes("### Diff review is mandatory for a PR (cp-dlw7)"), "docs/contracts.md has no mandatory-review section");
	const mandatory = contracts.slice(contracts.indexOf("### Diff review is mandatory for a PR"), contracts.indexOf("### The second checkpoint path"));
	assert.match(mandatory, /REVIEW_MAX_ATTEMPTS` = 5|5 reviews per branch/, "the cap of 5 must survive unchanged");
	assert.match(mandatory, /WORKER_FORBIDDEN_TOOLS/, "the reason the implementer cannot review is mechanical, and must be named");
	// The duty is hard-gated: an unreviewed head cannot merge.
	assert.match(mandatory, /is hard-gated in `cp_integrate`/i);
	assert.doesNotMatch(AGENTS, /does not check it for you/);
	assert.doesNotMatch(AGENTS, /unreviewed PR merges if you let it/);

	// And the tool's own surface says it, since that is what the parent sees at
	// call time even when the contract is not in context.
	assert.match(EXTENSION, /Run cp_review on every kind:ship delivery:pr job/);
	assert.match(EXTENSION, /One pass per pushed head/);

	// The Integration section points at the review, without claiming it permits a merge.
	assert.match(integration, /cp_review/, "AGENTS.md §Integration never mentions the review that precedes it");
	assert.match(integration, /evidence, never permission|never authorization/i);
	assert.match(integration, /next: review|`review`/);
	assert.match(integration, /never re-review an unchanged|do not re-review an unchanged/i);
});

test("ship PRs open as drafts and are marked ready only for a reviewed head (jje.5)", () => {
	const ship = readFileSync(join(REPO_ROOT, "prompts/briefs/brief-ship.md"), "utf8");
	assert.match(ship, /open exactly one\s+PR from this branch, `--draft`, if none exists \(reuse it as is;/);
	assert.doesNotMatch(ship, /gh pr ready/, "the worker never marks its own PR ready");
	const integration = AGENTS.slice(AGENTS.indexOf("## Integration"), AGENTS.indexOf("## Reporting to the operator"));
	assert.match(integration, /open as \*\*drafts\*\*: an unreviewed draft is a hold \(`next: review`\), never merge pending/);
	assert.match(integration, /`gh pr ready` once, re-reads the head and continues/);
	assert.match(integration, /refused ready surfaces once and stops/);
	assert.match(CONTRACTS, /\*\*A draft is a hold until review, not a refusal \(jje\.5\)\.\*\*/);
	assert.match(CONTRACTS, /a stale pass never readies a new head/);
	assert.match(CONTRACTS, /No GitHub auto-merge is armed/);
});

test("the README states the requirements a fresh machine needs", () => {
	for (const required of ["`pi`", "`git`", "`treehouse`", "`gh`"]) {
		assert.ok(README.includes(required), `README does not require ${required}`);
	}
	assert.match(README, /npm test/);
	assert.match(README, /e2e:phase3/);
	assert.match(README, /CP_LIVE_TESTS=1/);
	// Out-of-scope items are declared, so nobody hunts for them.
	assert.match(README, /--serve/);
	assert.match(README, /Slack/);
});

test("cp_check is exposed, and refuses an unregistered project fail-closed", async (t) => {
	// T27's parity review caught this gap: T12 built the policy and dispatch
	// called it, but no surface let the parent ask "may this be dispatched here?"
	// before taking a lease. There is no RPC command that lists tools, so the
	// wiring is asserted where it is observable: the source registration above,
	// and the composition root's `preflight` the tool delegates to.
	assert.ok(TOOLS.includes("cp_check"), `cp_check is not registered; got: ${TOOLS.join(",")}`);
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const post = new CommandPost({ home: home.path, packageRoot: REPO_ROOT });
	const result = await post.preflight.check({ project: "never-registered", jobId: "cp-x", fetch: false });
	assert.equal(result.status, "fail", "an unknown project must not be dispatchable");
	assert.ok(result.findings.length > 0);
	for (const finding of result.findings) {
		if (finding.level === "fail") assert.ok(finding.fix, `finding ${finding.code} has no fix`);
	}
});

test("the composition root reads CP_TREEHOUSE_ROOT, and omits it when unset", (t) => {
	// cp-epy2 §4.2: `src/command-post.ts` is the only `new LeaseManager(...)`
	// call site, so this is where "unset means today's behaviour" is decided for
	// the whole home. The argv-level proof lives in tests/leases.test.ts; this
	// pins the wiring that feeds it.
	const home = createScratchHome();
	t.after(() => home.cleanup());

	const unset = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: {} });
	assert.equal(unset.leases.poolRoot, undefined, "no pool root configured means no --root at all");

	const set = new CommandPost({
		home: home.path,
		packageRoot: REPO_ROOT,
		parentEnv: { CP_TREEHOUSE_ROOT: "/pools/slack-home" },
	});
	assert.equal(set.leases.poolRoot, "/pools/slack-home");

	// An exported-but-empty value configures nothing (same as unset).
	const empty = new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { CP_TREEHOUSE_ROOT: "  " } });
	assert.equal(empty.leases.poolRoot, undefined);

	// A relative root is refused rather than silently made per-clone.
	assert.throws(
		() => new CommandPost({ home: home.path, packageRoot: REPO_ROOT, parentEnv: { CP_TREEHOUSE_ROOT: "pool" } }),
		/CP_TREEHOUSE_ROOT must be an absolute path/,
	);

	// And the drain projection is reachable from the root the extension uses.
	assert.deepEqual(unset.quiesce(), { active: 0, busy: [] });
});
