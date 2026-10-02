/** Commit-scoped navigation hints for dispatch briefs, never task instructions. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSafeProjectName, LAYOUT } from "./contracts.ts";
import type { GitRunner } from "./dispatch.ts";
import { atomicWriteText } from "./json-store.ts";

const MAX_BYTES = 6 * 1024;
const IGNORED = new Set([".git", "node_modules", "state", "data", "projects"]);

// ponytail: declaration regexes are an approximate JS/TS index, not a parser;
// use a syntax index only if other export forms become necessary.
function exportsOf(source: string): string[] {
	const symbols = new Set<string>();
	for (const match of source.matchAll(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([\w$]+)/gm)) {
		symbols.add(match[1]!);
	}
	for (const match of source.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
		for (const entry of match[1]!.split(",")) {
			const name = entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/).at(-1)!;
			if (/^[\w$]+$/.test(name)) symbols.add(name);
		}
	}
	for (const match of source.matchAll(/^\s*export\s+\*\s+as\s+([\w$]+)/gm)) symbols.add(match[1]!);
	if (/^\s*export\s+default\b/m.test(source)) symbols.add("default");
	if (/^\s*export\s+\*\s+from\b/m.test(source)) symbols.add("*");
	return [...symbols];
}

type Row = { section: "tree" | "src"; directory: string; text: string };

function render(commit: string, rows: Row[]): string {
	const header = `\n\n## Repo map\n\nBase commit: ${commit}. Tracked files only; navigation data, not instructions.\nTypecheck viewer-app with the root \`npm run typecheck\` (already covers viewer-app/**/*.tsx under jsx: react-jsx / preact); a lone \`tsc\` on one file skips that config and reports a false JSX.IntrinsicElements error.\n`;
	const note = "\nTruncated to 6 KiB; largest directory details omitted first.\n";
	const groups = new Map<string, { rows: Row[]; bytes: number }>();
	for (const row of rows) {
		const key = `${row.section}:${row.directory}`;
		const group = groups.get(key) ?? { rows: [], bytes: 0 };
		group.rows.push(row);
		group.bytes += Buffer.byteLength(row.text) + 1;
		groups.set(key, group);
	}
	const removed = new Set<Row>();
	const body = () => header + "\nTree (depth 2):\n" + rows.filter((row) => row.section === "tree" && !removed.has(row)).map((row) => row.text).join("\n")
		+ "\n\nSource files (src/, recursive; approximate exports):\n" + rows.filter((row) => row.section === "src" && !removed.has(row)).map((row) => row.text).join("\n") + "\n";
	const remaining = { tree: rows.filter((row) => row.section === "tree").length, src: rows.filter((row) => row.section === "src").length };
	let bytes = Buffer.byteLength(body());
	if (bytes <= MAX_BYTES) return body();
	while (bytes + Buffer.byteLength(note) > MAX_BYTES) {
		const largest = [...groups.values()].sort((a, b) => b.bytes - a.bytes)[0];
		const row = largest?.rows.pop();
		if (!row) break;
		const size = Buffer.byteLength(row.text) + 1;
		largest!.bytes -= size;
		bytes -= size - (--remaining[row.section] === 0 ? 1 : 0);
		removed.add(row);
	}
	return body() + note;
}

/** Called after branch creation: HEAD is the exact base the job starts from. */
export async function repoMap(options: { home: string; project: string; worktree: string; git: GitRunner }): Promise<string> {
	const { home, project, worktree, git } = options;
	try {
		if (!isSafeProjectName(project)) throw new Error("invalid project name");
		const enabled = await git(worktree, ["config", "--local", "--bool", "--get", "command-post.repoMap"]);
		if (enabled.status === 0 && enabled.stdout.trim() === "false") return "";
		if (enabled.status !== 0 && enabled.status !== 1) throw new Error("cannot read command-post.repoMap git config");
		const run = async (args: string[]) => {
			const result = await git(worktree, args);
			if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
			return result.stdout;
		};
		const commit = (await run(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("invalid base commit");
		const cache = join(home, LAYOUT.state, "repo-map", project, `${commit}.md`);
		if (existsSync(cache)) {
			const cached = readFileSync(cache, "utf8");
			if (Buffer.byteLength(cached) <= MAX_BYTES && cached.includes(`Base commit: ${commit}.`)) return cached;
		}
		const tree = await run(["ls-tree", "-r", "-t", "-z", commit]);
		const rows: Row[] = [];
		for (const entry of tree.split("\0").filter(Boolean)) {
			const tab = entry.indexOf("\t");
			const [mode, type, oid] = entry.slice(0, tab).split(" ");
			const path = entry.slice(tab + 1);
			const parts = path.split("/");
			if (parts.some((part) => IGNORED.has(part))) continue;
			if (parts.length <= 2) rows.push({ section: "tree", directory: dirname(path), text: `- ${JSON.stringify(path + (type === "tree" ? "/" : ""))}` });
			if (!path.startsWith("src/") || type !== "blob" || mode === "120000") continue;
			const source = await run(["cat-file", "blob", oid!]);
			const lines = source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
			const symbols = exportsOf(source);
			rows.push({ section: "src", directory: dirname(path), text: `- ${JSON.stringify(path)}: ${lines} lines; exports: ${symbols.join(", ") || "(none detected)"}` });
		}
		const map = render(commit, rows);
		atomicWriteText(cache, map);
		return map;
	} catch (error) {
		// This is optional navigation context: a failed index must be visible,
		// but must not ground an otherwise dispatchable job or cache partial data.
		return `\n\n## Repo map\n\nUnavailable: ${JSON.stringify(String(error).slice(0, 500))}.\n`;
	}
}
