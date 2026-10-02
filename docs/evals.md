# Worker-prompt evals (do8.7)

The do8 epic rewrote every worker prompt. This is what makes the next rewrite
**measured** instead of hoped-for: a checked-in corpus of cases drawn from real
failures and representative happy paths, a runner that scores one **arm** (a
prompt directory pair) against it, and a stable machine-readable result that
names the prompt, model and package versions it was produced from.

Binding code: [`src/evals.ts`](../src/evals.ts) (policy, pure),
[`scripts/eval.ts`](../scripts/eval.ts) (the edge: argv, fs, exit code),
[`evals/corpus.json`](../evals/corpus.json) (the corpus),
[`tests/evals.test.ts`](../tests/evals.test.ts) (everything above, tested for
free). The parent's own classification corpus is
[`evals/parent-routing.json`](../evals/parent-routing.json) with
[`tests/parent-routing-evals.test.ts`](../tests/parent-routing-evals.test.ts) —
see §Parent classification cases. Where this document and the code disagree,
the code wins.

## Two kinds of case, deliberately separate

| Kind | Scored against | Costs | Runs in CI |
|---|---|---|---|
| `contract` | the **assembled prompt text** ("the ship brief rebases onto the resolved base") | nothing | yes, on every `npm test` |
| `quality` | what a **model does** with that prompt, over N trials | a real model run | no |

Keeping them apart is the point. A contract case is a deterministic assertion
about a file this repository ships, so it belongs in the suite and fails a bad
prompt edit immediately. A quality case is a measurement of a stochastic system,
so it needs trials, human labels and an operator who agreed to pay for it.

**With no transport, quality cases are recorded as `skipped`, with the reason.**
They are never quietly dropped: `evals/results/contract.json` lists every one of
them, which is how the result file stays honest about what has not been measured.

## Commands

```bash
npm run eval             # contract arm over the whole corpus, result to stdout
npm run eval:contract    # …and write evals/results/contract.json (commit it)
npm run eval:check       # fail if that checked-in result is stale
```

Everything the runner takes:

```
node scripts/eval.ts [--arm <name>] [--profiles <dir>] [--briefs <dir>]
                     [--model <id>] [--corpus <file>] [--role planner|reviewer|implementer]
                     [--kind contract|quality] [--trials <n>]
                     [--replay <dir>] [--live] [--out <file>] [--check]
```

Exit code 0 = every scored case passed, 1 = a case failed (or `--check` found
drift), 2 = bad arguments or a refused live run.

### Shadowing old prompts against new

An arm is just a prompt directory pair, so the baseline is a worktree of the old
ref and no code changes:

```bash
git worktree add /tmp/do8-base origin/main
node scripts/eval.ts --arm baseline  --profiles /tmp/do8-base/profiles \
                     --briefs /tmp/do8-base/prompts/briefs --out /tmp/baseline.json
node scripts/eval.ts --arm candidate --out /tmp/candidate.json
```

Both results carry `versions.prompts` (a sha256 per prompt file), `versions.model`
and `versions.package_version`, so a comparison can always say what it compared.

### Model trials (paid, operator-authorized)

```bash
CP_EVAL_LIVE=1 node scripts/eval.ts --live --trials 5 --role reviewer --out /tmp/reviewer-live.json
```

Without `CP_EVAL_LIVE=1` the live transport refuses — the same gate shape the
live test suite uses (`CP_LIVE_TESTS`). `CP_EVAL_PI_BIN` overrides the `pi`
binary, which is how the free suite exercises the transport's plumbing against a
stand-in instead of a model.

The transport runs `pi --mode json`, not `pi -p`: the event stream is what
carries **usage and tool calls**, so `median_tokens` and `median_tool_calls`
below are measured rather than left null.

| Environment variable | Effect |
|---|---|
| `CP_EVAL_LIVE=1` | opens the money gate; nothing calls a model without it |
| `CP_EVAL_PI_BIN` | the binary to run (default `pi`) |
| `CP_EVAL_TIMEOUT_MS` | per-case wall-clock bound, default 600000 (10 min) |

Every live case is bounded by Node's own `execFileSync` timeout — there is no
GNU `timeout` on macOS and a worker cannot bound a hang after the fact. A case
that exceeds the budget is killed and the run stops with an actionable error
(which case, which budget, and the three ways out: raise `CP_EVAL_TIMEOUT_MS`,
lower `--trials`, or score a recording with `--replay`). Nothing is scored for a
case that timed out: a partial transcript is not a measurement.

Recorded transcripts are re-scored for free, which is how a paid run keeps
paying off:

