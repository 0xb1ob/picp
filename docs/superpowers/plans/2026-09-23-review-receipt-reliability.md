# Diff Review Receipt Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A valid diff-review observation becomes a schema-valid decision and parent wake-up; a failed finish cannot leave a held PR silently waiting or replay the same invalid scratch verdict forever.

**Architecture:** Project gate-only fields out of `decideGate` before validating a `DiffVerdict`. On finish failure before persistence, reuse the existing operational-decision path; on a partial write or second finish failure, journal a durable recovery notice so parent cannot wait silently. Do not change gate schema or bypass review.

**Tech Stack:** TypeScript, Node 24 `node --test`, TypeBox contracts, existing `ReviewRuns` registry.

**Spec:** `docs/contracts.md` (diff review and asynchronous reviewer sections); incident evidence: `state/artifacts/cp-review-receipt-diagnosis-7sfv/report.md` in the live home (gitignored).

## Global Constraints

- `src/contracts.ts` keeps `DiffVerdictSchema` strict (`additionalProperties: false`); gate reviews may retain `decision_summary`.
- No verdict without a persisted decision on the exact head may authorize `cp_integrate`.
- No live `state/`, `data/`, or project checkout edits; regressions use scratch homes and mock reviewer scripts.
- Keep one reviewer per job/surface; no unbounded retries or manual deletion of `review-1/verdict.json`.
- Use a leased Treehouse worktree for implementation and publish the PR after tests.

## Review Focus

- Reviewer returns a valid object `decision_summary`: persist a pass without the extra key (Task 1).
- Reviewer returns no summary: ordinary pass behavior remains unchanged (Task 1).
- Finish throws before writing: record an operational attempt and wake parent once (Task 2).
- Finish throws after a decision was written: avoid a second conflicting decision and duplicate wake-up (Task 2).
- Same-head retry after an operational fault: use attempt 2, never stale attempt-1 scratch (Task 2).

## File Map

| File | Responsibility |
|---|---|
| `src/diff-review.ts` | Strip gate-only output fields from diff decision. |
| `tests/diff-review.test.ts` | End-to-end regression for `decision_summary`, persisted verdict, and wake-up. |
| `src/review-runs.ts` | Convert finish failures to one persisted operational decision where safe. |
| `tests/review-runs.test.ts` | Finish failure, partial-write, and retry registry cases. |
| `src/command-post.ts`, `tests/wakeup-journal.test.ts` | Journal durable recovery notice for a finisher failure with no safe verdict wake-up. |
| `docs/contracts.md` | Document finish-failure behavior after changing it. |

---

### Task 1: Project a Valid Diff Verdict

**Files:** Modify `src/diff-review.ts` (`#finish`, currently around line 781); test `tests/diff-review.test.ts` beside the existing `pass: the verdict is recorded` test.

**Interfaces:** `decideGate(...)` still returns gate fields; `DiffReview.#persist(...)` still consumes `DiffVerdict`. No public signature changes.

- [ ] **Step 1: Write failing regression.** Use `reviewBenchOf(t)`, `pushJobBranch(jobId)`, `shipRecord(jobId)`, `script(...)`, `verdictCall(jobId, { decision_summary: { would_make_wrong: "Omitting verification would approve unseen behavior.", verified: "Inspected the one-file diff and its test." } })`, `seal()`, and `review.reviewAndWait({ jobId, model })` as in the adjacent pass test. Assert `result.next === "proceed"`; read `paths.reviewFile(jobId, 1)` and assert `validate(DiffVerdictSchema, decision).ok`, no `decision_summary` property, `readPriorAttempts(...).attempt === 2`, one `b.sent` entry with `headSha === head`, and no `review_orphaned` in job events. Existing no-summary pass test is the control.
- [ ] **Step 2: Run red.** `node --test tests/diff-review.test.ts` must fail on missing persisted decision or a finish failure for the new case.
- [ ] **Step 3: Implement projection.** In `#finish`, destructure `decision_summary` beside existing `rubric` before spreading `decided` into `DiffVerdict`:

  ```ts
  const { raw, rubric: _rubric, decision_summary: _summary, ...decided } = decideGate({
  ```

  Retain existing arguments. Do not add the field to `DiffVerdictSchema` or remove it from gate results.
- [ ] **Step 4: Run green.** `node --test tests/diff-review.test.ts` and `npm run typecheck`; expected: new and existing pass tests green.
- [ ] **Step 5: Commit this self-contained change.** `git add src/diff-review.ts tests/diff-review.test.ts && git commit -m "fix: persist diff verdicts with decision summaries"`.

