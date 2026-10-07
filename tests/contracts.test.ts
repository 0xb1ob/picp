import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MandateSchema, ProjectSchema, ReviewerModelSchema } from "../src/contracts.ts";
import {
	ANSWER_CARD_COLLAPSED_LINES,
	ANSWER_ENTRY_TYPE,
	ANSWER_MAX_BYTES,
		BRIEF_PLACEHOLDERS,
	ContractError,
	DEFAULT_BUDGET_CONFIG,
	DEFAULT_GATE_CONFIG,
	EMPTY_FLEET,
	EMPTY_USAGE,
	ENVELOPE_REPAIR_MAX_ATTEMPTS,
	emptyJobsDocument,
	type Envelope,
	EnvelopeSchema,
	MINIMAL_PLAN_SUMMARY,
	DELIVERIES,
	DeliverySchema,
	FAILURE_CLASSES,
	FAILURE_RECOVERABLE,
	RECOVERY_POLICY,
	validateScriptExitResult,
	validateScriptExitResultRecord,
	findDependencyCycle,
	FLEET_MUTATING_TOOLS,
	type Job,
	JOB_KINDS,
	JOB_STATUSES,
	jobsInvariantErrors,
	type FleetRecord,
	GATE_MAX_REVISE,
	GATE_REVIEW_TIMEOUT_MAX_MS,
	GateConfigSchema,
	GateVerdictSchema,
	isInside,
	isIsoTimestamp,
	isSafeJobId,
	isSafeLedgerPrefix,
	isoTimestamp,
	configureLayout,
	currentLayoutMode,
	LAYOUT,
	layoutFor,
	MODE_SETTINGS,
	MODES,
	neverCommitFor,
	validateModeSettings,
	validateRuntime,
	LEDGER_PREFIX_PATTERN,
	LEGACY_ROLE_ALIASES,
	normalizeLegacyRoles,
	ROLES,
	parseCheckpointFileName,
	NEVER_COMMIT_PATHS,
	decodeReviewAnswer,
	encodeReviewAnswer,
	paths,
	QUESTION_METHODS,
	REVIEW_DIALOG_TITLE,
	type ProfileFrontmatter,
	RoutingConfigSchema,
	RoutingDecisionSchema,
	type RunStatus,
	collectLegacyJobFields,
	stripLegacyJobFields,
	SUMMARY_MAX_LINES,
	QUESTION_OUTCOMES,
	validate,
	CP_EVENT_KINDS,
	PENDING_REVIEW_FILE,
	QUALITY_PANEL_SLOT,
	REVIEW_SURFACES,
	validatePendingReview,
	VERDICT_MESSAGE_TYPE,
	validateEnvelope,
	validateFleetFile,
	validateJobsDocument,
	validateProfile,
	validateQuestionRecord,
	validateReviewApproval,
	validateRunStatus,
	WORKER_FORBIDDEN_FLAGS,
	WORKER_FORBIDDEN_TOOLS,
	WORKER_REQUIRED_FLAGS,
	PARENT_BRIDGE_FLAGS,
} from "../src/contracts.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

test("reviewer model is additive, bounded and exact; legacy records still validate", () => {
	const project = { name: "demo", clone_url: "https://github.com/o/demo.git", delivery: "pr", registered_at: "2026-10-07T10:00:00Z" };
	const mandate = { schema_version: 1, id: "md-aabbcc", issued_by: { channel: "operator_chat" }, issued_at: "2026-10-07T10:00:00Z", expiry: "2026-10-08T10:00:00Z", projects: ["demo"], objective: "review", allowed_actions: ["review"], spend_cap: { usd: 10, tokens: 100_000 }, job_cap: 3, ask_on: [], status: "active", decisions: [], escalations: [] };
	for (const [schema, record] of [[ProjectSchema, project], [MandateSchema, mandate]] as const) {
		assert.equal(validate(schema, record).ok, true);
		assert.equal(validate(schema, { ...record, reviewer_model: "provider/model/variant" }).ok, true, "first slash separates provider from model");
		for (const reviewer_model of [null, "", "provider", "/model", "provider/", "provider/has space", `p/${"x".repeat(128)}`]) assert.equal(validate(schema, { ...record, reviewer_model }).ok, false);
		const incomplete = { ...record, reviewer_model: "provider/model", ...("name" in record ? { name: undefined } : { objective: undefined }) };
		assert.equal(validate(schema, incomplete).ok, false, "the optional field never relaxes mandatory fields");
	}
	assert.equal(validate(ReviewerModelSchema, "provider/model").ok, true);
});

test("job ids are path-safe or rejected", () => {
	for (const ok of ["cp-t02-contracts-vuh", "abc", "A1_b-2"]) {
		assert.ok(isSafeJobId(ok), `${ok} should be safe`);
	}
	for (const bad of ["", "../etc", "a/b", "a.b", "-leading", "a b", "a".repeat(129)]) {
		assert.ok(!isSafeJobId(bad), `${bad} should be rejected`);
	}
});

test("path helpers fail closed on traversal and bad attempts", () => {
	assert.equal(paths.runDir("cp-x1"), ".pi-command-post/state/runs/cp-x1");
	assert.equal(paths.eventsFile("cp-x1"), ".pi-command-post/state/runs/cp-x1/events.jsonl");
	assert.equal(paths.statusFile("cp-x1"), ".pi-command-post/state/runs/cp-x1/status.json");
	assert.equal(paths.artifactFile("cp-x1"), ".pi-command-post/state/artifacts/cp-x1/report.md");
	assert.equal(paths.scriptResultFile("cp-x1"), ".pi-command-post/state/runs/cp-x1/script-result.json");
	assert.equal(paths.gateFile("cp-x1", 2), ".pi-command-post/state/runs/cp-x1/gate-2.json");
	for (const evil of ["../../etc/passwd", "a/b", "..", "x.y"]) {
		assert.throws(() => paths.runDir(evil), ContractError, `runDir(${evil})`);
		assert.throws(() => paths.artifactDir(evil), ContractError, `artifactDir(${evil})`);
	}
	assert.throws(() => paths.gateFile("cp-x1", 0), ContractError);
	assert.throws(() => paths.gateFile("cp-x1", 1.5), ContractError);
});

test("script exit result carries bounded facts, not output, and must match the job", () => {
	const result = { job_id: "cp-x1", status: "failed", exit_code: 2, signal: null, timed_out: false, reason: "exit",
		summary: "Script exited with code 2", artifact_path: "/home/state/artifacts/cp-x1/report.md" };
	assert.equal(validateScriptExitResult(result, "cp-x1", "/wt/cp-x1").ok, true);
	for (const invalid of [
		{ ...result, job_id: "cp-other" }, { ...result, status: "done" }, { ...result, signal: "SIGTERM" },
		{ ...result, artifact_path: "/wt/cp-x1/output" }, { ...result, stdout: "secret" },
		{ ...result, summary: "a\nb\nc\nd" },
	]) assert.equal(validateScriptExitResult(invalid, "cp-x1", "/wt/cp-x1").ok, false, JSON.stringify(invalid));
	assert.equal(validateScriptExitResult({ ...result, status: "done", reason: "success", exit_code: 0 }, "cp-x1").ok, true);
	const record = { schema_version: 1, job_id: "cp-x1", result };
	assert.equal(validateScriptExitResultRecord(record, "cp-x1").ok, true);
	assert.equal(validateScriptExitResultRecord({ ...record, job_id: "cp-other" }, "cp-x1").ok, false);
	assert.equal(validateScriptExitResultRecord({ ...record, result: { ...result, job_id: "cp-other" } }, "cp-x1").ok, false);
	assert.equal(FAILURE_RECOVERABLE.script_exit, false);
	assert.equal(FAILURE_RECOVERABLE.script_signal, false);
	assert.equal(RECOVERY_POLICY.script_exit, "none");
	assert.equal(RECOVERY_POLICY.script_signal, "none");
});

