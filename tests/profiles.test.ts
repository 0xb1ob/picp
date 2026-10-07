/**
 * T6 acceptance: profile frontmatter is validated on load, and brief assembly
 * is pure and fail-closed.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
	BRIEF_PLACEHOLDERS,
	DecisionSummarySchema,
	DIFF_REVIEW_MAX_BYTES,
	DIFF_REVIEW_MAX_STAT_FILES,
	ROLES,
	SUMMARY_MAX_CHARS,
	SUMMARY_MAX_LINES,
	terminatingToolForRole,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import {
	assembleBrief,
	listProfiles,
	loadProfile,
	parseFrontmatter,
	parseProfile,
	ProfileError,
	profileForRole,
	readBriefTemplate,
	renderTemplate,
	templatePlaceholders,
} from "../src/profiles.ts";
import { NONINTERACTIVE_WORKER_ENV, resolveWorkerTools, workerEnvironment } from "../src/worker-manager.ts";
import { PACKAGE_TOOLS, ROLE_PACKAGES } from "../src/worker-packages.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

// ---------------------------------------------------------------------------
// shipped profiles
// ---------------------------------------------------------------------------

test("the shipped profiles load and every role resolves to exactly one default", () => {
	const profiles = listProfiles(PROFILES_DIR);
	// cp-u3o4: `qa` is the fourth profile and the third *role* is still planner —
	// ROLES is fixed at three by contract, so the Q&A worker reuses `planner`
	// (which is also what keeps "planner profiles are read-only" true for it) and
	// is asked for by name.
	assert.deepEqual(
		profiles.map((profile) => profile.frontmatter.name).sort(),
		["gate-reviewer", "implementer", "planner", "qa"],
	);
	for (const role of ROLES) {
		const profile = profileForRole(PROFILES_DIR, role);
		assert.equal(profile.frontmatter.role, role);
		// The tiebreak, asserted where it matters: the default for a role is the
		// profile named after it, so adding qa.md cannot silently re-route research.
		assert.equal(profile.frontmatter.name, role);
		assert.ok(profile.systemPrompt.length > 100, `${role} needs a real system prompt body`);
		assert.ok(
			profile.frontmatter.tools.includes(terminatingToolForRole(role)),
			`${role} must hold its terminating tool ${terminatingToolForRole(role)}`,
		);
		for (const other of ["report_result", "report_verdict"].filter((tool) => tool !== terminatingToolForRole(role))) {
			assert.ok(!profile.frontmatter.tools.includes(other), `${role} must not hold ${other}`);
		}
		for (const forbidden of WORKER_FORBIDDEN_TOOLS) {
			assert.ok(!profile.frontmatter.tools.includes(forbidden));
		}
		// Every profile's brief template exists and only uses known placeholders.
		const template = readBriefTemplate(BRIEFS_DIR, profile.frontmatter.briefTemplate);
		for (const placeholder of templatePlaceholders(template)) {
			assert.ok(
				(BRIEF_PLACEHOLDERS as readonly string[]).includes(placeholder),
				`${profile.frontmatter.briefTemplate} uses unknown \${${placeholder}}`,
			);
		}
	}
});

test("profile tools are built-ins, worker tools, or supplied by an activated package", () => {
	for (const { frontmatter: profile } of listProfiles(PROFILES_DIR)) {
		const allowed = new Set([
			"read", "bash", "edit", "write", "grep", "find", "ls",
			"report_result", "report_verdict", "ask_operator",
			...(profile.packages ?? ROLE_PACKAGES[profile.role]).flatMap((name) => PACKAGE_TOOLS[name] ?? []),
		]);
		assert.equal(allowed.has("glob"), false, "glob is not a pi tool");
		for (const tool of profile.tools) assert.ok(allowed.has(tool), `${profile.name}: unknown tool ${tool}`);
	}
});

test("read-only roles get no write tools", () => {
	for (const name of ["planner", "gate-reviewer"]) {
		const profile = loadProfile(PROFILES_DIR, name);
		assert.equal(profile.frontmatter.readOnly, true);
		for (const tool of ["write", "edit", "apply_patch"]) {
			assert.ok(!profile.frontmatter.tools.includes(tool), `${name} must not hold ${tool}`);
		}
	}
	const implementer = loadProfile(PROFILES_DIR, "implementer");
	assert.equal(implementer.frontmatter.readOnly, false);
	assert.ok(implementer.frontmatter.tools.includes("write"));
	assert.ok(implementer.frontmatter.tools.includes("replace"));
	assert.equal(implementer.frontmatter.tools.includes("edit"), false);
});

test("the gate reviewer holds read-only discovery and its verdict tool", () => {
	const reviewer = loadProfile(PROFILES_DIR, "gate-reviewer");
	assert.deepEqual(reviewer.frontmatter.tools, ["read", "grep", "find", "ls", "report_verdict"]);
	assert.deepEqual(resolveWorkerTools(reviewer), reviewer.frontmatter.tools);
	assert.equal(reviewer.frontmatter.readOnly, true);
	assert.match(reviewer.systemPrompt, /grepping tells you where, `read` tells you what/);
	assert.match(reviewer.systemPrompt, /Do not open the repository/);
});

test("profiles declare a model, an effort level and a budget", () => {
	// The ordered candidate list is `fallbacks` (pi-command-post-0a9); the
	// pre-cp-eff `fallbackModels` ladder is not coming back under its old name.
	for (const profile of listProfiles(PROFILES_DIR)) {
		const front = profile.frontmatter;
		assert.match(front.model, /\//, `${front.name} model must be provider/model-id`);
		assert.ok((front.budget?.tokens ?? 0) > 0, `${front.name} needs a token budget`);
		assert.ok(front.thinking !== undefined, `${front.name} needs a thinking level`);
		assert.ok(!("fallbackModels" in front), `${front.name} still declares fallbackModels`);
	}
});

test("a profile's fallbacks parse as an ordered list, and every shipped profile ships one", () => {
	// The installation contract: Anthropic or OpenAI is enough, so every shipped
	// profile names an OpenAI candidate after its Anthropic preference.
	for (const profile of listProfiles(PROFILES_DIR)) {
		const { name, model, fallbacks } = profile.frontmatter;
		assert.ok(Array.isArray(fallbacks) && fallbacks.length > 0, `${name} needs a fallback candidate`);
		const providers = [model, ...(fallbacks ?? [])].map((ref) => ref.split("/")[0]);
		assert.deepEqual(providers, ["anthropic", "openai"], `${name}: anthropic first, then openai`);
	}

	// The inline-array frontmatter parser needs no help with it.
	const parsed = parseProfile(
		[
			"---",
			"name: fixture",
			"role: implementer",
			"tools: [read]",
			"model: mock/preferred",
			"fallbacks: [mock/second, mock/third]",
			"briefTemplate: brief-ship",
			"---",
			"body",
		].join("\n"),
		join(PROFILES_DIR, "fixture.md"),
	);
	assert.deepEqual(parsed.frontmatter.fallbacks, ["mock/second", "mock/third"]);
});

// ---------------------------------------------------------------------------
// parsing and validation
// ---------------------------------------------------------------------------

const VALID = `---
name: probe
role: implementer
tools: [read, report_result]
model: mock/script-a
thinking: low
briefTemplate: brief-ship
readOnly: false
budget: { tokens: 1000 }
---

Body that becomes the system prompt.
`;

test("frontmatter parsing handles scalars, arrays and inline maps", () => {
	const { frontmatter, body } = parseFrontmatter(VALID, "probe.md");
	assert.deepEqual(frontmatter.tools, ["read", "report_result"]);
	assert.deepEqual(frontmatter.budget, { tokens: 1000 });
	assert.equal(frontmatter.readOnly, false);
	assert.equal(body, "Body that becomes the system prompt.");
	assert.throws(() => parseFrontmatter("no frontmatter here", "x.md"), /missing --- frontmatter/);
	assert.throws(() => parseFrontmatter("---\nbroken line\n---\nbody\n", "x.md"), /cannot parse frontmatter line/);
});

test("invalid profiles never load", () => {
	const home = createScratchHome();
	let counter = 0;
	/** Each case gets its own directory: a broken profile is fatal for the dir. */
	const dirWith = (files: Record<string, string>): string => {
		counter += 1;
		const dir = join(home.path, `profiles-${counter}`);
		mkdirSync(dir, { recursive: true });
		for (const [name, text] of Object.entries(files)) {
			writeFileSync(join(dir, `${name}.md`), text);
		}
		return dir;
	};
	try {
		assert.equal(loadProfile(dirWith({ probe: VALID }), "probe").frontmatter.name, "probe");

		// name must match the file name
		assert.throws(() => loadProfile(dirWith({ mismatch: VALID }), "mismatch"), /must match the file name/);

		// recursion guard from the contract
		const greedy = VALID.replace("tools: [read, report_result]", "tools: [read, cp_dispatch]").replace(
			"name: probe",
			"name: greedy",
		);
		assert.throws(() => loadProfile(dirWith({ greedy }), "greedy"), /parent-only/);

		// unknown role
		const wrongRole = VALID.replace("role: implementer", "role: reviewer").replace("name: probe", "name: wrong-role");
		assert.throws(() => loadProfile(dirWith({ "wrong-role": wrongRole }), "wrong-role"), ProfileError);

		// empty body
		const bodyless = "---\nname: bodyless\nrole: implementer\ntools: [read]\nmodel: m/x\nbriefTemplate: brief-ship\n---\n";
		assert.throws(() => loadProfile(dirWith({ bodyless }), "bodyless"), /body is empty/);

		// unknown profile name lists what exists, even when a sibling is broken
		assert.throws(() => loadProfile(dirWith({ probe: VALID, bodyless }), "nope"), /unknown profile "nope"/);

		// a duplicate role is ambiguous, never "first wins"
		const probe2 = VALID.replace("name: probe", "name: probe2");
		assert.throws(() => profileForRole(dirWith({ probe: VALID, probe2 }), "implementer"), /ambiguous role/);

		// a broken profile is fatal for role resolution: never silently skipped
		assert.throws(() => profileForRole(dirWith({ probe: VALID, bodyless }), "implementer"), /body is empty/);
	} finally {
		home.cleanup();
	}
});

