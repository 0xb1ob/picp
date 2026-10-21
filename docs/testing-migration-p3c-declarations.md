# P3c declaration assessment

Owner of all seven partial files: **P3c2**, disposition **convert**. The files were restored to their original
baseline paths rather than counting `*-retained.test.ts` renames as deletions. No declaration is deleted in this
revision: mapped declarations stay in their partial files until the file's remaining declarations are proved.

Each row identifies one declaration (long titles shortened; suite labels included where useful); the two
parameterized CI-watch declarations cover all their generated cases. `keep` means retained for the stated reason,
not redundant-unreachable. A variant without its own demonstrated failing consumer assertion stays. P3/P3b inherited checks stay too.

143 static declarations assessed: **5 mapped, 138 retained, 0 redundant-unreachable**; retained share **96.50%**.
The seven files contain 152 runtime cases, including parameterized cases. No file is wholly mapped, so no file
qualifies for deletion. The separate six new consumer scenarios remain in `tests/e2e/landing.test.ts`.

All five mapped declarations use scenario 05-8. Reproduction:
`npm run test:one -- --test-name-pattern='CI watch persists arrival' tests/e2e/landing.test.ts` with the named
manifest patch; every recorded mutation failed its stated assertion, then the restored complete file passed.

## tests/ci-watch.test.ts — 80 declarations