test("timestamps are UTC second-precision ISO", () => {
	const stamp = isoTimestamp(new Date("2026-08-27T12:34:56.789Z"));
	assert.equal(stamp, "2026-08-27T12:34:56Z");
	assert.ok(isIsoTimestamp(stamp));
	assert.ok(!isIsoTimestamp("2026-08-27T12:34:56.789Z"));
	assert.ok(!isIsoTimestamp("2026-08-27 12:34:56"));
	assert.ok(isIsoTimestamp(isoTimestamp()));
});

test("isInside is boundary-correct", () => {
	assert.ok(isInside("/a/b/c", "/a/b"));
	assert.ok(isInside("/a/b", "/a/b/"));
	assert.ok(!isInside("/a/bc", "/a/b"));
	assert.ok(!isInside("/a", "/a/b"));
});

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

const shipCtx = { job_id: "cp-ship1", kind: "ship", delivery: "pr" } as const;
const researchCtx = { job_id: "cp-res1", kind: "research", delivery: "pipeline", worktree: "/wt/cp-res1" } as const;

function shipEnvelope(overrides: Partial<Envelope> = {}): unknown {
	return {
		job_id: "cp-ship1",
		kind: "ship",
		status: "done",
		summary: "Added the retry ladder; suites green.",
		branch: "cp-ship1",
		pr_url: "https://github.com/org/repo/pull/42",
		...overrides,
	};
}

function researchEnvelope(overrides: Partial<Envelope> = {}): unknown {
	return {
		job_id: "cp-res1",
		kind: "research",
		status: "done",
		summary: "Mapped the failure paths; 4 files to touch.",
		artifact_path: "/home/op/state/artifacts/cp-res1/report.md",
		plan_summary: MINIMAL_PLAN_SUMMARY,
		self_assessment: {
			confidence: "high",
			scope: "M",
			blocking_unknowns: false,
			destructive_scope: false,
		},
		...overrides,
	};
}

test("valid ship and research envelopes pass", () => {
	const ship = validateEnvelope(shipEnvelope(), shipCtx);
	assert.ok(ship.ok, ship.ok ? "" : ship.errors.join("; "));
	const research = validateEnvelope(researchEnvelope(), researchCtx);
	assert.ok(research.ok, research.ok ? "" : research.errors.join("; "));
});

test("envelope shape violations are reported with paths", () => {
	const result = validate<Envelope>(EnvelopeSchema, { job_id: "cp-ship1", kind: "nope", status: "done" });
	assert.ok(!result.ok);
	assert.ok(result.errors.some((e) => e.startsWith("/kind:")), result.errors.join("; "));
	assert.ok(result.errors.some((e) => e.includes("summary")), result.errors.join("; "));
});

test("unknown envelope fields are rejected (closed schema)", () => {
	const result = validateEnvelope(shipEnvelope({}) as Envelope & { notes?: string }, shipCtx);
	assert.ok(result.ok);
	const extra = validate<Envelope>(EnvelopeSchema, { ...(shipEnvelope() as object), notes: "hi" });
	assert.ok(!extra.ok);
	assert.ok(extra.errors.join("; ").includes("additional properties"));
});

test("envelope identity must match the dispatch record", () => {
	const wrongJob = validateEnvelope(shipEnvelope({ job_id: "cp-other" }), shipCtx);
	assert.ok(!wrongJob.ok);
	assert.ok(wrongJob.errors.some((e) => e.startsWith("job_id:")));

	const wrongKind = validateEnvelope(researchEnvelope({ job_id: "cp-ship1" }), shipCtx);
	assert.ok(!wrongKind.ok);
	assert.ok(wrongKind.errors.some((e) => e.startsWith("kind:")));
});

test("summary may not carry a findings body", () => {
	const manyLines = validateEnvelope(shipEnvelope({ summary: "a\nb\nc\nd" }), shipCtx);
	assert.ok(!manyLines.ok);
	assert.ok(manyLines.errors.some((e) => e.includes(`at most ${SUMMARY_MAX_LINES} lines`)));

	const fenced = validateEnvelope(shipEnvelope({ summary: "done\n```ts\ncode\n```" }), shipCtx);
	assert.ok(!fenced.ok);

	const heading = validateEnvelope(shipEnvelope({ summary: "# Findings" }), shipCtx);
	assert.ok(!heading.ok);
	assert.ok(heading.errors.some((e) => e.includes("plain prose")));

	const tooLong = validateEnvelope(shipEnvelope({ summary: "x".repeat(601) }), shipCtx);
	assert.ok(!tooLong.ok);
});

test("research/done must name an absolute artifact outside the worktree, and no PR", () => {
	const missing = validateEnvelope(researchEnvelope({ artifact_path: undefined }), researchCtx);
	assert.ok(!missing.ok);
	assert.ok(missing.errors.some((e) => e.startsWith("artifact_path:")));

	const relative = validateEnvelope(researchEnvelope({ artifact_path: "report.md" }), researchCtx);
	assert.ok(!relative.ok);
	assert.ok(relative.errors.some((e) => e.includes("absolute")));

	const inside = validateEnvelope(researchEnvelope({ artifact_path: "/wt/cp-res1/report.md" }), researchCtx);
	assert.ok(!inside.ok);
	assert.ok(inside.errors.some((e) => e.includes("outside the worktree")));

	const withPr = validateEnvelope(
		researchEnvelope({ pr_url: "https://github.com/org/repo/pull/1" }),
		researchCtx,
	);
	assert.ok(!withPr.ok);
	assert.ok(withPr.errors.some((e) => e.startsWith("pr_url:")));
});

// ---------------------------------------------------------------------------
// cp-u3o4: delivery:answer is a delivery, not a kind
// ---------------------------------------------------------------------------

test("delivery:answer is on the delivery axis and the kind axis is untouched", () => {
	assert.deepEqual([...DELIVERIES], ["pr", "local", "pipeline", "answer", "board"]);
	assert.deepEqual([...JOB_KINDS], ["ship", "research"], "a Q&A job is a research job; there is no fourth kind");
	assert.ok(validate(DeliverySchema, "answer").ok);
	assert.ok(!validate(DeliverySchema, "qa").ok);
	// The bounds the card and the worker share.
	assert.equal(ANSWER_MAX_BYTES, 8192);
	assert.equal(ANSWER_ENTRY_TYPE, "cp-answer");
	assert.ok(ANSWER_CARD_COLLAPSED_LINES > 0);
});

test("a Q&A envelope is judged by the research rules, unchanged", () => {
	const answerCtx = { job_id: "cp-res1", kind: "research", delivery: "answer", worktree: "/wt/cp-res1" } as const;

	const ok = validateEnvelope(researchEnvelope(), answerCtx);
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));

	// An answer still needs a file: the body never travels in the envelope.
	const noArtifact = validateEnvelope(researchEnvelope({ artifact_path: undefined }), answerCtx);
	assert.ok(!noArtifact.ok);
	assert.ok(noArtifact.errors.some((e) => e.startsWith("artifact_path:")));

	// A body-shaped summary is refused exactly as before — nothing about the Q&A
	// path widens what may travel in a headline.
	for (const summary of ["a\nb\nc\nd", "# Answer", "answer\n```ts\ncode\n```"]) {
		const bodyish = validateEnvelope(researchEnvelope({ summary }), answerCtx);
		assert.ok(!bodyish.ok, `a body-shaped summary must still be refused: ${JSON.stringify(summary)}`);
	}

	// And a Q&A worker opens no PR.
	const withPr = validateEnvelope(researchEnvelope({ pr_url: "https://github.com/org/repo/pull/1" }), answerCtx);
	assert.ok(!withPr.ok);
	assert.ok(withPr.errors.some((e) => e.startsWith("pr_url:")));
});

test("cp_ask is dispatch capability: forbidden to workers, and gated on the parent lock", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_ask"));
	assert.ok(FLEET_MUTATING_TOOLS.includes("cp_ask"));
});

