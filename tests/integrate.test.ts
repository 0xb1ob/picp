/**
 * cp-uug acceptance: the merge sequence as a parent-side state machine.
 *
 * Every test here is hermetic — `gh` and `git` are an injected function, the
 * teardown gate and the ledger are injected objects, and nothing shells out.
 * That is the same discipline `tests/merges.test.ts` uses, and for the same
 * reason: the subject is *what was observed*, never what a caller claimed.
 *
 * The invariants under test, in one list:
 *
 *  - a merge happens only for a PR whose CI finished green **on the pushed
 *    head**, and only with a human's authorization **for that same head**;
 *  - the order is merge (no `--delete-branch`) → record → sync → teardown →
 *    delete head → close, because deleting first is what forces `force`;
 *  - a conflict or a red head is handed back to the job's own implementer,
 *    exactly once, and never re-dispatched;
 *  - nothing is mutated on any refusal path;
 *  - `advance` is idempotent and resumable: it recomputes the due step from
 *    facts, so calling it twice, or after a parent restart, is safe.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore, deriveFromCheckpoints, isDerivedAwaitingId } from "../src/awaiting.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { detectCiWait } from "../src/ci-wait.ts";
import {
	type Checkpoint,
	DEFAULT_ORIGIN,
	type DiffVerdict,
	type Envelope,
	type EnvelopeRecord,
	REVIEW_MAX_ATTEMPTS,
	DiffVerdictSchema,
	EMPTY_USAGE,
	isoTimestamp,
	paths,
	parseCheckpointAwaitingId,
	type Receipt,
	SALVAGE_PRUNE_MAX,
	SALVAGE_REF_PREFIX,
	SCHEMA_VERSION,
	validate,
	WORKER_FORBIDDEN_TOOLS,
} from "../src/contracts.ts";
import { EscalationStore } from "../src/escalation.ts";
import { readFinalFixRecord, requestFinalFix, resolveFinalFix } from "../src/final-fix.ts";
import { readReviewPassHeads } from "../src/merge-ask.ts";
import { FleetStore } from "../src/fleet.ts";
import { IntegrationHolds } from "../src/integration-hold.ts";
import { MainCiStore } from "../src/main-ci.ts";
import bridgeExtension, { saveOperatorTarget } from "../extensions/cp-bridge/index.ts";
import { registerIntegrateTools } from "../extensions/command-post/tools-integrate.ts";
import { reopenEnvelopeSlot } from "../src/supersede.ts";
import {
	conflictMessage,
	formatIntegration,
	Integrator,
	isSalvageRef,
	type LedgerLike,
	type TeardownLike,
} from "../src/integrate.ts";
import type { CommandRunner } from "../src/merges.ts";
import { trackersFile } from "../src/trackers/config.ts";
import { MergeStore } from "../src/merges.ts";
import { RunRegistry } from "../src/runs.ts";
import type { TeardownResult } from "../src/teardown.ts";
import { createScratchHome, readRunEvents } from "./harness/index.ts";

const BR = "cp-int1";
const PR_URL = "https://github.com/o/r/pull/61";
const HEAD_A = "aaaaaaaaaaaa1111111111111111111111111111";
const HEAD_B = "bbbbbbbbbbbb2222222222222222222222222222";
const MERGE_COMMIT = "cccccccccccc3333333333333333333333333333";
const BASE_TIP = "dddddddddddd4444444444444444444444444444";
const FORK_POINT = "eeeeeeeeeeee5555555555555555555555555555";
const PR_RECEIPT: Receipt = { kind: "pr", status: "open", title: `PR for ${BR}`, url: PR_URL };

function writeReviewPass(
	home: string,
	head: string,
	extra: {
		attempt?: number;
		equivalentTo?: { head_sha: string; attempt: number };
		verdict?: "pass" | "revise" | "escalate";
		cause?: "policy" | "flagged" | "operational" | "operational_persistent";
		truncated?: boolean;
	} = {},
): void {
	const attempt = extra.attempt ?? 1;
	const verdictKind = extra.verdict ?? "pass";
	const verdict = {
		schema_version: SCHEMA_VERSION,
		job_id: BR,
		attempt,
		verdict: verdictKind,
		cause: extra.cause ?? (verdictKind === "revise" || verdictKind === "escalate" ? "policy" : null),
		flags: { destructive_scope: false, scope_growth: false, blocking_unknowns: false },
		reasons: ["the diff does what the brief asked"],
		decided_at: "2026-09-05T10:30:21Z",
		head_sha: head,
		diff_stat: { files: 1, truncated: extra.truncated ?? false },
		...(extra.equivalentTo ? { equivalent_to: extra.equivalentTo } : {}),
	};
	const parsed = validate<DiffVerdict>(DiffVerdictSchema, verdict);
	assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
	const file = extra.equivalentTo
		? join(home, paths.reviewEquivalenceFile(BR, head))
		: join(home, paths.reviewFile(BR, attempt));
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify(verdict));
}

/** Exactly the fields this module asks `gh pr view` for. */
interface PrJson {
	number?: number;
	url?: string;
	state?: string;
	mergeable?: string;
	mergeStateStatus?: string;
	reviewDecision?: string;
	isDraft?: boolean;
	autoMergeRequest?: unknown;
	mergedAt?: string;
	mergeCommit?: { oid: string };
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
}

interface GhFail {
	fail: string;
	status?: number;
}

type CiRunJson = { status: string; conclusion: string | null; headSha: string; workflowName?: string };

interface World {
	/** What `gh pr view` answers, or a failure. */
	pr: PrJson | GhFail;
	/** What `gh run list` answers, or a failure. */
	runs: CiRunJson[] | GhFail;
	/** exit of `git merge-base --is-ancestor origin/<base> origin/<branch>`; `"unreadable"` is exit 128. */
	ancestor: boolean | "unreadable";
	/** Is the head branch still on origin? */
	branchOnRemote: boolean;
	updateBranchFails?: string;
	mergeFails?: string;
	deleteFails?: string;
	/** Worktree facts, for the sync step. */
	worktreeHead?: string;
	worktreeDirty?: boolean;
	/** `git rev-list --count <remote>..HEAD`: commits origin does not have. */
	worktreeAhead?: number;
	/** That count could not be read at all. */
	worktreeAheadFails?: string;
	/**
	 * What `git ls-remote --heads origin <branch>` answers **inside the lease**
	 * (the sync step's own question, asked in the worktree rather than in the
	 * clone). Defaults to `HEAD_A`; `""` is "origin has no such ref".
	 */
	syncRemoteSha?: string;
	/** That question could not be answered at all: origin unreachable. */
	syncLsRemoteFails?: string;
	/**
	 * The losslessness proof's questions (cp-8vf6), asked only when the worktree
	 * holds commits origin does not: what origin names for the **base**, where
	 * the two heads fork from it, and what each head's cumulative diff is.
	 */
	syncBaseSha?: string;
	syncBaseLsRemoteFails?: string;
	mergeBaseSha?: string;
	mergeBaseFails?: string;
	/**
	 * Cumulative diff text per revision. The default gives each head a *different*
	 * diff, so the proof fails and the refusal is the one this module always made
	 * — a test that wants the reset has to say the diffs match.
	 */
	cumulativeDiff?: Record<string, string>;
	diffFails?: string;
	patchIdFails?: string;
	/** `git patch-id` answered, but with nothing usable. */
	patchIdEmpty?: boolean;
	updateRefFails?: string;
	/**
	 * The rescue refs `git for-each-ref refs/cp-salvage/` reports in the clone,
	 * as `[ref, sha]` pairs — the input to the retention policy (cp-wcy5).
	 * Defaults to none, so every pre-existing test sees no prune work at all.
	 */
	salvageRefs?: Array<[string, string]>;
	/** That listing could not be read. */
	forEachRefFails?: string;
	/**
	 * `git fetch origin <base>` in the **clone** — the prune's own fetch, the one
	 * that makes the base tip's objects present for `merge-base`. Kept separate
	 * from every other fetch in this module so a test can fail exactly it.
	 */
	baseFetchFails?: string;
	/** What origin answers for the *base* in the clone: the prune's own base tip. */
	pruneBaseSha?: string;
	pruneBaseLsRemoteFails?: string;
	/** Is a rescue ref's commit an ancestor of the base tip? Per sha; default no. */
	reachableFromBase?: Record<string, boolean>;
	/** `git merge-base --is-ancestor` cannot answer for these shas at all. */
	ancestorUnreadable?: string[];
	/** `git update-ref -d` refuses. */
	deleteRefFails?: string;
	/**
	 * `refs/remotes/origin/<branch>` does not resolve in the lease — the
	 * `--single-branch` / `--depth` clone, and the reason the reset must name a
	 * sha. Any `git reset --hard <rev>` whose rev is not a 40-hex sha fails, the
	 * way real git fails with "ambiguous argument".
	 */
	trackingRefUnresolvable?: boolean;
	/**
	 * When set, the SECOND `gh pr view` call (the cp-e0c permission re-read)
	 * reports this head instead of `world.pr.headRefOid` — simulating a
	 * force-push landing between CI verification and the permission check.
	 */
	permHead?: string;
	/**
	 * The head the *server* has when `gh pr merge` runs — a force-push that
	 * landed after the permission read or after a human answered the
	 * authorization. When it differs from the argv's `--match-head-commit`
	 * value, the mock refuses the merge the way real `gh` does (cp-n1a).
	 */
	remoteHeadAtMerge?: string;
	/** rules endpoint response for `gh api .../rules/branches/<base>`, or a failure. */
	rules?: unknown[] | GhFail;
	/**
	 * What `gh api repos/{owner}/{repo}/actions/workflows` answers
	 * (cp-no-ci-repo-derived): an object (serialised), a raw stdout string, or a
	 * `GhFail`. The default is a repository that **has** a workflow, so every test
	 * written before this probe existed sees the behaviour it was written against.
	 */
	workflows?: unknown;
	/** `gh pr ready` refuses with this stderr (jje.5). */
	readyFails?: string;
	/** A push lands across `gh pr ready`: every later `gh pr view` reports this head. */
	readyMovesHead?: string;
	/** `gh pr ready --undo` refuses with this stderr. */
	undoFails?: string;
}

/** The open, clean, current PR every test starts from. */
function openPr(): PrJson {
	return {
		number: 61,
		url: PR_URL,
		state: "OPEN",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		headRefName: BR,
		headRefOid: HEAD_A,
		baseRefName: "main",
	};
}

function defaultWorld(overrides: Partial<World> = {}): World {
	return {
		pr: openPr(),
		runs: [{ status: "completed", conclusion: "success", headSha: HEAD_A, workflowName: "ci" }],
		ancestor: true,
		branchOnRemote: true,
		...overrides,
	};
}

/** Everything `gh`/`git` were asked, in order, as `"<bin> <args…>"`. */
type Calls = string[];

/** A deterministic stand-in for `git patch-id`: same bytes in, same id out. */
function fakePatchId(diff: string): string {
	return createHash("sha1").update(diff).digest("hex");
}

