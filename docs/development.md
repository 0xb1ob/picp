# Development

Notes for changing pi-command-post itself. Newcomers start at the
[README](../README.md).

## Running from a checkout

```bash
git clone https://github.com/0xb1ob/picp.git
cd picp
npm install
./bin/cp-operator
```

A source checkout is its own home: its state lives in the gitignored
`<checkout>/.pi-command-post/`. `CP_HOME=/path` picks another home and wins over
every other rule; `/doctor` prints the home it chose and why
([storage.md](storage.md)). A plain git repository that is not a command-post
checkout is refused as a home (single-project mode was removed).

## Tests

```bash
npm run typecheck
npm test                                        # everything, mock-backed: no tokens, no network
npm run test:one -- tests/answer-card.test.ts   # one file, same hermetic preload
npm run e2e:phase1                              # worker lifecycle
npm run e2e:phase2                              # dispatch → envelope → promote → teardown
npm run e2e:phase3                              # pipeline: research → gate → checkpoint → implement
```

Running the existing checks is always required; authoring new tests is not. A worker adds a test only for acceptance
supplied by the brief or a human, or a reproducing regression for a reported bug. Behavioral acceptance defaults to the
mock-provider e2e harness through real product entry points ([tests/e2e/README.md](../tests/e2e/README.md)). Mock LLM
calls; do not add live-model gates. The structural, golden and security exceptions are listed explicitly in
[testing-migration.md](testing-migration.md). Known-regression coverage is preserved: its old file may be removed only
after equivalent e2e assertions pass and fail against the old defect. An assertion that cannot reach a public consumer is
`redundant-unreachable` when an e2e case pins the consumer-visible outcome of that path, and the manifest must name that
case (`scripts/test-migration-check.ts` enforces it); otherwise the assertion stays and the worker reports it. Do not mock
internals to reach it. A missing new test alone is not a defect; an unmet supplied acceptance or an unproved deletion is
(`prompts/briefs/diff-review-rubric.md`, criterion 3).

The forge (GitHub/GitLab) and landing-proof work is covered by focused files.
They need no live forge, token or network. GitLab is a fake HTTP transport that
throws on an unexpected request, `gh` is an injected runner, and the git proof
runs on real scratch repositories (a bare remote plus a linked job worktree):

```bash
npm run test:one -- tests/forge-url.test.ts         # remotes, nested groups, custom hosts, safe PR/MR links
npm run test:one -- tests/forge-observers.test.ts   # fake gh and fake GitLab answers, failures, canary token
npm run test:one -- tests/landing-proof.test.ts     # merge, squash, rebase, deleted branch; negatives and budgets
npm run test:one -- tests/teardown.test.ts          # the ship gate with receipts and the git proof
npm run test:one -- tests/merges.test.ts            # GitHub and GitLab merge receipts
npm run test:one -- tests/integrate.test.ts         # a merged MR's tail; open/closed MRs run no gh
npm run test:one -- tests/viewer-jobs.test.ts       # GitLab links in the dashboard
```

awaiting_merge (parked `human_handoff` PRs) is covered with synthetic fleet, watch and GraphQL fixtures; no gh, git
or network runs:

```bash
npm run test:one -- tests/awaiting-merge-park.test.ts       # park/resume primitives, crash stages, refusals
npm run test:one -- tests/awaiting-merge-watch.test.ts      # batched watch, exits, stack follow-ups, the sweep port
npm run test:one -- tests/awaiting-merge-lifecycle.test.ts  # handoff parks, viewer keeps CI, change request, merge
npm run test:one -- tests/awaiting-merge-viewer.test.ts     # With the team, frozen time and cost, head CI
npm run test:one -- tests/human-handoff.test.ts             # the handoff port: park, fallback row, review first
```

