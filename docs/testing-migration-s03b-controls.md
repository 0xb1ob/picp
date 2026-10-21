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
