// Retained constructor and helper contracts have no public entry point; see docs/testing-migration/s11b.md.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore, deriveFromCheckpoints, isDerivedAwaitingId } from "../src/awaiting.ts";
import { makeHandoff } from "../src/human-handoff.ts";
import type { ParkFacts, ParkResult } from "../src/awaiting-merge.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
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
} from "../src/contracts.ts";
import type { IntegrationNext } from "../src/contracts.ts";
import type { ChangeRequestObservation, ObservationOutcome } from "../src/forges/adapter.ts";
import { readFinalFixRecord, requestFinalFix } from "../src/final-fix.ts";
import { FleetStore } from "../src/fleet.ts";
import { IntegrationHolds } from "../src/integration-hold.ts";
import { MainCiStore } from "../src/main-ci.ts";
import { reopenEnvelopeSlot } from "../src/supersede.ts";
import {
	Integrator,
	isSalvageRef,
	type IntegratorOptions,
	type LedgerLike,
	type TeardownLike,
} from "../src/integrate.ts";
import type { CommandRunner, MergeStoreOptions } from "../src/merges.ts";
import { MergeStore } from "../src/merges.ts";
import { RunRegistry } from "../src/runs.ts";
import type { TeardownResult } from "../src/teardown.ts";
import { createScratchHome, fakeWorkerManager } from "./harness/index.ts";
import { HeldRelease } from "../src/held-release.ts";
import { answerActions, type FakeRun } from "./harness/actions-api.ts";
const JOB_ID = "cp-int1";
const PR_URL = "https://github.com/o/r/pull/61";
const HEAD_A = "aaaaaaaaaaaa1111111111111111111111111111";
const HEAD_B = "bbbbbbbbbbbb2222222222222222222222222222";
const MERGE_COMMIT = "cccccccccccc3333333333333333333333333333";
const BASE_TIP = "dddddddddddd4444444444444444444444444444";
const FORK_POINT = "eeeeeeeeeeee5555555555555555555555555555";
const PR_RECEIPT: Receipt = { kind: "pr", status: "open", title: `PR for ${JOB_ID}`, url: PR_URL };

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
		job_id: JOB_ID,
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
		? join(home, paths.reviewEquivalenceFile(JOB_ID, head))
		: join(home, paths.reviewFile(JOB_ID, attempt));
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

type CiRunJson = FakeRun;

