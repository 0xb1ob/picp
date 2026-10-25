# Ledger rows: p8f

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8f (cp-e2e-migration-p8f-skvg) | behavior 04, sixth slice: optional worker packages through cp_dispatch, role activation (04-36) and resolution faults (04-37) in `tests/e2e/worker-packages-p8f.test.ts`: `tests/worker-packages.test.ts` 12 mapped, 22 retained in `tests/worker-packages-retained.test.ts`; the worker reporter on dispatched and gated workers, envelopes (04-38), plans (04-39), guards (04-40) and verdicts (04-41) in `tests/e2e/worker-reporter-p8f.test.ts`: `tests/worker-reporter.test.ts` 20 mapped, 27 retained in `tests/worker-reporter-retained.test.ts`; the #543 review lows (a control for the kill -9 row, the p8e incoming range, three narrowings noted or pinned, stale citations) | 2 (`tests/worker-packages.test.ts`, `tests/worker-reporter.test.ts`) |
<!-- /manifest:ledger -->

P8f (job `cp-e2e-migration-p8f-skvg`) is the sixth behavior-04 slice. Fake packages sit in the parent's pi agent dir
as `pi install` lays them out, and real workers are dispatched through a real CommandPost; argv, environment and the
model's offered tools are read from the live worker. Each control below changed one guard, failed in the named case,
and was restored. The two files close P8's `convert` rows.