CI evidence is GitHub Actions only (runs on the exact head plus each run attempt's jobs, `src/actions-ci.ts`). These
files need no token or network; the policy file's fake `gh` throws on any request outside the Actions allowlist:

```bash
npm run test:one -- tests/actions-ci.test.ts            # runs/jobs parsing, pagination, attempts, fail-closed reads
npm run test:one -- tests/actions-ci-policy.test.ts     # allowlist; no Checks/status/rollup read in any CI reader
npm run test:one -- tests/ci-access.test.ts             # Actions-only advice; /doctor workflows, runs and jobs probe
npm run test:one -- tests/ci-configured.test.ts         # only a positive empty workflow list is "no Actions CI"
npm run test:one -- tests/schedule-org-review.test.ts   # the org-review approval gate reads Actions, never rollup
```

Worker-prompt evals are a separate axis: `npm run eval` scores the assembled
prompt text against a checked-in corpus; the model-quality half runs only
under `CP_EVAL_LIVE=1` ([evals.md](evals.md)).

Live-model suites are operator-run only and skipped by default:
`CP_LIVE_TESTS=1 npm run e2e:live` (the release suite, token-budgeted) and
`CP_LIVE_TESTS=1 npm run smoke:live`. See
[tests/e2e/README.md](../tests/e2e/README.md) and
[tests/harness/README.md](../tests/harness/README.md).

## CI

`.github/workflows/ci.yml` runs `npm test` on GitHub-hosted `ubuntu-latest`.
The job has `timeout-minutes: 45`, and a newer push to the same PR cancels the
older run.

While the repository is private, `runs-on` picks the operator's self-hosted
runner instead (`[self-hosted, nomad]`: one ephemeral, privileged
Docker-in-Docker runner per job). The choice keys on
`github.event.repository.private`, so a public repository, and therefore any
fork PR, never reaches a privileged self-hosted runner.

The m2, m3 and `tests/pipeline.test.ts` lease suites (and the other
lease-backed tests) need a real `treehouse` on `PATH`; without it they
self-skip and `node --test` still exits 0. So before `npm test` the job prepends
`$HOME/.local/bin` via `GITHUB_PATH`, installs treehouse with
`node scripts/install-tools.ts treehouse` (ordinary privileges, no sudo) and
prints `treehouse --version` into the log; the installer tracks upstream
latest, so that line is the version record. The sentinel
`tests/ci-host-tools.test.ts` fails the run when `GITHUB_ACTIONS=true` and
treehouse is not on `PATH`. Off CI a missing treehouse still only skips. The
live suites stay skipped (`CP_LIVE_TESTS` is empty). After the suite, a separate
step runs `npm run eval:check` (offline, 5-minute timeout, no `CP_EVAL_LIVE`) and
fails when `evals/results/contract.json` is stale.

## Several homes on one machine

Only needed when you run more than one home; both default to normal behaviour
when unset.

| Env var | Default | Why |
|---|---|---|
| `CP_LEDGER_PREFIX` | `cp` | a job id is its git branch; two homes minting `cp-` ids for the same remote can collide |
| `CP_TREEHOUSE_ROOT` | `~/.treehouse` | two homes cloning one remote share one worktree pool unless the roots differ |

One parent runs per home at a time (`state/parent.lock`); a second one is
refused, and a lock left by a dead parent is reclaimed after its pid is probed.

Dispatch refreshes a leased worktree's dependencies before the worker starts: when `package-lock.json` exists and `node_modules` is missing or its `.package-lock.json` differs, it runs `npm ci` there (`src/worktree-deps.ts`), logs one `cp:deps_prepared` event, and on a failed install still starts the worker with a note in its brief.

## Repository layout

| Path | Role |
|---|---|
| `AGENTS.md` | the parent's operating contract |
| `docs/contracts.md` | binding contracts and why (code wins on disagreement) |
| `src/` | policy modules; `src/command-post.ts` is the composition root |
| `src/service/`, `bin/cp-install`, `bin/cp-bootstrap`, `scripts/install.sh` | the installer and the always-on services ([service.md](service.md)) |
| `src/viewer/`, `viewer-app/`, `bin/cp-view` | the dashboard ([viewer-app.md](viewer-app.md)) |
| `extensions/command-post/` | the parent extension |
| `extensions/cp-bridge/`, `bin/cp-operator` | the operator session and its `cp_parent` tool |
| `extensions/worker-reporter/` | loaded into every worker: `report_result` / `report_verdict` |
| `profiles/` | worker roles: planner, implementer, gate-reviewer, qa |
| `prompts/briefs/` | brief templates |
| `skills/cp-memory/` | memory curation skill |
| `skills/cp-self-review/` | self-review recipe (parent-expanded manual schedule) |
| `skills/cp-pr-review/` | read-only PR-review recipe (parent-expanded manual schedule) |
| `defaults/` | `routing.default.json`, copied once into a new home |
| `evals/` | the eval corpus and committed results |
| `tests/` | unit and end-to-end suites against a mock provider |

There is no separate fleet CLI: `bin/` holds only the installer, the operator
launcher and the dashboard. `.pi-command-post/` is never committed; a guard
enforces it.
