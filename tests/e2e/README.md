# Milestone E2E gates

Automated, deterministic, free. They run against the scriptable mock provider
(`tests/harness/mock-provider.ts`) and a scratch git repo — no tokens, no
network, no operator credentials (`PI_CODING_AGENT_DIR` is a temp dir).

| Gate | Command | Covers |
|---|---|---|
| m1 | `npm run e2e:phase1` | worker lifecycle: profile + brief → spawn under the trust policy → events teed → `status.json` phase transitions → validated envelope → graceful shutdown with an observed close |
| m2 | `npm run e2e:phase2` | dispatch: ledger intake → routing/lease/branch/preflight → scripted worker edits+commits+pushes → envelope (held vs teardown-ready) → promote round trip → teardown gates (pass and fail-closed) → crash with bounded re-dispatch → budget breach escalation |
| m3 | `npm run e2e:phase3` | pipeline: research → artifact → envelope → every gate verdict/cause branch (pass, revise + promote, capped second revise, flag-forced escalate, unparseable → operational → operational_persistent on a different model) → journaled checkpoint → implementer dispatched with the artifact as its task file → parent context-safety guards asserted |

`npm test` runs every gate plus the unit suites: its glob is
`tests/**/*.test.ts`, so every file above (including `tests/e2e/attach.test.ts`)
is picked up by that one invocation and the per-gate scripts exist only to run
one of them alone. It also *collects* the live suites and skips them (they print
their skip reason), so `npm test` stays free.

## The live suite (T29) — operator-run

`tests/e2e/live.test.ts` is the release suite: five scenarios against a **real
model** on a scratch project. It is skipped unless `CP_LIVE_TESTS=1` and is
**never** a CI gate. The mock milestones above are the gates; this proves the
things a mock cannot — that a real model, given our real briefs, produces
envelopes our validator accepts and trees our teardown gates pass.

### Before you run it

```bash
pi auth                 # provider auth must already work
treehouse --version     # worktree leases; there is no fallback
npm test                # start green: the free suite must pass first
```

The suite creates its own scratch home, scratch git repo with a bare remote,
scratch ledger and scratch treehouse pool per scenario, and removes them
afterwards. It never touches your home, your `~/.treehouse`, your ledger, or
any real repository.

### Running it

```bash
# everything (measured: ~3 minutes, 9 jobs, ~270k tokens, ~$0.20 on haiku-4-5)
CP_LIVE_TESTS=1 npm run e2e:live

# one scenario at a time — recommended the first time
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(a\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(b\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(c\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(d\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(e\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(f\)" tests/e2e/live.test.ts
CP_LIVE_TESTS=1 node --test --test-name-pattern "live \(g\)" tests/e2e/live.test.ts

# a different model, or tighter money
CP_LIVE_TESTS=1 CP_LIVE_MODEL=anthropic/claude-sonnet-5 npm run e2e:live
CP_LIVE_TESTS=1 CP_LIVE_TOKEN_BUDGET=100000 CP_LIVE_TOTAL_BUDGET=300000 npm run e2e:live
```

| variable | default | meaning |
|---|---|---|
| `CP_LIVE_TESTS` | unset | `1` opens the gate. Nothing live runs without it |
| `CP_LIVE_MODEL` | `anthropic/claude-haiku-4-5` | the model every worker and reviewer uses |
| `CP_LIVE_TOKEN_BUDGET` | `140000` | **per job**; a job over it fails the scenario |
| `CP_LIVE_TOTAL_BUDGET` | `600000` | whole suite; checked as each job reports in |

Every job's spend is printed as it completes, and the run ends with a table:

```
[live a/ship] cp-live-a-… turns=6 tools=6 tokens=32632 cost=$0.0165 (job budget 140000, suite 32632/600000)
[live] 9 job(s), 271629 tokens, $0.1987 total (model anthropic/claude-haiku-4-5)
```