function runnerFor(world: World, calls: Calls, worktree?: string): CommandRunner {
	let prViewCalls = 0;
	let readied = false;
	let readyCalled = false;
	const runner: CommandRunner = async (cwd, bin, args, options) => {
		const line = `${bin} ${args.join(" ")}`;
		calls.push(line);
		if (bin === "gh") {
			if (args[0] === "pr" && args[1] === "view") {
				if ("fail" in world.pr) return { status: world.pr.status ?? 1, stdout: "", stderr: world.pr.fail };
				prViewCalls += 1;
				let pr = prViewCalls >= 2 && world.permHead ? { ...world.pr, headRefOid: world.permHead } : world.pr;
				if (readyCalled) pr = { ...pr, isDraft: !readied, ...(world.readyMovesHead ? { headRefOid: world.readyMovesHead } : {}) };
				return { status: 0, stdout: JSON.stringify(pr), stderr: "" };
			}
			if (args[0] === "pr" && args[1] === "ready") {
				if (args[2] === "--undo") {
					if (world.undoFails) return { status: 1, stdout: "", stderr: world.undoFails };
					readied = false;
					return { status: 0, stdout: "", stderr: "" };
				}
				if (world.readyFails) return { status: 1, stdout: "", stderr: world.readyFails };
				readied = readyCalled = true;
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "api" && args[1]?.includes("actions/workflows")) {
				const answer = world.workflows ?? { total_count: 1, workflows: [{ id: 1, name: "ci" }] };
				if (typeof answer === "object" && answer !== null && "fail" in answer) {
					const failure = answer as GhFail;
					return { status: failure.status ?? 1, stdout: "", stderr: failure.fail };
				}
				return { status: 0, stdout: typeof answer === "string" ? answer : JSON.stringify(answer), stderr: "" };
			}
			if (args[0] === "api" && args[1]?.includes("rules/branches")) {
				if (world.rules && "fail" in (world.rules as GhFail)) return { status: 1, stdout: "", stderr: (world.rules as GhFail).fail };
				return { status: 0, stdout: JSON.stringify(world.rules ?? []), stderr: "" };
			}
			if (args[0] === "pr" && args[1] === "update-branch") {
				return world.updateBranchFails
					? { status: 1, stdout: "", stderr: world.updateBranchFails }
					: { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "pr" && args[1] === "merge") {
				if (world.mergeFails) return { status: 1, stdout: "", stderr: world.mergeFails };
				// The head binding is server-side: GitHub refuses the merge when the
				// branch has moved past the commit the argv names (cp-n1a). A merge
				// issued *without* `--match-head-commit` is not bound at all, and so
				// would silently land the new head here — which is the bug.
				const bound = args.includes("--match-head-commit") ? args[args.indexOf("--match-head-commit") + 1] : undefined;
				if (world.remoteHeadAtMerge && bound && bound !== world.remoteHeadAtMerge) {
					return {
						status: 1,
						stdout: "",
						stderr: "failed to merge pull request: Head branch was modified. Review and try the merge again. (HTTP 409)",
					};
				}
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "run" && args[1] === "list") {
				if ("fail" in world.runs) return { status: 1, stdout: "", stderr: world.runs.fail };
				return { status: 0, stdout: JSON.stringify(world.runs), stderr: "" };
			}
			throw new Error(`unexpected gh call: ${line}`);
		}
		if (bin === "git") {
			if (args[0] === "fetch") {
				// `git fetch origin main` in the clone is the retention policy's own
				// (cp-wcy5); `--prune` is the freshness check's and `<BR>` is the sync
				// step's, and neither is what `baseFetchFails` is about.
				const target = args[args.length - 1] ?? "";
				if (world.baseFetchFails && cwd !== worktree && target !== BR && target !== "--prune") {
					return { status: 128, stdout: "", stderr: world.baseFetchFails };
				}
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "merge-base" && args.includes("--is-ancestor")) {
				// Two different questions share this argv shape. The freshness check asks
				// about two *branch names*; the retention policy (cp-wcy5) asks whether a
				// rescue ref's commit is an ancestor of the sha origin named for the base.
				const subject = args[args.indexOf("--is-ancestor") + 1] ?? "";
				if (!subject.startsWith("origin/")) {
					if ((world.ancestorUnreadable ?? []).includes(subject)) {
						return { status: 128, stdout: "", stderr: "fatal: Not a valid object name" };
					}
					return { status: world.reachableFromBase?.[subject] ? 0 : 1, stdout: "", stderr: "" };
				}
				if (world.ancestor === "unreadable") return { status: 128, stdout: "", stderr: "fatal: Not a valid object name" };
				return { status: world.ancestor ? 0 : 1, stdout: "", stderr: "" };
			}
			if (args[0] === "for-each-ref") {
				if (world.forEachRefFails) return { status: 128, stdout: "", stderr: world.forEachRefFails };
				// git honours `--sort=refname`, and the prune's bound is a slice of this
				// listing, so the mock honours it too — otherwise a test asserting *which*
				// refs the bound covers would be asserting insertion order.
				const refs = [...(world.salvageRefs ?? [])];
				if (args.includes("--sort=refname")) refs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
				const lines = refs.map(([ref, sha]) => `${ref} ${sha}`);
				return { status: 0, stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "", stderr: "" };
			}
			// The proof's fork point: `git merge-base <base tip> <rev>`, two revisions
			// and no flag.
			if (args[0] === "merge-base") {
				return world.mergeBaseFails
					? { status: 128, stdout: "", stderr: world.mergeBaseFails }
					: { status: 0, stdout: `${world.mergeBaseSha ?? FORK_POINT}\n`, stderr: "" };
			}
			if (args[0] === "diff") {
				if (world.diffFails) return { status: 128, stdout: "", stderr: world.diffFails };
				const rev = args[args.length - 1] ?? "";
				const text = world.cumulativeDiff?.[rev] ?? `--- a/x\n+++ b/x\n+cumulative diff of ${rev}\n`;
				return { status: 0, stdout: text, stderr: "" };
			}
			if (args[0] === "patch-id") {
				if (world.patchIdFails) return { status: 128, stdout: "", stderr: world.patchIdFails };
				if (world.patchIdEmpty) return { status: 0, stdout: "\n", stderr: "" };
				// Real `git patch-id` reads the diff on stdin and nothing else, so a mock
				// that ignored stdin could not tell two different diffs apart — which is
				// the whole question this step decides.
				const stdin = options?.stdin ?? "";
				if (stdin.trim().length === 0) return { status: 0, stdout: "", stderr: "" };
				return { status: 0, stdout: `${fakePatchId(stdin)} ${FORK_POINT}\n`, stderr: "" };
			}
			if (args[0] === "update-ref") {
				if (args[1] === "-d") {
					return world.deleteRefFails
						? { status: 1, stdout: "", stderr: world.deleteRefFails }
						: { status: 0, stdout: "", stderr: "" };
				}
				return world.updateRefFails
					? { status: 128, stdout: "", stderr: world.updateRefFails }
					: { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "ls-remote") {
				// The sync step asks origin from *inside the lease*; every other
				// ls-remote in this module runs in the clone. Keeping them apart is what
				// lets a test say "origin could not be asked for the worktree's branch"
				// without also deleting the head branch for the delete_head step.
				if (worktree !== undefined && cwd === worktree) {
					// The proof asks origin for the *base* tip from the same place, and it
					// has to be answerable (or unanswerable) on its own.
					if (args[args.length - 1] !== BR) {
						if (world.syncBaseLsRemoteFails) return { status: 128, stdout: "", stderr: world.syncBaseLsRemoteFails };
						const base = world.syncBaseSha ?? BASE_TIP;
						return { status: 0, stdout: base.length > 0 ? `${base}\trefs/heads/main\n` : "", stderr: "" };
					}
					if (world.syncLsRemoteFails) return { status: 128, stdout: "", stderr: world.syncLsRemoteFails };
					const sha = world.syncRemoteSha ?? HEAD_A;
					return { status: 0, stdout: sha.length > 0 ? `${sha}\trefs/heads/${BR}\n` : "", stderr: "" };
				}
				// In the clone: the head branch (`#branchOnRemote`), or the base tip the
				// retention policy proves reachability against.
				if (args[args.length - 1] !== BR) {
					if (world.pruneBaseLsRemoteFails) return { status: 128, stdout: "", stderr: world.pruneBaseLsRemoteFails };
					const base = world.pruneBaseSha ?? BASE_TIP;
					return { status: 0, stdout: base.length > 0 ? `${base}\trefs/heads/main\n` : "", stderr: "" };
				}
				return {
					status: 0,
					stdout: world.branchOnRemote ? `${HEAD_A}\trefs/heads/${BR}\n` : "",
					stderr: "",
				};
			}
			if (args[0] === "rev-parse") return { status: 0, stdout: `${world.worktreeHead ?? HEAD_A}\n`, stderr: "" };
			if (args[0] === "rev-list") {
				return world.worktreeAheadFails
					? { status: 128, stdout: "", stderr: world.worktreeAheadFails }
					: { status: 0, stdout: `${world.worktreeAhead ?? 0}\n`, stderr: "" };
			}
			if (args[0] === "status") return { status: 0, stdout: world.worktreeDirty ? " M src/x.ts\n" : "", stderr: "" };
			if (args[0] === "reset") {
				const rev = args[args.length - 1] ?? "";
				if (world.trackingRefUnresolvable && !/^[0-9a-f]{40}$/.test(rev)) {
					return {
						status: 128,
						stdout: "",
						stderr: `fatal: ambiguous argument '${rev}': unknown revision or path not in the working tree.`,
					};
				}
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[0] === "push") {
				return world.deleteFails ? { status: 1, stdout: "", stderr: world.deleteFails } : { status: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected git call: ${line}`);
		}
		throw new Error(`unexpected binary: ${bin}`);
	};
	return runner;
}

interface Bench {
	home: string;
	fleet: FleetStore;
	runs: RunRegistry;
	calls: Calls;
	sent: Array<{ jobId: string; message: string }>;
	closed: Array<{ id: string; reason: string }>;
	teardowns: string[];
	worktree: string;
	integrator(world?: Partial<World>, options?: BenchOptions): Integrator;
	mergeCheckpoints(): CheckpointStore;
	awaiting(): AwaitingStore;
	approve(head: string): void;
}

interface BenchOptions {
	run?: CommandRunner;
	/** `undefined` means no sender is wired at all. */
	send?: (jobId: string, message: string) => Promise<{ receipt: string; error?: string }>;
	teardown?: TeardownLike;
	ledger?: LedgerLike;
	noSender?: boolean;
	/** `false` — the default — means the real AwaitingStore, at the bench's home. */
	noAwaiting?: boolean;
}

async function benchOf(
	t: { after(fn: () => void | Promise<void>): void },
	jobPatch: Record<string, unknown> = {},
	options: { reviewHead?: string | false } = {},
): Promise<Bench> {
	const home = createScratchHome();
	const fleet = new FleetStore({ home: home.path });
	const runs = new RunRegistry(home.path);
	t.after(() => {
		runs.closeAll();
		home.cleanup();
	});
	const calls: Calls = [];
	const sent: Array<{ jobId: string; message: string }> = [];
	const closed: Array<{ id: string; reason: string }> = [];
	const teardowns: string[] = [];
	const worktree = join(home.path, "worktrees", BR);

	await fleet.add({
		job_id: BR,
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "held",
		reported_at: isoTimestamp(),
		worker: {
			pid: process.pid,
			session_id: "s",
			session_file: join(home.path, "s.jsonl"),
			profile: "implementer",
			role: "implementer",
			model: "mock/model",
			started_at: isoTimestamp(),
		},
		worktree,
		branch: BR,
		dispatched_at: isoTimestamp(),
		usage: EMPTY_USAGE,
		receipts: [PR_RECEIPT],
		...jobPatch,
	});
	if (options.reviewHead !== false) writeReviewPass(home.path, options.reviewHead ?? HEAD_A);

	const defaultTeardown: TeardownLike = {
		async teardown(jobId) {
			teardowns.push(jobId);
			await fleet.patch(jobId, { phase: "done", closed_reason: "gated", closed_at: isoTimestamp() });
			return {
				job_id: jobId,
				torn_down: true,
				reason: "pushed",
				worktree,
				branch: BR,
				lease_returned: true,
				artifacts_removed: false,
			} satisfies TeardownResult;
		},
	};

	return {
		home: home.path,
		fleet,
		runs,
		calls,
		sent,
		closed,
		teardowns,
		worktree,
		mergeCheckpoints: () => new CheckpointStore(home.path, { kind: "merge" }),
		awaiting: () => new AwaitingStore({ home: home.path }),
		/**
		 * A human answered the merge authorization for this head. The question is
		 * seeded first because that is the real sequence: `cp_integrate` asks (the
		 * record is written `pending` before anyone is asked), and only
		 * `CheckpointStore.decide` — a human channel — ever answers it.
		 */
		approve(head: string) {
			const store = new CheckpointStore(home.path, { kind: "merge" });
			const scope = head.slice(0, 12);
			store.request({ jobId: BR, scope, question: `Merge ${PR_URL} for ${BR} at ${scope}?` });
			store.decide(BR, true, { by: "operator command", scope });
		},
		integrator(worldPatch = {}, options = {}) {
			const world = defaultWorld(worldPatch);
			const run = options.run ?? runnerFor(world, calls, worktree);
			const merges = new MergeStore({ home: home.path, fleet, runs, run });
			return new Integrator({
				home: home.path,
				fleet,
				merges,
				teardown: options.teardown ?? defaultTeardown,
				ledger: () => options.ledger ?? {
					async close(id, reason) {
						closed.push({ id, reason });
						return {};
					},
				},
				projectDir: () => home.path,
				runs,
				run,
				...(options.noAwaiting ? {} : { awaiting: () => new AwaitingStore({ home: home.path }) }),
				...(options.noSender
					? {}
					: {
							send:
								options.send ??
								(async (jobId, message) => {
									sent.push({ jobId, message });
									return { receipt: "delivered" };
								}),
						}),
			});
		},
	};
}

/**
 * The `--match-head-commit` binding as it appears in a captured `gh pr merge`
 * argv: where the flag is, and the sha immediately after it. `undefined` means
 * the merge was not bound to any head at all — the cp-n1a defect.
 */
function matchHeadBinding(mergeCall: string): { flagAt: number; head: string | undefined } | undefined {
	const args = mergeCall.split(" ");
	const flagAt = args.indexOf("--match-head-commit");
	if (flagAt < 0) return undefined;
	return { flagAt, head: args[flagAt + 1] };
}

/** The PR as GitHub reports it once it has merged. */
function mergedPr(head = HEAD_A): PrJson {
	return {
		number: 61,
		url: PR_URL,
		state: "MERGED",
		mergeable: "MERGEABLE",
		mergedAt: "2026-09-01T10:00:00Z",
		mergeCommit: { oid: MERGE_COMMIT },
		headRefName: BR,
		headRefOid: head,
		baseRefName: "main",
	};
}

// ---------------------------------------------------------------------------
// 1. the happy path, one call at a time
// ---------------------------------------------------------------------------

test("a durable operator hold prevents a green, reviewed PR from merging", async (t) => {
	const b = await benchOf(t);
	const file = join(b.home, paths.runDir(BR), "integration-hold.json");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ job_id: BR, reason: "browser QA", held_at: isoTimestamp() }));
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "wait");
	assert.match(result.reason, /browser QA/);
	assert.equal(b.calls.some((call) => call.startsWith("gh pr merge")), false);
});

test("integration hold persists across instances; explicit release resumes with fresh gates", async (t) => {
	const b = await benchOf(t);
	const holds = new IntegrationHolds(b.home);
	holds.hold(BR, "  browser QA  ");
	assert.equal(new IntegrationHolds(b.home).get(BR)?.reason, "browser QA");
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "wait");
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "wait");
	assert.equal(b.calls.length, 0);
	new IntegrationHolds(b.home).release(BR);
	holds.release(BR); // Releasing twice is harmless.
	assert.equal(holds.get(BR), undefined);
	const pending = await b.integrator({ runs: [{ status: "in_progress", conclusion: null, headSha: HEAD_A }] }).advance({ jobId: BR });
	assert.equal(pending.next, "wait");
	assert.equal(b.calls.some((call) => call.startsWith("gh pr merge")), false);
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "advance");
	assert.equal(b.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
});

for (const permission of ["CLEAN", undefined]) {
	test(`a hold arriving during CI prevents the ${permission === "CLEAN" ? "repo-derived" : "human-checkpoint"} merge`, async (t) => {
		const b = await benchOf(t);
		b.approve(HEAD_A);
		const holds = new IntegrationHolds(b.home);
		const world = defaultWorld({ pr: { ...openPr(), mergeStateStatus: permission } });
		const run = runnerFor(world, b.calls, b.worktree);
		const integration = b.integrator({}, {
			run: async (cwd, bin, args, options) => {
				const result = await run(cwd, bin, args, options);
				if (bin === "gh" && args[0] === "run") holds.hold(BR, "QA requested during CI read");
				return result;
			},
		});
		const result = await integration.advance({ jobId: BR });
		assert.equal(result.next, "wait");
		assert.match(result.reason, /QA requested during CI read/);
		assert.equal(b.calls.some((call) => call.startsWith("gh pr merge")), false);
		holds.release(BR);
		const resumed = await b.integrator({ pr: world.pr }).advance({ jobId: BR });
		assert.equal(resumed.next, "advance");
		assert.equal(resumed.record.merge_authority?.kind, permission === "CLEAN" ? "repo_derived" : "human_checkpoint");
	});
}

test("invalid or unreadable integration holds fail closed and can be explicitly released", async (t) => {
	const b = await benchOf(t);
	const holds = new IntegrationHolds(b.home);
	for (const value of ["{", "{}", JSON.stringify({ job_id: "other-job", reason: "QA", held_at: isoTimestamp() })]) {
		holds.hold(BR, "QA");
		writeFileSync(holds.file(BR), value);
		const result = await b.integrator().advance({ jobId: BR });
		assert.equal(result.next, "wait");
		assert.match(result.reason, /invalid integration hold|integration hold unreadable/);
		assert.deepEqual(b.calls, []);
		holds.release(BR);
	}
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "advance");
});

test("integration holds reject missing jobs, unsafe ids, non-PR jobs and empty reasons", async (t) => {
	const b = await benchOf(t);
	const holds = new IntegrationHolds(b.home);
	assert.throws(() => holds.hold("missing", "QA"), /no fleet record/);
	assert.throws(() => holds.release("missing"), /no fleet record/);
	assert.throws(() => holds.hold("../escape", "QA"));
	assert.throws(() => holds.hold(BR, "  "), /reason/);
	assert.throws(() => holds.hold(BR, "x".repeat(2001)), /reason/);
	assert.equal(holds.get(BR), undefined);
	await b.fleet.patch(BR, { delivery: "local" });
	assert.throws(() => holds.hold(BR, "QA"), /delivery:pr ship job/);
	assert.throws(() => holds.release(BR), /delivery:pr ship job/);
});

const MAIN_RED_REASON = `${BR}: main is red since ${HEAD_B.slice(0, 12)}: structure; rebase onto origin/main and pass CI to merge`;

test("k52: a latched-red main holds the merge unless the head contains origin/main and its own CI is green", async (t) => {
	const b = await benchOf(t);
	const store = new MainCiStore({ home: b.home });
	store.setRed("demo", HEAD_B, { failing: "structure" });
	for (const world of [{ ancestor: false }, { ancestor: "unreadable" as const }, { runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] }, { runs: [] }]) {
		const result = await b.integrator(world).advance({ jobId: BR });
		assert.equal(result.next, "wait", JSON.stringify(world));
		assert.equal(result.reason, MAIN_RED_REASON);
	}
	assert.equal(b.calls.some((call) => call.startsWith("gh pr merge")), false);
	// No merge-authorization fallback around the latch: the workflows probe that precedes it never ran.
	assert.equal(b.calls.some((call) => call.includes("actions/workflows")), false);
	assert.equal(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }), undefined);
	// Fix-forward: origin/main is an ancestor of the branch and CI is green on the pushed head.
	const fix = await b.integrator().advance({ jobId: BR });
	assert.notEqual(fix.next, "wait");
	assert.ok(b.calls.includes(`git merge-base --is-ancestor origin/main origin/${BR}`));
	assert.ok(fix.facts.some((fact) => /fix-forward/.test(fact)));
});

test("k52: another project's latch, a corrupt main-ci.json, and a cleared latch never block", async (t) => {
	const b = await benchOf(t);
	const store = new MainCiStore({ home: b.home });
	store.setRed("some-other-project", HEAD_B);
	assert.notEqual((await b.integrator({ ancestor: false }).advance({ jobId: BR })).next, "wait");
	const c = await benchOf(t);
	const corruptStore = new MainCiStore({ home: c.home });
	corruptStore.setRed("demo", HEAD_B);
	writeFileSync(corruptStore.file, "{not json");
	const corrupt = await c.integrator({ ancestor: false }).advance({ jobId: BR });
	assert.notEqual(corrupt.next, "wait");
	assert.ok(corrupt.facts.some((fact) => fact.includes("main-ci.json unreadable")));
});

test("k52: setRed twice then clear resumes the ordinary flow", async (t) => {
	const b = await benchOf(t);
	const store = new MainCiStore({ home: b.home });
	store.setRed("demo", HEAD_B, { failing: "structure" });
	store.setRed("demo", HEAD_A, { failing: "other" });
	assert.equal((await b.integrator({ ancestor: false }).advance({ jobId: BR })).reason, MAIN_RED_REASON);
	store.clear("demo");
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "advance");
	assert.equal(b.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
});

type HoldTool = {
	execute(id: string, params: Record<string, unknown>, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<{
		content: Array<{ text: string }>;
		details: Record<string, unknown>;
		isError?: boolean;
	}>;
};

test("operator bridge writes a hold without a running parent; parent status sees it and release resumes", async (t) => {
	const b = await benchOf(t);
	const previous = process.env.PI_HOME;
	process.env.PI_HOME = join(b.home, "operator-pi");
	t.after(() => { if (previous === undefined) delete process.env.PI_HOME; else process.env.PI_HOME = previous; });
	saveOperatorTarget({ home: b.home, mode: "multi", hostPid: 0, parentPid: 0 });
	const tools = new Map<string, HoldTool>();
	bridgeExtension({
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		registerCommand: () => {},
		on: () => {},
		sendMessage: () => assert.fail("a hold must not need a parent turn"),
	} as never);
	const bridge = tools.get("cp_parent")!;
	const missing = await bridge.execute("missing", { action: "integration_hold" });
	assert.equal(missing.isError, true);
	const empty = await bridge.execute("empty", { action: "integration_hold", job_id: BR, reason: " " });
	assert.equal(empty.isError, true);
	const held = await bridge.execute("hold", { action: "integration_hold", job_id: BR, reason: "operator browser QA" });
	assert.notEqual(held.isError, true);
	assert.equal((await b.integrator().advance({ jobId: BR })).next, "wait");
	registerIntegrateTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as never, {
		commandPost: () => ({ home: b.home, integrator: b.integrator(), integrate: (request: { jobId: string }) => b.integrator().advance(request) }),
		setLive: () => {}, refreshWidget: () => {},
	} as never);
	const parent = tools.get("cp_integrate")!;
	const invoke = (params: Record<string, unknown>) => parent.execute("parent", { job_id: BR, ...params }, undefined, undefined, {});
	const status = await invoke({ action: "status" });
	assert.equal((status.details.hold as { reason: string }).reason, "operator browser QA");
	await invoke({ action: "release" });
	await invoke({ action: "hold", reason: "parent QA" });
	assert.equal(new IntegrationHolds(b.home).get(BR)?.reason, "parent QA");
	assert.equal((await invoke({ action: "advance" })).details.next, "wait");
	await bridge.execute("release", { action: "integration_release", job_id: BR });
	assert.equal((await invoke({ action: "advance" })).details.next, "advance");
	assert.equal(b.calls.filter((call) => call.startsWith("gh pr merge")).length, 1);
});

test("cp_integrate appends the tracker write-back line on next: done, and only then (laf)", async (t) => {
	const b = await benchOf(t);
	const file = trackersFile(b.home);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, JSON.stringify({ schema_version: 1, connections: [
		{ id: "demo-beads", project: "demo", adapter: "beads", endpoint: "/dbs/demo.db", intake_enabled: false, write_enabled: true, status: "active", connected_at: "2026-09-01T00:00:00Z" },
	] }));
	const job = { id: BR, title: "linked", status: "closed", labels: ["project:demo", "kind:ship", "delivery:pr"], tracker: { connection_id: "demo-beads", item_id: "b-9" } };
	let calls = 0;
	const tools = new Map<string, HoldTool>();
	registerIntegrateTools({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never) } as never, {
		commandPost: () => ({
			home: b.home, registry: {}, ledger: () => ({ read: () => ({ jobs: [job] }), normalizeRef: (ref: string) => ref }),
			// Call 1 merges; call 2 records the receipt and runs to done.
			integrate: (request: { jobId: string }) => (calls++ === 0 ? b.integrator() : b.integrator({ pr: mergedPr() })).advance(request),
		}),
		setLive: () => {}, refreshWidget: () => {},
	} as never);
	const invoke = () => tools.get("cp_integrate")!.execute("call", { job_id: BR }, undefined, undefined, {});
	const merged = await invoke();
	assert.equal(merged.details.next, "advance");
	assert.ok(!merged.content[0]!.text.includes("tracker write-back"), merged.content[0]!.text);
	const done = await invoke();
	assert.equal(done.details.next, "done");
	assert.ok(done.content[0]!.text.includes(`\n  tracker write-back: demo-beads/b-9 closes with ${PR_URL} on the next write-back tick`), done.content[0]!.text);
});

test("permitted (mergeStateStatus CLEAN) and green merges immediately, with no checkpoint at all", async (t) => {
	const b = await benchOf(t);

	// Call 1: GitHub itself would take this merge unforced (mergeStateStatus
	// CLEAN), and CI is green — merge directly, no checkpoint minted.
	const merged = await b.integrator().advance({ jobId: BR });
	assert.equal(merged.step, "merge");
	assert.equal(merged.next, "advance");
	const mergeCall = b.calls.find((line) => line.startsWith("gh pr merge"));
	assert.ok(mergeCall, "the merge was not issued");
	assert.ok(mergeCall.includes("--squash"));
	const binding = matchHeadBinding(mergeCall);
	assert.ok(binding, "the head binding must be server-side and atomic");
	assert.equal(binding.head, HEAD_A, "--match-head-commit must be followed by the verified head");
	assert.ok(!mergeCall.includes("--delete-branch"), "deleting the head here is what forces `force` at teardown");
	assert.equal(
		b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }),
		undefined,
		"a permitted merge never mints a checkpoint",
	);
	assert.equal(merged.record.merge_authority?.kind, "repo_derived");
	assert.equal(merged.record.merge_authority?.merge_state_status, "CLEAN");

	// Call 2: record → sync → teardown → delete head → close.
	const done = await b.integrator({ pr: mergedPr() }).advance({ jobId: BR });
	assert.equal(done.step, "done");
	assert.equal(done.next, "done");
	assert.equal(done.merge?.recorded, true);
	assert.equal(done.merge?.receipt.authority?.kind, "repo_derived");
	assert.equal(b.teardowns.length, 1);
	assert.deepEqual(b.closed, [{ id: BR, reason: `merged: ${PR_URL}` }]);

	// The three end-state facts the parent is left to check (§Decision 6).
	assert.deepEqual(done.end_state, {
		merge_receipt: true,
		fleet_done: true,
		closed_reason: "gated",
		pr_receipt_status: "merged",
		br_closed: true,
	});
	assert.ok(existsSync(join(b.home, paths.mergeFile(BR))));

	// Ordering: the head branch is deleted only after teardown ran.
	const deleteIndex = b.calls.findIndex((line) => line.startsWith("git push origin --delete"));
	assert.ok(deleteIndex >= 0, "the head branch was never deleted");
	assert.equal(b.teardowns.length, 1);

	const kinds = readRunEvents(b.home, BR).map((event) => event.type);
	assert.ok(kinds.includes("integration_advanced"));
	assert.ok(kinds.includes("integration_permitted"), "the permission decision is journaled before the merge");

	assert.match(formatIntegration(done), /integrate: done -> done/);
	assert.match(formatIntegration(merged), /authority: repo_derived/);
});

test("--admin, --auto and --delete-branch are never issued, across every path in this file", async (t) => {
	const b = await benchOf(t);
	await b.integrator().advance({ jobId: BR });
	await b.integrator({ pr: mergedPr() }).advance({ jobId: BR });
	for (const line of b.calls) {
		assert.ok(!line.includes("--admin"), `an admin bypass was issued: ${line}`);
		assert.ok(!line.includes("--auto"), `auto-merge was armed: ${line}`);
		assert.ok(!line.includes("--delete-branch"), `the head was deleted at merge time: ${line}`);
	}
});

// ---------------------------------------------------------------------------
// 2 + 3. idempotence and resumability
// ---------------------------------------------------------------------------

test("advance after a finished integration is a no-op: no second merge, no second close", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	await b.integrator({ pr: mergedPr() }).advance({ jobId: BR });
	assert.equal(b.closed.length, 1);

	const again = await b.integrator({ pr: mergedPr(), branchOnRemote: false }).advance({ jobId: BR });
	assert.equal(again.next, "done");
	assert.equal(again.merge?.recorded, false, "the receipt already existed");
	assert.equal(b.closed.length, 1, "the br issue is closed once");
	assert.equal(b.teardowns.length, 1, "teardown ran once");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 1);
});

test("a parent restart between merge and record is resumed from what gh reports", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	const merged = await b.integrator().advance({ jobId: BR });
	assert.equal(merged.step, "merge");

	// Simulate the parent dying here: a brand new Integrator, nothing in memory.
	const resumed = await b.integrator({ pr: mergedPr() }).advance({ jobId: BR });
	assert.equal(resumed.next, "done");
	assert.equal(resumed.merge?.recorded, true);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 1, "the merge is not re-issued");
});

// ---------------------------------------------------------------------------
// 4 + 5. authorization is required, and it is bound to one head sha
// ---------------------------------------------------------------------------

test("the fallback checkpoint (an unreadable merge verdict): no authorization, a pending one and a declined one all refuse before any merge", async (t) => {
	const b = await benchOf(t);
	// `mergeStateStatus` absent — the allowlist reads this as "not permitted",
	// never as permission, and falls to the per-head human checkpoint.
	const unreadable = { ...openPr(), mergeStateStatus: undefined };

	const missing = await b.integrator({ pr: unreadable }).advance({ jobId: BR });
	assert.equal(missing.next, "surface");
	assert.match(missing.reason, /evidence is not authorization/);

	const stillPending = await b.integrator({ pr: unreadable }).advance({ jobId: BR });
	assert.equal(stillPending.next, "surface");
	assert.match(stillPending.reason, /awaiting a human/);

	// The pending record was written by the first call above; only a human answers it.
	b.mergeCheckpoints().decide(BR, false, { by: "operator command", scope: HEAD_A.slice(0, 12) });
	const declined = await b.integrator({ pr: unreadable }).advance({ jobId: BR });
	assert.equal(declined.next, "surface");
	assert.match(declined.reason, /declined/);

	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, "gh pr merge must never be invoked");
});

test("an approval names the commit it approves: a moved head has no authorization at all (fallback path)", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	writeReviewPass(b.home, HEAD_B);

	// The implementer force-pushed: the PR head is B now, and CI is green on B.
	// The repo's verdict is unreadable either way, so the fallback still applies.
	const moved = await b
		.integrator({
			pr: { ...openPr(), mergeStateStatus: undefined, headRefOid: HEAD_B },
			runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }],
		})
		.advance({ jobId: BR });

	assert.equal(moved.step, "authorize");
	assert.equal(moved.next, "surface");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, "a sha nobody approved is never merged");
	const forB = b.mergeCheckpoints().get(BR, { scope: HEAD_B.slice(0, 12) });
	assert.equal(forB?.decision, "pending", "a new authorization is requested for the new head");
	const forA = b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) });
	assert.equal(forA?.decision, "approved", "the old answer is never overwritten, and never inherited");
});

test("the fallback merge binds to the authorized head too: --match-head-commit on both paths (cp-n1a)", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);

	// The repo's own verdict is unreadable, so this is the human-checkpoint
	// fallback — the path whose only other tie between the answer and the commit
	// is the checkpoint's file name.
	const merged = await b.integrator({ pr: { ...openPr(), mergeStateStatus: undefined } }).advance({ jobId: BR });
	assert.equal(merged.step, "merge");
	assert.equal(merged.next, "advance");
	assert.equal(merged.record.merge_authority?.kind, "human_checkpoint", "this must be the fallback path, not the repo-derived one");
	assert.equal(merged.record.merge_authority?.checkpoint_file, paths.checkpointFile(BR, "merge", HEAD_A.slice(0, 12)));

	const mergeCall = b.calls.find((line) => line.startsWith("gh pr merge"));
	assert.ok(mergeCall, "the merge was not issued");
	const binding = matchHeadBinding(mergeCall);
	assert.ok(binding, "the fallback merge must bind the head server-side, not only in the checkpoint's file name");
	assert.equal(binding.head, HEAD_A, "--match-head-commit must be followed by the authorized head");
	assert.ok(mergeCall.includes("--squash"));
	assert.ok(!mergeCall.includes("--delete-branch"), "teardown's `pushed` reason needs origin/<branch> to survive");
	assert.ok(!mergeCall.includes("--admin"), "no bypass, ever");
});

test("a force-push landing after the human's answer is refused by the binding: retry, no receipt, nothing merged (cp-n1a)", async (t) => {
	const b = await benchOf(t);
	// A human authorized head A (the checkpoint is keyed by it) …
	b.approve(HEAD_A);
	// … and between that answer and this merge, a force-push landed head B on
	// origin. `gh pr merge --match-head-commit A` is refused server-side, exactly
	// as real `gh` refuses it, so the commit nobody authorized never merges.
	const result = await b
		.integrator({ pr: { ...openPr(), mergeStateStatus: undefined }, remoteHeadAtMerge: HEAD_B })
		.advance({ jobId: BR });

	assert.equal(result.step, "merge");
	assert.equal(result.next, "retry", "a refused merge is operational: the next call re-reads the head");
	assert.match(result.reason, /Nothing was merged and nothing was recorded/);
	assert.match(result.reason, /Head branch was modified/, "the cause is relayed, not hidden behind a generic refusal");
	assert.ok(result.reason.includes(HEAD_A.slice(0, 12)), "the message names the head the merge was bound to");

	// Nothing was mutated: no receipt, no merge authority, no teardown, no close.
	assert.equal(result.merge, undefined, "a refusal records no merge receipt");
	assert.equal(result.record.merge_authority, undefined, "no authority is claimed for a merge that never happened");
	assert.ok(!existsSync(join(b.home, paths.mergeFile(BR))), "no merge receipt file may exist");
	assert.equal(b.teardowns.length, 0);
	assert.deepEqual(b.closed, []);
	const job = b.fleet.get(BR);
	assert.equal(job?.phase, "held", "the job is not marked merged or done");
	assert.equal(job?.receipts?.find((receipt) => receipt.kind === "pr")?.status, "open");

	// The approval for A survives untouched, and A was never re-approved for B.
	assert.equal(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) })?.decision, "approved");
	assert.equal(b.mergeCheckpoints().get(BR, { scope: HEAD_B.slice(0, 12) }), undefined);
});

test("the repo-derived merge is refused the same way when the head moves under it (cp-n1a)", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ remoteHeadAtMerge: HEAD_B }).advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "retry");
	assert.equal(result.merge, undefined);
	assert.ok(!existsSync(join(b.home, paths.mergeFile(BR))));
	assert.equal(b.teardowns.length, 0);
});

// ---------------------------------------------------------------------------
// 6 + 7. freshness, and what a green run actually proves
// ---------------------------------------------------------------------------

const updateBranchCalls = (calls: Calls) => calls.filter((line) => line.startsWith("gh pr update-branch")).length;
const STRICT_RULES = [
	{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "ci" }] } },
];

test("CLEAN, green and reviewed on a stale base merges the original head, with no update-branch (item 33)", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ ancestor: false }).advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "advance");
	assert.equal(updateBranchCalls(b.calls), 0, "a base GitHub does not require current is never rebased onto");
	const mergeCall = b.calls.find((line) => line.startsWith("gh pr merge"));
	assert.ok(mergeCall);
	assert.equal(matchHeadBinding(mergeCall)?.head, HEAD_A, "the merge is bound to the head CI and review saw");
});

test("BEHIND is updated server-side once, and the old head's CI and review do not carry over", async (t) => {
	const b = await benchOf(t);
	const behind = await b.integrator({ pr: { ...openPr(), mergeStateStatus: "BEHIND" } }).advance({ jobId: BR });
	assert.equal(behind.step, "fresh");
	assert.equal(behind.next, "advance");
	assert.equal(behind.head_sha, undefined, "the moved head is not carried forward");
	assert.equal(updateBranchCalls(b.calls), 1);
	assert.ok(b.calls.some((line) => line.startsWith("gh run list")), "CI was read on the original head first");
	assert.ok(!b.calls.some((line) => line.startsWith("gh pr merge")));
	assert.match(behind.reason, /CI and cp_review must pass on the new commit/);

	// The update landed head B; only head A has green CI and a review pass.
	const movedPr = { ...openPr(), headRefOid: HEAD_B };
	const stale = await b.integrator({ pr: movedPr }).advance({ jobId: BR });
	assert.equal(stale.step, "ci");
	assert.equal(stale.next, "wait", "green CI on the superseded head is not green");
	const unreviewed = await b
		.integrator({ pr: movedPr, runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }] })
		.advance({ jobId: BR });
	assert.equal(unreviewed.next, "review", "a review of the old head does not cover the new one");
	assert.equal(updateBranchCalls(b.calls), 1, "updated exactly once");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("BLOCKED on a stale base without a readable up-to-date rule stays merge pending: no rebase, no merge", async (t) => {
	for (const rules of [undefined, [], { fail: "HTTP 403" }] as const) {
		const b = await benchOf(t);
		const result = await b
			.integrator({ ancestor: false, pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "" }, ...(rules ? { rules: rules as World["rules"] } : {}) })
			.advance({ jobId: BR });
		assert.equal(result.step, "permit");
		assert.equal(result.next, "surface");
		assert.equal(updateBranchCalls(b.calls), 0, `no speculative rebase (rules: ${JSON.stringify(rules)})`);
		assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	}
});

test("BLOCKED with a strict required-checks rule and a stale base is updated once; unreadable ancestry never is", async (t) => {
	const b = await benchOf(t);
	const blocked = { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "" };
	const updated = await b.integrator({ ancestor: false, pr: blocked, rules: STRICT_RULES }).advance({ jobId: BR });
	assert.equal(updated.step, "fresh");
	assert.equal(updated.next, "advance");
	assert.equal(updateBranchCalls(b.calls), 1);

	for (const ancestor of ["unreadable", true] as const) {
		const c = await benchOf(t);
		const result = await c.integrator({ ancestor, pr: blocked, rules: STRICT_RULES }).advance({ jobId: BR });
		assert.equal(result.next, "surface", `ancestor=${ancestor}`);
		assert.equal(updateBranchCalls(c.calls), 0, `ancestor=${ancestor}: no speculative rebase`);
		assert.equal(c.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	}
});

test("a stale base with red CI, a conflict or a moved head never triggers update-branch", async (t) => {
	const red = await benchOf(t);
	const redResult = await red
		.integrator({ ancestor: false, runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A, workflowName: "ci" }] })
		.advance({ jobId: BR });
	assert.equal(redResult.next, "resolve");
	assert.equal(updateBranchCalls(red.calls), 0);

	const conflict = await benchOf(t);
	const conflictResult = await conflict
		.integrator({ ancestor: false, pr: { ...openPr(), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } })
		.advance({ jobId: BR });
	assert.equal(conflictResult.step, "conflict");
	assert.equal(updateBranchCalls(conflict.calls), 0);

	const moved = await benchOf(t);
	const movedResult = await moved.integrator({ ancestor: false, permHead: HEAD_B }).advance({ jobId: BR });
	assert.equal(movedResult.next, "wait");
	assert.equal(updateBranchCalls(moved.calls), 0);

	for (const bench of [red, conflict, moved]) {
		assert.equal(bench.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	}
});

test("unknown mergeability never causes a rebase or a merge", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ ancestor: false, pr: { ...openPr(), mergeStateStatus: "UNKNOWN" } }).advance({ jobId: BR });
	assert.equal(result.next, "retry");
	assert.equal(updateBranchCalls(b.calls), 0);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a completed green run on a superseded sha is not green", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	const result = await b
		.integrator({ runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }] })
		.advance({ jobId: BR });
	assert.equal(result.step, "ci");
	assert.equal(result.next, "wait");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("CI still running on the pushed head merges nothing and asks nobody", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	const result = await b
		.integrator({ runs: [{ status: "in_progress", conclusion: null, headSha: HEAD_A, workflowName: "ci" }] })
		.advance({ jobId: BR });
	assert.equal(result.next, "wait");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a repo that HAS workflows but no run yet on this head still falls back to a per-head checkpoint (cp-e0c/C7)", async (t) => {
	const b = await benchOf(t);
	const asked = await b.integrator({ runs: [] }).advance({ jobId: BR });
	assert.equal(asked.step, "authorize");
	assert.equal(asked.next, "surface");
	assert.ok(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }), "a checkpoint must exist for a CI-less branch");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);

	b.approve(HEAD_A);
	const merged = await b.integrator({ runs: [] }).advance({ jobId: BR });
	assert.equal(merged.step, "merge");
	assert.equal(merged.record.merge_authority?.kind, "human_checkpoint");
	// Both fallback triggers bind the head, not just the unreadable-verdict one.
	const mergeCall = b.calls.find((line) => line.startsWith("gh pr merge"));
	assert.ok(mergeCall);
	assert.equal(matchHeadBinding(mergeCall)?.head, HEAD_A, "a CI-less fallback merge is bound to the authorized head too");
});

// ---------------------------------------------------------------------------
// no CI configured at all (cp-no-ci-repo-derived): repo-derived, not a human
// ---------------------------------------------------------------------------

/** `gh api .../actions/workflows` for a repository that genuinely has none. */
const NO_WORKFLOWS = { total_count: 0, workflows: [] };

test("a repository that reports zero workflows merges on the repo's own authority, minting no checkpoint", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ runs: [], workflows: NO_WORKFLOWS }).advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "advance");
	assert.equal(result.record.merge_authority?.kind, "repo_derived");
	assert.equal(result.record.merge_authority?.merge_state_status, "CLEAN");
	assert.equal(
		b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }),
		undefined,
		"a repo with no CI configured never spends a human authorization",
	);
	// The evidence is positive, not an absence: the repository was asked.
	assert.ok(
		b.calls.some((line) => line === "gh api repos/{owner}/{repo}/actions/workflows"),
		"the repository must be asked what workflows it has",
	);
	assert.ok(
		result.facts.some((fact) => fact.startsWith("ci configuration: none (authoritative_empty)")),
		`the authoritative answer must be in the record's facts: ${result.facts.join(" | ")}`,
	);
	const mergeCall = b.calls.find((line) => line.startsWith("gh pr merge"));
	assert.ok(mergeCall);
	assert.equal(matchHeadBinding(mergeCall)?.head, HEAD_A);
	assert.ok(!mergeCall.includes("--admin"), "no CI is never a reason to force a merge");
});

test("a repository with no CI whose merge the repo itself refuses still surfaces merge pending, and never a checkpoint", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({
			runs: [],
			workflows: NO_WORKFLOWS,
			pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" },
		})
		.advance({ jobId: BR });
	assert.equal(result.step, "permit");
	assert.equal(result.next, "surface");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	assert.equal(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }), undefined);
	const items = b.awaiting().list();
	assert.equal(items.length, 1);
	assert.match(items[0]?.decision ?? "", /merge pending/i);
});

test("an unreadable workflows probe is not 'no CI': every failure shape still mints the human checkpoint", async (t) => {
	const failures: Array<[string, unknown]> = [
		["403", { fail: "gh: Resource not accessible by integration (HTTP 403)" }],
		["network error", { fail: "dial tcp: lookup api.github.com: no such host" }],
		["an empty stdout from a failed command", { fail: "" }],
		["output that will not parse", "<html>502 Bad Gateway</html>"],
	];
	for (const [label, workflows] of failures) {
		const b = await benchOf(t);
		const result = await b.integrator({ runs: [], workflows }).advance({ jobId: BR });
		assert.equal(result.step, "authorize", label);
		assert.equal(result.next, "surface", label);
		assert.ok(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }), `${label} must still ask a human`);
		assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, label);
		assert.ok(
			result.facts.some((fact) => fact.startsWith("ci configuration: unreadable (")),
			`${label}: the record must say the configuration was unreadable, not absent`,
		);
	}
});

