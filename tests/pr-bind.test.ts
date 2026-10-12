/**
 * picp-d0p: `cp_dispatch pr` binds a ship/pr job to an existing PR. Every refusal names
 * its cause, and the checkout of the PR head in a leased worktree loses nothing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { FleetRecord } from "../src/contracts.ts";
import { DispatchError, type GitRunner } from "../src/dispatch.ts";
import type { CommandRunner } from "../src/merge-ask.ts";
import { assertBranchFree, type BoundPrFacts, boundPrNote, checkoutBoundBranch, parsePrRef, readBoundPr } from "../src/pr-bind.ts";
import { createScratchRepo, type ScratchRepo } from "./harness/scratch-repo.ts";

const OWNER_REPO = "acme/widgets";
const URL = "https://github.com/acme/widgets/pull/169";
const SHA = "9f1c2e3a4b5c6d7e8f90a1b2c3d4e5f60718293a";
const OPEN = { number: 169, url: URL, state: "OPEN", isDraft: true, isCrossRepository: false, headRefName: "cp-b55w", headRefOid: SHA, baseRefName: "main" };

const gh = (row: Record<string, unknown>, calls: string[][] = []): CommandRunner => async (command, args) => {
	calls.push([command, ...args]);
	return JSON.stringify(row);
};
const read = (exec: CommandRunner, ref = "169") => readBoundPr({ ref, project: "demo", clone: "/tmp", base: "main", ownerRepo: OWNER_REPO, exec });

test("an open same-repo PR on the default base binds, by number or url", async () => {
	const calls: string[][] = [];
	const facts = await read(gh(OPEN, calls), URL);
	assert.deepEqual(facts, { number: 169, url: URL, draft: true, head: "cp-b55w", headSha: SHA, base: "main" });
	assert.deepEqual(calls[0]?.slice(0, 6), ["gh", "pr", "view", "169", "--repo", OWNER_REPO]);
	assert.deepEqual(parsePrRef("#169", OWNER_REPO), { number: 169 });
	assert.deepEqual(parsePrRef("https://github.com/ACME/Widgets/pull/7", OWNER_REPO), { number: 7 });
});

test("every unsafe PR is refused with a DispatchError naming the cause", async () => {
	const cases: Array<[string, Promise<BoundPrFacts>, RegExp]> = [
		["merged", read(gh({ ...OPEN, state: "MERGED" })), /is MERGED/],
		["closed", read(gh({ ...OPEN, state: "CLOSED" })), /is CLOSED/],
		["fork", read(gh({ ...OPEN, isCrossRepository: true })), /from a fork.*push the fork branch to origin/],
		["stacked", read(gh({ ...OPEN, baseRefName: "release" })), /targets release, not the project's default base main/],
		["other repo", read(gh(OPEN), "https://github.com/other/widgets/pull/169"), /names other\/widgets.*origin remote is acme\/widgets/],
		["gh down", read(async () => Promise.reject(new Error("gh: command not found"))), /gh could not read acme\/widgets#169 \(gh: command not found\)/],
		["unparseable", read(async () => "not json"), /not a readable PR/],
		["no github origin", readBoundPr({ ref: "169", project: "demo", clone: "/tmp", base: "main", ownerRepo: undefined, exec: gh(OPEN) }), /no GitHub origin remote/],
	];
	for (const [name, promise, pattern] of cases) {
		await assert.rejects(promise, (error: unknown) => error instanceof DispatchError && pattern.test(error.message), name);
	}
});

test("assertBranchFree refuses a held or failed holder and allows a done one", () => {
	const holder = (phase: FleetRecord["phase"]) => ({ job_id: "cp-b55w", phase, branch: "cp-b55w" }) as FleetRecord;
	assert.throws(() => assertBranchFree([holder("held")], "cp-new", "cp-b55w"), /job cp-b55w \(held\) holds it — promote that job \(cp_send cp-b55w\)/);
	assert.throws(() => assertBranchFree([holder("failed")], "cp-new", "cp-b55w"), DispatchError);
	assertBranchFree([holder("done")], "cp-new", "cp-b55w");
	assertBranchFree([{ ...holder("failed"), job_id: "cp-new" }], "cp-new", "cp-b55w"); // its own earlier record
});

test("the bound note forbids history rewrite: merge the base, fast-forward push only", () => {
	const note = boundPrNote({ number: 169, url: URL, draft: false, head: "cp-b55w", headSha: SHA, base: "main" });
	assert.match(note, /Bound to https:\/\/github\.com\/acme\/widgets\/pull\/169 \(open\), head cp-b55w at 9f1c2e3a4b5c, base main/);
	assert.match(note, /do not open a PR/);
	assert.match(note, /merging origin\/main into it, never by rebase/);
	assert.match(note, /push fast-forward only/);
	assert.match(note, /never rewrite or drop existing commits/);
});

// --- checkoutBoundBranch on a real scratch clone ------------------------------------

const git: GitRunner = async (cwd, args) => {
	try {
		return { status: 0, stdout: execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
	} catch (error) {
		return { status: 1, stdout: "", stderr: String((error as { stderr?: unknown }).stderr ?? error) };
	}
};

/** A clone whose origin has `feat` at c2 (c1 before it), plus a detached leased worktree. */
function bench(t: { after(fn: () => void): void }): { repo: ScratchRepo; wt: string; c1: string; c2: string } {
	const repo = createScratchRepo();
	t.after(() => repo.cleanup());
	repo.git("switch", "--quiet", "-c", "feat");
	repo.write("a.txt", "1\n");
	const c1 = repo.commitAll("c1");
	repo.write("a.txt", "2\n");
	const c2 = repo.commitAll("c2");
	repo.git("push", "--quiet", "origin", "feat");
	repo.git("switch", "--quiet", "main");
	const wt = join(dirname(repo.path), "slot");
	repo.git("worktree", "add", "--quiet", "--detach", wt, "main");
	return { repo, wt, c1, c2 };
}
const checkout = (wt: string, headSha: string) => checkoutBoundBranch({ git, worktree: wt, jobId: "cp-pr169", head: "feat", headSha, now: new Date("2025-01-02T03:04:05Z") });