| ID | Unique declaration prefix | Disposition and reason / own failing control |
|---|---|---|
| C01 | a held delivery:pr job with an open PR receipt is watched | keep: exact selection predicate is not independently mutated through a consumer |
| C02 | waiting, done and failed jobs are not watched | keep: full phase exclusion matrix lacks its own consumer control |
| C03 | delivery local and pipeline are not watched | keep: both delivery exclusions need independent consumer proof |
| C04 | a held job with no PR receipt is not watched | keep: missing-receipt selection is not independently controlled |
| C05 | the set drains itself | keep: merged and landed receipt exclusions are not both controlled |
| C06 | a job whose envelope slot was reopened | keep: reopened-envelope selection is not pinned by the new scenario |
| C07 | all runs completed green on the current head | keep: multi-workflow aggregate assertions lack their own mutation |
| C08 | rerunwake-12z: the derived key carries the attempt | keep: legacy id-less key assertions are not covered by NC-32 |
| C09 | one unfinished run on the head emits nothing | keep: mixed completed/unfinished aggregate has no own control |
| C10 | a green run on a superseded sha | keep: old-head suppression needs its own control |
| C11 | a completed non-green run on the current head | keep: all non-green conclusion variants lack independent controls |
| C12 | a merged PR derives pr_merged | keep: merge-commit payload and CI suppression are not independently controlled |
| C13 | a closed unmerged PR derives pr_closed | keep: closed-without-merge notification has no own control |
| C14 | zero runs for the branch emits nothing | keep: empty-runs silence has no own control |
| C15 | two ticks with identical facts and an observed arrival wake once | mapped: NC-41 reannounces confirmed green; fails `an arrived green attempt is not announced again`, actual ci_green observation, expected [] |
| C16 | sent is not delivered | keep: exact retry-window boundaries require the retained clock test |
| C17 | pi-command-post-jua: an unconfirmed fact gets one resend | keep: the one-resend bound has no own consumer control |
| C18 | a restart over the same state file | keep: new process/state replay is not controlled by the current case |
| C19 | rerunwake-12z: a re-run that fails again | mapped: NC-32 collapses attempts; fails `a new attempt is a new failure even on the same head`, actual undefined |
| C20 | rerunwake-12z: a green re-run after a red attempt | mapped: NC-39 suppresses green emission; fails `a green rerun follows a failed attempt`, actual undefined |
| C21 | rerunwake-12z: a re-run of an already-announced green head | keep: green-to-green new-attempt transition has no own control |
| C22 | rerunwake-12z: the same completed attempt polled twice | mapped: NC-40 reannounces confirmed red; fails `an arrived attempt is not announced again`, actual ci_failed observation, expected [] |
| C23 | rerunwake-12z: a restart over the same run identity | keep: restart persistence needs a separate process/replay control |
| C24 | a force-push makes the new head a new key | keep: non-retraction and identity assertions have no own control |
| C25 | ci_failed, then a force-push, then green | keep: complete failure/non-retraction transition has no own control |
| C26 | a job that leaves the watch set is pruned | keep: pruning has no dedicated old-defect mutation |
| C27 | a parked job's row survives the prune | keep: parked preservation and done pruning need separate controls |
| C28 | every command the watcher builds passes detectCiWait | keep: command-policy checks are not implied by notification behavior |
| C29 | a query error backs off exponentially | keep: exact fake-clock backoff/reset assertions stay |
| C30 | a CI read refused for permission | keep: denied-versus-network state variants lack an own mutation |
| C31 | a query that learned nothing does not age | keep: head age after failed reads is not independently controlled |
| C32 | a missing gh disables the watch | keep: one-time disabled diagnostic has no own consumer control |
| C33 | forge PR 3: missing gh stops only the GitHub job | keep: mixed-forge availability and one-time wake have no own control |
| C34 | forge PR 3: a GitLab MR maps onto the watch's terminal shape | keep: failed-read and cross-provider routing assertions stay |
| C35 | an announced verdict on an open PR | keep: exact idle multiplier requires its retained clock assertion |
| C36 | a job with no verdict yet | keep: exact initial interval requires its retained clock assertion |
| C37 | a tick that is not due yet | keep: skipped query counts are not independently controlled |
| C38 | an overlapping tick returns the first one's promise | keep: overlapping-promise identity is not proved by sequential ticks |
| C39 | nextDueMs: base, idle multiplier | keep: capped arithmetic matrix is not implied by consumer transitions |
| C40 | a malformed CP_CI_WATCH_SECONDS | keep: malformed configuration variants need individual consumer controls |
| C41 | the watcher writes only its own state file | keep: absence of unrelated writes needs its own control |
| C42 | state/ci-watch.json round-trips | keep: full schema rejection matrix is not covered by valid-state scenarios |
| C43 | an unreadable state file degrades | keep: corrupt legacy state lacks its own seeded consumer control |
| C44 | confirming the same key twice is a no-op | mapped: NC-42 removes confirmation deduplication; fails `arrival is idempotent`, actual repeated key, expected [] |
| C45 | arrival evidence comes off the message | keep: parser negative-input matrix is not independently controlled |
| C46 | the notice is a headline plus facts | keep: exact notice/authorization wording assertions stay |
| C47 | the green notice sends the parent to cp_integrate | keep: forbidden gh advice and integration wording have no own control |
| C48 | a red notice asks no merge question | keep: notice wording is not pinned by the state assertions |
| C49 | picp-wzq: a red notice names the failing run | keep: link selection and stable key have no own consumer control |
| C50 | REST parsing: the PR url | keep: exact transport field normalization remains independently checked |
| C51 | green: verdict returns promptly | keep: deadline continuation without parent turn needs its own control |
| C52 | HELD PR WAITING names deadline ownership and a ${hold} | keep: all sampled hold states and read counts remain protected |
| C53 | deadline resumes through the ${guard} | keep: all generated guards and no-mutation assertions remain protected |
| C54 | restart arms only the remaining interval | keep: remaining/expired deadline and no-rearm variants lack controls |
| C55 | a valid new head/generation replaces the timer | keep: cancellation and replacement interleavings are not covered |
| C56 | synchronous patch equivalence releases the lane | keep: equivalence/review lane handoff has no own control |
| C57 | 4B1-T6: driving(job) is true | keep: throwing-step driving cleanup remains independently asserted |
| C58 | a landed continuation relays once | keep: wake suppression versus actionable stop distinction lacks control |
| C59 | a HELD PR LANDED notice carries no tracker advice | keep: removed tracker advice is an explicit retained contract |
| C60 | jje.2 revise: a revise verdict | keep: revise must not trigger continuation; no own consumer control |
| C61 | jje.2 serial: two held PRs | keep: shared project lane overlap is not proved by one job |
| C62 | jje.2 red: a failed head stops visibly once | keep: duplicate event/promotion suppression needs its own control |
| C63 | human_handoff: one durable notice | keep: handed-off notice identity and human merge are not controlled |
| C64 | awaiting_merge PR6: a handoff that parked | keep: stale parked continuation/wake suppression remains checked |
| C65 | jje.2 stale: a moved head | keep: reopened generation and phase exclusions lack controls |
| C66 | jje.2 wait/retry/pending | keep: operational faults and review deduplication are not controlled |
| C67 | jje.2 restart: startup resumes every held PR | keep: restart startup multiplicity is not tested by one live process |
| C68 | unload-parent PR2 drain: no step while draining | keep: drain/resume key consumption has no own control |
| C69 | unload-parent PR2 drain: a drain that starts mid-sequence | keep: mid-step drain interleaving is not independently controlled |
| C70 | unload-parent PR2: a landing calls onLanded once | keep: throwing callback must not undo landing; no consumer control |
| C71 | jje.2: a CI/PR watch tick that throws | keep: per-cause durable error deduplication remains checked |
| C72 | jje.2 generation: a CI fact carries the generation | keep: reopened generation identity has no own control |
| C73 | rerunwake-12z: a new CI attempt is a new continuation fact | keep: continuation replay differs from watcher notification; NC-32 is insufficient |
| C74 | jje.2 interleaving: phase, generation and head | keep: before-every-step rechecks need interleaving controls |
| C75 | jje.2 wait re-arms | keep: settled wait versus in-flight replay distinction lacks control |
| C76 | jje.2 review interleaving | keep: stale trigger during review step remains independently checked |
| C77 | jje.2 lagged watcher | keep: newer remote head during a step has no own control |
| C78 | jje.2 snapshot | keep: startup snapshot versus later head/generation change stays |
| C79 | jje.2 fail closed | keep: unreadable owning head must not advance; no own control |
| C80 | onCi records its outcome per CI key | keep: outcome persistence and pending review deduplication stay |