test("a red head is still never a merge ask, whatever the workflows endpoint says", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({
			runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A, workflowName: "ci" }],
			workflows: NO_WORKFLOWS,
		})
		.advance({ jobId: BR });
	assert.equal(result.next, "resolve");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	assert.equal(b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }), undefined);
	// A red head short-circuits before the probe: there is nothing to establish.
	assert.ok(!b.calls.some((line) => line.includes("actions/workflows")));
});

// ---------------------------------------------------------------------------
// repo-derived permission: blocked, unstable, draft, auto-merge, a moved head
// ---------------------------------------------------------------------------

test("blocked by required reviews raises a merge-pending reminder and attempts no merge", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" } })
		.advance({ jobId: BR });
	assert.equal(result.step, "permit");
	assert.equal(result.next, "surface");
	assert.match(result.reason, /merge pending|will not take the merge/i);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	assert.equal(
		b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }),
		undefined,
		"a repo refusal never mints a checkpoint",
	);
	const items = b.awaiting().list();
	assert.equal(items.length, 1);
	assert.equal(items[0]?.type, "approval");
	assert.equal(items[0]?.state, "open");
	assert.match(items[0]?.decision ?? "", /review/i);
});

test("blocked with the rules unreadable still raises a reminder, never a merge", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "" } })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("UNSTABLE is treated as pending, not permitted — a non-required check we cannot see must not be merged over", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ pr: { ...openPr(), mergeStateStatus: "UNSTABLE" } }).advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

