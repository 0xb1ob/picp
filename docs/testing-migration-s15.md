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
