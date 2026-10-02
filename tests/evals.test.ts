/**
 * The worker-prompt eval suite, tested for free (do8.7).
 *
 * Two properties matter here and they are different:
 *
 *  1. **The contract arm is real coverage.** Its cases assert what the do8
 *     prompt rewrites actually put in the text a worker reads (resolved base,
 *     flag-independent verdicts, root-cause bug method), so a prompt edit that
 *     drops one fails this file rather than a live run somebody pays for.
 *  2. **The scorer is deterministic and unpaid.** Precision/recall, severity
 *     calibration, coverage and the terminal-report check are pure functions
 *     over recorded text, so the expensive half (calling a model) is the only
 *     part an operator has to authorize.
 *
 * No model is called anywhere in this file. The live transport is exercised
 * against a fake `pi` binary, which is what makes its plumbing testable at all.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type EvalArm,
	type EvalCase,
	type EvalCorpus,
	CORPUS_MAX_CASES,
	CORPUS_MIN_CASES,
	EVAL_TIMEOUT_DEFAULT_MS,
	EvalError,
	formatResult,
	liveEvalSkip,
	liveTimeoutMs,
	liveTransport,
	loadCorpus,
	parseOutput,
	parseTranscript,
	renderSurface,
	replayTransport,
	REQUIRED_SCENARIOS,
	runEval,
	scoreFindings,
	validateCorpus,
} from "../src/evals.ts";
import { REPO_ROOT } from "./harness/index.ts";

const CORPUS_PATH = join(REPO_ROOT, "evals/corpus.json");
const RESULT_PATH = join(REPO_ROOT, "evals/results/contract.json");
const FAKE_PI = join(REPO_ROOT, "tests/fixtures/fake-eval-pi.mjs");

const ARM: EvalArm = {
	name: "candidate",
	profilesDir: join(REPO_ROOT, "profiles"),
	briefsDir: join(REPO_ROOT, "prompts/briefs"),
	model: "anthropic/claude-sonnet-5",
};

function scratch(): { path: string; cleanup(): void } {
	const path = mkdtempSync(join(tmpdir(), "cp-evals-"));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** The live gate open, pointed at the fake pi binary instead of a model. */
function fakeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
	return { ...process.env, CP_EVAL_LIVE: "1", CP_EVAL_PI_BIN: FAKE_PI, ...overrides };
}

/**
 * One string that satisfies a coverage pattern, for building recorded replies:
 * groups and alternations collapse to their first branch, `.{n,m}` to a space,
 * escapes to the literal. Only the syntax this corpus actually uses.
 */