test("cp-u3o4: two profiles for one role resolve to the one named after the role", () => {
	const home = createScratchHome();
	const dir = join(home.path, "profiles");
	mkdirSync(dir, { recursive: true });
	try {
		const planner = `---
name: planner
role: planner
tools: [read, report_result]
model: mock/script-a
thinking: high
briefTemplate: brief-research
readOnly: true
budget: { tokens: 1000 }
---

The planner's system prompt.
`;
		const qa = planner.replace("name: planner", "name: qa").replace("briefTemplate: brief-research", "briefTemplate: brief-qa");
		writeFileSync(join(dir, "planner.md"), planner);
		writeFileSync(join(dir, "qa.md"), qa);

		// The regression this exists for: adding qa.md must not re-route (or break)
		// every default research dispatch.
		const resolved = profileForRole(dir, "planner");
		assert.equal(resolved.frontmatter.name, "planner");
		// And qa is reachable, by name, which is how dispatch asks for it.
		assert.equal(loadProfile(dir, "qa").frontmatter.briefTemplate, "brief-qa");

		// Ambiguity the tiebreak does not resolve is still a refusal, not a default.
		const other = qa.replace("name: qa", "name: qa2");
		writeFileSync(join(dir, "qa2.md"), other);
		rmSync(join(dir, "planner.md"));
		assert.throws(() => profileForRole(dir, "planner"), /ambiguous role "planner"/);
	} finally {
		home.cleanup();
	}
});

