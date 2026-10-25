# cp-dpmo fresh control checkpoint

Original coverage remains intact; zero retirement credit. Baselines and retained comparison completed before this control; see exported job artifact `cp-dpmo/proof/`.

Governing handoff: `/home/ubuntu/.pi-command-post/state/artifacts/cp-1fmp/remaining-brief-cp-dpmo.md`, SHA256 `ed45f8f958e75b0e5d5deb55f472827e4a88aebba044e0422c6ea5447a863c09`. Full governing package: `/home/ubuntu/.pi-command-post/state/artifacts/cp-1pl1/report.md`; inventory: `/home/ubuntu/.pi-command-post/operator/scratch/migration-recreation/manifest.json`.

S10 dirty executed on base `1f6a9023c8cc19e572fd372f30f5e440356a0a72`. Production blob `src/integrate.ts`: `e63f33abfa61f6c3507510cf625ec2f72da42387`; consumer blob `tests/e2e/landing-merge.test.ts`: `817dd847dd5e5b3f9237167227ec46fbbcfaa2b8`.

Command for both mutation and restoration:

```
npm run test:one -- --test-name-pattern='landing S10:.*synchronization' tests/e2e/landing-merge.test.ts
```

Mutation exit 1: `dirty` fails with `AssertionError [ERR_ASSERTION]: dirty: reset requires proof`, actual hard-reset argv versus expected `[]`. Restored command exit 0. Source restored with hashline undo before the passing run. Typecheck passed after restoration. This is fresh preparation proof, not completed final-state proof.

| File | SHA256 |
|---|---|
| cp-dpmo-S10-dirty.patch | 162b4f5e6d3c5b9c548b6bf1f24d291ca191df77f22929a6ba80db40d01d19bd |
| cp-dpmo-S10-dirty-fail.log | 30762ac335494fc481ee4a5c2965949ac8a426aa72c6f195322968ea2e94e613 |
| cp-dpmo-S10-dirty-restored.log | 598215ca56b326fd78c93afabef648e1713d6e51388696dd9ce1ea24dfd6343b |

All other required mutation controls remain pending. Historical missing logs stay missing. No production changes ship.
