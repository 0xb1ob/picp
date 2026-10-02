# Reviewable Diff Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refuse unscorable diff reviews before spawning a reviewer, with precise file/byte evidence and a bounded staging route for first-project and generated-results PRs.

**Architecture:** `materializeDiff()` already measures file count and lists omitted hunks. Keep its 300-file/300,000-byte bounds; have `DiffReview.start()` treat any omitted hunks in the *subject under review* as a policy escalation, like stat overflow. Put compact delivery guidance in the existing ship brief so workers can split generated data from code before opening an oversized PR. Do not auto-approve partial review or silently raise caps.

**Tech Stack:** TypeScript, Node 24 `node --test`, git three-dot diff, existing mock-provider review bench.

**Spec:** `docs/contracts.md` diff-review bounding contract; observed PR #1 (429 files), PR #3 (164-file stacked repair with cumulative 293-file diff), and PR #6 (CSV hunks hid script/tests) in `state/sessions/cp-parent.jsonl`.

## Global Constraints

- Reviewer always sees a complete diff subject for the head it judges, or no reviewer starts; a listed omitted file is not review evidence.
- Keep first-review three-dot semantics and subsequent delta-from-previous-head semantics; no new merge bypass.
- File and byte limits remain 300 and 300,000; no new dependency, dynamic prompt-length guessing, or automated PR splitting.
- Generated result files stay in the delivery; split into ordered code and data stages, verify each independently.
- No target strategy/backtest changes in this repository: Pine bounds, provenance, and run IDs were repaired in the target project during the audited session.

## Review Focus

- 301 tiny changed files: existing `stat_overflow` path stays untouched (Task 1).
- 2 files with one oversized CSV: pre-review escalation names omitted file and does not spawn model (Task 1).
- Script/test ordered after generated CSV: no pass based solely on visible CSV hunks (Task 1).
- Complete changed-head delta with oversized full history: review delta using prior verdict without requiring full history in prompt (Task 1).
- Historical truncated pass on same patch/head: cannot satisfy equivalence or integration (Task 1).
- Ship brief on generated output: worker knows staging limits before pushing, without skipping files (Task 2).

## File Map

| File | Responsibility |
|---|---|
| `src/diff-review.ts` | Refuse truncated review subject before spawn; keep attempt/head bookkeeping. |
| `tests/diff-review.test.ts` | Truncation and delta review regression. |
| `src/merge-ask.ts`, `tests/merge-ask.test.ts` | Prevent historical truncated passes from satisfying the integration review gate. |
| `prompts/briefs/brief-ship.md` | Early guidance on code/data staging for large or generated changes. |
| `tests/dispatch.test.ts` | Check ship brief still carries the review limits and preservation rule. |
| `docs/contracts.md` | Update bounding description from 'list omissions' to 'stop the review'. |

---

### Task 1: Fail Closed on Omitted Subject Hunks

**Files:** Modify `src/diff-review.ts` after `materializeDiff()` returns, before `profileForRole()`/spawn; test `tests/diff-review.test.ts` near the `stat overflow` and `materializeDiff ... byte cap` tests.

**Interfaces:** `materializeDiff()` result stays `{ ok: true, files, truncated, omitted, path, base } | { ok: false, reason: "stat_overflow", files, cap, base }`. `DiffReview.start()` still returns `DiffReviewResult | DiffReviewWait`.