const draftPr = (): PrJson => ({ ...openPr(), isDraft: true });
const count = (b: Bench, prefix: string) => b.calls.filter((line) => line.startsWith(prefix)).length;

test("jje.5: a draft with no pass on its current head is a hold: review, never ready, a reminder or an escalation", async (t) => {
	for (const reviewHead of [false, HEAD_B] as const) {
		const b = await benchOf(t, {}, { reviewHead });
		const result = await b.integrator({ pr: draftPr() }).advance({ jobId: BR });
		assert.deepEqual([result.next, count(b, "gh pr ready"), count(b, "gh pr merge")], ["review", 0, 0], `pass on ${reviewHead}`);
		assert.equal(b.awaiting().list().length + new EscalationStore({ home: b.home }).list({ jobId: BR }).length, 0);
	}
});

test("jje.5: a reviewed draft head is marked ready once and re-read; the ready PR then merges CLEAN", async (t) => {
	const b = await benchOf(t);
	const ready = await b.integrator({ pr: draftPr() }).advance({ jobId: BR });
	assert.deepEqual([ready.next, ready.head_sha, count(b, "gh pr view"), count(b, "gh pr merge")], ["advance", HEAD_A, 3, 0]);
	assert.equal((await b.integrator().advance({ jobId: BR })).step, "merge");
	assert.deepEqual(b.calls.filter((line) => line.startsWith("gh pr ready")), [`gh pr ready ${PR_URL}`], "an already-ready PR is never readied again");
	assert.equal(matchHeadBinding(b.calls.find((line) => line.startsWith("gh pr merge")) ?? "")?.head, HEAD_A);
	// The CI-unreadable checkpoint path readies a reviewed draft before it asks a human.
	const noCi = await benchOf(t);
	const fallback = await noCi.integrator({ pr: draftPr(), runs: [], workflows: { fail: "HTTP 403" } }).advance({ jobId: BR });
	assert.deepEqual([fallback.next, count(noCi, "gh pr ready"), noCi.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) })], ["advance", 1, undefined]);
});

