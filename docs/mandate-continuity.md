# Continuing admitted mandate work

Home and project default expiry closes admission to new work. It does not require a new grant to finish proven, unfinished named work. This policy applies to existing homes without changing saved settings. An explicit expiry remains a completion deadline.

`cp_next` and direct permission preflight prepare continuation when typed evidence proves the original admission. `cp_mandate(action: "continue", source_id: G)` exposes the same operation. It returns a fixed receipt and `committed`, `ineligible`, or `confirmation_required`, with a reason and escalation ID where applicable. Preparation alone grants no permission.

The original grant retains its expiry, scope, exclusions, baseline, USD cap, job cap, and accounting root. Existing token raises still follow that root's ceiling policy. Worker and reviewer expenses, including completed members and late charges, continue to count. A newer project grant does not refill a committed continuation's budget. Independently authorized fresh work retains normal selection.

## Evidence and existing homes

Named issue and enrollment capture the job's project, kind, scope digest and admission time. Existing typed membership and historical evidence can reconstruct admission. Missing or ambiguous evidence opens one existing `product_ambiguity` escalation, bound to the exact source, ordered jobs, full governing inputs and original limits. Inspect its evidence, answer through authenticated `cp_decide`, then repeat `continue` with `confirmation_escalation_id`. Denial, withdrawal or changed scope refuses continuation.

`replacement_id` identifies an obsolete-coverage replacement grant. An ID, matching title or matching project proves no relationship. If an authenticated typed mapping does not exist, confirmation must establish both the original admission and that exact coverage relationship. Confirmation records the mapping without revoking history or transferring funding to the newer grant. A generic supersession message is insufficient.

Pause, revoke, explicit deadline, fulfillment, exclusions, exhausted limits, schedule authority, changed project/kind and newly added scope remain binding. Oversize or missing governing inputs refuse before authority commits; no partial scope is substituted.

## Original work and successors

For the original job O, normal `cp_dispatch` uses its frozen task; a live worker continues through `cp_send`. Continuation itself changes no dependency.

After O's actual revise and normal closure/teardown, create fresh research R with `cp_job create`. Then call:

```text
cp_mandate(action: "replace_work", source_id: G,
           original_job_id: O, replacement_job_id: R)
```

The operation returns the fixed link, original work identity, original accounting root and prepared task file. Dispatch R using that file. R's post-expiry creation does not become a new admission. R is an alias of O's admitted work, with all original task and mandate text, ordered addenda, actual findings and consumed gate history. Additional scope, an existing worker or artifact, competing links and stopped/capped roots refuse. Interrupted preparation resumes with the same IDs and cannot authorize dispatch prematurely.

For example, an original $100 cap with $9.95 spent leaves $90.05 across O and R together. A 10,000,000-token cap with 103,200 consumed leaves 9,896,800. Alias creation resets neither balance. Aliases count as one logical job; simultaneous workers still consume parallelism.

## Pipeline and dependency handoff

`cp_pipeline(action: "reanchor", research_id: O, replacement_research_id: R)` retains the same ship and inherited gate attempts. It changes only the recorded blocking research edge. Pending or spent authorization, declined checkpoints and implementation already started refuse reanchor. An interrupted projection reports preparation explicitly; retry the same IDs before dispatch or advance.

Register ordinary dependents with:

```text
cp_gate(action: "handoff", job_id: R, source_job_id: O,
        dependent_job_ids: [D])
```

Registration freezes the exact edges and complete inputs, returns `handoff_id` and `waiting_review`, and removes nothing. Typed pipeline provenance can establish a mechanical edge. Unknown provenance opens an exact mechanical confirmation through the existing escalation flow; it cannot clear arbitrary holds.

Run the normal `cp_gate(job_id: R)`. After actual current PASS and normal R closure, repeat the same handoff. Only its recorded O edge becomes the satisfied R edge. Other substantive and unrelated blockers remain. Copied PASS, revise/escalate, moved scope or inputs, changed edges, missing closure, pending decisions, root stops and exhausted caps cannot commit it. Prepared projection blocks dependent dispatch until replay commits. Committed replay verifies the same inputs, PASS and edges without granting new authority.

## Recovery compatibility

Expiry alone no longer requires capped recovery or a replacement grant for proven admitted work. The existing recovery operations remain available for their independently authorized cases. Their attempt, finalization, spawn and full-input controls remain in force: continuation neither manufactures PASS nor replenishes consumed review credit.

Public mock coverage lives in `tests/e2e/mandate-continuity.test.ts`; existing authority, recovery and mission suites remain required. No live-model or migration prerequisite is introduced.
