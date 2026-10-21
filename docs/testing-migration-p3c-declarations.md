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
| tests/awaiting-merge-tick.test.ts | 2 | Pending V2 gap closure under P3c, including lock transitions and shutdown |

Current counts: 13/143 declarations mapped (9.09%), 0 retained, 130 pending; 8 declarations removed, 2/7 original
files fully deleted. The five existing CI-watch mappings remain until that file's conversion. Work continues until
the V2 acceptance is met; these intermediate counts are not a completion claim.

No pending declaration is counted as retained, redundant-unreachable or removed. The manifest ledger and PR body
carry the measured counts after each completed file migration.