test("jje.5: a head that moves across gh pr ready waits for its own review; a refused ready surfaces once", async (t) => {
	const moved = await benchOf(t);
	const green = (head: string) => ({ status: "completed", conclusion: "success", headSha: head });
	const world = moved.integrator({ pr: draftPr(), readyMovesHead: HEAD_B, runs: [green(HEAD_A), green(HEAD_B)] });
	const wait = await world.advance({ jobId: BR });
	assert.deepEqual([wait.next, wait.head_sha, count(moved, "gh pr merge")], ["wait", HEAD_B, 0]);
	assert.deepEqual(moved.calls.filter((line) => line.startsWith("gh pr ready")), [`gh pr ready ${PR_URL}`, `gh pr ready --undo ${PR_URL}`]);
	assert.match(wait.reason, /head moved to bbbbbbbbbbbb.*; returned to draft/);
	// Same GitHub: the moved, unreviewed head still reads as a draft, so it is held for review and never readied.
	const held = await world.advance({ jobId: BR });
	assert.equal(held.next, "review", "the new head is unreviewed");
	assert.ok(held.facts.some((fact) => /permission: pending \(draft\)/.test(fact)), "the moved head remains a draft");
	assert.equal(count(moved, "gh pr ready"), 2, "no second ready for the unreviewed head");
	const stuck = await benchOf(t);
	const refusedUndo = await stuck.integrator({ pr: draftPr(), readyMovesHead: HEAD_B, undoFails: "HTTP 502" }).advance({ jobId: BR });
	assert.deepEqual([refusedUndo.next, count(stuck, "gh pr merge")], ["surface", 0]);
	assert.match(refusedUndo.reason, /gh pr ready --undo refused \(HTTP 502\), so an unreviewed head reads ready/);
	const refused = await benchOf(t);
	const result = await refused.integrator({ pr: draftPr(), readyFails: "GraphQL: forbidden" }).advance({ jobId: BR });
	assert.deepEqual([result.next, count(refused, "gh pr view"), count(refused, "gh pr merge")], ["surface", 2, 0]);
	assert.match(result.reason, /gh pr ready refused: GraphQL: forbidden/);
});

test("an approved checkpoint can never merge what the repository refuses", async (t) => {
	const b = await benchOf(t);
	// Seed an approved checkpoint for this head first — as if it survived from
	// before this rule existed, or a human answered one out of band.
	b.approve(HEAD_A);
	const result = await b
		.integrator({ pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" } })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, "an approval never overrides a repo refusal");
	const checkpoint = b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) });
	assert.equal(checkpoint?.decision, "approved", "the stale approval itself is left untouched");
});

test("the head moving during the permission re-read voids the decision; nothing merges", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ permHead: HEAD_B }).advance({ jobId: BR });
	assert.equal(result.step, "permit");
	assert.equal(result.next, "wait");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, "a moved head is never merged");
	assert.match(result.reason, /moved during the permission check/);
});

test("a merge-pending reminder is withdrawn once the repo permits the merge, and never re-declared for a second decline", async (t) => {
	const b = await benchOf(t);
	await b.integrator({ pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" } }).advance({ jobId: BR });
	assert.equal(b.awaiting().list().filter((item) => item.state === "open").length, 1);

	// A repeat call with the same refusal must not mint a second row.
	await b.integrator({ pr: { ...openPr(), mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" } }).advance({ jobId: BR });
	assert.equal(b.awaiting().list().length, 1, "re-declaring the same refusal updates one row, never mints a second");

	// The repo now permits it: the merge lands and the reminder is withdrawn.
	const merged = await b.integrator().advance({ jobId: BR });
	assert.equal(merged.step, "merge");
	const items = b.awaiting().list();
	assert.equal(items.length, 1);
	assert.equal(items[0]?.state, "withdrawn");
});

test("an armed auto-merge is refused, not re-issued: cp_integrate never relies on it", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), autoMergeRequest: {} } })
		.advance({ jobId: BR });
	assert.equal(result.step, "permit");
	assert.equal(result.next, "surface");
	assert.match(result.reason, /auto-merge/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

// ---------------------------------------------------------------------------
// 8 + 9 + 10. handing back to the implementer
// ---------------------------------------------------------------------------

test("CI red on the pushed head promotes the implementer and never asks for a merge", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A, workflowName: "ci" }] })
		.advance({ jobId: BR });

	assert.equal(result.step, "ci");
	assert.equal(result.next, "resolve");
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0]!.message, /CI is red/);
	assert.match(b.sent[0]!.message, /--force-with-lease/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	assert.equal(
		b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }),
		undefined,
		"a red head is never a merge ask at all",
	);
});

test("duplicate red CI waits for the active repair, then surfaces a completed failure", async (t) => {
	const b = await benchOf(t);
	const world = { runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] };
	assert.equal((await b.integrator(world).advance({ jobId: BR })).next, "resolve");
	await b.fleet.patch(BR, { phase: "waiting" });
	assert.equal((await b.integrator(world).advance({ jobId: BR })).next, "resolve");
	assert.equal(b.sent.length, 1);
	await b.fleet.patch(BR, { phase: "held" });
	assert.equal((await b.integrator(world).advance({ jobId: BR })).next, "surface");
});

test("red CI waits for a working implementer even before an integration promotion", async (t) => {
	const b = await benchOf(t, { phase: "waiting" });
	const result = await b.integrator({ runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] }).advance({ jobId: BR });
	assert.equal(result.next, "resolve");
	assert.equal(b.sent.length, 0);
});

test("duplicate red CI does not send again while promotion is in flight", async (t) => {
	const b = await benchOf(t);
	const entered = { resolve: () => { }, promise: Promise.resolve() };
	entered.promise = new Promise<void>((resolve) => { entered.resolve = resolve; });

	const release = { resolve: () => { }, promise: Promise.resolve() };
	release.promise = new Promise<void>((resolve) => { release.resolve = resolve; });

	let sends = 0;
	const integrator = b.integrator({ runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] }, {
		send: async () => {
			sends++;
			entered.resolve();
			if (sends === 1) await release.promise;
			return { receipt: "delivered" };
		},
	});
	const first = integrator.advance({ jobId: BR });
	await entered.promise;
	try {
		assert.equal((await integrator.advance({ jobId: BR })).next, "resolve");
		assert.equal(sends, 1);
	} finally {
		release.resolve();
		await first;
	}
});

test("a conflict is handed back once, with the resync the server-side rebase requires", async (t) => {
	const b = await benchOf(t);
	const first = await b.integrator({ pr: { ...openPr(), mergeable: "CONFLICTING" } }).advance({ jobId: BR });
	assert.equal(first.step, "conflict");
	assert.equal(first.next, "resolve");
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0]!.message, new RegExp(`git reset --hard origin/${BR}`));
	assert.match(b.sent[0]!.message, /both sides survive/);

	// A second failure is the operator's, never a third automated attempt.
	const second = await b.integrator({ pr: { ...openPr(), mergeable: "CONFLICTING" } }).advance({ jobId: BR });
	assert.equal(second.next, "surface");
	assert.equal(b.sent.length, 1, "one promote, then a human");
});

test("no live implementer surfaces; nothing is dispatched in its place", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator(
			{ pr: { ...openPr(), mergeable: "CONFLICTING" } },
			{
				send: async () => {
					throw new Error(`${BR} has no live worker in this session`);
				},
			},
		)
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.match(result.reason, /no live worker/);
});

test("with no sender wired at all, a conflict surfaces rather than silently stalling", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), mergeable: "CONFLICTING" } }, { noSender: true })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
});

// ---------------------------------------------------------------------------
// 12 + 13. the PR moved without us
// ---------------------------------------------------------------------------

test("a PR merged externally jumps straight to record; nothing re-merges", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ pr: mergedPr() }).advance({ jobId: BR });
	assert.equal(result.next, "done");
	assert.equal(result.merge?.recorded, true);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0, "we did not merge it, GitHub did");
	assert.equal(
		b.mergeCheckpoints().get(BR, { scope: HEAD_A.slice(0, 12) }),
		undefined,
		"nothing is authorized after the fact",
	);
});

test("a PR closed unmerged surfaces and writes no receipt", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), state: "CLOSED" } })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.ok(!existsSync(join(b.home, paths.mergeFile(BR))));
	assert.equal(b.teardowns.length, 0);
	assert.equal(b.closed.length, 0);
});

test("a PR whose head branch is not this job's branch is refused, untouched", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), headRefName: "someone-else" } })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.match(result.reason, /not this\s+job's delivery|not this job's delivery/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

// ---------------------------------------------------------------------------
// 14 + 15. operational faults
// ---------------------------------------------------------------------------

test("a gh 403 mutates nothing and asks to be retried, carrying the first stderr line", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator({ pr: { fail: "HTTP 403: Resource not accessible\nmore" } }).advance({ jobId: BR });
	assert.equal(result.next, "retry");
	assert.match(result.reason, /403/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a rate-limited gh run list stops before the merge, not after it", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	const result = await b.integrator({ runs: { fail: "API rate limit exceeded" } }).advance({ jobId: BR });
	assert.equal(result.step, "ci");
	assert.equal(result.next, "retry");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a missing gh surfaces, and names force as the operator's honest exit rather than automation", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { fail: "spawn gh ENOENT", status: 127 } })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.match(result.reason, /gh is not available/);
	assert.match(result.reason, /proves nothing/);
});

// ---------------------------------------------------------------------------
// 16 + 17. the leased worktree
// ---------------------------------------------------------------------------

test("a worktree left behind origin is resynced before teardown, never forced", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const done = await b.integrator({ pr: mergedPr(), worktreeHead: HEAD_B }).advance({ jobId: BR });
	assert.equal(done.next, "done");
	assert.ok(
		b.calls.some((line) => line === `git reset --hard ${HEAD_A}`),
		"the worktree must be brought back to origin before the gate compares it",
	);
	assert.equal(b.teardowns.length, 1);
	assert.equal(done.teardown?.reason, "pushed");
});

// cp-uv5. The reset resolves its base from `ls-remote`, the same question the
// guard above it compared against — not from `refs/remotes/origin/<branch>`.
// This is PR #71's rule (cp-p0r) one function over: ask origin, act on origin's
// answer, and fail closed when origin cannot answer.

test("the reset names the sha ls-remote reported, never the remote-tracking ref", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	// origin's tip for the branch is MERGE_COMMIT; the *ref* name would have been
	// `origin/cp-int1`, and the two are different strings on purpose.
	const done = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, syncRemoteSha: MERGE_COMMIT })
		.advance({ jobId: BR });
	assert.equal(done.next, "done");
	const resets = b.calls.filter((line) => line.startsWith("git reset"));
	assert.deepEqual(resets, [`git reset --hard ${MERGE_COMMIT}`]);
	// Which git question was asked, not merely which answer came back: the sha
	// came from origin, and the tracking ref was never named as a revision.
	assert.ok(
		b.calls.includes(`git ls-remote --heads origin ${BR}`),
		"the base must be resolved by asking origin",
	);
	assert.ok(
		!b.calls.some((line) => line.startsWith("git reset") && line.includes(`origin/${BR}`)),
		"a remote-tracking ref must never be what the worktree is reset to",
	);
	assert.ok(
		!b.calls.some((line) => line.includes("refs/remotes/")),
		"nothing in the sync step may read refs/remotes/*",
	);
	assert.ok(
		done.facts.some((fact) => fact.includes(MERGE_COMMIT.slice(0, 12))),
		"the fact the parent relays must name the sha the worktree was actually moved to",
	);
});

test("a stale remote-tracking ref cannot satisfy the sync: only the ls-remote sha resolves", async (t) => {
	// The `--single-branch` / `--depth` clone, reproduced: `ls-remote` answers
	// fine while `origin/<branch>` does not resolve at all. Under the old code the
	// reset failed here and the step surfaced; asking origin makes it succeed.
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const done = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, trackingRefUnresolvable: true })
		.advance({ jobId: BR });
	assert.equal(done.next, "done");
	assert.ok(b.calls.includes(`git reset --hard ${HEAD_A}`));
	assert.equal(b.teardowns.length, 1);
});

test("origin unreachable for the branch is a refusal, not a fallback to the ref", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({
			pr: mergedPr(),
			worktreeHead: HEAD_B,
			syncLsRemoteFails: "fatal: could not read from remote repository",
		})
		.advance({ jobId: BR });
	assert.ok(
		!b.calls.some((line) => line.startsWith("git reset")),
		"an unreadable answer from origin is never permission to reset",
	);
	assert.ok(!b.calls.some((line) => line.startsWith("git status")), "the guards are not even reached");
	assert.notEqual(result.next, "surface");
});

test("origin naming no such ref is a refusal, not a fallback to the ref", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, syncRemoteSha: "" })
		.advance({ jobId: BR });
	assert.ok(
		!b.calls.some((line) => line.startsWith("git reset")),
		"an absent ref on origin is never permission to reset",
	);
	assert.notEqual(result.next, "surface");
});