## tests/main-ci.test.ts — 39 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| M01 | row 1: a failure on the fetched tip latches once | keep: workflow and failing-line payload need their own control |
| M02 | row 1: no matching log line | keep: fallback job-name selection is not independently controlled |
| M03 | row 1: a failure fires at once | keep: mixed pending/red timing variant lacks an own control |
| M04 | row 2: nothing latched | keep: all green/pending/empty silence variants remain checked |
| M05 | row 3: a repeat red | keep: repeat/new-tip red latch identity lacks its own control |
| M06 | row 5: stale green on an old sha | keep: actor-filter NC-35 does not specifically break stale-green suppression |
| M07 | row 4: green on every run | keep: exact once-only notice and clear assertions lack own control |
| M08 | row 6: git or gh failures | keep: inconclusive read/error matrix remains checked |
| M09 | row 7: an unreadable main-ci.json | keep: corrupt persisted state must not be overwritten |
| M10 | per project: one project's latch | keep: multiple-project isolation is absent from the one-project case |
| M11 | row 8: a project with no clone dir | keep: no-command skip has no own control |
| M12 | tick: one red transition sends exactly one wake | keep: refused-send reporting and multiplicity lack own control |
| M13 | formatMainCiNotice: red and green wording | keep: exact wording is not implied by persisted latch state |
| M14 | classifyMainTip ignores every run | keep: full classifier field assertions lack own control |
| M15 | mainRedHold: fails open with a fact | keep: fail-open and latched hold gate need own controls |
| M16 | cp-oc0m: a dynamic run | keep: NC-35 combines actor/event changes; full declaration lacks own control |
| M17 | cp-oc0m: another user's or a bot's run | keep: bot and case-insensitive login matrix is not independently controlled |
| M18 | cp-oc0m: a re-run counts | keep: rerun actor versus original actor lacks an own control |
| M19 | cp-oc0m: without an active mandate | keep: absence of all commands, including login, is not controlled |
| M20 | cp-oc0m: an unreadable login | keep: unreadable login diagnostic and unchanged file stay checked |
| M21 | cp-oc0m: a pre-change row is released | keep: seeded legacy/foreign rows lack their own consumer controls |
| M22 | cp-oc0m: memoLogin asks gh once | keep: memoization, retry and login validation stay checked |
| M23 | cp-oc0m: mainRedHold enforces only an own row | keep: enforced-scope and no-row scope-read matrix lacks controls |
| M24 | cp-oc0m: resolveMainCiScope | keep: grant/login fail-open matrix lacks own controls |
| M25 | cp-oc0m: the Actions query carries event | keep: raw field transport and counted filter are not separately controlled |
| M26 | main CI: an unreadable jobs read | keep: malformed runs/jobs read failure variants remain checked |
| M27 | formatMainCiNotice: released wording | keep: exact release wording has no own consumer control |
| M28 | PR1: an attempt-1 Install treehouse failure | keep: main-specific claim/rerun/latch sequence lacks an own control |
| M29 | PR1: a suite failure on main | keep: no-claim/no-rerun assertions lack an own control |
| M30 | PR1: a refused gh run rerun | keep: retained claim after rerun refusal remains independently checked |
| M31 | classifyInfraFailure: setup steps | keep: inherited classifier fixture variants still lack separate controls |
| M32 | attempt 2, a test failure, a cancel | keep: inherited complete guard matrix remains protected |
| M33 | paths: exact head | keep: inherited malformed identifiers and exact paths remain protected |
| M34 | readActionsCi: normalizes runs | keep: inherited normalization fields lack individual controls |
| M35 | retry: never past the budget | keep: inherited injected-clock budget and JSON structure checks stay |
| M36 | budget: one total deadline | keep: inherited per-request remaining deadline assertions stay |
| M37 | statusRunner: forwards each request's remaining budget | keep: inherited timeout forwarding and thrown status stay |
| M38 | ciReadDenied: only a permission refusal | keep: inherited negative classification inputs remain checked |
| M39 | the browser mirrors the backend's Actions-only label | keep: inherited viewer source parity is not consumer-tested here |

