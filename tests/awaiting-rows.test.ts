/**
 * cp-nz95 acceptance: the status block never renders an Awaiting-you row the
 * store refused or deferred, and never refuses one silently.
 *
 * The invariant, asserted against a real `AwaitingStore` rather than a stub:
 * for any set of supplied rows, every row rendered as **open** is present and
 * `open` in what `/cp-decide` and `cp_awaiting list` read. That is the one that
 * failed in production — the operator was told three decisions awaited them and
 * `/cp-decide` offered one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAwaitingRows } from "../src/awaiting-rows.ts";
import { AwaitingStore } from "../src/awaiting.ts";
import { assembleStatusBlock, MAX_CELL_CHARS, MAX_REASON_CHARS, type StatusBlockAwaitingInput } from "../src/status-block.ts";
import { assembleStatus, type StatusFacts } from "../src/status.ts";
import type { MergeAskProbe, MergeAskVerdict } from "../src/merge-ask.ts";
import type { StatusSnapshot } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

const NOW = "2026-08-30T12:00:00Z";

function snapshot(overrides: Partial<StatusFacts> = {}): StatusSnapshot {
	return assembleStatus({
		home: "/home/operator/pi-command-post",
		generated_at: NOW,
		include: "all",
		records: [],
		runs: new Map(),
		alive: new Map(),
		ledger: { ok: false, queried: false },
		...overrides,
	});
}

function probe(verdict: MergeAskVerdict): MergeAskProbe {
	return async () => verdict;
}

/** The Awaiting-you section, from the first line to the blank line after it. */
function awaitingSection(text: string): string[] {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.startsWith("Awaiting you"));
	const rest = lines.slice(start);
	const end = rest.indexOf("");
	return end === -1 ? rest : rest.slice(0, end);
}

/** Rows rendered as open questions — the bullets under the table itself. */
function openRows(text: string): string[] {
	const section = awaitingSection(text);
	const stop = section.findIndex((line) => line.startsWith("answer with cp_decide") || line.startsWith("Not asked"));
	return (stop === -1 ? section : section.slice(0, stop)).filter((line) => line.startsWith("  - "));
}

async function render(rows: StatusBlockAwaitingInput[], store: AwaitingStore): Promise<string> {
	const resolved = await resolveAwaitingRows(rows, store);
	return assembleStatusBlock(snapshot(), {
		awaiting: resolved.rendered,
		...(resolved.mergeAsks.length > 0 ? { mergeAsks: resolved.mergeAsks } : {}),
		...(resolved.refused.length > 0 ? { refused: resolved.refused } : {}),
	}).text;
}

test("a type:authorization row is refused, never rendered as open, and says why", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const resolved = await resolveAwaitingRows(
			[{ type: "authorization", decision: "Ship the destructive findings?", why: "w", blocks: "cp-x", job_id: "cp-x" }],
			store,
		);
		assert.deepEqual(resolved.rendered, []);
		assert.equal(resolved.refused.length, 1);
		assert.match(resolved.refused[0]!.reason, /never declared/);
		assert.match(resolved.refused[0]!.reason, /cp_decide/);
		// And nothing was written: the status block must not mint an authorization.
		assert.deepEqual(store.list(), []);

		const text = await render(
			[{ type: "authorization", decision: "Ship the destructive findings?", why: "w", blocks: "cp-x", job_id: "cp-x" }],
			store,
		);
		assert.equal(openRows(text).length, 0);
		assert.match(text, /Awaiting you: none/);
		assert.match(text, /Not asked \u2014 refused by the awaiting store \(1\)/);
	} finally {
		home.cleanup();
	}
});

test("authorization-shaped prose is stored with a lint, not refused", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const row: StatusBlockAwaitingInput = {
			type: "approval",
			decision: "Authorize the 5 destructive findings before the sweep?",
			why: "they delete data",
			blocks: "cp-y",
			job_id: "cp-y",
		};
		const resolved = await resolveAwaitingRows([row], store);
		assert.equal(resolved.rendered.length, 1);
		assert.equal(resolved.refused.length, 0);
		assert.match(resolved.rendered[0]!.lint ?? "", /Authorize/);
		assert.match(resolved.rendered[0]!.lint ?? "", /Ship cp-x, drop it, or open a follow-up\?/);
		assert.equal(store.list("open").length, 1);

		const text = await render([row], store);
		assert.equal(openRows(text).length, 1);
		assert.match(text, /lint: wording/);
	} finally {
		home.cleanup();
	}
});

