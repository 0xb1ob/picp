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

## Context retirement proof (10 declarations)

The context source blob is `d7954bb5a34b2bb4b451c9897072f6da274b39eb`. All ten declarations are mapped to scenarios 05-S15-C (whole-file packet) and 05-S15-F (object failures) in the canonical manifest. The real git audit checks forbidden object reads and consumer queries. A second actual review after removing the first decision and scratch packet verifies manifest/body determinism from the same git objects. The used-byte sum and whole-section count cover the old small-budget accounting assertions at the product's fixed budget.

The patches in `testing-migration-s15-controls/` are zero-context unified diffs against src/review-context.ts. Each was applied individually via the anchor editor, executed against the real-entry scenario, and restored. C01–C04 and C06–C10 run `node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='S15: reviewers receive bounded' --test-force-exit tests/e2e/diff-review.test.ts`; C05 runs the same command with pattern `S15: a git object read failure`. All ten returned exit 1 with the assertions below; the restored scenario passed. SHA-256 values include the patch's final newline.

| Control | Patch SHA-256 | Failing consumer assertion |
|---|---|---|
| C01 | f52327695217aaa30fafb6aee0476b80323ecd0fec927e954bae69d0dae11471 | deleted docs/legacy.md fork state: undefined instead of included |
| C02 | 99dbf09f3fcdf5fe08a0383e092ede0d4d92dde5e1a4345d8c4c61fb77108192 | lib/unique.ts head state: undefined instead of included |
| C03 | f0b3ff5963d1df369bd79125ca8ee7090f6cea6d45706c8f8d8c1bf15b4f7c4d | forbidden etc/hosts.md and x.ts cat-file commands present in real git audit |
| C04 | c09a354a2839af9c97afa80ffd5cb4be24392d1e3c5ddb26c34c563e694476c7 | big.json state: included instead of omitted-budget |
| C05 | f27f6ab1597b3b24b1c66a390ab85e9ac814d2ffea3d37f341e5ee65a9d9ab17 | unreadable src/fault.ts with named error absent from manifest |
| C06 | 02062e2e70d8d2859d8dc8c07d0f262e3b1e7d254f86ce813c854bf6deabc9d4 | img.bin state: included instead of binary |
| C07 | c2f7c332edd61bcd26a1346cd4d351adcfffe6a617f478d2f167bb0b1723609d | src/run.py sha256 missing instead of 64 hex characters |
| C08 | 5d3594d2302a95f53a0086c871cc0fa5232e55729d573ca45d893b8efb2d89cf | consumer array contains use-6 and use-7 |
| C09 | efdc68fd7e5d2bdc56283b598d2aa9b15a3cbc27d96e9197419a334f7c2da728 | reviewer brief lacks confirmed-absence explanation |
| C10 | bda2cbe060162587fea753d9651f19d0201685595492b7edb9a63672159582e5 | unchanged lib/core.py fork unexpectedly included |

E2e-only V8 captures before (`/tmp/cp-s15-context-before-rTlKDp`) and after (`/tmp/cp-s15-context-after-8ygSlZ`) deleting the context source test each contain two review-context module records and the same 80 positive function/range tuples: no lost or gained tuple. Both runs executed all 23 cases with zero skips. The captures include the real product host; reviewer children consume its materialized packets. Source blob, ten assertion rows and executed regression control are recorded before retiring the whole file. The migration checker with --verify-regressions passes.
