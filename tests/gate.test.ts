/**
 * T20 acceptance: every verdict/cause branch, with a stubbed reviewer.
 *
 * "Stubbed" here means a real `pi --mode rpc` gate-reviewer worker whose model
 * is the scriptable mock provider: the whole path (profile, scratch cwd,
 * artifact copy, `report_verdict`, write-once verdict.json, policy, gate-N.json)
 * runs for real, and only the model's answer is canned.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { CapacityReader } from "../src/capacity.ts";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	GATE_REASONS_MAX_ITEMS,
	GATE_RUBRIC_STATEMENT,
	GATE_VETO_FLAGS,
	type GateFlags,
	type GateReview,
	type GateVerdict,
	GateVerdictSchema,
	isoTimestamp,
	type JobRouting,
	LAYOUT,
	paths,
	REVIEW_ORIGINAL_TASK_MAX_BYTES,
	type RoutingConfig,
	SCHEMA_VERSION,
	validate,
	type VerdictRecord,
} from "../src/contracts.ts";
import { FleetStore } from "../src/fleet.ts";
import {
	awaitVerdict,
	BACKSTOP_POLL_INTERVAL_MS,
	capPayload,
	copyOriginalTask,
	decideGate,
	formatGate,
	Gate,
	GateError,
	isGateWait,
	nextAction,
	originalTaskBlock,
	ORIGINAL_TASK_COPY,
	readPriorAttempts,
	removeGateScratch,
	reviseMessage,
	SETTLE_GRACE_MS,
} from "../src/gate.ts";
import { assembleBrief, loadProfile, readBriefTemplate } from "../src/profiles.ts";
import { DEFAULT_ROUTING_CONFIG, type ModelProbe } from "../src/routing.ts";
import { ReviewRuns, type ReviewWakeup } from "../src/review-runs.ts";
import { RunRegistry } from "../src/runs.ts";
import { Sender } from "../src/send.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import {
	argOf,
	captureSpawns,
	createAgentDir,
	createScratchHome,
	MockProvider,
	REPO_ROOT,
	type ScriptOptions,
	type ScriptStep,
	WORKER_REPORTER_EXTENSION,
} from "./harness/index.ts";

const PROFILES_DIR = join(REPO_ROOT, "profiles");
const BRIEFS_DIR = join(REPO_ROOT, "prompts/briefs");

const NO_FLAGS: GateFlags = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

/** Only the mock models exist, so the fallback ladder is observable. */
const MOCK_ONLY: ModelProbe = { isAvailable: (model) => model.startsWith("mock/") };

function review(overrides: Partial<GateReview> & { job_id: string }): GateReview {
	return {
		verdict: "pass",
		flags: { ...NO_FLAGS },
		reasons: ["file list is concrete"],
		...overrides,
	} as GateReview;
}

// ---------------------------------------------------------------------------
// Policy (pure) — every branch of the ported rubric
// ---------------------------------------------------------------------------

const NO_PRIOR = { priorRevise: false, priorCause: null } as const;

test("pass and revise carry no cause; escalate always names one", () => {
	const pass = decideGate({ jobId: "cp-a", attempt: 1, prior: NO_PRIOR, model: "m", review: review({ job_id: "cp-a" }) });
	assert.equal(pass.verdict, "pass");
	assert.equal(pass.cause, null);
	assert.equal(nextAction(pass), "proceed");

	const revise = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", verdict: "revise", revisions: ["name the exact files"] }),
	});
	assert.equal(revise.verdict, "revise");
	assert.equal(revise.cause, null);
	assert.deepEqual(revise.revisions, ["name the exact files"]);
	assert.equal(nextAction(revise), "revise");

	// A reviewer's own escalate is a judgment about the artifact: policy.
	const escalate = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", verdict: "escalate", reasons: ["no test plan"] }),
	});
	assert.equal(escalate.cause, "policy");
	assert.equal(nextAction(escalate), "surface");
});

test("every verdict names the rubric it applied, and it never costs a reviewer a reason (cp-950e)", () => {
	const cases: Array<[string, GateVerdict]> = [
		["pass", decideGate({ jobId: "cp-a", attempt: 1, prior: NO_PRIOR, model: "m", review: review({ job_id: "cp-a" }) })],
		[
			"revise",
			decideGate({
				jobId: "cp-a",
				attempt: 1,
				prior: NO_PRIOR,
				model: "m",
				review: review({ job_id: "cp-a", verdict: "revise", revisions: ["name the exact files"] }),
			}),
		],
		[
			"escalate",
			decideGate({
				jobId: "cp-a",
				attempt: 1,
				prior: NO_PRIOR,
				model: "m",
				review: review({ job_id: "cp-a", verdict: "escalate", reasons: ["no test plan"] }),
			}),
		],
		[
			"operational (no usable verdict)",
			decideGate({ jobId: "cp-a", attempt: 1, prior: NO_PRIOR, model: "m", operational: "reviewer died" }),
		],
	];
	for (const [label, decision] of cases) {
		assert.equal(decision.rubric, GATE_RUBRIC_STATEMENT, `${label} verdict does not name its rubric`);
		assert.match(decision.rubric ?? "", /implementation-plan rubric/);
		// The statement is its own field, never a reason: a reason would spend the
		// capped payload budget a reviewer's own reasons need.
		assert.ok(
			!decision.reasons.some((reason) => reason.includes("implementation-plan rubric")),
			`${label}: the rubric statement must not be carried as a reason`,
		);
		assert.ok(validate<GateVerdict>(GateVerdictSchema, decision).ok, `${label} verdict is not schema-valid`);
	}

	// The cap still holds exactly: a reviewer at the maximum loses nothing.
	const maxed = Array.from({ length: GATE_REASONS_MAX_ITEMS }, (_unused, index) => `reviewer reason ${index}`);
	const atCap = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", reasons: maxed }),
	});
	assert.equal(atCap.reasons.length, GATE_REASONS_MAX_ITEMS);
	assert.deepEqual(atCap.reasons, maxed, "the rubric statement must not displace any reviewer reason");
	assert.equal(atCap.rubric, GATE_RUBRIC_STATEMENT);
	assert.ok(validate<GateVerdict>(GateVerdictSchema, atCap).ok);

	assert.match(
		formatGate({
			verdict: atCap,
			next: nextAction(atCap),
			model: "m",
			attempt: 1,
			path: "gate-1.json",
		} as never),
		/rubric: .*implementation-plan rubric/,
	);
});

test("a veto flag forces escalate on a reviewer pass: FLAGGED, not policy — it may still reach a checkpoint", () => {
	assert.deepEqual([...GATE_VETO_FLAGS], ["destructive_scope", "scope_growth"], "the veto set is policy, not an implementation detail");
	for (const flag of GATE_VETO_FLAGS) {
		const decision = decideGate({
			jobId: "cp-a",
			attempt: 1,
			prior: NO_PRIOR,
			model: "m",
			review: review({ job_id: "cp-a", verdict: "pass", flags: { ...NO_FLAGS, [flag]: true } }),
		});
		assert.equal(decision.verdict, "escalate", `${flag} did not force escalate`);
		assert.equal(decision.cause, "flagged", `${flag}: a flag on top of a reviewer pass is FLAGGED, never policy`);
		assert.ok(decision.reasons.some((reason) => reason.includes(`flag forced escalate: ${flag}`)));
		assert.equal(decision.flags[flag], true);
		assert.equal(nextAction(decision), "authorize", "a flagged escalate may still reach a human checkpoint");
	}
});

// cp-unknowns-no-veto: `blocking_unknowns` is true by construction of any
// correctly decomposed ticket ("an assumption nothing in the diff resolves" —
// the rest is a sibling ticket's job), so a veto on it made incremental
// delivery an escalate, and `policy` — unauthorizable — whenever the reviewer
// said `revise`. It is now reported and nothing more.
test("blocking_unknowns is reported, never a veto: the reviewer's own verdict stands (cp-unknowns-no-veto)", () => {
	const UNKNOWNS: GateFlags = { ...NO_FLAGS, blocking_unknowns: true };

	const onPass = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", verdict: "pass", flags: { ...UNKNOWNS }, reasons: ["defers the hub to cp-b1"] }),
	});
	assert.equal(onPass.verdict, "pass", "blocking_unknowns no longer forces escalate");
	assert.equal(onPass.cause, null, "a pass carries no cause — not `flagged`");
	assert.equal(nextAction(onPass), "proceed");
	// The evidence survives: the flag is persisted and it has its own reason line.
	assert.deepEqual(onPass.flags, UNKNOWNS);
	assert.ok(onPass.reasons.includes("defers the hub to cp-b1"), "the reviewer's own reason is kept");
	assert.ok(onPass.reasons.some((reason) => reason.includes("flag reported, no veto: blocking_unknowns")));
	assert.ok(
		!onPass.reasons.some((reason) => reason.includes("flag forced escalate")),
		"nothing was forced, so nothing may claim it was",
	);
	assert.ok(validate<GateVerdict>(GateVerdictSchema, onPass).ok);

	const onRevise = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			flags: { ...UNKNOWNS },
			revisions: ["name the exact files"],
		}),
	});
	assert.equal(onRevise.verdict, "revise", "a revise stays a revise: the implementer gets one round, not a dead end");
	assert.equal(onRevise.cause, null, "the unauthorizable escalate/policy is exactly the defect this removes");
	assert.equal(nextAction(onRevise), "revise");
	assert.deepEqual(onRevise.revisions, ["name the exact files"]);
	assert.deepEqual(onRevise.flags, UNKNOWNS);
	assert.ok(onRevise.reasons.some((reason) => reason.includes("flag reported, no veto: blocking_unknowns")));

	// It rides along without changing a veto flag's own outcome, and only the
	// vetoing flag is named as having forced anything.
	const alongside = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", verdict: "pass", flags: { ...UNKNOWNS, destructive_scope: true } }),
	});
	assert.equal(alongside.verdict, "escalate");
	assert.equal(alongside.cause, "flagged");
	assert.ok(alongside.reasons.some((reason) => reason.includes("flag forced escalate: destructive_scope")));
	assert.ok(
		!alongside.reasons.some((reason) => reason.includes("flag forced escalate: destructive_scope, blocking_unknowns")),
		"a reported flag is never listed as one that forced the escalate",
	);
	assert.ok(alongside.reasons.some((reason) => reason.includes("flag reported, no veto: blocking_unknowns")));
});

