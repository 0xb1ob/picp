/**
 * Moves the named slices' rows (and their regression patch blocks) from docs/testing-migration.md into
 * docs/testing-migration/<slice>.md, and the frozen retired-integration lines with them. `--list` prints slice sizes.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { RETIRED_PATTERN, lineHash, ALLOWLIST_FILE, type AllowEntry } from "./check-retired-integration.ts";

const MONOLITH = "docs/testing-migration.md";
const DIR = "docs/testing-migration";
const NAMES = ["prs", "scenarios", "assertions", "regressions", "incoming", "feature-removed", "baseline"] as const;
const PATCH = /<!-- patch:([\w-]+) -->\n```diff\n[\s\S]*?\n```\n(?:<!-- \/patch:\1 -->\n)?/g;

const cells = (line: string): string[] => line.slice(1, -1).split(" | ").map((cell) => cell.trim().replace(/^`|`$/g, ""));
const sliceToken = (text: string): string | undefined => /\bS(\d+b?)\b/.exec(text)?.[1]?.replace(/^/, "s");
const ownerKey = (owner: string): string =>
	sliceToken(owner) ?? (owner.includes("main-ci") ? "main-ci" : /^P\d+[a-z]?(-rest)?/.exec(owner)?.[0].toLowerCase() ?? "unowned");
const scenarioKey = (id: string): string => {
	const behavior = /^(\d\d)-/.exec(id)?.[1];
	return sliceToken(id) ?? (id.includes("-main-") ? "main-ci" : id.startsWith("DR-") ? "s04" : behavior ? `b${behavior}` : "unowned");
};

interface Table { header: string[]; rows: string[] }
const section = (text: string, name: string) =>
	new RegExp(`<!-- manifest:${name} -->\\n([\\s\\S]*?)<!-- /manifest:${name} -->\\n`).exec(text);

/** Table rows of a section in document order, with patch blocks excised. */
function table(text: string, name: string): Table {
	const body = section(text, name)?.[1] ?? "";
	const lines = body.replace(PATCH, "").split("\n").filter((line) => line.startsWith("|"));
	return { header: lines.slice(0, 2), rows: lines.slice(2) };
}

const patches = (text: string) => new Map([...text.matchAll(PATCH)].map((match) => [match[1] as string, match[0]]));
const sliceFiles = () => (existsSync(DIR) ? readdirSync(DIR).filter((name) => name.endsWith(".md")).map((name) => `${DIR}/${name}`) : []);

function keyOf(name: string, line: string, baseOwner: ReadonlyMap<string, string>): string {
	const c = cells(line);
	const [c0 = "", c1 = "", c2 = "", c3 = ""] = c;
	if (name === "prs") return ownerKey(c0);
	if (name === "scenarios") return scenarioKey(c0);
	if (name === "assertions") return /-retained\.test\.ts/.test(cells(line)[4] ?? "") && c2 === "—" && /^tests\/review-(tool|runs)\.test\.ts$/.test(c0) ? "s15" : c2 && c2 !== "—" ? scenarioKey(c2) : baseOwner.get(c0) ?? "unowned";
	if (name === "regressions") return scenarioKey(c3);
	if (name === "incoming") return ownerKey(c1);
	if (name === "feature-removed") return baseOwner.get(c0) ?? "unowned";
	return ownerKey(c2);
}

