/**
 * cp-u3o4: the answer card's pure half — the capped read, the collapsed and
 * expanded views, and the degrade line for an answer whose file has moved.
 *
 * Everything here runs without pi and without a terminal, which is the point
 * of `src/answer-card.ts` existing at all: the renderer in the extension is
 * then a few `Text` children over these values. It is NOT sufficient evidence
 * for the TUI behaviour itself (cur-20260901-5) — that has to be reproduced on
 * a real pi TUI, and docs/contracts.md §Q&A answers says how.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type AnswerCardData,
	answerCardView,
	formatAnswerDegrade,
	formatAnswerHeader,
	formatAnswerNotice,
	readAnswerSource,
} from "../src/answer-card.ts";
import { ANSWER_CARD_COLLAPSED_LINES, ANSWER_MAX_BYTES, LAYOUT } from "../src/contracts.ts";
import { createScratchHome } from "./harness/index.ts";

function scratchAnswer(
	t: { after(fn: () => void): void },
	body: string,
	overrides: Partial<AnswerCardData> = {},
): AnswerCardData {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const dir = join(home.path, LAYOUT.artifacts, "cp-q1");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "report.md");
	writeFileSync(path, body);
	return {
		job_id: "cp-q1",
		project: "demo",
		summary: "config lives in src/config.ts",
		path,
		bytes: Buffer.byteLength(body),
		...overrides,
	};
}

test("an answer is read capped, and the cap is the answer bound", (t) => {
	const oversized = "x".repeat(ANSWER_MAX_BYTES + 500);
	const data = scratchAnswer(t, oversized);
	const source = readAnswerSource(data.path);
	assert.equal(source.truncated, true);
	assert.equal(source.bytes, ANSWER_MAX_BYTES + 500, "bytes is the size on disk, not the size read");
	assert.equal(Buffer.byteLength(source.text), ANSWER_MAX_BYTES);

	const small = scratchAnswer(t, "Answer\n\nsrc/config.ts\n");
	const read = readAnswerSource(small.path);
	assert.equal(read.truncated, false);
	assert.equal(read.text, "Answer\n\nsrc/config.ts\n");
});

test("a collapsed card shows the head and says how much is hidden; expanded shows all", (t) => {
	const lines = Array.from({ length: ANSWER_CARD_COLLAPSED_LINES + 7 }, (_, index) => `line ${index + 1}`);
	const data = scratchAnswer(t, `${lines.join("\n")}\n`);

	const collapsed = answerCardView(data);
	assert.equal(collapsed.body.length, ANSWER_CARD_COLLAPSED_LINES);
	assert.equal(collapsed.body[0], "line 1");
	assert.equal(collapsed.hidden, 7);
	assert.equal(collapsed.degraded, undefined);
	// The headline travels on the card too — it is the envelope's, already
	// bounded to three lines, and it is never the body.
	assert.deepEqual(collapsed.summary, ["config lives in src/config.ts"]);
	assert.match(collapsed.header, /^ANSWER — cp-q1 · demo · /);

	const expanded = answerCardView(data, { expanded: true });
	assert.equal(expanded.body.length, lines.length);
	assert.equal(expanded.hidden, 0);
});

test("a short answer is never truncated and hides nothing", (t) => {
	const data = scratchAnswer(t, "Answer\n\nIt is read from src/config.ts at startup.\n");
	const view = answerCardView(data);
	assert.deepEqual(view.body, ["Answer", "", "It is read from src/config.ts at startup."]);
	assert.equal(view.hidden, 0);
	assert.equal(view.truncated, false);
});

test("an answer file that is gone degrades to a path and a byte count, and never throws", (t) => {
	const data = scratchAnswer(t, "Answer\n\nhere\n");
	rmSync(data.path);
	const view = answerCardView(data);
	assert.equal(view.body.length, 0);
	assert.equal(view.degraded, formatAnswerDegrade(data));
	assert.match(view.degraded as string, /file no longer readable/);
	assert.ok((view.degraded as string).includes(data.path));
	// The header still renders: the card stays in the transcript after teardown.
	assert.equal(view.header, formatAnswerHeader(data, data.bytes));
});

test("an unreadable answer degrades exactly like a missing one", (t) => {
	const data = scratchAnswer(t, "Answer\n");
	const view = answerCardView(data, {
		read: () => {
			throw new Error("EACCES");
		},
	});
	assert.equal(view.degraded, formatAnswerDegrade(data));
});

test("a file over the bound renders capped and says so", (t) => {
	const body = `${Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n")}\n`;
	assert.ok(Buffer.byteLength(body) > 2048);
	const data = scratchAnswer(t, body);
	const view = answerCardView(data, { expanded: true, maxBytes: 2048 });
	assert.equal(view.truncated, true);
	assert.ok(Buffer.byteLength(view.body.join("\n")) <= 2048);
});

test("the non-TUI notice is a pointer, never a body", (t) => {
	const data = scratchAnswer(t, "Answer\n\nthe secret sauce is in src/config.ts\n");
	const notice = formatAnswerNotice(data);
	assert.ok(notice.includes(data.path));
	assert.ok(notice.includes(data.job_id));
	assert.ok(!notice.includes("secret sauce"), "the answer body never travels in a notice");
});

test("a card with no project and no headline still renders a header", (t) => {
	const data = scratchAnswer(t, "Answer\n", { summary: "" });
	delete (data as { project?: string }).project;
	const view = answerCardView(data);
	assert.deepEqual(view.summary, []);
	assert.match(view.header, /^ANSWER — cp-q1 · /);
});