function sampleMatching(pattern: string): string {
	let text = pattern.replace(/\.\{\d+,\d+\}/g, " ");
	while (/\([^()]*\)/.test(text)) {
		text = text.replace(/\(([^()]*)\)/, (_all, inner: string) => (inner.split("|")[0] as string).replace(/\?$/, ""));
	}
	return (text.split("|")[0] as string).replace(/\\/g, "").replace(/[?^$]/g, "");
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

test("the checked-in corpus is 20-50 cases and covers every required scenario", () => {
	const corpus = loadCorpus(CORPUS_PATH);
	assert.ok(
		corpus.cases.length >= CORPUS_MIN_CASES && corpus.cases.length <= CORPUS_MAX_CASES,
		`corpus size ${corpus.cases.length} is outside ${CORPUS_MIN_CASES}-${CORPUS_MAX_CASES}`,
	);
	for (const [role, scenarios] of Object.entries(REQUIRED_SCENARIOS)) {
		for (const scenario of scenarios) {
			const covered = corpus.cases.filter((item) => item.role === role && item.scenario === scenario);
			assert.ok(covered.length > 0, `no case covers ${role}/${scenario}`);
		}
	}
	// Deterministic contract cases and model-quality cases are separate kinds,
	// and both kinds exist: a corpus of only contract cases measures no model,
	// and one of only quality cases can never run in CI.
	assert.ok(corpus.cases.some((item) => item.kind === "contract"));
	assert.ok(corpus.cases.some((item) => item.kind === "quality"));
	// Reviewer ground truth is human-labeled, which is what makes precision and
	// recall computable; every seeded-defect case carries its labels.
	for (const scenario of ["seeded-p0", "seeded-p1", "seeded-p2"]) {
		const seeded = corpus.cases.find((item) => item.scenario === scenario && item.kind === "quality");
		assert.ok((seeded?.expect?.labels ?? []).length > 0, `${scenario} needs at least one human label`);
	}
	// A trap case's ground truth is "there is nothing to find": an empty label
	// list, so every finding counts against precision.
	const trap = corpus.cases.find((item) => item.scenario === "false-positive-trap");
	assert.deepEqual(trap?.expect?.labels, []);
});

test("a corpus that drops a scenario, repeats an id or mislabels a case does not load", (t) => {
	const corpus = loadCorpus(CORPUS_PATH);
	const dir = scratch();
	t.after(() => dir.cleanup());
	const write = (value: unknown): string => {
		const path = join(dir.path, `corpus-${Math.random().toString(36).slice(2)}.json`);
		writeFileSync(path, JSON.stringify(value));
		return path;
	};

	const dropped: EvalCorpus = { ...corpus, cases: corpus.cases.filter((item) => item.scenario !== "seeded-p0") };
	assert.throws(() => loadCorpus(write(dropped)), /no case covers required scenario reviewer\/seeded-p0/);

	const first = corpus.cases[0] as EvalCase;
	assert.match(validateCorpus({ ...corpus, cases: [...corpus.cases, first] }).join("\n"), /duplicate case id/);
	assert.match(validateCorpus({ version: 2, cases: corpus.cases }).join("\n"), /version must be 1/);
	assert.match(validateCorpus({ version: 1, cases: corpus.cases.slice(0, 3) }).join("\n"), /must hold 20-50 cases/);

	const quality = corpus.cases.find((item) => item.kind === "quality") as EvalCase;
	const noSubject = corpus.cases.map((item) => (item === quality ? { ...item, subject: undefined } : item));
	assert.match(validateCorpus({ version: 1, cases: noSubject }).join("\n"), /needs the subject/);

	const contract = corpus.cases.find((item) => item.kind === "contract") as EvalCase;
	const mixed = corpus.cases.map((item) => (item === contract ? { ...item, verdict: undefined, expect: { ...item.expect, labels: [] } } : item));
	assert.match(validateCorpus({ version: 1, cases: mixed }).join("\n"), /not contract ones/);

	const planner = corpus.cases.find((item) => item.role === "planner" && item.kind === "quality") as EvalCase;
	const labeled = corpus.cases.map((item) => (item === planner ? { ...item, expect: { ...item.expect, labels: [] } } : item));
	assert.match(validateCorpus({ version: 1, cases: labeled }).join("\n"), /reviewer ground truth/);
});

test("a coverage pattern that is not a regex is caught at load, not mid-run", (t) => {
	// The regression this pins: coverage patterns are compiled while scoring, so
	// an unclosed group used to throw *after* a paid model call had been made.
	const corpus = loadCorpus(CORPUS_PATH);
	const quality = corpus.cases.find((item) => item.kind === "quality" && (item.expect?.coverage ?? []).length > 0) as EvalCase;
	const broken = corpus.cases.map((item) =>
		item === quality ? { ...item, expect: { ...item.expect, coverage: ["([unclosed", "fine"] } } : item,
	);
	const errors = validateCorpus({ version: 1, cases: broken });
	assert.equal(errors.length, 1, errors.join("\n"));
	assert.match(errors[0] as string, new RegExp(`^${quality.id}: coverage pattern "\\(\\[unclosed" is not a regex`));

	const dir = scratch();
	t.after(() => dir.cleanup());
	const path = join(dir.path, "broken-corpus.json");
	writeFileSync(path, JSON.stringify({ version: 1, cases: broken }));
	assert.throws(() => loadCorpus(path), /coverage pattern .* is not a regex/);

	// Every pattern the shipped corpus uses compiles, which is what makes the
	// task-coverage metric computable at all.
	for (const item of corpus.cases) {
		for (const pattern of item.expect?.coverage ?? []) {
			assert.doesNotThrow(() => new RegExp(pattern, "i"), `${item.id}: ${pattern}`);
		}
	}
});

// ---------------------------------------------------------------------------
// The contract arm: what the do8 prompt rewrites promised
// ---------------------------------------------------------------------------

test("every contract case passes against this repository's own prompts", async () => {
	const result = await runEval({ corpus: loadCorpus(CORPUS_PATH), arm: ARM, kind: "contract", root: REPO_ROOT });
	const failed = result.cases.filter((item) => item.status !== "passed");
	assert.deepEqual(
		failed.map((item) => `${item.case_id}: ${item.checks.filter((check) => !check.ok).map((check) => check.name).join("; ")}`),
		[],
	);
	assert.equal(result.metrics.contract_compliance, 1);
	assert.equal(result.mode, "contract");
	// The versions block is what lets a rollout decision name what it measured.
	assert.equal(result.versions.prompts["profiles/planner.md"]?.startsWith("sha256:"), true);
	assert.equal(result.versions.model, ARM.model);
});

test("the ship brief is rendered with the resolved base, and keeps no origin/main residue", () => {
	// do8.6, asserted through the eval's own renderer: the same text a worker is
	// given, with a non-main base.
	const brief = renderSurface(ARM, "ship-brief");
	assert.match(brief, /git rebase origin\/trunk/);
	assert.doesNotMatch(brief, /origin\/main/);
});

test("quality cases are skipped, with the reason, when nothing is authorized to call a model", async () => {
	const result = await runEval({ corpus: loadCorpus(CORPUS_PATH), arm: ARM, root: REPO_ROOT });
	const skipped = result.cases.filter((item) => item.status === "skipped");
	assert.ok(skipped.length > 0, "the corpus has quality cases; they must be reported, not omitted");
	assert.equal(result.metrics.quality_skipped, skipped.length);
	for (const item of skipped) {
		assert.equal(item.kind, "quality");
		assert.match(item.skipped_reason as string, /CP_EVAL_LIVE=1|--replay/);
	}
});

test("the checked-in contract result is current and byte-stable", async () => {
	const fresh = formatResult(
		await runEval({ corpus: loadCorpus(CORPUS_PATH), arm: ARM, root: REPO_ROOT }),
	);
	const again = formatResult(await runEval({ corpus: loadCorpus(CORPUS_PATH), arm: ARM, root: REPO_ROOT }));
	assert.equal(fresh, again, "a contract run must be deterministic: same prompts in, same bytes out");
	assert.equal(
		readFileSync(RESULT_PATH, "utf8"),
		fresh,
		`${RESULT_PATH} is stale — re-run \`npm run eval:contract\` and commit the result`,
	);
});

// ---------------------------------------------------------------------------
// Scoring: precision, recall, severity, terminal report
// ---------------------------------------------------------------------------

test("precision and recall are computed against the human labels, not against the reviewer's confidence", () => {
	const labels = [
		{ id: "sql", severity: "P0" as const, where: "src/users.ts:42", match: "(sql|injection)" },
		{ id: "test", severity: "P2" as const, where: "src/users.ts:50", match: "test" },
	];
	// One real finding at the right severity, one missed defect, one invention.
	const score = scoreFindings(labels, [
		"[severity: high] [confidence: high] src/users.ts:42 — email is interpolated into SQL → injection → parameterize",
		"[severity: medium] [confidence: low] src/users.ts:9 — the import order is unconventional",
	]);
	assert.equal(score.true_positives, 1);
	assert.equal(score.false_positives, 1);
	assert.equal(score.false_negatives, 1);
	assert.equal(score.precision, 0.5);
	assert.equal(score.recall, 0.5);
	assert.equal(score.severity_matches, 1);
	assert.equal(score.severity_scored, 1);

	// Severity calibration is scored only on matched pairs, and a P0 reported as
	// low is a miscalibration, not a miss.
	const miscalibrated = scoreFindings([labels[0] as (typeof labels)[0]], [
		"[severity: low] [confidence: high] src/users.ts:42 — sql injection → parameterize",
	]);
	assert.equal(miscalibrated.true_positives, 1);
	assert.equal(miscalibrated.severity_matches, 0);

	// Two findings about one defect are one true positive and one false
	// positive: a reviewer is not rewarded for repeating itself.
	const repeated = scoreFindings([labels[0] as (typeof labels)[0]], [
		"[severity: high] src/users.ts:42 — sql injection",
		"[severity: high] src/users.ts:43 — sql injection again",
	]);
	assert.equal(repeated.true_positives, 1);
	assert.equal(repeated.false_positives, 1);
	assert.equal(repeated.precision, 0.5);

	// A clean case has no labels: every finding is a false positive, and recall
	// is undefined rather than 0 (there was nothing to recall).
	const clean = scoreFindings([], ["[severity: low] src/util.ts:1 — consider renaming this"]);
	assert.equal(clean.false_positives, 1);
	assert.equal(clean.precision, 0);
	assert.equal(clean.recall, null);
	assert.equal(scoreFindings([], []).precision, null);
});

test("the terminal report is the JSON the output contract asks for, read out of a transcript", () => {
	const parsed = parseOutput(
		'I read the diff.\nHere is my verdict.\n{"verdict":"revise","flags":{"scope_growth":true},"reasons":["a"],"revisions":["b"]}\n',
	);
	assert.equal(parsed.terminal, true);
	assert.equal(parsed.verdict, "revise");
	assert.deepEqual(parsed.flags, { scope_growth: true });
	assert.deepEqual(parsed.findings, ["a", "b"]);

	// Prose with no report is exactly the failure mode the metric exists for.
	assert.equal(parseOutput("I would revise this diff. Trust me.").terminal, false);
	// Malformed JSON does not throw and does not count as a report.
	assert.equal(parseOutput('{"verdict": "pass"').terminal, false);
	// A `status` envelope (planner/implementer cases) is a terminal report too.
	assert.equal(parseOutput('{"status":"blocked","summary":"conflict in src/contracts.ts"}').terminal, true);
});

test("a recorded run is scored without a model, and every metric bucket is computed", async (t) => {
	const dir = scratch();
	t.after(() => dir.cleanup());
	const armDir = join(dir.path, "candidate");
	mkdirSync(armDir, { recursive: true });
	const corpus = loadCorpus(CORPUS_PATH);
	const quality = corpus.cases.filter((item) => item.kind === "quality");

	// Record a reply for every quality case: a terminal report that satisfies
	// the reviewer expectations, cites path:line, and names the coverage terms.
	for (const item of quality) {
		const findings = (item.expect?.labels ?? []).map(
			(label) => `[severity: ${{ P0: "high", P1: "medium", P2: "low" }[label.severity]}] [confidence: high] ${label.where} — ${label.id} → impact → fix`,
		);
		const coverage = (item.expect?.coverage ?? []).map(sampleMatching);
		const body = {
			...(item.expect?.verdict ? { verdict: item.expect.verdict } : { status: "done" }),
			flags: item.expect?.flags ?? {},
			reasons: findings,
			revisions: [],
			summary: "recorded",
		};
		// Recordings are `pi --mode json` streams, which is what carries the tokens
		// and tool calls the rollout gate reads.
		const events = [
			{ type: "tool_execution_start", toolName: "read" },
			{ type: "tool_execution_start", toolName: "read" },
			{ type: "tool_execution_start", toolName: "grep" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: `src/example.ts:12 evidence. ${coverage.join(" ")}\n${JSON.stringify(body)}`,
					usage: { input: 1000, output: 200, totalTokens: 1200 },
				},
			},
		];
		writeFileSync(join(armDir, `${item.id}.txt`), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	}

	const result = await runEval({
		corpus,
		arm: ARM,
		transport: replayTransport(dir.path),
		kind: "quality",
		trials: 2,
		root: REPO_ROOT,
	});
	assert.equal(result.mode, "model");
	assert.equal(result.trials, 2);
	assert.equal(result.cases.length, quality.length * 2, "every quality case runs every trial");
	assert.equal(result.metrics.terminal_report, 1);
	assert.equal(result.metrics.task_coverage, 1, "the recorded replies name every coverage term");
	assert.equal(result.metrics.grounded_evidence, 1);
	assert.equal(result.metrics.reviewer_recall, 1, "every labeled defect was reported");
	assert.equal(result.metrics.reviewer_precision, 1);
	assert.equal(result.metrics.reviewer_severity_accuracy, 1);
	assert.equal(result.metrics.plan_first_pass, 1);
	assert.equal(result.metrics.implementation_verification, 1);
	assert.equal(result.metrics.quality_skipped, 0);
	// The two cost metrics are populated from the recordings, not left null: a
	// median gate nobody can compute is a gate nobody can apply.
	assert.equal(result.metrics.median_tokens, 1200);
	assert.equal(result.metrics.median_tool_calls, 3);

	// A reviewer that misses the seeded defect and invents one instead scores
	// zero on both, and the case fails — the point of the whole exercise.
	const seeded = quality.find((item) => item.scenario === "seeded-p0") as EvalCase;
	writeFileSync(
		join(armDir, `${seeded.id}.txt`),
		`{"verdict":"pass","flags":{},"reasons":["[severity: low] src/users.ts:1 — consider renaming findUser"],"revisions":[]}\n`,
	);
	// That one is a plain transcript, not an event stream: it still scores, and
	// the medians simply stop counting it.
	const worse = await runEval({ corpus, arm: ARM, transport: replayTransport(dir.path), kind: "quality", root: REPO_ROOT });
	const scored = worse.cases.find((item) => item.case_id === seeded.id);
	assert.equal(scored?.status, "failed");
	assert.equal(scored?.findings?.true_positives, 0);
	assert.equal(scored?.findings?.false_positives, 1);
	assert.ok((worse.metrics.reviewer_recall as number) < 1);
});

test("a missing recording is an error, not a silent pass", async (t) => {
	const dir = scratch();
	t.after(() => dir.cleanup());
	await assert.rejects(
		runEval({ corpus: loadCorpus(CORPUS_PATH), arm: ARM, transport: replayTransport(dir.path), kind: "quality", root: REPO_ROOT }),
		(error: unknown) => error instanceof EvalError && /no recording for/.test((error as Error).message),
	);
});

// ---------------------------------------------------------------------------
// The money gate
// ---------------------------------------------------------------------------

test("model trials are refused until an operator opens the gate", async () => {
	assert.match(liveEvalSkip({} as NodeJS.ProcessEnv) as string, /CP_EVAL_LIVE=1/);
	assert.match(liveEvalSkip({} as NodeJS.ProcessEnv) as string, /cost money/);
	assert.equal(liveEvalSkip({ CP_EVAL_LIVE: "1" } as NodeJS.ProcessEnv), false);

	const corpus = loadCorpus(CORPUS_PATH);
	await assert.rejects(
		runEval({
			corpus,
			arm: ARM,
			transport: liveTransport({} as NodeJS.ProcessEnv),
			kind: "quality",
			root: REPO_ROOT,
		}),
		/live eval refused/,
	);
});

test("the live transport invokes a headless model run and reports what it spent", async () => {
	// Gate open, but pointed at a fake binary: the plumbing (argv shape, stdout
	// capture, event parsing, usage accounting) is proven without spending
	// anything.
	const corpus = loadCorpus(CORPUS_PATH);
	// `kind: "quality"` is load-bearing, not decoration: a scenario carries both a
	// contract case (prompt text) and a quality case (a model call), and only the
	// latter exercises a transport at all. Same predicate as the seeded-defect
	// lookup above.
	const clean = corpus.cases.find((item) => item.scenario === "clean-diff" && item.kind === "quality") as EvalCase;
	const result = await runEval({
		corpus: { version: 1, cases: [clean] } as EvalCorpus,
		arm: ARM,
		transport: liveTransport(fakeEnv()),
		root: REPO_ROOT,
	});
	assert.equal(result.cases.length, 1);
	assert.equal(result.cases[0]?.status, "passed", JSON.stringify(result.cases[0]?.checks));
	assert.equal(result.metrics.terminal_report, 1);
	// The rollout gate reads medians, so a live run has to carry them: these are
	// the fake's own numbers, read out of its event stream.
	assert.equal(result.cases[0]?.tokens, 1234);
	assert.equal(result.cases[0]?.tool_calls, 2);
	assert.equal(result.metrics.median_tokens, 1234);
	assert.equal(result.metrics.median_tool_calls, 2);
});

test("a live run is bounded by Node's own timeout, and says what to do about it", async () => {
	const corpus = loadCorpus(CORPUS_PATH);
	const clean = corpus.cases.find((item) => item.scenario === "clean-diff" && item.kind === "quality") as EvalCase;
	const started = Date.now();
	await assert.rejects(
		runEval({
			corpus: { version: 1, cases: [clean] } as EvalCorpus,
			arm: ARM,
			// A worker has no GNU `timeout`, so the bound is execFileSync's own.
			transport: liveTransport(fakeEnv({ CP_FAKE_PI_MODE: "slow", CP_EVAL_TIMEOUT_MS: "750" })),
			root: REPO_ROOT,
		}),
		(error: unknown) => {
			assert.ok(error instanceof EvalError, String(error));
			const message = (error as Error).message;
			assert.match(message, new RegExp(`^${clean.id} \\(trial 1\\)`), message);
			assert.match(message, /exceeded the 750ms budget and was killed/, message);
			assert.match(message, /nothing was scored for this case/, message);
			// Actionable: every way out is named.
			assert.match(message, /CP_EVAL_TIMEOUT_MS/, message);
			assert.match(message, /--trials/, message);
			assert.match(message, /--replay/, message);
			return true;
		},
	);
	// The bound is real: the fake would otherwise hold the process for 600s.
	assert.ok(Date.now() - started < 60_000, "the timeout did not actually stop the run");
});

test("a live run that dies for another reason names the exit code and the stderr tail", async () => {
	const corpus = loadCorpus(CORPUS_PATH);
	const clean = corpus.cases.find((item) => item.scenario === "clean-diff" && item.kind === "quality") as EvalCase;
	await assert.rejects(
		runEval({
			corpus: { version: 1, cases: [clean] } as EvalCorpus,
			arm: ARM,
			transport: liveTransport(fakeEnv({ CP_FAKE_PI_MODE: "fail" })),
			root: REPO_ROOT,
		}),
		(error: unknown) =>
			error instanceof EvalError &&
			/exited 3/.test((error as Error).message) &&
			/401 Unauthorized/.test((error as Error).message),
	);

	// A binary that is not there is the other operator-fixable failure.
	await assert.rejects(
		runEval({
			corpus: { version: 1, cases: [clean] } as EvalCorpus,
			arm: ARM,
			transport: liveTransport(fakeEnv({ CP_EVAL_PI_BIN: join(REPO_ROOT, "tests/fixtures/not-a-binary") })),
			root: REPO_ROOT,
		}),
		/set CP_EVAL_PI_BIN/,
	);
});

test("the live timeout has a default and refuses a nonsense override", () => {
	assert.equal(liveTimeoutMs({} as NodeJS.ProcessEnv), EVAL_TIMEOUT_DEFAULT_MS);
	assert.ok(EVAL_TIMEOUT_DEFAULT_MS >= 60_000, "a real model turn needs minutes, not seconds");
	assert.equal(liveTimeoutMs({ CP_EVAL_TIMEOUT_MS: "1500" } as NodeJS.ProcessEnv), 1500);
	assert.throws(() => liveTimeoutMs({ CP_EVAL_TIMEOUT_MS: "soon" } as NodeJS.ProcessEnv), /positive number of milliseconds/);
	assert.throws(() => liveTimeoutMs({ CP_EVAL_TIMEOUT_MS: "-1" } as NodeJS.ProcessEnv), /positive number of milliseconds/);
});

test("tokens and tool calls come out of the event stream, and stay absent when nobody counted", () => {
	const stream = [
		{ type: "message_update", usage: { input: 10, output: 1, totalTokens: 11 } },
		{ type: "tool_execution_start", toolName: "read" },
		{ type: "message_end", message: { role: "assistant", content: "first", usage: { totalTokens: 100 } } },
		{ type: "message_update", usage: { totalTokens: 7 } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"verdict":"pass"}' }], usage: { input: 40, output: 10 } } },
	]
		.map((event) => JSON.stringify(event))
		.join("\n");
	const parsed = parseTranscript(`${stream}\n`);
	assert.equal(parsed.tokens, 150, "settled message usage adds up; a superseded in-flight update does not");
	assert.equal(parsed.tool_calls, 1);
	assert.equal(parsed.text, 'first\n{"verdict":"pass"}');
	assert.equal(parseOutput(parsed.text).verdict, "pass");

	// Usage still streaming when the run ended is counted once, not dropped.
	const midFlight = parseTranscript(
		`${JSON.stringify({ type: "message_update", usage: { totalTokens: 42 } })}\n${JSON.stringify({ type: "agent_end" })}\n`,
	);
	assert.equal(midFlight.tokens, 42);

	// A plain transcript is scorable, and reports no measurement rather than a
	// zero: an unmeasured arm must not read as a free one.
	const plain = parseTranscript('I reviewed it.\n{"verdict":"revise"}\n');
	assert.equal(plain.tokens, undefined);
	assert.equal(plain.tool_calls, undefined);
	assert.equal(plain.text, 'I reviewed it.\n{"verdict":"revise"}\n');

	// An event stream with no assistant text falls back to the raw stream, so a
	// malformed run is still scored (and fails honestly) rather than throwing.
	const noText = parseTranscript(`${JSON.stringify({ type: "agent_start" })}\n`);
	assert.match(noText.text, /agent_start/);
	assert.equal(noText.tokens, undefined);
	assert.equal(noText.tool_calls, 0);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("`node scripts/eval.ts --check` is the documented drift check", () => {
	const out = execFileSync(process.execPath, ["scripts/eval.ts", "--out", "evals/results/contract.json", "--check"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(out, "", "--check writes nothing to stdout");

	// A different arm renders the same prompts and must still pass its contract
	// cases; the arm name is recorded, not scored.
	const other = execFileSync(process.execPath, ["scripts/eval.ts", "--arm", "baseline", "--kind", "contract"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	assert.equal(JSON.parse(other).versions.arm, "baseline");
	assert.equal(JSON.parse(other).metrics.contract_compliance, 1);
});
