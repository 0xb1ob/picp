/**
 * Duration-balanced sharding (greedy longest-first over scripts/test-timings.json): `files <n>` lists shard n, `run <n>`
 * runs it heaviest file first, `check` verifies the partition (untimed weigh the median), `gen <spec-log>` rewrites it.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { fileURLToPath } from "node:url";
import TestFileGuard from "./test-file-guard.ts";

export const SHARDS = 15;
const TABLE = fileURLToPath(new URL("./test-timings.json", import.meta.url));
const CI_YML = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
const GLOB = "tests/**/*.test.ts";

export function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	return s.length === 0 ? 1 : (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
}

/** Unknown or new files weigh the table's median; ties break by name so the split is deterministic. */
export function assignShards(files: readonly string[], timings: Record<string, number>, n = SHARDS): string[][] {
	const med = median(Object.values(timings).filter((v) => v > 0));
	const weight = (f: string) => timings[f] ?? med;
	const shards = Array.from({ length: n }, () => ({ load: 0, files: [] as string[] }));
	for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
		const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
		lightest.load += weight(f);
		lightest.files.push(f);
	}
	return shards.map((s) => s.files.sort());
}

/** The node CLI runs files alphabetically; starting the heaviest first keeps a late-sorting big file off the tail. */
export function startOrder(files: readonly string[], timings: Record<string, number>): string[] {
	const med = median(Object.values(timings).filter((v) => v > 0));
	const weight = (f: string) => timings[f] ?? med;
	return [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
}

function loadTable(): Record<string, number> {
	try {
		return JSON.parse(readFileSync(TABLE, "utf8"));
	} catch (error) {
		throw new Error(`cannot read timing table ${TABLE}: ${String(error)}`);
	}
}
const discover = (): string[] => globSync(GLOB).sort();

/** Whether a file declares a spec name: as a literal, or as a template literal whose `${}` slots match any text. */
function declares(source: string): (name: string) => boolean {
	const templates = [...source.matchAll(/`([^`]*\$\{[^`]*)`/g)]
		.map((m) => m[1]!.split(/\$\{[^}]*\}/))
		.filter((parts) => parts.join("").length >= 8)
		.map((parts) => new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`, "su"));
	return (name) => source.includes(name) || templates.some((re) => re.test(name));
}

/**
 * Credits each top-level spec line of a `gh run view --log` to its job's shard (rebuilt from the run's `table`): the
 * reporter prints files whole in `startOrder`, so a line goes to the next file declaring it, else stays (`unmatched`).
 */
export function timingsFromRunLog(
	log: string,
	files: readonly string[],
	table: Record<string, number>,
	sources: Record<string, string>,
): { timings: Record<string, number>; unmatched: number } {
	const ms: Record<string, number> = Object.fromEntries(files.map((f) => [f, 0]));
	const orders = assignShards(files, table).map((s) => startOrder(s, table));
	const named = Object.fromEntries(files.map((f) => [f, declares(sources[f] ?? "")]));
	const cursor = orders.map(() => 0);
	let unmatched = 0;
	for (const line of log.split("\n")) {
		const m = /^test-shard \((\d+)\)\t[^\t]*\t\S+ [✔✖▶﹣] (.+?) \(([\d.]+)ms\)(?: # .*)?\s*$/u.exec(line);
		const k = Number(m?.[1]) - 1;
		const order = orders[k];
		if (!m || !order || order.length === 0) continue;
		const next = order.findIndex((f, i) => i >= cursor[k]! && named[f]!(m[2]!));
		if (next < 0) unmatched++;
		else cursor[k] = next;
		ms[order[cursor[k]!]!]! += Number(m[3]);
	}
	return { timings: Object.fromEntries(Object.entries(ms).map(([f, v]) => [f, Math.round(v)])), unmatched };
}

function shardFiles(arg: string | undefined, table: Record<string, number>): string[] {
	const i = Number(arg);
	if (!Number.isInteger(i) || i < 1 || i > SHARDS) throw new Error(`shard must be 1..${SHARDS}, got ${arg}`);
	const list = assignShards(discover(), table)[i - 1]!;
	if (list.length === 0) throw new Error(`shard ${i} is empty`);
	return list;
}

if (import.meta.main) {
	const [cmd, arg] = process.argv.slice(2);
	if (cmd === "files") {
		console.log(shardFiles(arg, loadTable()).join("\n"));
	} else if (cmd === "run") {
		const table = loadTable();
		const list = startOrder(shardFiles(arg, table), table);
		const stream = run({ files: list.map((f) => resolve(f)), concurrency: 3, timeout: 300_000, forceExit: true });
		stream.on("test:fail", () => {
			process.exitCode = 1;
		});
		stream.pipe(new spec()).pipe(process.stdout);
		stream.pipe(new TestFileGuard(undefined, list)).pipe(process.stdout);
	} else if (cmd === "check") {
		const all = discover();
		const table = loadTable();
		const untimed = all.filter((f) => !(f in table));
		if (untimed.length > 0) console.log(`${untimed.length} file(s) with no timing entry weigh the median: ${untimed.join(", ")}`);
		const shards = assignShards(all, table);
		const flat = shards.flat();
		const bad = all.filter((f) => flat.filter((g) => g === f).length !== 1);
		if (all.length === 0 || bad.length > 0 || flat.length !== all.length || shards.some((s) => s.length === 0)) {
			console.error(`shard assignment is not a partition of ${GLOB}; offenders: ${bad.join(", ") || "(empty shard)"}`);
			process.exit(1);
		}
		const matrix = /matrix:\s*\n\s*shard:\s*\[([^\]]*)\]/.exec(readFileSync(CI_YML, "utf8"))?.[1]?.split(",").map((x) => Number(x.trim()));
		const want = shards.map((_, k) => k + 1);
		if (!matrix || matrix.join() !== want.join()) {
			console.error(`ci.yml test-shard matrix is [${matrix?.join(", ") ?? "missing"}]; the script assigns shards [${want.join(", ")}]`);
			process.exit(1);
		}
		console.log(`${all.length} files in ${shards.length} shards: ${shards.map((s) => s.length).join("/")}`);
	} else if (cmd === "gen" && arg) {
		// Run at the log's commit: its file list and table rebuild the shards that run used.
		const files = discover();
		const prior = loadTable();
		const sources = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
		const { timings: t, unmatched } = timingsFromRunLog(readFileSync(arg, "utf8"), files, prior, sources);
		const med = median(Object.values(t).filter((v) => v > 0));
		for (const f of files) if (!t[f]) t[f] = prior[f] === 0 ? 0 : Math.round(med);
		writeFileSync(TABLE, `${JSON.stringify(Object.fromEntries(Object.entries(t).sort()), null, "\t")}\n`);
		console.log(`${unmatched} spec line(s) named no later file of their shard and stayed with the current one`);
	} else {
		console.error(`usage: test-shards.ts files <1..${SHARDS}> | run <1..${SHARDS}> | check | gen <gh-run-log>`);
		process.exit(2);
	}
}