**The budget catches a runaway; it does not second-guess the work.** Measured on
haiku-4-5 (cumulative per job): a one-file ship job 26-31k, an implementer
working from an artifact 39-66k, a promoted `delivery:pr` fix 52-76k, a research
job 43-78k for its first report and **~94k when it takes the revise round
trip** — the most expensive legitimate job in the suite. The first defaults (60k,
then 90k) sat *inside* that spread, so the suite failed on model variance rather
than on a runaway. A gate attempt is charged to the **reviewer's own** run dir
(`state/runs/<id>/gate-<n>/status.json`), not to the research job whose job id it
shares — otherwise the planner is billed twice and the reviewer never.

### The seven scenarios

| # | what it proves | needs |
|---|---|---|
| **(a)** single ship job | intake → dispatch (routing, lease, branch, preflight) → a real envelope our validator accepts → teardown's **real** gates (clean + committed) → job close | treehouse |
| **(b)** pipeline | research → artifact → a real gate verdict with its `cause` → (a `revise` is promoted and re-gated once) → journaled checkpoint → implementer dispatched with the artifact **as a file** → its envelope → teardown | treehouse, 3 leases |
| **(c)** `delivery:pr` hold | push + PR envelope → `held` (worker and lease deliberately alive) → **promote** a CI fix to the same worker (the promote reopens the envelope slot; this scenario asks for a reply, not a second report) → pushed again → teardown | treehouse |
| **(d)** parent `kill -9` | a real parent process (a driver script) dispatches a real worker, is killed with no cleanup, and a fresh parent reconciles: the worker is reported as an **orphan**, never re-phased or killed at startup; the run log survives and still renders | treehouse |
| **(e)** worker crash | `SIGKILL` a working worker → the close is **observed** → classified `crash` → the ladder says `retry_same` (**same brief**) → a bare re-dispatch is refused `branch_exists` → lease back, leftover branch removed, second worker completes; the cap escalates instead of looping | treehouse |
| **(f)** planner asks the operator (T31) | a real model reaches for `ask_operator` → the dialog reaches a (scripted) human → the answer lands in the **worker's** context and its plan quotes it → `/status` says `? asked you` while it waits → both halves journaled, both events in the run log → teardown | treehouse |
| **(g)** planner's question **held** at a console (attach, phase 7) | the same ask in `hold` mode: **no dialog** (the `Asker` is wired and never called), one held notice, `/status` says `? asked you (q1, held …)`, then attach (`TestConsole` — the real reducer over the real ports, no terminal) → answer → detach (`opened → answer → closed`, reason `detached`); the plan quotes the choice and the interruption cap is not charged | treehouse |

**A non-pass gate verdict in (b) is a legitimate outcome.** The scenarios assert
the machinery around the model's answer — that a cause is set, that only a pass
reaches a human, that nothing is authorized otherwise — never the answer itself.

**The PR url in (c) is supplied by the test**, not invented by a model: there is
no GitHub behind a scratch bare remote, and `delivery:pr` requires an https url.
The hold/promote/teardown machinery around it is the real subject. To exercise a
true PR, point a scenario at a real remote you own and open the PR yourself.

### If something fails

1. **Read the spend line first.** Over budget means the model wandered; rerun
   the single scenario with a higher `CP_LIVE_TOKEN_BUDGET` or a better model
   before assuming a bug.
2. `state/` in the scratch home is deleted with the fixture, so re-run with the
   scenario's `t.after` disabled (or copy the printed home path early) when you
   need the run log. Everything the parent observed is in
   `state/runs/<job-id>/events.jsonl`; render it with `/watch <job-id>` in a
   session pointed at that home, or read the file directly.
3. A live failure is **information, not a red build** (same rule as the smokes):
   rerun it, then decide. Provider hiccups, rate limits and a model having a bad
   day are all normal and none of them mean the plumbing broke.
4. Leaked worktrees: the fixture points the pool at a temp dir and removes it, so
   `treehouse status` should be unchanged. If a run was killed mid-scenario,
   remove the printed pool root by hand.