test("parseProfile rejects a frontmatter that is not an object of known keys", () => {
	assert.throws(
		() => parseProfile(VALID.replace("thinking: low", "temperature: 0.7"), "probe.md"),
		/invalid profile frontmatter/,
	);
});

// ---------------------------------------------------------------------------
// brief assembly (pure)
// ---------------------------------------------------------------------------

test("brief assembly substitutes every placeholder and fails closed", () => {
	const profile = loadProfile(PROFILES_DIR, "planner");
	const template = readBriefTemplate(BRIEFS_DIR, profile.frontmatter.briefTemplate);
	const values = {
		job_id: "cp-res1",
		branch: "cp-res1",
		worktree: "/wt/cp-res1",
		project: "demo",
		kind: "research",
		delivery: "pipeline",
		artifact_path: "/home/op/state/artifacts/cp-res1/report.md",
		task: "Find every caller of the retry ladder.",
	};

	const brief = assembleBrief({ profile, template, values });
	assert.ok(!brief.includes("${"), "no placeholder may survive assembly");
	for (const value of Object.values(values)) {
		assert.ok(brief.includes(value), `brief must contain ${value}`);
	}
	assert.ok(brief.endsWith("\n"));

	// Purity: same inputs, same output; nothing written anywhere.
	assert.equal(assembleBrief({ profile, template, values }), brief);

	// Missing value -> error, never an empty hole.
	assert.throws(
		() => assembleBrief({ profile, template, values: { ...values, artifact_path: undefined } }),
		/missing value\(s\) for \$\{artifact_path\}/,
	);
	assert.throws(
		() => assembleBrief({ profile, template, values: { ...values, task: "" } }),
		/missing value\(s\)/,
	);

	// Unknown placeholder in a template -> error (typo protection).
	assert.throws(() => renderTemplate("hello ${nope}", values, "t.md"), /unknown placeholder\(s\) \$\{nope\}/);
});

