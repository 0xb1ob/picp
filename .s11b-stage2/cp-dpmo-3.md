# cp-dpmo increment 3 — complete S10 matrix

Execution HEAD `2dff83fef6feed3e6251a109cfa9a91491efcf99`, base `aef9518a924ddd2bcab69bf3a8ca9fdd7ca05e19`.
All 25 listed S10 controls now have fresh independent production mutants, named consumer AssertionError failures (exit 1), and identical-command restored passes (exit 0), zero skips. Originals intact, no retirement credit. Typecheck passed after final restoration.

Use `npm run test:one -- --test-name-pattern='<selector>' tests/e2e/<file>.test.ts` for rows with selectors;
rows with selector `ALL` used `npm run test:one -- tests/e2e/<file>.test.ts` without a selector. Both commands in each pair are identical.

| Control | Selector | File | Required failure observed |
|---|---|---|---|
| conflict-head | landing S09:.*real repair | landing-s09 | moved conflict head surfaces instead of resolve |
| repair-exhaustion | landing S09:.*real repair | landing-s09 | completed red/conflict repair resolves instead of surface |
| prune-safety | landing S10:.*rescue | landing-merge | retained reference set deepEqual |
| review-pass | landing S10:.*review evidence | landing-merge | pass/equivalent/approved review instead of advance |
| ci-refusal | landing S10:.*unreadable forge | landing-merge | unreadable Actions advance instead of retry |
| cleanup-retry | landing S10:.*cleanup failures | landing-merge | delete/close wait instead of retry |
| s08-head | ALL | landing-review-window | false/head and true/head |
| s08-ci | ALL | landing-review-window | false/ci and true/ci |
| s08-permission | ALL | landing-review-window | false/permission and true/permission |
| watch-shape | landing S02: watcher queries | landing-ci-watch | blocking_watch guidance missing |
| forbid-integrate | landing S10: dispatch rejects | landing-merge | Missing expected rejection for cp_integrate |
| forbid-merged | landing S10: dispatch rejects | landing-merge | Missing expected rejection for cp_merged |

Exact patches and logs: `cp-dpmo-S10-<control>*`. `cp-dpmo-SHA256SUMS-3` hashes their bytes. Hashline undo restored each isolated mutant before the paired pass. Production integrate/merge and S09 consumer blobs remain those in increments 1/2.

Additional production blobs: merge-permission `0935c95d2c019981649f60a41b4bd875552d677b`, ci-wait `1cb3d1965da2deb3d308a898df3b4d59e22bae61`, contracts/workers `51819d09396681399ba5e34ba4d1e2d070864a62`.
Consumer blobs: review-window `f511a8a79e660a7b3d0b5e7745e479828ddb887e`, ci-watch `a75f02e2e10eb307739e188a1911914521f7c7ac`.

## Independent S10b status and actual evidence-only size boundary

Also executed `npm run test:one -- tests/e2e/landing-merge.test.ts` under the independent S10b status mutant.
Exit 1 at both `dirty: reset requires proof` and unreadable `status`'s `/git status\) \(exit 128/` refusal;
restored full consumer passed (83 cases, zero skips). Exact patch/logs and hashes are durably exported to
`/home/ubuntu/.pi-command-post/state/artifacts/cp-dpmo/proof/cp-dpmo-S10b-status*` and `S10b-status-SHA256SUMS`.

Before this metadata, adding that evidence to the current branch measured **292,594 bytes**, evidence only,
with no original deletion. Exact candidate is exported as `cp-dpmo/evidence-candidate.patch`, SHA256
`32b1144d5af6a2cf693ec216afeb540ebea67ec55edee04120abc5fc2c802c1d`.
The S10-only candidate measured 264,826 bytes before this metadata. Preserve this PR within the 280,000 cap;
remaining S08/S09/S10b/S11 evidence requires another ordered evidence delivery before cp-xwu0 retirement.
No missing proof is waived, and no original coverage is removed.