### What the first real run taught us (T29 amendments)

The suite was written before it could be run, and six assertions were wrong
about the system rather than about the model. All six are now pinned by **free**
tests as well, so they cannot come back:

| the suite believed | the system actually | pinned in |
|---|---|---|
| a returned lease deletes its worktree | `treehouse return` **recycles** it: cleaned, reset, `status: available` | `tests/leases.test.ts` |
| `advance()` answers `revise` / `retry` | those are **cp_gate's** words; advance says `wait`/`authorize`/`surface`/`done` | `tests/pipeline.test.ts` |
| the pipeline reaches `done` by itself | only the next `advance()` writes it — and without that guard a second advance dispatched a **second implementer** | `tests/pipeline.test.ts` |
| the ladder returns `redispatch` | it returns `retry_same`, and the re-dispatch is refused until the leftover branch is removed | `tests/e2e/phase2.test.ts` (m2) |
| `process.kill(pid, 0) === undefined` proves liveness | it returns **true**; the probe is `isPidAlive` (one of the two checks was literally `\|\| true`) | `src/fleet.ts` |
| a gate's spend is the job's `status.json` | the reviewer has its own run dir; reading the job's charged the planner twice | `tests/live-harness.test.ts` |

Two were product bugs, not test bugs: the unreachable `done` state (with its
second-implementer hole) and a revise message that told the planner to call
`report_result` again — which the write-once envelope refused, and which cost a
paid revise round trip that changed no artifact. (cp-held-cannot-report closed
the other half of that seam: a promote now reopens the envelope slot, so a
re-report is accepted rather than lost.)

One trap worth remembering when writing a live assertion: **a worker is idle the
moment it reports**, so "wait for idle" after a promote is a wait that is already
over. Wait for the fact you actually need — for a revise, the artifact's mtime.

The suite's own scaffolding (fixture, budget ledger, PR-url helper, skip gate) is
tested **for free** in `tests/live-harness.test.ts`, so a broken fixture is found
in CI rather than after you have paid for a run.

## Live smokes (operator-run)

`tests/e2e/live-smoke.test.ts` repeats the milestone round trip against a real
model. It is **skipped unless `CP_LIVE_TESTS=1`** and is never a CI gate:

```bash
CP_LIVE_TESTS=1 npm run smoke:live
CP_LIVE_TESTS=1 CP_LIVE_MODEL=anthropic/claude-haiku-4-5 npm run smoke:live
CP_LIVE_TESTS=1 CP_LIVE_TOKEN_BUDGET=40000 npm run smoke:live
```

- `CP_LIVE_MODEL` — cheap model to use (default `anthropic/claude-haiku-4-5`).
- `CP_LIVE_TOKEN_BUDGET` — hard ceiling (default 60k); breaching it fails the
  test instead of the wallet.
- The smoke uses the operator's real pi config, so provider auth must already
  work (`pi auth`). It prints the turns/tools/tokens/cost it used.

Three smokes exist today: **m1** (worker round trip), **m2** (one full
`delivery:local` job: intake → dispatch → envelope → teardown) and **m3** (a
pipeline: research → a real gate verdict with its cause → checkpoint →
implementer dispatch). The m2 and m3 smokes additionally need
`treehouse` installed, and they clone only a scratch fixture repo — never a real
project. The m3 smoke answers its own checkpoint and records
`decided_by: "live smoke (unattended)"`, because "who authorized this?" is
exactly the question the journal exists to answer.

A live smoke failing is information, not a red build: rerun it, then decide.

## House rules for suites that lease

Anything that takes a treehouse lease must call `enableTreehouse(clone)` from
the harness first. It points the pool at a temp dir **and** hides
`treehouse.toml` via `.git/info/exclude`, so the clone stays clean for preflight
and teardown. Do not "clean up" the config with `git stash`: a stashed config
silently sends the pool back to `~/.treehouse` and leaks worktrees into the
operator's home.