test("a veto flag on top of a reviewer's own escalate, or on top of revise, stays POLICY", () => {
	// The reviewer already judged the plan disputed (its own escalate): the
	// flag is riding on an unresolved judgment, not a sound plan.
	const onEscalate = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-a", verdict: "escalate", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: ["no test plan"] }),
	});
	assert.equal(onEscalate.cause, "policy");
	assert.equal(nextAction(onEscalate), "surface");

	// The reviewer asked for a revision: the plan is not yet judged sound either.
	// Unchanged for every flag that still vetoes.
	for (const flag of GATE_VETO_FLAGS) {
		const onRevise = decideGate({
			jobId: "cp-a",
			attempt: 1,
			prior: NO_PRIOR,
			model: "m",
			review: review({
				job_id: "cp-a",
				verdict: "revise",
				flags: { ...NO_FLAGS, [flag]: true },
				revisions: ["name the exact files"],
			}),
		});
		assert.equal(onRevise.verdict, "escalate", flag);
		assert.equal(onRevise.cause, "policy", flag);
		assert.equal(nextAction(onRevise), "surface", flag);
	}
});

// pi-command-post-review-high-only-4gi / review-no-veto-grp: DiffReview opts
// into these; the plan gate's default decideGate() is unchanged.
test("highOnlyBar: a revise with no high/high finding is downgraded to pass", () => {
	const medium = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		highOnlyBar: true,
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			reasons: ["[severity: medium] [confidence: high] src/x.ts:1 — missing a test"],
			revisions: ["[severity: low] [confidence: high] src/x.ts:1 — add a test"],
		}),
	});
	assert.equal(medium.verdict, "pass");
	assert.equal(medium.cause, null);
	assert.equal(medium.revisions, undefined);
	assert.ok(medium.reasons.some((reason) => reason.includes("downgraded: no high/high finding")));

	const mixedConfidence = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		highOnlyBar: true,
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			reasons: ["[severity: high] [confidence: medium] src/x.ts:1 — maybe a leak"],
			revisions: ["lock it down"],
		}),
	});
	assert.equal(mixedConfidence.verdict, "pass");
	assert.equal(mixedConfidence.revisions, undefined);

	const untagged = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		highOnlyBar: true,
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			reasons: ["needs a test"],
			revisions: ["add a test"],
		}),
	});
	assert.equal(untagged.verdict, "pass", "missing tags are not high/high");
	assert.equal(untagged.revisions, undefined);
	assert.ok(untagged.reasons.some((reason) => reason.includes("downgraded: no high/high finding")));
});

test("highOnlyBar: a high/high finding keeps revise; escalate and omitted bar are untouched", () => {
	const kept = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		highOnlyBar: true,
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			reasons: ["[severity: high] [confidence: high] src/x.ts:1 — auth bypass"],
			revisions: ["[severity: high] [confidence: high] src/x.ts:1 — reject empty token"],
		}),
	});
	assert.equal(kept.verdict, "revise");
	assert.equal(kept.cause, null);
	assert.deepEqual(kept.revisions, ["[severity: high] [confidence: high] src/x.ts:1 — reject empty token"]);
	assert.ok(!kept.reasons.some((reason) => reason.includes("downgraded: no high/high finding")));

	const escalate = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		highOnlyBar: true,
		review: review({ job_id: "cp-a", verdict: "escalate", reasons: ["stat empty"] }),
	});
	assert.equal(escalate.verdict, "escalate");
	assert.equal(escalate.cause, "policy");

	const omitted = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		review: review({
			job_id: "cp-a",
			verdict: "revise",
			reasons: ["[severity: medium] [confidence: high] src/x.ts:1 — missing a test"],
			revisions: ["add a test"],
		}),
	});
	assert.equal(omitted.verdict, "revise", "the plan gate's default is unchanged");
	assert.deepEqual(omitted.revisions, ["add a test"]);
});

test("empty vetoFlags: a raised flag is reported, never forced", () => {
	const decision = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		vetoFlags: [],
		review: review({
			job_id: "cp-a",
			verdict: "pass",
			flags: { ...NO_FLAGS, destructive_scope: true },
			reasons: ["the diff drops a table"],
		}),
	});
	assert.equal(decision.verdict, "pass");
	assert.equal(decision.cause, null);
	assert.equal(decision.flags.destructive_scope, true);
	assert.ok(decision.reasons.some((reason) => reason.includes("flag reported, no veto: destructive_scope")));
	assert.ok(
		!decision.reasons.some((reason) => reason.includes("flag forced escalate")),
		"an empty veto list never claims a force",
	);
	assert.equal(nextAction(decision), "proceed");
});

test("one revise max: a second revise becomes escalate on policy, and drops revisions", () => {
	const decision = decideGate({
		jobId: "cp-a",
		attempt: 2,
		prior: { priorRevise: true, priorCause: null },
		model: "m",
		review: review({ job_id: "cp-a", verdict: "revise", revisions: ["again"] }),
	});
	assert.equal(decision.verdict, "escalate");
	assert.equal(decision.cause, "policy");
	assert.equal(decision.revisions, undefined, "an escalate carries no revisions");
	assert.ok(decision.reasons.some((reason) => reason.includes("attempt cap")));
});

test("no usable verdict is operational, then operational_persistent", () => {
	const first = decideGate({
		jobId: "cp-a",
		attempt: 1,
		prior: NO_PRIOR,
		model: "m",
		operational: "reviewer exited without reporting a verdict",
	});
	assert.equal(first.verdict, "escalate");
	assert.equal(first.cause, "operational");
	assert.deepEqual(first.flags, NO_FLAGS, "flags are never invented");
	assert.equal(nextAction(first), "retry");

	for (const priorCause of ["operational", "operational_persistent"] as const) {
		const second = decideGate({
			jobId: "cp-a",
			attempt: 2,
			prior: { priorRevise: false, priorCause },
			model: "m2",
			operational: "reviewer exhausted its in-run verdict repairs",
		});
		assert.equal(second.cause, "operational_persistent");
		assert.equal(nextAction(second), "surface", "a persistent tool failure stops looping");
	}
});

test("the verdict payload is capped so it can be relayed verbatim", () => {
	const long = Array.from({ length: 10 }, (_unused, index) => `${index} ${"word ".repeat(40)}`);
	const capped = capPayload(long, undefined, 100);
	assert.ok(capped.reasons.length < long.length);
	assert.ok(capped.reasons.at(-1)?.includes("dropped"));
	const total = capped.reasons.join(" ").split(/\s+/).filter(Boolean).length;
	assert.ok(total <= 100 + 20, `capped payload is ${total} words`);
	// Under the cap nothing is touched.
	assert.deepEqual(capPayload(["short reason"], ["short revision"], 100), {
		reasons: ["short reason"],
		revisions: ["short revision"],
	});
});

test("capPayload enforces the item cap even when everything fits the word budget (cp-yg2)", () => {
	// A dozen short reasons: nowhere near the 300-word budget, but one item
	// over the schema's maxItems. The old implementation only counted words,
	// so this shape sailed through uncapped and blew up at schema validation.
	const many = Array.from({ length: GATE_REASONS_MAX_ITEMS + 2 }, (_unused, index) => `reason ${index}`);
	const capped = capPayload(many, undefined);
	assert.ok(capped.reasons.length <= GATE_REASONS_MAX_ITEMS, `capped to ${capped.reasons.length} items`);
	assert.ok(capped.reasons.at(-1)?.includes("dropped"));
	// The full, pre-cap list travels back so the caller can persist it.
	assert.deepEqual(capped.raw?.reasons, many);
});

test("a fabricated 15-reason review still produces a schema-valid, gateable verdict (cp-yg2)", () => {
	// Exactly the shape that made cp-yg2 ungateable: a reviewer observation
	// with more reasons than the decision schema allows. No live model —
	// `decideGate` is pure, so this is reproduced directly.
	const manyReasons = Array.from({ length: 15 }, (_unused, index) => `reason number ${index} the reviewer gave`);
	const decision = decideGate({
		jobId: "cp-yg2",
		attempt: 2,
		prior: NO_PRIOR,
		model: "m",
		review: review({ job_id: "cp-yg2", verdict: "escalate", reasons: manyReasons }),
	});

	// The persisted shape (raw stripped) is what `Gate.gate` writes to
	// gate-<n>.json, and it must validate — the whole bug was that it did not.
	const { raw, ...persisted } = decision;
	const validated = validate<GateVerdict>(GateVerdictSchema, persisted);
	assert.ok(validated.ok, `capped decision still violates the contract: ${!validated.ok ? validated.errors.join("; ") : ""}`);
	assert.ok(persisted.reasons.length <= GATE_REASONS_MAX_ITEMS);
	assert.equal(persisted.verdict, "escalate");
	assert.equal(persisted.cause, "policy");
	assert.ok(persisted.reasons.some((r) => r.includes("dropped")), "a truncation note must be visible to the operator");

	// The full 15 reasons are recoverable from `.raw`, not silently lost.
	assert.deepEqual(raw?.reasons, manyReasons);
});

