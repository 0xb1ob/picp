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
| `risky-any` | planner, risk high | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | xhigh |
| `risky-ship` | implementer, risk high | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | high |
| `reviews` | gate-reviewer | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | high |
| `research-big` | planner, scope L | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | high |
| `big-ship` | implementer, scope M/L | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | medium |
| `small-ship` | implementer, scope S | `anthropic/claude-sonnet-5-5` | `anthropic/claude-opus-5-5`, `openai/gpt-6.1-sol` | high |

Profiles (`profiles/*.md`), which is what ordinary planning and QA resolve from
(cp-routing-t4 left them without a rubric row on purpose):

| profile | preferred | then | effort |
|---|---|---|---|
| `planner` | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | medium |
| `implementer` | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | medium |
| `qa` | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | low |
| `gate-reviewer` | `anthropic/claude-opus-5-5` | `openai/gpt-6.1-sol` | high |

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
     actually authenticated and that every profile route resolves. A route
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
  profile, or rescue an explicit override.
