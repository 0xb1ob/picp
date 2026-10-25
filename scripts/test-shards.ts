/**
 * Duration-balanced test sharding: greedy longest-first over scripts/test-timings.json.
 * `files <n>` lists shard n; `check` verifies every test file is in exactly one shard (untimed files weigh the median);
 * `gen <spec-log>` rewrites the table from a CI run's spec reporter output.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SHARDS = 4;
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

function loadTable(): Record<string, number> {
	try {
		return JSON.parse(readFileSync(TABLE, "utf8"));
	} catch (error) {
		throw new Error(`cannot read timing table ${TABLE}: ${String(error)}`);
	}
}
const discover = (): string[] => globSync(GLOB).sort();

/** Top-level (unindented) spec lines carry per-test or per-suite wall time; credit each to the file naming it. */
export function timingsFromSpecLog(log: string, sources: Record<string, string>): Record<string, number> {
	const out: Record<string, number> = Object.fromEntries(Object.keys(sources).map((f) => [f, 0]));
	for (const line of log.split("\n")) {
		const m = line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z /, "").match(/^[✔✖▶] (.+) \(([\d.]+)ms\)\s*$/u);
		if (!m) continue;
		const owner = Object.keys(sources).find((f) => sources[f]!.includes(m[1]!));
		if (owner) out[owner] = Math.round(out[owner]! + Number(m[2]));
	}
	return out;
}

if (import.meta.main) {
	const [cmd, arg] = process.argv.slice(2);
	if (cmd === "files") {
		const i = Number(arg);
		if (!Number.isInteger(i) || i < 1 || i > SHARDS) throw new Error(`shard must be 1..${SHARDS}, got ${arg}`);
		const list = assignShards(discover(), loadTable())[i - 1]!;
		if (list.length === 0) throw new Error(`shard ${i} is empty`);
		console.log(list.join("\n"));
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
		const files = discover();
		const sources = Object.fromEntries(files.map((f) => [f, readFileSync(f, "utf8")]));
		const t = timingsFromSpecLog(readFileSync(arg, "utf8"), sources);
		const med = median(Object.values(t).filter((v) => v > 0));
		const prior = loadTable();
		for (const f of files) if (!t[f]) t[f] = prior[f] === 0 ? 0 : Math.round(med);
		writeFileSync(TABLE, `${JSON.stringify(Object.fromEntries(Object.entries(t).sort()), null, "\t")}\n`);
	} else {
		console.error("usage: test-shards.ts files <1..4> | check | gen <spec-log>");
		process.exit(2);
	}
}