test("ship/done needs branch, and a PR url only for delivery:pr", () => {
	const noBranch = validateEnvelope(shipEnvelope({ branch: undefined }), shipCtx);
	assert.ok(!noBranch.ok);
	assert.ok(noBranch.errors.some((e) => e.startsWith("branch:")));

	const noPr = validateEnvelope(shipEnvelope({ pr_url: undefined }), shipCtx);
	assert.ok(!noPr.ok);
	assert.ok(noPr.errors.some((e) => e.startsWith("pr_url:")));

	const badPr = validateEnvelope(shipEnvelope({ pr_url: "github.com/org/repo/pull/42" }), shipCtx);
	assert.ok(!badPr.ok);
	assert.ok(badPr.errors.some((e) => e.includes("https")));

	const local = validateEnvelope(shipEnvelope({ pr_url: undefined }), { ...shipCtx, delivery: "local" });
	assert.ok(local.ok, local.ok ? "" : local.errors.join("; "));
});

test("ship envelopes may carry optional base_sha (full 40-char commit sha)", () => {
	const noBaseSha = validateEnvelope(shipEnvelope(), shipCtx);
	assert.ok(noBaseSha.ok, "base_sha is optional");

	const withBaseSha = validateEnvelope(
		shipEnvelope({ base_sha: "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a" }),
		shipCtx,
	);
	assert.ok(withBaseSha.ok, withBaseSha.ok ? "" : withBaseSha.errors.join("; "));

	const tooShort = validateEnvelope(
		shipEnvelope({ base_sha: "2046b57" }),
		shipCtx,
	);
	assert.ok(!tooShort.ok, "base_sha must be exactly 40 chars");
	assert.ok(tooShort.errors.some((e) => e.includes("40")));

	const tooLong = validateEnvelope(
		shipEnvelope({ base_sha: "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3axx" }),
		shipCtx,
	);
	assert.ok(!tooLong.ok, "base_sha must be exactly 40 chars");

	const researchWithBaseSha = validateEnvelope(
		researchEnvelope({ base_sha: "2046b5780e2c4a1a2b3c4d5e6f7a8b9c0d1e2f3a" }),
		researchCtx,
	);
	assert.ok(researchWithBaseSha.ok, "research envelopes may also carry base_sha");
});

test("blocked envelopes must name blockers", () => {
	const noBlockers = validateEnvelope(
		shipEnvelope({ status: "blocked", pr_url: undefined, branch: undefined }),
		shipCtx,
	);
	assert.ok(!noBlockers.ok);
	assert.ok(noBlockers.errors.some((e) => e.startsWith("blockers:")));

	const ok = validateEnvelope(
		shipEnvelope({
			status: "blocked",
			pr_url: undefined,
			branch: undefined,
			blockers: ["migration needs owner sign-off"],
		}),
		shipCtx,
	);
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));
});

const plannerBlocker = {
	question: "Which store?",
	why: "The plan cannot name a schema without it.",
	options: ["Postgres", "SQLite"],
	recommended: "SQLite",
	assume_if_unanswered: "SQLite",
};

test("a planner blocked envelope takes questions, and a body-shaped blocker is refused", () => {
	const ok = validateEnvelope(
		researchEnvelope({
			status: "blocked",
			artifact_path: undefined,
			blockers: [plannerBlocker, { ...plannerBlocker, question: "Which TTL?" }],
		}),
		researchCtx,
	);
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));

	const stringy = validateEnvelope(
		researchEnvelope({ status: "blocked", artifact_path: undefined, blockers: ["which store?"] }),
		researchCtx,
	);
	assert.ok(!stringy.ok);
	assert.ok(stringy.errors.some((error) => error.includes("not a string")));

	const body = validateEnvelope(
		researchEnvelope({
			status: "blocked",
			artifact_path: undefined,
			blockers: [{ ...plannerBlocker, why: "# Findings\n```\nthe body\n```" }],
		}),
		researchCtx,
	);
	assert.ok(!body.ok);
	assert.ok(
		body.errors.some((error) => error.includes("body belongs in the artifact") || error.includes("never a body")),
		body.ok ? "" : body.errors.join("; "),
	);

	const tooMany = validateEnvelope(
		researchEnvelope({
			status: "blocked",
			artifact_path: undefined,
			blockers: [plannerBlocker, plannerBlocker, plannerBlocker, plannerBlocker],
		}),
		researchCtx,
	);
	assert.ok(!tooMany.ok);
	assert.ok(tooMany.errors.some((error) => error.includes("at most 3")));
});

test("envelope errors are model-facing and bounded", () => {
	const result = validateEnvelope({ job_id: "cp-ship1", kind: "ship", status: "done", summary: "" }, shipCtx);
	assert.ok(!result.ok);
	assert.ok(result.errors.length > 0 && result.errors.length <= 10);
	for (const message of result.errors) {
		assert.match(message, /: /, `error must name a path and a fix: ${message}`);
	}
	assert.ok(ENVELOPE_REPAIR_MAX_ATTEMPTS >= 2);
});

// ---------------------------------------------------------------------------
// cp-ne3 regression: report_result payloads shaped like the ones rejected on a
// worker's first attempt (cp-48z, cp-phj, cp-lxl). The text below is
// synthetic, but keeps the real payloads' shape and lengths: the rejections
// were caused by BLOCKER_MAX_CHARS (300) and the old
// suggested_implementer_model cap (120).
// ---------------------------------------------------------------------------

// cp-48z's first report_result call: a restore blocked on an invalid
// registry token. Each entry explains what a worker did and what a human must
// do next; several exceed the old 300-char cap, and truncating them on retry
// is exactly the information loss this fix exists to prevent.
const CP_48Z_BLOCKERS: readonly string[] = [
	"Backup integrity verified and restore point chosen: snapshot 0000aaaa (2026-01-04 04:00 UTC, Sunday), the newest snapshot strictly before the 2026-01-08 incident window. A full integrity check over every pack in the example repository reported no errors, and a dry-run restore of this exact snapshot into a scratch directory completed cleanly with matching file counts.",
	"The `example-app` scheduler job did not exist at all (404, not just stopped) when this job started - something had already deregistered it, presumably as a first containment step. Re-registered it from the example job spec with its group count temporarily forced to 0 (via a scratch copy, not a repo change) so nothing booted from the old disk before the restore. It is currently registered and scaled to 0 - safe, with no allocation running anywhere.",
	"Dispatching the parameterized `example-restore` job first failed with 'unpermitted metadata keys: [SNAPSHOT]' - the job spec's parameterized block was missing its optional metadata list. Fixed in the example restore job spec (shipped in PR #9) and redeployed it.",
	"Re-dispatched after that fix; the restore task failed to start because the container runtime could not pull registry.example.com/example/backup-tool:0.1.1 ('denied'). Traced the cause to the scheduler variable holding EXAMPLE_REGISTRY_TOKEN: a direct check against the registry API with that token returns 401 'Bad credentials' - the token itself is invalid, expired or revoked, independent of the scheduler or this repo. This blocks the restore and also every periodic backup and maintenance job, since they all pull the same image.",
	"Operator action needed before the restore can proceed: mint a fresh registry token for the example account with read-only package scope and store it in the scheduler variable as EXAMPLE_REGISTRY_TOKEN=<new-token>, preserving every other key already in that variable. Once that token works, re-run the parameterized restore job with SNAPSHOT=0000aaaa; the job is already registered, validated and ready to go, so no other change is needed first.",
	"Network rejoin was NOT attempted - there is nothing running to rejoin yet since the restore has not happened. Once the restore succeeds and the guest boots, generate a fresh single-use, pre-authorized join key with the example tag in the network admin console and run the join command on the guest through its out-of-band console at console.example.com, per the plan's section 6 - this step still needs a human with both admin-console and guest-console access to finish.",
	"Per the brief's overrides, the following were correctly skipped or treated as already done and needed no action here: old join-key revocation (already revoked), the secret-leak hunt (retracted, none found), the device audit (operator already confirmed clean), and forensic disk imaging (declined by the operator).",
];