test("prior attempts are read from disk, so the revise cap survives a restart", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	assert.deepEqual(readPriorAttempts(home.path, "cp-a"), {
		decisions: [],
		attempt: 1,
		priorRevise: false,
		priorCause: null,
	});

	const first: GateVerdict = {
		schema_version: SCHEMA_VERSION,
		job_id: "cp-a",
		attempt: 1,
		verdict: "revise",
		cause: null,
		flags: { ...NO_FLAGS },
		reasons: ["thin test plan"],
		revisions: ["name the commands"],
		model: "mock/one",
		decided_at: isoTimestamp(),
	};
	mkdirSync(join(home.path, paths.runDir("cp-a")), { recursive: true });
	writeFileSync(join(home.path, paths.gateFile("cp-a", 1)), JSON.stringify(first));
	const prior = readPriorAttempts(home.path, "cp-a");
	assert.equal(prior.attempt, 2);
	assert.equal(prior.priorRevise, true);
	assert.equal(prior.priorCause, null);

	writeFileSync(join(home.path, paths.gateFile("cp-a", 2)), JSON.stringify({ ...first, attempt: 2, verdict: "x" }));
	assert.throws(() => readPriorAttempts(home.path, "cp-a"), GateError);
});

test("the revise promote carries the revisions and says it is the only one", () => {
	const message = reviseMessage({
		schema_version: SCHEMA_VERSION,
		job_id: "cp-a",
		attempt: 1,
		verdict: "revise",
		cause: null,
		flags: { ...NO_FLAGS },
		reasons: ["thin test plan"],
		revisions: ["list the exact commands"],
		model: "mock/one",
		decided_at: isoTimestamp(),
	});
	assert.match(message, /list the exact commands/);
	assert.match(message, /only revision available/);
	// The promote text asks for a reply, because the artifact is the deliverable
	// and the gate re-reads it from disk. What it must NOT do any more is claim a
	// second `report_result` is refused: a promote reopens the envelope slot
	// (contracts §Envelope supersession), so a re-report is accepted. Telling a
	// worker its report will be refused, while the machinery would accept it, is
	// the same class of lie as accepting work nobody can report.
	assert.match(message, /A reply is enough/);
	assert.match(message, /envelope slot was\n?reopened/);
	assert.doesNotMatch(message, /Do not call report_result again/);
	assert.match(message, /Update the artifact in place/);
});

// ---------------------------------------------------------------------------
// The gate run, with a stubbed reviewer
// ---------------------------------------------------------------------------

interface Bench {
	home: string;
	agentDir: string;
	provider: MockProvider;
	artifacts: ArtifactStore;
	fleet: FleetStore;
	manager: WorkerManager;
	runs: RunRegistry;
	gate: Gate;
	sent: ReviewWakeup[];
	reviews: ReviewRuns;
	/**
	 * The very object the gate routes with. Mutable on purpose: a rubric row can
	 * only name a mock model after its script is registered, which is after the
	 * bench is built.
	 */
	routing: RoutingConfig;
	/** A dispatch record for the subject job, with the routing it was dispatched on. */
	subjectRecord(jobId: string, routing?: JobRouting): Promise<void>;
	script(name: string, steps: ScriptStep[], options?: ScriptOptions): string;
	/** Register the models file after every script is known. */
	seal(): void;
	writeArtifact(jobId: string, body?: string): string;
	/** The frozen original task `Dispatcher.dispatch` would have written. */
	writeOriginalTask(jobId: string, body: string): string;
	/** A live "planner" worker + fleet record for the promote path. */
	livePlanner(jobId: string): Promise<void>;
}

/**
 * `null` omits `reviewTimeoutMs` from `GateOptions` entirely, so the gate falls
 * back to `data/gate.json` (or the built-in default) exactly as it would from
 * `CommandPost.gateModule()` — the config-file precedence tests need that.
 */
async function benchOf(
	t: { after(fn: () => void | Promise<void>): void },
	options: { reviewTimeoutMs?: number | null; rmScratch?: (dir: string) => void; capacity?: (home: string, fleet: FleetStore) => CapacityReader; probe?: ModelProbe } = {},
): Promise<Bench> {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const agentDir = createAgentDir({ provider });
	const artifacts = new ArtifactStore({ home: home.path });
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	const manager = new WorkerManager({
		home: home.path,
		workerReporterPath: WORKER_REPORTER_EXTENSION,
		parentEnv: { ...process.env, ...agentDir.env },
	});
	const sender = new Sender({ fleet, manager, runs, home: home.path });
	const sent: ReviewWakeup[] = [];
	const reviews = new ReviewRuns({ home: home.path, runs, wakeup: (wakeup) => (sent.push(wakeup), true) });
	const reviewTimeoutMs = options.reviewTimeoutMs === undefined ? 20_000 : options.reviewTimeoutMs;
	const routing: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, rubric: [] };
	const gate = new Gate({
		home: home.path,
		profilesDir: PROFILES_DIR,
		briefsDir: BRIEFS_DIR,
		artifacts,
		manager,
		fleet,
		runs,
		sender,
		routing,
		probe: options.probe ?? MOCK_ONLY,
		...(options.capacity ? { capacity: options.capacity(home.path, fleet) } : {}),
		reviews,
		...(reviewTimeoutMs === null ? {} : { reviewTimeoutMs }),
		...(options.rmScratch ? { rmScratch: options.rmScratch } : {}),
	});

	t.after(async () => {
		await manager.shutdownAll();
		runs.closeAll();
		agentDir.cleanup();
		await provider.stop();
		home.cleanup();
	});

	return {
		home: home.path,
		agentDir: agentDir.path,
		provider,
		artifacts,
		fleet,
		manager,
		runs,
		gate,
		sent,
		reviews,
		routing,
		async subjectRecord(jobId, jobRouting) {
			await fleet.add({
				job_id: jobId,
				project: "demo",
				kind: "research",
				delivery: "pipeline",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "planner",
					role: "planner",
					model: "mock/planner",
					started_at: isoTimestamp(),
				},
				worktree: home.path,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
				...(jobRouting ? { routing: jobRouting } : {}),
			});
		},
		script: (name, steps, options) => provider.addScript(name, steps, options),
		seal: () => agentDir.writeModels(provider),
		writeArtifact(jobId, body?: string) {
			const path = artifacts.path(jobId);
			writeFileSync(path, body ?? "# Goal\nship it\n\n# File list\nsrc/app.ts\n");
			return path;
		},
		writeOriginalTask(jobId, body) {
			const path = join(home.path, paths.originalTaskFile(jobId));
			mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
			writeFileSync(path, body);
			return path;
		},
		async livePlanner(jobId) {
			await fleet.add({
				job_id: jobId,
				project: "demo",
				kind: "research",
				delivery: "pipeline",
				origin: DEFAULT_ORIGIN,
				phase: "held",
				reported_at: isoTimestamp(),
				worker: {
					pid: process.pid,
					session_id: "s",
					session_file: join(home.path, "s.jsonl"),
					profile: "planner",
					role: "planner",
					model: "mock/planner",
					started_at: isoTimestamp(),
				},
				worktree: home.path,
				branch: jobId,
				dispatched_at: isoTimestamp(),
				usage: EMPTY_USAGE,
			});
			const managed = manager.spawn({
				identity: { jobId, kind: "research", delivery: "pipeline", runDir: join(home.path, paths.runDir(jobId)), worktree: home.path },
				profile: loadProfile(PROFILES_DIR, "planner"),
				model: "mock/planner",
				brief: "stand by",
			});
			await managed.worker.getState(20_000);
		},
	};
}

function verdictCall(jobId: string, overrides: Partial<GateReview> = {}): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [{ name: "report_verdict", args: { ...review({ job_id: jobId, ...overrides }) } }],
		usage: { prompt_tokens: 900, completion_tokens: 40 },
	};
}

test("pass: a reviewer verdict becomes a recorded decision, and the artifact never leaves the store", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-pass";
	b.writeArtifact(jobId);
	// The isolation property ("one file, a copy, never the store") is only
	// observable *while the reviewer runs*, now that a passed attempt's scratch
	// cwd is removed afterwards (cp-yi73). So it is asserted from inside the
	// reviewer stub: this callback runs in the provider handler, mid-turn, with
	// the reviewer process alive and its cwd on disk.
	const scratch = join(b.home, paths.gateScratchDir(jobId, 1));
	const copy = join(scratch, "artifact.md");
	const seen: { entries: string[]; body: string }[] = [];
	const model = b.script("gate-pass", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_verdict",
					args: () => {
						seen.push({ entries: readdirSync(scratch), body: readFileSync(copy, "utf8") });
						return review({ job_id: jobId, reasons: ["file list is concrete", "test plan runs"] });
					},
				},
			],
			usage: { prompt_tokens: 900, completion_tokens: 40 },
		},
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });

	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.cause, null);
	assert.equal(result.next, "proceed");
	assert.equal(result.model, model);
	assert.equal(result.verdict.attempt, 1);

	// The decision is on disk, schema-valid, and readable by the next attempt.
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.verdict, "pass");
	assert.equal(readPriorAttempts(b.home, jobId).attempt, 2);

	// The reviewer's own run: its write-once verdict, its events.
	assert.ok(existsSync(join(b.home, paths.gateVerdictFile(jobId, 1))));
	assert.ok(existsSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl")));

	// While it ran, the reviewer's cwd held exactly one file, byte-identical to
	// the store's artifact — and afterwards that directory is gone, while the
	// store and the attempt's own record are untouched (cp-yi73).
	assert.equal(seen.length, 1, "the reviewer never reached its verdict tool");
	assert.deepEqual(seen[0]?.entries, ["artifact.md"]);
	assert.equal(seen[0]?.body, readFileSync(b.artifacts.file(jobId), "utf8"));
	assert.ok(!existsSync(scratch), "a passed attempt's scratch cwd is not left on disk");
	assert.ok(existsSync(b.artifacts.file(jobId)), "the store is never touched");
	assert.ok(existsSync(join(b.home, paths.gateFile(jobId, 1))));

	// The brief pointed the reviewer at the copy, never at the store or a worktree.
	const brief = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(copy));
	assert.ok(!brief.includes(b.artifacts.file(jobId)));

	// The job's own log records the outcome (never the artifact).
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /gate_decided/);
	assert.match(events, /gate_scratch_removed/, "the removal is logged, not silent");
	assert.ok(!events.includes("File list"));

	// One-shot: nothing is left running.
	assert.equal(b.manager.get(`${jobId}#gate-1`), undefined);
	assert.match(formatGate(result), /gate attempt 1: pass/);
});