`tests/worker-packages.test.ts` retains 22 of 34 (65%). Eleven pin pi's own `DefaultPackageManager` on fixture
layouts (empty, one or both installed, malformed, glob, unconfigured, symlinked or skills-only, pi-lens absent):
no guard of ours decides those, so no control can fail them. Three read the pi docs the CLI flags rest on, one reads
the machine's real install and skips without it. Two pin frozen defaults and named constants, three need a profile
`packages:` override or a never-list name in a profile (profiles are package data), one drives a spawn racing an
unsettled resolution, and one scans src/ for spawn sites. The gate-reviewer cannot be cp_dispatched (its brief needs
the gate's task), so the caveman row naming it stays whole; the per-role and web rows below note that narrowing.

`tests/worker-reporter.test.ts` maps its 20 real-worker cases onto four e2e cases: implementers and planners are
cp_dispatched and gate reviewers run through cp_gate, so records, repair prompts, caps and refusals are read from the
run dir, the run log, the fleet failure and the model's requests. It retains 27 of 47 (57%). The 26 pure-helper units
(job identity, rejection text, edit-failure causes and near-miss lines, the miss counter, abort batches, the
credential, redaction and silent-bash branches, local checks, head checks, the answer bound, verdict clamping) cover
branches no dispatched worker is scripted to hit; 04-40 and 04-41 pin one consumer outcome of each family. The
recursion guard stays because a dispatched worker is never offered a parent-only tool, so nothing can call one.

The #543 lows: the kill -9 row (04-20) gets NC-P8f-kill-close; the p8e incoming row now reads 04-27..04-32; the
malformed script cap now pins "no branch" in 04-35, and the prompt-to-shutdown and busy-receipt rows note what they
narrow. Stale citations of deleted test files are fixed in docs/contracts.md, docs/build-history.md,
src/worker-packages.ts and tests/harness/hermetic-env.ts. `tests/contracts-anchors.test.ts`, README.md, s19.md,
p8b.md, `scripts/test-shards.ts` and ci.yml cite none of them, and the deleted file's timing entry is dropped.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8f | 04 | tests/e2e/worker-packages-p8f.test.ts`, `tests/e2e/worker-reporter-p8f.test.ts | 6 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-36 | tests/e2e/worker-packages-p8f.test.ts | P8f packages: each dispatched role loads only its installed packages and their tools, never caveman, a skill file or a never-list skill; an operator-named skill reaches its own job |
| 04-37 | tests/e2e/worker-packages-p8f.test.ts | P8f package faults: a failed resolution spawns the bare argv and says why; an unkeyed web provider withholds pi-web-access until a key arrives; a directory manifest reaches -e as entry files |
| 04-38 | tests/e2e/worker-reporter-p8f.test.ts | P8f reporter envelopes: a ship report is filed once at the worker, a wrong head or a contract break is repaired in-run, a re-report is a no-op or refused, and past the cap the job fails envelope_invalid |
| 04-39 | tests/e2e/worker-reporter-p8f.test.ts | P8f reporter plans: a blocked planner report is first-class, a body-shaped blocker and an oversize plan_summary are repaired, and neither a plan nor an answer opens a console hold |
| 04-40 | tests/e2e/worker-reporter-p8f.test.ts | P8f reporter guards: a CI wait, a credential probe and a state-bearing web call are refused while plain calls run; token output is redacted; silent bash and anchor-edit failures are enriched |
| 04-41 | tests/e2e/worker-reporter-p8f.test.ts | P8f reporter verdicts: a gate reviewer files one schema-valid verdict, over-long items are clamped with the original kept, a malformed verdict is repaired in-run, and an exhausted repair is an operational gate |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/worker-packages.test.ts | a directory-style manifest is resolved to entry-point files, never handed to -e as a directory | 04-37 | mapped | a directory manifest reaches -e as its `*.ts` and `<sub>/index.ts` files, each loads in the worker, a README and an index-less subdirectory do not; control NC-P8f-dir |
| tests/worker-packages.test.ts | both installed, implementer: ponytail's flags only — never caveman, trust flags intact | 04-36 | mapped | the implementer's -e is the reporter, ponytail and pi-lens, caveman never loads, --no-extensions and --no-skills stay; control NC-P8f-role |
| tests/worker-packages.test.ts | only caveman installed: an implementer still gets no added flags | 04-36 | mapped | caveman installed beside the others is loaded by no dispatched role; control NC-P8f-role. Narrowed: caveman is not the only package installed |
| tests/worker-packages.test.ts | the role table is total, and no role activates caveman | 04-36 | mapped | each dispatched role gets exactly its table entry and never caveman; control NC-P8f-role |
| tests/worker-packages.test.ts | every real profile gets only its configured resources, and discovery stays off | 04-36 | mapped | implementer, planner and qa get their resources only, discovery off and no --skill; control NC-P8f-role. Narrowed: gate-reviewer and ops are not cp_dispatched |
| tests/worker-packages.test.ts | single skills are not detected: ~/.pi/agent/skills and git package skills stay off (skillreads-vqy) | 04-36 | mapped | agent-dir skills and a git package of skills, never-list ones among them, reach no worker's --skill; control NC-P8f-single |
| tests/worker-packages.test.ts | per-role activation: implementer gets its packages; readers get pi-lens; nobody gets a skill file | 04-36 | mapped | pi-lens loads for every role with its headless flags, its tools and a pinned PI_LENS_HOME; no package skill file; controls NC-P8f-skill, NC-P8f-lens-flags, NC-P8f-lens-env. Narrowed: the gate-reviewer half |
| tests/worker-packages.test.ts | a per-job operator-named skill dir reaches --skill with --no-skills kept; an unmentioned never-list skill never loads | 04-36 | mapped | cp_dispatch skills reaches only qa's --skill with --no-skills kept; control NC-P8f-mention. Narrowed: the non-absolute refusal has no input (the resolver returns absolute dirs) |
| tests/worker-packages.test.ts | planner role pi-web-access: on for planner and qa, never gate-reviewer or implementer; web_enable never allowlisted | 04-36 | mapped | the planner and qa models see the four web tools, the implementer none, web_enable nobody; controls NC-P8f-web-tools, NC-P8f-web-enable. Narrowed: the gate-reviewer and profile-override halves |
| tests/worker-packages.test.ts | an unavailable provider withholds pi-web-access: no -e, no tools, reason recorded | 04-37 | mapped | brave without a key and an unparseable web-search.json withhold the package, a key restores it; control NC-P8f-withhold. Narrowed: the reason string /doctor reads is not pinned |
| tests/worker-packages.test.ts | a failed resolution is recorded on the run log and on the spawn result, never silent | 04-37 | mapped | a broken settings.json spawns the bare argv and the run log's worker_packages_unresolved line leads with pi's error; control NC-P8f-error. Narrowed: the still-resolving race stays in the retained row |
| tests/worker-packages.test.ts | tryResolveWorkerPackages keeps pi's failure instead of hiding it | 04-37 | mapped | the same run-log line; a home that resolves cleanly logs only the tools warning (04-36); control NC-P8f-error |
| tests/worker-packages.test.ts | neither package installed: detection is empty and never throws | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi's DefaultPackageManager resolution of an empty or absent agent dir; no guard of ours to break. |
| tests/worker-packages.test.ts | both packages installed: extensions and skills are detected per package, from their own manifests | — | retained | Verbatim in tests/worker-packages-retained.test.ts. The detected skills half reaches no worker (skillreads-vqy); 04-36 pins the -e half (NC-P8f-role). |
| tests/worker-packages.test.ts | one present, the other absent: each package is independent | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi's resolution of fixture layouts; no guard of ours to break. |
| tests/worker-packages.test.ts | a malformed or half-installed package is skipped, not fatal | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi skips the layout itself; no guard of ours to break. |
| tests/worker-packages.test.ts | a glob or !exclusion manifest entry is skipped, and the spawn is unaffected | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi drops the glob itself; no guard of ours to break. |
| tests/worker-packages.test.ts | the manifest keys our fixtures write are the ones pi documents (pi, not we, reads them) | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: reads pi's shipped docs, no command-post path. |
| tests/worker-packages.test.ts | `-e` takes an entry-point file, and an extension directory has a documented layout | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: reads pi's shipped docs. |
| tests/worker-packages.test.ts | `--skill` is documented as additive even with `--no-skills` (the flag combination this rests on) | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: reads pi's shipped docs. |
| tests/worker-packages.test.ts | a really-installed optional package resolves through pi to spawnable paths (skipped when absent) | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: reads this machine's real ~/.pi/agent, which an e2e home never has. |
| tests/worker-packages.test.ts | the shared empty default cannot be mutated by a caller | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: no caller mutates the frozen default. |
| tests/worker-packages.test.ts | the optional packages are named, with no version pinned | — | retained | Verbatim in tests/worker-packages-retained.test.ts. A constant pin with no consumer outcome beyond 04-36. |
| tests/worker-packages.test.ts | neither installed: the worker argv is exactly what it was, no added flags | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Compares two plans in-process; 04-37 shows the bare argv only after a failed resolution. |
| tests/worker-packages.test.ts | activation is availability ∩ role: an uninstalled or unknown name resolves to nothing | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: an unknown name needs a profile `packages:` override; profiles are package data. |
| tests/worker-packages.test.ts | profile `packages:` overrides the role default in both directions | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: profiles are package data. |
| tests/worker-packages.test.ts | a planner and a gate-reviewer are never caveman-compressed | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point for the gate-reviewer half: cp_dispatch cannot start one; 04-36 pins the planner and qa (NC-P8f-role). |
| tests/worker-packages.test.ts | the package manager is the path: settings decide, the disk alone does not | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi lists no resource of an unconfigured package; no guard of ours to break. |
| tests/worker-packages.test.ts | a skill symlinked into ~/.pi/agent/skills still belongs to its package | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: package skills reach no worker (skillreads-vqy). |
| tests/worker-packages.test.ts | a skills-only package cannot supply its extension tools | — | retained | Verbatim in tests/worker-packages-retained.test.ts. pi's resolution of a skills-only layout; no guard of ours to break. |
| tests/worker-packages.test.ts | pi-lens absent: no --no-read-guard flag is added | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Absence is pi's resolution; 04-36 pins the flags when present (NC-P8f-lens-flags). |
| tests/worker-packages.test.ts | the never-list is never activated, by any role or any profile override | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point for the override half: profiles are package data; 04-36 pins never-list skills staying off (NC-P8f-single). |
| tests/worker-packages.test.ts | a spawn started before resolution settles waits for it and still gets the role's packages | — | retained | Verbatim in tests/worker-packages-retained.test.ts. Missing entry point: a dispatch cannot be timed ahead of an unsettled resolution. |
| tests/worker-packages.test.ts | every WorkerManager spawn site in src/ awaits ready() first | — | retained | Verbatim in tests/worker-packages-retained.test.ts. A source scan of src/ with no runtime entry point. |
| tests/worker-reporter.test.ts | a worker session produces a valid envelope file | 04-38 | mapped | the dispatched implementer's record is the report as sent, attempt 1, with a timestamp and no rejection file, and the call ends the run; controls NC-P8f-noop, NC-P8f-write-once |
| tests/worker-reporter.test.ts | a head_sha that is not worktree HEAD is repaired in-run | 04-38 | mapped | attempt 2 carries the real head and the repair prompt names it; control NC-P8f-head |
| tests/worker-reporter.test.ts | an invalid envelope is repaired within the cap | 04-38 | mapped | a wrong job id and a body-shaped summary are repaired to attempt 2 in two model turns; control NC-P8f-repair |
| tests/worker-reporter.test.ts | a body-shaped planner blocker is rejected with the repair prompt | 04-39 | mapped | the second request carries the rejection, the artifact hint and the fix-these-points line; control NC-P8f-repair |
| tests/worker-reporter.test.ts | repair is bounded: past the cap the job fails as envelope_invalid | 04-38 | mapped | no envelope, envelope-rejected.json with the cap and the branch and pr_url errors, and the fleet failure is envelope_invalid naming it; controls NC-P8f-repair, NC-P8f-reject-file |
| tests/worker-reporter.test.ts | blocked reports are first-class | 04-39 | mapped | a blocked planner report is filed with its blockers and reaches intake as a report. No control of its own: it takes the filing path NC-P8f-noop and NC-P8f-write-once break in 04-38 |
| tests/worker-reporter.test.ts | re-reporting is idempotent, and contradicting a report is refused | 04-38 | mapped | three calls in one turn leave attempt 1; the run log shows the no-op and the refusal; controls NC-P8f-noop, NC-P8f-write-once. Narrowed: one turn, not three prompts |
| tests/worker-reporter.test.ts | recursion guard: parent-only tools are blocked inside a worker | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Missing entry point: no dispatched worker is offered a parent-only tool to call. |
| tests/worker-reporter.test.ts | web egress guard: a web call carrying command-post state is refused, a clean one runs (cp-if9x) | 04-40 | mapped | a planner's web_search with a state path never runs, a clean query does; control NC-P8f-web |
| tests/worker-reporter.test.ts | CI-wait guard: a sleep-then-poll bash call is refused, a real command is not (cp-kzc) | 04-40 | mapped | the poll is refused naming head_sha and never reaches GitHub, echo still runs; control NC-P8f-ci-wait |
| tests/worker-reporter.test.ts | N2: bash token output is redacted before the session JSONL and the model see it | 04-40 | mapped | the tool end, the worker's session file and the next request carry [REDACTED] and no token; control NC-P8f-redact |
| tests/worker-reporter.test.ts | a gate-reviewer session produces a schema-valid verdict file | 04-41 | mapped | cp_gate's reviewer files a schema-valid attempt-1 verdict in one turn and the gate reads pass; control NC-P8f-role-tool |
| tests/worker-reporter.test.ts | an over-long reason is clamped and recorded, not rejected — and the original survives | 04-41 | mapped | clamped to GATE_REVIEW_ITEM_MAX at attempt 1, the raw copy holds both originals and the reviewer is told its path; control NC-P8f-clamp |
| tests/worker-reporter.test.ts | a malformed verdict is repaired in-run, without re-reading the artifact | 04-41 | mapped | a wrong job id and revise without revisions repair to attempt 2 in two turns; control NC-P8f-repair |
| tests/worker-reporter.test.ts | verdict repair is bounded, and exhaustion is visible to the parent | 04-41 | mapped | no verdict, verdict-rejected.json with the cap and a revisions error, and the gate reads escalate/operational; controls NC-P8f-repair, NC-P8f-reject-file |
| tests/worker-reporter.test.ts | a planner envelope files without a console hold | 04-39 | mapped | a dispatched planner's plan files at attempt 1 with no rejection and no console question. No control: no guard of ours opens a question to remove |
| tests/worker-reporter.test.ts | an oversize plan_summary is repaired, then filed | 04-39 | mapped | attempt 2 carries the short goal; control NC-P8f-repair |
| tests/worker-reporter.test.ts | review: an answer job never asks for review | 04-39 | mapped | the answer job's report files and opens no console question. No control: an absence with no guard to remove |
| tests/worker-reporter.test.ts | review: an implementer never asks for review | 04-38 | mapped | the implementer's report opens no console question. No control: an absence with no guard to remove |
| tests/worker-reporter.test.ts | exactly one terminating tool per role | 04-38 | mapped | the implementer sees report_result only, the gate reviewer report_verdict only (04-41) and its description states both bounds; controls NC-P8f-role-tool, NC-P8f-verdict-prose |
| tests/worker-reporter.test.ts | job identity comes from the environment and fails closed | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Missing entry point: dispatch always sets a complete CP_* environment. |
| tests/worker-reporter.test.ts | rejection text names the fixes and the remaining budget | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure formatter; 04-38 and 04-39 pin its text in the repair prompt (NC-P8f-repair). |
| tests/worker-reporter.test.ts | edit failures are diagnosed by cause, not left for the worker to guess | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure classifier over every cause; 04-40 pins stale_anchor (NC-P8f-enrich). |
| tests/worker-reporter.test.ts | a not-found edit points at the nearest real line instead of leaving the worker to re-read blind | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper over a fixture file; no dispatched worker is scripted against pi's edit tool. |
| tests/worker-reporter.test.ts | a not-unique edit lists every line it matched, not just the count | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper over a fixture file. |
| tests/worker-reporter.test.ts | an overlap failure is passed through unenriched — the built-in message already names both indices | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper; an absence with no consumer outcome. |
| tests/worker-reporter.test.ts | an unreadable file still gets the cause and hint, just no near-miss line | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper over a missing path. |
| tests/worker-reporter.test.ts | replace/insert failures get a cause and next move, like edit | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper over every anchor cause; 04-40 pins stale_anchor (NC-P8f-enrich). |
| tests/worker-reporter.test.ts | miss counter: identical = same scope and cause (not same input); scopes never pool; resets clear runs | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Counter internals; 04-40 pins the third identical miss (NC-P8f-enrich). |
| tests/worker-reporter.test.ts | credential guards are blocked at tool_call (N1, N2, N5) | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. The bulk-copy, secret-search and allowed halves; 04-40 pins the gh auth probe (NC-P8f-cred). |
| tests/worker-reporter.test.ts | tool_result handler: bash token shapes are redacted, success or error | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. The error and silent-command halves; 04-40 pins a successful bash (NC-P8f-redact). |
| tests/worker-reporter.test.ts | tool_result handler: replace/insert are enriched, and the 3rd identical miss on a file appends the re-read line | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. The insert and edit halves; 04-40 pins three replace misses (NC-P8f-enrich). |
| tests/worker-reporter.test.ts | tool_result handler: misses on different files are not pooled; an input path is preferred | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Counter scoping over handcrafted results; the fake tool cannot vary its path per call. |
| tests/worker-reporter.test.ts | tool_result handler: a successful read resets the run, including the path-less fallback | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Counter reset over handcrafted results. |
| tests/worker-reporter.test.ts | tool_result handler: successes and unrelated results are left untouched | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. An absence; 04-40's plain bash and web calls run unchanged. |
| tests/worker-reporter.test.ts | a replace batch reports the cause once; sibling E_OP_ABORTED lines do not restate it or count as misses | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Missing entry point: a batch abort needs the real hashline tool's batch ids. |
| tests/worker-reporter.test.ts | an E_OP_ABORTED line with no batch id is never deduped onto another operation | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Same batch-id input. |
| tests/worker-reporter.test.ts | a successful edit, replace, or insert clears remembered abort batches | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Same batch-id input. |
| tests/worker-reporter.test.ts | a bash non-zero exit with no output names the command that failed | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. The truncation and unchanged branches; 04-40 pins `Command: false` (NC-P8f-silent). |
| tests/worker-reporter.test.ts | findEditMatchLines falls back to the first non-blank line, then a short prefix, when there is no exact hit | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper. |
| tests/worker-reporter.test.ts | local checks protect the artifact and research porcelain | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Fixture-path branches; P9e-reporter pins the missing-artifact repair end to end. |
| tests/worker-reporter.test.ts | headShaErrors: ship/done needs the worktree HEAD; others untouched | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. The non-done and unreadable branches; 04-38 pins a wrong head (NC-P8f-head). |
| tests/worker-reporter.test.ts | localChecks compares a ship report against the real worktree HEAD | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Same check over a scratch repo; 04-38 pins it (NC-P8f-head). |
| tests/worker-reporter.test.ts | cp-u3o4: an answer over the bound is refused repairably; at the bound it is accepted | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Byte-exact bound pairs; 04-39 files an answer under it. |
| tests/worker-reporter.test.ts | report_verdict advertises a lenient item bound and keeps every other bound of the contract | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Schema comparison; 04-41 pins the clamp outcome (NC-P8f-clamp). |
| tests/worker-reporter.test.ts | clampVerdictItems hard-cuts over-long items to the strict cap and leaves the rest alone | — | retained | Verbatim in tests/worker-reporter-retained.test.ts. Pure helper edge cases; 04-41 pins the clamp (NC-P8f-clamp). |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| NC-P8f-role | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: activation takes every optional package, ignoring the role | an implementer: ponytail and pi-lens |
| NC-P8f-skill | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: activation passes the packages' skills | no package, single or git skill file reaches a worker |
| NC-P8f-single | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: detection drops the inside-the-package skill filter (combined with NC-P8f-skill) | no package, single or git skill file reaches a worker |
| NC-P8f-lens-flags | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: PACKAGE_FLAGS is not applied | implementer: pi-lens runs headless with --no-read-guard |
| NC-P8f-lens-env | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: packageEnv pins no PI_LENS_HOME | implementer: pi-lens logs are pinned out of the worktree |
| NC-P8f-web-tools | tests/worker-packages.test.ts | 04-36 | src/worker-manager.ts: activated package tools are not appended to the allowlist | implementer: pi-lens's tools reach the model |
| NC-P8f-web-enable | tests/worker-packages.test.ts | 04-36 | src/worker-packages.ts: web_enable joins pi-web-access's tools | planner: the lazy web loader never |
| NC-P8f-mention | tests/worker-packages.test.ts | 04-36 | src/worker-manager.ts: withJobSkills drops the per-job skills | only the operator-named skill, for its own job |
| NC-P8f-withhold | tests/worker-packages.test.ts | 04-37 | src/worker-packages.ts: an unavailable provider is not withheld | an unusable provider is absence |
| NC-P8f-error | tests/worker-packages.test.ts | 04-37 | src/worker-packages.ts: a failed resolution returns no error | pi's own failure leads the run-log line |
| NC-P8f-dir | tests/worker-packages.test.ts | 04-37 | src/worker-packages.ts: an extension resolves to its directory | worker exited (code=1 signal=null) before responding: Failed to load extension ".../ponytail/extensions" |
| NC-P8f-kill-close | tests/worker-process.test.ts | 04-20 | src/worker-process.ts: a signalled close never resolves `closed` | timed out after 30000ms waiting for the recorded death |
| NC-P8f-noop | tests/worker-reporter.test.ts | 04-38 | extensions/worker-reporter/index.ts: an identical re-report is not recognised | an identical re-report is a no-op |
| NC-P8f-write-once | tests/worker-reporter.test.ts | 04-38 | extensions/worker-reporter/index.ts: an existing record is not checked | neither re-report touches the record |
| NC-P8f-repair | tests/worker-reporter.test.ts | 04-38 | extensions/worker-reporter/index.ts: no repair attempt is offered | timed out waiting for the accepted envelope; 04-39 and 04-41 fail the same way |
| NC-P8f-reject-file | tests/worker-reporter.test.ts | 04-38 | extensions/worker-reporter/index.ts: the rejection file is never written | the capped job's failure; 04-41's verdict-rejected.json read fails too |
| NC-P8f-head | tests/worker-reporter.test.ts | 04-38 | extensions/worker-reporter/head.ts: head_sha is never compared to HEAD | the corrected head is attempt 2 |
| NC-P8f-ci-wait | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: a CI wait is not blocked | timed out after 90000ms waiting for the guard job's 8 tool results |
| NC-P8f-cred | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: a gh auth probe is not blocked | a credential probe is refused with the sanctioned read |
| NC-P8f-web | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: a state-bearing web call is not blocked | a web call carrying command-post state never runs |
| NC-P8f-redact | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: bash output is not redacted | tool_execution_end carries [REDACTED] |
| NC-P8f-silent | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: a silent bash failure is not enriched | a silent non-zero exit names its command |
| NC-P8f-enrich | tests/worker-reporter.test.ts | 04-40 | extensions/worker-reporter/index.ts: edit failures are not enriched | /cause: stale_anchor/ |
| NC-P8f-clamp | tests/worker-reporter.test.ts | 04-41 | extensions/worker-reporter/index.ts: clampVerdictItems never clamps | an over-long item is clamped, not rejected |
| NC-P8f-role-tool | tests/worker-reporter.test.ts | 04-41 | extensions/worker-reporter/index.ts: the gate reviewer is not given report_verdict | a reviewer reports only a verdict |
| NC-P8f-verdict-prose | tests/worker-reporter.test.ts | 04-41 | extensions/worker-reporter/index.ts: the 400-character cap leaves the description | the reason cap is in the prose the model reads |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-packages-p8f.test.ts | P8f | behavior 04, optional worker packages through cp_dispatch; scenarios 04-36..04-37 |
| tests/harness/package-home.ts | P8f | e2e harness: a CommandPost over a pi agent dir with fake installed packages |
| tests/worker-packages-retained.test.ts | P8f | convert-owned; 22 declarations of tests/worker-packages.test.ts retained verbatim |
| tests/e2e/worker-reporter-p8f.test.ts | P8f | behavior 04, the worker reporter on dispatched and gated workers; scenarios 04-38..04-41 |
| tests/worker-reporter-retained.test.ts | P8f | convert-owned; 27 declarations of tests/worker-reporter.test.ts retained verbatim |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/worker-packages.test.ts` | deleted | P8f | behavior 04: 12 mapped (04-36, 04-37), 22 retained in tests/worker-packages-retained.test.ts; controls NC-P8f-role, NC-P8f-skill, NC-P8f-single, NC-P8f-lens-flags, NC-P8f-lens-env, NC-P8f-web-tools, NC-P8f-web-enable, NC-P8f-mention, NC-P8f-withhold, NC-P8f-error, NC-P8f-dir |
| `tests/worker-reporter.test.ts` | deleted | P8f | behavior 04: 20 mapped (04-38..04-41), 27 retained in tests/worker-reporter-retained.test.ts; controls NC-P8f-noop, NC-P8f-write-once, NC-P8f-repair, NC-P8f-reject-file, NC-P8f-head, NC-P8f-ci-wait, NC-P8f-cred, NC-P8f-web, NC-P8f-redact, NC-P8f-silent, NC-P8f-enrich, NC-P8f-clamp, NC-P8f-role-tool, NC-P8f-verdict-prose |
<!-- /manifest:baseline -->