// pi-command-post-envelope-bounds-in-brief-1bz: the schema's bounds were only
// in the schema, so a worker copying the brief's example learned them from a
// rejection instead — 11 report_result rejections in two days, each one an
// extra turn at the end of a session. Every surface that shows the envelope
// must state the bounds it is validated against.
test("every brief that shows report_result states the envelope's bounds", () => {
	for (const name of ["brief-ship", "brief-research", "brief-qa"] as const) {
		const brief = readBriefTemplate(BRIEFS_DIR, name);
		assert.ok(
			brief.includes(`at most ${SUMMARY_MAX_LINES} lines and at most ${SUMMARY_MAX_CHARS} characters`),
			`${name} must state the summary bound the schema enforces`,
		);
		assert.match(brief, /blockers/, `${name} must name blockers`);
		assert.match(brief, /required and non-empty/, `${name} must say blockers are required when blocked`);
	}
	// The ship brief is the only one carrying shas, and an abbreviated one is a
	// rejection: the schema requires exactly 40 characters.
	assert.match(readBriefTemplate(BRIEFS_DIR, "brief-ship"), /full 40-char sha/);
	// ...and the research brief is the only one carrying self_assessment, whose
	// key set is closed.
	assert.match(readBriefTemplate(BRIEFS_DIR, "brief-research"), /exactly these keys, no others/);
});

// pi-command-post-sumbound-yhd: the same bound, on the surface a worker reads
// before it ever sees a rejection. In window C a worker overran the
// 600-character cap 5 times in 4 of 13 runs (cp-9as8, cp-glwc ×2, cp-nbib,
// cp-pty4) — each overrun a rejected call and an extra turn at the end of a
// job. The profiles are static markdown, so this test, not the prose, is what
// keeps them equal to the schema.
test("every profile that names report_result states the summary bound", () => {
	const named = listProfiles(PROFILES_DIR).filter((profile) => profile.systemPrompt.includes("report_result"));
	assert.deepEqual(
		named.map((profile) => profile.frontmatter.name).sort(),
		["implementer", "planner", "qa"],
		"the profiles that finish with report_result; gate-reviewer has report_verdict",
	);
	// Both numbers, from the constants — and whitespace-tolerant, because markdown
	// wraps mid-phrase.
	const bound = new RegExp(
		`at\\s+most\\s+${SUMMARY_MAX_LINES}\\s+lines\\s+and\\s+at\\s+most\\s+${SUMMARY_MAX_CHARS}\\s+characters`
	);
	for (const profile of named) {
		const name = profile.frontmatter.name;
		assert.match(profile.systemPrompt, bound, `${name} names report_result but never states the summary bound the schema enforces`);
		assert.match(profile.systemPrompt, /longer\s+summary\s+is\s+refused/i, `${name} must say an over-long summary is refused`);
	}

	// The implementer is the one profile whose summary carries a url, so it is the
	// one that has to say the headline and the PR url are all that ride in it, and
	// that the details live in the artifact.
	const implementer = profileForRole(PROFILES_DIR, "implementer").systemPrompt;
	assert.match(implementer, /full\s+PR\s+url\s+only/, "implementer must name the PR url as the only payload in the summary");
	assert.match(implementer, /every detail goes in the artifact/, "implementer must send the details to the artifact");
});

