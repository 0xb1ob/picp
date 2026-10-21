# S03 work log

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

Scope: tests/ci-watch.test.ts declarations 41–80, last range; S02 and S07 carry-ins. No source unit has been deleted yet. Mapping remains in progress; the passing scenarios alone do not authorize retirement.

## Executed controls (restored immediately)

Commands use `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.

| ID | Production mutation | Pattern | Observed assertion failure |
|---|---|---|---|
| S03-authority | src/ci-watch.ts: replace the green evidence/authorization/Awaiting row/merged disclaimer with `CI finished.` | landing S03: actual parent | /evidence, not authorization/i fails on the actual CI message, excluding the system prompt |
| S03-confirm | src/ci-watch.ts: remove `if (existing.announced.includes(key)) continue;` | landing S03: corrupt | duplicate arrival changes nothing: actual [key], expected [] |
| S03-corrupt | src/ci-watch.ts: read() JSON catch throws CiWatchError instead of returning EMPTY_CI_WATCH_FILE | landing S03: corrupt | corrupt memory is forgotten, not a failed read: actual 1, expected 0 errors |
| S03-delivery | src/ci-watch.ts: remove delivery !== pr guard | landing S02: only reported | checked exclusion fails for delivery local |
| S03-receipt | src/ci-watch.ts: absent receipt returns true | landing S02: only reported | checked exclusion fails for receipts [] |
| S03-landed | src/ci-watch.ts: status comparison becomes status !== merged | landing S02: only reported | checked exclusion fails for landed receipt |
| S03-blocking | src/ci-watch.ts: ghPrRest invokes gh run watch 12345 instead of gh api pulls | landing S02: watcher queries | watcher command run watch 12345: detectCiWait returns blocking_watch, expected undefined |
| S03-exclusions | src/ci-watch.ts: isWatched returns true; variants are independent subtests | landing S02: only reported | all 11 exclusions fail individually (waiting/done/failed, local/pipeline, empty/artifact receipts, merged/landed/MERGED/trim); no variant is masked by an earlier failure |
| S03-eligible | src/ci-watch.ts: isWatched returns false | landing S02: only reported | the eligible delivery is queried: actual undefined, expected ci_green |
| S03-advice | src/ci-watch.ts: replace two green integration-advice strings with Verify CI yourself and check ancestry with gh pr view | landing S03: actual parent | /cp_integrate/ fails on actual delivered CI message |
| S03-red | src/ci-watch.ts: replace red policy strings with Ask whether to merge the failing run | landing S03: actual parent | /Merging red is forbidden/ fails on actual delivered red notice |
| S03-failed-run | src/ci-run-ref.ts: failedRunOn returns runs[0] | landing S03: actual parent | only the failing run is named: actual false (skipped run 300 replaces failing run 302) |
| S03-generation | src/held-continuation.ts: remove generation mismatch guard | landing S03: facts changed | generation subcase returns stopped at reviewer selection instead of stale; will be repeated with the newly configured mock reviewer before final mapping |
| S03-pending | src/held-continuation.ts: replace pending-review guard with false | landing S03: new CI | a new fact reaches the already-pending review gate: actual stopped, expected review_pending |
| S07-NC-3 / NC-37 rerun | src/integrate.ts: replace cumulative prior allowance with 0 | landing: held CI repairs the same | restarted parent reads the spent allowance before looking for a local worker: expected /already asked once/, actual no live worker; assertion follows observed startup timestamp change, with no manual integrate call |

## Positive verification

The complete tests/e2e/landing.test.ts passed after these controls were restored: 23 cases, zero failures/skips. Root typecheck passed before this scenario batch; it must run again before final delivery. The four S03 scenarios cover corrupt memory/arrival, actual parent notices, durable deadline guards, and changes during a blocked forge read. Declaration-specific controls and bookkeeping remain to be completed.

The existing harness creates an isolated throwaway agent directory through createAgentDir, configures only the mock provider, and removes it in t.after. No operator credentials or installed agent configuration are used.
