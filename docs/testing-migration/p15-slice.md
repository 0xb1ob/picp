# Ledger rows: p15-slice

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P15 (cp-e2e-migration-p15-18d4) | behavior 13, project tracker: `cp_job`, `/cp-jobs` and `cp_project` through a real parent pi on the mock provider, in `tests/e2e/project-tracker.test.ts` (85 declarations in five files: 75 mapped to P15-jobs-lifecycle, -jobs-refusals, -jobs-refs-scope, -ledger-file and -projects, 10 retained verbatim in three `*-retained.test.ts` files; `tests/fake-parent-tracker.test.ts` retained whole as a harness test; controls P15-C1..C10) | 2 (`tests/trackers-ledger.test.ts`, `tests/verify-external-ref.test.ts`; the other three are mixed moves with no fully-deleted-file credit) |
<!-- /manifest:ledger -->

Behavior 13. Each P15 scenario boots one real `pi --mode rpc` parent with the command-post extension on a scratch
home and scripts its tool calls through the mock provider. The parent runs `cp_job`, `cp_project` and `/cp-jobs`, and
`gh` is a scripted stub on its PATH. The scenarios then read the tool results, the slash-command notices, `jobs.json`,
`projects.json`, the rendered `projects.md`, the escalation store and the stub's call log. No scenario skips.