test("a clean worktree holding unpushed commits is never reset either", async (t) => {
	// The one destructive call in this module, and the one case a porcelain check
	// cannot see: an implementer that committed and did not push has work that
	// exists in exactly one place. Resetting would be the only thing in this
	// system that ever destroyed work.
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, worktreeAhead: 2 })
		.advance({ jobId: BR });
	assert.equal(result.step, "sync");
	assert.equal(result.next, "surface");
	assert.ok(!b.calls.some((line) => line.startsWith("git reset")), "unpushed commits must never be discarded");
	assert.equal(b.teardowns.length, 0);
	assert.match(result.reason, /2 commit\(s\) origin\/cp-int1 does not/);
});

test("a worktree whose divergence cannot be read is left alone, not reset", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, worktreeAheadFails: "fatal: bad revision" })
		.advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.ok(!b.calls.some((line) => line.startsWith("git reset")), "an unreadable count is not zero");
});

test("a dirty worktree is never reset: it surfaces instead", async (t) => {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, worktreeDirty: true })
		.advance({ jobId: BR });
	assert.equal(result.step, "sync");
	assert.equal(result.next, "surface");
	assert.equal(b.teardowns.length, 0);
	assert.ok(!b.calls.some((line) => line.startsWith("git reset")));
});

// cp-8vf6. The second guard refused 7 times on 2026-09-01, correctly each time
// and falsely in substance every time: the commits were the branch's own
// pre-rebase versions, already absorbed by the squash merge. It now *proves*
// that before it resets — the cumulative branch diff's patch-id, computed for
// the local head and for the sha origin names, against a base tip origin itself
// named. Anything less than two equal, non-empty ids is the refusal it always
// made.

/**
 * Every git question except the freshness check. That one reads `origin/<base>`
 * in the **clone**, deliberately and out of this job's scope (the plan names it
 * as its own issue): it decides whether to ask GitHub for a server-side rebase,
 * and it can never discard anything. Every question that *can* decide whether
 * work is destroyed has to name a sha origin itself reported.
 */
function decisive(calls: Calls): string[] {
	return calls.filter((line) => !line.includes("--is-ancestor"));
}

/** The two heads carry the same change: the shape all 7 refusals had. */
function absorbed(local: string, remote: string): Partial<World> {
	const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
	return { cumulativeDiff: { [local]: patch, [remote]: patch } };
}

async function syncWith(t: Parameters<typeof benchOf>[0], world: Partial<World>) {
	const b = await benchOf(t);
	mkdirSync(b.worktree, { recursive: true });
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), worktreeHead: HEAD_B, syncRemoteSha: MERGE_COMMIT, worktreeAhead: 2, ...world })
		.advance({ jobId: BR });
	return { b, result };
}

test("the 7-refusal shape: pre-rebase commits whose content the base already carries are proven and reset", async (t) => {
	const { b, result } = await syncWith(t, absorbed(HEAD_B, MERGE_COMMIT));
	assert.equal(result.next, "done");
	assert.equal(b.teardowns.length, 1, "the job must reach teardown instead of surfacing a false alarm");

	// Which questions were asked, in order — not merely that a reset happened.
	const at = (predicate: (line: string) => boolean) => b.calls.findIndex(predicate);
	const baseAsked = at((line) => line === "git ls-remote --heads origin main");
	const forkLocal = at((line) => line === `git merge-base ${BASE_TIP} ${HEAD_B}`);
	const forkRemote = at((line) => line === `git merge-base ${BASE_TIP} ${MERGE_COMMIT}`);
	const diffLocal = at((line) => line === `git diff --no-color --no-ext-diff --no-textconv --no-renames --binary ${FORK_POINT} ${HEAD_B}`);
	const diffRemote = at(
		(line) => line === `git diff --no-color --no-ext-diff --no-textconv --no-renames --binary ${FORK_POINT} ${MERGE_COMMIT}`,
	);
	const salvage = at((line) => line.startsWith("git update-ref refs/cp-salvage/"));
	const reset = at((line) => line === `git reset --hard ${MERGE_COMMIT}`);
	for (const [what, index] of Object.entries({ baseAsked, forkLocal, forkRemote, diffLocal, diffRemote, salvage, reset })) {
		assert.ok(index >= 0, `${what} was never asked`);
	}
	assert.equal(b.calls.filter((line) => line === "git patch-id --stable").length, 2, "both sides must be identified");
	assert.ok(baseAsked < forkLocal, "the base tip is asked of origin before anything is computed against it");
	assert.ok(diffLocal < salvage && diffRemote < salvage, "nothing is salvaged before the proof is complete");
	assert.ok(salvage < reset, "the discarded head must be on a ref *before* the reset, not after");
	assert.match(
		b.calls[salvage] ?? "",
		new RegExp(`^git update-ref refs/cp-salvage/${BR}/\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z ${HEAD_B}$`),
		"the rescue ref must be named for the job and point at the head being discarded",
	);

	// The rule Job B established, unchanged: origin is asked, refs/remotes is not.
	assert.ok(!b.calls.some((line) => line.includes("refs/remotes/")), "nothing in the sync step may read refs/remotes/*");
	assert.ok(
		!decisive(b.calls).some((line) => line.startsWith("git ") && /origin\/(main|cp-int1)/.test(line)),
		"the base must never be read as a remote-tracking ref",
	);

	// And the fact the parent relays says what was discarded and where it is kept.
	const fact = result.facts.find((line) => line.includes("worktree reset to"));
	assert.ok(fact, "the sync fact is missing");
	assert.match(fact, /2 pre-rebase commit\(s\) were discarded/);
	assert.match(fact, /patch-id [0-9a-f]{12}/);
	assert.match(fact, new RegExp(`kept at refs/cp-salvage/${BR}/`));
});

test("the dangerous inverse: content the base does not carry is never reset away", async (t) => {
	// Default world: the two heads have *different* cumulative diffs, which is a
	// worktree holding real work. This is the case the guard exists for.
	const { b, result } = await syncWith(t, {});
	assert.equal(result.step, "sync");
	assert.equal(result.next, "surface");
	assert.ok(!b.calls.some((line) => line.startsWith("git reset")), "unproven commits must never be discarded");
	assert.ok(!b.calls.some((line) => line.startsWith("git update-ref")), "no reset, no salvage ref");
	assert.equal(b.teardowns.length, 0);
	assert.match(result.reason, /2 commit\(s\) origin\/cp-int1 does not/);
	assert.match(result.reason, /could not be proven to be already in main/);
	assert.match(result.reason, /patch-id [0-9a-f]{12}\) is not the one origin's tip carries/);
	// Actionable: it names the fix, not just the refusal.
	assert.match(result.reason, /fix it in place rather than reaching for force/);
});

test("an unproven answer refuses, whichever git question was the one that could not be answered", async (t) => {
	const cases: Array<[string, Partial<World>, RegExp]> = [
		["origin cannot be asked for the base", { ...absorbed(HEAD_B, MERGE_COMMIT), syncBaseLsRemoteFails: "fatal: could not read from remote repository" }, /did not name a tip for main/],
		["origin has no such base", { ...absorbed(HEAD_B, MERGE_COMMIT), syncBaseSha: "" }, /did not name a tip for main/],
		["no merge base", { ...absorbed(HEAD_B, MERGE_COMMIT), mergeBaseFails: "fatal: Not a valid object name" }, /share no readable merge base/],
		["the diff will not read", { ...absorbed(HEAD_B, MERGE_COMMIT), diffFails: "fatal: bad object" }, /cumulative diff of .* could not be read/],
		["patch-id fails", { ...absorbed(HEAD_B, MERGE_COMMIT), patchIdFails: "fatal: broken pipe" }, /gave no id/],
		["patch-id answers with nothing", { ...absorbed(HEAD_B, MERGE_COMMIT), patchIdEmpty: true }, /gave no id/],
		["both cumulative diffs are empty", { cumulativeDiff: { [HEAD_B]: "", [MERGE_COMMIT]: "" } }, /empty cumulative diff/],
		["the rescue ref cannot be written", { ...absorbed(HEAD_B, MERGE_COMMIT), updateRefFails: "fatal: cannot lock ref" }, /could not be kept on a rescue ref first/],
	];
	for (const [what, world, reason] of cases) {
		const { b, result } = await syncWith(t, world);
		assert.equal(result.next, "surface", `${what}: it must surface`);
		assert.ok(!b.calls.some((line) => line.startsWith("git reset")), `${what}: nothing may be reset`);
		assert.equal(b.teardowns.length, 0, `${what}: teardown must not run`);
		assert.match(result.reason, reason, what);
		assert.ok(
			!decisive(b.calls).some((line) => line.startsWith("git ") && line.includes("origin/main")),
			`${what}: an unreadable base is never a reason to read the tracking ref`,
		);
	}
});

test("the proof is not attempted at all when the worktree holds nothing origin does not", async (t) => {
	const { b, result } = await syncWith(t, { worktreeAhead: 0, ...absorbed(HEAD_B, MERGE_COMMIT) });
	assert.equal(result.next, "done");
	assert.deepEqual(b.calls.filter((line) => line.startsWith("git reset")), [`git reset --hard ${MERGE_COMMIT}`]);
	assert.ok(!b.calls.some((line) => line.startsWith("git patch-id")), "a plain fast-forward proves nothing extra");
	assert.ok(!b.calls.some((line) => line.startsWith("git update-ref")), "and salvages nothing");
});

// ---------------------------------------------------------------------------
// cp-wcy5. The rescue refs cp-8vf6 writes accumulate one per proven reset, and
// nothing pruned them. The retention policy deletes one **only** once its
// commit is provably reachable from the tip origin names for the base: never on
// age, never on count, never on a timer, and never outside refs/cp-salvage/.
// ---------------------------------------------------------------------------

const SALVAGED_REACHABLE = "1111111111116666666666666666666666666666";
const SALVAGED_ORPHAN = "2222222222227777777777777777777777777777";
const REF_REACHABLE = `refs/cp-salvage/cp-old1/2026-09-01T10-00-00Z`;
const REF_ORPHAN = `refs/cp-salvage/cp-old2/2026-09-01T11-00-00Z`;

/** The two-call happy path, with rescue refs already on disk in the clone. */
async function integrateWith(t: Parameters<typeof benchOf>[0], world: Partial<World>) {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	await b.integrator(world).advance({ jobId: BR });
	const result = await b.integrator({ pr: mergedPr(), ...world }).advance({ jobId: BR });
	return { b, result };
}

/** Every `git update-ref -d` issued, as `[ref, sha]`. */
function deletes(calls: Calls): Array<[string, string]> {
	return calls
		.filter((line) => line.startsWith("git update-ref -d "))
		.map((line) => {
			const args = line.split(" ");
			return [args[3] ?? "", args[4] ?? ""] as [string, string];
		});
}

test("a rescue ref whose commit the base provably carries is pruned; one it does not is kept", async (t) => {
	const { b, result } = await integrateWith(t, {
		salvageRefs: [
			[REF_REACHABLE, SALVAGED_REACHABLE],
			[REF_ORPHAN, SALVAGED_ORPHAN],
		],
		reachableFromBase: { [SALVAGED_REACHABLE]: true },
	});
	assert.equal(result.next, "done");

	// Exactly one delete, for exactly the reachable ref, bound to the sha that was
	// proven (so a ref another lease moved in between is not deleted on a stale
	// proof — real git refuses that lock).
	assert.deepEqual(deletes(b.calls), [[REF_REACHABLE, SALVAGED_REACHABLE]]);

	// The authoritative question, asked of origin and never of a tracking ref.
	assert.ok(
		b.calls.includes("git ls-remote --heads origin main"),
		"the base tip must come from origin itself (PR #71, PR #85)",
	);
	assert.ok(
		b.calls.includes(`git merge-base --is-ancestor ${SALVAGED_REACHABLE} ${BASE_TIP}`),
		"reachability is proven against the sha origin named",
	);
	assert.ok(
		b.calls.includes(`git merge-base --is-ancestor ${SALVAGED_ORPHAN} ${BASE_TIP}`),
		"and it is asked for every ref, not inferred from the first answer",
	);
	assert.ok(!b.calls.some((line) => line.includes("refs/remotes/")), "never a remote-tracking ref");

	// What the operator sees: what went, what stayed, and why each.
	const prunedFact = result.facts.find((line) => line.includes("rescue ref(s) pruned"));
	assert.ok(prunedFact, `no prune fact in ${JSON.stringify(result.facts)}`);
	assert.match(prunedFact, new RegExp(`1 rescue ref\\(s\\) pruned`));
	assert.match(prunedFact, new RegExp(`ancestor of ${BASE_TIP.slice(0, 12)}, the sha origin names for main`));
	assert.ok(prunedFact.includes(REF_REACHABLE));
	const keptFact = result.facts.find((line) => line.includes("rescue ref(s) kept"));
	assert.ok(keptFact, "a kept ref must be reported, or a deleted one is indistinguishable from a lost one");
	assert.ok(keptFact.includes(REF_ORPHAN));
	assert.match(keptFact, new RegExp(`${SALVAGED_ORPHAN.slice(0, 12)} is not reachable from main`));

	// And it is journaled, with both lists.
	const event = readRunEvents(b.home, BR)
		.filter((entry) => entry.type === "integration_advanced")
		.map((entry) => entry.payload as Record<string, unknown>)
		.find((payload) => payload.step === "prune_salvage");
	assert.ok(event, "the prune must be journaled");
	assert.deepEqual(event.pruned, [`${REF_REACHABLE} -> ${SALVAGED_REACHABLE.slice(0, 12)}`]);
	assert.equal((event.kept as string[]).length, 1);
});

test("an unreadable origin keeps every rescue ref, and the refusal is the question that failed", async (t) => {
	const { b, result } = await integrateWith(t, {
		salvageRefs: [[REF_REACHABLE, SALVAGED_REACHABLE]],
		// Even though this commit *is* reachable, origin cannot be asked at all.
		reachableFromBase: { [SALVAGED_REACHABLE]: true },
		pruneBaseLsRemoteFails: "fatal: could not read from remote repository",
	});
	assert.equal(result.next, "done", "a prune that could not run never fails the integration");
	assert.deepEqual(deletes(b.calls), [], "an unreadable answer is not permission to delete");

	// Asserted by which question was asked: origin was asked, the tracking ref was
	// not consulted as a fallback, and reachability was never even computed.
	assert.ok(b.calls.includes("git ls-remote --heads origin main"));
	assert.ok(
		!b.calls.some((line) => line.startsWith("git ") && !line.includes("--is-ancestor") && line.includes("origin/main")),
		"an unreadable base is never a reason to reach for refs/remotes/origin/main",
	);
	assert.ok(
		!b.calls.some((line) => line.startsWith(`git merge-base --is-ancestor ${SALVAGED_REACHABLE}`)),
		"nothing is proven against a base tip that was never obtained",
	);
	const fact = result.facts.find((line) => line.includes("rescue ref(s) kept"));
	assert.ok(fact);
	assert.match(fact, /origin did not name a tip for main/);
});

