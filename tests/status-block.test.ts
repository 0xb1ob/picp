/**
 * cp-8aj acceptance: the status block is assembled by the extension, not
 * hand-typed by the model. This pins the merge (disk snapshot + caller
 * judgment) and the rendering rules the issue's screenshot-derived comment
 * demanded: one line per empty section, a shared width, a bounded label, and
 * a fallback to the br title when the caller supplies none.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AwaitingStore } from "../src/awaiting.ts";
import { REPO_ROOT } from "./harness/index.ts";
import {
	assembleStatusBlock,
	MAX_CELL_CHARS,
	MAX_LABEL_CHARS,
	type StatusBlockInput,
} from "../src/status-block.ts";
import {
	DEFAULT_ORIGIN,
	EMPTY_USAGE,
	type FleetRecord,
	type RunStatus,
	type StatusSnapshot,
	type Usage,
	type WorkerHandle,
} from "../src/contracts.ts";
import { assembleStatus, type StatusFacts } from "../src/status.ts";
import { jobState } from "../src/status-render.ts";
import { initialStatus } from "../src/run-artifacts.ts";

const NOW = "2026-08-30T12:00:00Z";
const HOME = "/home/operator/pi-command-post";

function usage(overrides: Partial<Usage> = {}): Usage {
	return { ...EMPTY_USAGE, ...overrides };
}

function record(
	overrides: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> },
): FleetRecord {
	const { worker, ...rest } = overrides;
	return {
		project: "demo",
		kind: "ship",
		delivery: "pr",
		origin: DEFAULT_ORIGIN,
		phase: "waiting",
		worktree: `/home/operator/.treehouse/demo/${overrides.job_id}`,
		branch: overrides.job_id,
		dispatched_at: "2026-08-30T11:56:00Z",
		usage: usage(),
		...rest,
		worker: {
			pid: 4242,
			session_id: `sess-${overrides.job_id}`,
			session_file: `/sessions/${overrides.job_id}.jsonl`,
			profile: "implementer",
			role: "implementer",
			model: "anthropic/claude-sonnet-5",
			started_at: "2026-08-30T11:56:00Z",
			...worker,
		},
	} as FleetRecord;
}

function run(jobId: string, overrides: Partial<RunStatus> = {}): RunStatus {
	return { ...initialStatus(jobId, {}, "2026-08-30T11:56:00Z"), ...overrides } as RunStatus;
}

function snapshot(overrides: Partial<StatusFacts> = {}): StatusSnapshot {
	return assembleStatus({
		home: HOME,
		generated_at: NOW,
		include: "all",
		records: [],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
		...overrides,
	});
}

test("an empty everything renders four one-line sections, not four tables", () => {
	const result = assembleStatusBlock(snapshot());
	assert.equal(
		result.text,
		["In progress: none", "", "Blocked: none", "", "Awaiting you: none", "", "Shipped: none"].join("\n"),
	);
	assert.deepEqual(result.shippedIds, []);
});

test("a missing parent-supplied label falls back to the ledger title, then the bare id", () => {
	const snap = snapshot({
		records: [record({ job_id: "cp-abc" })],
		issues: [
			{
				id: "cp-abc",
				title: "Add the retry ladder",
				status: "in_progress",
				labels: [],
				blocked_by: [],
				comments: [],
				created_at: NOW,
				updated_at: NOW,
			},
		],
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /cp-abc — Add the retry ladder/);

	// No title at all (no ledger join): the bare id is the label.
	const noTitle = snapshot({ records: [record({ job_id: "cp-notitle" })] });
	const untitled = assembleStatusBlock(noTitle);
	assert.match(untitled.text, /cp-notitle — cp-notitle/);
});

test("a caller-supplied label wins over the ledger title", () => {
	const snap = snapshot({
		records: [record({ job_id: "cp-abc" })],
		issues: [
			{
				id: "cp-abc",
				title: "Add the retry ladder",
				status: "in_progress",
				labels: [],
				blocked_by: [],
				comments: [],
				created_at: NOW,
				updated_at: NOW,
			},
		],
	});
	const input: StatusBlockInput = { labels: [{ job_id: "cp-abc", label: "dispatch tool" }] };
	const result = assembleStatusBlock(snap, input);
	assert.match(result.text, /cp-abc — dispatch tool/);
	assert.ok(!result.text.includes("Add the retry ladder"));
});

test("a long label is bounded, not left to blow up the layout", () => {
	const longLabel = "x".repeat(MAX_LABEL_CHARS + 40);
	const snap = snapshot({ records: [record({ job_id: "cp-long" })] });
	const result = assembleStatusBlock(snap, { labels: [{ job_id: "cp-long", label: longLabel }] });
	const line = result.text.split("\n").find((entry) => entry.includes("cp-long —"));
	assert.ok(line);
	// The label cell itself never exceeds the bound (plus the ellipsis marker).
	assert.ok(!line!.includes(longLabel), "an unbounded label leaked through");
	assert.ok(line!.length <= MAX_LABEL_CHARS + 60, `line unexpectedly long: ${line!.length}`);
});

test("a long awaiting-you cell is bounded the same way", () => {
	const longWhy = "y".repeat(MAX_CELL_CHARS + 40);
	const result = assembleStatusBlock(snapshot(), {
		awaiting: [{ type: "approval", decision: "ship it?", why: longWhy, blocks: "the release" }],
	});
	assert.ok(!result.text.includes(longWhy), "an unbounded why-cell leaked through");
	assert.match(result.text, /\[approval\] ship it\? — why: y+… — blocks: the release/);
});

test("cp-nz95: a refused row prints under an empty table, with its reason, and is never counted open", () => {
	const result = assembleStatusBlock(snapshot(), {
		refused: [
			{
				type: "authorization",
				decision: "Ship the sweep?",
				job_id: "cp-x",
				reason: "authorization items are derived from state/checkpoints/*.json, never declared — use /cp-authorize instead.",
			},
		],
	});
	assert.match(result.text, /Awaiting you: none/);
	assert.ok(!result.text.includes("answer with cp_decide"), "a refused row is not answerable");
	assert.match(result.text, /Not asked — refused by the awaiting store \(1\); not stored, so cp_decide cannot offer them:/);
	assert.match(result.text, /cp-x — \[authorization\] Ship the sweep\?/);
	assert.match(result.text, /refused: authorization items are derived/);
});

test("cp-nz95: a refused row never inflates the open count beside real rows", () => {
	const result = assembleStatusBlock(snapshot(), {
		awaiting: [{ type: "design", decision: "Postgres or sqlite?", why: "schema", blocks: "cp-db" }],
		refused: [{ type: "approval", decision: "Approve the sweep?", reason: "that reads like an authorization request" }],
	});
	assert.match(result.text, /answer with cp_decide \(1 open\)/);
	assert.match(result.text, /Not asked — refused by the awaiting store \(1\)/);
});

test("blocked rows never claim to be a human decision — that is Awaiting you's job", () => {
	const result = assembleStatusBlock(snapshot(), {
		blocked: [{ job_id: "cp-dep", waiting_on: "cp-base to merge first" }],
	});
	assert.match(result.text, /cp-dep — cp-dep {2}\(waiting on: cp-base to merge first\)/);
	assert.match(result.text, /Awaiting you: none/);
});

test("in progress leans on the same facts /status and /watch already read: age, tokens, cost, run(phase)", () => {
	const snap = snapshot({
		records: [
			record({
				job_id: "cp-live",
				dispatched_at: "2026-08-30T11:56:00Z",
				usage: usage({ total_tokens: 12_300, cost_usd: 0.42 }),
				routing: { scope: "M", risk: "high", thinking: "high", inferred: true },
			}),
		],
		runs: new Map([
			["cp-live", run("cp-live", { phase: "working", usage: usage({ total_tokens: 12_300, cost_usd: 0.42 }) })],
		]),
		alive: new Map([["cp-live", true]]),
	});
	// A wider width than the default: this test asserts every fact renders in
	// full, not how a narrow terminal degrades (that is its own test below).
	const result = assembleStatusBlock(snap, {}, { width: 160 });
	// scope/risk (cp-status-scope-risk) sit right after the model, `?`-marked
	// here because this job's routing was inferred, not caller-supplied.
	assert.match(
		result.text,
		/cp-live — cp-live {2}\(demo · claude-sonnet-5 · M\?\/high\? · high · working \(waiting\) · 4m · 12.3k \$0.42\)/,
	);
});

test("the block and the widget name a job's state with the same word (cp-8tu)", () => {
	// Share the vocabulary, not the layout: `jobState` is the one place that
	// decides what a job's state IS, so the two surfaces can disagree about
	// columns and never about facts. A failed job is the case where the old
	// `runLabel(job) (phase)` cell read `exited (failed)` in the block while the
	// widget called it failed.
	const snap = snapshot({
		records: [
			record({
				job_id: "cp-dead",
				phase: "failed",
				dispatched_at: "2026-08-30T11:56:00Z",
				failure: { class: "crash", message: "pid no longer exists", at: "2026-08-30T11:58:00Z" },
				worker: { exited_at: "2026-08-30T11:58:00Z", exit_code: 1 },
			}),
		],
		runs: new Map([["cp-dead", run("cp-dead", { phase: "exited", exited_at: "2026-08-30T11:58:00Z", exit_code: 1 })]]),
	});
	const job = snap.jobs.find((entry) => entry.job_id === "cp-dead");
	assert.ok(job);
	assert.equal(jobState(job).word, "failed");
	const result = assembleStatusBlock(snap, {}, { width: 160 });
	// The word appears once, not twice: the policy phase is only repeated when it
	// adds a second fact.
	assert.match(result.text, /cp-dead {2}\(demo · claude-sonnet-5 · — · — · failed · /);
	assert.ok(!result.text.includes("failed (failed)"));

	// A live job still carries both facts: liveness first, policy in parentheses.
	const live = snapshot({
		records: [record({ job_id: "cp-live2", dispatched_at: "2026-08-30T11:56:00Z" })],
		runs: new Map([["cp-live2", run("cp-live2", { phase: "working" })]]),
		alive: new Map([["cp-live2", true]]),
	});
	assert.match(assembleStatusBlock(live, {}, { width: 160 }).text, /working \(waiting\)/);
});

test("in progress renders an unknown scope\/risk as \u2014, never a guessed default, for a job with no routing decision on record", () => {
	const snap = snapshot({
		records: [record({ job_id: "cp-legacy", dispatched_at: "2026-08-30T11:56:00Z" })],
		runs: new Map([["cp-legacy", run("cp-legacy", { phase: "working" })]]),
		alive: new Map([["cp-legacy", true]]),
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /cp-legacy — cp-legacy {2}\(demo · claude-sonnet-5 · \u2014 · \u2014 · working \(waiting\)/);
});

test("in progress renders an explicit scope\/risk with no `?` marker", () => {
	const snap = snapshot({
		records: [
			record({
				job_id: "cp-explicit",
				dispatched_at: "2026-08-30T11:56:00Z",
				routing: { scope: "S", risk: "low", thinking: "minimal", inferred: false },
			}),
		],
		runs: new Map([["cp-explicit", run("cp-explicit", { phase: "working" })]]),
		alive: new Map([["cp-explicit", true]]),
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /cp-explicit — cp-explicit {2}\(demo · claude-sonnet-5 · S\/low · minimal · working \(waiting\)/);
});

test("a done job with a PR receipt is Shipped, full url, never a bare number or slug", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-shipped",
				phase: "done",
				closed_at: NOW,
				reported_at: NOW,
				worker: { exited_at: NOW, exit_code: 0 },
				receipts: [{ kind: "pr", status: "open", title: "PR for cp-shipped", url: "https://github.com/acme/repo/pull/42" }],
			}),
		],
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /Shipped:\n {2}- cp-shipped — cp-shipped: https:\/\/github\.com\/acme\/repo\/pull\/42/);
	assert.deepEqual(result.shippedIds, ["cp-shipped"]);
	// A done job never re-appears under "In progress".
	assert.ok(!result.text.split("Shipped:")[0]!.includes("cp-shipped"));
});

test("pi-command-post-1jz: a done research job with a board receipt is Shipped too, not only a PR", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-board-shipped",
				kind: "research",
				delivery: "board",
				phase: "done",
				closed_at: NOW,
				reported_at: NOW,
				worker: { exited_at: NOW, exit_code: 0 },
				receipts: [{ kind: "board", status: "published", title: "board for cp-board-shipped", url: "http://100.64.0.1:8766/boards/cp-board-shipped/" }],
			}),
		],
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /Shipped:\n {2}- cp-board-shipped — cp-board-shipped: http:\/\/100\.64\.0\.1:8766\/boards\/cp-board-shipped\//);
	assert.deepEqual(result.shippedIds, ["cp-board-shipped"]);
});

test("a forced teardown with an unmerged (open) PR receipt is excluded from Shipped, and surfaced as unverified", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-forced",
				phase: "done",
				closed_at: NOW,
				closed_reason: "forced",
				worker: { exited_at: NOW, exit_code: null },
				receipts: [{ kind: "pr", status: "open", title: "PR for cp-forced", url: "https://github.com/acme/repo/pull/7" }],
			}),
		],
	});
	const result = assembleStatusBlock(snap);
	assert.ok(!/^Shipped:\n {2}- cp-forced/m.test(result.text), "a forced+open receipt must never read as Shipped");
	assert.match(result.text, /Shipped \(unverified, forced teardown\):\n {2}- cp-forced.*pull\/7.*forced teardown, PR not confirmed merged/s);
});

test("a normal (gated) done job with a PR receipt still renders as Shipped — forced exclusion is narrow", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-gated-ship",
				phase: "done",
				closed_at: NOW,
				closed_reason: "gated",
				worker: { exited_at: NOW, exit_code: 0 },
				receipts: [{ kind: "pr", status: "open", title: "PR for cp-gated-ship", url: "https://github.com/acme/repo/pull/8" }],
			}),
		],
	});
	const result = assembleStatusBlock(snap);
	assert.match(result.text, /Shipped:\n {2}- cp-gated-ship — cp-gated-ship: https:\/\/github\.com\/acme\/repo\/pull\/8/);
});

test("shipped churn: a job already shown collapses to a one-line count instead of repeating the row", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-shipped",
				phase: "done",
				closed_at: NOW,
				worker: { exited_at: NOW, exit_code: 0 },
				receipts: [{ kind: "pr", status: "open", title: "p", url: "https://example.com/pr/1" }],
			}),
		],
	});
	const first = assembleStatusBlock(snap);
	assert.deepEqual(first.shippedIds, ["cp-shipped"]);
	const second = assembleStatusBlock(snap, {}, { shownShipped: new Set(first.shippedIds) });
	assert.match(second.text, /Shipped: none new \(1 already reported\)/);
});

test("a narrow terminal degrades the row width but never drops the PR url", () => {
	const snap = snapshot({
		include: "all",
		records: [
			record({
				job_id: "cp-narrow",
				phase: "done",
				closed_at: NOW,
				worker: { exited_at: NOW, exit_code: 0 },
				receipts: [{ kind: "pr", status: "open", title: "p", url: "https://example.com/owner/repo/pull/999999" }],
			}),
		],
	});
	const wide = assembleStatusBlock(snap, { labels: [{ job_id: "cp-narrow", label: "a reasonably descriptive label" }] });
	const narrow = assembleStatusBlock(
		snap,
		{ labels: [{ job_id: "cp-narrow", label: "a reasonably descriptive label" }] },
		{ width: 20 },
	);
	assert.match(wide.text, /https:\/\/example\.com\/owner\/repo\/pull\/999999/);
	assert.match(narrow.text, /https:\/\/example\.com\/owner\/repo\/pull\/999999/, "the url must survive a narrow terminal");
	const narrowLine = narrow.text.split("\n").find((line) => line.includes("cp-narrow"));
	assert.ok(narrowLine);
	// The label collapsed under the width cap even though the url did not.
	assert.ok(!narrowLine!.includes("a reasonably descriptive label"));
});

test("in progress collapses to one line when the fleet is empty, even with other sections populated", () => {
	const result = assembleStatusBlock(snapshot(), {
		awaiting: [{ type: "design", decision: "postgres or sqlite?", why: "schema choice", blocks: "cp-db" }],
	});
	assert.match(result.text, /^In progress: none$/m);
});

test("cp-routing-provenance: the block's In progress line reads the same cell the widget does", () => {
	// The status block is the fourth reader of `FleetRecord.routing`. It renders
	// through `formatScopeRisk` too, so a defaulted axis must reach the operator
	// as `-` here as well — never as an `S/low` somebody appears to have chosen.
	const defaulted = assembleStatusBlock(
		snapshot({
			records: [
				record({
					job_id: "cp-defaulted",
					routing: { scope: "S", risk: "low", thinking: "medium", inferred: false, provenance: { scope: "defaulted", risk: "defaulted" } },
				}),
			],
		}),
	);
	assert.match(defaulted.text, /cp-defaulted .*· -\/- · medium ·/);

	// And a mixed decision keeps the `?` on the inferred axis only.
	const mixed = assembleStatusBlock(
		snapshot({
			records: [
				record({
					job_id: "cp-mixed",
					routing: { scope: "M", risk: "high", thinking: "high", inferred: true, provenance: { scope: "explicit", risk: "inferred" } },
				}),
			],
		}),
	);
	assert.match(mixed.text, /cp-mixed .*· M\/high\? · high ·/);
});

// Opt-in regression: nothing in src/ depends on a block being rendered per
// turn. This is a static boundary check, not prose — a future module that
// wires a gate through the renderer (or that calls the tool by name) fails
// here, which is what would silently reintroduce a per-turn dependency.
test("no core src/ module depends on the status block being rendered", () => {
	const files = readdirSync(join(REPO_ROOT, "src")).filter((name) => name.endsWith(".ts"));
	const renderers = new Set(["status-block.ts", "awaiting-rows.ts", "shipped-seen.ts"]);
	for (const name of files) {
		const source = readFileSync(join(REPO_ROOT, "src", name), "utf8");
		if (!renderers.has(name)) {
			assert.doesNotMatch(source, /from "\.\/status-block\.ts"/, `${name} imports the renderer; a gate must not depend on rendering`);
		}
		// The tool name may be described in a comment; a runtime reference to it
		// would mean src/ expects the parent to have called it.
		for (const [index, line] of source.split("\n").entries()) {
			if (!line.includes("cp_status_block")) continue;
			const trimmed = line.trim();
			assert.ok(
				trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*"),
				`src/${name}:${index + 1} references cp_status_block outside a comment`,
			);
		}
	}
	// And the gates themselves are callable with no block in sight: reviewDeferred
	// is exported from the store, not reached through the renderer.
	assert.equal(typeof AwaitingStore.prototype.reviewDeferred, "function");
});

test("cp-project-grouped-reporting: a block spanning projects has one [project] section per project in every table", () => {
	const shipped = (job_id: string, project: string) =>
		record({
			job_id,
			project,
			phase: "done",
			closed_at: NOW,
			reported_at: NOW,
			worker: { exited_at: NOW, exit_code: 0 },
			receipts: [{ kind: "pr", status: "open", title: "p", url: `https://github.com/acme/${project}/pull/1` }],
		});
	const snap = snapshot({
		records: [
			record({ job_id: "cp-a1", project: "demo-app" }),
			record({ job_id: "cp-b1", project: "atlas" }),
			record({ job_id: "cp-a2", project: "demo-app" }),
			shipped("cp-a3", "demo-app"),
			shipped("cp-b2", "atlas"),
		],
	});
	const { text } = assembleStatusBlock(snap, {
		blocked: [
			{ job_id: "cp-b1", waiting_on: "CI" },
			{ job_id: "cp-a1", waiting_on: "a dependency" },
		],
		awaiting: [
			{ type: "approval", decision: "merge b1", why: "green", blocks: "b1", job_id: "cp-b1" },
			{ type: "approval", decision: "merge a2", why: "green", blocks: "a2", job_id: "cp-a2" },
		],
	});
	const section = (heading: string) => text.split(`${heading}:\n`)[1]!.split("\n\n")[0]!.split("\n");
	const inProgress = section("In progress");
	assert.equal(inProgress[0], "  [demo-app]");
	assert.match(inProgress[1]!, /^ {4}- cp-a1 /);
	assert.match(inProgress[2]!, /^ {4}- cp-a2 /);
	assert.equal(inProgress[3], "  [atlas]");
	assert.match(inProgress[4]!, /^ {4}- cp-b1 /);
	assert.deepEqual(
		section("Blocked").map((line) => line.trim().split(" ")[0]),
		["[atlas]", "-", "[demo-app]", "-"],
	);
	const awaiting = section("Awaiting you");
	assert.equal(awaiting[0], "  [atlas]");
	assert.equal(awaiting[2], "  [demo-app]");
	const shippedLines = section("Shipped");
	assert.equal(shippedLines[0], "  [demo-app]");
	assert.match(shippedLines[1]!, /cp-a3 .*https:\/\/github\.com\/acme\/demo-app\/pull\/1$/);
	assert.equal(shippedLines[2], "  [atlas]");
});

test("cp-project-grouped-reporting: a single-project block carries no section headers", () => {
	const { text } = assembleStatusBlock(snapshot({ records: [record({ job_id: "cp-a1" }), record({ job_id: "cp-a2" })] }));
	assert.equal(text.includes("[demo]"), false);
});