test("shipped briefs carry the policy the contract requires", () => {
	const research = readBriefTemplate(BRIEFS_DIR, "brief-research");
	const ship = readBriefTemplate(BRIEFS_DIR, "brief-ship");
	const gate = readBriefTemplate(BRIEFS_DIR, "gate-rubric");

	for (const [name, text] of [
		["brief-research", research],
		["brief-ship", ship],
		["gate-rubric", gate],
	] as const) {
		assert.match(text, /report_(result|verdict)/, `${name} must tell the worker how to finish`);
		assert.match(text, /\$\{job_id\}/, `${name} must bind the job id`);
		// Transport mechanics from command-post/muxa must NOT be ported.
		for (const banned of ["muxa", "tmux", "pane", "receipt token", "treehouse return --force"]) {
			assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `${name} still mentions ${banned}`);
		}
	}

	assert.match(research, /never goes into the envelope/i);
	assert.match(research, /git status --porcelain/);
	// cp-kzc: the ship brief ends the job at the pushed head sha. It must say so,
	// and must not reintroduce any instruction to wait for CI.
	assert.match(ship, /Do not wait for CI\. Report the pushed head sha and stop\./);
	assert.match(ship, /head_sha/);
	assert.match(ship, /second PR/);
	// The base is resolved per repository (preflight), so the template may never
	// hardcode it: a non-main repo would be told to rebase onto a branch that
	// does not exist, and to read `base_sha` from it.
	assert.ok(!ship.includes("origin/main"), "brief-ship must not hardcode origin/main");
	assert.match(ship, /git rebase origin\/\$\{base\}/);
	assert.match(ship, /git rev-parse origin\/\$\{base\}/);
	// ...and an unresolved base is a refusal, not an empty hole in a live brief.
	assert.throws(
		() => renderTemplate(ship, { job_id: "cp-x", branch: "cp-x", worktree: "/wt", project: "demo", kind: "ship", delivery: "pr", task: "t" }, "brief-ship"),
		/missing value\(s\) for \$\{base\}/,
	);
	assert.match(gate, /destructive_scope/);
	assert.match(gate, /report_verdict/);
	assert.ok(!gate.includes("report_result"), "the reviewer has no envelope tool");
});

test("the focused script selects only the requested file with the suite's safety flags", () => {
	const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
	const focused = scripts["test:one"];
	assert.ok(focused, "test:one script must exist");
	for (const flag of ["--import ./tests/harness/hermetic-env.ts", "--test-concurrency=3", "--test-timeout=300000", "--test-force-exit"]) {
		assert.ok(focused.includes(flag), `focused run must retain ${flag}`);
	}
	assert.doesNotMatch(focused, /tests\/\*\*\/\*\.test\.ts/, "focused run must not include the all-files glob");
	const { NODE_TEST_CONTEXT: _drop, ...env } = process.env;
	const output = execFileSync("npm", ["run", "test:one", "--", "tests/answer-card.test.ts"], { cwd: REPO_ROOT, encoding: "utf8", env });
	assert.match(output, /tests 8\b/);
	assert.match(output, /pass 8\b/);
});

// ---------------------------------------------------------------------------
// implementer method and ship-brief compaction (do8.2)
// ---------------------------------------------------------------------------

