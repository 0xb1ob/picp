# cp-1fmp fresh S10 preparation and size boundary

Execution HEAD: `c3de778f0ba123ec9b26290e64c3ac8712d15634`; production source base remains
`8a0b54702fd0325e2483cd6ff52746eb838f8f15`. No production changes remain.
All three controls ran independently, exited 1 at consumer AssertionError, were restored, and reran to exit 0.

| Control | Selector | Required observed failure |
|---|---|---|
| S10-review-pass | landing S10: review evidence | pass/equivalent/approved: review instead of advance |
| S10-ci-refusal | landing S10: unreadable forge | rate/permission/jobs-denied/jobs-partial/jobs-malformed: advance instead of retry |
| S10-cleanup-retry | landing S10: cleanup failures | delete/close: wait instead of retry |

Each command used `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit
--test-name-pattern='<selector>' tests/e2e/landing-merge.test.ts` with the selector above on one shell line.
No leaf was skipped. Exact patches, fail and restored logs have the matching `cp-1fmp-S10-` prefix.
`cp-1fmp-S10-SHA256SUMS` records exact patch/log hashes. Typecheck passes after restoration.
These are preparation runs with originals intact, not final-state proof.

An alternate index containing every current proof file and deletion of `tests/integrate.test.ts` measured
280,322 bytes against origin/main BEFORE this metadata and its hashes. This already exceeds the strict
280,000-byte cap, while full S08, remaining S10/S10b and every final-state replay are still outstanding.
The actual candidate patch is exported to the job artifact, not committed or used to delete coverage.
At least one additional evidence-only delivery must precede retirement; its final size must be measured again.
No ceiling increase, proof removal, new branch or new PR is proposed by this worker.
Originals remain: 144 declarations, 12 byte-identical retained calls, zero retirement credit.