test("cp-48z-shaped blockers over the old 300-char cap are accepted on the first call", () => {
	assert.ok(CP_48Z_BLOCKERS.some((b) => b.length > 300), "fixture must actually exceed the old 300-char cap");
	const result = validateEnvelope(
		shipEnvelope({
			status: "blocked",
			pr_url: "https://github.com/example-org/example-repo/pull/9",
			blockers: [...CP_48Z_BLOCKERS],
		}),
		shipCtx,
	);
	assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
});

test("a blocker longer than BLOCKER_MAX_CHARS still names the field and the limit", () => {
	const result = validate<Envelope>(EnvelopeSchema, {
		...(shipEnvelope({ status: "blocked", pr_url: undefined, branch: undefined }) as object),
		blockers: ["x".repeat(1001)],
	});
	assert.ok(!result.ok);
	assert.ok(result.errors.some((e) => e.startsWith("/blockers/0:") && e.includes("1000")));
});

// cp-lxl and cp-phj both overflowed the old
// 120-char suggested_implementer_model cap by putting a justification in the
// same field as the model id; on retry, cp-phj's repair *dropped the model
// identity entirely* ("senior-level model, security/incident-response
// judgment needed") to fit the cap — real information loss, not padding.
const CP_LXL_MODEL_ID = "claude-opus-4-6";
const CP_LXL_MODEL_REASON =
	"high-stakes incident-response runbook with irreversible credential-revocation and live-restore steps; needs strong judgment at each STOP point, not just mechanical execution";
const CP_LXL_COMBINED = `${CP_LXL_MODEL_ID} (${CP_LXL_MODEL_REASON})`;

test("the real combined id+reason string that overflowed the old 120-char cap is what a worker wrote", () => {
	assert.equal(CP_LXL_COMBINED.length, 191);
});

test("split into id + reason, cp-lxl's real suggestion is accepted on the first call", () => {
	const research = validateEnvelope(
		researchEnvelope({
			self_assessment: {
				confidence: "high",
				scope: "L",
				blocking_unknowns: true,
				destructive_scope: true,
				suggested_implementer_model: CP_LXL_MODEL_ID,
				suggested_implementer_model_reason: CP_LXL_MODEL_REASON,
			},
		}),
		researchCtx,
	);
	assert.ok(research.ok, research.ok ? "" : research.errors.join("; "));
});

test("cp-phj's second-attempt repair, which dropped the model id to fit the old cap, is exactly the failure mode this fixes", () => {
	// This is what the worker actually sent after truncating: no model
	// identity survives, only a generic description. Split fields make this
	// unnecessary because the id alone ("claude-opus-4.5") fits comfortably.
	const lossyRepair = "senior-level model, security/incident-response judgment needed";
	assert.ok(lossyRepair.length <= 120, "this is what workers were forced down to");
	const research = validateEnvelope(
		researchEnvelope({
			self_assessment: {
				confidence: "high",
				scope: "M",
				blocking_unknowns: true,
				destructive_scope: true,
				suggested_implementer_model: "claude-opus-4.5",
				suggested_implementer_model_reason:
					"security/incident-response judgment needed for restore-point selection and credential rotation scope",
			},
		}),
		researchCtx,
	);
	assert.ok(research.ok, research.ok ? "" : research.errors.join("; "));
});

// ---------------------------------------------------------------------------
// fleet state
// ---------------------------------------------------------------------------

function fleetRecord(overrides: Partial<FleetRecord> = {}): FleetRecord {
	return {
		job_id: "cp-ship1",
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: "terminal",
		phase: "waiting",
		worker: {
			pid: 4242,
			session_id: "abc",
			session_file: "/sessions/abc.jsonl",
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-27T12:00:00Z",
		},
		worktree: "/wt/cp-ship1",
		branch: "cp-ship1",
		dispatched_at: "2026-08-27T12:00:00Z",
		usage: EMPTY_USAGE,
		...overrides,
	};
}

test("empty fleet file validates", () => {
	const result = validateFleetFile(EMPTY_FLEET);
	assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
});

test("fleet rejects duplicate job ids", () => {
	const result = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [fleetRecord(), fleetRecord()],
	});
	assert.ok(!result.ok);
	assert.ok(result.errors.some((e) => e.includes("duplicate job_id")));
});

test("held requires reported_at and failed requires a failure cause", () => {
	const held = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [fleetRecord({ phase: "held" })],
	});
	assert.ok(!held.ok);
	assert.ok(held.errors.some((e) => e.includes("reported_at")));

	const heldOk = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [fleetRecord({ phase: "held", reported_at: "2026-08-27T12:30:00Z" })],
	});
	assert.ok(heldOk.ok, heldOk.ok ? "" : heldOk.errors.join("; "));

	const failed = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [fleetRecord({ phase: "failed" })],
	});
	assert.ok(!failed.ok);
	assert.ok(failed.errors.some((e) => e.includes("failure")));

	const failedOk = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [
			fleetRecord({
				phase: "failed",
				failure: { class: "crash", message: "exit 1", at: "2026-08-27T12:10:00Z" },
			}),
		],
	});
	assert.ok(failedOk.ok, failedOk.ok ? "" : failedOk.errors.join("; "));
});

test("a legacy \"researcher\" role on disk loads as planner, and only planner is written back", () => {
	// A home that ran the pre-rename build still has the old word in fleet.json.
	// It must load, and what it loads must be the current role name.
	const legacy = {
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [
			{
				...fleetRecord({ job_id: "cp-plan1", kind: "research" }),
				worker: { ...fleetRecord().worker, profile: "researcher", role: "researcher" },
			},
		],
	};
	const loaded = validateFleetFile(legacy);
	assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("; "));
	assert.equal(loaded.value.jobs[0]?.worker.role, "planner");
	// Never written again: serializing the loaded record has no legacy word in
	// any `role`, and the profile name is left exactly as it was on disk.
	const written = JSON.parse(JSON.stringify(loaded.value)) as typeof legacy;
	assert.equal(written.jobs[0]?.worker.role, "planner");

	// questions.jsonl, same normaliser, same result.
	const question = validateQuestionRecord({
		schema_version: 1,
		job_id: "cp-plan1",
		seq: 1,
		dialog_id: "d1",
		role: "researcher",
		method: "input",
		question: "which base branch?",
		asked_at: "2026-08-27T12:00:00Z",
		outcome: "answered",
		answer: "main",
	});
	assert.ok(question.ok, question.ok ? "" : question.errors.join("; "));
	assert.equal(question.value.role, "planner");

	// The walk only rewrites a `role` property whose value is the retired word:
	// a message role, a title or a model name that contains it is untouched.
	const untouched = normalizeLegacyRoles({
		role: "assistant",
		title: "hire a researcher",
		nested: [{ role: "researcher" }, { role: "implementer" }],
	});
	assert.equal(untouched.role, "assistant");
	assert.equal(untouched.title, "hire a researcher");
	assert.deepEqual(untouched.nested, [{ role: "planner" }, { role: "implementer" }]);

	assert.deepEqual(LEGACY_ROLE_ALIASES, { researcher: "planner" });
	assert.ok(!ROLES.includes("researcher" as never), "the retired role is not a role");
});

test("fleet has no stalled phase", () => {
	const result = validateFleetFile({
		schema_version: 1,
		updated_at: "2026-08-27T12:00:00Z",
		jobs: [{ ...fleetRecord(), phase: "stalled" }],
	});
	assert.ok(!result.ok);
});

// ---------------------------------------------------------------------------
// run status projection
// ---------------------------------------------------------------------------

function runStatus(overrides: Partial<RunStatus> = {}): unknown {
	return {
		schema_version: 1,
		job_id: "cp-ship1",
		phase: "working",
		turns: 2,
		tool_calls: 5,
		usage: EMPTY_USAGE,
		started_at: "2026-08-27T12:00:00Z",
		last_activity_at: "2026-08-27T12:04:00Z",
		event_count: 42,
		reported: false,
		...overrides,
	};
}

