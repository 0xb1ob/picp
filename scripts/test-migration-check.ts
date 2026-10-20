/**
 * Read-only validator for docs/testing-migration.md against the git tree at its pinned baseline; prints static `test(`
 * counts (TypeScript AST) apart from runner totals and exits 1 on any finding. Imports no production code.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";

const DISPOSITIONS = new Set(["pending", "e2e", "retained", "exception", "deleted"]);

interface Args {
	base?: string;
	manifest: string;
	runnerLog?: string;
	verifyRegressions: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { manifest: "docs/testing-migration.md", verifyRegressions: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = () => {
			const next = argv[(i += 1)];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
			return next;
		};
		if (flag === "--base") args.base = value();
		else if (flag === "--manifest") args.manifest = value();
		else if (flag === "--runner-log") args.runnerLog = value();
		else if (flag === "--verify-regressions") args.verifyRegressions = true;
		else throw new Error(`unknown argument ${flag}`);
	}
	return args;
}

/** The body of `<!-- manifest:<name> -->` … `<!-- /manifest:<name> -->`; a missing section is a finding. */
function section(doc: string, name: string, findings: string[]): string {
	const match = new RegExp(`<!-- manifest:${name} -->\\n([\\s\\S]*?)<!-- /manifest:${name} -->`).exec(doc);
	if (!match) findings.push(`manifest has no ${name} section`);
	return match?.[1] ?? "";
}

/** Table rows of a section as trimmed cells, header and separator rows dropped; backticks are stripped. */
function rows(body: string): string[][] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
		.slice(1)
		.map((line) => line.slice(1, line.endsWith("|") ? -1 : undefined).split(" | ").map((cell) => cell.trim().replace(/^`|`$/g, "")));
}

function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

/** Calls whose callee is the bare identifier `test`: the repository's case declarations. */
function countDeclarations(path: string, source: string): number {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	let count = 0;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") count += 1;
		ts.forEachChild(node, visit);
	};
	visit(file);
	return count;
}

function currentTestFiles(): string[] {
	return git("ls-files", "--cached", "--others", "--exclude-standard", "--", "tests")
		.split("\n")
		.filter((path) => path.endsWith(".test.ts") && existsSync(path));
}

/** Sum of the node runner's `ℹ tests|pass|fail|skipped|todo N` summary lines in a saved log. */
function runnerTotals(log: string): Record<string, number> {
	const totals: Record<string, number> = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 };
	for (const match of log.matchAll(/^ℹ (tests|pass|fail|skipped|todo) (\d+)$/gm)) {
		const key = match[1] as string;
		totals[key] = (totals[key] ?? 0) + Number(match[2]);
	}
	return totals;
}