test("the rendered lint keeps the quoted trigger AND the suggested rewording", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		for (const decision of [
			"Authorize the 5 destructive findings before the sweep?",
			"Should I go ahead with the destructive sweep across every registered project now?",
			"ok to deploy the sweep?",
			"go / no-go on the sweep?",
			"Please approve the sweep",
		]) {
			const resolved = await resolveAwaitingRows([{ type: "approval", decision, why: "w", blocks: "b", job_id: "cp-y" }], store);
			assert.equal(resolved.rendered.length, 1, decision);
			const lint = resolved.rendered[0]!.lint ?? "";
			assert.ok(lint.length <= MAX_REASON_CHARS, `lint is ${lint.length} chars, over the render bound: ${decision}`);
			assert.match(lint, /lint: wording/);
			assert.ok(lint.includes("Ship cp-x, drop it, or open a follow-up?"), `lint lost rewording: ${lint}`);
		}
	} finally {
		home.cleanup();
	}
});

test("a gate-deferred row renders in the deferred section only, never as open", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: probe({ action: "defer", ci: "in_progress", reason: "CI is in_progress on abc1234" }),
		});
		const row: StatusBlockAwaitingInput = {
			type: "approval",
			decision: "Merge PR #47?",
			why: "green",
			blocks: "cp-z",
			job_id: "cp-z",
		};
		const resolved = await resolveAwaitingRows([row], store);
		assert.deepEqual(resolved.rendered, []);
		assert.deepEqual(resolved.refused, []);
		assert.equal(resolved.mergeAsks.length, 1);
		assert.equal(resolved.mergeAsks[0]!.kind, "deferred");
		assert.equal(store.list("open").length, 0);
		assert.equal(store.list("deferred").length, 1);

		const text = await render([row], store);
		assert.equal(openRows(text).length, 0);
		assert.match(text, /Not asked yet \u2014 not ready to merge \(1/);
		assert.match(text, /CI is in_progress on abc1234/);
	} finally {
		home.cleanup();
	}
});

test("a red merge ask is refused as an ask and printed as CI red, not as an open row", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: probe({ action: "refuse", ci: "failed", reason: "CI failure on abc1234 — merging red is forbidden" }),
		});
		const text = await render([{ type: "approval", decision: "Merge PR #48?", why: "w", blocks: "b", job_id: "cp-r" }], store);
		assert.equal(openRows(text).length, 0);
		assert.match(text, /Not asked \u2014 CI red \(1\)/);
	} finally {
		home.cleanup();
	}
});

test("round trip: every row rendered as open is open in the store, for a mixed batch", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({
			home: home.path,
			mergeAsk: probe({ action: "defer", ci: "superseded", reason: "no CI run has started on abc1234 yet" }),
		});
		const rows: StatusBlockAwaitingInput[] = [
			{ type: "design", decision: "Postgres or sqlite?", why: "schema", blocks: "cp-db", job_id: "cp-db" },
			{ type: "authorization", decision: "Ship cp-x?", why: "w", blocks: "cp-x", job_id: "cp-x" },
			{ type: "approval", decision: "Approve the sweep?", why: "w", blocks: "cp-y", job_id: "cp-y" },
			{ type: "approval", decision: "Merge PR #47 and drop cp-to39?", why: "w", blocks: "cp-z", job_id: "cp-z" },
			{ type: "approval", decision: "Ship cp-q, drop it, or open a follow-up?", why: "research done", blocks: "cp-q", job_id: "cp-q" },
		];
		const resolved = await resolveAwaitingRows(rows, store);
		const text = assembleStatusBlock(snapshot(), {
			awaiting: resolved.rendered,
			...(resolved.mergeAsks.length > 0 ? { mergeAsks: resolved.mergeAsks } : {}),
			...(resolved.refused.length > 0 ? { refused: resolved.refused } : {}),
		}).text;

		// The invariant: rendered-open ⊆ store-open, and the counts agree.
		const open = new Set(store.list("open").map((item) => item.id));
		assert.equal(resolved.rendered.length, 3);
		for (const row of resolved.rendered) {
			assert.ok(row.id, "a rendered row carries the id the operator answers");
			assert.ok(open.has(row.id!), `${row.decision} was rendered open but is not open in the store`);
		}
		assert.equal(openRows(text).length, resolved.rendered.length);
		assert.match(text, /answer with cp_decide \(3 open\)/);

		assert.equal(resolved.refused.length, 1, "the authorization row is still refused");
		assert.equal(resolved.mergeAsks.length, 1, "the deferred merge ask");
		assert.match(text, /Not asked yet \u2014 not ready to merge/);
		assert.match(text, /Not asked \u2014 refused by the awaiting store/);
	} finally {
		home.cleanup();
	}
});

