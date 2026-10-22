# P3c partial delivery

The operator accepted P3c as a partial delivery (ask-c77a4f32b23b). The pilot continues in follow-on
slice jobs owned by **P3c-rest**, rather than assigning unfinished conversion to this completed slice.
Reachable behaviors need real-entry assertions and failing controls before retirement. A retained unit
must name a missing entry point; missing assertions or controls remain conversion work.

The original slice has 143 static declarations (152 parameterized runtime cases).

| Original file | Declarations | Delivery and follow-on status |
|---|---:|---|
| tests/ci-watch.test.ts | 80 | S10b retires the original: 75 mapped, five retained verbatim in tests/ci-watch-retained.test.ts (S02 6/8/32/33 and S03 70), zero pending. Canonical declaration 71 mapping and executed two-cause control: [S10b](testing-migration/s10b.md). One retained file, one original file retired. |
| tests/main-ci.test.ts | 39 | Follow-on #416: 32 mapped, 7 retained (mixed tests narrowed) in tests/main-ci-retained.test.ts, 0 pending; whole original retired. Full titles and controls: [main-CI accounting](testing-migration-main-ci-declarations.md). |
| tests/foreign-ci-watch.test.ts | 11 | S06 completed: 10 mapped to 05-10/S06-1 in tests/e2e/landing-ci-watch.test.ts, one static declaration in tests/foreign-ci-watch-retained.test.ts; supersedes the P3c-rest pending snapshot |
| tests/parked-ci.test.ts | 3 | All three mapped to 05-12 and deleted; real timer, forge barriers, resume/re-park and legacy held state; NC-36 and NC-49–NC-55 |
| tests/ci-evidence.test.ts | 5 | All five mapped to 05-9 and deleted; NC-33 and NC-43–NC-48 fail their tool/storage/viewer assertions |
| tests/integrate-held-ci.test.ts | 3 | S07: all three mapped to 05-13 and 05-S07 and deleted; NC-37 and S07-NC-1..3; S03 proves real startup recomputation without a manual integrate call, kills only the held worker PID, and asserts the queued forge-barrier result |
| tests/awaiting-merge-tick.test.ts | 2 | Retained verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c-rest); missing lifecycle entry points below; no deletion credit |

Delivered counts: **13/143 declarations mapped (9.09%), 2 retained (1.40%), 128 pending; 8 declarations
removed and 2/7 files deleted**. Five CI-watch mappings remain in their original file until follow-on conversion.
This completes only the operator-approved partial slice; it does not satisfy the original 60%/three-file target.
The remaining five files continue under P3c-rest; other behavior-05 files remain outside this slice.

S07 subsequently maps three more declarations and deletes `tests/integrate-held-ci.test.ts`: cumulative
16/143 mapped, 2 retained, 125 pending, 11 declarations removed and 3/7 files deleted. It adds one e2e
declaration and extends 05-13; no other slice's ownership changes. The counts above describe P3c's original delivery.

Current follow-on snapshot after S10b: **128/143 mapped, 15 retained, zero pending**.
The retained declarations are five CI-watch contracts, seven main-CI declarations,
one foreign-CI declaration and two timer declarations. S10b maps CI-watch 71 after #443,
retains the synchronous callback contract (70), and retires the original watcher file.
[Canonical mapping and final-state controls](testing-migration/s10b.md) supersede the earlier keep-whole
and pending-fix instructions for CI-watch; the slice history below records those earlier decisions.

No pending declaration is counted as retained, redundant-unreachable or removed. The timer file is a 100%
rename, not retired coverage. Its two assertion rows remain `retained`; the baseline-file table's `deleted`
means only that its old path is absent. The replacement is `convert`, owner P3c-rest, and earns zero
removed-declaration or deleted-file credit. NC-38 is only a rename-bookkeeping cross-reference required for
the absent baseline path: NC-36 proves parked observation wiring, not either retained timer assertion.

| Retained declaration | Specifically missing entry point and evidence |
|---|---|
| a lock taken after session_start still sweeps on the next interval | No public API transfers ownership to an already-started parent. `extensions/command-post/index.ts` registers session hooks before the timer; `session-hooks.ts` acquires only at session_start and releases only at session_shutdown. Reinstating the old startup lock guard still passes real 05-12 (`v2-tick-startup-probe.log`, exit 0), so it is not counted as a failing consumer control. |
| session_shutdown clears the startup catch-up and the interval | No public API observes dormant timer callbacks after shutdown while ownership remains held, or shuts down before the first startup timer in that state. Shutdown releases the lock; the real process then exits. Removing both clears still passes real 05-12 (`v2-tick-shutdown-probe.log`, exit 0), while the retained regression fails (`v2-tick-shutdown-unit-probe.log`, exit 1). The exact timer assertions stay. |

Both mutations were restored. Neither passing consumer probe is a negative control. No P1 exception is
introduced. A future ownership-transfer API or observable post-shutdown lifecycle is needed to map these cases.

## S02 follow-on (cp-e2e-slice-s02-l7ph)

S02 owns only `tests/ci-watch.test.ts` declarations 1–40. It adds five scenarios and extends 05-8:
36 declarations are mapped; declarations 6, 8, 32 and 33 have unreachable sub-assertions and remain intact.
All original declarations stay in place under the operator's split-file amendment; no deletion credit is claimed.
S03 originally owned 41–80 and final retirement; frozen Addendum 1 now assigns declaration 71 and retirement to S10b.
S03b retains four verbatim S02 declarations in tests/ci-watch-retained.test.ts. Their missing entry points
are named in the assertion map; public consumer controls do not replace those helper assertions.
The copies temporarily duplicate originals because the operator requires the original file to stay whole.
The 13/143 summary above records P3c's historical partial delivery, before these follow-on mappings.