## tests/foreign-ci-watch.test.ts — 11 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| F01 | selection: an open job naming a PR | keep: closed/other-repo/own-delivery exclusions need own controls |
| F02 | green runs on the head give one ci_green | keep: deduplication and exact base-repository query lack an own control |
| F03 | a moved head gives head_moved once | keep: NC-34 breaks head_moved, but full once-only and re-derived CI assertions need separate controls |
| F04 | a merged PR gives pr_merged | keep: unreadable-PR dropping and terminal no-query assertions lack controls |
| F05 | a failing query backs off | keep: exact backoff and per-tick cap remain independently checked |
| F06 | the store is a total read | keep: corrupt file recovery lacks an own seeded consumer control |
| F07 | evidence only: the ports are read-only | keep: absence of merge/wake/wait APIs remains explicitly checked |
| F08 | ghForeignRuns reads Actions runs | keep: attempt-job path and unreadable-versus-empty transport checks stay |
| F09 | the reviewer gate waits for CI | keep: timeout expiry and brief state need independent consumer controls |
| F10 | binding (c) holds for the head | keep: dispatch-time fresh-head gate lacks its own valid semantic control |
| F11 | CommandPost.dispatch arms a waiting reviewer | keep: automatic release/start-once behavior is not proved by rejected dispatch |

## tests/parked-ci.test.ts — 3 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| P01 | parked CI: head A green | keep: exact reread counts and journal multiplicity are not controlled by NC-36 |
| P02 | parked CI: a permission denial | keep: transient unknown and exact backoff assertions need own controls |
| P03 | parked CI: a resume or re-park | keep: in-flight generation/phase races lack a consumer barrier control |

## tests/ci-evidence.test.ts — 5 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| E01 | recordForwardedCi: stores source forwarded | keep: complete timestamp/URL and distinct-result storage assertions lack own controls |
| E02 | recordForwardedCi: refuses a short or moved head | keep: full secret/URL/repository rejection matrix is not proved by NC-33 |
| E03 | recordForwardedCi: keeps the newest | keep: bounded observation retention needs a dedicated overflow control |
| E04 | forwardedCi (viewer) | keep: legacy/native/head selection and URL filtering need viewer controls |
| E05 | cp_integrate record_ci | keep: unknown-head refusal is not proved by the current-head scenario control |

## tests/integrate-held-ci.test.ts — 3 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| H01 | CI observation repairs without parent notice delivery | keep: duplicate/manual serialization and repair-request contents need own controls |
| H02 | startup repair and restart preserve | keep: NC-37 proves live allowance, not restart persistence or all failing report variants |
| H03 | held repair uses real Sender permission | keep: full expired/eligible/refused grant and revival matrix lacks own controls |

## tests/awaiting-merge-tick.test.ts — 2 declarations

| ID | Unique declaration prefix | Disposition and reason |
|---|---|---|
| T01 | a lock taken after session_start | keep: exact lock loss/reacquisition timer behavior lacks its own consumer control |
| T02 | session_shutdown clears the startup catch-up | keep: removal of both pending callbacks after shutdown lacks an own consumer control |
