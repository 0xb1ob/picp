# S11b replayed S10 controls

## cp-1fmp continuation

Fresh consumer baselines and S09 controls (`cp-1fmp-continuation.md`, since removed) and
fresh S10 controls (`cp-1fmp-S10.md`, since removed) were executed with failing and restored runs.
Original coverage remains intact; these runs earn preparation credit only. The deletion candidate exceeds
280,000 bytes before completion of the required proof. The parent approved PR502 as evidence only and
assigned all remaining proof and retirement acceptance to `cp-dpmo`.

## Fresh stage2 proof (PR500)

The new proof increments (`.s11b-stage2/README.md`, since removed) record S11-C01–C29 and S09-NC01 isolated
mutations, named consumer failures and restored passes on the recorded execution heads. It also includes the
executable TypeScript AST source-slice comparison: all 12 retained calls match original identities byte for byte
(144/12 static calls). This is fresh proof. Remaining matrix controls are still required before retirement.
The original suite remains intact.

Each mutation was executed alone through its existing public consumer scenario, failed with AssertionError, and was restored. Selectors and original declaration mappings are in ../testing-migration-s10.md. These final-base mutations account for line shifts and the added unreadable-status guard; the dirty-only control does not replace S10b’s separate unreadable-status control, which remains for the follow-up.

| Control | Bug patched back in `src/integrate.ts` | Observed failure (exit 1) |
|---|---|---|
| S10-dirty | the worktree-sync dirty check never fires, so a dirty worktree is synchronized | `dirty: reset requires proof`: a hard reset ran where none was expected |
| S10-sync-guards | worktree sync resets straight to the remote branch tip, skipping every guard | the integrate output lacks `worktree reset to`; the dirty case resets without proof |
| S10-sync-reset | the sync's `git reset --hard` is replaced by `git status` | behind, stale and absorbed cases: the expected hard reset never ran |
| S10-rescue-target | the rescue ref is written at the head's parent instead of the head | strict equality fails: the rescue ref names the wrong commit |
| S10-proof-skip | the absorption proof runs even when no commit would be discarded | behind and stale cases: the expected hard reset never ran |
| S10-prune | rescue-ref pruning always answers "cleanup unavailable" | stale rescue ref is kept; output lacks `origin did not name a tip` |
| S10-ref-scope | pruning considers every ref, not only salvage refs | `cleanup must preserve main`: main is deleted |
| S10-prune-safety | pruning drops its bound, its base-tip and fetch guards, and its reachability checks | three deep-equal checks fail: an expected kept rescue ref is missing (empty list) |
| S10-review-gate | the review gate always lets the head through | three cases advance instead of returning `review` |
