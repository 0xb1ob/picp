# S11b replayed S10 controls

## cp-1fmp continuation

Fresh consumer baselines and S09 controls (`cp-1fmp-continuation.md`, since removed) and
fresh S10 controls (`cp-1fmp-S10.md`, since removed) preserved exact patches, fail/restored logs and hashes.
Original coverage remains intact; these runs earn preparation credit only. The deletion candidate exceeds
280,000 bytes before completion of the required proof. The parent approved PR502 as evidence only and
assigned all remaining proof and retirement acceptance to `cp-dpmo`.
Historical evidence and missing-log notices below remain unchanged.

## Fresh stage2 proof (PR500)

The new [proof increments](../../.s11b-stage2/README.md) record S11-C01–C29 and S09-NC01 exact isolated patches,
SHA256s, named consumer failures and restored passes on the recorded execution HEADs
against main `2ca3ed5f2e31af2cd08763e398bdc9a67ffc7fbd`. It also includes the executable TypeScript AST
source-slice comparison: all 12 retained calls match original identities byte for byte (144/12 static calls).
This is fresh proof; the historical patches and missing-log notices below remain unchanged. Remaining matrix
controls are still required before retirement. The original suite remains intact.

Each patch was executed alone through its existing public consumer scenario, failed with AssertionError, and was restored. Selectors and original declaration mappings are in ../testing-migration-s10.md. These final-base patches account for line shifts and the added unreadable-status guard; the dirty-only control does not replace S10b’s separate unreadable-status control, which remains for the follow-up.

## S10-dirty

SHA-256: `c6e1a67ed875195ab573433efb861e45872219c0da4fc52535542403d1c182db`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: dirty: reset requires proof     actual: [ [ 'reset', '--hard', '38b86d59e2b4de03e29ec91eeb04c88dd1fc3d65' ] ],     expected: [],

<!-- control:S11b-S10-dirty -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..e921e67 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1447,7 +1447,7 @@ export class Integrator {
 		}
 		const dirty = await this.#run(worktree, "git", ["status", "--porcelain"]);
 		if ((bad = unread(dirty, "could not read the worktree status (git status)", true))) return bad;
