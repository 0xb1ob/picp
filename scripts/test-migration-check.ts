/**
 * Read-only validator for docs/testing-migration.md against the git tree at its pinned baseline; prints static `test(`
 * counts (TypeScript AST) apart from runner totals and exits 1 on any finding. Imports no production code.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DISPOSITIONS = new Set(["convert", "e2e", "retained", "exception", "deleted", "deleted-with-feature"]);
const GONE = new Set(["deleted", "deleted-with-feature"]);
/** Names a removing PR (`#123`) or job id (`cp-…`); a programme phase alone (`P1`) does not. */
const REMOVER_RE = /#\d+|\bcp-[a-z0-9][a-z0-9-]*/;

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

/** Titles of the bare-`test` calls (the case declarations); a non-literal title is `<expr>`. */
export function declarationTitles(path: string, source: string): string[] {
	const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
	const titles: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
			const title = node.arguments[0];
			titles.push(title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) ? title.text : "<expr>");
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return titles;
}

function countDeclarations(path: string, source: string): number {
	return declarationTitles(path, source).length;
}

/** A `deleted-with-feature` row: owner names the removing PR/job; evidence cites removed source modules. */
export function deletedWithFeatureFindings(path: string, owner: string, evidence: string, exists: (path: string) => boolean): string[] {
	const findings: string[] = [];
	if (!REMOVER_RE.test(owner)) findings.push(`${path}: deleted-with-feature owner must name the removing PR or job (got "${owner}")`);
	const sources = [...evidence.matchAll(/\b(?:src|extensions)\/[\w./-]+\.ts\b/g)].map((match) => match[0]);
	if (sources.length === 0) findings.push(`${path}: deleted-with-feature names no removed source module (src/… or extensions/…)`);
	for (const source of sources) if (exists(source)) findings.push(`${path}: deleted-with-feature cites ${source}, which still exists`);
	return findings;
}

/**
 * Lost declarations in kept files: each `feature-removed` row names a title present at the baseline, absent from the
 * tree, and the removing PR/job; a file's net loss must be covered by that many rows.
 */
export function featureRemovedFindings(
	rows: readonly string[][],
	lost: ReadonlyMap<string, { before: number; after: number }>,
	titles: (path: string) => { base: readonly string[]; tree: readonly string[] },
): string[] {
	const findings: string[] = [];
	const covered = new Map<string, Set<string>>();
	for (const [path = "", declaration = "", remover = ""] of rows) {
		const seen = covered.get(path) ?? new Set<string>();
		if (seen.has(declaration)) findings.push(`${path}: feature-removed "${declaration}" listed twice`);
		if (!REMOVER_RE.test(remover)) findings.push(`${path}: feature-removed "${declaration}" must name the removing PR or job`);
		const { base, tree } = titles(path);
		if (!base.includes(declaration)) findings.push(`${path}: feature-removed "${declaration}" is not a baseline declaration`);
		if (tree.includes(declaration)) findings.push(`${path}: feature-removed "${declaration}" is still declared`);
		covered.set(path, seen.add(declaration));
	}
	for (const [path, { before, after }] of lost) {
		const notes = covered.get(path)?.size ?? 0;
		if (before - after > notes) findings.push(`${path}: ${before} → ${after} declarations with no deletion record (${notes} feature-removed note(s))`);
	}
	return findings;
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

	const prs = new Map<string, { behavior: string; target: string; cases: string }>();
	for (const [pr = "", behavior = "", target = "", cases = ""] of rows(section(doc, "prs", findings))) {
		if (prs.has(pr)) findings.push(`${pr}: more than one conversion PR row`);
		if (!/^\d\d$/.test(behavior) || !target.startsWith("tests/e2e/")) findings.push(`${pr}: needs a behavior id and a tests/e2e/ target`);
		prs.set(pr, { behavior, target, cases });
	}

	const disposition = new Map<string, { kind: string; owner: string; evidence: string }>();
	for (const [path = "", kind = "", owner = "", evidence = ""] of rows(section(doc, "baseline", findings))) {
		if (disposition.has(path)) findings.push(`${path}: more than one baseline disposition`);
		if (!baseSet.has(path)) findings.push(`${path}: listed in the baseline but not a test file at ${base.slice(0, 12)}`);
		if (!DISPOSITIONS.has(kind)) findings.push(`${path}: unknown disposition "${kind}"`);
		if (kind !== "deleted" && !evidence) findings.push(`${path}: ${kind} without evidence`);
		if (!GONE.has(kind) && !currentSet.has(path)) findings.push(`${path}: missing from the tree but not dispositioned deleted`);
		if (GONE.has(kind) && currentSet.has(path)) findings.push(`${path}: dispositioned ${kind} but still present`);
		if (kind === "deleted-with-feature") findings.push(...deletedWithFeatureFindings(path, owner, evidence, existsSync));
		const pr = prs.get(owner);
		if (kind === "convert" && !evidence.startsWith(`behavior ${pr?.behavior ?? "?"}`)) {
			findings.push(`${path}: convert needs a conversion PR owner and "behavior <id>" evidence (got ${owner}, "${evidence}")`);
		}
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
	const lost = new Map<string, { before: number; after: number }>();
	for (const [path, before] of baseCounts) {
		const after = currentSet.has(path) ? decls([path]) : 0;
		if (after < before && !GONE.has(disposition.get(path)?.kind ?? "")) lost.set(path, { before, after });
	}
	findings.push(...featureRemovedFindings(rows(section(doc, "feature-removed", findings)), lost, (path) => ({
		base: baseFiles.includes(path) ? declarationTitles(path, git("show", `${base}:${path}`)) : [],
		tree: currentSet.has(path) ? declarationTitles(path, readFileSync(path, "utf8")) : [],
	})));
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
	const byOwner = [...owners].sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));
	for (const [owner, counts] of byOwner) console.log(`  ${owner || "(no owner)"}: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	console.log("conversion PRs (owned baseline files; static declarations at the baseline and in the tree):");
	const census = { files: 0, base: 0, tree: 0 };
	for (const [pr, { behavior, target, cases }] of prs) {
		const owned = [...disposition].filter(([, entry]) => entry.owner === pr).map(([path]) => path);
		const atBase = owned.reduce((sum, path) => sum + (baseCounts.get(path) ?? 0), 0);
		const inTree = decls(owned.filter((path) => currentSet.has(path)));
		census.files += owned.length;
		census.base += atBase;
		census.tree += inTree;
		console.log(`  ${pr} behavior ${behavior} → ${target} (${cases} cases): ${owned.length} files, ${atBase} baseline / ${inTree} tree declarations`);
	}
	console.log(`  total: ${census.files} files, ${census.base} baseline / ${census.tree} tree declarations`);
	if (args.runnerLog) console.log(`runner-executed (${args.runnerLog}): ${Object.entries(runnerTotals(readFileSync(args.runnerLog, "utf8"))).map(([k, n]) => `${k} ${n}`).join(", ")}`);
	for (const finding of findings) console.error(`FAIL ${finding}`);
	console.log(findings.length ? `${findings.length} finding(s)` : "manifest ok");
	return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = main();
	} catch (error) {
		console.error(`FAIL ${(error as Error).message}`);
		process.exitCode = 1;
	}
}