- [ ] **Step 1: Add red integration tests.** Create a one-head branch in `reviewBenchOf(t)` with `src/check.ts` and enough generated content to exceed `DIFF_REVIEW_MAX_BYTES` while staying under 300 files. Give it a scripted reviewer; assert `review.reviewAndWait(...)` returns `escalate`/`policy`, `next === "surface"`, `diff_stat.truncated === true`, reasons name omitted paths and byte limit, no `brief.md`, and mock-provider request count 0. Keep existing 301-file no-spawn test. Seed a historical `pass` with `diff_stat.truncated: true` and same `patch_id`: a rebased head must not inherit that pass; its complete subject must be reviewed. Seed an old truncated pass for current head in `tests/merge-ask.test.ts`: `readReviewPassVerdict` must return `undefined`, including the equivalent-verdict file. Add a delta case: first review a complete branch diff just under 300,000 bytes; append a small commit making cumulative branch diff larger than 300,000 but delta small. Confirm complete delta still reaches reviewer with prior verdict, though supplemental `full-diff.md` is bounded.
- [ ] **Step 2: Run red.** `node --test tests/diff-review.test.ts tests/merge-ask.test.ts`; omitted hunks currently reach reviewer and old truncated passes still qualify.
- [ ] **Step 3: Fail closed, including historical passes.** After current stat-overflow branch in `DiffReview.start()`, check `materialized.truncated`. Build a bounded `capPayload` reason stating count, `DIFF_REVIEW_MAX_BYTES`, and omitted paths (keep raw copy when capped). Persist a `DiffVerdict` with `verdict: "escalate"`, `cause: "policy"`, `flags: { ...NO_FLAGS }`, current `attempt`, `head_sha: headSha`, `decided_at: isoTimestamp(now())`, and `diff_stat: { files: materialized.files, truncated: true }`, then return from `#persist` without spawning. Before this branch, filter `priorPass` and `latestContentReview` in `src/diff-review.ts` by `diff_stat.truncated === false` so an old partial pass cannot grant equivalence or serve as a delta baseline. In `src/merge-ask.ts`, make both direct and equivalent branches of `readReviewPassVerdict` require `diff_stat.truncated === false`; this also gates `cp_integrate`. For delta reviews, only the `diff.md` subject's truncation blocks review; `full-diff.md` is supplemental prior context covered by previous complete verdict.
- [ ] **Step 4: Run green.** `node --test tests/diff-review.test.ts tests/merge-ask.test.ts tests/integrate.test.ts`; `npm run typecheck`. Check new escalation names path/byte cap, historical truncated verdict cannot satisfy integration, and complete delta gets genuine review.
- [ ] **Step 5: Document and commit.** Update `docs/contracts.md` diff review bounding paragraph: omitted paths are diagnostic evidence, never a scoreable partial subject; stage smaller PRs and re-review each head. Run `npm test`, then commit source/test/doc.

### Task 2: Warn Implementers Before Large PRs

**Files:** Modify `prompts/briefs/brief-ship.md`; test `tests/dispatch.test.ts` (existing brief assembly assertions).

**Interfaces:** No new tool flags or schema; the existing brief remains the single instruction packet.

- [ ] **Step 1: Add failing brief assertion.** In the existing ship-brief assembly test, assert the rendered brief mentions the exact `300 files` and `300,000 bytes` diff-review caps, says to keep generated runs separate from code/tests when the diff would omit necessary hunks, and requires preserving all requested outputs across ordered PRs. Also assert the brief does not authorize bypassing review.
- [ ] **Step 2: Run red.** `node --test tests/dispatch.test.ts`; the brief currently does not carry this guidance.
- [ ] **Step 3: Add a short paragraph** to `prompts/briefs/brief-ship.md`: before pushing a data-heavy deliverable, inspect `git diff --name-status` and `git diff` against intended base. If it exceeds 300 files or 300,000 diff bytes, preserve completed work in a commit, run required local verification, rebase/retest as applicable, and push the current branch before filing `report_result(status: "blocked", blockers: ["review scope: N files / M bytes; propose code/test PR then ordered data batches"])`. Do not open another PR or split frozen job yourself; parent creates/authorizes follow-up jobs. Preserve all requested outputs. This is planning guidance, not a new policy gate.
- [ ] **Step 4: Run green.** `node --test tests/dispatch.test.ts` and `npm test`; commit the brief and test.

**Done when:** Neither an over-300-file branch nor an under-300-file but incomplete diff can produce a passing review, and workers learn staged-delivery constraints before generating a huge PR. No partial-diff review or cap override is introduced.