test("a store that cannot write is a refusal, not an unanswerable open row", async () => {
	const failing = {
		declareGated: async () => {
			throw new Error("EACCES: state/awaiting.json is not writable");
		},
	};
	const resolved = await resolveAwaitingRows(
		[{ type: "design", decision: "A or B?", why: "w", blocks: "b" }],
		failing as never,
	);
	assert.deepEqual(resolved.rendered, []);
	assert.equal(resolved.refused.length, 1);
	assert.match(resolved.refused[0]!.reason, /EACCES/);
});

test("re-rendering an already answered decision is a notice, never a second ask", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		const row: StatusBlockAwaitingInput = { type: "design", decision: "A or B?", why: "w", blocks: "b" };
		const first = await resolveAwaitingRows([row], store);
		assert.equal(first.rendered.length, 1);
		await store.answer(first.rendered[0]!.id!, { answer: "A", by: "operator dialog (tui)" });

		const again = await resolveAwaitingRows([row], store);
		assert.deepEqual(again.rendered, []);
		assert.equal(again.refused.length, 1);
		assert.match(again.refused[0]!.reason, /already answered/);
	} finally {
		home.cleanup();
	}
});

test("a max-length decision cannot crowd the settled notice's actionable clause out of the render", async () => {
	const home = createScratchHome();
	try {
		const store = new AwaitingStore({ home: home.path });
		// The tool schema and the awaiting schema both cap `decision` at 100 chars,
		// so this is the longest decision that can ever reach the notice by the
		// supported path; the over-length case is covered below, against a stub.
		{
			const decision = `Postgres or sqlite for ${"x".repeat(MAX_CELL_CHARS - 24)}?`;
			assert.equal(decision.length, MAX_CELL_CHARS);
			const row: StatusBlockAwaitingInput = { type: "design", decision, why: "w", blocks: "b" };
			const first = await resolveAwaitingRows([row], store);
			assert.equal(first.rendered.length, 1);
			await store.answer(first.rendered[0]!.id!, { answer: "postgres", by: "operator dialog (tui)" });

			const again = await resolveAwaitingRows([row], store);
			assert.equal(again.refused.length, 1);
			const reason = again.refused[0]!.reason;
			assert.ok(reason.length <= MAX_REASON_CHARS, `settled notice is ${reason.length} chars, over the render bound`);

			const text = assembleStatusBlock(snapshot(), { refused: again.refused }).text;
			const line = text.split("\n").find((entry) => entry.trim().startsWith("refused:"));
			assert.ok(line, "no rendered refusal line");
			assert.ok(line!.includes("already answered in state/awaiting.json"), line);
			assert.ok(line!.includes("Ask a new question if it needs deciding again"), `the actionable clause was cut: ${line}`);
			assert.ok(!line!.includes("x".repeat(MAX_CELL_CHARS + 1)), "an unbounded decision leaked into the notice");
		}

		// And past the cap: `resolveAwaitingRows` is exported behaviour, not a
		// tool-only path, so an unbounded decision must still not eat the fix.
		const huge = `Postgres or sqlite for ${"x".repeat(MAX_CELL_CHARS * 6)}?`;
		const stub = {
			declareGated: async () => ({
				item: { id: "aw-stub", state: "withdrawn", decision: huge } as never,
				raised: false,
			}),
		};
		const resolved = await resolveAwaitingRows([{ type: "design", decision: huge, why: "w", blocks: "b" }], stub as never);
		assert.equal(resolved.refused.length, 1);
		assert.ok(resolved.refused[0]!.reason.length <= MAX_REASON_CHARS, "an unbounded decision blew the render bound");
		const hugeText = assembleStatusBlock(snapshot(), { refused: resolved.refused }).text;
		const hugeLine = hugeText.split("\n").find((entry) => entry.trim().startsWith("refused:"));
		assert.ok(hugeLine?.includes("already withdrawn in state/awaiting.json"), hugeLine);
		assert.ok(hugeLine?.includes("Ask a new question if it needs deciding again"), `the actionable clause was cut: ${hugeLine}`);
	} finally {
		home.cleanup();
	}
});