function main(): void {
	const args = process.argv.slice(2);
	const mono = readFileSync(MONOLITH, "utf8");
	const docs = [mono, ...sliceFiles().map((file) => readFileSync(file, "utf8"))];
	const baseOwner = new Map(docs.flatMap((doc) => table(doc, "baseline").rows).map((line) => [cells(line)[0] ?? "", ownerKey(cells(line)[2] ?? "")]));
	const allPatches = patches(mono);
	if (args[0] === "--list") {
		const sizes = new Map<string, number>();
		for (const name of NAMES) for (const line of table(mono, name).rows) {
			const key = keyOf(name, line, baseOwner);
			const patch = name === "regressions" ? allPatches.get(cells(line)[4] ?? "")?.length ?? 0 : 0;
			sizes.set(key, (sizes.get(key) ?? 0) + line.length + 1 + patch);
		}
		for (const [key, size] of [...sizes].sort((a, b) => a[1] - b[1])) console.log(`${key}\t${size}`);
		return;
	}
	const slices = new Set(args);
	if (slices.size === 0) throw new Error("usage: split-migration-ledger.ts --list | <slice...>");
	const moved = new Map<string, Map<string, string[]>>();
	const movedPatches = new Map<string, string[]>();
	let out = mono;
	let allowlist: AllowEntry[];
	try {
		allowlist = JSON.parse(readFileSync(ALLOWLIST_FILE, "utf8")) as AllowEntry[];
	} catch (error) {
		throw new Error(`${ALLOWLIST_FILE} is not readable JSON: ${(error as Error).message}`);
	}
	for (const name of NAMES) {
		const m = section(mono, name);
		if (!m) continue;
		let index = 0;
		const body = m[1] as string;
		const kept = body.split(PATCH_SPLIT).map((segment, i) => {
			if (i % 2 === 1) return segment;
			return segment.split("\n").filter((line) => {
				if (!line.startsWith("|")) return true;
				const row = index++;
				if (row < 2) return true;
				const key = keyOf(name, line, baseOwner);
				if (!slices.has(key)) return true;
				const perSlice = moved.get(key) ?? new Map<string, string[]>();
				perSlice.set(name, [...(perSlice.get(name) ?? []), line]);
				moved.set(key, perSlice);
				const patchId = name === "regressions" ? cells(line)[4] : undefined;
				if (patchId && allPatches.has(patchId)) movedPatches.set(key, [...new Set([...(movedPatches.get(key) ?? []), patchId])]);
				if (RETIRED_PATTERN.test(line)) shiftAllowance(allowlist, line, `${DIR}/${key}.md`);
				return false;
			}).join("\n");
		});
		out = out.replace(m[0], () => m[0].replace(body, () => kept.join("")));
	}
	const gone = new Set([...movedPatches.values()].flat());
	const dropped = new RegExp(`(?:(?<=\\n)\\n)?${PATCH.source}`, "g");
	out = out.replace(dropped, (block, id: string) => (gone.has(id) ? "" : block));
	mkdirSync(DIR, { recursive: true });
	for (const [key, perSlice] of moved) {
		const file = `${DIR}/${key}.md`;
		const old = existsSync(file) ? readFileSync(file, "utf8") : "";
		const parts = [`# Ledger rows: ${key}\n`];
		// Prose and patches already in the slice file stay where they are; only tables are rebuilt.
		const rest = old.replace(/^# Ledger rows:[^\n]*\n/, "").replace(/<!-- manifest:[\w-]+ -->\n[\s\S]*?<!-- \/manifest:[\w-]+ -->\n/g, "").replace(/^\n+/, "");
		for (const name of NAMES) {
			const before = table(old, name);
			const rows = [...before.rows, ...(perSlice.get(name) ?? [])];
			if (rows.length === 0) continue;
			const header = before.header.length ? before.header : table(mono, name).header;
			parts.push(`<!-- manifest:${name} -->\n${[...header, ...rows].join("\n")}\n<!-- /manifest:${name} -->\n`);
		}
		if (rest) parts.push(rest.replace(/\n*$/, "\n"));
		const tail = (movedPatches.get(key) ?? []).map((id) => allPatches.get(id) as string);
		writeFileSync(file, [...parts, ...tail].join("\n"));
		console.log(`${file}: ${[...perSlice].map(([name, rows]) => `${name} ${rows.length}`).join(", ")}`);
	}
	out = moveControls(out);
	if (slices.has("b05") || slices.has("s02")) {
		out = moveProse(out, `${DIR}/s02.md`, /S02 controls run with [\s\S]*?S02 worker artifact directory\.\n\n?/);
		out = movePatches(out, `${DIR}/s02.md`, ["NC-S02-key", "NC-S02-history", "NC-S02-prune"]);
	}
	if (slices.has("s19")) out = moveProse(out, `${DIR}/s19.md`, /S19 carry-in \(main session[\s\S]*?split-deferred\.log`\.\n\n?/);
	if (slices.has("s20")) out = moveProse(out, `${DIR}/s20.md`, /S20 wake-rule controls cover[^\n]*\n[^\n]*\n\n?/);
	writeFileSync(MONOLITH, out);
	writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(allowlist, null, "\t")}\n`);
}

/** Moves a prose paragraph out of the monolith into a slice file, ahead of its patch blocks; no-op when absent. */
function moveProse(text: string, file: string, paragraph: RegExp): string {
	const found = paragraph.exec(text);
	if (!found || !existsSync(file)) return text;
	const slice = readFileSync(file, "utf8");
	const at = slice.indexOf("<!-- patch:");
	const prose = found[0].replace(/\n*$/, "\n\n");
	writeFileSync(file, at < 0 ? `${slice.replace(/\n*$/, "\n\n")}${prose}` : `${slice.slice(0, at)}${prose}${slice.slice(at)}`);
	return text.replace(found[0], () => "");
}

/** Moves patch blocks by id from the monolith to the end of a slice file; no-op when absent. */
function movePatches(text: string, file: string, ids: string[]): string {
	if (!existsSync(file)) return text;
	let out = text;
	for (const id of ids) {
		const block = patches(out).get(id);
		if (!block) continue;
		writeFileSync(file, `${readFileSync(file, "utf8").replace(/\n*$/, "\n\n")}${block}`);
		const at = out.indexOf(block);
		out = out.slice(0, out[at - 1] === "\n" && out[at - 2] === "\n" ? at - 1 : at) + out.slice(at + block.length);
	}
	return out;
}

/** Moves each `NC-nn` prose paragraph, with its failure log, beside the patch block it describes; no-op when absent. */
function moveControls(text: string): string {
	const lines = text.split("\n");
	const at = lines.indexOf("## Assertion map");
	const files = sliceFiles();
	const drop: [number, number][] = [];
	for (let i = Math.max(at, 0); i < lines.length; i++) {
		if ((lines[i] as string).startsWith("```")) {
			while (!/^```$/.test(lines[++i] ?? "```")) continue;
			continue;
		}
		if (!lines[i] || /^(\||<!--|#)/.test(lines[i] as string)) continue;
		let end = i;
		while (end < lines.length && lines[end] && !/^(\||<!--)/.test(lines[end] as string)) end++;
		const head = lines.slice(i, end).join("\n");
		const key = /^(?:#+\s*|\*\*)?NC-(\d\d)\b/.exec(head)?.[1];
		let next = end;
		while (lines[next] === "") next++;
		const log = key && /^```(?!diff)/.test(lines[next] ?? "") ? next : -1;
		const close = log < 0 ? -1 : lines.indexOf("```", log + 1);
		const file = key ? files.find((name) => new RegExp(`<!-- patch:NC-${key}(?:-[\\w-]+)? -->`).test(readFileSync(name, "utf8"))) : undefined;
		if (file) {
			let slice = readFileSync(file, "utf8");
			const id = new RegExp(`<!-- patch:(NC-${key}(?:-[\\w-]+)?) -->`).exec(slice)?.[1];
			const block = id ? patches(slice).get(id) : undefined;
			if (!block) throw new Error(`${file}: cannot parse the NC-${key} patch block; its prose would be dropped`);
			const tail = close < 0 ? "" : `\n${lines.slice(log, close + 1).join("\n")}\n`;
			slice = slice.replace(block, () => `${head}\n\n${block}${tail}`);
			writeFileSync(file, slice);
			const last = close < 0 ? end : close + 1;
			drop.push([i, lines[last] === "" ? last + 1 : last]);
			end = last;
		}
		i = end;
	}
	for (const [from, to] of drop.reverse()) lines.splice(from, to - from);
	return lines.join("\n");
}

const PATCH_SPLIT = /(<!-- patch:[\w-]+ -->\n```diff\n[\s\S]*?\n```\n(?:<!-- \/patch:[\w-]+ -->\n)?)/;

/** Re-attributes one frozen allowlist line from the monolith to the slice file it moved to. */
function shiftAllowance(entries: AllowEntry[], line: string, path: string): void {
	const hash = lineHash(line);
	const from = entries.find((entry) => entry.path === MONOLITH && entry.sha256 === hash);
	if (!from) return;
	const to = entries.find((entry) => entry.path === path && entry.sha256 === hash);
	if (to) to.count += 1;
	else entries.push({ ...from, path, count: 1 });
	from.count -= 1;
	if (from.count === 0) entries.splice(entries.indexOf(from), 1);
}

main();