```bash
node scripts/eval.ts --replay evals/recordings --trials 3 --out /tmp/replayed.json
```

Recordings live at `<dir>/<arm>/<case-id>.<trial>.txt` (or `<case-id>.txt`).
Save the raw `pi --mode json` stream and the recording carries its tokens and
tool calls with it; a plain-text transcript scores identically, minus those two
metrics (they stay **absent**, never `0`).

## The corpus

`evals/corpus.json` is one JSON document, 20–50 cases (both bounds enforced at
load). Every case carries the failure or happy path it pins in `why` — a case
nobody can trace back to a real defect is a case nobody will maintain.

| Field | Meaning |
|---|---|
| `role` | `planner` \| `reviewer` \| `implementer` — the rollout unit |
| `scenario` | one of the required scenarios below; unknown values do not load |
| `kind` | `contract` \| `quality` |
| `surface` | which prompt text the case is scored against (profile or brief) |
| `subject` | what the worker acts on (quality cases): a plan, a diff, a situation |
| `expect.verdict` / `expect.flags` | the reviewer's terminal report |
| `expect.includes` / `expect.excludes` | literal substrings |
| `expect.coverage` | case-insensitive **regexes** the output must match (task-coverage metric); every one is compiled at load, so a malformed pattern is a load error rather than a crash after a paid call |
| `expect.evidence` | the output must cite a `path:line` (grounded-evidence metric) |
| `expect.labels` | **human-labeled** defects: id, severity `P0`/`P1`/`P2`, where, and the regex that recognises a finding about it |

Required scenarios (`REQUIRED_SCENARIOS` in `src/evals.ts`; a corpus missing one
does not load):

- **planner** — omitted-requirement, stale-path, invented-test-command,
  excessive-scope, genuine-unknown, complete-executable-plan
- **reviewer** — pass-with-flag, missing-section, unscorable-input, seeded-p0,
  seeded-p1, seeded-p2, clean-diff, style-only, false-positive-trap
- **implementer** — task-file-handoff, bug-regression, docs-only, non-main-base,
  review-revision, blocked-evidence, clean-pushed-delivery, exactly-once-report

An empty `labels: []` is meaningful ground truth: the clean, style-only and
false-positive-trap cases say *there is nothing to find*, so every finding
counts against precision.

## Metrics

| Metric | How it is computed |
|---|---|
| `contract_compliance` | share of contract checks passed |
| `terminal_report` | share of quality outputs that ended in the report the output contract asks for |
| `task_coverage` | share of `expect.coverage` patterns matched |
| `grounded_evidence` | share of cases citing a `path:line` where one was required |
| `plan_first_pass` | planner quality cases that passed every check on trial 1 |
| `implementation_verification` | implementer quality cases that passed every check |
| `reviewer_precision` / `reviewer_recall` | findings matched to human labels; a matched finding is consumed, so two findings about one defect are one TP and one FP |
| `reviewer_severity_accuracy` | matched findings whose severity word matches the label (`P0`→high, `P1`→medium, `P2`→low) |
| `median_tokens` / `median_tool_calls` | median over the runs that reported them: assistant-message `usage` and `tool_execution_start` events from the `pi --mode json` stream |

A metric with nothing to measure is `null`, never `0`: an unmeasured arm must
not read as a failing one.

**Known limitation.** Quality cases score a single headless turn (`pi -p`), so
an implementer case measures the *stated* procedure, not a whole worktree
delivery. End-to-end behaviour is still the live e2e suite's job
(`CP_LIVE_TESTS=1 npm run e2e:live`), and the eval harness states its one
deviation from production inside the prompt itself (`EVAL_OUTPUT_CONTRACT`):
`report_verdict` / `report_result` are not available to `pi -p`, so a case asks
for the same payload as one JSON object.

## Rollout: one role at a time

Regressions are attributable only if one thing changed. Roll out **planner,
then reviewer, then implementer** — never two in one merge — and for each:

1. `npm run eval:contract` is green and its result file is committed (CI enforces
   this: a prompt edit with a stale result fails `tests/evals.test.ts`).
2. Shadow the candidate against the baseline arm: `--role <role> --trials 5`,
   same model, same corpus, both `versions` blocks recorded.
3. Compare against the thresholds below.
4. Merge that role's prompts alone, then watch the next real jobs of that role
   before starting the next role.

### Thresholds

Ship a role's prompt change when, on ≥5 trials of that role's cases:

