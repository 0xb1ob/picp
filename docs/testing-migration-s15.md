# S15 declaration accounting

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S15 owns the whole of review-context, review-merge-window, review-runs and review-tool. Other slices own all other conversions.

## Dispositions

Context: 10 mapped, whole source file deleted. Window: 2 mapped, whole source file deleted. Tool: 4 mapped and 3 retained in `tests/review-tool-retained.test.ts`. Review-runs accounting is still in progress; its original file remains intact.

All product entry points use real product code and mocked models. Temporary agent directories, git shims and invalid profile configuration live outside the checkout and are removed by test cleanup. Filesystem fault cases alter the OS rename boundary and restore it in `finally`.

## Window equivalence

`landing S15: durable review evidence owns the merge window across parent restarts` exercises `CommandPost.integrate` and a fresh real RPC parent's `cp_integrate`. It checks missing, incomplete, malformed and wrong-head evidence; exact persisted 30-second deadline before and after restart; unchanged verdict bytes; and fresh/elapsed equivalent passes. The existing `landing: the review deadline resumes once and rechecks current gates` crosses the real deadline.

The deleted source blob is `60d780038feccabb53e53af161910110b242e5f1`. W01 removes the deadline's 30000ms interval: the fresh pass advances instead of waiting. W02 removes the evidence/head match: mismatched equivalence incorrectly gets `review_resume_at`. Both mutations failed the real-entry scenario and were restored; the restored scenario passed. SHA-256: W01 `76fe8e4aee8fad87cbd5a6f9f100ede181f1bbbd6aab1beced777a94cdf5ca00`; W02 `9da9ff314d8357cb81cd17f232f7ccc8b0bc2a2a5783b19b7a275bba22e92d14`.

V8 captures `/tmp/cp-s15-window-before-Zj7vN0` and `/tmp/cp-s15-window-final-GJoDIs` each contain two window module records and the same six positive named-function tuples. Anonymous wrapper offsets change when files are loaded through the real parent; they are excluded from the named-function comparison.

## Tool assertion accounting

Source blob: `9a39a3adc4f91eb48e99b19f43c198a852b9b2cf`. Scenario T is `S15: the real cp_review tool relays bounded verdicts and policy refusals without review bodies`; P is `S15: dispatch preview rejects parent tools in external worker profile configuration`, both in `tests/e2e/diff-review.test.ts`.

| Original declaration | Disposition | Assertion coverage and executed control |
|---|---|---|
| 1 registers beside gate; dispatch refusal | mapped T | Actual parent tool schemas and descriptions, dispatch-specific error, no decision; T00 fails the cp_dispatch repair assertion. |
| 2 parent-only review and gate | mapped P | Public dispatch preview reads external invalid profiles for both tools; T05 fails the cp_review rejection assertion. Real reviewer requests also contain neither parent tool. |
| 3 round-trip and closed schema | retained | T pins real RPC schema validity, head, separate next and verdict-file equality (T01). The remaining closed-schema assertion supplies an extra next property directly to validate: cp_review has no argument permitting a caller-supplied DiffVerdict; DiffReview validates persisted decisions and removes next before returning. Keep the original declaration verbatim for this schema contract. |
| 4 medium finding still proceeds | mapped T | The complete medium reason reaches RPC content and next remains proceed; T02 removes formatted content and fails the reason assertion. |
| 5 malformed negative file count | retained | cp_review cannot return a negative diff_stat.files: git output is counted, persisted prior verdicts are validated, and finish validates before writing. No tool argument supplies a verdict. Keep the helper's defensive validator assertion verbatim. |
| 6 uncapped observation and raw subject | retained | T now covers real materialized subjects: a drain starts after preflight but before spawn, producing a bounded operational verdict with subject counts and no diff path (T03 fails). The original combined input additionally contains a raw review observation, a revise receipt and materialized diff together. cp_review cannot return that combination: its live reviewer returns wait and the observation finishes asynchronously; cached and policy results have no raw observation, and synchronous spawn failure has no reviewer observation. Keep the original declaration verbatim for that unreachable helper input. |
| 7 model-free stat overflow | mapped T | Wide and oversized real branches return validated policy verdicts, no model/subject and no reviewer; T04 fabricates a model and fails the model-free assertion. |

The retained source keeps every original assertion for declarations 3, 5 and 6; unused imports and explanatory comments were removed. Four mapped declarations are removed only after the replacement scenarios and their controls pass/fail as recorded. Direct typed-helper invalid inputs remain protected; they are not invented through mocks of product functions.

## Executed additional controls