test("start returns wait at once, writes pending.json, and the verdict arrives as a wake-up", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-async";
	b.writeArtifact(jobId);
	const model = b.script("gate-async", [verdictCall(jobId, { reasons: ["file list is concrete"] })]);
	b.seal();

	const started = await b.gate.start({ jobId, model, directive: "call cp_pipeline advance cp-gate-async" });
	assert.ok(isGateWait(started), `expected wait, got ${JSON.stringify(started)}`);
	assert.equal(started.attempt, 1);
	assert.equal(started.model, model);
	assert.ok(existsSync(join(b.home, paths.pendingReviewFile(jobId, "gate", 1))), "pending.json while the reviewer runs");
	assert.equal(existsSync(join(b.home, paths.gateFile(jobId, 1))), false, "no decision yet");
	assert.equal(b.sent.length, 0);

	// A second start while one is pending is refused with the pending record.
	await assert.rejects(() => b.gate.start({ jobId, model }), /already has a gate review in flight/);

	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);

	assert.equal(existsSync(join(b.home, paths.pendingReviewFile(jobId, "gate", 1))), false);
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.verdict, "pass");
	assert.equal(b.sent.length, 1);
	assert.equal(b.sent[0]?.surface, "gate");
	assert.equal(b.sent[0]?.attempt, 1);
	assert.match(b.sent[0]?.content ?? "", /gate attempt 1: pass/);
	assert.match(b.sent[0]?.content ?? "", /Next: call cp_pipeline advance cp-gate-async/);
	assert.ok(!b.sent[0]?.content.includes("ship it"), "the wake-up never carries the artifact");

	// After the decision, start returns the finished result, not another reviewer.
	const again = await b.gate.start({ jobId, model });
	assert.ok(!isGateWait(again));
	assert.equal(again.verdict.attempt, 1);
	assert.equal(again.next, "proceed");
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /review_started/);
	assert.match(events, /verdict_wakeup_sent/);
});

test(
	"cp-reviewer-routing: the gate routes on the subject's axes and spawns that model AND effort",
	{ timeout: 120_000 },
	async (t) => {
		// The defect: the gate passed routing no scope and no risk, so every reviewer
		// resolved at the standing S/low default and a row scoped to large, risky
		// work could never fire. And the resolver returned a model only, so the row's
		// effort was dropped and the worker spawned at the profile's own level.
		const b = await benchOf(t);
		const jobId = "cp-gate-routed";
		b.writeArtifact(jobId);
		const narrow = b.script("gate-narrow", [verdictCall(jobId)]);
		const broad = b.script("gate-broad", [verdictCall(jobId)]);
		b.seal();
		b.routing.rubric.push(
			{ id: "reviews-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
			{ id: "reviews-default", role: "gate-reviewer", model: broad, thinking: "low" },
		);
		await b.subjectRecord(jobId, {
			scope: "L",
			risk: "high",
			thinking: "xhigh",
			inferred: false,
			provenance: { scope: "assessed", risk: "assessed" },
		});
		const spawns = captureSpawns(b.manager);

		// No `model` on the request: routing decides, which is the whole point.
		const result = await b.gate.gateAndWait({ jobId });

		assert.equal(result.verdict.verdict, "pass");
		assert.equal(result.model, narrow, "the narrow L/high row fired, not the broad default");
		assert.equal(spawns.length, 1);
		const spawn = spawns[0];
		assert.equal(spawn?.request.model, narrow);
		assert.equal(spawn?.request.thinking, "medium", "the row's effort travels to the spawn");
		assert.equal(argOf(spawn?.args ?? [], "--model"), narrow, "and to the actual argv");
		assert.equal(argOf(spawn?.args ?? [], "--thinking"), "medium");
		assert.equal(
			loadProfile(PROFILES_DIR, "gate-reviewer").frontmatter.thinking,
			"high",
			"fixture check: the profile level the spawn must NOT have used",
		);

		// The attempt records the decision it actually spawned, once, with its inputs.
		const events = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.filter((event) => event.type === "routing_resolved");
		assert.equal(events.length, 1, "recorded once per attempt");
		assert.deepEqual(events[0]?.payload, {
			surface: "gate",
			attempt: 1,
			model: narrow,
			source: "rubric",
			rule: "reviews-large",
			thinking: "medium",
			scope: "L",
			risk: "high",
			provenance: { scope: "inherited", risk: "inherited" },
			subject_provenance: { scope: "assessed", risk: "assessed" },
			line: `source=rubric model=${narrow} rule=reviews-large thinking=medium`,
		});
	},
);

test("high-risk gate reviewer chooses scored eligible provider and records its decision", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t, { probe: { isAvailable: (model) => model.startsWith("mock/") || model.startsWith("mock2/") }, capacity: (home, fleet) => new CapacityReader({ home, fleet, env: { CP_GATEWAY_ADMIN_KEY: "test-only" }, fetch: async () => Response.json({
		code: 0, message: "success", data: { enabled: true, timestamp: "2026-09-25T00:00:00Z", platform: {
			mock: { max_capacity: 4, current_in_use: 4, waiting_in_queue: 0 }, mock2: { max_capacity: 8, current_in_use: 0, waiting_in_queue: 0 },
		} },
	}) }) });
	const jobId = "cp-gate-capacity";
	b.writeArtifact(jobId);
	const main = b.script("gate-cap-main", [verdictCall(jobId)]);
	const other = b.script("gate-cap-other", [verdictCall(jobId)]).replace(/^.*\//, "mock2/");
	b.seal();
	const file = join(b.agentDir, "models.json");
	const catalog = JSON.parse(readFileSync(file, "utf8"));
	catalog.providers.mock2 = { ...catalog.providers.mock };
	writeFileSync(file, JSON.stringify(catalog));
	mkdirSync(join(b.home, LAYOUT.data), { recursive: true });
	writeFileSync(join(b.home, LAYOUT.data, "capacity.json"), JSON.stringify({ url: "https://gateway.example", path: "/capacity" }));
	b.routing.rubric.push({ id: "reviews-high", role: "gate-reviewer", risk: "high", model: main, fallbacks: [other], thinking: "low" });
	await b.subjectRecord(jobId, { scope: "L", risk: "high", inferred: false });
	const spawns = captureSpawns(b.manager);
	const result = await b.gate.gateAndWait({ jobId });
	assert.equal(result.model, other);
	assert.equal(argOf(spawns[0]?.args ?? [], "--model"), other);
	const event = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl"), "utf8")
		.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
		.find((entry) => entry.type === "routing_resolved")?.payload;
	assert.deepEqual(event?.capacity, { source: "admin", scores: [{ provider: "mock", score: 0 }, { provider: "mock2", score: 8 }] });
	assert.match(String(event?.line), /capacity=admin:mock=0,mock2=8/);
});

test(
	"pi-command-post-0a9: the gate reviewer spawns the fallback candidate; an override still refuses",
	{ timeout: 120_000 },
	async (t) => {
		const b = await benchOf(t);
		const jobId = "cp-gate-fallback";
		b.writeArtifact(jobId);
		const spare = b.script("gate-spare", [verdictCall(jobId)]);
		b.seal();
		// `unauth/opus` is in nobody's registry here (MOCK_ONLY authenticates `mock/`
		// only): the preferred candidate is unusable, exactly as it is on a machine
		// where that provider is not authenticated.
		b.routing.rubric.push({
			id: "reviews",
			role: "gate-reviewer",
			model: "unauth/opus",
			fallbacks: [spare],
			thinking: "low",
		});
		await b.subjectRecord(jobId);
		const spawns = captureSpawns(b.manager);

		const result = await b.gate.gateAndWait({ jobId });

		assert.equal(result.verdict.verdict, "pass");
		assert.equal(result.model, spare, "the review ran, on the candidate that was reachable");
		assert.equal(argOf(spawns[0]?.args ?? [], "--model"), spare);
		assert.equal(argOf(spawns[0]?.args ?? [], "--thinking"), "low", "the row's effort is not substituted");

		const payload = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.find((event) => event.type === "routing_resolved")?.payload;
		assert.deepEqual(payload?.attempted, [{ model: "unauth/opus", refusal: "availability" }]);
		assert.match(String(payload?.line), /attempted=unauth\/opus\(availability\)/);

		// A reviewer model the operator named is not a candidate list: it is refused,
		// before the reviewer is spawned, whatever the row could have fallen back to.
		const named = "cp-gate-override";
		b.writeArtifact(named);
		await b.subjectRecord(named);
		await assert.rejects(() => b.gate.gateAndWait({ jobId: named, model: "unauth/opus" }), /no available model/);
	},
);

