# S10b final-state control replay

Controls run independently through the real product scenarios. Each mutation is reversed before the next run.
The tables record executed assertion failures, not patch applicability. Final restored checks are recorded in
[S10b](s10b.md). Commands use `npm run test:one -- --test-name-pattern="<selector>" tests/e2e/landing.test.ts`.
No live model is used. Existing S02/S03 control definitions remain in their owning manifests and replay notes.

## Integrate declarations 81–120

The 17 patches are `docs/testing-migration-s10-<control>.patch`; each executed with exit 1.
Selectors are the `landing S10:` groups except `watch-shape`, which uses S02 watcher queries.

| Control | Selector suffix | Observed failed assertion |
|---|---|---|
| sync-guards | synchronization | refused synchronization/reset command expectations |
| sync-reset | synchronization | reset command sequence |
| prune | rescue | rescue preservation, fetch/list/reachability/delete refusal reasons |
| ref-scope | rescue | cleanup must preserve main |
| review-gate | review evidence | review refusal replaced by OPEN PR result |
| review-pass | review evidence | missing/nonpassing review replaced by OPEN PR result |
| ci-refusal | unreadable forge | unreadable CI refusal replaced by OPEN PR result |
| missing-gh | unreadable forge | missing-gh reason replaced by spawn ENOENT |
| cleanup-retry | cleanup failures | expected retry, got wait after failed cleanup |
| rebase | cleanup failures | expected cleanup refusal, got OPEN PR result |
| retry-notice | cleanup failures | forbidden “nothing was mutated” claim appears |
| prune-safety | rescue | rescue reference set deepEqual |
| rescue-target | synchronization | rescue target SHA equality |
| proof-skip | synchronization | behind/stale: reset requires proof |
| watch-shape | S02: watcher queries | missing blocking_watch refusal |
| forbid-integrate | dispatch rejects | missing expected rejection |
| forbid-merged | dispatch rejects | missing expected rejection |

The carried tracking-ref mutation independently failed the behind and stale reset SHA assertions (86/87).
The carried permission-classification mutation failed `/token lacks Actions read/` (82).
The generic review-reason mutation failed `/cp_review/` in both missing and fallback cases (111/120).
The status and jobless controls have canonical regression rows and reproducible patches in [S10b](s10b.md).

## S02 watcher controls

The 24 `NC-S02-*` patches are embedded in [S02](s02.md). Every control exited 1 at its selected consumer assertion.
The first GitLab command used an obsolete selector and selected no case; it earned no evidence credit.
The corrected `landing S02: unavailable gh` replay failed the GitLab query-set deepEqual assertion.
Run this section with
`npm run test:one -- --test-name-pattern='landing S02:' tests/e2e/landing-ci-watch.test.ts`.

| Control suffix | Observed failed assertion |
|---|---|
| eligibility | waiting/done/failed/local/pipeline/receipt exclusions |
| terminal | terminal PR observation equality |
| retry | one resend preserves identity |
| resend | never a third send |
| age | failed queries never refresh an unread head |
| cap | errors back off exponentially and cap |
| gitlab | GitLab query-set deepEqual after GitHub disablement (corrected selector) |
| policy | missing blocking_watch refusal |
| restart | confirmed arrival survives reconstruction |
| permission | permission-failure observation equality |
| idle | settled heads use idle cadence |
| base | unfinished heads use base cadence |
| due | due-query timing assertion |
| overlap | overlapping ticks query once |
| env | invalid watch interval is refused |
| aggregate | one unfinished workflow defers the aggregate |
| superseded | a superseded green is no verdict |
| empty | no runs is no verdict |
| red | red aggregate observation equality |
| closed | closed PR observation equality |
| parked | parked rows survive held-watch pruning |
| key | pushed-head key includes its current head |
| history | one journal event per completed attempt |
| prune | finished deliveries leave the watch |

## S03 and S03b continuation controls

The following current-source mutations replay the controls in
[`testing-migration-s03-replayed-controls.md`](../testing-migration-s03-replayed-controls.md) and
[`testing-migration-s03b-controls.md`](../testing-migration-s03b-controls.md). Aliases separate independent
branches of older grouped controls. Each completed row below exited 1 at the named assertion or bounded wait.
The in-flight outcome case uses `tests/e2e/headless-lifecycle.test.ts`; the rest use landing scenarios.
After the landing split, run this section with
`npm run test:one -- --test-name-pattern='landing S03:' tests/e2e/landing-s03.test.ts`.
The headless in-flight case retains its separate file and selector.