test("run status validates and ties exited to an observed close", () => {
	const ok = validateRunStatus(runStatus());
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));

	const inferredDeath = validateRunStatus(runStatus({ phase: "exited" }));
	assert.ok(!inferredDeath.ok);
	assert.ok(inferredDeath.errors.some((e) => e.includes("observed")));

	const observed = validateRunStatus(
		runStatus({ phase: "exited", exited_at: "2026-08-27T12:05:00Z", exit_code: 0 }),
	);
	assert.ok(observed.ok, observed.ok ? "" : observed.errors.join("; "));

	const contradiction = validateRunStatus(runStatus({ phase: "idle", exited_at: "2026-08-27T12:05:00Z" }));
	assert.ok(!contradiction.ok);
});

// ---------------------------------------------------------------------------
// profiles, gate, routing, budgets
// ---------------------------------------------------------------------------

function profile(overrides: Partial<ProfileFrontmatter> = {}): unknown {
	return {
		name: "planner",
		role: "planner",
		tools: ["read", "bash", "report_result"],
		model: "anthropic/claude-sonnet-5",
		briefTemplate: "brief-research",
		readOnly: true,
		...overrides,
	};
}

test("profile validation enforces the recursion guard", () => {
	const ok = validateProfile(profile());
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));

	for (const tool of WORKER_FORBIDDEN_TOOLS) {
		const bad = validateProfile(profile({ tools: ["read", tool] }));
		assert.ok(!bad.ok, `${tool} must be refused`);
		assert.ok(bad.errors.some((e) => e.includes("parent-only")));
	}

	const writablePlanner = validateProfile(profile({ readOnly: false }));
	assert.ok(!writablePlanner.ok);

	const unknownField = validateProfile({ ...(profile() as object), model_name: "x" });
	assert.ok(!unknownField.ok);
});

test("worker spawn flag policy is fail-closed", () => {
	for (const flag of ["--mode", "rpc", "--no-approve", "--no-extensions", "--no-skills"]) {
		assert.ok(WORKER_REQUIRED_FLAGS.includes(flag), `${flag} must be required`);
	}
	assert.ok(PARENT_BRIDGE_FLAGS.includes("--no-extensions"), "bridge parent must disable extension discovery");
	for (const flag of ["--approve", "-a"]) {
		assert.ok(WORKER_FORBIDDEN_FLAGS.includes(flag));
	}
	// required and forbidden may never intersect
	for (const flag of WORKER_REQUIRED_FLAGS) {
		assert.ok(!WORKER_FORBIDDEN_FLAGS.includes(flag));
	}
});

test("gate verdict schema carries a cause on escalate and drops revisions elsewhere", () => {
	const base = {
		schema_version: 1,
		job_id: "cp-res1",
		attempt: 1,
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["file list is concrete"],
		decided_at: "2026-08-27T12:00:00Z",
	};
	assert.ok(validate(GateVerdictSchema, { ...base, verdict: "pass", cause: null }).ok);
	assert.ok(validate(GateVerdictSchema, { ...base, verdict: "escalate", cause: "policy" }).ok);
	assert.ok(
		validate(GateVerdictSchema, { ...base, verdict: "escalate", cause: "operational_persistent" }).ok,
	);
	assert.ok(!validate(GateVerdictSchema, { ...base, verdict: "pass" }).ok, "cause is required");
	assert.ok(!validate(GateVerdictSchema, { ...base, verdict: "pass", cause: "flaky" }).ok);
	assert.ok(!validate(GateVerdictSchema, { ...base, verdict: "maybe", cause: null }).ok);
	assert.equal(GATE_MAX_REVISE, 1);
});

test("routing config is closed and fail-closed on allow", () => {
	const ok = validate(RoutingConfigSchema, {
		schema_version: 1,
		allow: ["anthropic/*"],
		rubric: [
			{ id: "scoped", role: "implementer", project: "demo", scope: ["L"], risk: "high", model: "anthropic/claude-opus-5" },
			{ id: "r4", role: "planner", scope: ["S", "M"], model: "anthropic/claude-sonnet-5" },
		],
	});
	assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("; "));

	const emptyAllow = validate(RoutingConfigSchema, { schema_version: 1, allow: [], rubric: [] });
	assert.ok(emptyAllow.ok, "an empty allowlist is representable (and means: allow nothing)");

	const badRole = validate(RoutingConfigSchema, {
		schema_version: 1,
		allow: ["*"],
		rubric: [{ id: "r", role: "reviewer", model: "m" }],
	});
	assert.ok(!badRole.ok);

	// cp-cxt: `pins` is not a key any more, and the schema is closed, so a config
	// written for the old two-mechanism model cannot pass as valid.
	const withPins = validate(RoutingConfigSchema, {
		schema_version: 1,
		allow: ["*"],
		rubric: [],
		pins: [{ match: { role: "planner" }, model: "m" }],
	});
	assert.ok(!withPins.ok);
});

test("routing: candidate lists and their provenance are optional and bounded", () => {
	const rule = (fallbacks: unknown) => ({
		schema_version: 1,
		allow: ["*/*"],
		rubric: [{ id: "r", role: "implementer", model: "anthropic/claude-opus-5", fallbacks }],
	});
	assert.ok(validate(RoutingConfigSchema, rule(["openai/gpt-5.5", "xai/grok-4.6"])).ok);
	assert.ok(validate(RoutingConfigSchema, rule([])).ok, "an empty list is a row with no ladder");
	assert.ok(!validate(RoutingConfigSchema, rule(["a/b", "c/d", "e/f", "g/h", "i/j"])).ok, "at most four candidates");
	assert.ok(!validate(RoutingConfigSchema, rule("openai/gpt-5.5")).ok, "a bare string is not a list");

	// The provenance a fallback owes: model refs and enum words, nothing else.
	const decision = (attempted: unknown) => ({ model: "xai/grok-4.6", source: "rubric", rule: "r", attempted });
	assert.ok(validate(RoutingDecisionSchema, decision([{ model: "anthropic/claude-opus-5", refusal: "availability" }])).ok);
	assert.ok(validate(RoutingDecisionSchema, { model: "m/x", source: "profile", rule: "p" }).ok, "absent when nothing was skipped");
	assert.ok(!validate(RoutingDecisionSchema, decision([{ model: "m/x", refusal: "exhausted" }])).ok, "`exhausted` is about the list, not a member");
	assert.ok(
		!validate(RoutingDecisionSchema, decision([{ model: "m/x", refusal: "availability", detail: "sk-secret" }])).ok,
		"no free-text field can be smuggled into the provenance",
	);
	assert.ok(
		!validate(
			RoutingDecisionSchema,
			decision(Array.from({ length: 9 }, () => ({ model: "m/x", refusal: "availability" }))),
		).ok,
		"bounded at 8 entries",
	);
});

test("gate config: absent field defaults elsewhere, bounds are enforced, schema is closed", () => {
	assert.ok(validate(GateConfigSchema, { schema_version: 1 }).ok, "review_timeout_ms is optional");
	assert.ok(validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: 60_000 }).ok);
	assert.ok(!validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: 0 }).ok, "zero is refused");
	assert.ok(!validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: -5 }).ok, "negative is refused");
	assert.ok(
		!validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: "300000" }).ok,
		"non-numeric is refused",
	);
	assert.ok(
		!validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: GATE_REVIEW_TIMEOUT_MAX_MS + 1 }).ok,
		"above the upper bound is refused",
	);
	assert.ok(validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: GATE_REVIEW_TIMEOUT_MAX_MS }).ok);
	assert.ok(
		!validate(GateConfigSchema, { schema_version: 1, review_timeout_ms: 60_000, extra: true }).ok,
		"schema is closed",
	);
	assert.equal(DEFAULT_GATE_CONFIG.review_timeout_ms, undefined, "default config opts in to nothing");
});

