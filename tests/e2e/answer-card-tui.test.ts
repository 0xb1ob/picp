/**
 * P11c behavior 10: the `cp-answer` card in a real pi TUI on a pty (tests/harness/tui.ts). Cards queued in the home's
 * outbox are drained by the command-post extension at session start and drawn by its entry renderer; ctrl+o expands.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AnswerCardOutbox } from "../../src/answer-delivery.ts";
import { ANSWER_CARD_COLLAPSED_LINES, ANSWER_MAX_BYTES, paths } from "../../src/contracts.ts";
import { COMMAND_POST_EXTENSION, createAgentDir, createScratchHome, MockProvider, waitFor } from "../harness/index.ts";
import { startTui } from "../harness/tui.ts";

const has = (...needles: string[]) => (drawn: string) => needles.every((needle) => drawn.includes(needle));
const between = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

// P11c-answer-tui: six queued answers render as cards. Pins the collapsed head and its hidden count, a short answer
// shown whole, the ANSWER_MAX_BYTES read cap (the tail past it never drawn), a gone or unreadable file degrading to
// path and size, a header with no project or headline, and ctrl+o expanding every card.
test("P11c-answer-tui: answer cards render collapsed, capped, degraded and expanded in a real TUI", { timeout: 180_000 }, async (t) => {
	const home = createScratchHome();
	const provider = await MockProvider.start();
	const model = provider.addScript("p11c-answer-tui", [{ kind: "text", text: "Ready." }], { onExhausted: "repeat" });
	const agent = createAgentDir({ provider });
	t.after(async () => { agent.cleanup(); await provider.stop(); home.cleanup(); });
	const outbox = new AnswerCardOutbox({ home: home.path });
	const queue = (jobId: string, body: string | undefined, extra: { project?: string; summary?: string } = {}) => {
		const path = join(home.path, paths.artifactFile(jobId));
		mkdirSync(join(home.path, paths.artifactDir(jobId)), { recursive: true });
		if (body !== undefined) writeFileSync(path, body);
		const bytes = body === undefined ? 0 : statSync(path).size;
		const project = "project" in extra ? extra.project : "demo";
		outbox.enqueue({ job_id: jobId, ...(project ? { project } : {}), generation: 1, summary: extra.summary ?? `headline of ${jobId}`, path, bytes, reported_at: "2026-10-01T00:00:00Z" });
		return path;
	};
	queue("cp-q1", "Answer\n\nIt is read from src/config.ts at startup.\n");
	const rows = Array.from({ length: ANSWER_CARD_COLLAPSED_LINES + 7 }, (_, i) => `row ${i + 1}`);
	queue("cp-q2", `${rows.join("\n")}\n`);
	const bigLines = Array.from({ length: Math.ceil(ANSWER_MAX_BYTES / 100) + 10 }, (_, i) => `big ${String(i).padStart(3, "0")} ${"x".repeat(91)}`);
	const big = `${bigLines.join("\n")}\nTAIL-PAST-CAP\n`;
	const bigPath = queue("cp-q3", big);
	const gonePath = queue("cp-q4", "Answer\n\nhere\n");
	rmSync(gonePath);
	const dirPath = join(home.path, paths.artifactFile("cp-q5"));
	queue("cp-q5", undefined);
	mkdirSync(dirPath, { recursive: true });
	queue("cp-q6", "Answer\n", { project: undefined, summary: "" });

	const env = { ...agent.env, CP_HOME: home.path, CP_MODE: "multi" };
	const args = ["--no-session", "--no-extensions", "--no-context-files", "-e", COMMAND_POST_EXTENSION, "--model", model];
	// Tall enough that every card, expanded, is still inside the first frame pi-tui draws.
	const tui = startTui(t, home.path, env, args, { columns: 200, lines: 160 });
	const drawn = await waitFor(tui.screen, has("───", "ANSWER — cp-q6"), { timeoutMs: 60_000, what: "six answer cards" });
	const q1 = between(drawn, "ANSWER — cp-q1", "ANSWER — cp-q2");
	assert.ok(q1.includes(`ANSWER — cp-q1 · demo · ${statSync(join(home.path, paths.artifactFile("cp-q1"))).size} B`), q1);
	assert.ok(has("headline of cp-q1", "Answer", "It is read from src/config.ts at startup.")(q1), q1);
	assert.doesNotMatch(q1, /more line\(s\)|capped at/, "a short answer is never truncated and hides nothing");

	const q2 = between(drawn, "ANSWER — cp-q2", "ANSWER — cp-q3");
	assert.ok(q2.includes(`row ${ANSWER_CARD_COLLAPSED_LINES}`), q2);
	assert.doesNotMatch(q2, new RegExp(`row ${ANSWER_CARD_COLLAPSED_LINES + 1}\\b`), "the collapsed card shows only its head");
	assert.ok(q2.includes("… 7 more line(s) (expand)"), q2);

	const q3 = between(drawn, "ANSWER — cp-q3", "ANSWER — cp-q4");
	assert.ok(q3.includes(`ANSWER — cp-q3 · demo · ${(Buffer.byteLength(big) / 1024).toFixed(1)} KB`), "the header is the size on disk");
	assert.ok(q3.includes(`— capped at ${ANSWER_MAX_BYTES} bytes; full file at ${bigPath}`), q3);

	const q4 = between(drawn, "ANSWER — cp-q4", "ANSWER — cp-q5");
	assert.ok(q4.includes("ANSWER — cp-q4 · demo · 13 B"), "the header still renders once the file is gone");
	assert.ok(q4.includes(`answer at ${gonePath} (13 B) — file no longer readable`), q4);
	assert.doesNotMatch(q4, /here/, "a gone file shows no body");

	const q5 = between(drawn, "ANSWER — cp-q5", "ANSWER — cp-q6");
	assert.ok(q5.includes(`answer at ${dirPath} (0 B) — file no longer readable`), "an unreadable answer degrades like a missing one");

	const q6 = drawn.slice(drawn.indexOf("ANSWER — cp-q6"));
	assert.match(q6, /ANSWER — cp-q6 · 7 B\s+Answer/, "no project, no headline: the header still renders");
	assert.doesNotMatch(drawn, /renderer failed|TAIL-PAST-CAP/);

	const lastWhole = bigLines[Math.floor(ANSWER_MAX_BYTES / 100) - 1] as string;
	const expanded = await tui.press("\x0f", has("Tool output: expanded", `row ${rows.length}`, lastWhole), "ctrl+o expands the cards");
	assert.doesNotMatch(expanded, /more line\(s\)|TAIL-PAST-CAP|big 08[2-9]/, "an expanded card hides nothing but never reads past the cap");
});