| Control | Mutation | Observed failed assertion or bounded wait |
|---|---|---|
| S03-authority | remove authority sentence | evidence, not authorization |
| S03-advice | replace cp_integrate advice | cp_integrate |
| S03-red | remove red prohibition | Merging red is forbidden |
| S03-confirm | remove store arrival dedup | duplicate arrival changes nothing |
| S03-corrupt | throw on corrupt watch memory | corrupt memory is forgotten, not a failed read |
| S03-schema | accept unvalidated memory | corrupt memory is forgotten, not a failed read |
| S03-rest-merged | force REST merged false | REST merged flag reaches public observation |
| S03-delivery | omit PR delivery guard | local/pipeline deliveries are not queried |
| S03-receipt | accept missing PR receipt | empty and non-PR receipts are excluded |
| S03-landed | accept only exact merged spelling | landed/case/whitespace exclusions |
| S03-coalesce | omit seen-key guard | replay starts no additional integration read |
| S03-rearm | retain wait/draining seen keys | same identity can read again after wait |
| S03-run-key | omit run identity | new attempt reaches integration once |
| S03-generation-key | omit generation identity | reopened generation is a new identity |
| S03-driving | hide driving membership | expected spawn-cap rejection missing |
| S03-driving-finally | omit driving cleanup | throwing step clears busy fence |
| S03-each-step | omit per-step stale check | phase/hold changes stop the loop |
| S03-pending | bypass pending review guard | new fact reaches already-pending review gate |
| S03-deadline | omit timer trigger | restarted deadline reaches terminal gate, 45s wait |
| S03-stop-head | omit head tag from stop identity | changed handed-off head gets another stop |
| S03b-legacy | ignore legacy arrival strings | both arrival forms confirmed, 10s wait |
| S03b-arrival-type | ignore custom message type | only cp-ci messages confirm arrival |
| S03b-revise | allow revise wake to trigger | revise handoff never schedules integration |
| S03b-gate | allow research gate wake to trigger | gate pass schedules no PR integration |
| S03b-landed-hook | omit onLanded call | real landed hook reports consumer failure, 10s wait |
| S03b-disable | omit durable disable reason | gh is not available |
| S03-resume | return no startup outcomes | startup arms durable window, 10s wait |
| S03-stale | disable stale checks | queued startup cannot adopt reopened identity; stale facts spend no review |
| S03-sampled | replace sampled hold text | none/bounded reason/unconfirmed hold text |
| S03-mid-drain | disable drain check | draining hold stops integration |
| S03-owner | ignore home ownership | lost ownership cannot advance beyond review wait |
| S03-outcome | hide continuation CI outcome | handled in code, no parent turn |
| S03-failed-run | pick first run blindly | only failing run is named |
| S03-tracker | append tracker work to landing notice | no tracker/write-back/receipt-note chores |
| S03-landed-turn | make quiet landing trigger turn | landing relayed without waking model |
| S03b-snapshot-generation | recapture queued generation | queued startup cannot adopt reopened identity |
| S03b-snapshot-head | recapture queued head | stale queued startup reaches no forge read |
| S03b-expiration | accept expired review window | expired/retry startup reaches terminal result, 15s/45s waits |
| S03b-equivalent-window | bypass synchronous window arm | equivalence arms window without extra integration step |
| S03b-replacement-generation | omit new-generation timer | valid new generation replaces deadline |
| S03b-replacement-head | omit replacement-head timer | changed head replaces original deadline |
| S03b-stop | suppress nonterminal notices | surface/retry wakes real parent, 20s waits |
| S03b-stop-hook | release dependents on stops | stopped continuation never releases armed dependents |
| S03-eligible | reject every watched record | eligible delivery is queried |
| S03-remote-head | omit remote-head review comparison | changed remote head spends no review |
| S03-fleet-write | erase receipts during watch observation | watch tick writes no receipts or fleet state |
| S03-blocking | issue gh run watch | watcher command refuses blocking watch |
| S03b-unreadable-drain | treat unreadable drain as false | unreadable drain fails closed at real deadline |
| S03b-parked | omit parked notice liveness exemption | parking relayed without waking model |
| S03b-fleet-stamp | omit held-envelope validation | held-without-report validation |
| S03b-actions-id | default missing Actions id | historical id-less run is refused |
| S03b-retry | rearm a deadline after operational retry | operational retry never rearms its deadline |

Inherited CI-repair controls also replayed with exit 1:
`npm run test:one -- --test-name-pattern='landing: held CI repair' tests/e2e/landing.test.ts tests/e2e/landing-ci-watch.test.ts`.

| Control | Mutation | Observed failed assertion |
|---|---|---|
| S07-NC-1 | omit Sender repair mandate check | revoked authority refuses repair |
| S07-NC-2 | serialize by job instead of project | another job in the same project waits behind CI repair |
| S07-NC-3 | reset spent conflict-repair allowance | restart reads spent allowance before local-worker lookup |

S03 declaration 70 is retained verbatim; none of these asynchronous hook controls substitutes for its
synchronous throwing-onLanded assertion.

## Inherited 05-8 controls

The five patches embedded in [B05](b05.md) replayed independently against
`landing: CI watch persists`. Each exited 1; all mutations were restored.
`npm run test:one -- --test-name-pattern='landing: CI watch persists' tests/e2e/landing-ci-watch.test.ts`.

| Control | Observed failed assertion |
|---|---|
| NC-32-attempt-identity | a new attempt is a new failure even on the same head |
| NC-39 | a green rerun follows a failed attempt |
| NC-40 | an arrived attempt is not announced again |
| NC-41 | an arrived green attempt is not announced again |
| NC-42 | arrival is idempotent |

Across these tables, 101 executed negative controls failed at consumer assertions or bounded waits.
The discarded zero-match GitLab command is excluded from that count. No patch-application refusal or
module-load failure is counted as negative evidence.

## Independent wording carry-ins

Two additional mutations each exited 1 through the existing S10 review/cleanup scenarios:

| Control | Mutation | Observed failed assertion |
|---|---|---|
| S10b-unchanged | remove only the unchanged-head sentence, preserving cp_review guidance | /unchanged/ fails in missing and fallback |
| S10b-resume-hint | remove only “resumes, never starting over”, preserving retry facts and absence of a false no-mutation claim | resume-hint assertion fails in delete, close and merge-unknown |

These are supplementary to the 101 inherited controls above. Both source mutations were restored.
