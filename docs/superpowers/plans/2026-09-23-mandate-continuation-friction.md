# Mandate and Continuation Friction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replacement authority and same-worker repair remain safe but do not pause immediately, consume phantom worker slots, or misread PR references as issue-intake commands.

**Architecture:** Keep cumulative budget accounting and immutable grants. Preflight new grants against already-spent lifetime totals before writing; count only actively working workers in the concurrency slot while continuing to count held jobs toward spend and job caps. Tighten free-text issue-ref extraction to exclude explicitly prefixed PR mentions; leave explicit `external_ref` verification unchanged.

**Tech Stack:** TypeScript, Node 24 `node --test`, existing MandateStore/FleetStore/ledger and TypeBox contracts.

**Spec:** `AGENTS.md` sections Escalation, Continuation, Dispatch and Integration; `docs/contracts.md` mandate/reference verification sections. Incident: `state/sessions/cp-parent.jsonl` (Sep 22-23 budget/parallelism/PR #7 refusals).

## Global Constraints

- Never auto-raise a spend cap or expand project, job, risk or merge authority. Require explicit token and USD ceilings; dollar and token caps remain independent.
- Historic usage still counts toward a replacement grant covering the same job; do not silently reset lifetime usage or treat cache reads as free unless the contract explicitly changes.
- A held PR still counts toward job count and spend. It does not consume a parallel *working* worker slot. One job never has two implementers.
- Bare `#17` and `owner/repo#17` still mean an issue to verify; explicit `PR #17` means descriptive prose, not issue intake.
- No production state or mandate edits as part of this plan; implementation tests use scratch homes.

## Review Focus

- Grant token, USD, or job cap already exhausted by covered fleet jobs: refuse before writing and show all totals (Task 1).
- Replacement grant restricted to another job/project: unrelated historic usage does not count (Task 1).
- Live usage crosses grant cap mid-run: notify once and pause new work without killing in-flight worker (Task 4).
- Promote same held job: serial limit allows it, but duplicate live worker remains forbidden (Task 2).
- `PR #7` prose vs bare `#7` issue: only the latter triggers issue verification (Task 3).

## File Map

| File | Responsibility |
|---|---|
| `src/mandate.ts` | Issuance preflight, spend totals, live-slot accounting, issue-ref extraction. |
| `extensions/command-post/index.ts` | Supply current fleet records to issuance preflight. |
| `src/dispatch.ts`, `src/revive.ts`, `src/recovery.ts`, `src/command-post.ts` | Observe live usage after run projection on fresh, revived, and recovered workers. |
| `tests/dispatch.test.ts`, `tests/revive.test.ts`, `tests/recovery.test.ts` | Verify threshold notices on normal spawn, revive, and recovery. |
| `src/next.ts` | Expose actual worker slot count without changing spend totals. |
| `tests/mandate.test.ts` | Budget and reference parsing coverage. |
| `tests/next.test.ts`, `tests/send.test.ts` | Held vs working slots, same-worker promotion. |
| `docs/contracts.md`, `AGENTS.md` | Explain cap baseline and serial active-worker semantics. |

---

### Task 1: Refuse Immediately Exhausted Replacement Grants

**Files:** Modify `MandateStore.issue` in `src/mandate.ts` and issuance call in `extensions/command-post/index.ts` (currently around line 2897); test `tests/mandate.test.ts`.

**Interfaces:** Extend `issue(input: IssueMandateInput, jobs: readonly MandateUsageJob[] = []): Mandate`; retain default to keep existing test and single-job callers working. `mandateSpend(candidate, jobs)` remains the one accounting function.

- [ ] **Step 1: Write red tests.** Seed a scratch `MandateStore` and a held fleet job with `usage.total_tokens: 17_550_034` and `cost_usd: 0.10`. Issue a covering grant with token cap 3,000,000 and USD cap 20, passing those jobs: expect `MandateError` mentioning used tokens and cap, and no new mandate. Repeat with 50,000,000 tokens (active grant), USD cap 0.05 (refusal naming USD spend), and a grant for another job/project (success). Also seed three covered jobs under `job_cap: 3`: refuse immediately with used jobs/cap, then accept `job_cap: 4`. Keep existing `capReached` test: grant issued before usage accrues still pauses later.
- [ ] **Step 2: Run red.** `node --test tests/mandate.test.ts`; old `issue()` ignores fleet usage.
- [ ] **Step 3: Preflight in `issue` before write.** Build candidate with `job_ids`, `projects`, exclusions and caps, call `mandateSpend(candidate, jobs)`, and throw if tokens or USD `>=` corresponding cap **or** `spend.jobs >= job_cap` (include all three used/cap totals in error). Keep `capReached` for usage accrued later. In extension `cp_mandate issue`, pass `post.fleet.read().jobs` already read as `jobs`; check before writing grant. Do not auto-raise any cap or mutate older grant.
- [ ] **Step 4: Run green.** `node --test tests/mandate.test.ts tests/mandate-defaults.test.ts`; `npm run typecheck`. Confirm refusal is actionable and generates no extra budget escalation after issuance.
- [ ] **Step 5: Update `docs/contracts.md` and commit.** State replacement caps include recorded lifetime usage and existing covered jobs; show all three totals at issue time and require explicit higher caps. Run `npm test`; commit code, test, doc.

### Task 2: Separate Working Slots from Held Deliveries

**Files:** Modify `mandateSpend` in `src/mandate.ts`, shared use in `src/next.ts` and `assertDispatchAllowed`; test `tests/mandate.test.ts`, `tests/next.test.ts`, `tests/send.test.ts`.

**Interfaces:** Keep `mandateSpend` return shape `{ usd, tokens, jobs, inFlight }`, but define `inFlight` as `phase === "waiting"` (current working phase); `held` stays in `jobs` and `usage`. If fleet can represent a genuinely active held worker without `phase: waiting`, identify it in a test before changing the predicate, then count active process state rather than treating every held PR as active.

- [ ] **Step 1: Write red tests.** With a serial grant and held job A, assert `cpNext` can recommend ready job B and `assertDispatchAllowed` allows B; with A waiting, B must still be refused. For held A, `cp_send` promotion of A must pass the slot check but still use A's existing managed worker; add assertions in `tests/send.test.ts` beside existing held/promotion tests that no new process or job appears. Held A must still contribute all prior USD/tokens and one job to `mandateSpend`.
- [ ] **Step 2: Run red.** `node --test tests/mandate.test.ts tests/next.test.ts tests/send.test.ts`; current code counts `phase === "held"` as `inFlight`.
- [ ] **Step 3: Use one occupancy definition.** Change the shared `inFlight` increment in `mandateSpend` to count only actually active workers. Leave `matchingJobs`, `capReached` and `assertDispatchAllowed` scope checks unchanged. `cpNext` already reads `spend.inFlight`; no separate counter should be added there. Clarify the `NextMandateView.live_workers` comment and `AGENTS.md` wording.
- [ ] **Step 4: Run green.** Focused three suites, then `npm test`. Verify two waiting jobs still hit serial limit and same-job promotion never dispatches a duplicate.
- [ ] **Step 5: Commit.** Commit shared counter, focused tests and wording after full suite passes.

### Task 3: Do Not Intake Descriptive PR Mentions as Issues

**Files:** Modify `extractBareIssueRef` in `src/mandate.ts`; test `tests/mandate.test.ts` near `resolveMandateObjectiveRef` tests.

**Interfaces:** `extractBareIssueRef(text): { ownerRepo?: string; number: string } | undefined` unchanged. `resolveMandateObjectiveRef` still verifies true bare issue refs and raises `conflicting_acceptance` for closed issues or PRs masquerading as an issue.

- [ ] **Step 1: Write red tests.** Check `extractBareIssueRef("replace PR #7 with same two-file patch") === undefined`, plus lower-case `pr #7` and `pull request #7`. Assert `resolveMandateObjectiveRef` with that prose never invokes `verifyRef` or creates a job/escalation. Existing `"fix #17"` and `"fix owner/repo#17"` must continue to resolve/verify normally; `"fix #17 despite PR #7"` should resolve issue 17 only.
- [ ] **Step 2: Run red.** `node --test tests/mandate.test.ts`; current regex matches `#7` after `PR `.
- [ ] **Step 3: Narrow matching.** In `extractBareIssueRef`, skip a match if the immediately preceding words label it `PR` or `pull request` (case-insensitive), then continue to the next bare match. Keep verification in `resolveMandateObjectiveRef`; do not treat PRs as issues or skip actual bare issue refs merely because another PR is mentioned. No new parser dependency.
- [ ] **Step 4: Run green.** `node --test tests/mandate.test.ts`, `npm run typecheck`, `npm test`; commit parser/test.

### Task 4: Surface Live Mandate Overspend Once

**Files:** Modify `attachWorkerObservers` and its call sites in `src/dispatch.ts`, `src/revive.ts`, and `src/recovery.ts`, plus `CommandPost` wiring in `src/command-post.ts`; test `tests/dispatch.test.ts`, `tests/revive.test.ts`, `tests/recovery.test.ts`, and `tests/mandate.test.ts`.

**Interfaces:** Add optional `WorkerObserverOptions.onUsage(jobId: string, usage: Usage): void`. Register listener *after* `recorder.attach(worker)` so `recorder.status.usage` includes event; share it between fresh, revived, and bounded-recovery workers. Keep `mandateSpend` as one cap calculator.

- [ ] **Step 1: Write red threshold tests.** In scratch homes, issue grant capped at 3M tokens and $20. Emit worker usage updates taking job from 2.3M to 2.5M (one 80% warning) then to 3.1M (one cap-pause notice). Re-emit same cumulative usage and simulate revive and bounded recovery; assert no duplicate durable notice or budget escalation. Assert worker remains live (no silent termination), but next dispatch/ship promotion is refused by paused mandate. Check `cost_usd` crossing independently.
- [ ] **Step 2: Run red.** `node --test tests/dispatch.test.ts tests/revive.test.ts tests/recovery.test.ts tests/mandate.test.ts`; current sweep sees persisted fleet usage only at next parent action, not streaming run usage.
- [ ] **Step 3: Wire one usage observer.** In `attachWorkerObservers`, subscribe after `recorder.attach(worker)` and call optional `onUsage` on `message_update`/`message_end` when `recorder.status.usage` advances. In CommandPost, overlay current `runs.get(id)?.status.usage` onto each matching fleet record before `mandates.sweep(now, jobs)` so concurrent jobs count once; inspect at threshold/cap crossings, not every token. Journal bounded `kind: "recovery"` durable notice keyed by mandate id and threshold using existing `#journalDurable`/`boundedWakeupId`, stating used/cap totals and that in-flight worker continues. Pass same callback from dispatch, revive, and bounded recovery; once mandate pauses, new dispatches stay gated. No new timer, dependency, cap raise, or worker kill.
- [ ] **Step 4: Run green.** Focused suites and `npm test`; document in `docs/contracts.md` that mission caps pause future work and notify during in-flight work, but a single model/tool event may exceed cap before observation.
- [ ] **Step 5: Commit.** Commit shared observer, wiring, focused tests and contract wording. Do not claim a strict monetary ceiling: a currently executing call may overshoot even after warning.

**Done when:** New grants cannot start already exhausted, live cap crossings notify parent once without silent kills, held deliveries do not consume active-worker slots, and descriptive PR references do not trigger issue verification. Keep current default 3M-token/serial limits until measured usage warrants separate policy change. An in-flight model/tool event can still exceed cap before observation. RPC 120-second injection waits, invalid overlong escalation/memory text, and duplicate mission-end notices lack causal evidence for changing contracts; collect frequency and failure-path data first.
