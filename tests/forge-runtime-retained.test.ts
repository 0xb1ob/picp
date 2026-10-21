/** Retained landing-proof budget, runner timeout and recheck boundaries; see docs/testing-migration.md. */
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type GitRun, type LandingProof, readLandingProof } from "../src/landing-proof.ts";
import { defaultGit, landingMoved } from "../src/teardown-head.ts";
import { advanceBase, createScratchRepo, git, type ScratchRepo, squashMergeAndDeleteHead } from "./harness/index.ts";
// Retained by P3b (docs/testing-migration.md): moved verbatim from tests/landing-proof.test.ts.
const MUTATING = new Set(["reset", "checkout", "switch", "commit", "update-ref", "push", "merge", "branch", "tag", "add", "rm", "restore", "stash", "rebase", "cherry-pick", "update-index", "write-tree", "symbolic-ref"]);

interface Bench {
	repo: ScratchRepo;
	calls: string[][];
	/** A linked job worktree branched from origin's current main. */
	job(id: string): string;
	run: GitRun;
}

function benchOf(t: { after(fn: () => void): void }): Bench {
	const repo = createScratchRepo({ name: "lp", files: { "README.md": "# lp\n", "src/a.ts": "a1\n", "src/b.ts": "b1\n" } });
	t.after(() => repo.cleanup());
	const calls: string[][] = [];
	return {
		repo,
		calls,
		job(id) {
			git(repo.path, "fetch", "--quiet", "origin");
			const path = join(dirname(repo.path), `wt-${id}`);
			git(repo.path, "worktree", "add", "--quiet", "--no-track", "-b", id, path, "origin/main");
			return path;
		},
		run: async (cwd, args, options) => {
			calls.push([...args]);
			assert.ok(!MUTATING.has(args[0] as string), `the proof never runs git ${args[0]}`);
			if (args[0] === "fetch") assert.ok(args.slice(1).every((arg) => !arg.includes(":")), "a fetch names an exact sha, never a ref destination");
			return defaultGit(cwd, args, options);
		},
	};
}