test("absent local branch: created tracking origin, HEAD at the PR head", async (t) => {
	const { repo, wt, c2 } = bench(t);
	repo.git("branch", "-D", "feat");
	assert.deepEqual(await checkout(wt, c2), {});
	assert.equal(repo.gitIn(wt, "rev-parse", "HEAD"), c2);
	assert.equal(repo.gitIn(wt, "rev-parse", "--abbrev-ref", "HEAD"), "feat");
	assert.equal(repo.gitIn(wt, "rev-parse", "--abbrev-ref", "feat@{upstream}"), "origin/feat");
});

test("local branch behind origin: fast-forwarded", async (t) => {
	const { repo, wt, c1, c2 } = bench(t);
	repo.git("branch", "-f", "feat", c1);
	assert.deepEqual(await checkout(wt, c2), {});
	assert.equal(repo.head("refs/heads/feat"), c2);
});

test("diverged local branch: kept on a salvage ref, then reset to origin", async (t) => {
	const { repo, wt, c1, c2 } = bench(t);
	repo.git("switch", "--quiet", "-C", "feat", c1);
	repo.write("b.txt", "local only\n");
	const local = repo.commitAll("local only");
	repo.git("switch", "--quiet", "main");
	const result = await checkout(wt, c2);
	assert.equal(result.salvaged, "refs/cp-salvage/cp-pr169/2025-01-02T03-04-05Z");
	assert.equal(repo.head(result.salvaged), local, "the diverged commit is kept");
	assert.equal(repo.head("refs/heads/feat"), c2);
});

test("a branch checked out in another worktree is refused", async (t) => {
	const { repo, wt, c2 } = bench(t);
	repo.git("worktree", "add", "--quiet", join(dirname(repo.path), "other"), "feat");
	await assert.rejects(checkout(wt, c2), /checked out in another worktree/);
});

test("HEAD not at the PR's headRefOid is refused", async (t) => {
	const { wt, c1 } = bench(t);
	await assert.rejects(checkout(wt, c1), /not the PR head .* the PR moved while dispatching/);
});
