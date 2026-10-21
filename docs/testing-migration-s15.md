# S15 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S15 owns the whole of review-context, review-merge-window, review-runs and review-tool. Other slices own all other conversions.

## Context replacement evidence

Entry point: `CommandPost.diffReview`, using the existing S04 stack, a real reviewer child and mocked model responses.

Scenario C: `S15: reviewers receive bounded whole-file snapshots with resolved task paths and capped consumers` in `tests/e2e/diff-review.test.ts`.
Scenario F: `S15: a git object read failure is named in reviewer context without fabricating absence` in that file.

| Original review-context declaration | Scenario | Executed production mutation | Failing assertion |
|---|---|---|---|
| 1 deleted task path | C | collect queues only head-side changed paths | docs/legacy.md fork state is undefined, expected included |
| 2 basename resolution | C | omit named paths from candidates | lib/unique.ts state is undefined, expected included |
| 3 absolute and home paths | C | remove TASK_PATH negative lookbehind | etc/hosts.md unexpectedly included |
| 4 whole-file budget | C | bypass remaining-byte guard | big.json included, expected omitted-budget |
| 5 git failures | F | turn failed blob reads into absent entries | no unreadable src/fault.ts entry with the named error |
| 6 binary | C | bypass NUL rejection | img.bin included, expected binary |
| 7 stable hashes/order | C | omit sha256 from included manifest entries | empty sha256 fails 64-hex assertion |
| 8 consumer cap | C | remove users.slice(0, MAX_CONSUMERS) | extra use-6.ts and use-7.ts entries |
| 9 pointer semantics | C | replace absent/unknown pointer explanation | reviewer brief lacks confirmed-absence explanation |
| 10 unchanged fork deduplication | C | queue fork as well as head for every named path | lib/core.py fork is included, expected undefined |

All ten production mutations above were executed individually and restored with undo_last_change. Each run used:

```
node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='S15:' --test-timeout=300000 --test-force-exit tests/e2e/diff-review.test.ts
```

The original file remains pending complete whole-file retirement bookkeeping and assertion-equivalence review. These rows record the executed declaration controls; they do not license an unproved assertion deletion. Restored full focused run: 15 passed, zero skipped; typecheck passed. Contract eval and export golden regeneration left tracked output unchanged; the normal golden check passed.

## Remaining files

review-merge-window (2), review-runs (19), review-tool (7) still need declaration accounting and conversion. No retained disposition is claimed at this stage.

## Second checkpoint

Added `S15: real reviewer attempts persist before waiting, reject duplicates and announce only after handback` through CommandPost.diffReview with real reviewer processes. Executed three individual src/review-runs.ts mutations, restoring each: initialize handed_back=true (fails initial false flag assertion); remove the wakeup handback await (fails zero pre-handback wakes); remove #send (fails one post-handback wake). These support declarations 1, 3 and 4; the duplicate preflight assertion is also exercised, but the separate registry-slot case still requires accounting.

Added `S15: the real cp_review tool relays bounded verdicts and policy refusals without review bodies`: a real pi RPC parent runs unknown-job, cached pass, wide-subject and oversized-subject cp_review calls. It checks medium reasons, persisted verdict equality, policy/model-free results and absence of raw diff bodies and paths. Production controls for this scenario remain pending; no migration credit is claimed for it yet.

Executed helper payload controls: replacing details.verdict with {} fails DiffVerdictSchema validation in the real RPC scenario; stripping formatted reasons fails the medium reason text assertion. A separate exploratory diff_path: result.diff?.path mutation PASSED this scenario: current cached and policy tool results carry no materialized diff. It was restored and earns no control credit. The original direct-helper raw diff/path injection assertion must therefore stay until a reachable consumer case is established or its unreachable input is traced and retained explicitly.

## Third checkpoint

Additional real-entry scenarios cover failed transport, legacy orphan reconciliation (including an unwritable decision directory), and real review decision writes with filesystem-boundary faults. The write scenario injects one failed atomic rename, a rename that succeeds then reports failure, and persistent rename failures; original fs bindings are restored in finally. No production function is replaced.

Executed and restored controls:

- Remove #clear from the normal reviewer finally: the failed-transport scenario finds pending.json still present.
- Remove pending.handed_back from the orphan wake condition: the untold legacy attempt unexpectedly wakes.
- Return from orphan sweep after a failed decision write: the later healthy job is not finished.
- Bypass orphan live-PID protection: the expected live-reviewer skip is missing.
- Remove the fallback finish call: the transient fault leaves no operational decision, and the persistent-fault subcase sees one write instead of two. Both subcase assertions failed in the recorded run.
- Bypass decisionExists after a partial finish: the persisted pass is overwritten by escalate; the partial-write subcase fails.

These add executable evidence for review-runs declarations 5, 8, 9, 10 (filesystem-failure portion), 12, 13, and the live-PID portion of 14. Exact complete declaration dispositions, remaining controls, patch hashes, whole-file retirements and reference repairs remain unfinished. No deletion or retained credit is claimed for those incomplete declarations.