### Task 2: Surface Finish Failures as Operational Decisions

**Files:** Modify `src/review-runs.ts` (`#run` finish catch), `src/command-post.ts` (ReviewRuns options and existing `#journalDurable`); test `tests/review-runs.test.ts`, `tests/wakeup-journal.test.ts`; document in `docs/contracts.md` async review section.

**Interfaces:** `ReviewAttempt<T>.finish(outcome: T): Promise<ReviewWakeup | undefined>` stays unchanged. Reuse its `{ operational: string }` convention, already used when `wait()` throws. Add optional `ReviewRunsOptions.onFinishFailure(pending: PendingReview, reason: string): void` for cases where no safe verdict wake-up can be constructed. `decisionExists(home, pending)` guards a partial success.

- [ ] **Step 1: Write failing registry tests.** Build a `ReviewAttempt<{ operational?: string }>` with a manually released `wait`, a `finish` that throws once and persists an operational decision on second call. Hand back and settle; assert one `review_orphaned` event, persisted operational decision, exactly one wake-up naming the fault, and next attempt number 2. Add a case whose first `finish` writes `paths.gateFile(jobId, 1)` then throws: assert fallback does not overwrite decision, no fabricated `cp-verdict`, and one `onFinishFailure` callback; add a case where both finishes throw and callback fires once. Exercise callback through CommandPost's durable outbox in `tests/wakeup-journal.test.ts` and assert one `recovery` row survives restart with job/attempt/surface details.
- [ ] **Step 2: Run red.** `node --test tests/review-runs.test.ts tests/wakeup-journal.test.ts`; pre-fix registry logs but neither persists an operational decision nor notifies parent.
- [ ] **Step 3: Implement bounded recovery.** In `#run`, on `finish` throw, record `review_orphaned`. If `decisionExists(home, pending)` is false, invoke `attempt.finish({ operational: `reviewer finish failed: ${message}` } as T)` once, using returned wake-up through ordinary handback/send path. If decision already exists or fallback throws, invoke `onFinishFailure` once after cleanup with bounded reason; do not send `cp-verdict` without a valid decision. In `CommandPost`, pass a callback that calls existing `#journalDurable` with `kind: "recovery"`, stable `boundedWakeupId` keyed by job/surface/attempt, `keys: [jobId]`, and content telling parent to inspect `cp_review` status and `/watch` rather than merge or retry stale scratch. Guard callback errors so cleanup still runs. On operational outcome, persisted verdict must be `escalate` with `cause: operational` (or `operational_persistent` on later attempts), not `pass`.
- [ ] **Step 4: Run green.** `node --test tests/review-runs.test.ts tests/wakeup-journal.test.ts tests/diff-review.test.ts tests/gate.test.ts`; `npm run typecheck`. Verify fallback's second same-head review uses attempt 2 and standard bounded operational ladder.
- [ ] **Step 5: Document and commit.** Update `docs/contracts.md` async-review failure paragraph with operational fallback, partial write, durable-notice behavior. Run `npm test`, then commit source/tests/doc.

### Task 3: Roll Out and Prove Receipt Recovery

**Files:** No code change; use deployment/restart procedure for the installed CP extension and a disposable scratch home. Production `state/` files stay intact.

**Interfaces:** The installed parent must load the new `DiffReview` projection. `cp_review <job-id>` remains the only authorized review entry point.

- [ ] **Step 1: Deploy reviewed commit via normal extension update.** Record deployed commit SHA and restart parent only after all live workers have drained, per `AGENTS.md`; never restart an active parent to force receipt ingestion.
- [ ] **Step 2: Exercise recovery in a scratch home.** Seed a reviewer `review-1/verdict.json` containing schema-valid `decision_summary`, no `review-1.json`, and a held PR head. Invoke `cp_review` once on unchanged head; assert persisted schema-valid decision and one `cp-verdict` on that head, without deleting scratch files or spawning duplicate live reviewers.
- [ ] **Step 3: Check production scope.** Audited mission eventually merged reviewed replacement work; do not assume its incident PR #10 is still current or reopen it blindly (this is target-project PR numbering, not this repository's PR #10). For any held PR with this exact orphan state, verify target repository, PR state, branch head, and reviewer activity before invoking `cp_review` once after deployment. Verify persisted decision and wake-up, proceed through normal CI/merge gates, and record outcome in incident follow-up without editing live run files.

**Done when:** A replay of the PR #7/#10 verdict shape persists `review-1.json` and delivers one `cp-verdict`; unrelated finisher exceptions surface through durable notices without approving unreviewed code. Rollout is verified after a drained-parent restart; no manual live-state surgery.
