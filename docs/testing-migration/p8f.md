# Ledger rows: p8f

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8f (cp-e2e-migration-p8f-skvg) | behavior 04, sixth slice: optional worker packages through cp_dispatch, role activation (04-36) and resolution faults (04-37) in `tests/e2e/worker-packages-p8f.test.ts`: `tests/worker-packages.test.ts` 12 mapped, 22 retained in `tests/worker-packages-retained.test.ts`; the #543 review lows (a control for the kill -9 row, the p8e incoming range, three narrowings noted or pinned, stale citations); `tests/worker-reporter.test.ts` stays `convert` for a follow-on slice | 1 (`tests/worker-packages.test.ts`) |
<!-- /manifest:ledger -->

P8f (job `cp-e2e-migration-p8f-skvg`) is the sixth behavior-04 slice. Fake packages sit in the parent's pi agent dir
as `pi install` lays them out, and real workers are dispatched through a real CommandPost; argv, environment and the
model's offered tools are read from the live worker. Each control below changed one guard, failed in the named case,
and was restored. `tests/worker-reporter.test.ts` (1539 lines) is untouched: one job could not carry both files'
mapping and controls, so it stays `convert` in p8.md for one follow-on, all or nothing.

`tests/worker-packages.test.ts` retains 22 of 34 (65%). Eleven pin pi's own `DefaultPackageManager` on fixture
layouts (empty, one or both installed, malformed, glob, unconfigured, symlinked or skills-only, pi-lens absent):
no guard of ours decides those, so no control can fail them. Three read the pi docs the CLI flags rest on, one reads
the machine's real install and skips without it. Two pin frozen defaults and named constants, three need a profile
`packages:` override or a never-list name in a profile (profiles are package data), one drives a spawn racing an
unsettled resolution, and one scans src/ for spawn sites. The gate-reviewer cannot be cp_dispatched (its brief needs
the gate's task), so the caveman row naming it stays whole; the per-role and web rows below note that narrowing.

The #543 lows: the kill -9 row (04-20) gets NC-P8f-kill-close; the p8e incoming row now reads 04-27..04-32; the
malformed script cap now pins "no branch" in 04-35, and the prompt-to-shutdown and busy-receipt rows note what they
narrow. Stale citations of deleted test files are fixed in docs/contracts.md, docs/build-history.md,
src/worker-packages.ts and tests/harness/hermetic-env.ts. `tests/contracts-anchors.test.ts`, README.md, s19.md,
p8b.md, `scripts/test-shards.ts` and ci.yml cite none of them, and the deleted file's timing entry is dropped.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8f | 04 | tests/e2e/worker-packages-p8f.test.ts | 2 new |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-36 | tests/e2e/worker-packages-p8f.test.ts | P8f packages: each dispatched role loads only its installed packages and their tools, never caveman, a skill file or a never-list skill; an operator-named skill reaches its own job |
| 04-37 | tests/e2e/worker-packages-p8f.test.ts | P8f package faults: a failed resolution spawns the bare argv and says why; an unkeyed web provider withholds pi-web-access until a key arrives; a directory manifest reaches -e as entry files |
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
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-packages-p8f.test.ts | P8f | behavior 04, optional worker packages through cp_dispatch; scenarios 04-36..04-37 |
| tests/harness/package-home.ts | P8f | e2e harness: a CommandPost over a pi agent dir with fake installed packages |
| tests/worker-packages-retained.test.ts | P8f | convert-owned; 22 declarations of tests/worker-packages.test.ts retained verbatim |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/worker-packages.test.ts` | deleted | P8f | behavior 04: 12 mapped (04-36, 04-37), 22 retained in tests/worker-packages-retained.test.ts; controls NC-P8f-role, NC-P8f-skill, NC-P8f-single, NC-P8f-lens-flags, NC-P8f-lens-env, NC-P8f-web-tools, NC-P8f-web-enable, NC-P8f-mention, NC-P8f-withhold, NC-P8f-error, NC-P8f-dir |
<!-- /manifest:baseline -->
