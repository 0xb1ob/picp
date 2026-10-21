# S06 declaration controls (rule v2)

This supplements the declaration dispositions in [testing-migration.md](testing-migration.md).
All 20 mapped original declarations have an executed production mutation below; the other 20 declarations remain
in the four retained files. Declaration numbers are their original file order, including retained declarations.
These are declaration controls, not merely one control per scenario.

Patch and log pairs are archived under
`/home/ubuntu/.pi-command-post/state/artifacts/cp-e2e-slice-s06-15yh/`.
Every listed execution exited 1 at the consumer assertion described below. All production mutations were reverted.
For each pair, apply its `.patch`, run the command for its scenario below, inspect the named assertion, and revert
before the next control. Earlier control patches and their commands are also recorded in the main migration ledger.

| Original file / declaration | Production mutation (artifact stem) | Executed failing consumer assertion |
|---|---|---|
| foreign-ci-watch / 1 selection | `foreign-selection`: remove closed-job filtering | checked jobs includes the closed job instead of exactly the selected foreign job |
| foreign-ci-watch / 2 green and replay | `control-dedupe`: replace fresh-fact filtering with all facts | `foreign facts are reported once`: expected empty, got repeated ci_green |
| foreign-ci-watch / 3 moved head | `foreign-moved`: suppress the moved-head fact | expected head_moved, got no fact |
| foreign-ci-watch / 4 terminal PR | `control-terminal`: query ended entries instead of skipping them | `terminal PR is no longer queried`: expected empty, got the merged job |
| foreign-ci-watch / 5 backoff and cap | `control-backoff`: set failed-read next_due_at to now | `a failed read backs off`: expected empty, got the failed job |
| foreign-ci-watch / 6 corrupt memory | `control-corrupt`: throw from the store read's parse-failure catch | `corrupt memory must recover`: corrupt foreign CI memory |
| foreign-ci-watch / 8 Actions reads | `control-actions`: turn rejected readActionsCi into an empty list | `malformed forge head is refused at the Actions boundary`: expected true, got false |
| foreign-ci-watch / 9 reviewer timeout | `foreign-timeout`: disable elapsed-time release | timed-out reviewer dispatch rejects waiting for CI instead of being accepted |
| foreign-ci-watch / 10 current-head binding | `control-binding`: accept completed evidence regardless of freshly read head | expected `/PR head is now/`, got normal model-selection preflight instead |
| foreign-ci-watch / 11 armed reviewer | `control-arm`: omit the requested armed entry from the persisted file | expected armed job id in entries, got empty array |
| forge-runtime / 1 legacy fallback | `runtime-legacy`: remove legacy GitHub observer fallback | legacy GitHub receipt fails as unsupported instead of recording gh evidence |
| forge-runtime / 2 configured project base | `runtime-trunk`: remove configured projectBaseBranch | real teardown fails instead of proving landing on trunk |
| forge-observers / 2 GitHub failures | `control-gh-error`: stop truncating gh failure to its first line | error must not match private second line; it contains that line |
| forge-observers / 4 GitLab states | `control-states`: normalize opened as closed | expected `/as open, not MERGED/`, got as closed |
| forge-observers / 5 malformed answers | `observer-conflict`: bypass conflicting sha/diff_refs head rejection | missing expected rejection for conflicting heads |
| forge-observers / 7 redirects | `control-http`: follow GitLab redirects | expected HTTP 302 redirect refused, got redirected HTTP 404 |
| forge-observers / 13 throwing afterRecorded | `observer-deploy`: throw instead of naming after-merge refusal | recordMerge rejects corrupt ledger instead of returning recorded receipt and retry text |
| forge-observers / 14 ledger refusal | `observer-deploy`: same mutation, same actual failing ledger operation | recordMerge rejects before the no-deploy-record and successful retry assertions |
| held-release / 5 room at cap | `control-release`: omit manager.shutdown(victim) | `a valid held author must free room for dispatch`: spawn cap reached |
| held-release / 7 journal failure | `held-reservation`: omit failed-transfer reservation cleanup | same-job retry rejects already holds a reserved slot |