test(
	"cp-reviewer-routing: a legacy subject with no recorded routing is unknown, never a measured S/low",
	{ timeout: 120_000 },
	async (t) => {
		const b = await benchOf(t);
		const jobId = "cp-gate-legacy";
		b.writeArtifact(jobId);
		const narrow = b.script("gate-legacy-narrow", [verdictCall(jobId)]);
		const broad = b.script("gate-legacy-broad", [verdictCall(jobId)]);
		b.seal();
		b.routing.rubric.push(
			{ id: "reviews-large", role: "gate-reviewer", scope: ["L"], risk: "high", model: narrow, thinking: "medium" },
			{ id: "reviews-default", role: "gate-reviewer", model: broad, thinking: "low" },
		);
		// A job dispatched before `routing` was recorded: no axes at all.
		await b.subjectRecord(jobId);
		const spawns = captureSpawns(b.manager);

		const result = await b.gate.gateAndWait({ jobId });

		// The fallback is the documented default (S/low → the broad row), and it is
		// legible: the record says unknown, and claims no measurement.
		assert.equal(result.model, broad);
		assert.equal(spawns[0]?.request.thinking, "low");
		const payload = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> })
			.find((event) => event.type === "routing_resolved")?.payload;
		assert.deepEqual(payload?.provenance, { scope: "unknown", risk: "unknown" });
		assert.equal(payload?.scope, undefined, "an unknown axis is absent, not defaulted into the record");
		assert.equal(payload?.risk, undefined);
	},
);

test("status reads pending and decided attempts from disk, changing nothing", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-status";
	b.writeArtifact(jobId);
	const model = b.script("gate-status", [verdictCall(jobId, { reasons: ["ok"] })]);
	b.seal();
	assert.deepEqual(b.gate.status(jobId), { decisions: [] });
	const started = await b.gate.start({ jobId, model });
	assert.ok(isGateWait(started));
	assert.equal(b.gate.status(jobId).pending?.attempt, 1);
	b.reviews.handBack(started.key);
	await b.reviews.settled(started.key);
	const after = b.gate.status(jobId);
	assert.equal(after.pending, undefined);
	assert.equal(after.decisions.length, 1);
});

test("orphan: an attempt with no reviewer is decided operational and the ladder says retry", async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-orphan";
	b.writeArtifact(jobId);
	const pending = {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		surface: "gate" as const,
		attempt: 1,
		model: "mock/gone",
		pid: 999_999,
		started_at: isoTimestamp(),
		deadline: isoTimestamp(),
		handed_back: true,
	};
	const wakeup = await b.gate.orphan(pending, "reviewer lost with the parent session");
	assert.ok(wakeup);
	assert.match(wakeup.content, /escalate \(cause: operational\)/);
	assert.match(wakeup.content, /-> retry/);
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.cause, "operational");
	assert.ok(decision.reasons.some((reason) => reason.includes("reviewer lost with the parent session")));
});

test("removeGateScratch removes only the reviewer's own cwd, and refuses every near miss", () => {
	const home = mkdtempSync(join(tmpdir(), "cp-gate-scratch-"));
	try {
		const dir = join(home, paths.gateScratchDir("cp-guard", 1));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "artifact.md"), "# Goal\nx\n");
		let rmCalls: string[] = [];
		const rm = (target: string) => {
			rmCalls.push(target);
			rmSync(target, { recursive: true, force: true });
		};

		// The reported hazard: an id or attempt that could collapse the path toward
		// `state/runs/` never produces a path at all.
		for (const jobId of ["", ".", "..", "../..", "cp/../..", "-cp", "cp guard"]) {
			const removal = removeGateScratch({ home, jobId, attempt: 1, rm });
			assert.equal(removal.removed, false, `removed for ${JSON.stringify(jobId)}`);
			assert.equal(removal.reason, "unsafe_id");
		}
		for (const attempt of [0, -1, 1.5, Number.NaN]) {
			assert.equal(removeGateScratch({ home, jobId: "cp-guard", attempt, rm }).reason, "unsafe_id");
		}

		// A path that escapes `home`, and one whose final segment is not `review`:
		// both refuse, and `rm` is never reached.
		const outside = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm, scratchDir: () => "../../review" });
		assert.deepEqual([outside.removed, outside.reason], [false, "outside_home"]);
		const homeItself = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm, scratchDir: () => "." });
		assert.deepEqual([homeItself.removed, homeItself.reason], [false, "outside_home"]);
		const wrongSegment = removeGateScratch({
			home,
			jobId: "cp-guard",
			attempt: 1,
			rm,
			// `gate-1` itself: brief.md, events.jsonl and verdict.json live there.
			scratchDir: paths.gateRunDir,
		});
		assert.deepEqual([wrongSegment.removed, wrongSegment.reason], [false, "unexpected_segment"]);
		assert.deepEqual(rmCalls, [], "a refused removal never calls rm");
		assert.ok(existsSync(join(dir, "artifact.md")), "and nothing on disk moved");
		assert.ok(existsSync(join(home, paths.gateRunDir("cp-guard", 1))));

		// The one path it does take.
		const removed = removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm });
		assert.deepEqual([removed.removed, removed.reason], [true, "removed"]);
		assert.deepEqual(rmCalls, [dir]);
		assert.ok(!existsSync(dir));
		assert.ok(existsSync(join(home, paths.gateRunDir("cp-guard", 1))), "the run's own record survives");

		// Idempotent: a second call is `absent`, not an error and not a wider rm.
		rmCalls = [];
		assert.equal(removeGateScratch({ home, jobId: "cp-guard", attempt: 1, rm }).reason, "absent");
		assert.deepEqual(rmCalls, []);

		// A removal that throws is reported, never propagated.
		mkdirSync(dir, { recursive: true });
		const failed = removeGateScratch({
			home,
			jobId: "cp-guard",
			attempt: 1,
			rm: () => {
				throw new Error("EBUSY: device or resource busy");
			},
		});
		assert.deepEqual([failed.removed, failed.reason], [false, "failed"]);
		assert.match(String(failed.error), /EBUSY/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a scratch removal that fails changes nothing about the verdict", { timeout: 120_000 }, async (t) => {
	const attempted: string[] = [];
	const b = await benchOf(t, {
		rmScratch: (dir) => {
			attempted.push(dir);
			throw new Error("EPERM: operation not permitted");
		},
	});
	const jobId = "cp-gate-rm-fails";
	b.writeArtifact(jobId);
	const model = b.script("gate-rm-fails", [verdictCall(jobId, { reasons: ["file list is concrete"] })]);
	b.seal();

	// A gate that escalated because a directory could not be removed would be a
	// worse bug than the disk usage it was cleaning up.
	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass");
	assert.equal(result.verdict.cause, null);
	assert.equal(result.next, "proceed");
	const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
	assert.equal(decision.verdict, "pass");

	// It was tried, on the right path, and the failure is on the record.
	assert.deepEqual(attempted, [join(b.home, paths.gateScratchDir(jobId, 1))]);
	assert.ok(existsSync(join(b.home, paths.gateScratchDir(jobId, 1), "artifact.md")), "a failed removal leaves the copy");
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /gate_scratch_removed/);
	assert.match(events, /EPERM/);
});

test("revise: the verdict is promoted to the still-live planner, once", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-revise";
	b.writeArtifact(jobId);
	const first = b.script("gate-revise-1", [
		verdictCall(jobId, { verdict: "revise", reasons: ["test plan is not runnable"], revisions: ["name the exact commands"] }),
	]);
	const second = b.script("gate-revise-2", [
		verdictCall(jobId, { verdict: "revise", reasons: ["still not runnable"], revisions: ["again"] }),
	]);
	// The planner just stays alive and idle: the promote's receipt is the fact
	// under test, not what the model does with it.
	b.script("planner", [{ kind: "text", text: "standing by" }], { onExhausted: "repeat" });
	b.seal();
	await b.livePlanner(jobId);

	const result = await b.gate.gateAndWait({ jobId, model: first });
	assert.equal(result.verdict.verdict, "revise");
	assert.equal(result.next, "revise");
	assert.deepEqual(result.verdict.revisions, ["name the exact commands"]);
	assert.equal(result.revise_receipt, "delivered", `revise not delivered: ${result.revise_error}`);
	assert.equal(result.revise_error, undefined);

	// The promote is on the planner's run log as a receipt, not as a payload:
	// the log records that a message was delivered, never its text.
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.match(events, /"type":"prompt_sent","payload":\{"receipt":"delivered"/);
	assert.ok(!events.includes("name the exact commands"));

	// Second attempt: the cap is policy, and it is enforced here, not by a model.
	const capped = await b.gate.gateAndWait({ jobId, model: second });
	assert.equal(capped.verdict.attempt, 2);
	assert.equal(capped.verdict.verdict, "escalate");
	assert.equal(capped.verdict.cause, "policy");
	assert.equal(capped.next, "surface");
	assert.equal(capped.revise_receipt, undefined, "an escalate is never promoted");

	// Neither attempt passed, so both keep the bytes they were judging: after a
	// revise the store has moved on, and this copy is the only record of what
	// attempt 1 saw (cp-yi73).
	for (const attempt of [1, 2]) {
		assert.ok(
			statSync(join(b.home, paths.gateScratchDir(jobId, attempt), "artifact.md")).size > 0,
			`attempt ${attempt}'s evidence was removed`,
		);
	}
});

