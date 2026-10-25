# cp-dpmo increment 2 — evidence-only continuation

Parent scheduled retirement as cp-xwu0, dependent on this evidence delivery. The earlier candidate-deletion size stop is historical; PR503 now delivers remaining evidence only, all 144 originals intact. No retirement credit. Full remaining matrix still gates evidence completion.

Execution HEAD `ae165b9815dd0a5493e99c5141b54cb831ebbe40`; base `aef9518a924ddd2bcab69bf3a8ca9fdd7ca05e19`.
Production integrate blob `e63f33abfa61f6c3507510cf625ec2f72da42387`, held-continuation blob `93f2392fadb411b3fae329b685e60d1a76c66c8f`; merge consumer blob unchanged from increment 1; S09 consumer blob `cbf9ec09d8d809ae956d78e02a038eb77a8b22df`.

Each row used `npm run test:one -- --test-name-pattern='<selector>' tests/e2e/<file>.test.ts` for both fail and restored runs. Every mutant exited 1 at named AssertionError; every restored run exited 0, all zero skips. Sources restored with hashline undo before restored runs. Exact patch and logs named `cp-dpmo-S10-<control>*`; `cp-dpmo-SHA256SUMS-2` hashes all bytes.

| Control | Selector | File | Named failure |
|---|---|---|---|
| prune | landing S10:.*rescue | landing-merge | retained-ref arrays, refusal causes and empty spurious fact |
| ref-scope | landing S10:.*rescue | landing-merge | cleanup must preserve main |
| review-gate | landing S10:.*review evidence | landing-merge | missing/moved/nonpassing/truncated/fallback review bypass |
| missing-gh | landing S10:.*unreadable forge | landing-merge | missing executable retry instead of surface |
| rebase | landing S10:.*cleanup failures | landing-merge | OPEN advance instead of cleanup refusal |
| retry-notice | landing S10:.*cleanup failures | landing-merge | forbidden nothing-was-mutated wording |
| reminder-dedupe | landing S09:.*repository refusals | landing-s09 | reminder row count 2 instead of 1 |
| reminder-withdraw | landing S09:.*repository refusals | landing-s09 | reminder open instead of withdrawn |

Typecheck passed after restoration. This brings executed fresh S10 controls to 13/25; remaining controls and other inherited matrices remain pending.
