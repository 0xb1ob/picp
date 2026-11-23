# Multi-vendor routing: the shipped matrix and how to activate it

Tracker: `pi-command-post-0a9`. This document is the *policy* half of the change
whose *mechanism* is contracted in [`docs/contracts.md`](contracts.md)
§Routing config: which models the shipped template and profiles name, the
evidence behind each of them, what the one-provider guarantee is worth, and the
operator runbook for adopting the new template on a machine that already has a
`data/routing.json`.

Nothing here is run by any code path. Activation is an operator step, with an
exact backup and a validation before first use, and its rollback is restoring
one file.

## The guarantee

**Anthropic or OpenAI authenticated in pi is enough.** (xAI was the third rung
until the 2026-09-23 model refresh removed `grok-4.6`; an xAI-only machine no
longer resolves the shipped routes.)
Every shipped profile (planner, implementer, qa, gate-reviewer) and every
(role, scope, risk) route of the shipped template resolves and launches under
any single one of them, at an effort that model actually serves.

Anthropic stays first when scores tie or are unknown. On a fresh dispatch an
eligible OpenAI candidate with more free slots (or fewer waiting local workers
when the gateway fails) can win instead. `attempted` still describes refusals,
not candidates passed over by the capacity comparison.

## The matrix

`data/routing.default.json` (the template `scaffoldHome` copies **once** into
`data/routing.json`):

| row | selector | preferred | then | effort |
|---|---|---|---|---|
| `risky-any` | planner, risk high | see defaults/routing.default.json | see defaults/routing.default.json | xhigh |
| `risky-ship` | implementer, risk high | see defaults/routing.default.json | see defaults/routing.default.json | high |
| `reviews` | gate-reviewer | see defaults/routing.default.json | see defaults/routing.default.json | high |
| `research-big` | planner, scope L | see defaults/routing.default.json | see defaults/routing.default.json | high |
| `big-ship` | implementer, scope M/L | see defaults/routing.default.json | see defaults/routing.default.json | medium |
| `small-ship` | implementer, scope S | see defaults/routing.default.json | see defaults/routing.default.json | high |

Profiles (`profiles/*.md`) name no model since R1 PR4; a profile's `thinking` is the
effort only where the row names none. Ordinary planning and QA resolve from the template's
last row, `planner-default`; a home whose rubric left a role uncovered gets that role's row
from `defaults/routing.role-defaults.json` once (contracts.md §Routing config). Models: see that file.

| row | role | effort |
|---|---|---|
| `planner-default` | planner | the profile's: `planner` medium, `qa` low, `ops` medium |
| `implementer-default` | implementer (migration only) | `implementer` medium |
| `gate-reviewer-default` | gate-reviewer (migration only) | `gate-reviewer` high |

## The evidence

The 2026-09-26 operator decision replaced Luna with Sol in every remaining
fallback slot, retaining each row's and profile's effort. The registry evidence
and rationale below record the earlier 2026-09-23 refresh.

A later values-only change (cp-zk0b) moved `small-ship` to `anthropic/claude-sonnet-5-5` at effort `high`, with
`anthropic/claude-opus-5-5` ahead of `openai/gpt-6.1-sol` in its fallbacks; the registry table below predates it.

Read from pi's own registry (`MODELS` in
`@earendil-works/pi-ai/dist/models.generated.js`, pi-ai 0.87.1 — the dev
dependency was raised from 0.85.x to match the installed pi, whose registry is the
first to carry these ids; cross-checked with `pi --list-models`). No
inference was run and no credential was read to produce it. `thinkingLevelMap`
maps pi's levels to provider values; an absent key is supported, `null` is not
(`supportedThinkingFor`, `src/routing.ts`).

| model | reasoning | $/MTok in→out | serves low / medium / high / xhigh |
|---|---|---|---|
| `anthropic/claude-opus-5-5` | yes | 4 → 20 | ✓ ✓ ✓ ✓ |
| `anthropic/claude-sonnet-5` | yes | 2 → 10 | ✓ ✓ ✓ ✓ |
| `openai/gpt-6.1-sol` | yes | 2 → 10 | ✓ ✓ ✓ ✓ |
| `openai/gpt-6-luna` | yes | 0.1 → 0.5 | ✓ ✓ ✓ ✓ |