test("flags: a reviewer pass with a flag is escalated FLAGGED, and may still be authorized", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-flag";
	b.writeArtifact(jobId);
	const model = b.script("gate-flag", [
		verdictCall(jobId, { verdict: "pass", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: ["plan drops a table"] }),
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "escalate");
	assert.equal(result.verdict.cause, "flagged");
	assert.equal(result.verdict.flags.destructive_scope, true);
	assert.equal(result.next, "authorize", "a reviewer-sound plan escalated only on flags may still reach a checkpoint");
});

test(
	"flags: a reviewer pass with blocking_unknowns passes, and the flag round-trips onto disk (cp-unknowns-no-veto)",
	{ timeout: 120_000 },
	async (t) => {
		const b = await benchOf(t);
		const jobId = "cp-gate-unknowns";
		b.writeArtifact(jobId);
		const model = b.script("gate-unknowns", [
			verdictCall(jobId, {
				verdict: "pass",
				flags: { ...NO_FLAGS, blocking_unknowns: true },
				reasons: ["the hub itself is deferred to cp-b1"],
			}),
		]);
		b.seal();

		const result = await b.gate.gateAndWait({ jobId, model });
		assert.equal(result.verdict.verdict, "pass");
		assert.equal(result.verdict.cause, null);
		assert.equal(result.next, "proceed", "deferring work to a sibling ticket is not an escalate");

		// The observation is not lost by not being a veto: the persisted decision
		// carries the flag and its explanatory line.
		const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
		assert.equal(decision.flags.blocking_unknowns, true);
		assert.ok(decision.reasons.includes("the hub itself is deferred to cp-b1"));
		assert.ok(decision.reasons.some((reason) => reason.includes("flag reported, no veto: blocking_unknowns")));
		assert.ok(validate<GateVerdict>(GateVerdictSchema, decision).ok);
	},
);

test(
	"a reviewer at the schema's own reasons cap still produces a gateable decision, and the raw overflow is recoverable (cp-yg2)",
	{ timeout: 120_000 },
	async (t) => {
		const b = await benchOf(t);
		const jobId = "cp-gate-cap-overflow";
		b.writeArtifact(jobId);
		// The reviewer's own reasons array is already at the schema's max
		// (GateReviewSchema allows no more) — valid on its own. The flag then
		// forces the parent to append its own "flag forced escalate" reason on
		// top, which is exactly the shape that made cp-yg2 ungateable: the
		// resulting array is one item over what GateVerdictSchema allows.
		const maxed = Array.from({ length: GATE_REASONS_MAX_ITEMS }, (_unused, index) => `reviewer reason ${index}`);
		const model = b.script("gate-cap-overflow", [
			verdictCall(jobId, { verdict: "pass", flags: { ...NO_FLAGS, destructive_scope: true }, reasons: maxed }),
		]);
		b.seal();

		const result = await b.gate.gateAndWait({ jobId, model });

		// A usable, schema-valid verdict — the job is gateable.
		assert.equal(result.verdict.verdict, "escalate");
		assert.equal(result.verdict.cause, "flagged");
		assert.ok(result.verdict.reasons.length <= GATE_REASONS_MAX_ITEMS);
		assert.ok(
			result.verdict.reasons.some((r) => r.includes("dropped")),
			"the operator must be able to tell truncation happened",
		);

		// The canonical decision is on disk and schema-valid.
		const decision = JSON.parse(readFileSync(join(b.home, paths.gateFile(jobId, 1)), "utf8")) as GateVerdict;
		assert.ok(decision.reasons.length <= GATE_REASONS_MAX_ITEMS);

		// The full, uncapped decision is recoverable from the run directory.
		const rawPath = join(b.home, paths.gateFileRaw(jobId, 1));
		assert.ok(existsSync(rawPath), "the pre-cap decision must survive on disk");
		const raw = JSON.parse(readFileSync(rawPath, "utf8")) as GateVerdict;
		assert.ok(raw.reasons.length > GATE_REASONS_MAX_ITEMS, "the raw copy keeps every reason, uncapped");
		assert.ok(raw.reasons.some((r) => r.includes("flag forced escalate")));
		for (const reason of maxed) assert.ok(raw.reasons.includes(reason), `raw decision lost reason: ${reason}`);
	},
);

test("flags: a reviewer's own escalate with a flag stays policy, unauthorizable", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-flag-policy";
	b.writeArtifact(jobId);
	const model = b.script("gate-flag-policy", [
		verdictCall(jobId, {
			verdict: "escalate",
			flags: { ...NO_FLAGS, destructive_scope: true },
			reasons: ["the plan itself drops the wrong table"],
		}),
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "escalate");
	assert.equal(result.verdict.cause, "policy", "the reviewer's own escalate is a disputed plan, not a flagged-but-sound one");
	assert.equal(result.next, "surface");
});

test("operational ladder: no verdict -> retry -> surface, bounded at two", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-op";
	b.writeArtifact(jobId);
	// A reviewer that talks instead of reporting: no verdict file, ever.
	const silent = b.script("gate-silent", [{ kind: "text", text: "I think the artifact is fine." }]);
	b.seal();

	const first = await b.gate.gateAndWait({ jobId, model: silent });
	assert.equal(first.verdict.verdict, "escalate");
	assert.equal(first.verdict.cause, "operational");
	assert.equal(first.next, "retry", "an operational fault is retried, not surfaced");
	assert.match(first.verdict.reasons.join(" "), /settled without reporting a verdict/);

	// cp-eff removed the fallback ladder, so the retry re-runs the SAME model —
	// right for a transient fault, and bounded: a second operational fault is
	// `operational_persistent` and goes to a human instead of looping.
	const second = await b.gate.gateAndWait({ jobId, model: silent });
	assert.equal(second.model, first.model, "there is no second list of models to walk");
	assert.equal(second.verdict.cause, "operational_persistent");
	assert.equal(second.next, "surface");
	assert.equal(second.verdict.attempt, 2);
});

test(
	"data/gate.json is read per attempt: an operator edit reaches the very next review, no restart",
	{ timeout: 120_000 },
	async (t) => {
		// No `reviewTimeoutMs` on this Gate: the timeout must come from disk, the
		// same wiring `CommandPost.gateModule()` uses.
		const b = await benchOf(t, { reviewTimeoutMs: null });
		const jobId = "cp-gate-timeout-cfg";
		b.writeArtifact(jobId);
		// Two separate scripts: each `hang` step is consumed the instant it is
		// requested (before it ever answers), so attempt 2 needs its own model —
		// reusing attempt 1's would hit an exhausted script instead of a hang.
		const hang1 = b.script("gate-hang-1", [{ kind: "hang" }]);
		const hang2 = b.script("gate-hang-2", [{ kind: "hang" }]);
		b.seal();

		const gateConfigFile = join(b.home, LAYOUT.gateConfigFile);
		mkdirSync(join(b.home, LAYOUT.data), { recursive: true });
		writeFileSync(gateConfigFile, JSON.stringify({ schema_version: SCHEMA_VERSION, review_timeout_ms: 1_000 }));

		const first = await b.gate.gateAndWait({ jobId, model: hang1 });
		assert.equal(first.verdict.cause, "operational");
		assert.match(
			first.verdict.reasons.join(" "),
			/did not report a verdict within 1000ms/,
			"attempt 1 used the 1000ms configured on disk",
		);

		// The operator edits the config between attempts — no parent restart, no
		// new Gate instance (this is the same `b.gate`, exactly like a pipeline's
		// operational retry re-runs on the live Gate).
		writeFileSync(gateConfigFile, JSON.stringify({ schema_version: SCHEMA_VERSION, review_timeout_ms: 2_500 }));

		const second = await b.gate.gateAndWait({ jobId, model: hang2 });
		assert.equal(second.verdict.cause, "operational_persistent");
		assert.match(
			second.verdict.reasons.join(" "),
			/did not report a verdict within 2500ms/,
			"attempt 2 used the 2500ms just written to data/gate.json, not attempt 1's 1000ms and not the 300000ms default",
		);
	},
);

test("an unparseable verdict is operational, not a judgment", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-bad";
	b.writeArtifact(jobId);
	// Wrong job id every time: the in-worker repair cap is spent, and the
	// worker writes verdict-rejected.json instead of a verdict.
	const bad = { job_id: "cp-someone-else", verdict: "pass", flags: NO_FLAGS, reasons: ["ok"] };
	const model = b.script("gate-bad", [
		{ kind: "tool_calls", calls: [{ name: "report_verdict", args: bad }] },
		{ kind: "tool_calls", calls: [{ name: "report_verdict", args: bad }] },
		{ kind: "tool_calls", calls: [{ name: "report_verdict", args: bad }] },
		{ kind: "text", text: "giving up" },
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.cause, "operational");
	assert.match(result.verdict.reasons.join(" "), /repairs|verdict/);
	assert.ok(existsSync(join(b.home, paths.gateRunDir(jobId, 1), "verdict-rejected.json")));
});

test("no artifact is a refusal, not an escalate", { timeout: 60_000 }, async (t) => {
	const b = await benchOf(t);
	b.seal();
	await assert.rejects(() => b.gate.gateAndWait({ jobId: "cp-gate-none" }), /no artifact for cp-gate-none/);
	assert.equal(existsSync(join(b.home, paths.gateFile("cp-gate-none", 1))), false);
});

// ---------------------------------------------------------------------------
// do8.3: the reviewer scores the plan against the ORIGINAL task, not against
// the planner's restatement of it.
// ---------------------------------------------------------------------------

/** The original task these tests freeze: three numbered requirements. */
const TASK = [
	"Rework the retry ladder.",
	"",
	"1. Retries must be bounded at three attempts.",
	"2. A budget breach must escalate to the operator.",
	"3. The ladder must survive a parent restart.",
].join("\n");

