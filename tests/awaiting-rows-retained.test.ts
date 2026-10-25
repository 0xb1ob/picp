/**
 * cp-nz95 units retained by P10c: the over-cap decision half reaches resolveAwaitingRows only through a direct call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAwaitingRows } from "../src/awaiting-rows.ts";
import { AwaitingStore } from "../src/awaiting.ts";
import { assembleStatusBlock, MAX_CELL_CHARS, MAX_REASON_CHARS, type StatusBlockAwaitingInput } from "../src/status-block.ts";
import { assembleStatus, type StatusFacts } from "../src/status.ts";
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