Those four levels are the only ones the matrix uses. `off` and `minimal` differ
between models, which is why no row names them.

Why these candidates (operator refresh, 2026-09-23):

- **Anthropic: Opus 5.5 is the default tier.** It replaces Opus 5 in every
  Opus slot and Sonnet 5 in the implementer/planner/QA profiles and `big-ship`;
  Sonnet 5 moves down to `small-ship`, replacing Haiku 4.5.
- **OpenAI: `gpt-6.1-sol` backs the Opus-5.5 review/high-risk slots,
  `gpt-6-luna` the rest.** Note `gpt-6-luna` is priced far below Opus 5.5
  (0.1 → 0.5 vs 4 → 20), so an OpenAI-only day runs ordinary implementation and
  planning on a much cheaper tier than the Anthropic preference; changing a slot
  is a one-line edit.
- **xAI is gone.** `grok-4.6` was removed from every ladder; the guarantee is now
  one of Anthropic or OpenAI.
- **Order is anthropic → openai for equal or unknown capacity.** Scored new
  spawns can select OpenAI first without changing the configured candidate set.

A live API-side check of the OpenAI ids needs credentials and paid
inference, so it is deliberately not part of the PR: `/doctor` on the operator's
own machine (step 4 below) is where that is proven, against the registry and the
auth pi actually has.

## Activating it on a machine that already has `data/routing.json`

`data/routing.json` is machine-local and gitignored: merging the PR changes the
*template*, never a live home. Copy-once means an existing file is never
touched. Adopting the new matrix is therefore an explicit operator step.

1. **Preconditions.** The PR is merged and this home is running that build. You
   do **not** need to drain live workers: routing is resolved once per dispatch
   (`loadRoutingConfig` runs per dispatch) and a running worker keeps the model
   it was launched with. Do not restart the parent while workers are live
   (cur-20260901-4) — that is a separate hazard, not a routing one.

2. **Back the file up, exactly, and verify the copy.**

   ```
   cp -p data/routing.json data/routing.json.bak-$(date +%Y%m%d-%H%M%S)
   cmp data/routing.json data/routing.json.bak-<stamp>   # must be silent
   ```

3. **Replace it.** Either delete `data/routing.json` and start a session (or run
   `cmdp scaffold`) so copy-once installs the new template verbatim, or write the
   template's content in by hand. Then re-narrow `allow` if you want it narrowed
   — the backup still holds the previous allowlist to consult. Note that
   narrowing `allow` now *skips* disallowed candidates rather than failing the
   route, so an `allow` that covers only the providers you authenticate is a
   supported way to express the policy.

4. **Validate before the first dispatch.**
   - `/doctor` — `config.routing*` and `models.*` green. This is the live
     registry-and-auth read: it proves, on this machine, which providers are
     actually authenticated and that every rubric route resolves. A route
     carried by a fallback reads `ok` with `fallback from <preferred>`; a route
     with no usable candidate is an `error` naming each candidate and its reason.
   - `cp_dispatch` with `dry_run: true` over a representative grid: a planner
     and an implementer job at S/low, M/low, L/low, S/high, M/high, L/high, plus
     one `delivery:answer` QA job, in at least one registered project. Expected:
     every preview resolves, `line` names the model you expect, no `error`.

5. **Optional, and separately authorized.** One cheap live smoke per
   authenticated provider. This is the only step that spends money; it is not
   part of the PR and not part of this runbook's required path.

6. **Rollback.** `cp -p data/routing.json.bak-<stamp> data/routing.json`. One
   file; nothing else in this change is stateful, and running workers were never
   re-routed.

## Advisory capacity (admin-only)