| Metric | Gate |
|---|---|
| `contract_compliance` | **1.0** — no exceptions; a contract case is a promise this repository already makes |
| `terminal_report` | ≥ 0.98, and never below baseline |
| `task_coverage` | ≥ baseline, and ≥ 0.90 absolute |
| `grounded_evidence` | ≥ baseline (planner) |
| `plan_first_pass` | ≥ baseline (planner) |
| `reviewer_recall` | ≥ baseline, and ≥ 0.80 on seeded P0/P1 defects |
| `reviewer_precision` | ≥ baseline, and ≥ 0.70 (false-positive traps included) |
| `reviewer_severity_accuracy` | ≥ 0.70 |
| `implementation_verification` | ≥ baseline |
| `median_tokens` | ≤ 1.25 × baseline unless a quality metric improved materially |

Any metric below baseline is a **stop**, not a trade — write down which case
regressed and why before continuing. A tie goes to the shorter prompt.

### Where this stands today

The contract arm is green and committed
([`evals/results/contract.json`](../evals/results/contract.json)): 27 contract
cases over the planner, reviewer and implementer surfaces, `contract_compliance`
1.0, versions recorded.

**The paid half has not been run.** Model trials cost money and were not
authorized for the change that built this suite, so the 23 quality cases are
recorded as `skipped` with their reason, and the baseline/candidate comparison
above is a procedure with no numbers in it yet. Nothing here manufactures a
result it did not measure: run the shadow above under `CP_EVAL_LIVE=1`, commit
the two result files, and the rollout decision becomes a reading of the table
rather than a judgement call.

## Parent classification cases (routing T6)

The corpus above scores **worker** prompts. `evals/parent-routing.json` scores
the **parent's** own category choices, in the same file conventions and behind
the same money gate: one hand-labeled case per required scenario
(`PARENT_ROUTING_SCENARIOS` in [`src/evals.ts`](../src/evals.ts)), 15 of them
today, bounded at 25.

Every case carries two layers, and confusing them is the failure this section
exists to prevent:

| Field | What it is | Who can be wrong about it |
|---|---|---|
| `labels` | human ground truth: the accepted `workflow`, `scope` and `risk` **sets**, plus `why` | a human, on review |
| `deterministic` | what `classifyIntake` and `resolveRoutingInputs` answer today, with per-axis `provenance` | this repository's code |
| `divergence` | required when `deterministic` falls outside `labels` | — |

A set per axis, not one value, because several of these cases are legitimately
ambiguous — rotating production credentials is defensible as one job *or* as a
pipeline — and forcing one arbitrary answer would score a correct choice as
wrong. `given` records what the operator had already settled (`kind`, `scope`,
`risk`, `model`), which is how the corpus exercises "an explicit axis overrides
only its own axis".

[`tests/parent-routing-evals.test.ts`](../tests/parent-routing-evals.test.ts)
runs for free in CI and proves **tool, schema and routing wiring only**: the
corpus loads, every scenario is labeled, and the deterministic layer still
answers what the corpus recorded. Regexes are not a measurement of a model, and
nothing here claims otherwise — where the keyword advisor disagrees with a human
label (a short-but-deep bug reading as `S`, a mechanical cross-cutting rename
reading as a pipeline), the case records the disagreement rather than widening
the label to hide it. That is also why `cp_pipeline classify` is advisory.

### The parent-model trial (paid, operator-authorized, not yet run)

`live_trials.status` in the corpus is `pending_operator_approval`: measuring
what a parent model actually passes to `cp_dispatch`/`cp_pipeline` needs real
model calls, and they were not authorized for the change that built this
corpus. **No parent-model quality claim exists**, and the validator refuses a
`measured` status that does not name the result file behind it.

When an operator approves it, the protocol is the one this suite already uses
(`CP_EVAL_LIVE=1`, `armVersions()` for prompt/model/package identifiers,
`parseTranscript()` for usage and tool calls) applied to the parent surface:

1. An **isolated harness**: a scratch home, the command-post extension loaded,
   dispatch and leases stubbed. Synthetic tasks only — no real repository, no
   real worker, no credentials, and no private artifacts in the results.
2. **Baseline and candidate arms** over the same corpus, same model, three
   trials per case, with both `versions` blocks recorded.
3. Score the **tool arguments** each trial produced against `labels`: workflow
   and the two axes separately, an answer inside the accepted set is correct,
   and a missing `reasons` is its own finding.
4. Report, per arm: under-routing (a labeled `high` answered `low`, or `L`/`M`
   answered `S`), unnecessary expensive routing and unnecessary pipelines,
   omitted reasons, unsupported model overrides, and latency, tokens and cost.
5. **High-impact under-routing is a release blocker** in an approved trial.
   Write the result file, set `live_trials.status` to `measured` and name it.