The deploy control is shared deliberately: both original declarations require that the real ledger failure be
returned as a named after-merge result while retaining the merge receipt. Throwing that failure breaks each
original contract and the same public recordMerge operation that replaces both. No other declaration relies on
another declaration's unrelated failing assertion.

## Commands

All commands use `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.

| Artifact stems | Pattern |
|---|---|
| foreign-selection, foreign-timeout, control-backoff, control-corrupt, control-actions, control-arm | foreign CI selection |
| foreign-moved, control-dedupe, control-terminal, control-binding | foreign CI stays |
| runtime-legacy | legacy unregistered |
| runtime-trunk | configured trunk |
| observer-conflict, control-gh-error, control-states, control-http | forge observation failures |
| observer-deploy | deploy ledger failure |
| held-reservation, control-release | spawn pressure releases |

## Additional production patches

The eleven rule-v2 controls below supplement the eight previously executed controls. Each row specifies the
production edit exactly; the archived unified patch carries surrounding context. SHA256 identifies that patch,
not its log. The log of the same stem records the execution and assertion above.

| Stem | Production edit | Patch SHA256 |
|---|---|---|
| control-actions | src/foreign-ci-watch.ts: append `.catch(() => [])` to readActionsCi in ghForeignRuns | b84744dd62616dbc5a62ae4166f001d81038ba869683894f51f797680bc576f9 |
| control-arm | src/dependency-dispatch.ts: replace arm's write with `this.#write({ ...file, entries: rest });` | 40fa6f2c0cc6060eacf4e1344ade8b5e6ad4b7293d6a7023cabc76ce14bffb91 |
| control-backoff | src/foreign-ci-watch.ts: replace failed-read deadline with `entry.next_due_at = isoTimestamp(now);` | a41db7b17bf84b3d7ccdf5a66afcb83831b0816142ce16524aabefea04b6ec29 |
| control-binding | src/foreign-ci-watch.ts: replace `if (current.head === entry.head_sha)` with `if (true)` | dd8cc14e9c4f241bd807e95fba7790176af8e683e9a9e063c825d7c5b4dbc6be |
| control-corrupt | src/foreign-ci-watch.ts: replace read's catch return with `throw new Error("corrupt foreign CI memory");` | d8b74f7ee61633ebd96566aaba58e8ac806b1d59f04020df40d16fe4f1622cbc |
| control-dedupe | src/foreign-ci-watch.ts: replace fresh filtering with `const fresh = facts;` | 6308fc8de83b0d057649cfef8924ead8fe778a4aca21a00bb20301009739a44a |
| control-gh-error | src/forges/github.ts: replace command-failure detail with `(result.stderr \|\| result.stdout).trim()` | ba908907fbac2a68ed31ea2e98f964029dd55f2b1f8baf6926ecdbbc3a99e254 |
| control-http | src/forges/gitlab.ts: change `redirect: "manual"` to `redirect: "follow"` | 210b2e2e78d1c0643ae02b0e686656775febc0a6f16bebdf804cd4049466ba39 |
| control-release | src/held-release.ts: delete `await manager.shutdown(victim);` | d4ded3df1323612de76e1888efba466115d3c5d907b906f864f796879d3056a1 |
| control-states | src/forges/gitlab.ts: use `STATES[raw.state === "opened" ? "closed" : raw.state]` | cac8fdda81232016b5a81ee4f3252231ae4444f924608702f4bbc3c9e2e4e95f |
| control-terminal | src/foreign-ci-watch.ts: replace ended/due guard with `if (!entry.ended && (entry.next_due_at && now.getTime() < Date.parse(entry.next_due_at))) continue;` | db55fa1577148d65213901fa056c248a9acaebb0a792882c0bc8e2ad50fbd5d9 |
