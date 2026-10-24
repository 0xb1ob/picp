# cp-1fmp partial execution — no retirement credit

Execution/source base: `8a0b54702fd0325e2483cd6ff52746eb838f8f15` (PR500 merged).
Production was restored with the hashline undo tool before the restored run.
Original coverage is intact: 144 static declarations, 152 expanded cases. Nothing is retired.

S09-NC12 was applied alone in `src/integrate.ts`: disable `if (error || !receipt)`.
Both runs used:

```
node --import ./tests/harness/hermetic-env.ts --test --test-force-exit --test-name-pattern='landing S09: a missing implementer' tests/e2e/landing-s09.test.ts
```

The mutant exited 1 at landing-s09.test.ts:326: actual resolve, expected surface.
Restored run exited 0, one case, zero skips. This is preparation only, not final-state proof.

SHA256:

```
eba4c9c401070b95e21ce9df6eaa9dfc1147478abd63e50f0bd6097f93dcf917  cp-1fmp-S09-NC12.patch
b44626fdcf8e33fdb6d263553aa8a7ba8493326cf7cbf43c27e9bee80ad71dc4  cp-1fmp-S09-NC12-fail.log
cb61d558af659dc51c353d1406e0daa362bb94418155ee49d62c81118bece015  cp-1fmp-S09-NC12-restored.log
```

`cp-1fmp-M-baseline.log` is interrupted output: the command exceeded its 200-second tool budget.
It is neither a failing consumer assertion nor a complete baseline pass; it earns zero credit.
No timeout was raised. The remaining full baseline and final-state mutation matrix were not completed.
Retirement remains blocked on those unexecuted proofs; this is an execution limitation, not an external prerequisite.
Historical missing logs remain missing. Existing patches/logs are unchanged.
