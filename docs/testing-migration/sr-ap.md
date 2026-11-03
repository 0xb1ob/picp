# Ledger rows: sr-ap

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| Self-review AP (cp-sr-ap-guidance-ky3d) | Guidance only, no behaviour change: `AGENTS.md` §Escalation and the `cp_escalate`/`cp_decide` descriptions in `extensions/command-post/tools-mandate.ts` say withdrawal, planner closure, decline/deny/replan/drop, restart or ledger close never release an authority hold, name the refusal's remedy (`cp_decide` the live id, or `cp_escalate action:replace` then `cp_decide` the replacement `approve`), need a fresh `cp_gate` for a changed plan and answer a hold with an option id; no test added, changed or deleted | 0 |
<!-- /manifest:ledger -->
