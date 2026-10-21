# S03b executed production controls

Base: c8d60449079eb75512470a8702eb83c13f62af83. All mutations restored immediately.
Command: `npm run test:one -- --test-name-pattern='landing S03: startup snapshots' tests/e2e/landing.test.ts`.
Fixed run: 3 cases passed, 0 failed/skipped (30.60 seconds).

## S03b-snapshot-generation (declaration 78)

Insert after `this.#driving.add(trigger.jobId);` in src/held-continuation.ts:

```diff
+ trigger.generation = (this.#deps.fleet.get(trigger.jobId)?.supersessions ?? 0) + 1;
```

Executed against the generation scenario before adding its head sibling. Exit 1:
`queued startup cannot adopt a reopened generation`: actual stopped, expected stale.

## S03b-snapshot-head (declaration 78)

Insert after `this.#driving.add(trigger.jobId);` in src/held-continuation.ts:

```diff
+ trigger.head = this.#deps.head(trigger.jobId, headOwner(trigger.event));
```

Executed with both variants. Generation passes; head fails (exit 1):
`stale queued startup reaches no forge read`: actual false, expected true.
The re-read lets the queued job reach the forge before the remote mismatch stops it.

## S03b-parked (declaration 64)

Base: 86b4cec9ba0a4cef74c0d6b1014648d670f6bdae (#429).
Command pattern: `landing S03: a real parent relays a newly parked` in landing.test.ts.
Executed patch in src/wakeup-outbox.ts:

```diff
- return id.startsWith("continuation:done:") || id.startsWith("continuation:parked:") || (id.startsWith("continuation:") && id.endsWith(":done"));
+ return id.startsWith("continuation:done:") || (id.startsWith("continuation:") && id.endsWith(":done"));
```

Exit 1: `parking is relayed without waking the parent model`, actual 1, expected 0.
Fixed runs pass, including 6.88 seconds on the merged S03b base. No mutation remains.

## S03b-expiration (54)

On the base above c8d6044, delete this line from src/review-merge-window.ts:

```diff
- if (now.getTime() >= deadline) return undefined;
```

Pattern `landing S03: expired review`: exit 1, expired variant waits instead of done and fails
`expired startup reaches terminal result` after 15 seconds; retry likewise stays wait.
Fixed expanded case passes 3 cases in 75.75 seconds.

## S03b-retry (54, 66)

On c8d60449079eb75512470a8702eb83c13f62af83, insert before the final result notice in #drive:

```diff
+ if (result.next === "retry") {
+   this.#seen.delete(key);
+   this.#arm(trigger, { head_sha: trigger.head!, attempt: 0, decided_at: "", review_resume_at: new Date(Date.now() + 1_000).toISOString() });
+ }
```

Same expired-review pattern exits 1: `operational retry never rearms its deadline`, actual 27 startup outcomes,
expected 2. Only startup events are counted; normal watcher polling does not satisfy this assertion.

## S03b-stale (65, 78)

On c8d60449079eb75512470a8702eb83c13f62af83, insert `return undefined;` first in #stale.
Pattern `landing S03: facts changed|landing S03: startup snapshots` exits 1: both queued variants fail
`queued startup cannot adopt a reopened generation` (stopped vs stale). The forge-read variants separately
fail generation and observed (review_started vs stale), and missing (review_started vs wait).

## S03b-resume (67)

On c8d60449079eb75512470a8702eb83c13f62af83, insert `return [];` first in resume().
Pattern `landing S03: startup snapshots|landing S03: a restarted parent` exits 1: queued startup cannot reach
`first startup holds the project lane`; the restart case fails `startup did not arm the durable window`.

## S03b-unreadable-drain (68)

On c8d60449079eb75512470a8702eb83c13f62af83, change #draining's catch return from true to false.
Pattern `landing S03: unreadable drain` exits 1: `unreadable drain fails closed at the real deadline`,
actual wait vs expected draining. Fixed case passes in 35.09 seconds and also lands the identical replayed CI key
once the unreadable drain is removed.

## S03b-equivalent-window (56), replacement-head/generation (55)

Base c8d60449079eb75512470a8702eb83c13f62af83; pattern `landing S03: patch-equivalent`.
The scratch branch merges an advanced base; the real reviewer reuses its stable patch-id pass synchronously.
A new generation then replaces the deadline again. Fixed extended case passes in 48.95 seconds.

Executed mutation for 56, in the started.next === proceed branch of #drive:

```diff
- if (window) return out("wait", step, this.#arm(trigger, window), "wait");
```

Exit 1: `synchronous equivalence arms the window without another integration step`, actual 2, expected 1.

Executed replacement-generation mutation, first in #arm:

```diff
+ if ((trigger.generation ?? 1) > 1) return "replacement deadline omitted";
```

Exit 1: `a valid new generation replaces its deadline`, actual 2 notices, expected 3.

Executed replacement-head mutation, first in #arm:

```diff
+ if (trigger.head !== this.#deps.head(trigger.jobId, "fleet")) return "replacement head omitted";
```

Exit 1: `a changed head replaces the original deadline`, actual 1 notice, expected 2.

## S03b second batch: 45, 58, 60, 70 and S02 6/8/32/33

All controls below ran at base d35117d136da6e2441ada5dacb158484a5b2741a and were restored immediately.
Commands used `npm run test:one -- --test-name-pattern='<pattern>' tests/e2e/landing.test.ts`.
Every listed mutation exited 1. No production mutation remains in the patch.

| Control / declaration | Pattern | Production mutation | Failing assertion |
|---|---|---|---|
| S03b-legacy / 45 | landing S03: actual parent arrival | src/ci-watch.ts: string entries in ciKeysFromMessage use continue instead of keys.add(entry) | both legacy and object arrivals are confirmed on their owning job times out |
| S03b-arrival-type / 45 | landing S03: actual parent arrival | src/ci-watch.ts: delete if (record.customType !== CI_MESSAGE_TYPE) return [] | only cp-ci messages confirm CI arrival |
| S03b-stop / 58 | landing S03: actionable surface | src/held-continuation.ts: first in #notice add if (next !== "done") return | surface/retry stop wakes the actual parent times out |
| S03b-revise / 60 | landing S03: a real revise verdict | src/held-continuation.ts: onVerdict guard becomes only if (wakeup.surface !== "review") return | revise handback never schedules integration: 1 versus 0 |
| S03b-gate / 60 | landing S03: a real passing research | src/held-continuation.ts: onVerdict guard becomes only if ((wakeup.details as { next?: unknown }).next !== "proceed") return | a gate pass schedules no PR integration: 1 versus 0 |
| S03b-landed-hook / 70 | landing S03: armed-release | src/held-continuation.ts: delete this.#deps.onLanded?.(jobId) | the real landed hook reports its consumer failure times out |
| S03b-stop-hook / 70 | landing S03: armed-release | src/held-continuation.ts: first in #notice add if (next !== "done") this.#landed(jobId) | a stopped continuation never releases armed dependents: 1 versus 0 |
| S03b-fleet-stamp / S02 6 | landing S02: only reported | src/contracts/fleet.ts: delete errors.push for held without reported_at | the fleet boundary rejects an unreported held slot before watcher eligibility |
| S03b-actions-id / S02 8 | landing S02: Actions refuses | src/actions-ci.ts: destructure id = 1 instead of id in parseRuns | malformed run must not become a fact / run without id or run_attempt |
| S03b-disable / S02 32 | landing S02: unavailable gh | src/ci-watch.ts: delete this.#disabled = reason in #disable | first.disabled must name gh is not available |
| S03b-gitlab / S02 33 | landing S02: unavailable gh | src/ci-watch.ts: disabled guard becomes if (this.#disabled) continue | same tick must check both GitHub and GitLab jobs |

The onDisabled callback in S02 32/33 has no production caller: CommandPost supplies none.
The named unavailable-gh case pins its visible counterpart: disabled state, no further GitHub reads,
continued local HTTPS GitLab reads, terminal payloads, confirmed merge deduplication, and the same
unconfirmed merge key after a fresh CommandPost is constructed from the same state.

S02 6's held-without-reported_at shape is rejected by FleetStore validation before isWatched.
Removing the predicate guard alone left the e2e green (executed twice); removing fleet validation failed.
The named only-reported case now pins the actual refusal, including its reported_at diagnostic.

S02 8's helper-only no-id event cannot come from Actions: the named Actions-refuses case pins the
public malformed-run refusal. Attempt identities remain pinned by 05-8 / NC-32. Legacy messages
already on disk still reach the parent and confirm correctly in the new actual-parent-arrival case.
These four mixed declarations are classified redundant-unreachable, with their reachable behavior pinned.

For 70, CommandPost's only onLanded callback returns void while starting ArmedDispatches.release.
A synchronous injected throwing callback cannot reach that consumer; the named armed-release case
instead corrupts the real armed file and pins a durable ARMED DISPATCH RELEASE FAILED notice,
preserved input, and a completed landing. The existing mission armed-dependant case pins once-only
release after a landing and no spawn on replay; no fake callback was introduced.

Exact independent second-batch patches (apply one control at a time, never together):

```diff
--- src/ci-watch.ts (S03b-legacy)
- if (typeof entry === "string" && entry.length > 0) keys.add(entry);
+ if (typeof entry === "string" && entry.length > 0) continue;
--- src/ci-watch.ts (S03b-arrival-type)
- if (record.customType !== CI_MESSAGE_TYPE) return [];
--- src/held-continuation.ts (S03b-stop, first in #notice)
+ if (next !== "done") return;
--- src/held-continuation.ts (S03b-revise, onVerdict)
- if (wakeup.surface !== "review" || (wakeup.details as { next?: unknown }).next !== "proceed") return;
+ if (wakeup.surface !== "review") return;
--- src/held-continuation.ts (S03b-gate, onVerdict)
- if (wakeup.surface !== "review" || (wakeup.details as { next?: unknown }).next !== "proceed") return;
+ if ((wakeup.details as { next?: unknown }).next !== "proceed") return;
--- src/held-continuation.ts (S03b-landed-hook, #landed)
- this.#deps.onLanded?.(jobId);
--- src/held-continuation.ts (S03b-stop-hook, first in #notice)
+ if (next !== "done") this.#landed(jobId);
--- src/contracts/fleet.ts (S03b-fleet-stamp)
- errors.push(`/jobs/${job.job_id}: phase "held" requires reported_at (a hold follows an envelope)`);
--- src/actions-ci.ts (S03b-actions-id, parseRuns)
- const { id, run_attempt: attempt, head_sha: headSha } = row;
+ const { id = 1, run_attempt: attempt, head_sha: headSha } = row;
--- src/ci-watch.ts (S03b-disable, #disable)
- this.#disabled = reason;
--- src/ci-watch.ts (S03b-gitlab, #run)
- if (this.#disabled && !gitlab) continue;
+ if (this.#disabled) continue;
```