Retained, not reachable: 10 units call helpers that no tool or command reaches. They are `recordAssessedRisk`,
seeded `mintJobId` draws, `Ledger.history`, `importJobs`, `ProjectRegistry.update`/`remove`, `assertCanonicalRepo`,
a nested-clone layout, a throwing CI probe and the `launching`/`awaiting_merge` fleet phases. Each row names what is
missing. `tests/fake-parent-tracker.test.ts` pins the e2e fixture's own process tracking, as `tests/harness.test.ts`
does.

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P15-jobs-lifecycle | `tests/e2e/project-tracker.test.ts` | P15-jobs-lifecycle: cp_job records, queries, gates and closes jobs, and /cp-jobs reads the same ledger |
| P15-jobs-refusals | `tests/e2e/project-tracker.test.ts` | P15-jobs-refusals: cp_job refuses bad intake, guards live workers and unreported blockers, and repairs legacy labels |
| P15-jobs-refs-scope | `tests/e2e/project-tracker.test.ts` | P15-jobs-refs-scope: external refs are verified through gh, amend freezes quoted scope, schedule and reviewer caps hold |
| P15-ledger-file | `tests/e2e/project-tracker.test.ts` | P15-ledger-file: the parent creates the ledger once, fails closed on a broken file, and archives retired fields first |
| P15-projects | `tests/e2e/project-tracker.test.ts` | P15-projects: cp_project registers, clones, detects who merges, reads CI readiness and keeps per-project settings |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/jobs-tool.test.ts | cp_job amend freezes authorized scope in order and refuses unverified quotes and closed jobs | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | cp_job is forbidden to workers and exposes exactly the spec's actions | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | create -> show -> list -> ready -> claim -> comment -> close through the action runner | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | conflicting and duplicate reserved labels refuse with no write or receipt; normal intake still dedupes | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | list marks legacy label faults and preserves search and narrow repair | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | riskkw-f10: cp_job create records risk as a label | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | a schedule: label is refused on create and update unless a parent-expanded schedule has a deferred anchor; fan-out create is idempotent | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | cp_job on a cp-org-pr-review run: risk:high from the label or the parameter counts against max_reviewers; an idempotent re-create past the cap returns the job | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | intake: three-item list with one dep; re-run creates nothing | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | cp_job script create dedupes only identical actions and shows the declaration | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | cp_job create stores a non-url external_ref and show prints it as the ref line | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | refusals at the boundary: pipeline/answer deliveries, a live worker on close/drop, missing arguments | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | dependencies through the runner: dep_add gates ready, blocked lists blockers, dep_remove frees | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | issue #2: dep_remove refuses a blocker whose worker never reported, warns on an open one | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | parseJobsArgs: ready by default, list flags, show needs an id | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | formatJobLine is one line: id, status, project, delivery/kind, title | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | portsFor's hasLiveWorker: launching has no worker; waiting/held do, done/failed do not | — | retained | kept verbatim in tests/jobs-tool-retained.test.ts; launching and awaiting_merge fleet records need a script or a parking record no cp_job scenario seeds |
| tests/jobs-tool.test.ts | registerJobs wires cp_job and /cp-jobs to the same ledger | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | create resolves project through the runtime: required | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/jobs-tool.test.ts | the cp_job schema refuses the retired type and priority arguments, on create and on update | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/jobs-tool.test.ts | cp_job create refuses a merged-PR ref at an issue url, and two bad refs in one project escalate once | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | cp_job create: an open issue ref creates the job as today, with the verified fact as a note | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/jobs-tool.test.ts | cp_job create: gh unreachable records a note and proceeds, no refusal | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/ledger.test.ts | job labels round trip and are read fail-closed | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | riskkw-f10: create records risk as a label and refuses a second or malformed one | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | riskkw: only an assessed high writes a `risk:` label, and it replaces a stale low | — | retained | kept verbatim in tests/ledger-retained.test.ts; recordAssessedRisk runs only inside classify and dispatch, never from cp_job |
| tests/ledger.test.ts | initJobsDocument creates an empty document once and never rewrites it | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | readJobsDocument fails closed: missing, not JSON, invalid shape, broken invariant | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | mintJobId draws four lowercase base36 characters, redraws on collision and lengthens after eight | — | retained | kept verbatim in tests/ledger-retained.test.ts; collisions and the eight-redraw lengthening need a seeded random source; P15-jobs-lifecycle pins the id shape |
| tests/ledger.test.ts | create accepts a research board delivery | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | intake refuses what the contract forbids, before anything is written | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | reserved extra labels refuse before minting or writing, including identical duplicates | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | legacy conflicting labels remain readable and searchable, refuse writes, and permit ID repair | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | untouched legacy faults permit healthy writes and sequential ID repairs, but touched faults refuse | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | create writes a valid record with the job labels, defaults and the actor-free shape | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | script declarations persist only for ship/local with a safe repository-relative path | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | findDuplicate: project+title or external_ref, open jobs only | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | direct create dedupes matching action and refuses a changed script action | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/ledger.test.ts | external_ref is a pointer to wherever the issue lives: a url, a path, or the command that shows it | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | the full job lifecycle: create -> ready -> claim -> comment -> close, and a close is a transition | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | drop closes with a reason and never deletes | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | a dropped close keeps dependents blocked; a landed close alone satisfies them | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | dependencies gate ready, blockersOf is fail-closed, and the graph refuses self, unknown and cycles | P15-jobs-lifecycle | mapped | cp_job and /cp-jobs through a real parent |
| tests/ledger.test.ts | list filters AND labels and statuses, limit 0 is unlimited, history is newest-closed first | — | retained | kept verbatim in tests/ledger-retained.test.ts; Ledger.history and an injected clock have no tool or command |
| tests/ledger.test.ts | importJobs appends pre-built records and refuses a duplicate id | — | retained | kept verbatim in tests/ledger-retained.test.ts; importJobs has no production caller |
| tests/ledger.test.ts | a write that cannot land leaves the previous document intact | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | a document written with type and priority still reads, and the next mutation writes it without them | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | the retired type and priority values are archived durably before the mutation that drops them | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | a mutation refuses and rewrites nothing when the retired fields cannot be archived | P15-ledger-file | mapped | jobs.json as the parent boots and cp_job writes it |
| tests/ledger.test.ts | every path that reads a jobs document from disk goes through the legacy strip | — | retained | kept verbatim in tests/ledger-retained.test.ts; a structural sweep over every reader; P15-ledger-file pins the strip through the tool |
| tests/projects.test.ts | reviewer preference persists, displays, replaces and clears; refusals do not write | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | after_merge_deploy stores, defaults its branch, refuses bad input, prints, and clears (#326) | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project reviewer_model dispatches set/clear and displays the saved preference | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project after_merge_deploy sets, shows and clears the opt-in; a call without deploy is refused | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | forge: legacy registries read unchanged; set/show/clear stores only non-secret settings; refusals write nothing | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | forge at registration must fit the clone url; an https remote on another host is refused | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project forge sets and clears through the tool; a token value has no parameter | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | an empty registry reads clean and creates nothing | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | registration writes the machine registry and the human view | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | one canonical clone per name and per remote | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | project names must survive as directories and as job labels | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | update and remove keep the registry consistent | — | retained | kept verbatim in tests/projects-retained.test.ts; ProjectRegistry.update/remove have no cp_project action |
| tests/projects.test.ts | a corrupt or contract-violating registry is refused | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | remote urls compare without .git noise | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | clone on demand is idempotent and lands in projects/<name> | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project's path: register from the session, twice, and render it | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | a worker can never register a project | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/projects.test.ts | an existing directory with a foreign origin is reported, never adopted | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | belongs to another repo: linked worktrees and nested clones are refused | — | retained | kept verbatim in tests/projects-retained.test.ts; a nested clone inside another repo has no cp_project path; P15-projects pins the linked worktree |
| tests/projects.test.ts | assertCanonicalRepo passes the main worktree and refuses a linked worktree and a nested clone | — | retained | kept verbatim in tests/projects-retained.test.ts; assertCanonicalRepo has no tool or command caller |
| tests/projects.test.ts | an old registry without archived still validates; archive/unarchive round-trips and keeps names() | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | merge_policy round-trips: absent is repo, human_handoff persists and renders, repo drops the key, junk is refused | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | register stores merge_policy human_handoff; repo and absent store no key; junk is refused and writes nothing | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | classifyMergeFlow: solo only when every signal agrees; a failed probe is human_handoff | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | ghMergeFlowProbe reads login, repo view, base rules and CODEOWNERS on the base; an unreadable call throws | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project add: new projects default to human_handoff, detection may set repo, explicit policy skips it, re-add changes nothing | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/projects.test.ts | cp_project add readiness: delivery:local wording, and a throwing probe never fails add | — | retained | kept verbatim in tests/projects-retained.test.ts; the CI probe never throws through gh (execRunner returns errors); P15-projects pins the local wording |
| tests/projects.test.ts | the ledger refuses a job in an archived project with a clear message | P15-projects | mapped | cp_project through a real parent and the gh stub |
| tests/trackers-ledger.test.ts | ordinary create is unchanged by tracker links, and the document refuses a duplicate key | P15-jobs-refusals | mapped | refused through cp_job or previewDispatch with nothing written |
| tests/verify-external-ref.test.ts | github issue url: open issue verifies clean, no mismatch | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/verify-external-ref.test.ts | github issue url that is actually a merged PR: wrong kind, mismatch | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/verify-external-ref.test.ts | github 404: not found, mismatch | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/verify-external-ref.test.ts | gh unreachable: note-worthy, never a mismatch | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/verify-external-ref.test.ts | bare file path: missing is a mismatch, existing is not | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
| tests/verify-external-ref.test.ts | anything else is unverifiable, never a mismatch | P15-jobs-refs-scope | mapped | external_ref through the gh stub, amend, schedule and reviewer caps |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P15-C1 | tests/ledger.test.ts | P15-jobs-lifecycle | `isReady` ignores open blockers | the `ready-gated` titles deep-equal `["one", "two"]` |
| P15-C2 | tests/ledger.test.ts | P15-jobs-lifecycle | `findDuplicate` also matches closed jobs | `dup-closed` |
| P15-C3 | tests/jobs-tool.test.ts | P15-jobs-refusals | close and drop skip the live-worker guard | `close waiting should be refused` |
| P15-C4 | tests/trackers-ledger.test.ts | P15-jobs-refusals | the document check lets two jobs link one tracker item | `duplicate-link should be refused` |
| P15-C5 | tests/verify-external-ref.test.ts | P15-jobs-refs-scope | `describeRefMismatch` reports no mismatch | `merged should be refused` |
| P15-C6 | tests/ledger.test.ts | P15-ledger-file | the document check skips duplicate ids | `duplicate should be refused` |
| P15-C7 | tests/projects.test.ts | P15-projects | `classifyMergeFlow` always answers human_handoff | `solo` |
| P15-C8 | tests/projects.test.ts | P15-projects | the CI denial classifier never matches | `denied` |
| P15-C9 | tests/projects.test.ts | P15-projects | the canonical-clone check skips its linked-worktree test | `linked` |
| P15-C10 | tests/ledger.test.ts | P15-ledger-file | `atomicWriteText` swallows a staging write that fails (the squatted temp path) | `read-only should be refused` |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/project-tracker.test.ts | cp-e2e-migration-p15-18d4 | P15-* scenarios through a real parent pi on the mock provider |
| tests/jobs-tool-retained.test.ts | cp-e2e-migration-p15-18d4 | 1 verbatim declaration: portsFor's hasLiveWorker over every fleet phase |
| tests/ledger-retained.test.ts | cp-e2e-migration-p15-18d4 | 5 verbatim declarations: helpers no tool or command reaches |
| tests/projects-retained.test.ts | cp-e2e-migration-p15-18d4 | 4 verbatim declarations: registry and clone helpers no cp_project call reaches |
<!-- /manifest:incoming -->
