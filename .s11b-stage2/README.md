# S11b stage2 fresh proof — increment 1

Job cp-migration-s11b-stage2-89t1, PR500. This is fresh evidence, not recovered historical logs.
Original integration coverage remains intact. No retirement credit is claimed.

`base-identities.txt` records the execution HEAD and origin/main, in that order.
`source-identities.txt` pins the production modules and S11 consumer. `SHA256SUMS` hashes the exact patches,
logs and retained comparison. Each patch came from `git diff -- <mutated production path>` while applied alone.
Each run used the existing public mock-provider consumer and the command printed in its log.
Mutations were undone with the hashline undo tool before the matching restored command and the next mutation.
All `*-fail.log` runs exited 1 at consumer AssertionError; all `*-restored.log` runs exited 0.
The timeouts were unchanged (test runner 300000 ms); compilation/setup/timeouts earn no proof credit.

Run the retained extraction check with `node .s11b-stage2/compare-retained.mjs` from the repository root.
It asserts 144 original / 12 retained static declarations, fixed original identities, equal titles and exact
AST test-call source slices. `retained-comparison.json` records both file SHA256s and each matching call hash.
The original and retained expanded suites previously passed 152 and 15 cases. `J-baseline.log` records 50 passing
S11 cases with no skips; W and C baseline invocations also passed 17 and 27 expanded cases in this continuation.

| Control | Required consumer outcome observed under mutation |
|---|---|
| S11-C01 | blocked advance / conflict resolve instead of surface; continuation blocker absent |
| S11-C02 | unreadable report advance instead of surface |
| S11-C03 | mid-CI CLEAN advance instead of surface |
| S11-C04 | mid-CI fallback advance instead of surface |
| S11-C05 | approved review instead of merge; approved-draft resolve instead of advance |
| S11-C06 | later-push fix attempts forbidden merge |
| S11-C07 | later-report and later-PR merge asks incorrectly raised |
| S11-C08 | declined and mandate decisions promote |
| S11-C09 | research delivery rejection absent |
| S11-C10 | worker instructions lack fetch-and-merge command |
| S11-C11 | legacy checkpoint IDs absent from public snapshot |
| S11-C12 | all eight eligible handoff variants wrongly merge/update or surface |
| S11-C13 | clean handoff surfaces; dirty parking loses Not parked cause |
| S11-C14 | unreviewed and strict-unreviewed heads park; changed head bypasses review |
| S11-C15 | red fix attempts merge; pending/superseded/red/strict-pending handoffs park |

Existing exact scenario selectors are printed verbatim in each pair of logs. The inherited matrix in the
readiness package and docs/testing-migration/s11.md gives the original declaration mapping. Other controls
remain outstanding; this increment alone never permits original-file removal.

## Increment 2

`base-identities-2.txt` and `source-identities-2.txt` pin the next batch (HEAD 5f71217); production is unchanged.
`SHA256SUMS-2` hashes its exact patches/logs. Each command is printed in the corresponding logs.
All fifteen isolated mutants exited 1 with the following named AssertionError failures; all restored commands exited 0.
S10 and S11 already contain S10b supersession pointers for watcher 71 / integrate 92; no pointer edit is needed.
The contract suite also passed (`contract.log`). No original was removed.

| Control | Required consumer outcome observed under mutation |
|---|---|
| S11-C16 | both human-merged done/blocked deliveries surface instead of done |
| S11-C17 | empty observed base incorrectly parks |
| S11-C18 | explicit repo policy reaches handoff permit instead of merge |
| S11-C19 | another PR incorrectly promotes |
| S11-C20 | pre-promotion moved head incorrectly promotes |
| S11-C21 | later report generation incorrectly reaches merge |
| S11-C22 | truncated capped review incorrectly promotes |
| S11-C23 | pending final-fix decision loses awaits-a-human guidance |
| S11-C24 | checks and unstable states incorrectly park |
| S11-C25 | unknown mergeability incorrectly parks |
| S11-C26 | unreadable permission and workflow states incorrectly mint merge checkpoints |
| S11-C27 | reviewed draft surfaces instead of proceeding through ready |
| S11-C28 | changed-head legacy handoff creates two rows instead of one |
| S11-C29 | independently answerable checkpoint IDs shrink from four to two |
| S09-NC01 | older branch CI surfaces instead of waiting |
