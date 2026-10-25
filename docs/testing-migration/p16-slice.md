# Ledger rows: p16-slice

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P16a (cp-e2e-migration-p16-ujq5) | behavior 14, first slice: home scaffold, flat layout, mode resolution, the br_id state sweep, USER.md delivery, and doctor's home-checkout and storage findings through real pi parents loaded from a scratch copy of the package, in `tests/e2e/configuration.test.ts` (59 declarations from 7 files: 55 mapped to P16-*, 4 retained verbatim in `tests/scaffold-retained.test.ts` and `tests/layout-flat-retained.test.ts`; controls P16-S1..S7). The other 10 P16 files stay `convert` for one follow-on | 7 (mixed move for scaffold and layout-flat: no fully-deleted-file credit for those 2) |
<!-- /manifest:ledger -->

Behavior 14, first slice. Each scenario copies this checkout's files into a scratch root as
`<root>/.pi-command-post/app`, a git checkout with a bare origin. It then starts real `pi --mode rpc` parents on that
copy with a hermetic agent dir and the mock provider. A parent with no `CP_HOME` therefore resolves a scratch home,
never this worktree. The scenarios read `/cp-version`, the startup notices, `/doctor --json`, the model's request
bodies, a scripted `cp_next` and `cp_check` call, the scratch files and a viewer started on the flat home.