test("the implementer profile states the implementation method, not just the publishing protocol", () => {
	const prompt = profileForRole(PROFILES_DIR, "implementer").systemPrompt;
	const required: [RegExp, string][] = [
		[/task file it names in\s+full \(never an excerpt\)/i, "read the task file completely"],
		[/repository's own instructions/i, "read the repository instructions"],
		[/every caller/i, "inspect callers before editing"],
		[/tests that cover it/i, "inspect the covering tests"],
		[/local patterns/i, "reuse local patterns"],
		[/plan is intent, not fact/i, "a plan is verified against the tree"],
		[/reproduce it first/i, "reproduce a bug before fixing it"],
		[/root cause/i, "fix at the root cause"],
		[/regression coverage/i, "add regression coverage when behaviour changes"],
		[/smallest coherent change/i, "smallest coherent in-scope change"],
		[/no unrelated\s+cleanup/i, "no unrelated cleanup"],
		[/focused checks/i, "run focused checks while working"],
		[/one file until it is green/i, "one test file while working, not the suite"],
		[/never a full local\s+`?npm test`?/i, "never a full local npm test; CI runs it once"],
		[/final diff/i, "inspect the final diff"],
		[/map it to every\s+requirement/i, "map the diff to every requirement"],
		[/re-run the same focused checks/i, "re-run focused checks before reporting, never a full local suite"],
		[/Review feedback is a claim to verify/i, "verify review feedback before acting on it"],
	];
	for (const [pattern, why] of required) {
		assert.match(prompt, pattern, `implementer profile must require: ${why}`);
	}
});

test("brief-ship is one compact delivery checklist that keeps every safeguard", () => {
	const ship = readBriefTemplate(BRIEFS_DIR, "brief-ship");

	// The environment claim that went stale: the runtime exports the
	// noninteractive editor/pager vars, so a brief that says none is set teaches
	// a worker something false.
	assert.doesNotMatch(ship, /no\s+`?GIT_EDITOR`?\s+set/i, "brief-ship still claims GIT_EDITOR is unset");

	// ...and the replacement claim is bound to the runtime that has to make it
	// true, not to prose: every variable the brief tells a worker to rely on is
	// a variable NONINTERACTIVE_WORKER_ENV actually exports, with that value.
	// If the env constant drops one, this fails instead of the brief quietly
	// promising something no worker gets.
	for (const [name, value] of Object.entries(NONINTERACTIVE_WORKER_ENV)) {
		if (!ship.includes(name)) continue;
		assert.match(
			ship,
			new RegExp(`${name}[^\\n]*${value}|${value}[^\\n]*${name}`),
			`brief-ship names ${name} but not its runtime value ${value}`,
		);
	}
	for (const name of ["GIT_EDITOR", "EDITOR", "VISUAL", "PAGER"]) {
		assert.ok(name in NONINTERACTIVE_WORKER_ENV, `${name} must be exported by the runtime`);
		assert.match(ship, new RegExp(name), `brief-ship must say the runtime sets ${name}`);
	}
	// The proof chain ends at the process the worker actually runs in: the
	// constant is what workerEnv() applies, so a brief claim about the shell is
	// an assertion about that function's output.
	const env = workerEnvironment(
		{ jobId: "cp-x", kind: "ship", delivery: "pr", runDir: "/run", worktree: "/wt" },
		{ home: "/home", parentEnv: { GIT_EDITOR: "vi", PAGER: "less" } },
	);
	for (const [name, value] of Object.entries(NONINTERACTIVE_WORKER_ENV)) {
		assert.equal(env[name], value, `workerEnvironment() must export ${name}=${value}`);
	}

	const order = ["git commit -F <file>", "git rebase origin/${base}", "npm run typecheck", "npm run test:one -- tests/<x>.test.ts", "git push --force-with-lease"];
	let cursor = -1;
	for (const step of order) {
		const at = ship.indexOf(step, cursor + 1);
		assert.ok(at > cursor, `brief-ship must sequence ${step} after ${order[order.indexOf(step) - 1] ?? "the start"}`);
		cursor = at;
	}
	assert.doesNotMatch(ship, /Run the full suite on the rebased tree|Run CI's `npm test`|full suite after rebase/i, "brief-ship must leave the full suite to CI");
	assert.match(ship, /never run full `npm test` locally/i);
	assert.match(ship, /Nomad CI runs the full suite on the pushed head/i);
	assert.match(ship, /prior synthesis/);
	assert.match(ship, /compact threshold/);
	assert.match(ship, /Inspect the diff, then commit/i, "the diff is read before the commit");

	const required: [RegExp, string][] = [
		[/read that file in full/i, "a task file is read in full"],
		[/never run full `npm test` locally/i, "full suite is CI-only"],
		[/Nomad CI runs the full suite on the pushed head/i, "Nomad CI is the full-suite gate"],
		[/\$\{worktree\}/, "the worktree boundary"],
		[/second PR/, "one PR per job"],
		[/git fetch origin/, "fetch before rebase"],
		[/git rebase origin\/\$\{base\}/, "rebase onto the resolved base"],
		[/--force-with-lease/, "force-with-lease push"],
		[/`delivery: local`/, "local delivery is named"],
		[/\*\*no PR\*\*; the push is the delivery/i, "local delivery opens no PR"],
		[/git status --porcelain` must be empty/, "a clean tree before reporting"],
		[/never a detached HEAD/, "commits on the job branch"],
		[/head_sha: "<git rev-parse HEAD>"/, "the pushed head sha in the envelope"],
		[/exactly once/i, "report_result exactly once"],
		[/never weaken a test or delete code/i, "conflicts never resolved by deleting work"],
		[/never manufacture a green claim/i, "no CI guessing"],
		[/never a diff, a transcript or findings/i, "no findings body in the summary"],
		// Cadence: focused checks during editing; CI owns the full suite.
		[/npm run test:one -- tests\/\<x\>\.test\.ts/, "focused test file while working"],
		// Reviewable-diff boundaries: the worker learns the review caps before it
		// pushes a PR no reviewer may score, and stages it instead of trimming it.
		[new RegExp(`${DIFF_REVIEW_MAX_STAT_FILES} files`), "the diff-review file cap, from the constant"],
		[new RegExp(DIFF_REVIEW_MAX_BYTES.toLocaleString("en-US")), "the diff-review byte cap, from the constant"],
		[/keep\s+every requested output/i, "no requested output is dropped to fit"],
		[/code\/test PR then\s+ordered data\s+batches/, "code and generated data are staged separately"],
		[/Do not open a PR or split the job yourself/, "the parent owns the split"],
		[/run steps 1–5 as\s+written, skip step 6, then steps 8–9/, "review scope follows the checklist, never replaces it"],
		[/unless Review scope applies, open exactly one\s+PR/, "step 6 names its one exception"],
		[/each stage is still reviewed/, "staging never skips review"],
		[/never `~\/\.pi`[^]*copy only `models\.json`[^]*`0700`[^]*`trap/i, "agent isolation: models.json only, 0700 temp dir outside the worktree, trap cleanup"],
		[/audit `git log -p[^`]*`[^]*never printing a matched line/i, "branch patch history is audited for credentials without printing them"],
	];
	for (const [pattern, why] of required) {
		assert.match(ship, pattern, `brief-ship must keep: ${why}`);
	}

	// The brief is bounded so further edits must stay concise.
	assert.doesNotMatch(ship, /bypass|without (a )?review|raise the cap/i, "the review scope paragraph grants no bypass");
	assert.ok(ship.length < 8700, `brief-ship is ${ship.length} chars; compact it or raise the ceiling on purpose`); // picp-k2o: one line — do not reread a prior synthesis
	assert.equal(ship.match(/job_id: "\$\{job_id\}"/g)?.length, 1, "exactly one report_result example");
	assert.equal(ship.match(/^## /gm)?.length, 1, "exactly one checklist section");
});

// ---------------------------------------------------------------------------
// reviewer verdict semantics live in the fixtures (do8.1)
// ---------------------------------------------------------------------------

test("no reviewer fixture tells a reviewer to escalate because a flag is true", () => {
	const fixtures = [
		["gate-rubric", readBriefTemplate(BRIEFS_DIR, "gate-rubric")],
		["diff-review-rubric", readBriefTemplate(BRIEFS_DIR, "diff-review-rubric")],
		["gate-reviewer profile", profileForRole(PROFILES_DIR, "gate-reviewer").systemPrompt],
	] as const;

	// The bug this guards (do8.1): a compliant reviewer that escalates on a flag
	// can never produce reviewer-pass + flag, which is the ONLY input that gate
	// policy classifies as cause=flagged — the authorizable path. So the
	// fixtures must never couple a flag to a verdict.
	const banned = [
		/escalate\s+whenever\s+any\s+flag/i,
		/escalate\s+(?:when|if)\s+any\s+flag/i,
		/`?escalate`?\s+—\s+any\s+flag\s+is\s+true/i,
		/any\s+flag\s+is\s+true[^.]*\b(?:escalate|verdict)\b/i,
	];
	for (const [name, text] of fixtures) {
		for (const pattern of banned) {
			assert.ok(!pattern.test(text), `${name} still instructs escalate-because-flag (${pattern})`);
		}
		// ...and says the independence out loud, so a reviewer reading only the
		// fixture scores quality on its own.
		assert.match(text, /never a reason to change|independently of the flags/i, `${name} must state flag independence`);
		assert.match(text, /parent/i, `${name} must leave flag policy to the parent`);
	}
});

test("reviewer fixtures define pass/revise/escalate by quality, and demand actionable findings", () => {
	const gate = readBriefTemplate(BRIEFS_DIR, "gate-rubric");
	const diff = readBriefTemplate(BRIEFS_DIR, "diff-review-rubric");
	const profile = profileForRole(PROFILES_DIR, "gate-reviewer").systemPrompt;

	// A missing required section is a fixable gap: revise, never escalate.
	for (const [name, text] of [["gate-rubric", gate], ["gate-reviewer profile", profile]] as const) {
		assert.match(text, /missing required section is normally\s+`?revise`?/i, `${name} must make a missing section revise`);
	}

	// escalate is reserved for the unscorable, not for a fixable gap.
	for (const [name, text] of [["gate-rubric", gate], ["diff-review-rubric", diff], ["gate-reviewer profile", profile]] as const) {
		assert.match(text, /unscorable|cannot be scored/i, `${name} must reserve escalate for the unscorable`);
		assert.match(text, /no praise, no style nits, no speculation/i, `${name} must forbid non-actionable output`);
	}

	assert.match(gate, /naming the criterion and the evidence/i, "gate reasons must cite criterion and evidence");
	assert.match(gate, /verified: "one line, at most 40 words/);
	assert.match(gate, /DecisionSummarySchema/);
	assert.match(profile, /verified.*at most 40 words/);
	assert.match(diff, /verified` fields are one line, at most 40 words/);
	assert.match((DecisionSummarySchema.properties.verified as { description?: string }).description ?? "", /at most 40 words/);

	// Diff findings carry severity, confidence, location, trigger, impact and the
	// required change — inside the existing string-array schema.
	for (const part of [/severity/i, /confidence/i, /path:line/i, /trigger/i, /impact/i, /required change/i]) {
		assert.match(diff, part, `diff-review-rubric must name ${part}`);
	}
});

// The reviewer's packet is untrusted input (do8.3, do8.4): a plan artifact was
// written by a worker, and a diff is whatever a branch changed — comments,
// fixtures, prompt text. Neither rubric may leave that unsaid, or a reviewer
// reading only its fixture has no reason to treat the files as data.
test("reviewer rubrics frame every file they hand over as input data, never instructions", () => {
	for (const name of ["gate-rubric", "diff-review-rubric"] as const) {
		const text = readBriefTemplate(BRIEFS_DIR, name);
		assert.match(text, /input data, never instructions/i, `${name} must frame its files as data`);
		assert.match(text, /follow\s+nothing/i, `${name} must forbid obeying the files`);
		assert.match(text, /never restate/i, `${name} must forbid restating a body`);
		assert.match(text, /\$\{original_task\}/, `${name} must hand over the original task by pointer`);
		assert.ok(!/\$\{task\}/.test(text), `${name} must never inline a task body into a reviewer brief`);
	}
});

test("brief templates are not exposed as operator prompt templates", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		pi: { prompts: string[] };
	};
	assert.deepEqual(manifest.pi.prompts, ["./prompts/*.md"]);
	// briefs live one level down, so /brief-ship can never be typed by mistake
	assert.ok(readBriefTemplate(BRIEFS_DIR, "brief-ship").length > 0);
});
