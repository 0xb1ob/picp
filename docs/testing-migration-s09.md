# S09 declaration evidence (in progress)

Ownership: the remaining behavior-05 files are owned by P3c-rest and re-sliced by operator decision ask-c77a4f32b23b (Raise cap to ~$2,700 on Sol); slice list operator/scratch/e2e-migration-slices.md; rule v2 applies.

Range: tests/integrate.test.ts declarations 41–80; the source unit file stays whole. No deletion credit.

Executed controls (temporary production mutations restored immediately):

- S09-NC-1: disable the `else if (older.length)` assignment in src/integrate.ts. Run the S09 exact-head scenario selecting `older`. It fails the next assertion: surface instead of wait. This preserves the branch-run superseded distinction (declaration 44).
- S09-NC-2: replace `if (ci.ci !== "green")` with `if (false)` in src/integrate.ts. Run all subcases of `landing S09: exact head and branch evidence distinguish pending, superseded and absent CI`. All twelve fail: pending/older advance instead of wait; present, denied/malformed/invalid branch, branch-green, and all four unreadable-workflow modes advance instead of surface; none lacks the authoritative-empty fact. This breaks each CI refusal/configuration behavior separately through the public consumer (41–50, excluding approval-after-unknown, which still needs its own assertion/control).
- S09-NC-3: add BLOCKED and UNSTABLE to PERMITTED_MERGE_STATES in src/merge-permission.ts. Five permission subcases fail next: advance instead of surface (blocked, unreadable-rules, unstable, no-ci-blocked, reminder).
- S09-NC-4: at entry to Integrator.#ready, return a valid permit/surface record with reason draft readiness unavailable. Ready and ready-unreadable-ci fail next (surface instead of advance); ready-moved fails next (surface instead of wait); refused-ready and refused-undo fail their named error assertions. An earlier trial used an invalid step name and earns no evidence credit.

Replay: `node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='landing S09: exact' tests/e2e/landing.test.ts`.