function commit(worktree: string, files: Record<string, string | null>, message = "work"): string {
	for (const [path, content] of Object.entries(files)) {
		const target = join(worktree, path);
		if (content === null) unlinkSync(target);
		else {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
	}
	git(worktree, "add", "-A");
	git(worktree, "commit", "--quiet", "-m", message);
	return git(worktree, "rev-parse", "HEAD");
}

/** Push the job branch, as a worker would. */
function push(worktree: string, id: string): void {
	git(worktree, "push", "--quiet", "origin", id);
}

const landed = (proof: LandingProof) => (proof.result === "landed" ? proof.evidence : assert.fail(`expected landed, got ${JSON.stringify(proof)}`));

test("unknown: missing inputs, broken commands, odd history and every budget keep the lease", { timeout: 120_000 }, async (t) => {
	const b = benchOf(t);
	const job = b.job("cp-unknown");
	commit(job, { "src/a.ts": "u1\n" });
	const head = commit(job, { "src/b.ts": "u2\n" });
	push(job, "cp-unknown");
	squashMergeAndDeleteHead(b.repo, "cp-unknown");
	advanceBase(b.repo, "src/a.ts", "later\n");
	advanceBase(b.repo, "docs/x.md", "# x\n");
	const bent = (bend: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string } | undefined): GitRun =>
		async (cwd, args) => bend(args) ?? b.run(cwd, args);
	const unknown = async (label: string, proof: Promise<LandingProof>, detail: RegExp) => {
		const result = await proof;
		assert.equal(result.result, "unknown", `${label}: ${JSON.stringify(result)}`);
		assert.match(result.result === "unknown" ? result.detail : "", detail, label);
	};
	await unknown("absent base", readLandingProof(b.run, job, head, "no-such-base"), /advertises no no-such-base/);
	await unknown("origin unreachable", readLandingProof(bent((a) => (a[0] === "ls-remote" ? { status: 128, stdout: "", stderr: "fatal: unreachable" } : undefined)), job, head, "main"), /could not be asked/);
	await unknown("object unavailable", readLandingProof(bent((a) => (a[0] === "fetch" ? { status: 128, stdout: "", stderr: "no" } : a[0] === "cat-file" ? { status: 1, stdout: "", stderr: "" } : undefined)), job, head, "main"), /could not be fetched/);
	await unknown("command failure", readLandingProof(bent((a) => (a[0] === "merge-base" ? { status: 128, stdout: "", stderr: "fatal: bad object" } : undefined)), job, head, "main"), /git merge-base failed/);
	await unknown("shallow", readLandingProof(bent((a) => (a[0] === "rev-parse" && a[1] === "--is-shallow-repository" ? { status: 0, stdout: "true\n", stderr: "" } : undefined)), job, head, "main"), /shallow/);
	await unknown("ambiguous fork", readLandingProof(bent((a) => (a[0] === "merge-base" && a[1] === "--all" ? { status: 0, stdout: `${"a".repeat(40)}\n${"b".repeat(40)}\n`, stderr: "" } : undefined)), job, head, "main"), /2 merge bases/);
	await unknown("path cap", readLandingProof(b.run, job, head, "main", { limits: { paths: 1 } }), /over the 1-path limit/);
	await unknown("candidate cap", readLandingProof(b.run, job, head, "main", { limits: { candidates: 2 } }), /search limit/);
	await unknown("output cap", readLandingProof(b.run, job, head, "main", { limits: { outputBytes: 10 } }), /output exceeded/);
	let now = 0;
	// Ticks of 10 s against a 25 s local budget: the third local command is over it. The remote phase does not count.
	await unknown("time cap", readLandingProof(b.run, job, head, "main", { limits: { commandMs: 25_000 }, clock: () => (now += 10_000) }), /25000 ms budget/);
	// A hung command is cut off by the runner timeout, remote and local alike, and reads as unknown.
	const hung = (verb: string): GitRun => async (cwd, args, options) => (args[0] === verb ? new Promise(() => {}) : b.run(cwd, args, options));
	await unknown("hung ls-remote", readLandingProof(hung("ls-remote"), job, head, "main", { limits: { fetchMs: 50 } }), /timed out after 50 ms/);
	await unknown("hung local command", readLandingProof(hung("merge-base"), job, head, "main", { limits: { commandMs: 200 } }), /git merge-base failed \(timed out after \d+ ms\)/);
	const asked: Array<number | undefined> = [];
	const recorded: GitRun = async (cwd, args, options) => {
		asked.push(options?.timeoutMs);
		return b.run(cwd, args, options);
	};
	await readLandingProof(recorded, job, head, "main");
	assert.equal(asked[0], 30_000, "ls-remote runs under the 30 s remote timeout");
	assert.ok(asked.slice(1).every((ms) => ms !== undefined && ms <= 30_000), "every command carries a timeout for its runner to kill on");
	assert.equal(landed(await readLandingProof(b.run, job, head, "main")).method, "path_tree", "the same job lands with the default limits");

	// A job whose commits cancel out has no content to find.
	const noop = b.job("cp-noop");
	commit(noop, { "src/a.ts": "tmp\n" });
	const noopHead = commit(noop, { "src/a.ts": "later\n" });
	advanceBase(b.repo, "docs/y.md", "# y\n");
	await unknown("zero aggregate diff", readLandingProof(b.run, noop, noopHead, "main"), /changes nothing/);
});

test("defaultGit kills a git that outlives its timeout and answers status null", async () => {
	const started = Date.now();
	// The alias's sleep writes nowhere, so the killed git's pipes close at once.
	const result = await defaultGit(tmpdir(), ["-c", "alias.hang=!sleep 2 >/dev/null 2>&1 </dev/null", "hang"], { timeoutMs: 100 });
	assert.equal(result.status, null);
	assert.match(result.stderr, /git -c timed out after 100 ms/);
	assert.ok(Date.now() - started < 1_500, "the caller is not held for the child's whole life");
});

test("the pre-release recheck refuses a proof whose HEAD moved or whose tree went dirty", { timeout: 60_000 }, async (t) => {
	const b = benchOf(t);
	const job = b.job("cp-race");
	const head = commit(job, { "src/a.ts": "r1\n" });
	push(job, "cp-race");
	squashMergeAndDeleteHead(b.repo, "cp-race");
	const evidence = landed(await readLandingProof(b.run, job, head, "main"));
	assert.equal(await landingMoved(b.run, job, evidence), undefined, "unchanged: the proof still describes the worktree");
	writeFileSync(join(job, "late.txt"), "late\n");
	assert.equal((await landingMoved(b.run, job, evidence))?.code, "landing_unverified", "a dirty tree after the proof keeps the lease");
	commit(job, {}, "late commit");
	assert.equal((await landingMoved(b.run, job, evidence))?.code, "landing_unverified", "a moved HEAD keeps the lease");
});