function main(): number {
	const args = parseArgs(process.argv.slice(2));
	const findings: string[] = [];
	const doc = readFileSync(args.manifest, "utf8");
	const pinned = /^Baseline sha: `([0-9a-f]{40})`$/m.exec(doc)?.[1];
	if (!pinned) findings.push("manifest names no `Baseline sha:`");
	if (args.base && pinned && args.base !== pinned) findings.push(`--base ${args.base} is not the manifest's baseline ${pinned}`);
	const base = args.base ?? pinned ?? "";

	const baseFiles = base ? git("ls-tree", "-r", "--name-only", base, "--", "tests").split("\n").filter((p) => p.endsWith(".test.ts")) : [];
	const baseSet = new Set(baseFiles);
	const current = currentTestFiles();
	const currentSet = new Set(current);

	const disposition = new Map<string, { kind: string; owner: string; evidence: string }>();
	for (const [path = "", kind = "", owner = "", evidence = ""] of rows(section(doc, "baseline", findings))) {
		if (disposition.has(path)) findings.push(`${path}: more than one baseline disposition`);
		if (!baseSet.has(path)) findings.push(`${path}: listed in the baseline but not a test file at ${base.slice(0, 12)}`);
		if (!DISPOSITIONS.has(kind)) findings.push(`${path}: unknown disposition "${kind}"`);
		if (kind !== "pending" && kind !== "deleted" && !evidence) findings.push(`${path}: ${kind} without evidence`);
		if (kind !== "deleted" && !currentSet.has(path)) findings.push(`${path}: missing from the tree but not dispositioned deleted`);
		if (kind === "deleted" && currentSet.has(path)) findings.push(`${path}: dispositioned deleted but still present`);
		disposition.set(path, { kind, owner, evidence });
	}
	for (const path of baseFiles) if (!disposition.has(path)) findings.push(`${path}: baseline file with no disposition`);

	const incoming = new Set<string>();
	for (const [path = "", owner = ""] of rows(section(doc, "incoming", findings))) {
		if (baseSet.has(path)) findings.push(`${path}: incoming but already in the baseline`);
		if (!owner) findings.push(`${path}: incoming without an owning PR`);
		incoming.add(path);
	}
	for (const path of current) if (!baseSet.has(path) && !incoming.has(path)) findings.push(`${path}: test file in neither the baseline nor incoming`);

	const scenarios = new Map<string, string>();
	for (const [id = "", path = "", name = ""] of rows(section(doc, "scenarios", findings))) {
		if (scenarios.has(id)) findings.push(`scenario ${id}: duplicate id`);
		scenarios.set(id, path);
		if (!existsSync(path)) findings.push(`scenario ${id}: ${path} does not exist`);
		else if (!readFileSync(path, "utf8").includes(JSON.stringify(name))) findings.push(`scenario ${id}: no test named ${JSON.stringify(name)} in ${path}`);
	}

	const unmapped = new Map<string, number>();
	for (const [path = "", assertion = "", scenario = "", status = "", note = ""] of rows(section(doc, "assertions", findings))) {
		if (!disposition.has(path)) findings.push(`assertion map names ${path}, which is not a baseline file`);
		const pinned = status === "mapped" || status === "redundant-unreachable";
		if (pinned && !scenarios.has(scenario)) findings.push(`${path}: "${assertion}" is ${status} but names no known e2e scenario (got "${scenario}")`);
		if (status === "redundant-unreachable" && !note) findings.push(`${path}: "${assertion}" is redundant-unreachable with no reason or approval`);
		if (status === "unreachable") {
			if (!note) findings.push(`${path}: "${assertion}" is unreachable with no reason`);
			unmapped.set(path, (unmapped.get(path) ?? 0) + 1);
		} else if (!pinned) findings.push(`${path}: "${assertion}" has unknown disposition "${status}"`);
	}

	const patches = new Map([...doc.matchAll(/<!-- patch:([\w-]+) -->\n```diff\n([\s\S]*?)\n```/g)].map((m) => [m[1] as string, `${m[2]}\n`]));
	const proven = new Set<string>();
	for (const [id = "", path = "", commit = "", scenario = "", patch = "", sha = "", failing = "", fixed = ""] of rows(section(doc, "regressions", findings))) {
		if (!scenarios.has(scenario)) findings.push(`regression ${id}: unknown scenario ${scenario}`);
		if (!failing || fixed !== "pass") findings.push(`regression ${id}: needs a failing assertion and a fixed "pass"`);
		if (!args.verifyRegressions) {
			proven.add(path);
			continue;
		}
		const body = patches.get(patch);
		if (!body) findings.push(`regression ${id}: no patch block ${patch}`);
		else if (createHash("sha256").update(body).digest("hex") !== sha) findings.push(`regression ${id}: patch ${patch} does not hash to ${sha}`);
		try {
			git("cat-file", "-e", `${commit}^{commit}`);
			proven.add(path);
		} catch {
			findings.push(`regression ${id}: bug commit ${commit} is not in this repository`);
		}
	}
	for (const [path, entry] of disposition) {
		if (entry.kind !== "deleted") continue;
		if (!proven.has(path)) findings.push(`${path}: deleted without a negative-control record`);
		if (unmapped.has(path)) findings.push(`${path}: deleted with ${unmapped.get(path)} unreachable assertion(s)`);
	}

	const baseCounts = new Map(baseFiles.map((path) => [path, countDeclarations(path, git("show", `${base}:${path}`))]));
	const baseDecls = [...baseCounts.values()].reduce((sum, n) => sum + n, 0);
	const decls = (paths: readonly string[]) => paths.reduce((sum, path) => sum + countDeclarations(path, readFileSync(path, "utf8")), 0);
	for (const [path, before] of baseCounts) {
		const after = currentSet.has(path) ? decls([path]) : 0;
		if (after < before && disposition.get(path)?.kind !== "deleted") findings.push(`${path}: ${before} → ${after} declarations with no deletion record`);
	}
	const kept = current.filter((path) => baseSet.has(path));
	const added = current.filter((path) => !baseSet.has(path));
	console.log(`baseline ${base.slice(0, 12)}: ${baseFiles.length} files, ${baseDecls} static declarations`);
	console.log(`tree: ${current.length} files, ${decls(current)} static declarations (baseline ${kept.length}/${decls(kept)}, incoming ${added.length}/${decls(added)})`);
	const owners = new Map<string, Record<string, number>>();
	for (const { kind, owner } of disposition.values()) {
		const counts = owners.get(owner) ?? {};
		counts[kind] = (counts[kind] ?? 0) + 1;
		owners.set(owner, counts);
	}
	for (const [owner, counts] of [...owners].sort()) console.log(`  ${owner || "(no owner)"}: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	if (args.runnerLog) console.log(`runner-executed (${args.runnerLog}): ${Object.entries(runnerTotals(readFileSync(args.runnerLog, "utf8"))).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	for (const finding of findings) console.error(`FAIL ${finding}`);
	console.log(findings.length ? `${findings.length} finding(s)` : "manifest ok");
	return findings.length ? 1 : 0;
}

try {
	process.exitCode = main();
} catch (error) {
	console.error(`FAIL ${(error as Error).message}`);
	process.exitCode = 1;
}