test("budget defaults and failure taxonomy are complete", () => {
	assert.equal(DEFAULT_BUDGET_CONFIG.spawn_cap, 10);
	assert.ok(DEFAULT_BUDGET_CONFIG.warn_ratio > 0 && DEFAULT_BUDGET_CONFIG.warn_ratio < 1);
	assert.equal(FAILURE_RECOVERABLE.tool_loop, false);
	assert.equal(FAILURE_RECOVERABLE.budget_exceeded, false);
	assert.equal(FAILURE_RECOVERABLE.crash, true);
	// cp-settle-without-report: not retryable, and deliberately so — the delivery
	// very likely already exists, so re-running the brief would duplicate it.
	assert.equal(FAILURE_RECOVERABLE.settled_without_report, false);
	// cp-0wq7: a failed model call repeats identically on a retry — the fix is a
	// credential or a routed model, both outside this fleet.
	assert.equal(FAILURE_RECOVERABLE.model_call_failed, false);
	assert.equal(FAILURE_RECOVERABLE.wall_clock_exceeded, false);
	assert.equal(FAILURE_RECOVERABLE.tool_call_cap_exceeded, false);
	assert.equal(Object.keys(FAILURE_RECOVERABLE).length, FAILURE_CLASSES.length);
	assert.equal(FAILURE_CLASSES.length, 14);
});

// ---------------------------------------------------------------------------
// doc / code agreement
// ---------------------------------------------------------------------------

test("docs/contracts.md documents every contract surface", () => {
	const doc = readFileSync(join(REPO_ROOT, "docs/contracts.md"), "utf8");
	const required = [
		"report_result",
		"state/fleet.json",
		"events.jsonl",
		"status.json",
		"ProfileFrontmatterSchema",
		"GateVerdictSchema",
		"RoutingConfigSchema",
		"GateConfigSchema",
		"BudgetConfigSchema",
		"SendReceiptSchema",
		"WORKER_REQUIRED_FLAGS",
		"PARENT_BRIDGE_FLAGS",
		"BRIDGE_RECEIPT_LEVELS",
		"WORKER_FORBIDDEN_TOOLS",
		"NEVER_COMMIT_PATHS",
		"FAILURE_RECOVERABLE",
		"`stalled` is retired",
		"`worker_exited`",
	];
	for (const needle of required) {
		assert.ok(doc.includes(needle), `docs/contracts.md must document ${needle}`);
	}
	for (const placeholder of BRIEF_PLACEHOLDERS) {
		assert.ok(doc.includes(`\`${placeholder}\``), `brief placeholder ${placeholder} must be documented`);
	}
	for (const path of NEVER_COMMIT_PATHS) {
		assert.ok(doc.includes(path), `never-commit path ${path} must be documented`);
	}
});

// ---------------------------------------------------------------------------
// cp-epy2 §4.2: a per-home br prefix, and the ids it mints
// ---------------------------------------------------------------------------

test("ledger prefixes are lowercase, short and letter-led, or rejected", () => {
	for (const ok of ["cp", "cps", "slack1", "a", "abcdefgh"]) {
		assert.ok(isSafeLedgerPrefix(ok), `${ok} should be a usable prefix`);
	}
	for (const bad of ["CP", "cp-x", "", "abcdefghi", "1cp", "cp_x", "cp x", "cp."]) {
		assert.ok(!isSafeLedgerPrefix(bad), `${bad} should be rejected`);
	}
	// The pattern is quoted in the refusal, so an operator sees the rule itself.
	assert.equal(LEDGER_PREFIX_PATTERN, "^[a-z][a-z0-9]{0,7}$");
});

test("a non-`cp` prefix round-trips through every path helper (JOB_ID_PATTERN is prefix-agnostic)", () => {
	const id = "cps-a1b";
	assert.ok(isSafeJobId(id));
	assert.equal(paths.runDir(id), ".pi-command-post/state/runs/cps-a1b");
	assert.equal(paths.artifactFile(id), ".pi-command-post/state/artifacts/cps-a1b/report.md");
	assert.equal(paths.checkpointFile(id), ".pi-command-post/state/checkpoints/cps-a1b.json");
	assert.equal(paths.checkpointFile(id, "diff"), ".pi-command-post/state/checkpoints/cps-a1b.diff.json");
	const sha = "a".repeat(40);
	assert.equal(paths.checkpointFile(id, "merge", sha), `.pi-command-post/state/checkpoints/cps-a1b.merge-${sha}.json`);

	// And back out again: listPending() reads the directory, so the inverse must
	// agree about which job a file belongs to whatever the prefix is.
	assert.deepEqual(parseCheckpointFileName("cps-a1b.json"), { jobId: id, kind: "ship" });
	assert.deepEqual(parseCheckpointFileName("cps-a1b.diff.json"), { jobId: id, kind: "diff" });
	assert.deepEqual(parseCheckpointFileName(`cps-a1b.merge-${sha}.json`), { jobId: id, kind: "merge", scope: sha });
});

test("`worker_exited` is a question outcome of its own, and never reads as an answer", () => {
	const record = validateQuestionRecord({
		schema_version: 1,
		job_id: "cp-plan1",
		seq: 1,
		dialog_id: "d1",
		role: "planner",
		method: "input",
		question: "which base branch?",
		asked_at: "2026-09-02T09:00:00Z",
		closed_at: "2026-09-02T09:05:00Z",
		outcome: "worker_exited",
	});
	assert.ok(record.ok, record.ok ? "" : record.errors.join("; "));
	assert.equal(record.value.outcome, "worker_exited");
	assert.equal(record.value.answer, undefined, "a dead worker's question has no answer");
	assert.ok(QUESTION_OUTCOMES.includes("worker_exited"));
	assert.ok(!QUESTION_OUTCOMES.includes("attached" as never));
});

test("the parent lock has a declared place in the layout", () => {
	// It is state, not data: machine-local, per home, and never committed.
	assert.equal(LAYOUT.parentLock, ".pi-command-post/state/parent.lock");
	assert.ok(LAYOUT.parentLock.startsWith(`${LAYOUT.state}/`));
	assert.ok(NEVER_COMMIT_PATHS.some((entry) => LAYOUT.parentLock.startsWith(entry)));
});

// ---------------------------------------------------------------------------
// Jobs document (spec 2026-09-04)
// ---------------------------------------------------------------------------

function job(overrides: Partial<Job> & { id: string }): Job {
	return {
		title: "t",
		status: "open",
		labels: ["project:demo", "delivery:pr"],
		blocked_by: [],
		comments: [],
		created_at: "2026-09-04T10:00:00Z",
		updated_at: "2026-09-04T10:00:00Z",
		...overrides,
	};
}

test("the jobs document lives in the runtime dotdir, which is never committed", () => {
	assert.equal(LAYOUT.runtimeDir, ".pi-command-post");
	assert.equal(LAYOUT.jobsFile, ".pi-command-post/jobs.json");
	assert.ok(NEVER_COMMIT_PATHS.includes(".pi-command-post/"));
	assert.ok(NEVER_COMMIT_PATHS.includes(".beads/"), "the frozen archive stays uncommittable");
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_job"));
	assert.deepEqual(JOB_STATUSES, ["open", "in_progress", "deferred", "closed"]);
});

test("validateJobsDocument accepts an empty document and a sound one", () => {
	assert.equal(validateJobsDocument(emptyJobsDocument("cp")).ok, true);
	const doc = { ...emptyJobsDocument("cp"), jobs: [job({ id: "cp-a" }), job({ id: "cp-b", blocked_by: ["cp-a"] })] };
	assert.equal(validateJobsDocument(doc).ok, true);
	assert.equal(validateJobsDocument({ ...doc, jobs: [job({ id: "cp-c", script: { path: "../unsafe.sh" }, labels: ["project:demo", "kind:ship", "delivery:local"] })] }).ok, false);
	assert.equal(validateJobsDocument({ ...doc, jobs: [job({ id: "cp-c", script: { path: "scripts/run.sh" } })] }).ok, false);
});

test("validateJobsDocument refuses shape errors with a path", () => {
	const result = validateJobsDocument({ ...emptyJobsDocument("cp"), jobs: [{ ...job({ id: "cp-a" }), status: "tombstone" }] });
	assert.equal(result.ok, false);
	if (!result.ok) assert.match(result.errors.join("\n"), /\/jobs\/0\/status/);
	assert.equal(validateJobsDocument({ ...emptyJobsDocument("CP") }).ok, false, "prefix must match LEDGER_PREFIX_PATTERN");
});