-		if (dirty.stdout.trim().length > 0) {
+		if (false) {
 			return {
 				acted: false,
 				failed: true,
```
<!-- /control:S11b-S10-dirty -->

## S10-sync-guards

SHA-256: `3aa88e2a5db413dde9f247cc02526f1732df056a9ff1299eddd1508228104c0e`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: The input did not match the regular expression /worktree reset to/. Input:     actual: 'gh: https://github.com/example/demo/pull/910 is MERGED at 2684334f8f20\nreceipt written: .pi-command-post/state/runs/cp-b7t3/merge.json\nunchecked synchronization\nteardown passed: pushed\ndeleted origin/cp-b7t3\njob cp-b7t3 closed: merged: https://github.com/example/demo/pull/910\ncp-b7t3 integrated: https://github.com/example/demo/pull/910 merged as 9a6925c2158c, receipt recorded, lease returned, head deleted, job closed.',     expected: /worktree reset to/,   AssertionError [ERR_ASSERTION]: The input did not match the regular expression /worktree reset to/. Input:     actual: 'gh: https://github.com/example/demo/pull/910 is MERGED at 78bba0e29259\nreceipt written: .pi-command-post/state/runs/cp-yncw/merge.json\nunchecked synchronization\nteardown passed: pushed\ndeleted origin/cp-yncw\njob cp-yncw closed: merged: https://github.com/example/demo/pull/910\ncp-yncw integrated: https://github.com/example/demo/pull/910 merged as 9d6f57f88c54, receipt recorded, lease returned, head deleted, job closed.',     expected: /worktree reset to/,   AssertionError [ERR_ASSERTION]: dirty: reset requires proof     actual: [ [ 'reset', '--hard', 'bdaaf0aa16eb0dc32b1c13cd5ce06ba3c1729f22' ] ],     expected: [],

<!-- control:S11b-S10-sync-guards -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..cf39a01 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1424,6 +1424,9 @@ export class Integrator {
 		base: string;
 	}): Promise<{ acted: boolean; failed: boolean; detail: string }> {
 		const { jobId, worktree, branch, base } = input;
+		const unsafeRemote = (await this.#run(worktree, "git", ["ls-remote", "--heads", "origin", branch])).stdout.trim().split(/\s+/)[0] ?? "";
+		await this.#run(worktree, "git", ["reset", "--hard", unsafeRemote]);
+		return { acted: true, failed: false, detail: "unchecked synchronization" };
 		const fetched = await this.#run(worktree, "git", ["fetch", "origin", branch]);
 		if (fetched.status !== 0) {
 			return { acted: false, failed: false, detail: `could not fetch origin/${branch} in the worktree` };
```
<!-- /control:S11b-S10-sync-guards -->

## S10-sync-reset

SHA-256: `f6d560428677d4f5a679121e9eb5be5d372672ace933981d2be831f2c077dda4`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: behind: reset requires proof     actual: [],     expected: [ [ 'reset', '--hard', '135e8d0e4b8b2492c315d35065d94f02816fb06e' ] ],   AssertionError [ERR_ASSERTION]: stale: reset requires proof     actual: [],     expected: [ [ 'reset', '--hard', '0e622bdd2953476b58d21e602a5da9fcaf68e64e' ] ],   AssertionError [ERR_ASSERTION]: absorbed: reset requires proof     actual: [],     expected: [ [ 'reset', '--hard', '421bbad9a39dffca98c9aed8ffb726d97da99330' ] ],

<!-- control:S11b-S10-sync-reset -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..8a6c5ea 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1510,7 +1510,7 @@ export class Integrator {
 		// (`remote.sha === head`, src/teardown.ts) is the same fact. Resetting to the
 		// ref would also fail outright in a clone whose refspec does not fetch this
 		// branch (`--single-branch`, `--depth`), where `ls-remote` answers fine.
-		const reset = await this.#run(worktree, "git", ["reset", "--hard", remote]);
+		const reset = await this.#run(worktree, "git", ["status", "--porcelain"]);
 		if (reset.status !== 0) {
 			return { acted: false, failed: true, detail: firstLine(reset) };
 		}
```
<!-- /control:S11b-S10-sync-reset -->

## S10-rescue-target

SHA-256: `10a08018762ea0e38c76ae5261f4e48259e9b8d01c842e428bafae4b0a89efab`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:     actual: '8cf23a1821a6ae7ab7aa4aa3b0d17bc948b3eb29',     expected: 'd1af37aec249f791669b0ae47c39fe0e94d8ceda',

<!-- control:S11b-S10-rescue-target -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..fdf2505 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1611,7 +1611,7 @@ export class Integrator {
 		// `:` is not legal in a ref name, so the timestamp is dashed.
 		const stamp = isoTimestamp(this.#now()).replaceAll(":", "-");
 		const ref = `${SALVAGE_REF_PREFIX}${jobId}/${stamp}`;
-		const written = await this.#run(worktree, "git", ["update-ref", ref, head]);
+		const written = await this.#run(worktree, "git", ["update-ref", ref, `${head}~1`]);
 		if (written.status !== 0) return { why: firstLine(written) };
 		return { ref };
 	}
```
<!-- /control:S11b-S10-rescue-target -->

## S10-proof-skip

SHA-256: `b2a5f6fbdd61212558df8cc6ca69a3dfecc8c0968d94e467377553b88df6a407`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: behind: reset requires proof     actual: [],     expected: [ [ 'reset', '--hard', '820cf62ef36d5329b3cc0ba7c0eb8dcfc1d35d2f' ] ],   AssertionError [ERR_ASSERTION]: stale: reset requires proof     actual: [],     expected: [ [ 'reset', '--hard', '5c39a5c126d1c50fcaa7ef0e428b57310c873750' ] ],

<!-- control:S11b-S10-proof-skip -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..bb6e953 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1470,7 +1470,7 @@ export class Integrator {
 			};
 		}
 		let absorbed = "";
-		if (count > 0) {
+		if (count >= 0) {
 			// The only path on which this function discards a commit. It runs the
 			// proof the parent used to run by hand, and every one of its steps fails
 			// closed: an unreadable base, a missing merge base, a diff that will not
```
<!-- /control:S11b-S10-proof-skip -->

## S10-prune

SHA-256: `4ee6658e17dac23179394a00e3d2d17a56a2a326bdb2fc50dce17f2c208ea3f6`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:     actual: [ 'refs/cp-salvage/cp-old/001', 'refs/cp-salvage/cp-old/999' ],     expected: [ 'refs/cp-salvage/cp-old/999' ],   AssertionError [ERR_ASSERTION]: The input did not match the regular expression /origin did not name a tip/. Input:     actual: 'gh: https://github.com/example/demo/pull/911 is MERGED at 2492c8bdc279\nreceipt written: .pi-command-post/state/runs/cp-lsof/merge.json\nteardown passed: pushed\ndeleted origin/cp-lsof\njob cp-lsof closed: merged: https://github.com/example/demo/pull/911\nrescue ref cleanup unavailable\ncp-lsof integrated: https://github.com/example/demo/pull/911 merged as d1f8962eeca3, receipt recorded, lease returned, head deleted, job closed.',     expected: /origin did not name a tip/,   AssertionError [ERR_ASSERTION]: The input did not match the regular expression /origin did not name a tip/. Input:     actual: 'gh: https://github.com/example/demo/pull/911 is MERGED at f27f4d7cf936\nreceipt written: .pi-command-post/state/runs/cp-fh2c/merge.json\nteardown passed: pushed\ndeleted origin/cp-fh2c\njob cp-fh2c closed: merged: https://github.com/example/demo/pull/911\nrescue ref cleanup unavailable\ncp-fh2c integrated: https://github.com/example/demo/pull/911 merged as caf24d2e0841, receipt recorded, lease returned, head deleted, job closed.',     expected: /origin did not name a tip/,

<!-- control:S11b-S10-prune -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..9b8421d 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1625,6 +1625,7 @@ export class Integrator {
 	 */
 	async #pruneSalvageRefs(input: { cwd: string; base: string; jobId: string }): Promise<string[]> {
 		const { cwd, base, jobId } = input;
+		return ["rescue ref cleanup unavailable"];
 		// `--sort=refname` is not cosmetic: the bound below is a slice, so the
 		// listing has to be deterministic for "the remainder is examined next time"
 		// to mean anything. Refname order is `<job-id>/<utc>`, which is stable across
```
<!-- /control:S11b-S10-prune -->

## S10-ref-scope

SHA-256: `b79de19991a354c6ae457a497bb1af7909c76d71772578c24e953e5583cc0032`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: cleanup must preserve main     actual: [ 128, 'refs/heads/main' ],     expected: [ 0, '425a329acc4239bbf2599f07b45fa436accb4d82' ],

<!-- control:S11b-S10-ref-scope -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..79b0820 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1646,7 +1646,7 @@ export class Integrator {
 				const [ref, objectName] = line.split(/\s+/);
 				return { ref: ref ?? "", sha: hexSha(objectName) };
 			})
-			.filter((entry): entry is { ref: string; sha: string } => isSalvageRef(entry.ref) && entry.sha !== undefined);
+			.filter((entry): entry is { ref: string; sha: string } => entry.sha !== undefined);
 		if (all.length === 0) return [];
 		// A bound on the work, never on the retention: the overflow is kept, and
 		// because the listing is sorted by refname it is the same remainder the next
```
<!-- /control:S11b-S10-ref-scope -->

## S10-prune-safety

SHA-256: `2573b859574756a3119f273ffc5fbae56e5f74fb245eb699b0b597026969bf27`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:     actual: [],     expected: [ 'refs/cp-salvage/cp-old/999' ],   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:     actual: [],     expected: [ 'refs/cp-salvage/cp-old/001' ],   AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:     actual: [],     expected: [ 'refs/cp-salvage/cp-old/001' ],

<!-- control:S11b-S10-prune-safety -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..59abd77 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -1651,14 +1651,14 @@ export class Integrator {
 		// A bound on the work, never on the retention: the overflow is kept, and
 		// because the listing is sorted by refname it is the same remainder the next
 		// integration examines — first, and minus whatever it prunes.
-		const refs = all.slice(0, SALVAGE_PRUNE_MAX);
+		const refs = all;
 		const overflow = all.length - refs.length;
 
 		// The base tip, from origin itself. An unreadable answer keeps everything —
 		// the same fail-closed shape as the proof that wrote these refs.
 		const tip = await this.#run(cwd, "git", ["ls-remote", "--heads", "origin", base]);
-		const baseTip = hexSha(tip.stdout.trim().split(/\s+/)[0] ?? "");
-		if (tip.status !== 0 || !baseTip) {
+		const baseTip = hexSha(tip.stdout.trim().split(/\s+/)[0] ?? "") ?? all[0]!.sha;
+		if (false) {
 			return [
 				`${all.length} rescue ref(s) kept — origin did not name a tip for ${base}, so nothing under ` +
 					`${SALVAGE_REF_PREFIX} could be proven reachable and nothing was deleted`,
@@ -1667,7 +1667,7 @@ export class Integrator {
 		// The tip's objects have to be here for `merge-base` to answer; fetched after
 		// ls-remote, for the same reason the proof does it in that order.
 		const fetched = await this.#run(cwd, "git", ["fetch", "origin", base]);
-		if (fetched.status !== 0) {
+		if (false) {
 			return [
 				`${all.length} rescue ref(s) kept — ${base} could not be fetched from origin (${firstLine(fetched)}), ` +
 					"so reachability could not be established",
@@ -1678,11 +1678,11 @@ export class Integrator {
 		const kept: string[] = [];
 		for (const { ref, sha } of refs) {
 			const reachable = await this.#run(cwd, "git", ["merge-base", "--is-ancestor", sha, baseTip]);
-			if (reachable.status === 1) {
+			if (false) {
 				kept.push(`${ref} (${sha.slice(0, 12)} is not reachable from ${base})`);
 				continue;
 			}
-			if (reachable.status !== 0) {
+			if (false) {
 				kept.push(`${ref} (reachability could not be read: ${firstLine(reachable)})`);
 				continue;
 			}
```
<!-- /control:S11b-S10-prune-safety -->

## S10-review-gate

SHA-256: `8aff31cae799653efd8ce7e54327a6713d4b7ec7b8b06045c9155ffd984abf14`; exit 1. Observed assertion:   AssertionError [ERR_ASSERTION]: gh: https://github.com/example/demo/pull/912 is OPEN at a14a7be0ef48     actual: 'advance',     expected: 'review',   AssertionError [ERR_ASSERTION]: gh: https://github.com/example/demo/pull/912 is OPEN at ed68cf67254a     actual: 'advance',     expected: 'review',   AssertionError [ERR_ASSERTION]: gh: https://github.com/example/demo/pull/912 is OPEN at 0ce80e6af8af     actual: 'advance',     expected: 'review',

<!-- control:S11b-S10-review-gate -->
```diff
diff --git a/src/integrate.ts b/src/integrate.ts
index 3d556ee..7a2aea0 100644
--- a/src/integrate.ts
+++ b/src/integrate.ts
@@ -799,6 +799,7 @@ export class Integrator {
 		head: string;
 	}): Promise<IntegrateResult | undefined> {
 		const { jobId, branch, facts, prUrl, head } = input;
+		return undefined;
 		if (readReviewPassVerdict(this.#options.home, jobId, head)) return undefined;
 		if (this.#flaggedDiffAuthorized(jobId, head)) return undefined;
 		const short = head.slice(0, 12);
```
<!-- /control:S11b-S10-review-gate -->
