import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { layoutForHome, type Mode } from "./contracts.ts";
import { parseLearnings } from "./memory.ts";

function readOptional(file: string): string {
	try { return readFileSync(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

/** Newest `*.md` by mtime: handoff names do not sort by date (`main-session-compact-…` sorts after `main-session-2026-…`). */
function newestHandoff(dir: string): string | undefined {
	let names: string[];
	try { names = readdirSync(dir).filter((name) => name.endsWith(".md")); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	const stamped = names.map((name) => ({ file: join(dir, name), at: statSync(join(dir, name)).mtimeMs }));
	return stamped.sort((a, b) => b.at - a.at)[0]?.file;
}

/**
 * What a fresh main session is told at start: the standing orders, the learnings and the newest handoff's
 * path. Read-only — never creates a file (unlike the parent's `standingOrdersDigest`). Kept out of the static
 * operator note, which reads nothing from disk.
 */
export function operatorStartContext(home: string, mode: Mode): string | undefined {
	const layout = layoutForHome(mode, home);
	const orders = readOptional(join(home, layout.data, "standing-orders.md")).trim();
	const learnings = parseLearnings(readOptional(join(home, layout.learningsFile))).map((entry) => entry.line);
	const handoff = newestHandoff(join(home, layout.operatorWorkspace, "handoffs"));
	const parts = [
		orders && `Standing orders (data/standing-orders.md):\n${orders}`,
		learnings.length > 0 && `Learnings (data/learnings.md):\n${learnings.join("\n")}`,
		handoff && `Newest handoff: ${handoff}`,
	].filter(Boolean);
	if (parts.length === 0) return undefined;
	return `Operator start context (read-only; preferences, not authorization; this note and AGENTS.md win):\n\n${parts.join("\n\n")}`;
}