test("jobsInvariantErrors names duplicates, foreign prefixes, closed inconsistencies, unknown blockers, self-deps and cycles", () => {
	const doc = {
		...emptyJobsDocument("cp"),
		jobs: [
			job({ id: "cp-a", blocked_by: ["cp-b"] }),
			job({ id: "cp-a" }),
			job({ id: "xx-1" }),
			job({ id: "cp-b", blocked_by: ["cp-a"] }),
			job({ id: "cp-c", status: "closed" }),
			job({ id: "cp-d", closed_at: "2026-09-04T10:00:00Z", close_reason: "r" }),
			job({ id: "cp-e", blocked_by: ["cp-e", "cp-nope"] }),
		],
	};
	const errors = jobsInvariantErrors(doc);
	assert.deepEqual(errors.ids, [
		"duplicate id cp-a",
		"xx-1 does not carry this document's prefix cp-",
		"cp-c is closed without closed_at/close_reason",
		"cp-d carries closed_at/close_reason but is open",
	]);
	assert.ok(errors.deps.includes("cp-e depends on itself"));
	assert.ok(errors.deps.includes("cp-e is blocked by unknown cp-nope"));
	assert.ok(errors.deps.some((line) => line.startsWith("dependency cycle: cp-a -> cp-b -> cp-a")), errors.deps.join("\n"));

	const invalid = validateJobsDocument(doc);
	assert.equal(invalid.ok, false, "validateJobsDocument runs the invariants too");
});

test("findDependencyCycle returns the cycle path or undefined", () => {
	assert.equal(findDependencyCycle([job({ id: "cp-a" }), job({ id: "cp-b", blocked_by: ["cp-a"] })]), undefined);
	assert.deepEqual(findDependencyCycle([job({ id: "cp-a", blocked_by: ["cp-b"] }), job({ id: "cp-b", blocked_by: ["cp-a"] })]), ["cp-a", "cp-b", "cp-a"]);
});

// ---------------------------------------------------------------------------
// Pending reviews (spec 2026-09-05-async-reviewers)
// ---------------------------------------------------------------------------

test("pending review paths: one attempt directory per surface, the panel in its own slot", () => {
	assert.equal(paths.reviewAttemptDir("cp-a", "gate", 2), paths.gateRunDir("cp-a", 2));
	assert.equal(paths.reviewAttemptDir("cp-a", "review", 3), paths.reviewRunDir("cp-a", 3));
	assert.equal(paths.reviewAttemptDir("cp-a", "quality", 1), paths.qualityRunDir("cp-a", QUALITY_PANEL_SLOT));
	assert.equal(paths.pendingReviewFile("cp-a", "gate", 2), `${paths.gateRunDir("cp-a", 2)}/${PENDING_REVIEW_FILE}`);
	assert.throws(() => paths.pendingReviewFile("../x", "gate", 1));
	assert.throws(() => paths.pendingReviewFile("cp-a", "gate", 0));
	assert.throws(() => paths.reviewAttemptDir("cp-a", "quality", 2), /quality panel runs once/);
});

test("pending review documents validate closed, and the review subject is optional", () => {
	const base = {
		schema_version: 1,
		job_id: "cp-a",
		surface: "gate",
		attempt: 1,
		model: "mock/reviewer",
		pid: 4242,
		started_at: "2026-09-05T10:00:00Z",
		deadline: "2026-09-05T10:15:00Z",
		handed_back: false,
	};
	assert.ok(validatePendingReview(base).ok);
	assert.ok(
		validatePendingReview({
			...base,
			surface: "review",
			subject: { head_sha: "a".repeat(40), branch: "cp-a", files: 3, truncated: false },
		}).ok,
	);
	assert.equal(validatePendingReview({ ...base, surface: "panel" }).ok, false);
	assert.equal(validatePendingReview({ ...base, extra: 1 }).ok, false);
	assert.equal(validatePendingReview({ ...base, attempt: 0 }).ok, false);
	assert.deepEqual([...REVIEW_SURFACES], ["gate", "review", "quality"]);
	assert.equal(VERDICT_MESSAGE_TYPE, "cp-verdict");
	for (const kind of ["review_started", "verdict_wakeup_sent", "verdict_wakeup_delivered", "review_orphaned"]) {
		assert.ok((CP_EVENT_KINDS as readonly string[]).includes(kind), `${kind} missing from CP_EVENT_KINDS`);
	}
});

// ---------------------------------------------------------------------------
// Modes and the configurable layout (spec 2026-09-04 single-project mode)
// ---------------------------------------------------------------------------

test("one runtime root in both modes, before and after configuration (cp-u3i2)", () => {
	const expected = {
		data: ".pi-command-post/data",
		state: ".pi-command-post/state",
		projects: ".pi-command-post/projects",
		runs: ".pi-command-post/state/runs",
		artifacts: ".pi-command-post/state/artifacts",
		pipelines: ".pi-command-post/state/pipelines",
		checkpoints: ".pi-command-post/state/checkpoints",
		mandates: ".pi-command-post/state/mandates",
		escalationsFile: ".pi-command-post/state/escalations.json",
		fleetFile: ".pi-command-post/state/fleet.json",
		awaitingFile: ".pi-command-post/state/awaiting.json",
		answeredFile: ".pi-command-post/state/answered.json",
		wakeupsFile: ".pi-command-post/state/wakeups.json",
		answerCardsFile: ".pi-command-post/state/answer-cards.json",
		ciWatchFile: ".pi-command-post/state/ci-watch.json",
		foreignCiWatchFile: ".pi-command-post/state/foreign-ci-watch.json",
		dispatchQueueFile: ".pi-command-post/state/dispatch-queue.json",
		ciRerunsFile: ".pi-command-post/state/ci-reruns.json",
		armedDispatchFile: ".pi-command-post/state/armed-dispatches.json",
		shippedSeenFile: ".pi-command-post/state/status-block-shipped.json",
		parentLock: ".pi-command-post/state/parent.lock",
		migrationsDir: ".pi-command-post/state/.migrations",
		sessions: ".pi-command-post/state/sessions",
		runtimeDir: ".pi-command-post",
		operatorWorkspace: ".pi-command-post/operator",
		jobsFile: ".pi-command-post/jobs.json",
		jobsLegacyArchive: ".pi-command-post/jobs-legacy-fields.jsonl",
		routingFile: ".pi-command-post/data/routing.json",
		projectsFile: ".pi-command-post/data/projects.json",
		projectsView: ".pi-command-post/data/projects.md",
		budgetsFile: ".pi-command-post/data/budgets.json",
		mandateDefaultsFile: ".pi-command-post/data/mandate-defaults.json",
		gateConfigFile: ".pi-command-post/data/gate.json",
		workerBoundsFile: ".pi-command-post/data/worker-bounds.json",
		suggestFile: ".pi-command-post/data/suggest.json",
		learningsFile: ".pi-command-post/data/learnings.md",
		candidatesFile: ".pi-command-post/data/candidates.md",
		archiveFile: ".pi-command-post/data/archive.md",
		curationLog: ".pi-command-post/data/curation.jsonl",
	};
	assert.deepEqual({ ...LAYOUT }, expected, "unconfigured LAYOUT is the one-root layout");
	assert.deepEqual(layoutFor("multi"), expected);
	assert.deepEqual([...NEVER_COMMIT_PATHS], [".pi-command-post/", ".beads/"]);
	assert.equal(currentLayoutMode(), undefined);

	configureLayout("multi");
	assert.equal(currentLayoutMode(), "multi");
	assert.deepEqual({ ...LAYOUT }, expected, "configuring multi changes nothing");
	assert.ok(Object.isFrozen(LAYOUT));
	configureLayout("multi"); // same mode again: fine
});