test("origin naming no tip for the base, an unreadable ancestry answer and a refused delete all keep the ref", async (t) => {
	const cases: Array<[string, Partial<World>, RegExp]> = [
		[
			"origin has no such base",
			{ salvageRefs: [[REF_REACHABLE, SALVAGED_REACHABLE]], pruneBaseSha: "" },
			/origin did not name a tip for main/,
		],
		[
			"the base cannot be listed",
			{ forEachRefFails: "fatal: not a git repository" },
			/could not be listed/,
		],
		[
			"ancestry cannot be read",
			{
				salvageRefs: [[REF_REACHABLE, SALVAGED_REACHABLE]],
				reachableFromBase: { [SALVAGED_REACHABLE]: true },
				ancestorUnreadable: [SALVAGED_REACHABLE],
			},
			/reachability could not be read/,
		],
		[
			"the delete itself refuses",
			{
				salvageRefs: [[REF_REACHABLE, SALVAGED_REACHABLE]],
				reachableFromBase: { [SALVAGED_REACHABLE]: true },
				deleteRefFails: "error: cannot lock ref",
			},
			/could not be deleted/,
		],
	];
	for (const [what, world, expected] of cases) {
		const { b, result } = await integrateWith(t, world);
		assert.equal(result.next, "done", `${what}: the integration still completes`);
		const fact = result.facts.find((line) => expected.test(line));
		assert.ok(fact, `${what}: the reason is missing from ${JSON.stringify(result.facts)}`);
		if (what !== "the delete itself refuses") {
			assert.deepEqual(deletes(b.calls), [], `${what}: nothing may be deleted`);
		}
	}
});

test("a base that cannot be fetched keeps every rescue ref: merge-base could not answer against it", async (t) => {
	// The base tip is a sha origin named, but its objects are not here, so
	// `merge-base` has nothing to answer with. Fetching is what makes it
	// answerable, and a fetch that fails is not permission.
	const { b, result } = await integrateWith(t, {
		salvageRefs: [[REF_REACHABLE, SALVAGED_REACHABLE]],
		reachableFromBase: { [SALVAGED_REACHABLE]: true },
		baseFetchFails: "fatal: could not read from remote repository",
	});
	assert.equal(result.next, "done", "a prune that could not run never fails the integration");
	assert.deepEqual(deletes(b.calls), [], "an unfetchable base is not permission to delete");
	assert.ok(b.calls.includes("git fetch origin main"), "the fetch that failed is the one that was asked for");
	assert.ok(
		!b.calls.some((line) => line.startsWith(`git merge-base --is-ancestor ${SALVAGED_REACHABLE}`)),
		"reachability is never computed against a tip whose objects are not present",
	);
	const fact = result.facts.find((line) => line.includes("rescue ref(s) kept"));
	assert.ok(fact, `no kept fact in ${JSON.stringify(result.facts)}`);
	assert.match(fact, /could not be fetched from origin/);
});

test("the per-call bound examines SALVAGE_PRUNE_MAX refs in refname order and keeps the remainder", async (t) => {
	// One more than the bound, listed in reverse refname order so "which refs the
	// bound covers" cannot pass by accident on insertion order.
	const total = SALVAGE_PRUNE_MAX + 1;
	const names = Array.from(
		{ length: total },
		(_, index) => `refs/cp-salvage/cp-bulk/2026-09-01T${String(index).padStart(3, "0")}-00-00Z`,
	);
	const { b, result } = await integrateWith(t, {
		salvageRefs: [...names].reverse().map((ref) => [ref, SALVAGED_REACHABLE] as [string, string]),
		// Every one of them is provably reachable: the bound, not the proof, is what
		// leaves one behind.
		reachableFromBase: { [SALVAGED_REACHABLE]: true },
	});
	assert.equal(result.next, "done");

	assert.ok(
		b.calls.some((line) => line.startsWith("git for-each-ref") && line.includes("--sort=refname")),
		"the slice is only meaningful over a deterministically ordered listing",
	);
	const deleted = deletes(b.calls).map(([ref]) => ref);
	assert.equal(deleted.length, SALVAGE_PRUNE_MAX, "exactly the bound, never more work in one call");
	assert.deepEqual(deleted, names.slice(0, SALVAGE_PRUNE_MAX), "and they are the first by refname");
	assert.ok(!deleted.includes(names[total - 1] ?? ""), "the last by refname is the one left for next time");

	const overflow = result.facts.find((line) => line.includes("further rescue ref(s) were not examined"));
	assert.ok(overflow, `no overflow fact in ${JSON.stringify(result.facts)}`);
	assert.match(overflow, new RegExp(`^1 further rescue ref\\(s\\) were not examined this call \\(bound ${SALVAGE_PRUNE_MAX}\\) and are kept$`));

	const event = readRunEvents(b.home, BR)
		.filter((entry) => entry.type === "integration_advanced")
		.map((entry) => entry.payload as Record<string, unknown>)
		.find((payload) => payload.step === "prune_salvage");
	assert.ok(event, "the prune must be journaled");
	assert.equal(event.not_examined, 1);
	assert.equal((event.pruned as string[]).length, SALVAGE_PRUNE_MAX);
	assert.deepEqual(event.kept, [], "nothing was kept for a reachability reason here");
});

test("no ref outside refs/cp-salvage/ is ever passed to a delete, whatever the listing says", async (t) => {
	const { b } = await integrateWith(t, {
		// A listing that includes refs this policy must never touch — the second
		// guard behind `for-each-ref`'s own scoping.
		salvageRefs: [
			["refs/heads/main", SALVAGED_REACHABLE],
			["refs/remotes/origin/main", SALVAGED_REACHABLE],
			["refs/cp-salvage-old/cp-x/2026", SALVAGED_REACHABLE],
			["refs/cp-salvage/", SALVAGED_REACHABLE],
			["refs/cp-salvage/../heads/main", SALVAGED_REACHABLE],
			[REF_REACHABLE, SALVAGED_REACHABLE],
		],
		reachableFromBase: { [SALVAGED_REACHABLE]: true },
	});
	assert.deepEqual(deletes(b.calls), [[REF_REACHABLE, SALVAGED_REACHABLE]]);
	for (const [ref] of deletes(b.calls)) assert.ok(isSalvageRef(ref), `${ref} is not a salvage ref`);
	assert.ok(
		!b.calls.some((line) => line.startsWith("git update-ref -d") && !line.includes(" refs/cp-salvage/")),
		"a delete may only ever name a ref under refs/cp-salvage/",
	);
});

test("a home with no rescue refs prunes nothing and says nothing about it", async (t) => {
	const { b, result } = await integrateWith(t, {});
	assert.deepEqual(deletes(b.calls), []);
	assert.ok(!result.facts.some((line) => line.includes("rescue ref")), "no refs is not a fact worth relaying");
	assert.ok(b.calls.some((line) => line.startsWith("git for-each-ref")), "the namespace is still read");
});

test("isSalvageRef admits only names strictly under refs/cp-salvage/", () => {
	assert.equal(SALVAGE_REF_PREFIX, "refs/cp-salvage/");
	assert.ok(isSalvageRef("refs/cp-salvage/cp-x/2026-09-01T10-00-00Z"));
	assert.ok(!isSalvageRef("refs/cp-salvage/"));
	assert.ok(!isSalvageRef("refs/cp-salvage-old/cp-x/2026"));
	assert.ok(!isSalvageRef("refs/heads/main"));
	assert.ok(!isSalvageRef("refs/remotes/origin/main"));
	assert.ok(!isSalvageRef("refs/cp-salvage/../heads/main"));
	assert.ok(!isSalvageRef("refs/cp-salvage/cp-x/2026 extra"));
	// Age and count are not admissible reasons at all: there is no such input.
	assert.equal(SALVAGE_PRUNE_MAX, 100);
});

test("a half-finished rebase in the worktree is surfaced, never automated over", async (t) => {
	const b = await benchOf(t);
	mkdirSync(join(b.worktree, ".git", "rebase-merge"), { recursive: true });
	b.approve(HEAD_A);
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "surface");
	assert.match(result.reason, /rebase is in progress/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

// ---------------------------------------------------------------------------
// contract-shaped guards
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// after the merge landed: the states an operator has to be able to trust
// ---------------------------------------------------------------------------

test("a head branch that cannot be deleted keeps everything else, and says so", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator({ pr: mergedPr(), deleteFails: "remote: refusing to delete a protected branch" })
		.advance({ jobId: BR });
	assert.equal(result.step, "delete_head");
	assert.equal(result.next, "retry");
	// The merge and the teardown already happened and must not be re-attempted.
	assert.equal(result.merge?.recorded, true);
	assert.equal(b.teardowns.length, 1);
	assert.equal(b.closed.length, 0, "the br issue is closed only after the head is gone");
	assert.match(result.reason, /merged and torn down/);

	// And it resumes: the next call re-reads the facts and finishes.
	const finished = await b.integrator({ pr: mergedPr(), branchOnRemote: false }).advance({ jobId: BR });
	assert.equal(finished.next, "done");
	assert.deepEqual(b.closed, [{ id: BR, reason: `merged: ${PR_URL}` }]);
	assert.equal(b.teardowns.length, 1, "teardown is not run twice");
});

test("a job close that fails leaves a merged, torn-down job in a retryable state", async (t) => {
	const b = await benchOf(t);
	b.approve(HEAD_A);
	await b.integrator().advance({ jobId: BR });
	const result = await b
		.integrator(
			{ pr: mergedPr() },
			{
				ledger: {
					async close() {
						throw new Error("br: database is locked");
					},
				},
			},
		)
		.advance({ jobId: BR });
	assert.equal(result.step, "close");
	assert.equal(result.next, "retry");
	assert.match(result.reason, /the job is still open/);
	// Everything that did land is still true, and is reported as such.
	assert.equal(result.merge?.recorded, true);
	assert.equal(b.teardowns.length, 1);
	assert.ok(existsSync(join(b.home, paths.mergeFile(BR))));

	const finished = await b.integrator({ pr: mergedPr(), branchOnRemote: false }).advance({ jobId: BR });
	assert.equal(finished.next, "done");
	assert.equal(finished.end_state?.br_closed, true);
	assert.deepEqual(b.closed, [{ id: BR, reason: `merged: ${PR_URL}` }]);
});

test("cp_integrate and cp_merged are parent-only tools", () => {
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_integrate"));
	assert.ok(WORKER_FORBIDDEN_TOOLS.includes("cp_merged"));
});

test("src/ci-wait.ts still refuses a worker's blocking watch (this design promised not to weaken it)", () => {
	assert.equal(detectCiWait("gh run watch 123 --exit-status")?.shape, "blocking_watch");
	assert.equal(detectCiWait("gh pr checks 61 --watch")?.shape, "blocking_watch");
});

test("an unreviewed head refuses before merge: next is review, no gh mutation", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(result.step, "review");
	assert.equal(result.head_sha, HEAD_A);
	assert.match(result.reason, /cp_review/);
	assert.match(result.reason, /unchanged/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr update-branch")).length, 0);
});

test("a passing cp_review on this head lets the merge proceed", async (t) => {
	const b = await benchOf(t);
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "advance");
	assert.ok(b.calls.some((line) => line.startsWith("gh pr merge")));
});

test("a recorded patch-equivalent pass is accepted as reviewed", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_B, { equivalentTo: { head_sha: HEAD_A, attempt: 1 } });
	const result = await b
		.integrator({
			pr: { ...openPr(), headRefOid: HEAD_B },
			runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }],
		})
		.advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "advance");
	assert.ok(b.calls.some((line) => line.startsWith("gh pr merge")));
});

test("a head that moved after the pass is not reviewed", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({
			pr: { ...openPr(), headRefOid: HEAD_B },
			runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }],
		})
		.advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(result.head_sha, HEAD_B);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a revise verdict is not a pass", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_A, { verdict: "revise" });
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("a flagged escalate without an approved diff checkpoint is not reviewed", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_A, { verdict: "escalate", cause: "flagged" });
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("an approved diff checkpoint on a flagged escalate of this head lets the merge proceed", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_A, { verdict: "escalate", cause: "flagged" });
	const diff = new CheckpointStore(b.home, { kind: "diff" });
	diff.request({ jobId: BR, question: "Accept the flagged diff?" });
	diff.decide(BR, true, { by: "operator command" });
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.step, "merge");
	assert.equal(result.next, "advance");
	assert.ok(b.calls.some((line) => line.startsWith("gh pr merge")));
});

test("a historical pass or approved flag on a truncated subject never authorizes the merge", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_A, { truncated: true });
	writeReviewPass(b.home, HEAD_A, { attempt: 2, verdict: "escalate", cause: "flagged", truncated: true });
	const diff = new CheckpointStore(b.home, { kind: "diff" });
	diff.request({ jobId: BR, question: "Accept the flagged diff?" });
	diff.decide(BR, true, { by: "operator command" });
	const result = await b.integrator().advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("an approved diff checkpoint does not cover a head that moved after the flagged escalate", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	writeReviewPass(b.home, HEAD_A, { verdict: "escalate", cause: "flagged" });
	const diff = new CheckpointStore(b.home, { kind: "diff" });
	diff.request({ jobId: BR, question: "Accept the flagged diff?" });
	diff.decide(BR, true, { by: "operator command" });
	const result = await b
		.integrator({
			pr: { ...openPr(), headRefOid: HEAD_B },
			runs: [{ status: "completed", conclusion: "success", headSha: HEAD_B, workflowName: "ci" }],
		})
		.advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("the human_checkpoint fallback refuses an unreviewed head the same way", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	b.approve(HEAD_A);
	const result = await b.integrator({ pr: { ...openPr(), mergeStateStatus: undefined } }).advance({ jobId: BR });
	assert.equal(result.next, "review");
	assert.equal(result.step, "review");
	assert.match(result.reason, /cp_review/);
	assert.equal(b.calls.filter((line) => line.startsWith("gh pr merge")).length, 0);
});