/** An artifact covering exactly the requirements listed. */
function planFor(covered: readonly number[]): string {
	const steps: Record<number, string> = {
		1: "cap attempts at three in src/failures.ts",
		2: "escalate a budget breach to the operator in src/send.ts",
		3: "read prior attempts from disk in src/gate.ts",
	};
	return [
		"## Goal",
		"Make the ladder better.", // deliberately a restatement, not the task
		"",
		"## File list",
		...covered.map((requirement) => `- ${steps[requirement]}`),
		"",
		"## Test plan",
		...covered.map((requirement) => `- npm test proves requirement ${requirement}`),
		"",
	].join("\n");
}

/**
 * A deterministic "reviewer": it reads the two files the gate put in its cwd
 * and returns `revise` for every requirement of the ORIGINAL task the artifact
 * does not cover. The model is canned, the review input is real — which is the
 * property under test: without the original task in the bounded input, this
 * reviewer cannot compute a coverage gap at all.
 */
function coverageReviewer(scratch: string, jobId: string): ScriptStep {
	return {
		kind: "tool_calls",
		calls: [
			{
				name: "report_verdict",
				args: () => {
					const task = readFileSync(join(scratch, ORIGINAL_TASK_COPY), "utf8");
					const artifact = readFileSync(join(scratch, "artifact.md"), "utf8");
					const missing = [...task.matchAll(/^(\d+)\. (.+)$/gm)]
						.filter(([, number]) => !artifact.includes(`requirement ${number}`))
						.map(([, number, text]) => `requirement coverage: the plan does not cover "${text}" (task item ${number})`);
					if (missing.length === 0) {
						return review({ job_id: jobId, reasons: ["requirement coverage: every task item maps to a file and a test"] });
					}
					return review({ job_id: jobId, verdict: "revise", reasons: missing, revisions: missing });
				},
			},
		],
		usage: { prompt_tokens: 900, completion_tokens: 40 },
	};
}

test("an artifact that omits one original requirement is revised; the complete one passes", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);

	// Same task, same reviewer, two artifacts. The incomplete one is internally
	// consistent and its Goal claims success: only the original task shows the gap.
	const omitted = "cp-gate-omits";
	b.writeOriginalTask(omitted, TASK);
	b.writeArtifact(omitted, planFor([1, 3]));
	const omittedModel = b.script("gate-omits", [coverageReviewer(join(b.home, paths.gateScratchDir(omitted, 1)), omitted)]);

	const complete = "cp-gate-covers";
	b.writeOriginalTask(complete, TASK);
	b.writeArtifact(complete, planFor([1, 2, 3]));
	const completeModel = b.script("gate-covers", [coverageReviewer(join(b.home, paths.gateScratchDir(complete, 1)), complete)]);
	b.seal();

	const gap = await b.gate.gateAndWait({ jobId: omitted, model: omittedModel, deliverRevise: false });
	assert.equal(gap.verdict.verdict, "revise", "a silently omitted requirement must not pass");
	assert.equal(gap.next, "revise");
	assert.match(gap.verdict.revisions?.join(" ") ?? "", /budget breach must escalate to the operator/);

	const ok = await b.gate.gateAndWait({ jobId: complete, model: completeModel });
	assert.equal(ok.verdict.verdict, "pass", "a complete artifact can still pass");
	assert.equal(ok.next, "proceed");
});

test("the frozen task reaches the reviewer as a file; its body never reaches the brief", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-taskfile";
	// A task that legitimately quotes credential-shaped text (cp-n7w's shape): it
	// must still reach the reviewer, which it can only do as a file — inlining it
	// into the brief would trip `assertBriefIsSafe` and refuse the spawn.
	const secretish = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const task = `${TASK}\n\nMeasured during research: ${secretish}\n`;
	b.writeOriginalTask(jobId, task);
	b.writeArtifact(jobId, planFor([1, 2, 3]));

	const scratch = join(b.home, paths.gateScratchDir(jobId, 1));
	const seen: { entries: string[]; task: string }[] = [];
	const model = b.script("gate-taskfile", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_verdict",
					args: () => {
						seen.push({ entries: readdirSync(scratch).sort(), task: readFileSync(join(scratch, ORIGINAL_TASK_COPY), "utf8") });
						return review({ job_id: jobId, reasons: ["requirement coverage: every task item is mapped"] });
					},
				},
			],
			usage: { prompt_tokens: 900, completion_tokens: 40 },
		},
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass");

	// The bounded review input: exactly two files, and the task copy is byte-identical.
	assert.equal(seen.length, 1, "the reviewer never reached its verdict tool");
	assert.deepEqual(seen[0]?.entries, ["artifact.md", ORIGINAL_TASK_COPY]);
	assert.equal(seen[0]?.task, task);

	// The brief names the copy and carries none of its body — which is what keeps
	// the credential guard scanning hand-written brief text only.
	const brief = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(join(scratch, ORIGINAL_TASK_COPY)), "the brief points at the task copy");
	assert.ok(!brief.includes(secretish), "the task body never reaches the brief");
	assert.ok(!brief.includes("Retries must be bounded"), "the task body never reaches the brief");
	assert.match(brief, /never the source of truth/, "the brief says the artifact's Goal is a restatement");
	const profile = loadProfile(PROFILES_DIR, "gate-reviewer");
	assert.equal(brief, assembleBrief({
		profile, template: readBriefTemplate(BRIEFS_DIR, profile.frontmatter.briefTemplate),
		values: { job_id: jobId, project: "unregistered", artifact_path: join(scratch, "artifact.md"), original_task: originalTaskBlock(join(scratch, ORIGINAL_TASK_COPY)) },
	}), "no addenda produces the identical pre-amendment brief");

	// The frozen original is untouched, and the whole scratch cwd (task copy
	// included) is removed on a pass, exactly as before (cp-yi73).
	assert.equal(readFileSync(join(b.home, paths.originalTaskFile(jobId)), "utf8"), task);
	assert.ok(!existsSync(scratch));

	// The job's own log still never carries either body.
	const events = readFileSync(join(b.home, paths.eventsFile(jobId)), "utf8");
	assert.ok(!events.includes(secretish));
});

test("the gate brief includes authorized addenda with provenance beside the original task", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-addenda";
	b.writeOriginalTask(jobId, TASK);
	b.writeArtifact(jobId, planFor([1, 2, 3]));
	const addenda = [1, 2].map((n) => ({ schema_version: 1, n, added_at: "2026-09-24T10:00:00Z", by: "operator-quote", quote: "approved", reason: "coverage", text: `Extra scope ${n}.` }));
	writeFileSync(join(b.home, paths.taskAddendaFile(jobId)), addenda.map((row) => JSON.stringify(row) + "\n").join(""));
	const model = b.script("gate-addenda", [verdictCall(jobId, { verdict: "revise", revisions: ["cover the amendment"] })]);
	b.seal();
	await b.gate.gateAndWait({ jobId, model, deliverRevise: false });
	const scratch = join(b.home, paths.gateScratchDir(jobId, 1));
	const brief = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "brief.md"), "utf8");
	assert.ok(brief.includes(join(scratch, ORIGINAL_TASK_COPY)));
	assert.ok(brief.includes(join(scratch, "task-addenda.md")));
	assert.match(brief, /Addendum 1 \(operator-quote, 2026-09-24T10:00:00Z\)/);
	assert.match(brief, /authorized scope/);
	assert.match(brief, /not their presence as scope growth/);
	assert.ok(brief.indexOf("Addendum 1") < brief.indexOf("Addendum 2"));
	const body = readFileSync(join(scratch, "task-addenda.md"), "utf8");
	assert.match(body, /Extra scope 1\./);
	assert.match(body, /Extra scope 2\./);
	assert.match(body, /Quote: "approved"/);
	assert.ok(!brief.includes("Extra scope 1."));
});

test("a job with no frozen task is reviewed artifact-only, and the brief says so", { timeout: 120_000 }, async (t) => {
	const b = await benchOf(t);
	const jobId = "cp-gate-notask";
	b.writeArtifact(jobId);
	const scratch = join(b.home, paths.gateScratchDir(jobId, 1));
	const seen: string[][] = [];
	const model = b.script("gate-notask", [
		{
			kind: "tool_calls",
			calls: [
				{
					name: "report_verdict",
					args: () => {
						seen.push(readdirSync(scratch).sort());
						return review({ job_id: jobId });
					},
				},
			],
			usage: { prompt_tokens: 900, completion_tokens: 40 },
		},
	]);
	b.seal();

	const result = await b.gate.gateAndWait({ jobId, model });
	assert.equal(result.verdict.verdict, "pass", "a missing freeze is not an operational fault");
	assert.deepEqual(seen[0], ["artifact.md"]);
	const brief = readFileSync(join(b.home, paths.gateRunDir(jobId, 1), "brief.md"), "utf8");
	assert.match(brief, /Original task: not available/);
	assert.ok(!brief.includes("${"), "no unsubstituted placeholder reaches a reviewer");
});

