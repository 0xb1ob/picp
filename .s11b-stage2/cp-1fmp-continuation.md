# cp-1fmp continuation — baseline and S09 preparation

Execution HEAD `869c47a45d54c7e425ba4fbb25019b4490833db8`; production source base remains
`8a0b54702fd0325e2483cd6ff52746eb838f8f15`. All mutations were isolated and restored before the matching pass.
Originals remain intact; zero retirement or final-state credit.

All five full baseline commands `npm run test:one -- tests/e2e/<file>.test.ts` completed successfully:
landing-merge 83, landing-s09 62, landing-review-window 17, landing-ci-watch 27, landing-s11 50;
all zero failures and zero skips. M retry used a 600-second shell budget, with no test timeout changes.
The C call interrupted by machine restart had no result and no surviving process after restart;
its incomplete log earns no credit. The retry completed with recorded exit 0.

New isolated controls all exited 1 at named consumer assertions, then 0 with restored production:

| Control | Mutation | Observed failures |
|---|---|---|
| S09-NC07 | disable failed-CI gate | red/second/test wait instead of resolve; infra loses rerun reason |
| S09-NC08 | disable conflict gate | conflict first step ci instead of conflict |
| S09-NC10 | disable permission-head and armed-auto-merge gates | moved advance instead of wait; auto advance instead of surface |
| S09-NC11 | send drafts directly to ready | unreviewed-draft and stale-draft surface instead of review |

Commands used the existing hermetic preload, `--test --test-force-exit --test-name-pattern=<selector>` and
`tests/e2e/landing-s09.test.ts`. NC07 selector: `landing S09: (a real repair|infra reruns)`;
NC08: `landing S09: a real repair`; NC10/11: `landing S09: repository refusals`.
Full matching scenarios ran without leaf skips, with 600-second shell budgets.
Exact patches and fail/restored logs use `cp-1fmp-S09-NC<nn>` prefixes.
`cp-1fmp-continuation-SHA256SUMS` records their SHA256s and baseline log hashes.
Historical missing evidence remains missing. Typecheck passes after restoration.
