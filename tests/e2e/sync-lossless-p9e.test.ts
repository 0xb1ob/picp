/** Behavior 11, P9e: cp_integrate's worktree sync, against real git in the 2026-09-01 shape (cp-8vf6). */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "../harness/index.ts";
import { writeWindowPass } from "../harness/review-window.ts";
import { landOnOrigin, run, SKIP, startStack } from "./landing-helpers.ts";

const appFile = (marker: string) => `seq 1 30 | sed 's/^25$/25 ${marker}/;s/^/line /' > src/app.txt`;

// P9e-sync: the lease holds the branch's pre-rebase head, origin's branch was rebased over base churn that shifts every
// hunk header, and the merge is a squash. Only an equal cumulative patch-id licenses the reset; unpushed text or binary
// work, or a hand-resolved rebase, refuses and leaves the lease exactly as it was.
test("P9e-sync: a squash-merged rebased branch resets its lease with a rescue ref, and any unproven work refuses", { skip: SKIP, timeout: 600_000 }, async (t) => {
	for (const mode of ["absorbed", "unpushed", "binary", "conflict"] as const) await t.test(mode, async (t) => {
		const s = await startStack(t);
		landOnOrigin(s.repo, `mkdir -p src && ${appFile("original")}`, "base: a 30-line file");
		const live = await s.held(`P9e sync ${mode}`, 912, {
			command: (branch) => `git fetch -q origin main && git merge -q --ff-only origin/main && ${appFile("branch step one")} && git commit -qam one && ` +
				`${appFile("branch step two")} && git commit -qam two && git push -q -u origin ${branch}`,
		});
		landOnOrigin(s.repo, "{ printf 'added %s\\n' a b c d e; cat src/app.txt; } > shifted && mv shifted src/app.txt", "base: churn above the hunk");
		const replay = mkdtempSync(join(tmpdir(), "cp-replay-"));
		t.after(() => rmSync(replay, { recursive: true, force: true }));
		git(replay, "clone", "--quiet", s.remote, "work");
		const work = join(replay, "work");
		git(work, "checkout", "--quiet", "-B", "replay", `origin/${live.jobId}`);
		if (mode === "conflict") {
			git(work, "reset", "--quiet", "--hard", "origin/main");
			writeFileSync(join(work, "src/app.txt"), readFileSync(join(work, "src/app.txt"), "utf8").replace("line 25 original", "line 25 resolved by hand"));
			git(work, "commit", "--quiet", "-am", "rebased with a hand-resolved conflict");
		} else git(work, "rebase", "--quiet", "origin/main");
		git(work, "push", "--quiet", "--force", "origin", `replay:${live.jobId}`);
		const rebased = git(work, "rev-parse", "HEAD");
		if (mode === "unpushed") writeFileSync(join(live.worktree, "src/unpushed.txt"), "work that exists nowhere else\n");
		if (mode === "binary") writeFileSync(join(live.worktree, "src/blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]));
		if (mode === "unpushed" || mode === "binary") {
			git(live.worktree, "add", "-A");
			git(live.worktree, "commit", "--quiet", "-m", "wip: not pushed anywhere");
		}
		const local = git(live.worktree, "rev-parse", "HEAD");
		writeWindowPass(s.home, live.jobId, rebased, "2026-01-01T00:00:00Z");
		s.setGh({ integration: true, runs: [run(912, rebased, "completed", "success")] });
		let result = await s.integrate(live.jobId);
		for (let step = 0; step < 8 && result.record.next === "advance"; step++) result = await s.integrate(live.jobId);
		const clone = s.post.registry.pathOf("demo");
		const rescues = git(clone, "for-each-ref", "--format=%(refname) %(objectname)", "refs/cp-salvage/");
		if (mode === "absorbed") {
			assert.equal(result.record.next, "done", result.text);
			assert.match(result.text, new RegExp(`worktree reset to ${rebased.slice(0, 12)}, the sha origin names for ${live.jobId}`));
			assert.match(rescues, new RegExp(`^refs/cp-salvage/${live.jobId}/\\S+ ${local}$`), "the discarded head is kept in the shared clone");
			assert.match(result.text, /2 pre-rebase commit\(s\) were discarded/);
			assert.match(result.text, new RegExp(`kept at refs/cp-salvage/${live.jobId}/`));
			return;
		}
		assert.equal(result.record.next, "surface", result.text);
		assert.equal(result.record.step, "sync");
		assert.equal(git(live.worktree, "rev-parse", "HEAD"), local, "the work survives: no reset was issued");
		assert.equal(rescues, "", "nothing was salvaged because nothing was discarded");
		if (mode === "unpushed") assert.equal(readFileSync(join(live.worktree, "src/unpushed.txt"), "utf8"), "work that exists nowhere else\n");
		if (mode === "binary") assert.ok(existsSync(join(live.worktree, "src/blob.bin")));
		assert.match(result.text, mode === "conflict" ? /is not the one origin's tip carries/ : /could not be proven to be already in main/);
		if (mode === "unpushed") assert.match(result.text, /fix it in place rather than reaching for force/);
	});
});
