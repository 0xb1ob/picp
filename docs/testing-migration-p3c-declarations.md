# P3c V2 conversion progress

The operator's V2 brief assigns all seven files below to **P3c**. Reachable behaviors get real-entry consumer
assertions and a negative control per behavior before their units are removed. A retained unit must name a
missing entry point; a missing assertion or control is work to complete, never a reason to retain it.

The initial slice has 143 static declarations (152 parameterized runtime cases). Progress is committed per file.
P3d owns only the other sixteen behavior-05 files. This document supersedes the review-1 audit dispositions.

| Original file | Declarations | Conversion status |
|---|---:|---|
| tests/ci-watch.test.ts | 80 | In progress: 05-8 already proves five declarations with NC-32 and NC-39–NC-42; remaining reachable gaps belong to P3c |
| tests/main-ci.test.ts | 39 | Pending V2 gap closure under P3c, including the inherited P3/P3b assertions |
| tests/foreign-ci-watch.test.ts | 11 | Pending V2 gap closure under P3c, including dispatch release and legacy state |
| tests/parked-ci.test.ts | 3 | All three mapped to 05-12 and deleted; real timer, forge barriers, resume/re-park and legacy held state; NC-36 and NC-49–NC-55 |
| tests/ci-evidence.test.ts | 5 | All five mapped to 05-9 and deleted; NC-33 and NC-43–NC-48 fail their tool/storage/viewer assertions |
| tests/integrate-held-ci.test.ts | 3 | Pending V2 gap closure under P3c, including restart and permission paths |
| tests/awaiting-merge-tick.test.ts | 2 | Retained verbatim in tests/awaiting-merge-tick-retained.test.ts (convert, owner P3c); specifically missing lifecycle entry points below; no deletion credit |

Current counts: 13/143 declarations mapped (9.09%), 2 retained (1.40%), 128 pending; 8 declarations removed, 2/7 original
files fully deleted. The five existing CI-watch mappings remain until that file's conversion. Work continues until
the V2 acceptance is met; these intermediate counts are not a completion claim.

No pending declaration is counted as retained, redundant-unreachable or removed. The manifest ledger and PR body
carry the measured counts after each completed file migration.

The timer file is a 100% rename, not retired coverage. Its two declaration rows remain `retained` in the assertion
ledger; the baseline-file table's `deleted` means only that its old path is gone. The replacement is convert-owned
by P3c, and the rename adds zero to the fully deleted-file/declaration counts.

| Retained declaration | Specifically missing entry point and evidence |
|---|---|
| a lock taken after session_start still sweeps on the next interval | No public API transfers ownership to an already-started parent. `extensions/command-post/index.ts` registers session hooks before the timer; `session-hooks.ts` acquires only at session_start and releases only at session_shutdown. Reinstating the old startup lock guard still passes real 05-12 (`v2-tick-startup-probe.log`, exit 0), so it is not counted as a failing consumer control. |
| session_shutdown clears the startup catch-up and the interval | No public API observes dormant timer callbacks after shutdown while ownership remains held, or shuts down before the first startup timer in that state. Shutdown releases the lock; the real process then exits. Removing both clears still passes real 05-12 (`v2-tick-shutdown-probe.log`, exit 0), while the retained regression fails (`v2-tick-shutdown-unit-probe.log`, exit 1). The exact timer assertions stay. |

Both mutations were restored. Neither passing consumer probe is recorded as a negative control. No P1 exception is
introduced. A future ownership-transfer API or observable post-shutdown lifecycle is the entry point needed to map
these retained declarations.