test("cp_integrate refuses a job that is not a delivery:pr ship job", async (t) => {
	const b = await benchOf(t, { kind: "research", delivery: "pipeline" });
	await assert.rejects(() => b.integrator().advance({ jobId: BR }), /delivery:pr ship job/);
});

test("one job's three authorizations are three files, three ids, and never each other", async (t) => {
	const b = await benchOf(t);
	const ship = new CheckpointStore(b.home);
	const diff = new CheckpointStore(b.home, { kind: "diff" });
	const merge = new CheckpointStore(b.home, { kind: "merge" });

	ship.request({ jobId: BR, question: "ship the plan?" });
	diff.request({ jobId: BR, question: "ship this diff?" });
	merge.request({ jobId: BR, scope: HEAD_A.slice(0, 12), question: `merge at ${HEAD_A.slice(0, 12)}?` });
	merge.request({ jobId: BR, scope: HEAD_B.slice(0, 12), question: `merge at ${HEAD_B.slice(0, 12)}?` });

	// Three distinct files, each addressed by its own store.
	assert.equal(paths.checkpointFile(BR), `.pi-command-post/state/checkpoints/${BR}.json`);
	assert.equal(paths.checkpointFile(BR, "diff"), `.pi-command-post/state/checkpoints/${BR}.diff.json`);
	assert.equal(
		paths.checkpointFile(BR, "merge", HEAD_A.slice(0, 12)),
		`.pi-command-post/state/checkpoints/${BR}.merge-${HEAD_A.slice(0, 12)}.json`,
	);

	// listPending reports the *job id*, not a file stem: `<id>.diff` was never one.
	assert.deepEqual(
		ship.listPending().map((entry) => entry.job_id),
		[BR],
	);
	assert.deepEqual(
		diff.listPending().map((entry) => entry.job_id),
		[BR],
	);
	const pendingMerges = merge.listPending();
	assert.equal(pendingMerges.length, 2, "one authorization per head sha");
	for (const entry of pendingMerges) assert.equal(entry.job_id, BR);

	// And four distinct Awaiting-you ids, so none of them is unanswerable.
	const ids = deriveFromCheckpoints([...ship.listPending(), ...diff.listPending(), ...pendingMerges]).map(
		(row) => row.id,
	);
	assert.equal(new Set(ids).size, 4, `ids collided: ${ids.join(", ")}`);
	assert.ok(ids.includes(`aw-checkpoint-${BR}`), "the ship row must keep the id it always had");
	// The suffix mirrors the file name, and is collision-safe for the same reason
	// that name is: a job id can never contain a `.`.
	assert.ok(ids.includes(`aw-checkpoint-${BR}.diff`));
	assert.ok(ids.includes(`aw-checkpoint-${BR}.merge-${HEAD_A.slice(0, 12)}`));
	assert.deepEqual(parseCheckpointAwaitingId(`aw-checkpoint-${BR}.merge-${HEAD_A.slice(0, 12)}`), {
		job_id: BR,
		kind: "merge",
		scope: HEAD_A.slice(0, 12),
	});
	// Every one of them is still recognisably derived, so cp_awaiting keeps refusing it.
	for (const id of ids) assert.ok(isDerivedAwaitingId(id), `${id} is not recognisable as a derived row`);
});

test("the generated conflict message is the promote text, not a model's prose", () => {
	const message = conflictMessage({ jobId: BR, branch: BR, prUrl: PR_URL, base: "main" });
	assert.match(message, new RegExp(`git fetch origin && git reset --hard origin/${BR}`));
	assert.match(message, /second PR, never a new branch/);
});

// ---------------------------------------------------------------------------
// jje.3: one operator-approved final fix at the review cap
// ---------------------------------------------------------------------------

const HEAD_C = "ffffffffffff6666666666666666666666666666";
const QUOTE = "yes, one final fix for cp-int1";
const NO_FLAG = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

/** The fix report: intake's own record shape, as the worker would have filed it. */
function writeShipEnvelope(home: string, head: string): void {
	const envelope = { job_id: BR, kind: "ship", status: "done", summary: "fixed", branch: BR, head_sha: head, pr_url: PR_URL } as Envelope;
	const stored: EnvelopeRecord = { schema_version: SCHEMA_VERSION, job_id: BR, received_at: isoTimestamp(), attempt: 1, envelope };
	writeFileSync(join(home, paths.envelopeFile(BR)), JSON.stringify(stored));
}

/** Five reviews on HEAD_A; the fifth is a complete capped revise, so its one final-fix question is pending. */
function capAt(home: string, extra: { truncated?: boolean } = {}): Checkpoint | undefined {
	for (let attempt = 1; attempt < REVIEW_MAX_ATTEMPTS; attempt += 1) writeReviewPass(home, HEAD_A, { attempt, verdict: "revise" });
	const capped: DiffVerdict = {
		schema_version: SCHEMA_VERSION, job_id: BR, attempt: REVIEW_MAX_ATTEMPTS, verdict: "escalate", cause: "policy", flags: NO_FLAG,
		reasons: ["[severity: high] [confidence: high] the retry path is untested", `review cap: this is review ${REVIEW_MAX_ATTEMPTS} of ${REVIEW_MAX_ATTEMPTS}`],
		decided_at: isoTimestamp(), head_sha: HEAD_A, diff_stat: { files: 1, truncated: extra.truncated ?? false },
		...(extra.truncated ? {} : { model: "mock/reviewer" }),
	};
	writeFileSync(join(home, paths.reviewFile(BR, REVIEW_MAX_ATTEMPTS)), JSON.stringify(capped));
	writeShipEnvelope(home, HEAD_A);
	const review = { job_id: BR, verdict: "revise" as const, flags: NO_FLAG, reasons: ["the retry path is untested"], revisions: ["add a test for the retry path"] };
	return requestFinalFix(home, { verdict: capped, review, prUrl: PR_URL });
}

function answerFinalFix(home: string, approved: boolean, by = "operator-quote"): void {
	new CheckpointStore(home, { kind: "final_fix" }).decide(BR, approved, { by, basis: { operator_quote: QUOTE }, scope: HEAD_A.slice(0, 12) });
}

/** The live implementer: cp_send reopens the envelope slot, exactly as `Sender` does. */
function reopeningSender(b: Bench): (jobId: string, message: string) => Promise<{ receipt: string }> {
	return async (jobId, message) => (b.sent.push({ jobId, message }), await reopen(b), { receipt: "delivered" });
}
const reopen = (b: Bench) => reopenEnvelopeSlot({ home: b.home, fleet: b.fleet, runs: b.runs, jobId: BR, reason: "test promote" });

async function reportFix(b: Bench, head: string): Promise<void> {
	writeShipEnvelope(b.home, head);
	await b.fleet.patch(BR, { reported_at: isoTimestamp(), phase: "held" });
}

/** Capped, approved on a quote, promoted once and reported at HEAD_B. */
async function reportedFix(t: { after(fn: () => void | Promise<void>): void }): Promise<{ b: Bench; send: BenchOptions }> {
	const b = await benchOf(t, {}, { reviewHead: false });
	capAt(b.home);
	answerFinalFix(b.home, true);
	const send = { send: reopeningSender(b) };
	await b.integrator({}, send).advance({ jobId: BR });
	await reportFix(b, HEAD_B);
	return { b, send };
}

const onHead = (head: string, conclusion = "success"): Partial<World> => ({ pr: { ...openPr(), headRefOid: head }, runs: [{ status: "completed", conclusion, headSha: head }] });
const merges = (b: Bench) => b.calls.filter((line) => line.startsWith("gh pr merge"));

test("jje.3: one operator approval and exactly one reported fix merge the fix head via cp_integrate", async (t) => {
	const b = await benchOf(t, {}, { reviewHead: false });
	const asked = capAt(b.home);
	assert.equal(asked?.decision, "pending");
	assert.match(asked?.evidence?.join("\n") ?? "", /add a test for the retry path/);
	const send = { send: reopeningSender(b) };

	const pending = await b.integrator({}, send).advance({ jobId: BR });
	assert.deepEqual([pending.next, pending.reason.includes(`aw-checkpoint-${BR}.final-fix-${HEAD_A.slice(0, 12)}`), b.sent.length], ["surface", true, 0]);

	answerFinalFix(b.home, true);
	const promoted = await b.integrator({}, send).advance({ jobId: BR });
	assert.deepEqual([promoted.next, b.sent.length, readFinalFixRecord(b.home, BR)?.fix_generation], ["resolve", 1, 2]);
	assert.match(b.sent[0]?.message ?? "", /- add a test for the retry path\n- the retry path is untested/);

	const waiting = await b.integrator({}, send).advance({ jobId: BR });
	assert.equal(waiting.next, "resolve", "an unreported fix is not a fix");
	assert.equal(b.sent.length, 1, "the implementer is promoted exactly once");

	await reportFix(b, HEAD_B);
	const merged = await b.integrator(onHead(HEAD_B), send).advance({ jobId: BR });
	assert.equal(merged.step, "merge");
	assert.equal(matchHeadBinding(merges(b)[0] ?? "")?.head, HEAD_B, "--match-head-commit binds the fix head");
	assert.ok(merged.facts.some((fact) => /operator-approved final fix at bbbbbbbbbbbb/.test(fact)));
	const { capped_head, pr_url, fix_generation, fix_head, decided_by, basis } = readFinalFixRecord(b.home, BR) ?? {};
	assert.deepEqual({ capped_head, pr_url, fix_generation, fix_head, decided_by, basis }, { capped_head: HEAD_A, pr_url: PR_URL, fix_generation: 2, fix_head: HEAD_B, decided_by: "operator-quote", basis: { operator_quote: QUOTE } });
	assert.equal(existsSync(join(b.home, paths.reviewFile(BR, REVIEW_MAX_ATTEMPTS + 1))), false, "no sixth review");
});

test("jje.3: a push after the fix report, or a second report, voids the final fix for good", async (t) => {
	for (const later of ["push", "report"] as const) {
		const { b, send } = await reportedFix(t);
		if (later === "report") await reopen(b).then(() => reportFix(b, HEAD_B));
		const moved = await b.integrator(onHead(later === "push" ? HEAD_C : HEAD_B), send).advance({ jobId: BR });
		assert.equal(moved.next, "surface", later);
		assert.match(moved.reason, /is void/);
		assert.ok(readFinalFixRecord(b.home, BR)?.invalidated, `${later}: the void is recorded`);
		const back = await b.integrator(onHead(HEAD_B), send).advance({ jobId: BR });
		assert.equal(back.next, "surface", `${later}: a voided fix never comes back`);
		assert.equal(merges(b).length, 0, later);
	}
});

test("jje.3: approval is bound to its PR and its capped head, and needs an operator quote on every surface", async (t) => {
	for (const how of ["other-pr", "moved-head"] as const) {
		const b = await benchOf(t, {}, { reviewHead: false });
		capAt(b.home);
		// /cp-authorize and the Awaiting dialog carry no quote, so they cannot approve it.
		assert.throws(() => new CheckpointStore(b.home, { kind: "final_fix" }).decide(BR, true, { by: "operator command", scope: HEAD_A.slice(0, 12) }), /only with an operator quote/);
		answerFinalFix(b.home, true);
		const world = how === "other-pr" ? { pr: { ...openPr(), url: "https://github.com/o/r/pull/62" } } : onHead(HEAD_B);
		const result = await b.integrator(world, { send: reopeningSender(b) }).advance({ jobId: BR });
		assert.match(result.reason, how === "other-pr" ? /another PR never inherits it/ : /head moved to bbbbbbbbbbbb before promotion/);
		assert.deepEqual([result.next, b.sent.length, merges(b).length, readFinalFixRecord(b.home, BR)], ["surface", 0, 0, undefined], how);
	}
});

test("jje.3: a later report (even at the same head) or another PR drops the fix head from the merge-ask gate at once", async (t) => {
	for (const how of ["report", "pr"] as const) {
		const { b } = await reportedFix(t);
		assert.equal(resolveFinalFix(b.home, b.fleet.require(BR), HEAD_B).state, "accepted", "the fix report binds HEAD_B");
		assert.deepEqual(readReviewPassHeads(b.home, BR), [HEAD_B]);
		if (how === "report") await reopen(b).then(() => reportFix(b, HEAD_B));
		else await b.fleet.patch(BR, { receipts: [{ ...PR_RECEIPT, url: "https://github.com/o/r/pull/62" }] });
		assert.deepEqual(readReviewPassHeads(b.home, BR), [], `${how}: never exposed before integrate re-resolves it`);
		if (how === "report") assert.ok(readFinalFixRecord(b.home, BR)?.invalidated, "the new generation voids it for good");
	}
});

test("jje.3: red CI on the approved fix head never merges", async (t) => {
	const { b, send } = await reportedFix(t);
	const red = await b.integrator(onHead(HEAD_B, "failure"), send).advance({ jobId: BR });
	assert.equal(red.step, "ci");
	assert.equal(merges(b).length, 0);
});

test("jje.3: declined, mandate-granted or truncated caps cannot merge and spawn nothing", async (t) => {
	for (const how of ["declined", "mandate", "truncated"] as const) {
		const b = await benchOf(t, {}, { reviewHead: false });
		const asked = capAt(b.home, { truncated: how === "truncated" });
		if (how === "truncated") {
			assert.equal(asked, undefined, "an incomplete subject declares no final fix");
			new CheckpointStore(b.home, { kind: "final_fix" }).request({ jobId: BR, scope: HEAD_A.slice(0, 12), question: "forged?" });
		}
		answerFinalFix(b.home, how !== "declined", how === "mandate" ? "mandate:md-abcd" : "operator-quote");
		const result = await b.integrator({}, { send: reopeningSender(b) }).advance({ jobId: BR });
		assert.deepEqual([result.step === "merge", b.sent.length, merges(b).length, readFinalFixRecord(b.home, BR)], [false, 0, 0, undefined], `${how}: nothing is promoted or merged`);
	}
});

test("jje.5: the approved final-fix head of a draft is marked ready, then merges", async (t) => {
	const { b, send } = await reportedFix(t);
	const ready = await b.integrator({ ...onHead(HEAD_B), pr: { ...draftPr(), headRefOid: HEAD_B } }, send).advance({ jobId: BR });
	assert.deepEqual([ready.next, count(b, "gh pr ready"), merges(b).length], ["advance", 1, 0]);
	await b.integrator(onHead(HEAD_B), send).advance({ jobId: BR });
	assert.equal(matchHeadBinding(merges(b)[0] ?? "")?.head, HEAD_B);
});