Retained, not reachable: the 4 kept units have no product entry point. Two are static package checks: the manifest
shape and the directory skeleton. One is `scaffoldHome({ ledger: false })`, which no product code calls. One is the
process-global `configureLayout` guard.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P16a | 14 | `tests/e2e/configuration.test.ts` | 5 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P16-scaffold | `tests/e2e/configuration.test.ts` | P16-scaffold: a first session scaffolds a fresh home once, an operator's own files and an existing ledger are never rewritten, and a bad CP_LEDGER_PREFIX writes no ledger |
| P16-mode | `tests/e2e/configuration.test.ts` | P16-mode: CP_MODE, settings.json, the launch directory and CP_HOME resolve one multi home or refuse with the reason |
| P16-migration | `tests/e2e/configuration.test.ts` | P16-migration: a session sweeps br_id to job_id once, leaves malformed and non-state files alone, and doctor reports what remains |
| P16-user-context | `tests/e2e/configuration.test.ts` | P16-user-context: USER.md beside the package's AGENTS.md reaches the model once with its precedence, truncated when runaway, and absent, empty or unreadable files send nothing |
| P16-doctor-home | `tests/e2e/configuration.test.ts` | P16-doctor-home: doctor and cp_next warn about a clean checkout home behind main without changing it, and doctor names stray home, state, alias and handoff storage |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/scaffold.test.ts | PACKAGE_ROOT resolves to the repo root | P16-scaffold | mapped | `/cp-version` names the loaded copy's root |
| tests/scaffold.test.ts | readPackageIdentity reads name and version from the manifest | P16-scaffold | mapped | `/cp-version` opens with `picp <semver>` |
| tests/scaffold.test.ts | readPackageIdentity fails closed on a missing manifest | P16-scaffold | mapped | `/cp-version` on a copy with no package.json reports `cannot read …/package.json` and prints no identity |
| tests/scaffold.test.ts | pi manifest declares the parent extension and not the worker extension | — | retained | kept verbatim in tests/scaffold-retained.test.ts; static package.json shape, no runtime consumer |
| tests/scaffold.test.ts | package directory skeleton exists | — | retained | kept verbatim in tests/scaffold-retained.test.ts; static tree shape, no runtime consumer |
| tests/scaffold.test.ts | gitignore keeps runtime state out of the repo | P16-doctor-home | mapped | a scaffolded checkout home leaves `git status --porcelain` empty |
| tests/scaffold.test.ts | an installed package never keeps its state inside its own clone | P16-mode | mapped | copies under `.pi/agent/git/`, `.pi/agent/npm/`, a project's `.pi/git/` and `.pi/npm/`, and `node_modules/` each resolve `source: managed` to the standard home and write nothing in the clone |
| tests/scaffold.test.ts | scaffolding a fresh home creates what a dispatch needs, once | P16-scaffold | mapped | the startup notice lists every created step; a second session announces nothing |
| tests/scaffold.test.ts | an existing jobs document is never rewritten, whatever the prefix in the environment says | P16-scaffold | mapped | relaunch with `CP_LEDGER_PREFIX=cps` leaves the ledger bytes unchanged |
| tests/scaffold.test.ts | an operator's own data/routing.json is never overwritten by the shipped default | P16-scaffold | mapped | the operator's routing.json bytes survive the first session |
| tests/scaffold.test.ts | a package root with no shipped default is a skip, not a failure | P16-scaffold | mapped | `· routing.default: skipped` and the ledger is still created |
| tests/scaffold.test.ts | a home's own .gitignore is never rewritten | P16-scaffold | mapped | the operator's `.gitignore` bytes survive |
| tests/scaffold.test.ts | the ledger step can be turned off for a home that will never dispatch | — | retained | kept verbatim in tests/scaffold-retained.test.ts; `ledger: false` has no product caller |
| tests/scaffold.test.ts | CP_LEDGER_PREFIX unset or empty: the document is created with prefix cp | P16-scaffold | mapped | a blank prefix writes `prefix: cp` |
| tests/scaffold.test.ts | CP_LEDGER_PREFIX=cps: the document records that prefix | P16-scaffold | mapped | the owned home's ledger records `cps` |
| tests/scaffold.test.ts | an invalid CP_LEDGER_PREFIX is refused and no document is written | P16-scaffold | mapped | five bad prefixes: `! ledger: failed` and no jobs document |
| tests/layout-flat.test.ts | the runtime root rule is the basename, and the viewer's contracts-free copy agrees | P16-doctor-home | mapped | the viewer's state dir for the flat home is `<home>/state` and reads what the parent scaffolded there |
| tests/layout-flat.test.ts | configureLayout(multi, flat home) puts every path directly under the home; nothing else may reconfigure it | — | retained | kept verbatim in tests/layout-flat-retained.test.ts; process-global layout guard, no entry point reconfigures a running parent |
| tests/layout-flat.test.ts | a flat home scaffolds data/, state/, projects/ and the ledger directly: no dotdir, no .gitignore, idempotent | P16-scaffold | mapped | the standard home's steps, no nested dotdir or `.gitignore`, scaffolded once |
| tests/layout-flat.test.ts | a flat home passes doctor's scaffold and storage checks, app/ and settings.json included | P16-doctor-home | mapped | `/doctor` on the standard home: scaffold.* and storage ok, a stray file named |
| tests/layout-flat.test.ts | the viewer reads a flat home's fleet and ledger | P16-doctor-home | mapped | `GET /api/jobs` on a viewer over the flat home lists the job and its title |
| tests/mode.test.ts | resolution table: environment, settings, directory shape -> mode, home, source | P16-mode | mapped | CP_HOME, CP_MODE, settings, home-dir, checkout, standard and managed sources through `/cp-version` |
| tests/mode.test.ts | the standard home: its app/ checkout resolves ~/.pi-command-post (flat), never app/ itself; CP_HOME still wins | P16-scaffold | mapped | launch from `app/src` with and without CP_HOME |
| tests/mode.test.ts | a repo named .pi-command-post keeps the nested settings.json, and single there is refused (review fix) | P16-mode | mapped | the refusal names the nested settings.json |
| tests/mode.test.ts | another home's nested .pi-command-post is never taken for a flat standard home (review fix, matches storage.alias) | P16-mode | mapped | with git refused as a repository, without git the standard home |
| tests/mode.test.ts | the settings file wins over the default and loses to CP_MODE; garbage is reported and ignored | P16-mode | mapped | settings source, CP_MODE override and the `settings.json ignored` note |
| tests/mode.test.ts | refusals: an invalid CP_MODE, and single anywhere (env or settings, with or without a repository, in a multi home) | P16-mode | mapped | invalid CP_MODE, CP_MODE=single and settings single refusals |
| tests/mode.test.ts | a former single-project home is refused as CP_HOME and as a launch directory, and names its state | P16-mode | mapped | both refusals through `/cp-version` |
| tests/mode.test.ts | the source checkout with state/, no projects/ and an exclude line still resolves multi (never taken for a former single home) | P16-mode | mapped | the copy with state/ and an exclude line resolves `source: checkout` |
| tests/mode.test.ts | isMultiHomeDir needs both .pi-command-post/projects/ and .pi-command-post/state/ | P16-mode | mapped | both dirs: home-dir; state/ alone: the standard home |
| tests/mode.test.ts | describeRuntime and resolveProjectArg: multi line, project required | P16-doctor-home | mapped | the `/cp-version` runtime line, and a scripted `cp_check` with a blank project refused |
| tests/mode.test.ts | gitToplevel against a real repository resolves symlinks and returns undefined outside one | P16-mode | mapped | a symlinked subdirectory's refusal names the real toplevel; plain dirs resolve |
| tests/mode.test.ts | a real repository is refused at resolution, before anything is scaffolded | P16-mode | mapped | refused repository has no `.pi-command-post` and a clean tree |
| tests/state-migrations.test.ts | renameKeyDeep renames object keys at every depth and never touches values | P16-migration | mapped | nested keys renamed; the `"br_id"` string value and text payload kept |
| tests/state-migrations.test.ts | listSweepTargets finds json documents and jsonl journals under state/ and skips sessions, backups and prose | P16-migration | mapped | 3 documents and 1 journal renamed; sessions, backup and brief.md byte-identical |
| tests/state-migrations.test.ts | the sweep renames documents and journal lines, copies a malformed line verbatim, writes the marker, and is a no-op afterwards | P16-migration | mapped | the startup notice, the rewritten files, the marker, and a silent second session |
| tests/state-migrations.test.ts | an unparseable document is reported and left exactly as it was | P16-migration | mapped | `! …cp-x/status.json: not JSON, left as is` and unchanged bytes |
| tests/state-migrations.test.ts | a home with no state at all sweeps to an empty report and still writes the marker | P16-migration | mapped | an empty home: no notice, marker written |
| tests/state-migrations.test.ts | doctor: unswept files are an error, a swept home is ok, and a legacy file behind the marker is a warning | P16-migration | mapped | `/doctor` mid-session: warn behind the marker, error once the marker is removed, ok after cleanup |
| tests/user-context.test.ts | no USER.md loads nothing and reports nothing | P16-user-context | mapped | no header in the model request |
| tests/user-context.test.ts | an empty or whitespace-only USER.md is treated as absent | P16-user-context | mapped | whitespace-only file: no header |
| tests/user-context.test.ts | a present but unreadable USER.md is treated as absent, not an error | P16-user-context | mapped | a directory named USER.md (unreadable for root too): no header and no notice |
| tests/user-context.test.ts | a present USER.md is discoverable, readable and carries its precedence | P16-user-context | mapped | header names the file; precedence text and body in the request |
| tests/user-context.test.ts | a runaway USER.md is truncated, not refused | P16-user-context | mapped | 8000 chars kept, the tail dropped, the truncation note sent |
| tests/user-context.test.ts | truncation can never cut the precedence away from the content | P16-user-context | mapped | the truncated request still carries the header and precedence |
| tests/user-context.test.ts | USER.md is read beside AGENTS.md, not under the command post home | P16-user-context | mapped | USER.md files in the home and the scratch root are never sent |
| tests/user-context.test.ts | session_start sends nothing when there is no USER.md | P16-user-context | mapped | the first parent's request has no header |
| tests/user-context.test.ts | session_start sends a present USER.md once, as background context | P16-user-context | mapped | one header across two prompts, never a displayed notice |
| tests/user-context.test.ts | the scaffold never creates USER.md, and never touches an existing one | P16-scaffold | mapped | no USER.md after scaffold; an operator's survives a relaunch |
| tests/user-context.test.ts | git never exposes USER.md at the repo root | P16-user-context | mapped | `git status --porcelain` empty with USER.md present |
| tests/user-context.test.ts | AGENTS.md tells the parent to read USER.md and states its precedence | P16-user-context | mapped | the injected contract in the model request carries the USER.md paragraph |
| tests/home-checkout.test.ts | doctor and cp_next warn about a clean home behind main without changing it | P16-doctor-home | mapped | `/doctor` and scripted `cp_next` both warn, with and without an active mandate (still `action: dispatch` of the ledger job); HEAD, origin/main and the tree unchanged; auto-update fix text |
| tests/home-checkout.test.ts | home lag advice is absent for ${state} | P16-doctor-home | mapped | `/doctor` and `cp_next` silent for untracked, modified, staged (on a fetched, behind checkout), current, unfetched, diverged, ahead and separate-home; missing-main is the `comparison with origin/main unavailable` warning in both |
| tests/storage.test.ts | a home with only .pi-command-post/ and .gitignore is one ok storage finding; another tool's directory is kept | P16-doctor-home | mapped | one ok storage finding; `.other-tool` still present after doctor |
| tests/storage.test.ts | storage.home: a leftover top-level state/ in a home without .git is a warn | P16-doctor-home | mapped | a top-level `state/` is listed |
| tests/storage.test.ts | storage.alias: a flat-named home inside another home warns and names the parent; a standard home does not | P16-doctor-home | mapped | CP_HOME at the nested root warns on `.gitignore` evidence, then on `.git/info/exclude` evidence, and not at all with neither; the standard home does not |
| tests/storage.test.ts | storage.home: a checkout home lists untracked, unignored paths through git | P16-doctor-home | mapped | an untracked `stray.txt` in the checkout home is listed; a corrupt index is `could not be listed` with the git exit |
| tests/storage.test.ts | storage.state: operator material at the top of state/ is a warn; records are not | P16-doctor-home | mapped | `notes.md` listed; `.json`, `.jsonl`, `.lock`, `.sock`, `.log`, `.tmp` records and `runs/` not |
| tests/storage.test.ts | storage.handoffs_dir: invalid JSON and a directory outside the home warn; inside the home is fine | P16-doctor-home | mapped | invalid JSON and outside warn; inside has no finding |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P16-S1 | tests/scaffold.test.ts | P16-scaffold | the ledger step skips its present check, so every session re-scaffolds | `a scaffolded home is not scaffolded again` |
| P16-S2 | tests/mode.test.ts | P16-mode | a settings.json saying single is no longer refused | `single-project mode was removed; .*settings\.json says single` |
| P16-S3 | tests/state-migrations.test.ts | P16-migration | the sweep never writes its marker | `an empty home still writes the marker` |
| P16-S4 | tests/user-context.test.ts | P16-user-context | a runaway USER.md is sent whole instead of truncated | `The expression evaluated to a falsy value` (8000 x kept, no 8001st, no TAIL) |
| P16-S5 | tests/home-checkout.test.ts | P16-doctor-home | the checkout lag finding ignores a dirty tree | `untracked` (doctor's home.checkout deepEqual for the dirty state) |
| P16-S6 | tests/layout-flat.test.ts | P16-scaffold | a flat home gets the nested home's `.gitignore` step | `Expected values to be strictly deep-equal` (the flat home's step list) |
| P16-S7 | tests/storage.test.ts | P16-doctor-home | the alias guard never reports an enclosing home | the `storage.alias` match on the nested CP_HOME fails: no finding |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/configuration.test.ts | cp-e2e-migration-p16-ujq5 | P16-* through real pi parents on a scratch copy of the package and the mock provider |
| tests/scaffold-retained.test.ts | cp-e2e-migration-p16-ujq5 | 3 units of tests/scaffold.test.ts with no entry point |
| tests/layout-flat-retained.test.ts | cp-e2e-migration-p16-ujq5 | the process-global configureLayout guard |
<!-- /manifest:incoming -->