Every path below is under `testing-migration-s15-controls/`. Hashes include the trailing newline. Apply one patch, run its named scenario through `node --import ./tests/harness/hermetic-env.ts --test --test-name-pattern='<prefix>' --test-force-exit tests/e2e/diff-review.test.ts`, then restore production source. All listed mutations were individually executed and restored with the anchor editor. `git apply --check` verifies reproducibility.

| Patch | Scenario prefix | SHA-256 | Observed failing assertion |
|---|---|---|---|
| R01.patch | S15: real reviewer attempts | 899c6086f4bd3f39577c6c75956ee9a6cfff610be4aec3300dbb562948f8d4d2 | initial pending handed_back true instead of false |
| R02.patch | S15: real reviewer attempts | d9dfbb7f767ef596ff5b66865e1cfc92888f6052f8d15d77c82852f368a2f5cf | one wake before handback instead of zero |
| R03.patch | S15: real reviewer attempts | 714bc20b471e994fda3791c4e197596c9b8945aa05edd129e2081f1485aa2b79 | zero wakes after handback instead of one |
| R04.patch | S15: a failed verdict transport | d22b74a9d41e404fcc65d77b1210b159fd983565156ea7e8f019b7bb7d31d72a | pending.json still exists after failed transport |
| R05.patch | S15: orphan reconciliation | 1d4c2b0885909c14992e3d704dc6f1d6a44878c2b37cb616e72d201906a10c7d | untold legacy attempt unexpectedly wakes |
| R06.patch | S15: orphan reconciliation | 3ff2a82d67c87ee6ddc6844593f23a2730545e77cedff631f73c8bc5ac7221c1 | later healthy job absent from finished report |
| R07.patch | S15: orphan reconciliation | ba3fbd8ae793eadba1e99c9a538e0791e2808b676eabbabd24eecc36549af7ee | malformed pending files never stop the orphan sweep: unwanted rejection |
| R08.patch | S15: real review decision writes | e3783e5959745f709d3afaaded56e416c5f09a3ce7b913e4e1091b273113a8a6 | partial-write pass overwritten by escalate |
| R09.patch | S15: real review decision writes | 89942e2ab53cbb3a965f2ae9047b1ca18e6055b1dcad4f9fc60b5bb7e3b331fe | transient failure emits an unwanted notice; persistent failure has one write instead of two |
| R10.patch | S15: real review decision writes | 6d7e1ea926cbc94b248d7f434c0beeacb82657e7ba01571c093a0404859f37c2 | failing durable-notice transport rejects reviewer settlement |
| Q01.patch | S15: a real quality waiter | 94227b5928c6bf246ed9cb60385e74f1365dbf8e3fc83047cdffcd3b473ed626 | wake says undefined quality pass instead of quality panel failed / reviewer wait failed |
| B01.patch | S15: a lost caller handback | 2d5f38c287afebf30c45a08f2b9e0d5b758ab485acef2e2428211ebcf42da738 | zero wakes after the production 60-second bound, expected one |
| T00.patch | S15: the real cp_review | 8c54f9510b953f4bb97c19d2aa056d8c6e7a137dcb751908ed187f9e2a794ca9 | unknown-job refusal names cp_pipeline instead of cp_dispatch |
| T01.patch | S15: the real cp_review | 3ce3adefc11135ef1816683ab0aa39d06ad12e3010295a1131e2268240ed3f93 | every successful RPC result carries a valid verdict: false instead of true |
| T02.patch | S15: the real cp_review | f4381def5a721bfe49c39912c4fb880b973fafd678a509bdf733f29074325f08 | RPC content lacks retry can stay stale |
| T03.patch | S15: the real cp_review | 42d921a45441fe1134ecbc41d03d5044cbde10401e5cdd3ac5ed18159efaeb48 | actual operational RPC details contain review/diff.md |
| T04.patch | S15: the real cp_review | dc4a2875dac6dc9c910a6492171a14e268f98d298586a1df3275ffe3ac9861df | fabricated policy model instead of undefined |
| T05.patch | S15: dispatch preview | 96f894ad8f6d5e6615375c7a4900dfa1155c973c18905dfba652195611ffe5c0 | missing expected rejection for a worker profile containing cp_review |

An earlier cached-result-only path-leak probe passed and earns no credit. T03 now reaches the actual materialized-subject path. Moving the afterWakeup hook ahead of send also passed the real landing outcome: the production continuation schedules asynchronous work, while the old unit injects synchronous work. This exploratory mutation was restored and earns no credit for exact callback order.

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