interface World {
	/** What `gh pr view` answers, or a failure. */
	pr: PrJson | GhFail;
	/** Every Actions run the fake API knows (served per exact head), or a failure. */
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
		headRefName: JOB_ID,
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
			if (args[0] === "api" && answerActions(String(args[1]), []) !== undefined) {
				if ("fail" in world.runs) return { status: 1, stdout: "", stderr: world.runs.fail };
				return { status: 0, stdout: answerActions(String(args[1]), world.runs) ?? "", stderr: "" };
			}
			throw new Error(`unexpected gh call: ${line}`);
		}
		if (bin === "git") {
			if (args[0] === "fetch") {
				// `git fetch origin main` in the clone is the retention policy's own
				// (cp-wcy5); `--prune` is the freshness check's and `<JOB_ID>` is the sync
				// step's, and neither is what `baseFetchFails` is about.
				const target = args[args.length - 1] ?? "";
				if (world.baseFetchFails && cwd !== worktree && target !== JOB_ID && target !== "--prune") {
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
					if (args[args.length - 1] !== JOB_ID) {
						if (world.syncBaseLsRemoteFails) return { status: 128, stdout: "", stderr: world.syncBaseLsRemoteFails };
						const base = world.syncBaseSha ?? BASE_TIP;
						return { status: 0, stdout: base.length > 0 ? `${base}\trefs/heads/main\n` : "", stderr: "" };
					}
					if (world.syncLsRemoteFails) return { status: 128, stdout: "", stderr: world.syncLsRemoteFails };
					const sha = world.syncRemoteSha ?? HEAD_A;
					return { status: 0, stdout: sha.length > 0 ? `${sha}\trefs/heads/${JOB_ID}\n` : "", stderr: "" };
				}
				// In the clone: the head branch (`#branchOnRemote`), or the base tip the
				// retention policy proves reachability against.
				if (args[args.length - 1] !== JOB_ID) {
					if (world.pruneBaseLsRemoteFails) return { status: 128, stdout: "", stderr: world.pruneBaseLsRemoteFails };
					const base = world.pruneBaseSha ?? BASE_TIP;
					return { status: 0, stdout: base.length > 0 ? `${base}\trefs/heads/main\n` : "", stderr: "" };
				}
				return {
					status: 0,
					stdout: world.branchOnRemote ? `${HEAD_A}\trefs/heads/${JOB_ID}\n` : "",
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
	now?: () => Date;
	run?: CommandRunner;
	/** `undefined` means no sender is wired at all. */
	send?: (jobId: string, message: string) => Promise<{ receipt: string; error?: string }>;
	teardown?: TeardownLike;
	ledger?: LedgerLike;
	noSender?: boolean;
	/** `false` — the default — means the real AwaitingStore, at the bench's home. */
	noAwaiting?: boolean;
	/** Wires the human-handoff port with a registry that knows only the bench's project ("demo"). */
	policy?: "repo" | "human_handoff";
	/** awaiting_merge PR6: the handoff's park port, as CommandPost wires it. */
	park?: (jobId: string, facts: ParkFacts) => Promise<ParkResult>;
	/** unload-parent PR2: the infra-rerun port, as CommandPost wires it. */
	infraRerun?: IntegratorOptions["infraRerun"];
	/** k52/cp-oc0m: whether a main-CI latch is enforced, as CommandPost wires it. */
	mainCiScope?: IntegratorOptions["mainCiScope"];
	/** Forge PR 3: the GitLab observer, wired into both the MergeStore and the Integrator. */
	observer?: IntegratorOptions["observer"];
	/** #326: the MergeStore's after-merge port, as CommandPost wires it. */
	afterRecorded?: MergeStoreOptions["afterRecorded"];
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
	const worktree = join(home.path, "worktrees", JOB_ID);

	await fleet.add({
		job_id: JOB_ID,
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
		branch: JOB_ID,
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
				branch: JOB_ID,
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
			store.request({ jobId: JOB_ID, scope, question: `Merge ${PR_URL} for ${JOB_ID} at ${scope}?` });
			store.decide(JOB_ID, true, { by: "operator command", scope });
		},
		integrator(worldPatch = {}, options = {}) {
			const world = defaultWorld(worldPatch);
			const run = options.run ?? runnerFor(world, calls, worktree);
			const merges = new MergeStore({ home: home.path, fleet, runs, run, ...(options.observer ? { observer: options.observer } : {}), ...(options.afterRecorded ? { afterRecorded: options.afterRecorded } : {}) });
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
				...(options.now ? { now: options.now } : {}),
				...(options.noAwaiting ? {} : { awaiting: () => new AwaitingStore({ home: home.path }) }),
				...(options.infraRerun ? { infraRerun: options.infraRerun } : {}),
				...(options.mainCiScope ? { mainCiScope: options.mainCiScope } : {}),
				...(options.observer ? { observer: options.observer } : {}),
				...(options.policy ? { handoff: makeHandoff({ registry: { get: (name) => (name === "demo" ? { merge_policy: options.policy } : undefined) }, awaiting: () => new AwaitingStore({ home: home.path }), runs, ...(options.park ? { park: options.park } : {}) }) } : {}),
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

// ---------------------------------------------------------------------------
// 1. the happy path, one call at a time
// ---------------------------------------------------------------------------

/** picp-wzq: a held step may read the PR and its CI, and do nothing else. */
function onlyHeldReads(calls: Calls): void {
	for (const call of calls) assert.match(call, /^gh (pr view |api repos\/\{owner\}\/\{repo\}\/actions\/runs[?/])/, `a held step ran ${call}`);
}

const heldRed = { runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A, workflowName: "ci", databaseId: 77 }] };

test("held repair waits for active, failed, terminal or unreported fleet records", async (t) => {
	for (const phase of ["waiting", "launching", "failed", "done", "unreported", "held"] as const) {
		const b = await benchOf(t);
		new IntegrationHolds(b.home).hold(JOB_ID, "QA");
		const record = b.fleet.require(JOB_ID);
		const changed = { ...record, phase, ...(phase === "held" ? { reported_at: undefined } : {}) };
		const mock = t.mock.method(b.fleet, "get", () => changed);
		const result = await b.integrator(heldRed).advance({ jobId: JOB_ID });
		assert.equal(result.next, "wait", phase);
		assert.equal(b.sent.length, 0);
		assert.equal(result.record.resolve_attempts, 0);
		onlyHeldReads(b.calls);
		mock.mock.restore();
	}
});
/** cp-oc0m: an active mandate covers "demo" and this machine's gh login is "me". */
const OWN_SCOPE = { mainCiScope: async () => ({ enforce: true as const, login: "me" }) };

test("k52/cp-oc0m: no active mandate, an unreadable login, a foreign row or no scope port never blocks", async (t) => {
	const scopes: Array<[string, IntegratorOptions["mainCiScope"] | undefined, string]> = [
		["no active mandate", async () => ({ enforce: false, reason: "no active mandate covers demo" }), "me"],
		["unreadable login", async () => ({ enforce: false, reason: "gh api user --jq .login unreadable: boom" }), "me"],
		["no scope port", undefined, "me"],
		["foreign row", OWN_SCOPE.mainCiScope, "other"],
	];
	for (const [label, mainCiScope, login] of scopes) {
		const b = await benchOf(t);
		new MainCiStore({ home: b.home }).setRed("demo", HEAD_B, { failing: "structure", login });
		const result = await b.integrator({ ancestor: false }, mainCiScope ? { mainCiScope } : {}).advance({ jobId: JOB_ID });
		assert.notEqual(result.next, "wait", label);
		assert.ok(result.facts.some((fact) => /^main-ci: .*not blocking/.test(fact)), label);
		assert.equal(b.calls.filter((call) => call.startsWith("gh pr merge")).length, 1, label);
	}
});

const draftPr = (): PrJson => ({ ...openPr(), isDraft: true });
const count = (b: Bench, prefix: string) => b.calls.filter((line) => line.startsWith(prefix)).length;

for (const permission of ["CLEAN", undefined]) {
	for (const phase of ["waiting", "launching"] as const) {
		test(`picp-03o: a ${phase} worker blocks the ${permission === "CLEAN" ? "repo-derived" : "human-checkpoint"} merge until it reports`, async (t) => {
			const b = await benchOf(t);
			writeShipEnvelope(b.home, HEAD_A);
			b.approve(HEAD_A);
			await reopen(b);
			// launching is currently script/local-only; exercise the merge guard without writing an invalid fleet.
			const waiting = b.fleet.require(JOB_ID);
			const mock = phase === "launching" ? t.mock.method(b.fleet, "get", () => ({ ...waiting, phase })) : undefined;
			const integration = b.integrator({ pr: { ...openPr(), mergeStateStatus: permission } });
			const result = await integration.advance({ jobId: JOB_ID });
			assert.equal(result.next, "resolve");
			assert.match(result.reason, new RegExp(`worker phase ${phase}`));
			assert.match(result.reason, /wait for its report/i);
			assert.deepEqual(b.calls.filter((call) => !call.startsWith("gh pr view")), []);
			assert.equal(b.sent.length + b.teardowns.length + b.closed.length, 0);
			assert.equal(result.record.resolve_attempts, 0, "waiting never spends another promotion");
			mock?.mock.restore();
			await reportFix(b, HEAD_A);
			const resumed = await integration.advance({ jobId: JOB_ID });
			assert.equal(resumed.next, "advance");
			assert.equal(resumed.record.merge_authority?.kind, permission === "CLEAN" ? "repo_derived" : "human_checkpoint");
			assert.equal(merges(b).length, 1);
		});
	}

}

test("picp-03o: integration cannot merge while its promotion is still in flight", async (t) => {
	const b = await benchOf(t);
	writeShipEnvelope(b.home, HEAD_A);
	const entered = { resolve: () => {}, promise: Promise.resolve() };
	entered.promise = new Promise<void>((resolve) => { entered.resolve = resolve; });
	const release = { resolve: () => {}, promise: Promise.resolve() };
	release.promise = new Promise<void>((resolve) => { release.resolve = resolve; });
	const world = defaultWorld({ runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] });
	const integration = b.integrator({}, {
		run: runnerFor(world, b.calls, b.worktree),
		send: async () => {
			entered.resolve();
			await release.promise;
			await reopen(b);
			return { receipt: "delivered" };
		},
	});
	const first = integration.advance({ jobId: JOB_ID });
	await entered.promise;
	try {
		world.runs = defaultWorld().runs;
		assert.equal((await integration.advance({ jobId: JOB_ID })).next, "resolve");
		assert.equal(merges(b).length, 0);
	} finally {
		release.resolve();
		await first;
	}
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
	const first = integrator.advance({ jobId: JOB_ID });
	await entered.promise;
	try {
		assert.equal((await integrator.advance({ jobId: JOB_ID })).next, "resolve");
		assert.equal(sends, 1);
	} finally {
		release.resolve();
		await first;
	}
});

test("4B1-T4: promoting(job) is true while the repair send is in flight, and HeldRelease never releases it then", async (t) => {
	const b = await benchOf(t);
	const entered = { resolve: () => { }, promise: Promise.resolve() };
	entered.promise = new Promise<void>((resolve) => { entered.resolve = resolve; });
	const release = { resolve: () => { }, promise: Promise.resolve() };
	release.promise = new Promise<void>((resolve) => { release.resolve = resolve; });
	const integrator = b.integrator({ runs: [{ status: "completed", conclusion: "failure", headSha: HEAD_A }] }, {
		send: async () => {
			entered.resolve();
			await release.promise;
			return { receipt: "delivered" };
		},
	});
	const workers = fakeWorkerManager(b.home, 5);
	workers.spawn(JOB_ID);
	const held = new HeldRelease({
		home: b.home, fleet: b.fleet, manager: workers.manager,
		busy: { sending: () => false, promoting: (id) => integrator.promoting(id), driving: () => false },
		integration: () => undefined, journal: () => {},
	});
	await b.fleet.patch(JOB_ID, { phase: "held" });
	assert.equal(integrator.promoting(JOB_ID), false);
	assert.deepEqual(held.releasable(), [JOB_ID]);
	const first = integrator.advance({ jobId: JOB_ID });
	await entered.promise;
	try {
		assert.equal(integrator.promoting(JOB_ID), true);
		assert.deepEqual(held.releasable(), []);
	} finally {
		release.resolve();
		await first;
	}
	assert.equal(integrator.promoting(JOB_ID), false);
});

test("with no sender wired at all, a conflict surfaces rather than silently stalling", async (t) => {
	const b = await benchOf(t);
	const result = await b
		.integrator({ pr: { ...openPr(), mergeable: "CONFLICTING" } }, { noSender: true })
		.advance({ jobId: JOB_ID });
	assert.equal(result.next, "surface");
});

// Forge PR 3: a GitLab MR is observed, never merged. Every case runs zero gh commands.
const MR_URL = "https://gitlab.example.com/group/sub/repo/-/merge_requests/7";
const MR_RECEIPT = { ...PR_RECEIPT, url: MR_URL };

function gitlabMr(observation: Partial<ChangeRequestObservation> | Exclude<ObservationOutcome, { ok: true }>, asked: string[] = []): IntegratorOptions["observer"] {
	return (ref) => ({
		provider: "gitlab",
		readChangeRequest: async () => {
			asked.push(ref);
			if ("ok" in observation) return observation;
			return { ok: true, observation: { provider: "gitlab", url: MR_URL, number: 7, state: "merged", source_branch: JOB_ID, target_branch: "develop", head_sha: HEAD_A, squash_commit_sha: MERGE_COMMIT, merged_at: "2026-10-07T10:00:00Z", ...observation } };
		},
	});
}

test("forge PR 3: open, closed, foreign, unreadable and held GitLab MRs stop with a named reason and touch nothing", async (t) => {
	const cases: Array<[string, Parameters<typeof gitlabMr>[0], IntegrationNext, RegExp]> = [
		["opened", { state: "open", squash_commit_sha: undefined, merged_at: undefined }, "surface", /merge it on GitLab, then re-run cp_integrate/],
		["unknown", { state: "unknown", squash_commit_sha: undefined, merged_at: undefined }, "surface", /is unknown/],
		["closed", { state: "closed", squash_commit_sha: undefined, merged_at: undefined }, "surface", /closed and was never merged/],
		["another branch", { source_branch: "someone-else" }, "surface", /not this job's delivery/],
		["merged, no target", { target_branch: undefined }, "surface", /merged, but GitLab named no target branch/],
		["unavailable", { ok: false, reason: "unavailable", detail: "HTTP 503 (service unavailable)" }, "retry", /could not be read \(unavailable: HTTP 503/],
		["fork", { ok: false, reason: "unsupported", detail: "fork (cross-project) merge requests are not supported in v1" }, "surface", /unsupported: fork/],
	];
	for (const [name, observation, next, reason] of cases) {
		const b = await benchOf(t, { receipts: [MR_RECEIPT] });
		const result = await b.integrator({}, { observer: gitlabMr(observation) }).advance({ jobId: JOB_ID });
		assert.equal(result.next, next, `${name}: ${result.reason}`);
		assert.match(result.reason, reason, name);
		assert.deepEqual(b.calls, [], `${name}: no gh ready/CI/merge/rebase and no git`);
		assert.ok(!existsSync(join(b.home, paths.mergeFile(JOB_ID))), `${name}: no receipt`);
		assert.equal(b.mergeCheckpoints().get(JOB_ID, { scope: HEAD_A.slice(0, 12) }), undefined, `${name}: no merge approval fallback`);
		assert.equal(b.teardowns.length + b.closed.length + b.sent.length, 0, name);
	}

	const held = await benchOf(t, { receipts: [MR_RECEIPT] });
	new IntegrationHolds(held.home).hold(JOB_ID, "operator pause");
	const waiting = await held.integrator({}, { observer: () => assert.fail("a held job reads nothing") }).advance({ jobId: JOB_ID });
	assert.equal(waiting.next, "wait");
	assert.match(waiting.reason, /GitLab CI is not read in v1.*integration held: operator pause/);
	assert.deepEqual(held.calls, []);
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

test("one job's three authorizations are three files, three ids, and never each other", async (t) => {
	const b = await benchOf(t);
	const ship = new CheckpointStore(b.home);
	const diff = new CheckpointStore(b.home, { kind: "diff" });
	const merge = new CheckpointStore(b.home, { kind: "merge" });

	ship.request({ jobId: JOB_ID, question: "ship the plan?" });
	diff.request({ jobId: JOB_ID, question: "ship this diff?" });
	merge.request({ jobId: JOB_ID, scope: HEAD_A.slice(0, 12), question: `merge at ${HEAD_A.slice(0, 12)}?` });
	merge.request({ jobId: JOB_ID, scope: HEAD_B.slice(0, 12), question: `merge at ${HEAD_B.slice(0, 12)}?` });

	// Three distinct files, each addressed by its own store.
	assert.equal(paths.checkpointFile(JOB_ID), `.pi-command-post/state/checkpoints/${JOB_ID}.json`);
	assert.equal(paths.checkpointFile(JOB_ID, "diff"), `.pi-command-post/state/checkpoints/${JOB_ID}.diff.json`);
	assert.equal(
		paths.checkpointFile(JOB_ID, "merge", HEAD_A.slice(0, 12)),
		`.pi-command-post/state/checkpoints/${JOB_ID}.merge-${HEAD_A.slice(0, 12)}.json`,
	);

	// listPending reports the *job id*, not a file stem: `<id>.diff` was never one.
	assert.deepEqual(
		ship.listPending().map((entry) => entry.job_id),
		[JOB_ID],
	);
	assert.deepEqual(
		diff.listPending().map((entry) => entry.job_id),
		[JOB_ID],
	);
	const pendingMerges = merge.listPending();
	assert.equal(pendingMerges.length, 2, "one authorization per head sha");
	for (const entry of pendingMerges) assert.equal(entry.job_id, JOB_ID);

	// And four distinct Awaiting-you ids, so none of them is unanswerable.
	const ids = deriveFromCheckpoints([...ship.listPending(), ...diff.listPending(), ...pendingMerges]).map(
		(row) => row.id,
	);
	assert.equal(new Set(ids).size, 4, `ids collided: ${ids.join(", ")}`);
	assert.ok(ids.includes(`aw-checkpoint-${JOB_ID}`), "the ship row must keep the id it always had");
	// The suffix mirrors the file name, and is collision-safe for the same reason
	// that name is: a job id can never contain a `.`.
	assert.ok(ids.includes(`aw-checkpoint-${JOB_ID}.diff`));
	assert.ok(ids.includes(`aw-checkpoint-${JOB_ID}.merge-${HEAD_A.slice(0, 12)}`));
	assert.deepEqual(parseCheckpointAwaitingId(`aw-checkpoint-${JOB_ID}.merge-${HEAD_A.slice(0, 12)}`), {
		job_id: JOB_ID,
		kind: "merge",
		scope: HEAD_A.slice(0, 12),
	});
	// Every one of them is still recognisably derived, so cp_awaiting keeps refusing it.
	for (const id of ids) assert.ok(isDerivedAwaitingId(id), `${id} is not recognisable as a derived row`);
});
const QUOTE = "yes, one final fix for cp-int1";
const NO_FLAG = { destructive_scope: false, scope_growth: false, blocking_unknowns: false };

/** The fix report: intake's own record shape, as the worker would have filed it. */
function writeShipEnvelope(home: string, head: string): void {
	const envelope = { job_id: JOB_ID, kind: "ship", status: "done", summary: "fixed", branch: JOB_ID, head_sha: head, pr_url: PR_URL } as Envelope;
	const stored: EnvelopeRecord = { schema_version: SCHEMA_VERSION, job_id: JOB_ID, received_at: isoTimestamp(), attempt: 1, envelope };
	writeFileSync(join(home, paths.envelopeFile(JOB_ID)), JSON.stringify(stored));
}

/** Five reviews on HEAD_A; the fifth is a complete capped revise, so its one final-fix question is pending. */
function capAt(home: string, extra: { truncated?: boolean } = {}): Checkpoint | undefined {
	for (let attempt = 1; attempt < REVIEW_MAX_ATTEMPTS; attempt += 1) writeReviewPass(home, HEAD_A, { attempt, verdict: "revise" });
	const capped: DiffVerdict = {
		schema_version: SCHEMA_VERSION, job_id: JOB_ID, attempt: REVIEW_MAX_ATTEMPTS, verdict: "escalate", cause: "policy", flags: NO_FLAG,
		reasons: ["[severity: high] [confidence: high] the retry path is untested", `review cap: this is review ${REVIEW_MAX_ATTEMPTS} of ${REVIEW_MAX_ATTEMPTS}`],
		decided_at: isoTimestamp(), head_sha: HEAD_A, diff_stat: { files: 1, truncated: extra.truncated ?? false },
		...(extra.truncated ? {} : { model: "mock/reviewer" }),
	};
	writeFileSync(join(home, paths.reviewFile(JOB_ID, REVIEW_MAX_ATTEMPTS)), JSON.stringify(capped));
	writeShipEnvelope(home, HEAD_A);
	const review = { job_id: JOB_ID, verdict: "revise" as const, flags: NO_FLAG, reasons: ["the retry path is untested"], revisions: ["add a test for the retry path"] };
	return requestFinalFix(home, { verdict: capped, review, prUrl: PR_URL });
}

function answerFinalFix(home: string, approved: boolean, by = "operator-quote"): void {
	new CheckpointStore(home, { kind: "final_fix" }).decide(JOB_ID, approved, { by, basis: { operator_quote: QUOTE }, scope: HEAD_A.slice(0, 12) });
}

/** The live implementer: cp_send reopens the envelope slot, exactly as `Sender` does. */
function reopeningSender(b: Bench): (jobId: string, message: string) => Promise<{ receipt: string }> {
	return async (jobId, message) => (b.sent.push({ jobId, message }), await reopen(b), { receipt: "delivered" });
}
const reopen = (b: Bench) => reopenEnvelopeSlot({ home: b.home, fleet: b.fleet, runs: b.runs, jobId: JOB_ID, reason: "test promote" });

async function reportFix(b: Bench, head: string): Promise<void> {
	writeShipEnvelope(b.home, head);
	await b.fleet.patch(JOB_ID, { reported_at: isoTimestamp(), phase: "held" });
}

const onHead = (head: string, conclusion = "success"): Partial<World> => ({ pr: { ...openPr(), headRefOid: head }, runs: [{ status: "completed", conclusion, headSha: head }] });
const merges = (b: Bench) => b.calls.filter((line) => line.startsWith("gh pr merge"));

test("jje.3: approval is bound to its PR and its capped head, and needs an operator quote on every surface", async (t) => {
	for (const how of ["other-pr", "moved-head"] as const) {
		const b = await benchOf(t, {}, { reviewHead: false });
		capAt(b.home);
		// /cp-authorize and the Awaiting dialog carry no quote, so they cannot approve it.
		assert.throws(() => new CheckpointStore(b.home, { kind: "final_fix" }).decide(JOB_ID, true, { by: "operator command", scope: HEAD_A.slice(0, 12) }), /only with an operator quote/);
		answerFinalFix(b.home, true);
		const world = how === "other-pr" ? { pr: { ...openPr(), url: "https://github.com/o/r/pull/62" } } : onHead(HEAD_B);
		const result = await b.integrator(world, { send: reopeningSender(b) }).advance({ jobId: JOB_ID });
		assert.match(result.reason, how === "other-pr" ? /another PR never inherits it/ : /head moved to bbbbbbbbbbbb before promotion/);
		assert.deepEqual([result.next, b.sent.length, merges(b).length, readFinalFixRecord(b.home, JOB_ID)], ["surface", 0, 0, undefined], how);
	}
});

// ---------------------------------------------------------------------------
// merge_policy human_handoff (src/human-handoff.ts)
// ---------------------------------------------------------------------------

const HANDOFF = { policy: "human_handoff" } as const;
const handoffRows = (b: Bench) => b.awaiting().list().filter((item) => item.subject?.startsWith("human-review pr "));
const mutations = (b: Bench) => b.calls.filter((line) => line.startsWith("gh pr merge") || line.startsWith("gh pr update-branch"));

test("human_handoff: no pass is a review hold, a draft is readied first, and repo policy is argv-identical", async (t) => {
	const unreviewed = await benchOf(t, {}, { reviewHead: false });
	const review = await unreviewed.integrator({}, HANDOFF).advance({ jobId: JOB_ID });
	assert.equal(review.next, "review");
	assert.equal(unreviewed.awaiting().list().length, 0);

	const draft = await benchOf(t);
	const ready = await draft.integrator({ pr: draftPr() }, HANDOFF).advance({ jobId: JOB_ID });
	assert.deepEqual([ready.next, count(draft, "gh pr ready"), handoffRows(draft).length], ["advance", 1, 0]);
	const handed = await draft.integrator({}, HANDOFF).advance({ jobId: JOB_ID });
	assert.deepEqual([handed.next, handoffRows(draft).length, mutations(draft).length], ["surface", 1, 0]);

	const plain = await benchOf(t);
	await plain.integrator().advance({ jobId: JOB_ID });
	const repo = await benchOf(t);
	await repo.integrator({}, { policy: "repo" }).advance({ jobId: JOB_ID });
	assert.deepEqual(repo.calls, plain.calls, "repo policy changes no argv");
	assert.ok(repo.calls.some((line) => line.startsWith("gh pr merge")));
});