test("originalTaskBlock is a pointer and a boundary, never a body", (t) => {
	const home = createScratchHome();
	t.after(home.cleanup);
	const jobId = "cp-gate-block";
	const scratch = join(home.path, paths.gateScratchDir(jobId, 1));
	mkdirSync(scratch, { recursive: true });

	// Nothing frozen: no copy, and the brief block states the absence.
	assert.equal(copyOriginalTask({ home: home.path, jobId, scratch }), undefined);
	assert.match(originalTaskBlock(undefined), /Original task: not available/);

	// An empty freeze is no freeze: an empty file would otherwise make every
	// requirement "uncovered" against a task nobody wrote.
	mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });
	writeFileSync(join(home.path, paths.originalTaskFile(jobId)), "");
	assert.equal(copyOriginalTask({ home: home.path, jobId, scratch }), undefined);

	writeFileSync(join(home.path, paths.originalTaskFile(jobId)), TASK);
	const copied = copyOriginalTask({ home: home.path, jobId, scratch });
	assert.equal(copied, join(scratch, ORIGINAL_TASK_COPY));
	assert.equal(readFileSync(copied as string, "utf8"), TASK);

	const block = originalTaskBlock(copied);
	assert.ok(block.includes(copied as string), "the block names the path");
	assert.ok(!block.includes("Retries must be bounded"), "the block never carries the body");
	assert.match(block, /never the source of truth/);
});

test("copyOriginalTask bounds the packet: an oversized task is cut on a line, and the cut is stated (do8.4)", (t) => {
	const home = createScratchHome();
	t.after(home.cleanup);
	const jobId = "cp-gate-bound";
	const scratch = join(home.path, paths.gateScratchDir(jobId, 1));
	mkdirSync(scratch, { recursive: true });
	mkdirSync(join(home.path, paths.runDir(jobId)), { recursive: true });

	const tail = "the last requirement nobody will see";
	const body = `${"requirement line\n".repeat(200)}${tail}\n`;
	writeFileSync(join(home.path, paths.originalTaskFile(jobId)), body);

	// Under the cap: copied whole, byte for byte.
	assert.equal(readFileSync(copyOriginalTask({ home: home.path, jobId, scratch }) as string, "utf8"), body);

	// Over it: the head that fits, whole lines only, plus a note naming the loss.
	const copied = copyOriginalTask({ home: home.path, jobId, scratch, maxBytes: 100 }) as string;
	const text = readFileSync(copied, "utf8");
	assert.ok(!text.includes(tail), "nothing past the cap is shown");
	assert.ok(text.startsWith("requirement line\n"), "the head is copied unaltered");
	assert.ok(!/requirement li$/m.test(text.split("\n\n")[0] as string), "the cut lands on a line boundary");
	assert.match(text, /bounded review packet/);
	assert.match(text, new RegExp(`of ${Buffer.byteLength(body, "utf8")} bytes`), "the note names the real size");

	// The default is the contract's, not a per-call guess.
	assert.equal(REVIEW_ORIGINAL_TASK_MAX_BYTES, 100_000);
});

// ---------------------------------------------------------------------------
// `awaitVerdict` (cp-x78): event-driven wake, with a long-interval backstop
// poll underneath. A fake worker exercises the `VerdictWorker` surface
// directly — no real process, no MockProvider — so the event path and the
// poll path are each individually observable.
// ---------------------------------------------------------------------------

class FakeVerdictWorker {
	#listeners = new Set<(event: { type: string; toolName?: string }) => void>();
	#closeResolve!: () => void;
	readonly closed: Promise<unknown>;

	constructor() {
		this.closed = new Promise<void>((resolve) => {
			this.#closeResolve = resolve;
		});
	}

	onEvent(listener: (event: { type: string; toolName?: string }) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: { type: string; toolName?: string }): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	close(): void {
		this.#closeResolve();
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}
}

function verdictRecord(jobId: string): VerdictRecord {
	return {
		schema_version: SCHEMA_VERSION,
		job_id: jobId,
		received_at: isoTimestamp(),
		attempt: 1,
		review: review({ job_id: jobId }),
	};
}

function awaitVerdictFiles(
	t: { after(fn: () => void | Promise<void>): void },
	prefix: string,
): { verdictFile: string; rejectedFile: string } {
	const dir = join(tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { verdictFile: join(dir, "verdict.json"), rejectedFile: join(dir, "verdict-rejected.json") };
}

test("awaitVerdict: a verdict file plus the verdict tool's tool_execution_end resolves without waiting for the backstop poll", async (t) => {
	const jobId = "cp-await-event";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-event");
	const worker = new FakeVerdictWorker();
	const record = verdictRecord(jobId);

	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

	// The reviewer writes its verdict, then reports through its terminating
	// tool — the same order the real worker uses.
	writeFileSync(verdictFile, JSON.stringify(record));
	worker.emit({ type: "tool_execution_end", toolName: "report_verdict" });

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.deepEqual(result.review, record.review);
	assert.ok(
		elapsed < BACKSTOP_POLL_INTERVAL_MS / 2,
		`expected the tool_execution_end event to wake the wait well under the ${BACKSTOP_POLL_INTERVAL_MS}ms backstop, took ${elapsed}ms`,
	);
	assert.equal(worker.listenerCount, 0, "the event listener must be removed once the wait resolves");
});

test(
	"awaitVerdict: tool_execution_end for a different tool is ignored — the verdict-tool filter actually filters",
	async (t) => {
		const jobId = "cp-await-wrong-tool";
		const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-wrong-tool");
		const worker = new FakeVerdictWorker();
		const record = verdictRecord(jobId);

		const start = Date.now();
		const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

		// The verdict file already exists, so a listener that failed to filter by
		// tool name would wake and resolve on this event immediately. It must not:
		// only the backstop poll may find the file from here.
		writeFileSync(verdictFile, JSON.stringify(record));
		worker.emit({ type: "tool_execution_end", toolName: "some_other_tool" });

		const result = await promise;
		const elapsed = Date.now() - start;
		assert.deepEqual(result.review, record.review);
		assert.ok(
			elapsed >= BACKSTOP_POLL_INTERVAL_MS - 100,
			`expected the mismatched tool event to be ignored, resolving only via the backstop poll (~${BACKSTOP_POLL_INTERVAL_MS}ms), took ${elapsed}ms`,
		);
		assert.equal(worker.listenerCount, 0);
	},
);

test(
	"awaitVerdict: an early tool_execution_end (the .tmp-rename race) never throws, and the verdict is still found once the file lands",
	async (t) => {
		const jobId = "cp-await-early-event";
		const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-early-event");
		const worker = new FakeVerdictWorker();
		const record = verdictRecord(jobId);

		const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });

		// The reviewer's report_verdict tool call can complete a tick before its
		// write-once verdict file's temp-write-then-rename becomes visible on
		// disk. Firing the event before the file exists must not resolve the wait
		// with a false negative (or throw) — it must keep waiting until the file
		// itself is the fact on the ground.
		worker.emit({ type: "tool_execution_end", toolName: "report_verdict" });
		assert.equal(existsSync(verdictFile), false, "the race only means something if the file is not there yet");
		setTimeout(() => writeFileSync(verdictFile, JSON.stringify(record)), 50);

		const result = await promise;
		assert.deepEqual(result.review, record.review);
		assert.equal(worker.listenerCount, 0);
	},
);

test("awaitVerdict: a verdict file with no event at all is still found, by the backstop poll", async (t) => {
	const jobId = "cp-await-backstop";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-backstop");
	const worker = new FakeVerdictWorker();
	const record = verdictRecord(jobId);

	// Written to disk only after the wait has already started its first sleep,
	// and the fake worker never emits anything at all: the only thing that can
	// find this file is the long-interval backstop poll, never the initial
	// synchronous check and never an event wake. This is the failure path a
	// missed or unrecognized event falls back to.
	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	setTimeout(() => writeFileSync(verdictFile, JSON.stringify(record)), 50);

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.deepEqual(result.review, record.review);
	assert.ok(
		elapsed >= 50 && elapsed < BACKSTOP_POLL_INTERVAL_MS + 500,
		`expected the backstop poll (~${BACKSTOP_POLL_INTERVAL_MS}ms) to find the file, took ${elapsed}ms`,
	);
	assert.equal(worker.listenerCount, 0);
});

test("awaitVerdict: a rejection file is a terminal operational fault", async (t) => {
	const jobId = "cp-await-rejected";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-rejected");
	const worker = new FakeVerdictWorker();
	writeFileSync(rejectedFile, "{}");

	const result = await awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	assert.match(result.operational ?? "", /exhausted its in-run verdict repairs/);
	assert.equal(worker.listenerCount, 0);
});

test("awaitVerdict: exit without a verdict is a terminal operational fault, worded exactly", async (t) => {
	const jobId = "cp-await-exit";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-exit");
	const worker = new FakeVerdictWorker();

	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	worker.close();

	const result = await promise;
	assert.equal(result.operational, "reviewer exited without reporting a verdict");
	assert.equal(worker.listenerCount, 0);
});

test("awaitVerdict: settle without a verdict waits the full grace, then is a terminal operational fault", async (t) => {
	const jobId = "cp-await-settle";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-settle");
	const worker = new FakeVerdictWorker();

	const start = Date.now();
	const promise = awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 30_000, worker });
	worker.emit({ type: "agent_settled" });

	const result = await promise;
	const elapsed = Date.now() - start;
	assert.equal(result.operational, "reviewer settled without reporting a verdict");
	assert.ok(elapsed >= SETTLE_GRACE_MS - 25, `expected to wait out the settle grace (~${SETTLE_GRACE_MS}ms), took ${elapsed}ms`);
	assert.equal(worker.listenerCount, 0);
});

test("awaitVerdict: the deadline is a terminal operational fault, worded with the configured timeout", async (t) => {
	const jobId = "cp-await-deadline";
	const { verdictFile, rejectedFile } = awaitVerdictFiles(t, "gate-await-deadline");
	const worker = new FakeVerdictWorker();

	const result = await awaitVerdict({ jobId, verdictFile, rejectedFile, timeoutMs: 200, worker });
	assert.equal(result.operational, "reviewer did not report a verdict within 200ms");
	assert.equal(worker.listenerCount, 0);
});