An optional gitignored `data/capacity.json` can name an HTTPS gateway and GET
admin path; set `CP_GATEWAY_ADMIN_KEY` in the parent environment, never in that
file (`cp-install --gateway-url <origin> --gateway-key-file <file>` does both,
docs/service.md §7b). See [the capacity contract](contracts.md#advisory-gateway-capacity) for
the response shapes and subscription-window thresholds. Without an admin key,
eligible candidates keep rubric order and no gateway calls are made. When a
key is set but concurrency is unreadable, provider estimates come from waiting
workers; unknown fleet means no score. Quota snapshots last 60 seconds and
non-tight providers rank first; `/status` shows the latest figures. Gateway totals
include other accounts and groups and do not reserve slots or block spawns.
An eligible Anthropic at 0 free slots can lose to OpenAI at 8; zero is not a
refusal. A 503 during a running worker's turn stays on the existing bounded
same-session retry/recovery: switching that worker mid-session could corrupt
its conversation or thinking state. The next spawn re-scores independently.

## What this change does not do

- It does not migrate anyone's `data/routing.json`, automatically or otherwise.
- It does not touch credentials or re-route running or held workers. A
  missing admin key uses static order; a configured but unreadable gateway
  uses waiting-worker fleet estimates, or static order if the fleet is unavailable.
- It does not reintroduce the gate's "retry on a different model" rung:
  fallback is resolved once before the spawn. A retry stays bounded; a new
  attempt re-scores before its spawn.
- It does not let a fallback change the effort, cross from a rubric row to a
  row, or rescue an explicit override.

## Claude CLI research soak (opt-in)

This section documents the soak; nothing here performs it, and no shipped row or default changes. Defaults stay pi and
the switch stays OFF. The mechanism is in [`docs/native-drivers.md`](native-drivers.md) (S1 to S3).

1. **A claude row of its own.** A `driver: "claude"` row must name an explicit `anthropic/claude-…` model; any other
   model refuses the dispatch with no lease. The shipped research rows name pi models, so adding `driver` to one of
   them is a configuration error. Add a separate planner row above the research row it should shadow, keep pi models
   as its `fallbacks`, and add the claude model to `allow`:

   ```json
   { "id": "native-research", "role": "planner", "scope": ["S"], "model": "anthropic/claude-<model>",
     "fallbacks": ["<the pi research model>"], "thinking": "high", "driver": "claude" }
   ```

   Back up `data/routing.json` first (`cp -p data/routing.json data/routing.json.bak-<stamp>`), then check it with
   `/doctor`: `models.planner` reports `driver=claude <model>, never pi; pi lane (unused) …`.
2. **The switch.** Dashboard Settings → Native workers, or `data/native.json` `{"claude_research": true}`. Only local
   and answer research runs native, `max_concurrent` jobs at a time (default 1); pipeline research, reviews, gates and ship jobs stay pi. Ship
   implementers have their own switch, `claude_ship` (off by default; [native-drivers.md](native-drivers.md#native-ship-jobs-n4f)).
3. **What to watch.**
   - Job detail's Driver fact: `claude, effort high` for a native job, `pi (preferred claude: <reason>)` for a fallback.
   - The Quota line's separate Claude item (shown only while the switch is ON): `Claude ok`, `Claude limited until
     HH:MMZ`, `Claude blocked (sign-in)` or `Claude unknown`. It is never merged into the gateway percentages.
   - Cost: a native run with no complete usage reads "unavailable (not measured)", never 0.
   - The run log's `routing_resolved` event carries `requested_driver`, `driver` and `driver_reason`.
4. **Rollback.** Remove the row: new jobs route to pi again, and a started native job keeps its driver. Or turn the
   switch OFF: new jobs on that row are refused by name (never run on pi), and resumes and revives of native jobs are refused; teardown
   still works. Deleting `state/native-availability.json` only resets the snapshot to unknown.

## Claude CLI for ship and review workers (the flip)

The operator does this by hand. picp never edits the home's data files. The mechanism and the concurrency rules are in
[native-drivers.md](native-drivers.md#native-concurrency-and-the-flip-n4i).

1. **Back up** both files with dated copies: `cp data/routing.json data/routing.json.<date>.bak` and
   `cp data/native.json data/native.json.<date>.bak`.
2. **Rows.** In `data/routing.json`, set `"driver": "claude"` on `risky-ship`, `big-ship`, `small-ship` and `reviews`.
   Each row keeps its explicit `anthropic/claude-…` model, and that model stays in `allow`.
3. **Switches.** In `data/native.json`, set `"claude_ship": true` and `"claude_review": true`, and keep
   `"max_concurrent": 1`. When every slot is taken, a new row-preferred job runs on pi with `driver_reason`
   `occupied: …`.
4. **Raise `max_concurrent`** (up to 4) only after 5 native ship jobs show no `allowed_warning` in the availability
   snapshot.
5. **Rollback** means restoring both `.bak` files. New dispatches follow them at once, and a started job keeps its
   driver.

## Codex CLI soak (opt-in)

This section documents the soak; nothing here performs it, and no shipped row or default changes. Defaults stay pi and
every codex switch stays OFF. The mechanism is in [native-drivers.md](native-drivers.md) ("Codex CLI workers").

1. **Preconditions.** This home runs a build with the C8 Settings switches. `/doctor` shows `codex.cli`, `codex.login`
   and `codex.containment` ok; fix any of them first (each line names its fix). Work under a mandate with a token cap:
   a codex job reports tokens only and costs $0.00 in every USD sum, so token caps are the only spend bound.
2. **Back up** both files with dated copies: `cp -p data/routing.json data/routing.json.<date>.bak` and
   `cp -p data/native.json data/native.json.<date>.bak` (when it exists).
3. **The switch.** Dashboard Settings → Native workers: the Codex CLI switch for that class. Leave
   `codex_max_concurrent` at 1 (it is set in `data/native.json` by hand and is not in Settings). The switch comes
   first: Model routing offers the Codex CLI on a rule only while its class switch is on.
4. **A codex rule.** In Settings → Model routing, set the rule's CLI to Codex CLI, pick an `openai/gpt-…` model
   (it must be in `allow`) and a thinking from `low` to `max` (`off` and `minimal` have no Codex effort), keep pi
   models as its fallbacks, and Save. Or write a row of its own by hand, above the row it should shadow:

   ```json
   { "id": "codex-research", "role": "planner", "scope": ["S"], "model": "openai/gpt-<model>",
     "fallbacks": ["<the pi research model>"], "thinking": "high", "driver": "codex" }
   ```

   Settings writes `driver: "codex"` on that rule through the audited write (SD-codex-rule); picking pi again deletes
   it. The Workers CLI leaves a codex rule alone.
5. **Order.** Research first (`codex_research`), then reviews (the `reviews` row, `codex_review`), then ship (the
   `small-ship` row, `codex_ship`). Move to the next class only after five clean jobs in the current one.
6. **What to watch.**
   - Job detail's Driver fact: `codex, effort <level>` for a codex job, `pi (preferred codex: <reason>)` for a fallback.
   - The chat footer's Codex item (shown while any codex switch is on): `Codex ok`, `Codex limited until HH:MMZ`,
     `Codex limited (reset unknown)` or `Codex unknown`.
   - The run log's `native_run` event: `lockdown: "ok"`, no `bypass`, `hook_failed: false`, measured tokens.
   - Cost reads "unknown (tokens only)", never a dollar figure.
7. **Stop rules.** Any kill criterion in native-drivers.md (a forbidden action runs, a dead hook lets a tool act, a
   report for another job is accepted, usage counted twice, a process outlives a stop, an extra surface is not
   refused): turn the switch off and report it. Do not work around it.
8. **Rollback.** Remove the codex rows (new jobs then route to pi), then turn the switch off in Settings (the key is
   deleted); with a codex row left and the switch off its jobs are refused by name, never run on pi. Before running an older build, restore the `.bak`
   files and follow the recovery notes in native-drivers.md.
