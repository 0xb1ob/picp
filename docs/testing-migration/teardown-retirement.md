# Teardown retirement: incomplete evidence

Base verified with `git rev-parse 53f8a8820638`:
`53f8a8820638cc4a4f85ccbe69f665d29583a807` (#492).

This is a partial delivery, not retirement approval or completed equivalence.
The original `tests/teardown.test.ts` remains intact, including declarations
18, 35 and 54. No deletion credit, retained-body extraction, final census or
51-mapped/3-retained claim is made.

## Completed consumer changes

- S17 successful-return reporting now uses base-ignored entries and a tracked
  nested package. It asserts exact ignored paths (`backtest/`,
  `pkg/sub/out.log`), formatter text, exclusion of top-level and nested
  `node_modules`, and surviving bytes for all four entries.
- S18 startup first proves an actual CommandPost lease return reaches the
  treehouse shim, checks the logged return command, clears the log, and then
  reconciles with zero startup calls. The same CommandPost environment runs
  both observations. Shim cleanup is in finally.
- S18 prose now distinguishes answer directory permissions from pipeline
  multiline ledger schema failure. Existing formatter/recovery assertions stay.

## Executed PATH control

Patch: `docs/s18-controls/startup-path.patch`.
SHA-256: `b639b254e9d46c6df5c8f9c9001120785d479f1d655838ade0a82fb6e62da7ac`.
Mutation moves the shim to `treehouse-off-path`; it leaves the real executable
available so return itself succeeds. Command:

```
npm run test:one -- --test-name-pattern='S18: done research' tests/e2e/teardown-s18.test.ts
```

Mutated run: exit 1, assertion `CommandPost lease return must reach the startup
shim`, actual false, expected true. Mutation restored through hashline undo;
restored selected case passed; restored full S18 passed 14/14 with zero skips.
`git apply --check docs/s18-controls/startup-path.patch` passes.

S17 full file passed 32/32 with zero skips. Static source declarations are not
these runtime totals. Typecheck, regression-verifying migration checker and
shard check passed. Mandatory contract eval passed 22/22; golden regeneration
produced no content change; the clean golden rerun passed.

## Outstanding retirement gates

Execution budget did not cover the full retirement proof. Continue this same job:

1. Read/map all 54 original declarations and each assertion against final cases.
2. Execute declaration-30 preservation, reporting, dependency-filter and formatter
   production controls; passing new reporting assertions alone earn no credit.
3. Replay all 33 inherited S17 and 18 inherited S18 controls, every credited
   variant, recording exact hashes, assertion failures and restored passes.
4. Extract declarations 18/35/54 verbatim with their helpers and missing-entry-point
   reasons; prove byte-identical bodies and run the retained file.
5. Only then retire original, reconcile stale S17/S18 pending-fix accounting,
   references, timings and manifest counts; re-run required focused checks.

Historical S17/S18 ledgers remain historical evidence, not final replay proof.
No product mutation is kept. No production source was changed.