test("layoutFor(multi) keeps one root; neverCommitFor(multi) lists .beads", () => {
	for (const mode of MODES) {
		const layout = layoutFor(mode);
		assert.equal(layout.data, ".pi-command-post/data");
		assert.equal(layout.state, ".pi-command-post/state");
		assert.equal(layout.projects, ".pi-command-post/projects");
		assert.equal(layout.operatorWorkspace, ".pi-command-post/operator");
	}
	assert.deepEqual(neverCommitFor("multi"), [".pi-command-post/", ".beads/"]);
});

test("the retired-field archive is never committable, in either mode", () => {
	// docs/contracts.md §Ledger claims NEVER_COMMIT_PATHS covers the archive.
	// The guard matches a path by its first segment (src/guards.ts), so what has
	// to hold is that some never-commit entry is a prefix segment of the path.
	for (const mode of MODES) {
		const archive = layoutFor(mode).jobsLegacyArchive;
		const covered = neverCommitFor(mode).filter((never) => `${archive}/`.startsWith(never.endsWith("/") ? never : `${never}/`));
		assert.deepEqual(covered, [".pi-command-post/"], `${mode}: ${archive} is not covered by ${neverCommitFor(mode).join(" ")}`);
		assert.equal(archive.startsWith(`${layoutFor(mode).runtimeDir}/`), true, `${mode}: the archive left the runtime dotdir`);
	}
	// The live constants are the multi ones until configureLayout runs, and
	// configuring a mode assigns exactly what layoutFor returns (asserted above),
	// so proving it per mode proves it for the configured layout.
	assert.equal(LAYOUT.jobsLegacyArchive, layoutFor("multi").jobsLegacyArchive);
	assert.deepEqual([...NEVER_COMMIT_PATHS], neverCommitFor("multi"));
});

test("mode settings and runtime records validate", () => {
	assert.deepEqual([...MODES], ["multi"]);
	assert.deepEqual([...MODE_SETTINGS], ["single", "multi", "auto"], "single stays readable so a legacy settings.json is refused, not ignored");
	assert.equal(validateModeSettings({ schema_version: 1, mode: "auto" }).ok, true);
	assert.equal(validateModeSettings({ schema_version: 1, mode: "both" }).ok, false);
	assert.equal(validateModeSettings({ mode: "single" }).ok, false, "schema_version is required");
	assert.equal(validateRuntime({ mode: "multi", home: "/h", source: "checkout", reason: "r" }).ok, true);
	assert.equal(validateRuntime({ mode: "single", home: "/r", source: "checkout", reason: "r" }).ok, false, "single is not a mode");
	assert.equal(validateRuntime({ mode: "multi", home: "/r", source: "repo", reason: "r" }).ok, false, "repo is not a source");
	assert.equal(
		validateRuntime({
			mode: "multi",
			home: "/r",
			source: "checkout",
			reason: "r",
			repo: { toplevel: "/r", name: "r", default_branch: "main" },
		}).ok,
		false,
		"a runtime carries no repo",
	);
});

test("stripLegacyJobFields removes type and priority from every job and touches nothing else", () => {
	const legacy = {
		schema_version: 1,
		prefix: "cp",
		jobs: [
			{
				id: "cp-a",
				title: "t",
				status: "open",
				type: "epic",
				priority: 2,
				labels: ["project:demo", "delivery:pr"],
				blocked_by: [],
				comments: [],
				created_at: "2026-09-04T10:00:00Z",
				updated_at: "2026-09-04T10:00:00Z",
			},
		],
	};
	const before = JSON.stringify(legacy);
	assert.equal(validateJobsDocument(legacy).ok, false, "the raw legacy shape is refused by the schema");
	const stripped = stripLegacyJobFields(legacy) as { jobs: Array<Record<string, unknown>> };
	assert.equal(validateJobsDocument(stripped).ok, true);
	assert.equal("type" in (stripped.jobs[0] ?? {}), false);
	assert.equal("priority" in (stripped.jobs[0] ?? {}), false);
	assert.equal(stripped.jobs[0]?.title, "t");
	assert.equal(JSON.stringify(legacy), before, "the input is not mutated");
	assert.deepEqual(stripLegacyJobFields("not a document"), "not a document");
	assert.deepEqual(stripLegacyJobFields({ jobs: "nope" }), { jobs: "nope" });
});

test("collectLegacyJobFields names every retired value a document still carries, and nothing else", () => {
	assert.deepEqual(collectLegacyJobFields({ jobs: [{ id: "cp-a", type: "epic", priority: 2 }] }), [
		{ id: "cp-a", fields: { type: "epic", priority: 2 } },
	]);
	assert.deepEqual(collectLegacyJobFields({ jobs: [{ id: "cp-a", priority: 0 }] }), [{ id: "cp-a", fields: { priority: 0 } }], "0 is a value, not an absence");
	assert.deepEqual(collectLegacyJobFields({ jobs: [{ id: "cp-a", type: undefined }] }), [{ id: "cp-a", fields: { type: undefined } }], "an explicit key is a value the schema would refuse");
	assert.deepEqual(collectLegacyJobFields({ jobs: [{ id: "cp-a", title: "t" }] }), [], "a cleaned document has nothing to archive");
	assert.deepEqual(collectLegacyJobFields({ jobs: [{ type: "epic" }] }), [{ id: "#0", fields: { type: "epic" } }], "an id-less row is still named");
	assert.deepEqual(collectLegacyJobFields("not a document"), []);
	assert.deepEqual(collectLegacyJobFields({ jobs: "nope" }), []);
	const doc = { jobs: [{ id: "cp-a", type: "epic", priority: 2 }] };
	const before = JSON.stringify(doc);
	collectLegacyJobFields(doc);
	assert.equal(JSON.stringify(doc), before, "the input is not mutated");
});

test("review: the answer codec round-trips and refuses garbage", () => {
	assert.equal(encodeReviewAnswer({ kind: "approve" }), "approve");
	assert.equal(encodeReviewAnswer({ kind: "revise", text: "split step 3" }), "revise\nsplit step 3");
	assert.equal(encodeReviewAnswer({ kind: "ask", text: "why redis?" }), "ask\nwhy redis?");
	assert.deepEqual(decodeReviewAnswer("approve"), { kind: "approve" });
	assert.deepEqual(decodeReviewAnswer("revise\nsplit step 3"), { kind: "revise", text: "split step 3" });
	assert.deepEqual(decodeReviewAnswer("ask\nwhy redis?\nand why not pg?"), { kind: "ask", text: "why redis?\nand why not pg?" });
	assert.equal(decodeReviewAnswer("revise\n"), undefined, "a revise with no words is not an answer");
	assert.equal(decodeReviewAnswer("approve please"), undefined);
	assert.equal(decodeReviewAnswer(undefined), undefined);
	assert.equal(decodeReviewAnswer(42), undefined);
	assert.equal(REVIEW_DIALOG_TITLE, "cp:plan-review");
	assert.deepEqual([...QUESTION_METHODS], ["select", "input", "confirm", "review"]);
});

test("review: a question record may carry method review", () => {
	const record = validateQuestionRecord({
		schema_version: 1, job_id: "cp-r1", seq: 1, dialog_id: "d1", role: "planner", method: "review",
		question: "Plan written.", asked_at: "2026-09-13T10:00:00Z", outcome: "timeout",
	});
	assert.equal(record.ok, true);
});

test("review: the approval record is bounded and lives under the run dir", () => {
	assert.equal(paths.reviewApproval("cp-r1"), ".pi-command-post/state/runs/cp-r1/review-approval.json");
	const ok = validateReviewApproval({
		schema_version: 1, job_id: "cp-r1", question_seq: 2,
		artifact_sha256: "a".repeat(64), approved_at: "2026-09-13T10:00:00Z", by: "operator console",
	});
	assert.equal(ok.ok, true);
	const bad = validateReviewApproval({ schema_version: 1, job_id: "cp-r1", question_seq: 2, artifact_sha256: "nope", approved_at: "2026-09-13T10:00:00Z", by: "operator console" });
	assert.equal(bad.ok, false);
});
