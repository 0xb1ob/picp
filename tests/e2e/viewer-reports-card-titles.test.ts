/**
 * Reports card titles in real headless Chrome: `tests/fixtures/sessions-chat-v2-browser.ts --stage reports-cards`
 * serves the built app with a 300-character, a bare-URL and a short title in both grids, then measures every card.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { REPO_ROOT } from "../harness/index.ts";

const CHROME = "/usr/bin/google-chrome";
type Card = { text: string; inside: boolean; overflow: number; lines: number; two_lines: boolean; apart: boolean; named: boolean };
type Heading = { height: number; line_height: number; lines: number; one_line: boolean; fits: boolean; under: boolean };
type Shot = { file: string; overflow: number; cards?: Card[]; heading?: Heading; jobs?: number[] };

test("reports-card-titles: titles wrap inside their cards in two lines beside the date at 1440, 1000 and 390; Jobs rows hold",
	{ skip: process.env.CI ? "Chrome cannot start as the CI cpci user (sandbox, crashpad); run locally: npm run test:one -- tests/e2e/viewer-reports-card-titles.test.ts"
		: existsSync(CHROME) ? false : `no Chrome at ${CHROME}`, timeout: 240_000 }, async (t) => {
	const out = mkdtempSync(join(tmpdir(), "cp-reports-cards-"));
	t.after(() => rmSync(out, { recursive: true, force: true }));
	await promisify(execFile)(process.execPath, ["tests/fixtures/sessions-chat-v2-browser.ts", "--stage", "reports-cards", "--chrome", CHROME, "--out", out],
		{ cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
	const shots = (JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { shots: Shot[] }).shots;
	const name = (shot: Shot) => shot.file.replace(/^.*\//, "");
	assert.deepEqual(shots.map(name), ["reports-cards-desktop.png", "reports-cards-narrow.png", "reports-cards-phone.png", "reports-cards-jobs-desktop.png"]);
	for (const shot of shots.filter((s) => s.cards)) {
		const off = (key: "inside" | "two_lines" | "apart" | "named") => shot.cards!.filter((c) => !c[key]).map((c) => `${c.text} (${c.overflow}px over, ${c.lines} lines)`);
		assert.equal(shot.cards!.length, 7, `${name(shot)}: four published and three job report cards`);
		assert.deepEqual(off("inside"), [], `${name(shot)}: every title rect stays inside its card rect (±1px)`);
		assert.deepEqual(off("two_lines"), [], `${name(shot)}: every title is at most two line-heights tall`);
		assert.deepEqual(off("apart"), [], `${name(shot)}: no title rect intersects its date rect`);
		assert.deepEqual(off("named"), [], `${name(shot)}: every title link carries its full title as a title attribute`);
		assert.equal(shot.overflow, 0, `${name(shot)}: scrollWidth - innerWidth is 0`);
	}
	const phone = shots.find((s) => name(s) === "reports-cards-phone.png")!.heading!;
	assert.equal(phone.one_line, true, `reports-cards-phone.png: the page title is at most 1.5 line-heights (${phone.height}px, ${phone.lines} lines)`);
	assert.equal(phone.fits, true, "reports-cards-phone.png: the page title is at least as wide as its one-line text");
	assert.equal(phone.under, true, "reports-cards-phone.png: the intro starts under the page title");
	const jobs = shots.at(-1)!;
	assert.equal(jobs.overflow, 0, `${name(jobs)}: scrollWidth - innerWidth is 0`);
	assert.deepEqual(jobs.jobs, [40, 36], "Jobs keeps its approved compact rows at 1440: 40px in flight, 36px done");
});
