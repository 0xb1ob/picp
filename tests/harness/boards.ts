/**
 * Published boards on a scratch home, shared by the dashboard's `/boards/` tests (P22) and the boards-only listener's
 * (boards-listener): the same seeded boards and the same refusal list, so both ports are held to one confinement.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT } from "../../src/contracts.ts";

/** Boards as the board skill publishes them: valid ones, a torn one, and four that resolve outside the boards dir. */
export function seedBoards(home: string) {
	const outside = mkdtempSync(join(tmpdir(), "cp-boards-out-"));
	const boards = join(home, LAYOUT.state, "boards");
	const make = (slug: string, meta: unknown): string => {
		const site = join(boards, slug, "site");
		mkdirSync(join(site, "img"), { recursive: true });
		writeFileSync(join(boards, slug, "board.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
		return site;
	};
	const site = make("alpha", { title: "Alpha report", description: "the first", job_ids: ["cp-1", 7, null], created_at: "2026-09-01T00:00:00Z" });
	writeFileSync(join(site, "index.html"), '<link rel="stylesheet" href="/boards/board.css"><h1>Alpha</h1>');
	writeFileSync(join(site, "img", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(site, ".hidden"), "no");
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(join(outside, "secret.txt"), join(site, "out.txt"));
	symlinkSync(join(site, "index.html"), join(site, "in.html"));
	writeFileSync(join(make("beta", { title: "Beta report", description: "the second", job_ids: ["cp-2"], created_at: "2026-09-03T00:00:00Z" }), "index.html"), "beta");
	make("broken", "{not json");
	make("untimed", { title: "No timestamp" });
	make("untitled", { title: "", created_at: "2026-09-02T00:00:00Z" });
	make("Upper", { title: "Upper", created_at: "2026-09-02T00:00:00Z" });
	const escape = make("escape", { title: "Escape", created_at: "2026-09-02T00:00:00Z" });
	rmSync(escape, { recursive: true });
	mkdirSync(join(outside, "elsewhere"));
	writeFileSync(join(outside, "elsewhere", "index.html"), "elsewhere");
	symlinkSync(join(outside, "elsewhere"), escape);
	mkdirSync(join(outside, "linked"));
	writeFileSync(join(outside, "linked", "board.json"), JSON.stringify({ title: "Linked", created_at: "2026-09-04T00:00:00Z" }));
	symlinkSync(join(outside, "linked"), join(boards, "linked"));
	const jsonout = make("jsonout", {});
	writeFileSync(join(jsonout, "index.html"), "jsonout");
	rmSync(join(boards, "jsonout", "board.json"));
	writeFileSync(join(outside, "elsewhere.json"), JSON.stringify({ title: "Out", created_at: "2026-09-05T00:00:00Z" }));
	symlinkSync(join(outside, "elsewhere.json"), join(boards, "jsonout", "board.json"));
	return { outside, make };
}

/** Bad slugs, traversal, encoded slashes, dot files, symlink escapes and torn boards: each a 404 under BOARD_CSP. */
export const REFUSED_BOARD_PATHS: readonly string[] = ["/boards/nope/", "/boards/broken/", "/boards/Upper/", "/boards/-a/", "/boards/a_b/", "/boards/a.b/",
	`/boards/${"x".repeat(65)}/`, "/boards/%C3%A9/", "/boards/alpha/out.txt", "/boards/alpha/..%2Fboard.json", "/boards/alpha/%2e%2e/board.json",
	"/boards/alpha/img/..%2f..%2fboard.json", "/boards/alpha/.hidden", "/boards/alpha/img", "/boards/alpha/img/", "/boards/alpha/%E0%A4%A",
	"/boards/alpha/a%00.png", "/boards/alpha/missing.html", "/boards/escape/", "/boards/jsonout/", "/boards/jsonout", "/boards/linked/", "/boards/untimed/",
	"/boards/..%2Falpha/"];
