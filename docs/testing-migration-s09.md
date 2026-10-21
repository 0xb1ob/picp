# S09 declaration evidence

S10 carry-in completion (main session carry-in): declaration 59 has independently executed reminder-dedupe and reminder-withdraw controls; 63 has completed-repair exhaustion in addition to its active guard; 70 has a new-head handoff control in addition to first conflict and exhaustion. Exact patches, blob SHAs and failing assertions are in [S10 controls](testing-migration-s10.md#executed-production-controls). S09-2 ready/reminder follow-ups now require an actual merge command. All declarations 41–80 also have canonical assertion-map rows in testing-migration.md.

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

S09 owns only static declarations 41–80 of `tests/integrate.test.ts`, counted in source order (a loop containing a test call is one declaration). S08 owns 1–40. This range adds consumer evidence and leaves the unit file byte-for-byte whole; the final range owns reconciliation and retirement. Accounting: 34 mapped, 6 retained mixed/internal declarations (15%), 0 redundant-unreachable, 0 deleted files, 0 pending. Retained assertions stay in the original file under the range amendment. No production change is shipped.

## Public scenarios

All cases are in `tests/e2e/landing.test.ts`, through real CommandPost integration, worker prompts/reporting, scratch git, scripted gh and the existing local HTTPS GitLab fixture. No internal method is mocked.

| ID | Test title after `landing S09: ` |
|---|---|
| 05-S09-1 | exact head and branch evidence distinguish pending, superseded and absent CI |
| 05-S09-2 | repository refusals and draft transitions preserve head authority |
| 05-S09-3 | external PR facts stop or finish without an automated merge |
| 05-S09-4 | GitLab integration observes the target and never asks GitHub to merge |
| 05-S09-5 | a real repair stays single while active and conflict handoffs follow heads |
| 05-S09-6 | public promotion before or during integration waits for a fresh report |
| 05-S09-7 | infra reruns once while second attempts and test failures promote |
| 05-S09-8 | a missing implementer surfaces without spending the same-head repair |

## Declaration map

Every mapped row names an assertion observed failing under its executed control. Retained mixed rows name their covered consumer outcome as well as the specific assertion that must stay.

| Declaration (source line) | Disposition | Consumer assertion and executed failure |
|---|---|---|
| 41 (1548), pending head | mapped | 1/pending: wait, no merge/checkpoint; NC-2 advances instead. |
| 42 (1558), workflows present | mapped | 1/present: surface with a head checkpoint, then approved human-checkpoint merge bound to this head; NC-2 advances instead of the initial surface. |
| 43 (1581), older branch run | mapped | 1/older: wait with no workflow probe/checkpoint; NC-1 surfaces instead. |
| 44 (1593), empty head/branch | mapped | 1/present and none: present asks, authoritative-empty merges without checkpoint; NC-2 breaks both (present advances; none lacks the authoritative-empty fact). |
| 45 (1606), branch-read failures | mapped | 1/denied-branch, malformed-branch, invalid-branch: checkpoint and unreadable fact, no merge; NC-2 advances in every shape. |
| 46 (1624), branch-only green | mapped | 1/branch-green: no merge/green fact/job lookup; NC-2 advances instead of surface. |
| 47 (1645), no workflows | mapped | 1/none: repo-derived merge with authoritative-empty fact and no checkpoint; NC-2 loses that fact. |
| 48 (1672), no CI plus refusal | mapped | 2/no-ci-blocked: surface and one reminder, no checkpoint/merge; NC-3 advances. |
| 49 (1690), unreadable workflows | mapped | 1/four workflows failures: unreadable fact and checkpoint; NC-2 advances for all four. |
| 50 (1711), red with no workflows | mapped | 5/red: repair starts without reading workflows or minting authorization; NC-7 waits instead of resolve. |
| 51 (1730), required reviews | mapped | 2/blocked: surface, open reminder, no merge/checkpoint; NC-3 advances. |
| 52 (1751), unreadable rules | mapped | 2/unreadable-rules: surface, no merge; NC-3 advances. |
| 53 (1760), unstable | mapped | 2/unstable: surface, no merge; NC-3 advances. |
| 54 (1770), unreviewed draft | mapped | 2/unreviewed-draft and stale-draft: review, zero ready/reminder/escalation; NC-11 surfaces for both. |
| 55 (1779), ready once | mapped | 2/ready and ready-unreadable-ci: advance without merge; ready later merges with one ready call; NC-4 surfaces. |
| 56 (1792), moved/refused ready | mapped | 2/ready-moved: wait, undo, then review without another ready; refused undo/ready surface with named cause; NC-4 breaks next/cause assertions. |
| 57 (1815), stale approval plus refusal | mapped | 2/approved-blocked: surface, no merge, old approved checkpoint preserved; NC-3 repeated on this added subcase advances. |
| 58 (1829), permission head moved | mapped | 2/moved: wait, no merge; NC-10 advances. |
| 59 (1838), reminder lifecycle | mapped | 2/reminder: repeated refusal keeps one row, later merge withdraws it; NC-3 advances on refusal. |
| 60 (1855), armed auto-merge | mapped | 2/auto: surface and no merge; NC-10 advances. |
| 61 (1870), sourced red repair | mapped | 5/red: ci/resolve, one prompt naming run 305 and its URL, merge-and-plain-push guidance, no merge/checkpoint; NC-7 waits. |
| 62 (1897), infra rerun | mapped | 7/infra, second, test: rerun once then resolve, or resolve immediately; NC-7 repeated on all three loses rerun reason (infra) or waits instead of resolve (second/test). |
| 63 (1937), duplicate red | mapped | 5/red: active repair stays resolve, report then persistent red surfaces; NC-5 waits during repair; NC-6 resolves after its completed failure. |
| 64 (1950), active worker authority matrix | retained (mixed) | 6 covers waiting workers before/during repository and human-checkpoint paths, fresh-head review and bound resumption; NC-5 breaks all four. The launching-model branch stays: CommandPost.integrate reads validated FleetStore records; src/contracts/fleet.ts explicitly rejects a model record in launching phase. Script launching is ship/local and cannot enter PR integration. An attempted real FleetStore.patch was refused with `model requires worker and forbids script fields`; direct bench construction bypasses this boundary. |
| 65 (1975), permission-read promotion | mapped | 6/during permission on both authority paths: resolve, zero attempts/merges, fresh report then review and bound new-head merge; NC-5 advances instead on both paths. |
| 66 (2002), concurrent raw Integrator promotion | retained | CommandPost.integrate serializes by job through continuation.serialize; no public cp_integrate can enter a second raw advance while its first send is pending. Unit constructs a private sender barrier and directly calls Integrator.advance twice. 6 pins the reachable public-send race; its NC-5 breaks resolve/no-merge. Keep the isolated lower-level concurrency assertion. |
| 67 (2031), working before integration | mapped | 6/repository/waiting/before integration starts a real public send before reading red CI: resolve with zero integration attempts; NC-5 increments attempts to 1. |
| 68 (2038), duplicate while send pending | retained | Same per-job CommandPost.integrate serialization as 66; two overlapping raw Integrator.advance calls with a custom sender are unavailable through cp_integrate. 5 pins one prompt during real active repair (NC-5 breaks resolve). Keep the isolated raw-send counter. |
| 69 (2066), isolated promoting predicate | retained | CommandPost.dispatch uses HeldRelease with its real WorkerManager and Sender. This unit injects an idle fake manager plus sending=false/driving=false while a private send promise is pending; no CommandPost port accepts those replacements. Actual Sender marks the real RPC worker busy while sending, so the isolated promoting-only releasable predicate cannot be supplied through dispatch. Keep its unit rather than replacing the manager. |
| 70 (2101), conflict handoff | mapped | 5/conflict: conflict step, safe merge/plain-push prompt, surface then quiet wait once per head, moved head earns another single handoff, surface journal counts 1 then 2; NC-8 changes step to ci; NC-6 also resolves instead of surface. |
| 71 (2140), no live implementer | mapped | 8: a real parent restart has no live worker, surface with zero attempts/processes; public revive then same-head resolve spends one attempt; NC-12 resolves at the missing-worker assertion. |
| 72 (2160), unwired sender | retained | CommandPost constructs Integrator with its Sender unconditionally; neither cp_integrate nor CommandPost.integrate has an option to remove it. Keep the bench's noSender option, which omits IntegratorOptions.send. Scenario 8 instead pins the reachable missing-worker outcome (NC-12). |
| 73 (2172), externally merged PR | mapped | 3/merged: done, receipt, closed job, no automated merge/checkpoint; NC-13 returns review. |
| 74 (2185), closed unmerged PR | mapped | 3/closed: surface without receipt or teardown; NC-13 returns review. |
| 75 (2211), GitLab squash | mapped | 4/squash: develop receipt, observed squash, deleted source, done/closed, exactly two MR reads and none on replay, zero gh; NC-9 retries instead of done. |
| 76 (2236), GitLab merge commit | mapped | 4/merge-commit: observed unknown strategy despite caller squash, develop receipt and closed job, zero gh; NC-9 retries instead of done. |
| 77 (2250), GitLab refusal matrix | retained (mixed) | 4 covers open, unknown, closed, foreign, unavailable, fork and held causes with no receipt/close/gh (NC-9 fails each). Keep the merged-with-no-target observer assertion: CommandPost.integrate's real GitLab adapter rejects missing target_branch before producing an observation (src/forges/gitlab.ts). The named no-target subcase pins its reachable retry/invalid response; a fabricated successful observation with no target cannot cross that parser. |
| 78 (2279), contradictory base/bound source | mapped | 4/contradictory-base surfaces on main after develop receipt; bound finishes and keeps the remote source; NC-9 retries rather than finishing the initial MR for both subcases. |
| 79 (2297), foreign PR branch | mapped | 3/foreign: surface, named mismatch, no receipt/merge; NC-13 returns review. |
| 80 (2311), gh 403 | mapped | 3/denied: retry with first stderr line, no receipt/merge; NC-13 waits instead. |

## Executed production controls

All mutations were applied temporarily and restored. Each run exited 1 at an assertion, not a schema failure. `NC-N` below means S09-NC-N. Invalid trial mutations earn no credit.

Use `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='<title prefix>' tests/e2e/landing.test.ts`. Subcases can be selected with anchored `--test-skip-pattern`; anchoring matters because skipping the parent title skips the entire case.

| Control | Production mutation | Executed scenario and failing assertion |
|---|---|---|
| NC-1 | Disable the `else if (older.length)` superseded assignment in src/integrate.ts. | 1/older: surface != wait. |
| NC-2 | Replace the main `if (ci.ci !== "green")` with `if (false)` in src/integrate.ts. | All twelve 1 subcases fail: pending/older advance instead of wait; present and branch/workflow refusals advance instead of surface; none loses its authoritative-empty fact. |
| NC-3 | Add BLOCKED and UNSTABLE to PERMITTED_MERGE_STATES in src/merge-permission.ts. | 2/blocked, unreadable-rules, unstable, no-ci-blocked, reminder each advance != surface. Re-executed separately for approved-blocked: advance != surface. |
| NC-4 | Return a valid permit/surface record with reason `draft readiness unavailable` at entry to Integrator.#ready. | 2/ready, ready-unreadable-ci surface != advance; ready-moved surface != wait; ready-undo-refused and ready-refused lack their named error causes. An earlier invalid step name failed schema validation and earns no credit. |
| NC-5 | Disable both active-worker guards (#deliveryBlocked and #resolve) in src/integrate.ts. | 5/red wait != resolve; 5/conflict surface != resolve. Re-executed on all four final 6 subcases: repository/before spends 1 != 0; repository/during and both checkpoint subcases advance != resolve. |
| NC-6 | Set #resolve's prior allowance to 0. | 5/red and conflict: completed failure resolves != surface. |
| NC-7 | Disable the main `if (ci.ci === "failed")` in src/integrate.ts. | 5/red waits != resolve. Re-executed on 7: infra loses rerun reason; second and test wait != resolve. |
| NC-8 | Disable main `mergeable === "CONFLICTING"` gate. | 5/conflict: first step ci != conflict. |
| NC-9 | Set the GitLab-routing decision `const gitlab = false` in src/integrate.ts. | All original eleven 4 subcases fail: successful MRs retry != done; open/closed/foreign/fork retry != surface; no-target/unavailable/held issue forbidden gh reads. Separately executed added unknown: retry != surface. |
| NC-10 | Disable both permission-head movement and armed-auto-merge gates in src/integrate.ts. | 2/moved advance != wait; 2/auto advance != surface. |
| NC-11 | For draft verdicts call #ready directly, bypassing #reviewRequired. | 2/unreviewed-draft and stale-draft surface != review. |
| NC-12 | Disable `if (error \|\| !receipt)` after #resolve's send. | 8: missing implementer resolve != surface. |
| NC-13 | Disable initial foreign-branch, MERGED and CLOSED PR gates, and replace unreadable view's next with wait. | 3/closed and foreign review != surface; merged review != done; denied wait != retry. |

S08 carry-in is recorded in [the S08 ledger](testing-migration-s08.md#s09-carry-in-declaration-2-rechecks): separately executed head, CI and permission mutations each failed the deadline merge-count assertion. Its existing hold control remains separate.

Before the S06/base merge, the migration checker reported 378 files and 4,307 static declarations (+8 from S08's 4,299). After merging S06 and the current base, it reports 378 files and 4,290 declarations, still +8 against that base's 4,282. S09 moves/deletes zero units. Fixtures create throwaway agent directories and mock models and register cleanup; workers never inherit installed agent settings. The GitLab token is an inert local canary. Full local suite and e2e-coverage report are intentionally not run; focused checks and CI own validation.
