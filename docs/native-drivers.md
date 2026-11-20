# Native CLI drivers: T3 Claude adapter vendoring (N1)

**Outcome: no-go for N1 as specified. Three stop rules fired during the closure preflight; nothing was vendored,
built, installed or loaded.** This page records the measured closure so the next decision starts from evidence.

Upstream pin: `pingdotgg/t3code` at `8b44f42b14c8e273156474a924ccf29680dd7857` (committed 2026-11-04, MIT,
`LICENSE:1–21`). Roots: `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (C below, 11,901 lines)
and `apps/server/src/provider/ClaudeTurnTokenUsage.ts`. Line references are at the pin.

## Stop rules that fired

1. **The closure needs `apps/server/src/provider/Drivers/*`.** C imports four Drivers modules as runtime values
   (`verbatimModuleSyntax: true`, `tsconfig.base.json:10`, so none is erased):

   | Import | Driver module | Runtime use in C |
   |---|---|---|
   | C:146 | `Drivers/ClaudeExecutable.ts` | C:11871 `resolveClaudeSdkExecutablePath` |
   | C:147 | `Drivers/ClaudeSkillDispatch.ts` | C:2156, C:2345 `planClaudeSkillDispatch` |
   | C:151 | `Drivers/ClaudeSkills.ts` | C:1674 `claudeLaunchArgDirectories`, C:4778 `discoverClaudeSkills` |
   | C:165 | `Drivers/ClaudeHome.ts` | C:8734 `claudeSignedOutMessage`, C:11868 `makeClaudeEnvironment` |

   These four are host helpers (33,712 bytes), not `ClaudeDriver.ts`; their own imports reach no account or
   reset-credit code. Allowing them is an operator decision, not a worker one.
2. **The closure needs DB, auth/secret and HTTP code.** C:161 imports `../../serverSettings.ts`, used as a value
   inside `makeClaudeAdapterV2` at C:4621 (`Effect.serviceOption(ServerSettings.ServerSettingsService)`).
   `apps/server/src/serverSettings.ts` then imports, at runtime:
   - `:32` `@t3tools/shared/nodeSqliteClient` (SQLite client);
   - `:57` `./auth/ServerSecretStore.ts`;
   - `:58` `./policy/ManagedPolicy.ts`, which reaches `packages/tailscale` via `policy/managedLimits.ts:12`;
   - `:59` `./secrets/secretProviderDefinitions.ts`, which reaches the 1Password secret-provider driver;
   - `:60` `./sourceControl/sourceControlHostSecrets.ts`, which reaches all nine `packages/source-control-*`
     forge drivers (GitHub, GitLab, Bitbucket, Azure DevOps and others: 92 files, 1,340,502 bytes).

   The `@t3tools/contracts` barrel (C:80, `packages/contracts/src/index.ts:9,29`) also brings in the HTTP API
   contracts `environmentHttp.ts` and `server.ts` (`effect/http-api`).
3. **A non-permissive licence.** `@anthropic-ai/claude-agent-sdk@0.3.284` (runtime import, C:35–60) declares
   `"license": "SEE LICENSE IN README.md"`; its `LICENSE.md` reads "© Anthropic PBC. All rights reserved. Use is
   subject to the Legal Agreements". That is outside MIT, ISC, Apache-2.0, BSD-2/3 and 0BSD.

No vendored source edit was attempted and no bundle was built, so the "source edit needed" and "Node 24 import"
rules were not reached. The live-install build-step question was not reached either.

## Measured closure

Resolved by following every `import`/`export … from`/`import()`/`import("…")` type reference from both roots with
the TypeScript parser. Relative paths resolve as written; workspace packages resolve through their `package.json`
`exports`. An edge is type-only when the declaration or all its specifiers are `type`. Runtime files are those
reachable through runtime edges alone. Bytes are file sizes at the pin.

| Area | Files | Bytes | Runtime files | Runtime bytes | Type-only files | Type-only bytes |
|---|---|---|---|---|---|---|
| packages/effect-codex-app-server | 4 | 2,415,401 | 0 | 0 | 4 | 2,415,401 |
| packages/source-control-* (9 dirs) | 92 | 1,340,502 | 92 | 1,340,502 | 0 | 0 |
| packages/contracts | 77 | 1,006,034 | 77 | 1,006,034 | 0 | 0 |
| apps/server/src/orchestration-v2 (root + siblings) | 8 | 520,116 | 8 | 520,116 | 0 | 0 |
| packages/shared | 47 | 490,498 | 42 | 446,983 | 5 | 43,515 |
| packages/provider-core | 37 | 235,433 | 26 | 183,584 | 11 | 51,849 |
| apps/server serverSettings chain (settings, auth, secrets, policy, source control) | 12 | 148,583 | 12 | 148,583 | 0 | 0 |
| apps/server/src/provider (other) | 10 | 112,551 | 10 | 112,551 | 0 | 0 |
| apps/server other (config, attachments, preview, process, package.json) | 10 | 93,353 | 9 | 90,791 | 1 | 2,562 |
| apps/server/src/provider/Drivers/* (stop rule) | 4 | 33,712 | 4 | 33,712 | 0 | 0 |
| packages/tailscale | 2 | 25,261 | 2 | 25,261 | 0 | 0 |
| packages/provider-{acp-registry,cursor,fx,grok,kiro,muse,opencode,pi} | 16 | 24,544 | 16 | 24,544 | 0 | 0 |
| packages/secret-provider-* | 6 | 15,737 | 5 | 9,885 | 1 | 5,852 |
| **total** | 325 | 6,461,725 | 303 | 3,942,546 | 22 | 2,519,179 |

`ClaudeTurnTokenUsage.ts` alone is self-contained at runtime: 1 runtime file, 9,338 bytes; its other 77 files
(1,006,034 bytes of `packages/contracts`) are type-only.

### npm packages reached (lock-resolved from `pnpm-lock.yaml` at the pin)

| Package | Version | Licence | Edge |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.284 | SEE LICENSE IN README.md (proprietary) | runtime |
| `effect` | 4.1.2 | MIT | runtime (80 subpaths, including `http`, `http-api`, `sql`, `rpc`) |
| `diff` | 8.0.3 | BSD-3-Clause | runtime |
| `yaml` | 2.9.0 | ISC | runtime |
| `unified` | 11.0.5 | MIT | runtime |
| `remark-parse` | 11.0.0 | MIT | runtime |
| `remark-gfm` | 4.0.1 | MIT | runtime |
| `remark-math` | 6.0.0 | MIT | runtime |
| `ffi-rs`, `mdast` | — | not audited | type-only |

Effect 4.1.2 is confirmed by the lock (`effect@4.1.2: {}`) and the workspace catalog. Licences come from
`npm view <pkg>@<version> license`; the SDK's `LICENSE.md` was read from `npm pack` output.

### Not measured

Vendored and generated bytes, the `node_modules` install-size delta, bundle size and cold probe time do not
exist: the stop rules fire before the copy, the install and the build.

## Thin-driver fallback (estimate)

**Superseded by the decision below:** the stream-json suggestion in this section is not the chosen design.

A picp-owned Claude driver that spawns the user's `claude` CLI in `--print --output-format stream-json` mode and
parses its NDJSON avoids the Drivers, settings/DB/secret/forge chain and the SDK dependency (picp would not
redistribute the SDK; the CLI's own terms still apply to whoever runs it). Estimate: 600–900 lines of picp
TypeScript plus tests, no `effect`. `ClaudeTurnTokenUsage.ts` can be reused as the one attributed MIT file, since
its runtime closure is itself. It gives up T3's event normalization, subagent/workflow projection and edge-case
handling in C, which would be re-earned case by case.

## Go/no-go for N2

**No-go** for N2 on the vendored-adapter path until the operator decides all three findings: allow the four
Drivers helpers, accept the serverSettings chain (or wait for upstream to make it optional), and accept the SDK
licence. If any answer is no, N2 should start from the thin picp driver on the official Agent SDK in "Decision
(2026-11-04)" below (the stream-json pointer to the thin driver above is superseded).

## Bump procedure (if vendoring is ever approved)

Pick the new commit, rerun the closure resolver from both roots, diff the file list and the npm list against the
previous pin, re-audit every new licence, recopy byte-identical with fresh git blob SHA-1s, rebuild, and rerun the
integrity, load and boundary checks before the pin moves.

An Agent SDK bump (N2 driver) also bumps the 8 `vendor/claude-binary-stub/<platform>/package.json` versions to the
SDK's new `optionalDependencies` pin; `tests/claude-binary-stub.test.ts` fails until they match.

## Decision (2026-11-04)

- **Choice:** the operator chose "Thin driver on Agent SDK" (ask-5bc51801aafe). picp builds its own small Claude worker
  driver on the official `@anthropic-ai/claude-agent-sdk`, as a pinned npm dependency, not vendored. T3's
  ClaudeAdapterV2 serves as a reference only.
- **Licence:** the SDK's "All rights reserved" licence rules out copying or patching it. It does not rule out
  depending on it, which is how T3 uses it.
- **Versions, the same way T3 handles them:** a caret range plus the lockfile (T3 `apps/server/package.json:37`,
  `^0.3.284`). Always use the user's installed `claude` executable, never the SDK's bundled platform binaries (T3
  `pnpm-workspace.yaml:281–289`, `Drivers/ClaudeExecutable.ts`). Give a version advisory, with no auto-update.
- **Reuse:** only `apps/server/src/provider/ClaudeTurnTokenUsage.ts` (MIT, pin 8b44f42), copied unmodified.

## Spike result (N2 step 1, 2026-11-04)

`src/drivers/claude-spike.ts` runs one isolated Claude research-role query through SDK `query()` on the user's
installed `claude`. It is not wired into dispatch, send, revive, routing or the fleet; pi stays the only production
worker runtime.

**Verdict: Go for step 2.** No kill condition fired: every forbidden action was denied before it ran, a wrong-job
or conflicting report was refused, the exit is the observed one, and a throwing guard denies. Resume double-counting
is P3 work (this spike never resumes), so it stays a kill condition for step 2.

### Capability matrix (measured against `claude` 2.1.318, fake model)

| Capability | Result | Evidence |
|---|---|---|
| Hooks | In-process `PreToolUse` hook, `onFailure: "block"`; picp's worker guards deny before execution, a throw is a deny | `tests/e2e/native-worker-spike.test.ts` (3), (5); `tests/claude-spike.test.ts` |
| MCP | picp's `report_result` as an SDK in-process MCP server (`mcp__picp__report_result`), validated by the worker-reporter checks, written once | e2e (1), (2) |
| Resume | SDK `resume` on a caller-kept scratch dir; the resumed process restores the session's `modelUsage`, so the prior run's ledger is the baseline. Counted once (N3a G2) | `tests/e2e/native-worker-gates.test.ts` G2 |
| Interrupt | The caller's `AbortSignal` aborts the run; the observed exit is reported and the pending tool never runs (N3a G2) | `tests/e2e/native-worker-gates.test.ts` G2 |
| Usage | T3's `ClaudeTurnTokenUsage.ts` normalizer: `complete` on success; unknown is `unavailable`, never 0 | e2e (7); unit `spikeUsage` |
| Exit | The child's own exit code/signal; after a 10 s grace the driver kills and still reports the observed exit | e2e (7) |

Isolation: every run gets a `mktemp -d` scratch dir (dirs mode 0700) outside the worktree holding `HOME`,
`CLAUDE_CONFIG_DIR` and `TMPDIR`, removed in `finally` (a resume passes its own `scratchDir`, which the caller removes).
`settingSources: []`, `strictMcpConfig`, `managedSettings: { disableAllHooks: true }`, no plugins, skills or agents,
`Agent`/`Task`/`WebFetch`/`WebSearch` disallowed. The child env is an allow-list (`PATH`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TZ`) plus the explicit provider variables; a host `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` never reaches it.
N4m: `managedSettings` also sets `strictKnownMarketplaces: []` (env `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`), so the headless plugin reconcile never installs the passed settings' `enabledPlugins` into a kept scratch for a resumed follow-up.

### Step-2 gates (before any wiring)

Both gates below are now measured and closed; see "Step-2 gates result (N3a)".

- **Shell write scope must be enforced before wiring.** The Write tool is scoped to the artifact directory
  (`src/drivers/claude-spike.ts:178`), but Bash is not: a redirect (`echo x > file`) or a `cp`/`mv` into the worktree
  passes. Bash is covered only for specific shapes: host auth copies (`src/worker-credential-guard.ts:46`), bulk copies
  of the home (`:183`), history rewrites (`src/worker-history-guard.ts:52`), shell `apply_patch`
  (`src/ci-wait.ts:229`), and key-path reads plus audited remote-host calls (`src/worker-host-guard.ts:44`).
- **Resume and interrupt** are measured before wiring; resume double-counting usage stays a kill condition.

### Versions (as T3 handles them)

- `@anthropic-ai/claude-agent-sdk` `^0.3.318` in `package.json`, exact `0.3.318` in `package-lock.json` (T3:
  `apps/server/package.json:37` `^0.3.284`). `zod` `^4.6.7` is added because it is the SDK's peer. N3a moved both
  to `dependencies`; `tests/structure.test.ts` approves them in its runtime dependency allow-list.
- The SDK always gets the installed `claude` from PATH (`pathToClaudeCodeExecutable` plus `spawnClaudeCodeProcess`,
  which records the spawned command); the e2e asserts it equals the resolved path.
- Version advisory: `CLAUDE_VERSION_FLOOR` is 2.1.318, the version measured working. A missing `claude` or an older
  one fails with "run `claude update`". No auto-update (`DISABLE_AUTOUPDATER=1` in the child).
- **Bundled platform binaries are never installed.** T3 drops them with pnpm overrides (`pnpm-workspace.yaml:281–289`).
  picp gets the same result with npm workspaces: `vendor/claude-binary-stub/<platform>/` holds 8 empty stubs (only a
  `package.json` with the SDK's pinned name and version), and root `package.json` `workspaces` links them in. npm
  then satisfies the SDK's optional dependencies with in-checkout links, so it never downloads the binaries. npm
  `overrides` with a local `file:` stub were tried first and refused: the lock and the installed links resolve the
  path differently, either failing `npm ci` or linking outside the checkout. `tests/claude-binary-stub.test.ts` pins
  every lock entry to a stub link and each stub version to the SDK's pin.

### Licences

- `@anthropic-ai/claude-agent-sdk`: `"SEE LICENSE IN README.md"`; its `LICENSE.md` reads "© Anthropic PBC. All rights
  reserved. Use is subject to the Legal Agreements". picp depends on it from npm and never vendors, copies or patches
  it. Its peers `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` are MIT.
- `vendor/t3code/ClaudeTurnTokenUsage.ts`: MIT (T3 Tools Inc.), byte-identical at pin 8b44f42, recorded in
  `vendor/t3code/pin.json` and `THIRD_PARTY_NOTICES.md`. `vendor/t3code/contracts-shim.d.ts` is picp's own type shim.

### Measured

| Item | Value |
|---|---|
| SDK | 0.3.318, range `^0.3.318` |
| `claude --version` | 2.1.318 |
| `node_modules` delta | +39 MB with the stubs (main 192 → 231 MB, clean `npm ci`); +351 MB before them (202 → 553 MB at the first head, with the bundled 323 MB `claude-agent-sdk-linux-x64` binary) |
| Fake-model run | cold start (spawn to `system/init`) 473 ms; a five-step run 808 ms |
| Live smoke (one run) | exit 0, `claude-opus-5-5`, 5.86 s (cold start 409 ms), usage complete: 947 in / 134 out |
| Files | `src/drivers/claude-spike.ts` 444 lines; `tests/harness/claude-mock-provider.ts` 156 lines (N2; N3a sizes below) |

The live smoke (`tests/e2e/native-worker-live-smoke.test.ts`) runs only with `CP_LIVE_TESTS=1`: one no-tool turn
using the operator's login, which `claude` reads from its own settings file; picp passes the path and never reads it.
`report_result` was registered in that run but never called (no tools, one turn).

## Step-2 gates result (N3a)

Fake model through the real installed `claude` 2.1.318 unless stated; `tests/e2e/native-worker-gates.test.ts` holds
G1–G3 and R1 and skips when `claude` is not on PATH (as in CI). Still no runtime wiring: dispatch, send and revive are
N3b, which must keep every layer below on.

- **G1, shell write scope.** The SDK `sandbox` option was tried first: on this host bubblewrap works but `socat` is
  missing, and `sandbox: { enabled: true, failIfUnavailable: true }` fails closed at startup ("socat not installed"),
  so it is never silently unsandboxed but cannot run here. The OS sandbox needs `socat` and stays a later option; picp
  does not install it. The deny-by-default read-only allow-list shipped here was replaced by the deny-by-shape scope of
  [WP2](#wp2-bash-scope) (`src/drivers/claude-bash-scope.ts`). The Write tool stays scoped to the artifact dir.
- **R1, env and secret paths.** A passed settings file's `env` reaches the CLI and every Bash child, so it is kept out
  in layers: env dumps (`env` with no command, `printenv`, bare `set`/`export`/`declare`, `compgen -v`) and secret-named
  `$` expansions are refused ([WP2](#wp2-bash-scope)), and a secret-path guard refuses Read, Grep, Glob and Bash arguments that are, link to, or
  contain the passed settings path, `<home>/.claude*`, `<home>/.config/claude*` (both `$HOME` and the passwd home),
  `/proc` or `/dev/fd`. The existing guards do not match these paths (`workerHostGuard` covers ssh keys only), so the
  guard is new and sits beside them. The CLI's own `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` exists in 2.1.318 but runs
  Bash inside the same bwrap + `socat` sandbox: here every Bash call fails closed under it, so it is not set (it would
  also stop the read-only commands G1 keeps). The e2e proves the scrub alone still keeps the provider token out, and
  the N2 spike e2e checks the env keys handed to the real spawn: no host `ANTHROPIC_*`/`CLAUDE_*` key reaches it.
- **G2, resume and interrupt.** A resumed run keeps the session id, and its process restores the session's cumulative
  `modelUsage`; `spikeUsage` subtracts the prior run's ledger, so two runs of 2 model calls each count 24/14 and 24/14
  (48/28 for 4 calls, once). An `AbortSignal` interrupt during a tool_use turn exits `code 0`, not driver-killed,
  ~600 ms after the abort (the fake holds the answer 500 ms), and the pending Write never runs.
- **G3, loaded-surface lockdown** (`src/drivers/claude-lockdown.ts`). On `system/init`, before any tool is allowed,
  the driver compares init, `initializationResult()` (commands with their `builtin` flag, agents with descriptions)
  and the SDK's hook listing with what picp passed; on any extra it aborts with a named refusal holding counts only.
  Every tool call waits on that verdict. Built-in agents are pinned by a digest of name and description, so a loaded
  agent reusing a built-in name counts as an extra; a CLI update that rewrites a built-in description refuses until
  the pin is updated. Init cannot list empty skills, plugins and agents on 2.1.318, so only the CLI's own built-ins
  (`builtin` flag, `path: "builtin"`, agent digest) are allowed; the operator accepted this narrowing
  (ask-5e8f9aefe0df).
- **G4, dependencies.** The SDK and `zod` are runtime `dependencies`; the 8 workspace stubs and their pin test stay.

| Surface | picp passes | Allowed in init | Seen (fake / live) |
|---|---|---|---|
| tools | role list + `mcp__picp__report_result` | exactly that | 6 / 1 |
| MCP servers | `picp` (in-process) | only `picp` | 1 / 1 |
| skills | `skills: []`, `settingSources: []` | CLI-bundled only (`builtin` slash command) | 16 / 16 |
| plugins | `plugins: []` | path `builtin` only | 4 / 4 |
| agents | `agents: {}` | the CLI's 5 built-ins, by name and description digest | 5 / 5 |
| slash commands | none | `builtin` only | 44 / 44 |
| hooks | picp's in-process PreToolUse | none listed; `managedOnly` must bind | 0 / 0 |
| output style | none | `default` | default / default |

What the SDK controls, for the operator's question: with `settingSources: []` the CLI loads no user, project or local
settings, so the worktree `.claude/` skills, agents, commands, hooks and `CLAUDE.md` never load (L1/L2 markers absent
from every model request). `managedSettings: { disableAllHooks: true }` binds as managed-only hooks: a passed settings
file's hooks (`SessionStart` included) do not run, while picp's SDK callback hook still denies (L3: a
`permissions.allow` widening let no denied Write or Bash through). What it does NOT control:

- admin-managed policy (`managed-settings.json`, MDM) always loads and cannot be turned off from the SDK;
- `skills: []` is a context filter, not a sandbox, and a no-op without setting sources on 2.1.318 (kept as defence in
  depth): the CLI's bundled skills, built-in plugins, agents and slash commands stay listed in init;
- a passed settings file can still carry hooks (neutralized by the managed-only lock), `env` (reaches Bash, see R1) and
  `permissions` (the guard denies first); an `outputStyle` or a non-builtin plugin there is refused by the lockdown.

What the model sees (R2, first request to the fake model): the `tools` array is exactly the role list plus
`mcp__picp__report_result`, plus the CLI's `DeferredToolPlaceholder` (described as reserved, "never call"); no `Skill`,
`Agent`, `Task` or `SlashCommand` tool. The system prompt and messages list 0 built-in skill, agent or plugin
descriptions: of 16 skill, 5 agent, 4 plugin and 44 command names, the only matches are common words (`run`, `effort`,
`model`, and `claude` as the model's own name). The built-ins exist in init only and cannot be invoked: no tool calls
them. The 4 built-in plugins contribute 0 hooks, 0 MCP servers and 0 non-builtin commands or skills.

The settings path is a driver option: default `~/.claude/settings.json`, `null` for none; picp passes the path and
never opens it. Recommend an auth-only settings file for workers.

| Measured (N3a) | Value |
|---|---|
| Sandbox | unavailable (`socat` missing); fails closed at startup, so no spawn delta to measure |
| Lockdown check | 22–36 ms after init (fake cold start 390 ms) |
| Live smoke (one run, before R1/R2) | exit 0, verdict ok, counts as in the table, no extras |
| `node_modules` | 231 MB, unchanged (+39 MB over main before N2) |
| Files | `claude-spike.ts` 522, `claude-bash-policy.ts` 230, `claude-lockdown.ts` 96, gates e2e 268 lines |

## N3b research wiring

**The switch.** `workers.native_claude_research` (dashboard Settings → *Native workers*, file `data/native.json`, key
`claude_research`) is OFF by default. It changes nothing on its own: a job runs native only when `cp_dispatch` also
names `driver: "claude"` or its rubric row carries `driver: "claude"` ([S1](#routing-level-driver-s1)). pi stays the
default driver, and no shipped routing row names claude.

**Selection and refusals.** `nativeSelectionRefusal` (`src/drivers/claude.ts`) runs from `resolveDriverRoute`
(`src/dispatch-driver.ts`) when `Dispatcher` resolves the route, before preflight, the lease and any spawn. An explicit
request refuses as `refused: <job> cannot run on the Claude CLI driver: <reason>`, in this order:

| Condition | Refusal names |
|---|---|
| switch file unreadable or off | the setting and where to turn it on |
| not research (role `planner`, delivery `local`, `answer`, `board` or `pipeline`; a pipeline's planner runs native, [D2](#routing-level-driver-s1)) | the job's kind/role/delivery; ship implementers run native since [N4f](#native-ship-jobs-n4f); review and plan roles never do. The parent and the operator are not jobs: each picks its CLI in its own file ([S1c](#native-parent-entry-s1c), [O2](#claude-cli-operator-o2)) |
| the home's native slots are full (fleet records with `worker.driver`, no observed exit, the job's own excluded) | `max_concurrent` and the live jobs ([N4i](#native-concurrency-and-the-flip-n4i)) |
| `claude` missing or below the pinned floor `CLAUDE_VERSION_FLOOR` | `claude update` / install remedy |

`WorkerManager.spawn` refuses a native worker past `max_concurrent` again (`SpawnSafetyError`) before admission. A `driver: "claude"`
dispatch held by the spawn cap or full native slots (queued) or by open blockers (armed) keeps its driver
(`QueuedDispatchRequestSchema.driver`, `toDispatchRequest`), so its release re-runs this selection: it runs native or is
refused, never on pi. A queued entry refused as `occupied` stays at the head; a successful `cp_teardown` drains the queue
once the closed record frees the slot. A quality voter that finds the native slot taken at spawn re-routes to pi
(`explicit: "pi"`) instead of abstaining.

Policy: a version floor (2.1.318), not an exact pin, because `claude` auto-updates and an exact pin would refuse every
run after each update, while the N3a lockdown digest already refuses a changed built-in surface; remedy `claude update`.

**Lifecycle.** The native worker is `src/drivers/claude-worker.ts`, a child that speaks the pi RPC lines dispatch already
reads, so the recorder, intake, bounds, observers and teardown are pi's own. `runClaudeSpike` is the run core (folded in,
no longer test-only): every N3a gate is on and not optional.

| Step | Native behaviour |
|---|---|
| Dispatch | `worker.driver: "claude"` on the fleet record; the brief is the first `prompt`; the routed model must be an explicit `anthropic/claude-…` id, passed to the CLI, or the spawn is refused |
| Gates | read-only Bash policy, secret-path guard (R1), lockdown, managed-only hooks, env allow-list, fresh `CLAUDE_CONFIG_DIR`, no setting sources |
| Report | `mcp__picp__report_result` through the existing validators and intake; one accepted generation; a wrong-job report is refused |
| Bounds | tool calls arrive as `tool_execution_start`; wall-clock and tool-call caps apply as for pi |
| No report or crash | the worker exits non-zero; the job fails on the observed exit, never a guessed completion |
| Teardown | stdin close aborts the run; the lease returns only after the observed child exit (`src/teardown.ts`) |
| Ledger and dashboard | job detail shows `Claude CLI` next to the model |
| Log transcript | each top-level assistant/user message (text, tool calls, tool result text, thinking text; never signatures, the init message or CLI config) is appended, flushed per message, as pi session lines to `state/sessions/native/<job>.jsonl` (mode 0600); each block is capped at 64 KiB with a visible truncation marker, a resumed run appends a "resumed" entry to the same file, and run status records it as `transcript_file`, which the dashboard job page's Transcript tab reads. It survives teardown; only the scratch dir is removed (`src/drivers/claude-transcript.ts`) |

**Follow-ups.** N3c replaced the N3b "Refused until N3c" list; see [N3c follow-ups](#n3c-follow-ups).

**Turn limit.** Each Claude CLI process runs with an SDK turn cap of 500 (`NATIVE_MAX_TURNS` in
`src/drivers/claude-worker.ts`); `CP_NATIVE_MAX_TURNS` overrides it with a positive integer, and any other value keeps
500. Every `native_run` event records `max_turns`; a run the SDK ends with `error_max_turns` adds `stop: "max_turns"`
and a stderr line. If the worker then exits without a report, the job fails as `turn_limit` ("Stopped at turn limit"),
not `crash`; the worktree and session are kept, and like every named stop it is never auto-recovered.

**Settle and named stops (N4e).** A native turn that ends with a clean `success` and no report no longer exits: the
worker emits `agent_settled` and stays idle, so settle.ts's existing nudge, correction and recovery prompts (same caps)
resume the same session. Every idle prompt passes `assertNativeResume` first (`src/drivers/claude-lifecycle.ts`), so a
switch-off, freeze, drain or spent window refuses it by name and nothing resumes. A turn ending on a rejected window, an
auth failure or a lockdown refusal records `native_run.stop: "window" | "auth" | "lockdown"` and exits non-zero, never
nudged: `window` fails as `provider_limit` naming the window and its reset (a plain `cp_revive` after the reset
resumes the session), `auth` as `model_call_failed` and `lockdown` as `spawn_failed`.

**Usage.** N4a measures every native run from its SDK result's `modelUsage` (`src/drivers/claude-usage.ts`), on any
subtype: `success` and every `error_*` result, so a run stopped at the turn limit is counted too. Per model it reads
input, output, cache read, cache write and `costUSD`; the cost is the larger of the per-model sum and `total_cost_usd`
(the cross-check). The growth over the session baseline becomes pi's `message_end` usage (input excludes cache
read/write), so run status, the fleet record, mandate accounting and the per-job `checkBudget` read it exactly like pi
usage. An unreadable `modelUsage` or zero tokens writes no measurement: the worker emits `usage_unavailable`, run status
carries `usage_unavailable: true` and the dashboard shows "unavailable (not measured)". Accounting then adds nothing for
that run (never a measured zero) and admission does not wait on it. Every `native_run` event names `result_subtype`,
`usage_status` (`complete`, `estimated`, `unavailable` or `unbaselined`) and `denied`: at most 5 `tool: reason` lines
of at most 200 characters, paths and env values redacted.

**Measured, estimated or unavailable (N4k).** A stop (stdin end or SIGTERM) that reaches a turn in flight waits for
its `result`: `NATIVE_REPORTED_GRACE_MS` (45 s) once a `report_result` or `report_verdict` was accepted, because the
parent stops a reviewer as soon as its verdict lands, else `NATIVE_RESULT_GRACE_MS` (4 s). The parent's stdin→SIGTERM
grace for a native worker is `NATIVE_SHUTDOWN_GRACE_MS` (57 s), so no SIGTERM cuts the wait; a second stop still aborts
at once. A result in time is **measured** (`complete`). A run that still ends without one is **estimated**: the usage
on its streamed assistant messages, counted once per message id, becomes the same `message_end` usage at cost 0 with
`cost_unknown` (picp holds no per-model price table), and the session baseline advances by it so a resume never counts
those tokens again. Only a run with neither a result nor streamed usage stays **unavailable**.

**Rollback.** Turning the switch off refuses new native dispatches, resumes and revives; a live native job keeps its
driver until its own exit or teardown, and teardown still works.

## N3c follow-ups

**Session metadata.** The worker keeps `<run dir>/native-claude` (`NativeSessionSchema`, `src/drivers/claude-followup.ts`,
mode 0600, atomic write): driver, the kept scratch dir (`$TMPDIR/cp-claude-native-XXXXXX`, the Claude config dir), the
Claude `session_id` from the init message, and the usage baseline. The id grants nothing; it is only the resume key, and
every resume re-runs admission. Teardown removes the scratch dir only after the observed worker exit
(`native_scratch_removed` in the run log); a record that fails validation keeps the dir and names why.
It also removes it when the recorded worker pid is gone even though no exit code was recorded (`src/teardown.ts`).

**Admission.** Every resume and revive passes `assertNativeResume` before a claude process starts, in dispatch's order:
the drain freeze and update hold, trust, the per-job budget on the recorded running total, then `assertNativeSelection`
(switch, research role, concurrency 1, version floor). Every N3a gate stays on in a resumed run: `runClaudeSpike` is the
only path, with the same Bash policy, R1, lockdown, managed hooks, env allow-list and fresh `CLAUDE_CONFIG_DIR`.

| Follow-up | pi | Claude CLI |
|---|---|---|
| `cp_send`, worker idle | prompt into the live session | admission, then ONE new claude process resumes the session with the message; worker disposition `resuming` (admitted, process starting, not yet run), ack `native: resuming: …`; a resume that throws journals `native_resume_failed` and the worker exits non-zero |
| `cp_send`, worker busy (auto/follow_up) | steer (auto) or follow_up | queued in `native-followups.jsonl`; ack `receipt: queued`, `native: queued until the current turn ends …` |
| `cp_send` mode `steer` | steer into the turn | refused by name; nothing sent |
| `cp_revive` | respawn idle | respawn, then resume with picp's revive prompt (also from `failed`) |
| `cp_revive continue_failed` / bounded recovery | continue / automatic | both run the plain native revive (admission, then the revive prompt): `continue_failed` records `continue_failed_as_revive`, and bounded recovery spends its one attempt, never redispatches, and refuses the named stops `turn_limit`, `provider_limit`, `model_call_failed` and `spawn_failed` (`native_refused`) |

**Busy-send choice: (ii), a durable picp queue.** Streaming user input into a live SDK session is a mid-turn steer
whose arrival point picp cannot observe or gate, so the ack could not be truthful. A busy send is appended to the queue
and acked as queued, never as delivered or steered. At turn end the worker first claims the queue atomically (a rename
to `native-followups.jsonl.claimed`), so a send queued while admission runs lands in a fresh queue for the next turn end.
It then re-runs `assertNativeResume`; if admitted it delivers exactly the claimed messages as one resumed turn; if
refused it puts them back ahead of any newer ones and logs `native_followup_refused` with the reason. A claim (this
one, or sends left queued when an idle send or revive starts a turn) settles and logs `native_followup_delivered` only
after its turn returns; a turn that throws puts them back the same way and logs `native_resume_failed`, so the next
admitted turn delivers them once. A queued follow-up does not reopen the report slot; an idle send does, so
reports stay one accepted per generation.

**Usage across resume.** A resumed `claude` restores the session's cumulative `modelUsage` and `total_cost_usd`. The
record keeps the last result's per-model ledger (with its `cache_read`/`cache_write` split) and cost as the baseline; a
resumed run counts only the growth over it, so each run is counted once. A record from before the split still parses;
its input growth counts as uncached input. A run without a readable ledger drops the baseline: that run and the next
are "unavailable", never 0 and never the cumulative total again. The budget check reads the running total through the
real admission path.

**Switch-off and restart.** With the switch off, resume and revive of an existing native job are refused with the named
switch reason and nothing starts; teardown still removes the worker and scratch dir. A parent restart or install drain
kills the native worker; the job keeps its session record, and a plain `cp_revive` resumes it once the parent is up.

## Routing-level driver (S1)

A rubric row's `driver` (`docs/contracts.md`, routing) makes native a routing choice, still behind the switch. Nothing
changes until a row carries `driver: "claude"` **and** the switch is ON; the shipped defaults name no driver.

**Precedence** (`resolveDriverRoute`, `src/dispatch-driver.ts`, for `cp_dispatch` preview and admission alike):

| Request | Driver | On a failed condition |
|---|---|---|
| explicit `driver: "claude"` | claude | refused by name, today's semantics; no lease |
| explicit `anthropic/claude-…` `model` override (cp_dispatch `model`, pipeline `implementer_model`), no `driver`, and the role's row (picked as if no override) is `driver: "claude"` | claude on the override model; `driver_reason` `rule: <row> prefers claude; override <model>` | pi on the override, `driver_reason` names the condition |
| any other explicit `model` override, no `driver` | pi | (the row is not consulted) |
| matching row `driver: "claude"` | claude | pi, `driver_reason` names the condition |
| row without `driver` (legacy) or `pi` | pi | — |
| a job whose fleet record already started (D1) | the recorded driver | a native job refuses rather than move to pi |

**Fallback reasons** (`driver_reason` is `<code>: <why>`): `denied` (the native primary is outside `allow` or hit by
`deny_by_role`), `switch`, `ineligible`, `occupied`, `cli_missing`, `cli_version`, and from S2 `window`,
`auth`, `lockdown` (below). The pi lane is the row's `[model, ...fallbacks]` through `resolveWithCapacity`, unchanged.

**Model and effort.** The native model is the row's own `model` (or an explicit override's), an explicit
`anthropic/claude-…` id; any other ref refuses the dispatch with no lease. The row's effort maps to SDK options: `off`
disables thinking, `low`/`medium`/`high`/`xhigh`/`max` set `effort`, `minimal` refuses, absent leaves the CLI default and
the reason records `effort CLI default`. The worker gets it as `CP_NATIVE_THINKING`; revive passes the same level.
When the native primary is `denied` or blocked by `window`/`auth`/`lockdown`, the row's `anthropic/claude-…`
fallbacks are tried in order (allowlist, then availability); the first unblocked one runs native and `driver_reason`
appends `<code>: <why>; native fallback <model>`. Switch, eligibility, CLI and slot refusals still go to pi.

**Eligibility (D2).** Research (role `planner`) with delivery `local`, `answer`, `board` or `pipeline` routes native,
so a pipeline's planner runs on its row's driver like any other. A gate revise is an ordinary native follow-up:
`queued` while the planner's turn runs, `resuming` the same session once it is idle, and the reopened slot takes the
revised report. `cp_pipeline advance` then routes the implementer by its own row. No selection returns the
`pipeline` code any more; it stays in `NativeRefusal` so recorded `driver_reason`s still read.

**Lock (D1).** The driver is fixed at the first admitted spawn and persisted as `worker.driver` plus `routing.driver`
and `routing.driver_reason`. A re-dispatch, revive, follow-up, continuation or recovery never reselects it; a fresh
operator-pick reroute (`src/reroute.ts`) must yield a model the recorded driver runs, or the respawn is refused.

**Concurrency.** Admission reserves the home's single native slot synchronously after the last await, so two
dispatches in one parent cannot both take it; the reservation ends when the dispatch settles (by then the fleet record
holds the slot) and on any pre-start failure. `WorkerManager.spawn` keeps its own final guard.

**Doctor.** A claude row's primary needs no pi credentials: `models.<profile>` reports `driver=claude <model>; pi
fallback …`, and an unusable pi lane is a warning, not an error.

## Availability snapshot (S2)

Native selection reads passive subscription evidence from earlier native runs; picp sends no extra request for it.

**Observation** (`src/drivers/claude-observation.ts`). From SDK `rate_limit_event` the worker keeps `status`
(`allowed`/`allowed_warning`/`rejected`), `rateLimitType`, `resetsAt` and `utilization`; everything else is dropped.
`resetsAt` is epoch **seconds** (the T3 adapter multiplies by 1000) and is stored as epoch ms; a non-numeric or absurd
value is no reset. `utilization` is display-only, and the overage fields are never read. Assistant errors
`authentication_failed`, `oauth_org_not_allowed` and `account_on_hold` become an `auth` code; a `rate_limit` error with
no rejected event marks an `unspecified` window rejected with no reset; a refused surface lockdown is `lockdown`. No
SDK text is stored or logged. The worker relays each as a `native_observation` event with its observation time and the
installed CLI version; a successful, lockdown-clean turn relays `turn_ok`.

**Cache** (`src/native-availability.ts`). `state/native-availability.json` under the home, written atomically by the
parent-side observer (`src/native-availability-observer.ts`) on native dispatch and revive, separate from the gateway
quota projection. Window events are deduplicated by `uuid` (the last 256 kept) and an older observation never replaces
a newer one. `seven_day_opus` and `seven_day_sonnet` apply only to that model family; the others apply to every model.
A missing or corrupt snapshot is **unknown**: neither spent nor free.

| Entry | New native selection |
|---|---|
| window `rejected`, reset in the future | blocked until the reset: `window: five_hour rejected until <UTC>` |
| window `rejected`, reset passed | unknown, attempted; the reason notes `unknown since its reset`, never "0% used" |
| window `rejected`, no reset | blocked: `window: … reset unknown` until invalidated |
| `auth` | blocked: `auth: <code> at <UTC>` until invalidated |
| `lockdown` | blocked: `lockdown: …` until invalidated |

**Invalidation** of a cached `auth`, `lockdown` or no-reset window entry: (i) a later observed `allowed` event for that
window, or a successful native turn (which clears only `five_hour`, `seven_day`, `seven_day_overage_included`,
`unspecified` and its own model family's window); (ii) the Settings switch turned OFF then ON (the switch file rewritten after the observation); (iii) a
different installed CLI version than the one that observed it.

**Lock.** The snapshot only steers NEW automatic jobs, which fall back to pi with the reason; an explicit
`driver: "claude"` and a started native job are refused by name instead. A native resume (`cp_send`, a queued
follow-up at turn end, `cp_revive`) is refused while a relevant window is rejected; queued sends stay queued in order,
and nothing moves to pi. Bounded recovery never resumes a native job (N3c).

**Rollback.** Turn the switch OFF (every job runs pi), or delete the snapshot file (unknown again); no state migrates.

## Operator view (S3)

Viewer and parent-side only; nothing here changes selection.

- **Job detail** (`/api/job/<id>` `job.driver_note`, the Driver fact): `claude, effort <level>` (or `effort CLI
  default`) for a native job, and `pi (preferred claude: <driver_reason, at most 200 chars>)` when a claude preference
  fell back. Records with no driver fields (legacy, plain pi) show nothing new.
- **Quota line** (`/api/workspace/status` `claude`, the chat footer): a separate Claude item, read through
  `nativeQuotaLine` (`src/viewer/native-quota.ts`) and never merged into the gateway `quota`. It is absent while the
  switch is OFF. States, in precedence order: `Claude blocked (sign-in)` (or `(lockdown)`), `Claude limited (reset
  unknown)`, `Claude limited until HH:MMZ` (the latest pending reset), `Claude unknown` (no readable snapshot, or a
  rejected window whose reset passed or was voided), `Claude ok`. The tooltip names each window. Entries the switch
  voided (ii) are ignored; the CLI-version check (iii) is not run here, since it would spawn `claude`, so after a CLI
  update the line may still show limited or blocked until the next dispatch re-checks and clears it.
- **Settings** help states the rule-plus-switch condition, OFF refusing resumes and revives, and that OFF then ON
  clears a remembered sign-in, lockdown or no-reset block.

The opt-in soak (a claude row, the switch, what to watch, rollback) is in
[`docs/routing-rollout.md`](routing-rollout.md#claude-cli-research-soak-opt-in).

## Role contract (N4b)

A native worker gets the same role contract a pi worker does: `nativeSpawnOptions` writes the profile body plus a short
native addendum (the Claude tool names, and the research artifact written with Write, not a heredoc) to
`<run dir>/native-system-prompt.md` (0600) and names it in `CP_NATIVE_SYSTEM_PROMPT_FILE`. `claude-worker.ts` reads it on
every turn, fresh or resumed, and passes it as the SDK `systemPrompt`; a missing, unreadable or empty file is a named start
error. The file path is in the worker's env only, never the claude child's. `SpikeJob` now carries the job's `kind` and
`role`, and `report_result` validates against them; the worker still refuses anything but research/planner.

## Implementer tool surface (N4c)

`src/drivers/claude-roles.ts` picks the tool set by role: planner keeps the research set (Read, Grep, Glob, Bash, Write)
unchanged; implementer gets Read, Grep, Glob, Edit, Write and Bash plus `report_result`; any other role is refused by
name. The lockdown's expected tools follow the role. An implementer's Edit/Write lands only where the realpath of the
target's nearest existing parent is inside the worktree (no symlink escapes, a dangling one included), outside `.git`,
off the secret paths and clear of the home's and every live grant's `exclude_paths`, which the worker process reads,
never the CLI child. Its Bash runs pi's pattern guards first, then (since [WP2](#wp2-bash-scope)) the native Bash
scope in place of the default-deny allow-list N4c shipped. The honest limit: `npm run` and `node` execute repo code, so
this is defence in depth at pi parity, not a sandbox. Selection stays research-only until N4f, so no production job
reaches this yet.

## Implementer forge tools (N4d)

`src/drivers/claude-forge-tools.ts` gives the implementer its network as in-process picp MCP tools beside
`report_result`. They run in the claude-worker process, which holds the inherited worker env, so no credential enters
the CLI child; the lockdown expects them for the implementer only. `git_push` pushes `HEAD` to `origin/<CP_JOB_ID>` in
the worktree and refuses `force`, main, the base branch (`CP_BASE_BRANCH`) and any other branch by name; a rejected
non-fast-forward push is refused by name too, never retried forced. `git_fetch` fetches `origin` in the worktree and
refuses any other `cwd`, the canonical clone included. `pr_create` opens a draft from the job branch (to
`CP_BASE_BRANCH` when set, else the repository's default) and records it in the run dir; a second call returns that
URL. `pr_edit` edits the title and/or body of that PR and refuses any other number. `gh_read` runs `pr view|checks`
on that PR or `run view <id> [--log-failed]` in this repo (widened in [WP1](#wp1-forge-reads)); `pr checks` and a
status `run view` share one snapshot per worker process, then the ci-wait repeat refusal answers. Every output passes
`redactGithubTokens` and is capped at 20,000 characters. The worker also reads `user.name`/`user.email` from the worktree's git config and passes them as
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so `git commit` works under the scratch HOME; no token, HOME or credential helper is
passed. The same slice makes `git checkout -- <path>` and `git restore` paths honour `exclude_paths`. N4f sets
`CP_BASE_BRANCH` at spawn (below).

## Native ship jobs (N4f)

**The switch.** `data/native.json` key `claude_ship` (no Settings row of its own; N4j was cut, and the Settings Workers
CLI sets it with the others, see [the flip](#native-concurrency-and-the-flip-n4i)) is OFF by default. It changes
nothing on its own: an implementer runs native only when its routing row (or the dispatch) says `driver: "claude"`,
the job is `kind:ship` with delivery `pr` or `local`, and `claude_ship` is on. Off, a claude row falls back to pi with
`driver_reason` `switch: the switch workers.native_claude_ship is off …`; an explicit `driver: "claude"` is refused
with no lease. The other keys: `claude_research` (unchanged), `claude_review` (the native reviewer, N4h, below) and
`max_concurrent` (integer 1–4, default 1; applied since
[N4i](#native-concurrency-and-the-flip-n4i)). Any other key, a non-boolean switch or an out-of-range count is refused by name, by every reader.

**What runs.** The native implementer gets the profile body plus a ship addendum (forge tools, commit in Bash, push only
with `git_push`, `pr_create` for the draft, then `report_result` with `head_sha`); a delivery `local` job's addendum
(N4i) says commit only, never `git_push` or `pr_create`, because picp integrates the branch locally. Dispatch passes the
job's base branch (the PR base for a bound PR, else the preflight base) as `CP_BASE_BRANCH`, the only new child env,
and the worker records it in its session record at its first turn. A revive passes the bound PR's base, then that
recorded dispatch base, then the project's `base_branch`. `pr_create` targets it and `git_push` refuses it.

**Follow-ups.** A CI-repair `cp_send` to the job's own native implementer (same kind) is admitted and resumes the same
session. A kind-changing promotion of a native research worker (a new brief via `task`/`task_file`) is refused by name:
its tools and policy were fixed at spawn. The revive prompt names the kind ("Continue the implementation …" for ship).

**Park→resume.** An `awaiting_merge` resume can re-lease the worktree at a new path, and the Claude CLI keys sessions by
cwd. The session record now keeps its `cwd`; a resume from a different worktree is refused by name
(`native_session_moved` in the run log) and the job continues on a fresh session led by its brief. A pre-N4f record has
no `cwd` and resumes as before.

**Rollback.** Set `claude_ship` false. New ship dispatches go to pi at once; jobs already started keep their driver (D1:
no pi fallback mid-job), and their resumes and revives are refused until the switch is back on or they are torn down.
Rows stay pi until the routing flip: this slice leaves the home's `data/native.json` and `data/routing.json` alone.

## Native concurrency and the flip (N4i)

**Concurrency.** `data/native.json` `max_concurrent` (1–4, default 1) is the home's native slot count. Three places
apply it: selection (`nativeSelectionRefusal`, live fleet records), dispatch admission (`src/dispatch-driver.ts`, a
per-home set of jobs being admitted, checked with the live records after the last await) and `WorkerManager.spawn`. A
live native process counts whether it is working or held, because a held PR keeps its idle worker for repairs. A job
never counts against itself, so a held job's own repair resumes its own slot. When the slots are full, a new job that
only prefers claude on its routing row falls back to pi, with a `driver_reason` starting `occupied:` that names the
live jobs. An explicit or locked native job is refused by name and never moved to pi (D1).

**The flip** (operator, by hand; picp never edits these files):

1. Back up both files with dated copies, e.g. `cp data/routing.json data/routing.json.2026-11-06.bak` and
   `cp data/native.json data/native.json.2026-11-06.bak`.
2. In `data/routing.json`, set `driver: "claude"` on the `risky-ship`, `big-ship`, `small-ship` and `reviews` rows
   (each keeps its explicit `anthropic/claude-…` model).
3. In `data/native.json`, set `claude_ship` and `claude_review` to `true`. Leave `max_concurrent` at 1 at first.
4. Raise `max_concurrent` only after 5 native ship jobs show no `allowed_warning` in the availability snapshot (S2).

**Rollback** means restoring both `.bak` files. New dispatches follow the restored files at once. Jobs that already
started keep their driver.

**The flip from Settings.** Dashboard Settings → *Model routing* → **Workers CLI** (`workers.driver`) does the flip for
every worker type at once, through the audited settings path. Claude CLI sets `driver: "claude"` on every rubric row
and turns `claude_research`, `claude_ship` and `claude_review` on; pi deletes every row's `driver` (absent is pi) and
deletes those three switches (absent is off). `max_concurrent` is never touched. The router reads the same files as
before, so no routing code changed. Every rubric role has a native class (`nativeClassOf`), so no row stays pinned.
Under native, each row's model picker lists only Anthropic Claude models and its thinking picker only the Claude
effort levels. The page names each row that needs a new model or effort and keeps Save off until all are valid. A
write that would leave a claude row on another model, or on `minimal`, is refused 400 and nothing is written. Fallbacks
are kept as they are. A non-Claude fallback stays the row's pi lane, under the S1 router rules above. The read model
reports `workers.driver` as the one driver every row names; when rows disagree it is null and names the split. A
claude value also names any switch still off. *Restore defaults* on that section puts the shipped models back and sets
pi.

## Native reviewer (N4h)

`cp_review`, `cp_gate` and the quality review resolve their reviewer through the driver resolver. A reviewer runs native
only when its rubric row (the `reviews` row) says `driver: "claude"`, `claude_review` is on, and a native slot is free
(`max_concurrent`: dispatched jobs, live reviewers and the subject's own native worker all count); otherwise it runs on
pi exactly as before, with the reason in the routing line. The subject job's own driver never binds its reviewer, and a
pipeline-owned subject may be reviewed natively (a reviewer takes no sends). The native reviewer gets Read, Grep and
Glob confined to its scratch packet plus `report_verdict`, an in-process MCP tool on pi's own handler: the same clamp,
`verdictChecks`, repair cap and write-once `verdict.json` (and `verdict-raw.json`), a wrong job or a different second
call refused by name. No Bash, Edit, Write or forge tools. A run that ends without a verdict is pi's no-verdict case
(settled or exited), inside the same deadline; `native_run` records the lockdown and measured usage in the review's run
dir. Rollback: set `claude_review` false.

## Native parent entry (S1c)

`data/parent.json` `driver: "claude"` (default `pi`) starts `src/drivers/claude-parent.ts` in place of `pi --mode rpc`.
The key is no longer file-only: dashboard Settings → *Parent and operator models* → **Parent CLI** (`models.parent_driver`)
writes it through the audited settings path, and a hand edit still works. With native picked, the parent model picker
lists only Anthropic Claude models and its thinking picker only the Claude effort levels (`off` plus `NATIVE_EFFORTS`).
A write pairing `claude` with any other model, or with `minimal`, is refused 400 before anything is written (the
`NativeDriverError` rule). The switch applies at the next parent start: the answer carries `restart: "parent"`, and the
page offers the drain-gated parent restart (`POST /api/parent/restart`). Saving never restarts the parent on its own.
The bridge, its outboxes and the pi RPC lines are unchanged. The entry runs `extensions/command-post` on a headless host
(`claude-parent-session.ts`), so startup, shutdown, wake-ups and the `tool_call` guards are the pi parent's own code.
The entry keeps its argv, prompt and mount. The turn engine (queue, steer, compact, rotate, RPC commands) is
`startClaudeSession` in `claude-session-engine.ts`, and the host's optional ports are for the Claude CLI operator. It
serves the 22 `cp_*` tools from an in-process MCP server `cp`, prefixed `mcp__cp__` for the model and unprefixed in
events. Each turn is one Agent SDK `query()` that resumes the claude session id kept in the session record. The record
(`sessions/cp-parent.jsonl`) also logs every operator text as it enters the model's input, and that log is what
`get_entries` serves. Wake-ups reach the model behind a `[fleet wake-up <type> — …]` line, so a resumed session can still
tell them from operator sends. A send that arrives while a turn runs is queued to the next turn (no mid-turn steer).
The dashboard's parent view reads a pi-format log beside the record, `sessions/native-parent-log/<record name>`
(`claude-parent-log.ts`, 0600, 64 KiB block cap): operator texts as user messages, wake-ups as custom messages,
assistant text, thinking, tool calls with their results, entry-side errors and compactions, appended as they land. The
viewer switches to it only when the control file's `sessionFile` opens with the native `record` line; `get_entries`
and a relaunch still read the record. A record with no log yet imports its claude sessions once from the CLI's
`native-parent-claude/config/projects/*/<session_id>.jsonl`; a rotation starts a new record and so a new log.
`compact`, `new_session`, `set_model` and `set_thinking_level` run between turns (a `/compact` with the extension's
instructions, a new record, the next turn's `--model` or effort); `get_commands` lists the registered commands the
entry runs. Any other RPC command is refused by name.

Ledger ids are generated (`cp-xxxx`), on this parent as on pi: a job is dispatched by the id `cp_job create` returned,
never under a name the parent picks (POC gap 11).

## Claude CLI operator (O2)

`data/operator.json` `driver: "claude"` (default `pi`; Settings **Operator CLI** since O3, below) makes `runOperator`
(`src/viewer/operator.ts`) start `src/drivers/claude-operator.ts` in place of `pi`. The pair must name an explicit
`anthropic/claude-…` model (`operatorDriverSetting`, `nativeOperatorSpawn`); anything else refuses the launch by name.
An absent file or `driver: "pi"` keeps today's argv. A `--session` resumes only a `native-operator-*` record. `-c`/`--continue` (dashboard Resume last session) resumes the newest recorded operator session when it is a `native-operator-*` record that still exists, else starts a new one with a stderr line.

The entry mounts `extensions/cp-bridge` on the same headless host and turn engine as the native parent, so the
dashboard control, relay outbox, ask and header guards, `cp_parent` (with `model_pick`) and image sends are the pi
operator's own code. The bridge's tools reach the model as `mcp__cp__*`; its built-ins are Bash, Read, Write, Edit, Grep
and Glob (plus web and the user's MCP servers since O4, below), and Agent and Task are disallowed. Each built-in passes `operatorToolRefusal` (the pi
operator's write scope, CI-wait and sleep-loop refusals), then a secret-path refusal for the Claude settings file, the
record's `native-operator-claude/` config dir, `/proc` and `/dev/fd`. Bash checks literal paths and lexed words (best
effort past `$`). The engine registers a Stop hook that runs `agent_before_settle`, so a prose question with no
`cp_parent ask` gets one continuation, then a card. Headless, the bridge's notices go to stderr, never an RPC stdout.

The Bash child keeps the real `HOME` (D3): one strace'd `claude` run with a picp `CLAUDE_CONFIG_DIR` opened nothing
under `~/.claude` except a missing `state/unattended-serving-consent.json` (ENOENT). Beside the allow-listed child env
it keeps `USER`, `PI_HOME`, `CP_HOME`, `PI_CODING_AGENT_DIR`, `SSH_AUTH_SOCK`, `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL`.

The record is `sessions/operator/native-operator-<ms>.jsonl`; its pi-format log, `native-parent-log/<record name>` beside
it, carries each reply's usage and model. The viewer's operator transcript and context ring read that log
(`sessionLogFile`). Tests: `tests/e2e/native-operator.test.ts` NO-1…NO-6, each guard with an allow-all negative control.

## Claude CLI operator lifecycle and Settings (O3)

Dashboard Settings → *Parent and operator models* → **Operator CLI** (`models.operator_driver`, options "pi" / "Claude
CLI") writes `data/operator.json` `driver` through the audited settings path, mirroring Parent CLI: with the Claude CLI
picked the operator model and thinking pickers narrow to Anthropic Claude models and the Claude efforts, and a write
pairing `claude` with any other model (the file's, else `CP_OPERATOR_MODEL`), with no model at all, or with `minimal`
is refused 400 before anything is written, so Restart session never starts an operator that cannot launch; the snapshot
reads such a file as refused. A saved change answers `restart: "operator"`; the page then offers Restart session and
never restarts on its own. Restore deletes the key (pi).

The launcher reads `driver` on every spawn. A restart marker records the `driver` of the session it names
(`native-operator-*` records are `claude`, anything else `pi`; a marker without the field is `pi`). When it differs from
the driver starting now, the relaunch has no resume flag: a clean session, logged as `driver changed (… → …)`. Otherwise
Restart session resumes the same record and claude session id, and Restart clean starts a new record.

`self_compact`, threshold compaction and the N5 streak compaction call the host's `compact` port, which runs the CLI's
own `/compact <instructions>` between turns. Settings model and thinking changes use `setModel` / `setThinking`, applied
to the next turn's `--model` and effort; each lands in `state/model-apply.jsonl` as on pi.

**U3: the compaction threshold.** With `driver: "claude"` and no valid `compact_at_tokens` the threshold defaults to
150000 (`NATIVE_OPERATOR_COMPACT_DEFAULT_TOKENS`); pi stays at 200000. Source: a `claude` 2.1.322 run against the mock
provider reported `getContextUsage()` `maxTokens` 1000000 and `autoCompactThreshold` 967000 for `claude-opus-5-5` (the
pi-ai catalog's context window is 1000000 too), and the Agent SDK documents a 200K compaction-policy boundary on 1M-window
models. 150000 sits under both, so the operator's own handoff compaction runs before the CLI's. Restoring the key under
the Claude CLI plans and reads back 150000. Tests: `tests/e2e/native-operator.test.ts` NO-7…NO-9 and
`tests/e2e/settings-drivers.test.ts` NO-10 and the two Operator CLI cases after it.

The engine reports idle while `agent_settled` handlers run, as pi does, so a Settings change that arrived mid-turn
applies at that settle (before O4 it was queued and never applied: every settle still read busy).

## Claude CLI operator tool parity (O4)

- **MCP servers.** The entry reads `<agent dir>/mcp.json` (`readUserMcpServers`, the file pi's builtin:mcp reads) and
  passes each enabled stdio or HTTP server as an SDK `mcpServers` entry beside `cp` (`claudeMcpServers`,
  `src/worker-mcp.ts`). Values in `env` and `headers` resolve `$NAME` / `${NAME}` from the launcher's env as pi does,
  because the CLI child gets only the allow-listed env. pi-only keys (`exposure`, `toolExposure`, `enabled`,
  `description`, `timeout`, `oauth`) are dropped. Skipped, one stderr line each: `enabled: false`, server-wide `hidden`,
  a server named `cp`, `cwd` or `auth` (no Claude CLI equivalent), a `!command` value, an unset variable. A tool that
  pi's `toolExposure` hides stays listed but its call is refused. With a server loaded, ToolSearch,
  ListMcpResourcesTool and ReadMcpResourceTool join the built-ins (pi's tool search and resource tools). Codemode has
  no equivalent. The system prompt lists the servers with their `description`.
- **Web (D4).** WebSearch and WebFetch are built-ins with no guard, as pi-web-access has none on the operator. Not
  covered: `get_search_content` (stored full results), `source_check`, `fetch_content`'s modes and video/repo
  handling, and the provider choice in `web-search.json`.
- **Skills.** The launcher passes `operatorSkillPaths` as `--skill`. The entry formats them with pi's own `loadSkills`
  / `formatSkillsForPrompt` (name, description, `SKILL.md` path) into the system prompt, and the model Reads one on
  demand, as pi's progressive disclosure does.
- **Lockdown.** Every query's `system/init` goes through `lockdownVerdict` (`checkSurface`, shared with the workers),
  with `cp` as picp's server, the user's servers and their `mcp__<server>__*` tools allowed, and the web, ToolSearch
  and resource tools allowed to be absent. Every PreToolUse waits on the verdict. A refusal (counts only) denies every
  call, aborts the query and ends the turn on that text.
- **Doctor.** `mcp.operator` says `operator session: driver claude: servers from <path>, no codemode` when
  `data/operator.json` runs the Claude CLI.
- **MCP OAuth.** pi keeps MCP OAuth tokens in `<agent dir>/mcp-auth.json`. The Claude CLI keeps its own under
  `CLAUDE_CONFIG_DIR`: here `sessions/operator/native-operator-claude/config`, which the operator's guards refuse to
  touch. An HTTP server that signs in with OAuth (no `Authorization` header) has to be signed in again there. A headless
  session has no `/mcp` login, so until that is done the server shows as needing auth and its tools are absent.

Tests: `tests/e2e/native-operator.test.ts` NO-11 (stdio server offered as `mcp__probe__*`, `enabled: false` never
started, a hidden tool refused) and NO-12 (an extra init plugin refused, with a negative control). fake-claude runs
`--mcp-config` stdio servers and answers the hook listing.

## Worker tool parity (WP0–WP7)

The Claude CLI workers are moving to the pi workers' tools, role by role, under pi's worker guards and the operator's
floors (secret paths, worktree write scope, `exclude_paths`, no push outside the job branch). Recovery for any step:
switch `claude_ship` / `claude_research` off (new jobs route to pi at once), or revert the PR.

### WP0 harness and guard baseline

Native workers now run in CI without an installed `claude`. `tests/harness/native-worker.ts` dispatches through the
real `cp_dispatch` of a pi parent on the mock model, with `tests/fixtures/fake-claude.ts` as `claude`
(`CP_E2E_REAL_CLAUDE=1` uses the installed CLI). fake-claude now also runs Edit, Grep and Glob, logs each spawn's env
key names (never values) in `spawns.jsonl`, and answers `initialize` with `hook_on_failure_supported`, which the SDK
requires before it sends the prompt of a query whose hook is `onFailure: "block"` (the workers'). No production code
changed. `tests/e2e/native-worker-parity.test.ts` NP-0a…NP-0e pin the guards every later step must keep: secret
paths and env dumps, writes outside the worktree or into `.git`, `exclude_paths` on Edit/Write, and pushes outside
`refs/heads/<job>`.

### WP1 forge reads

`gh_read` (`src/drivers/claude-forge-tools.ts`) now takes `verb` `pr view|list|diff|checks`, `issue view|list`,
`run view|list`, `release view|list`, `repo view` or `api`, with `number`, `run_id`, `log_failed`, `path` (`api`
only) and up to 20 read `args`. It always runs in the job's worktree with `GH_REPO` dropped, so gh reads the repo it
resolves there (the job's origin); `pr view|checks|diff` without a number still read this job's PR or branch. Refused
before `gh` runs, by name: `-X`/`--method`, `-f`/`-F`/`--field`/`--raw-field`, `--input`, `-H`/`--header`,
`--hostname`, `-R`/`--repo`, `-w`/`--web`, `--watch` (short letters also inside a bundle such as `-iXPOST`); any
positional in `args` but a `release view` tag (so `repo view other/x` is refused); a `--search`/`-S` value with a
`repo:`/`org:`/`user:`/`owner:` qualifier; and an `api` path that is graphql, a URL, a flag, holds a `..` or encoded
separator, or is not `repos/<owner>/<repo>/...`. A literal owner/repo must equal the job's origin, read once per
worker from the worktree's `origin` GitHub URL (for a non-GitHub URL, from `gh repo view --json nameWithOwner`); gh's
`{owner}/{repo}` placeholders need no lookup. The refusal names the path. Output stays
token-redacted and capped, and `pr checks`, `run list` and a status `run view` share the one CI status snapshot.
Planners now get `gh_read` too (`roleForgeTools`; the lockdown expects it); no other forge tool, so forge writes stay
off (U1). Bash `gh` is refused for both roles with a remedy naming `gh_read`. `tests/e2e/native-worker-parity.test.ts`
NP-1a (reads reach a planner and an implementer) and NP-1b (every write shape and every other repo refused; gh ran
only the repo lookup) pin it.

Follow-up (in WP2): a GitHub origin URL now pins `GH_REPO` for every `gh_read`, so neither an `upstream` remote nor
`gh repo set-default` can change the base repo gh resolves (a non-GitHub origin keeps `GH_REPO` dropped). `pr view|list`
with `statusCheckRollup` in `args` and an `api` path under `actions/runs` (not its logs), `check-runs`, `check-suites`
or `commits/<ref>/status(es)` now count toward the one CI status snapshot too; NP-1c pins a second read through
these routes being refused before gh runs.

### WP2 Bash scope

`src/drivers/claude-bash-scope.ts` replaces both Claude-only allow-lists (`readOnlyBashRefusal`, `shipBashRefusal`;
`src/drivers/claude-ship-policy.ts` is gone) for planners and implementers alike. pi's pattern guards still run
first, in pi's order and wording. Then `nativeBashRefusal` refuses by shape, first hit wins, and lets everything else
run (test runners, `python3`, `node -e`, `npx`, `curl`, `$VAR`, globs, `cd`, heredocs, headless browsers):

1. Secrets: a secret path named anywhere in the command (a home's `.claude` via `~/`, `~user/` or `$HOME/`, never a
   repo-local `.claude/`; any `.claude` or `.config/claude` word once the cwd is unknown or outside the worktree,
   as after `cd ~user`) or as a path word (with `~`, a glob's literal prefix, and every
   match of an unquoted glob checked through its links, so a planted link is caught), and a `$NAME`/`${NAME}` whose
   name looks secret (`SECRET_ENV_NAME`) or starts `ANTHROPIC_`/`CLAUDE_`, or an indirect `${!…}`.
2. Env dumps: `env` with no command, `printenv` bare or of a secret name, bare `set`/`export`/`readonly`/`declare`/
   `typeset` (or with `-p`), `compgen -v|-e`, BSD `ps e`.
3. `gh` (remedy: `gh_read`; for an implementer also `pr_create`/`pr_edit`); `scp` and `rsync` (remedy: `cp`/`mv`);
   git `push|fetch|pull|remote|config|worktree|submodule|clone|send-pack|http-push|receive-pack|upload-pack` (remedy:
   `git_push`, `git_fetch` then `git merge`); git run outside the worktree (`-C`, `--git-dir`, `--work-tree`, `GIT_DIR=`,
   a tracked `cd`); `-c alias.*`, `--config-env alias.*` and any `GIT_CONFIG*` assignment or export; `HOME=`/
   `XDG_CONFIG_HOME=` on git, exported, or handed to a git inside `sh -c`, `eval`, `env -S` or `find -exec` (WP3); a second branch (`switch`/`checkout` to
   another branch, `-b`/`-c`, `branch <new>`); and for a planner any repo-changing verb (`add`, `commit`, `merge`,
   `reset`, `restore`, `checkout`, `stash`, `rm`, `init`, …).
4. Write destinations: redirect targets and the destinations of `cp`/`mv`/`install`/`ln`, `rm`/`mkdir`/`touch`/`tee`/
   `chmod`/…, `dd of=`, `sed -i`/`perl -i`, `sort -o`, `curl -o`, `wget -O`, `chromium --screenshot=`, `find -delete`/
   `-fprint`, `tar -C`, `unzip -d`, git `restore`/`checkout --`/`rm`/`mv` paths and `--output`. Each must land in a
   root: an implementer's worktree (realpath, outside `.git` and its `exclude_paths`, a directory named by an excluded
   `dir/` counting as inside it; the root itself only for `git restore .`/`git checkout -- .` with no source rev, since
   `git checkout <rev> -- .` could rewrite excluded paths), the artifact dir, the scratch `TMPDIR` (`$TMPDIR/…`
   resolves), or `/tmp` outside the worktree's lease dir, the clone, the scratch dir and picp's run and artifact dirs.
   A destination the shell expands later (`$`, a glob, `~`, braces) or relative after a `cd` it cannot follow is
   refused.

The lexer (`src/drivers/claude-bash-lex.ts`) quotes like the shell, blanks quoted heredoc bodies (an unquoted body's `$(…)` is still scanned), re-scans
`$(…)`, backticks, `<(…)`, `sh|bash -c`, `eval`, `env -S` and `find -exec` (three levels at most), and looks through
`env`, `command`, `xargs`, `timeout`, `nohup`, `nice` and similar wrappers; it tracks `cd` along `&&` chains and
restores it after a `( … )` subshell. Refusals read `Refused: a native <planner|implementer>'s Bash <cause> is denied;
<remedy>. pi's guards and these scope checks are the only limits; everything else runs.` The CLI child also gets
`GIT_SSH_COMMAND=false`. The addenda now say Bash runs any command under pi's guards and writes only in the role's roots.

Residuals, named: (r1) the scope is lexical, so `node -e`, `python3 -c`, a repo script or a program that writes on its
own (`npm install`, `tar -x`, a browser without `=path`) can write anywhere the OS user can and read the settings env,
as on pi; a planner's teardown gate still needs a clean tree. (r2) A credential-free local-path origin would accept a
push made by such an interpreter (production origins need credentials the child lacks). (r3) An unencrypted key under
the passwd home stays usable by OpenSSH, mitigated by `GIT_SSH_COMMAND=false` unless an interpreter overrides it.
(r4) A glob's matches are checked at decision time; a link planted between the check and the run is not.
`tests/e2e/native-worker-parity.test.ts` NP-2a…NP-2g pin it at the consumer; `tests/claude-ship-policy.test.ts` keeps
the adversarial lexer table.

### WP3 child env

The CLI child of a native worker now gets, beyond `buildChildEnv`'s allow-list, what a pi worker's Bash relies on
(`nativeWorkerChildEnv` in `src/drivers/claude-roles.ts`, passed as `SpikeRunOptions.childEnv`): pi's
`NONINTERACTIVE_WORKER_ENV` (`GIT_EDITOR`, `PAGER`, `GIT_TERMINAL_PROMPT=0`, …); the job identity `CP_JOB_ID`,
`CP_KIND`, `CP_DELIVERY`, `CP_ROLE`, `CP_WORKTREE`, `CP_ARTIFACT_PATH`, `CP_BASE_BRANCH` when set; and the host's
`PLAYWRIGHT_BROWSERS_PATH`, `PUPPETEER_CACHE_DIR`, `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE` and the six `HTTP(S)_PROXY`/`NO_PROXY` spellings when set. `PLAYWRIGHT_BROWSERS_PATH` defaults to
`<passwd home>/.cache/ms-playwright` when unset and that dir exists, since the child's `HOME` is scratch. Never
`CP_HOME`, `CP_RUN_DIR`, `GH_*`, `SSH_AUTH_SOCK` (the `ops` profile alone gets it, WP7) or a secret-named key; a
proxy value containing `@` (embedded credentials) is dropped, with one stderr line naming the keys, never the value.
A CA override lets the child trust a custom CA, as pi's workers already do. `tests/e2e/native-worker-parity.test.ts`
NP-3a pins it through the spawned env key names and the child's own output. NP-1a now also pins `GH_REPO`: with a
GitHub origin, an `upstream` remote and gh's set-default on that upstream, every `gh_read` runs with the origin's
repo. Rollback: revert (the child is back to the allow-list).

### WP4 web tools (planner role)

A native planner-role worker (profiles `planner` and `qa`, any profile whose packages activate `pi-web-access`) gets the
CLI's `WebSearch` and `WebFetch`; implementers and reviewers keep them disallowed. The dispatch sets `CP_NATIVE_WEB=1`
(`nativeSpawnOptions`, from `activatedPackageNames`) and the research addendum names both tools. Each call passes pi's
`webEgressRefusal` in the worker process, as `fetch_content {url, prompt}` / `web_search {query, …}`, with the
worker's env: no `.pi-command-post`, job path, secret value or credential shape leaves the host. `WebFetch` processes
pages with the CLI's own model (pi refuses that `answer` mode). Whether the CLI loads the web tools under the scratch
config is unknown (K1), so the lockdown declares them optional: present or absent, it passes; any other extra still
refuses. `tests/e2e/native-worker-tools.test.ts` NP-4a…NP-4c pin a fetch and a search reaching the planner, egress
refusals leaving no request at a loopback web server, and web for the planner role only. Rollback: revert.

### WP5 user MCP servers (every role)

Every native worker (planner, implementer, gate reviewer) gets the operator's MCP servers from `<agent dir>/mcp.json`,
as pi's workers reach them through `mcp_call`. The worker process reads the file once (`claudeMcpServers`, the
operator's reader, with `picp` as the reserved name), passes each enabled stdio or HTTP server beside picp's own, and
appends the operator-style servers section to the system prompt; a skipped server (`picp`, `cwd`, `auth`, `!command`,
an unset `$VAR`) is one stderr line and a `native_mcp_skipped` run event, never a config value. `enabled: false`
servers never load; a tool `toolExposure`/`exposure` hides is refused by name in the PreToolUse hook; the others run
with no further tool guard, as `mcp_call` does on pi. `ToolSearch`, `ListMcpResourcesTool` and `ReadMcpResourceTool`
join when any server loads. The lockdown declares the user servers and those helpers optional: any other server, tool
or plugin still refuses the run before a tool executes. User servers hold their own credentials and can act
externally, as on pi; OAuth HTTP servers have no sign-in under the scratch config (O4). `/doctor`'s `mcp.workers`
detail names the native path when a `data/native.json` switch is on. `tests/e2e/native-worker-tools.test.ts`
NP-5a…NP-5c pin every role reaching the servers, the reserved name, and the lockdown with web and MCP optional.
Recovery: switch `claude_ship` / `claude_research` off, remove the server from `mcp.json`, or revert.

### WP6 per-job skills

A job naming per-job skills (`cp_dispatch skills`) no longer routes to pi as `ineligible`. The native worker gets the
same brief note a pi worker gets (`skillsBriefNote`, `src/job-skills.ts`): each skill's resolved `SKILL.md` path and
"Read each SKILL.md before you start"; it Reads the file on demand. The note grants no tools, scope or authority, and
`MENTION_NEVER` refusals still apply at dispatch. `tests/e2e/native-routing.test.ts` J1 (the skills row routes
claude; since WP7 the ops row does too) and `tests/e2e/native-worker-tools.test.ts` NP-6a (the brief names the path
and the worker's Read returns the skill body) pin it. Rollback: revert (restores the selection refusal).

### WP7 ops profile

An `ops:<class>` job (profile `ops`, role planner) no longer routes to pi as `ineligible`. The dispatch sets
`CP_NATIVE_PROFILE=<profile name>` (`nativeSpawnOptions`, from the worker manager), and `nativeWorkerChildEnv` gives the
`ops` child alone the host's `SSH_AUTH_SOCK` (when set) and unsets `buildChildEnv`'s `GIT_SSH_COMMAND=false`; every
other profile keeps both as before. Every `ssh` is still appended to the job's `host-audit.jsonl` and a key or `*.pem`
read is still refused (`workerHostGuard`); the research write scope applies, so README and other repo writes stay
refused. The native Bash scope still refuses `scp` and `rsync`, so a native ops job copies with `ssh … > <artifact
dir>/…`. `tests/e2e/native-routing.test.ts` J1 (the ops row routes claude) and `tests/e2e/native-worker-tools.test.ts`
NP-7a (a stub `ssh` sees the agent, one audit row, the key read and README write refused; a plain planner beside it
gets no agent and keeps `GIT_SSH_COMMAND`) pin it. Recovery: revert (ops goes back to pi by the selection refusal).

## Codex CLI workers (C0–C8)

### C0 spike

`src/drivers/codex-spike.ts` (`runCodexSpike`) runs one planner turn on the user's installed `codex app-server`
(floor `0.170.0`, `src/drivers/codex-cli.ts`) over LF-framed JSON-RPC (`codex-rpc.ts`, types in `codex-protocol.ts`).
It is **unwired**: no production module imports it, no switch or rubric row selects codex, `data/*.json` is untouched.
A host without `codex` runs CX-0 on the fake (`tests/fixtures/fake-codex.ts`, `tests/harness/codex-mock.ts`).

Gates, each failing closed: the reduced surface (`SURFACE_FLAGS`) and a lockdown before any thread
(`codex-lockdown.ts`: Codex home, sign-in, exactly picp's trusted session-flag hook, no MCP server, only the pinned
`system` skills, then `untrusted` approvals, a `readOnly` sandbox read-back, the worktree as cwd and no instruction
source); picp's `PreToolUse` hook (`codex-hook.mjs`, `node:` imports only) asks a unix socket in the run's scratch
dir, where the worker runs `spikeGuards` plus `codexSecretGuard`; each allow leaves a ticket that the approval and
dynamic-tool handlers require; a hook that fails marks the run `hook_failed` and interrupts the turn. The hook is
trusted per run with a `-c hooks.state=…` flag whose key and hash come from a first `hooks/list` (no write to
`CODEX_HOME`). `report_result` is a dynamic tool with the reporter's validators. Usage is the latest cumulative total
minus a baseline (a resume's previous totals, else the CLI's replayed total), `cost_unknown` always. The outcome is
the protocol state: an exit without `turn/completed` is `stopped` whatever the code. Scratch (`HOME`, `TMPDIR`,
`hook.sock`) is a `mkdtemp` dir under the temp dir, removed when the run returns.

Kill-criteria verdicts (CI: `tests/e2e/codex-worker-spike.test.ts` on the fake; live:
`CP_LIVE_TESTS=1 npm run test:one -- tests/e2e/codex-worker-live-smoke.test.ts`, codex-cli 0.170.0, 2026-11-18):

| KC | Criterion | CI (fake) | Live |
|---|---|---|---|
| 1 | a forbidden action executes | held (CX-0b) | held (LS-3a: denied at the hook, file absent) |
| 2 | a hook crash, timeout or missing socket lets a tool run | held (CX-0c) | held by picp's approval decline and ticket (LS-3b) |
| 3 | the report tool accepts another job | held (CX-0a) | not run (no CLI part) |
| 4 | usage is double-counted across resume | held (CX-0f) | held (LS-3c) |
| 5 | a command process survives teardown | held (CX-0g, CX-0h, CX-0i, CX-0j) | fired in the first run; held under the scope (LS-3d stop, LS-3d2 driver SIGKILL, LS-3d3 own exit) |
| 6 | an extra loaded surface is not refused | held (CX-0d, CX-0e) | held (LS-3e: the operator's MCP server refused) |

Live answers: X1 the hook runs before the approval; X2 the hook's `tool_use_id` equals the approval `itemId` and the
tool `callId` (every ticket matched by id); X4 a hook that exits 1, stalls past its timeout or is killed reports
`hook/completed failed` and the CLI **fails open** (it still raises the approval and still calls the dynamic tool),
so picp's decline and ticket are the gate; X5 the `system` skills are `imagegen`, `openai-docs`, `review-agent`,
`skill-creator`, `skill-installer`, and no instruction source loaded in an empty worktree; X9 the hook reaches the
socket. **X8 (KC5):** an interrupted foreground `sleep` is listed by `thread/backgroundTerminals/list` with a
`processId` but no `osPid`; `…/terminate` answers `{terminated: true}`, yet the `codex-linux-sandbox` wrapper (its own
session) and its child outlive the stop and the app-server's exit. The CLI reports no pid that picp could kill.
Not run: X3 (the `picp_planner` permission profile; C0 runs `sandbox: "read-only"`, so the artifact is not writable
by the shell and the lexical Bash scope plus `codexSecretGuard` are the only bar on reading the Codex home), X6
beyond the read-back, X10.

**Containment (the KC5 answer).** Every `codex app-server`, the trust probe included, runs in its own systemd user
scope: `systemd-run --user --scope --collect --unit=picp-codex-<pid>-<rand>.scope -- node codex-contain.mjs <unit> --
codex app-server …` (`src/drivers/codex-containment.ts`). The leader refuses to start Codex unless `/proc/self/cgroup`
names its own scope and the scope has `cgroup.kill`. It reports the kill file on fd 3 and writes `1` to it when the
app-server exits, when fd 3 closes (the driver died, even by SIGKILL) or on a signal. The driver writes it too after a
stop or any exit. `spawnCodexRpc` sends no request before the scope reports in, so there is no uncontained path: no
`systemd-run` on PATH (`CodexSpikeError.cli` `containment`), no user manager, or a failed scope check refuses the run.
A PID namespace was probed first and does not nest: with `kernel.apparmor_restrict_unprivileged_userns=1`,
codex-linux-sandbox's bwrap cannot create its namespace inside `unshare --user --pid` or `bwrap --unshare-pid`. Inside
the scope, the sandbox still runs with writes denied. CI uses a boundary fake `systemd-run`
(`tests/fixtures/fake-systemd-run.ts`): membership is an inherited env marker, and a fake kernel kills members when
`cgroup.kill` reads `1`. fake-codex can omit `osPid` and answer `terminated: true` without killing, as 0.170.0 does.
Host need for C1: a running systemd user manager (lingering) for the picp user.

### C1a gate hardening

Still **unwired** (C1b wires research dispatch). The run core now closes the gaps the C1 plan measured, and moves the
guard chain to `src/drivers/native-guards.ts` (no Agent SDK, no `zod`; `claude-spike.ts` re-exports it; the
SDK-free ratchet in `tests/structure.test.ts` walks the run core's run-time imports). How picp starts an app-server
lives in `src/drivers/codex-launch.ts`; every app-server, the trust probe and the smoke's bare servers included, takes
its argv from there and runs in the systemd user scope.

- **Kernel profile (`picp_planner`).** `-c permissions.picp_planner={filesystem={…}}` with `-c
  default_permissions="picp_planner"`: `/` deny, `:minimal` read, the worktree, its git common dir and the codex
  release dir (two levels above the real `codex` binary, unless under `/usr` or `/opt`) read, the artifact dir and the
  scratch tmp write. `thread/start` sends no `sandbox`. The `/` deny is load-bearing: measured on 0.170.0, a command a
  user allow rule (`<CODEX_HOME>/rules/*.rules`) approves runs **unsandboxed** when the profile has no deny entry
  (it read a file outside the worktree with a killed hook), and inside the sandbox when it has one. This corrects the
  plan's E12/E13 reading. The app-server cannot turn rules off (`--ignore-rules` exits 2) and no feature does.
  A release dir that is or holds `$HOME`, the passwd home or `CODEX_HOME` would open them to every command, so
  `codexReleaseDir` throws and the run never starts (CX-1k).
- **Surface.** `SURFACE_FLAGS` also disable `view_image`, `goals`, `sleep_tool` and `unified_exec_tty`. The lockdown
  reads every page of `experimentalFeature/list` (those nine features off, `hooks` on) and `config/read`
  (`web_search` `disabled` from `sessionFlags`, D4) before any thread, and after `thread/start` requires
  `activePermissionProfile.id` `picp_planner`, a `workspaceWrite` sandbox whose writable roots are exactly the two
  picp passed, no network, `excludeSlashTmp`, approvals routed to `user`, and `untrusted`.
- **Working directory.** The hook verdict and the approval deny a call whose `cwd` is not the worktree (a model
  `workdir` moves it, E10).
- **A dead hook kills the run.** A `hook/completed` that is not `completed`, `blocked` or `running` writes
  `cgroup.kill` (no `turn/interrupt`); the outcome is `stopped`, `hookFailed`.
- **Tripwire.** A `commandExecution` that got a process or ended without picp's accept (0.170.0 announces it
  `inProgress` with no process before it asks), a `fileChange` not declined, an `imageView`, `subAgentActivity`,
  `collabAgentToolCall`, `mcpToolCall`, `webSearch`, `imageGeneration` or `sleep` item, or a `thread/started` for
  another thread kills the scope: `bypass: <type>`, outcome `stopped`. A home with allow rules therefore fails each
  run at its first rule-approved command, by name. It keys on the item id; LS-4o-I runs `runCodexSpike` itself on
  the real CLI (mock model, a synthetic API-key login in a throwaway Codex home) and shows the hook's `tool_use_id`,
  the approval `itemId` and the tool `callId` are one id: a hook denial and an accepted command end `completed`, no
  bypass, every ticket matched by id.
- **`fileChange` order:** measured and fixed in C1b; see [C1b research wiring](#c1b-research-wiring).
- `onTool` reports each shell and dynamic tool call once per phase, for C1b's worker.

Kill-criteria verdicts (CI: `tests/e2e/codex-worker-spike.test.ts`; real CLI: `CP_LIVE_TESTS=1
XDG_RUNTIME_DIR=/run/user/$UID npm run test:one -- tests/e2e/codex-worker-live-smoke.test.ts`, codex-cli 0.170.0,
2026-11-18; LS-4o runs the real CLI on a loopback mock model, `tests/harness/codex-mock-provider.ts`, with a throwaway
Codex home, zero tokens):

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes | held (CX-0b; CX-1d: a `workdir` outside is denied at the hook) | held (LS-4o-W: an accepted outside `workdir` cannot read its file) |
| 2 | a hook crash, timeout or missing socket lets a tool have an effect | held (CX-0c, now `stopped`; CX-1g: allow rule plus killed hook, the outside read is refused and the run killed; CX-1h: an unasked command kills the run) | held (LS-4o-R offline: rule-approved read with a killed hook fails, 0 approvals; LS-4 live, one turn: killed hook, approval accepted, the sandbox refused the read; LS-4o-I: a hook denial through `runCodexSpike` is no bypass) |
| 2 (R2) | a sub-agent acts outside the profile or survives the kill | not modelled (fake-codex has no sub-agents) | held (LS-4o-V2 offline: on `gpt-6.2-sol` with every call allowed, the spawned sub-agent's outside read fails in the same profile, and after the scope kill pgrep finds 0 sleeps, sandboxes or app-servers) |
| 6 | an extra loaded surface is not refused | held (CX-1d: an enabled `view_image`, a differing profile read-back, `web_search` live) | held (LS-4o-V/S: lockdown `ok` on real read-backs, no `view_image` or web-search tool offered; LS-4o-T: tty refused) |

Negative controls run once and restored: without the `/` deny CX-1g fails on `executed.jsonl` and LS-4o-R on the
sentinel reaching the model; with `codex-spike.ts` importing `claude-spike.ts` the ratchet names that edge.
**R1 (C1 accepted it for research, es-781b5e; re-decided for C7 by the main session, es-ee4de5).** With a dead hook, a
command a user allow rule covers still starts with no approval. For a planner it stays inside `picp_planner`: it reads
only the worktree, its git dir and system paths, writes only the artifact dir and scratch tmp, has no network, and the
tripwire kills the run. For a write-capable job es-ee4de5 accepts the kernel-bound CLI shell under `picp_implementer`
as an **equal bound on effect** to the picp-served shell: with a dead hook the one unasked command can only write
non-excluded files of the job's own worktree; it cannot commit, push, touch `.git`, git config, hooks, an existing
excluded path, anything outside the worktree, or the network, and the job is killed and fails by name (probes PA, PB,
PC; LS-9o-P, LS-9o-R). That residual is RR1 ([C7a](#c7a-ship-job-groundwork-unwired)). Conditions: **C1** a
`cp_revive` or continue of a codex implementer whose last stop was `lockdown`/`hook_failed` surfaces the uncommitted
worktree changes by path before it relaunches, with a test (CX-7c, C7b); a `hook_failed` run's dirt is never
committed silently. **C2** LS-9o-R and LS-7o-D are the proof: if either shows any effect beyond one in-worktree write
(KC2), C7 stops and R1 flips to the picp-served shell (`--disable shell_tool` plus a picp `bash` dynamic tool run
through `codex sandbox`), never a repair around it. **C3** worker-side git for a codex job passes
`-c core.hooksPath=/dev/null -c core.fsmonitor=false` (`GIT_HOOKS_OFF`, `src/drivers/native-forge.ts`).

**R2 (accepted on its LS-4o-V2 condition).** `gpt-6.2-sol` still offers `spawn_agent` (LS-4o-V); a healthy hook blocks
it (E6) and the tripwire kills on its first `subAgentActivity` item. LS-4o-V2 shows the sub-agent's own commands run
under the same profile and die with the scope. `agents.max_threads=1`, the lowest value 0.170.0 accepts (0 is
rejected), does not stop the spawn (LS-4o-V2's second pass), so picp does not set it; that pass says so if a later CLI
honours it. A sub-agent acting outside the profile or surviving the kill fires KC2.
U1 (LS-4, live): the operator's home asked an approval for `cat`, so no allow rule covered it. U5 noted: LS-4 prints
counts and statuses only, never URLs or config values.
Known limits of the C1 planner: no network; it reads only the worktree, its git dir and system paths, so a brief
pointing at another job's artifact or a tool under the home cannot be followed. Recovery: revert; nothing selects it.

### C1b research wiring

C1b wires the run core to `cp_dispatch` for research only, behind switches that ship **off**. A `kind:research` job
with role planner and delivery `local` or `answer`, dispatched with `driver: "codex"` (or matched by a rubric row naming
it) and an explicit `openai/gpt-…` model, runs `src/drivers/codex-worker.ts`, a pi-RPC child like `claude-worker.ts`.
Every other role, kind and delivery stays on pi. No `data/*.json` or `defaults/routing*.json` was edited.

**Switches (`data/native.json`).** `codex_research`, `codex_ship`, `codex_review` (booleans, default off) and
`codex_max_concurrent` (1-4, default 1, counted apart from Claude's `max_concurrent`). `codex_research`, (C6)
`codex_review` and (C7b) `codex_ship` select. Since C8, Settings → Native workers sets the three switches (on writes
`true`, off deletes the key); it never sets `codex_max_concurrent` and never writes a codex row.

**Selection** (`codexSelectionRefusal` in `src/drivers/codex.ts`), each a named refusal before any lease, in order:

| Check | Category |
|---|---|
| `data/native.json` unreadable | `switch` |
| neither planner research nor a gate reviewer | `ineligible` |
| the class's switch off (`codex_research`, or C6 `codex_review`) | `switch` |
| delivery not `local` or `answer` (research only) | `ineligible` |
| profile `ops` (C5: the Codex shell has no network and no ssh agent) | `ineligible` |
| `codex_max_concurrent` live codex jobs | `occupied` |
| no `systemd-run`, or a malformed `CP_WORKER_MEMORY_MAX` | `containment` |
| `codex` missing or below `0.170.0` | `cli_missing` / `cli_version` |
| `codex login status` not 0 (HOME `/nonexistent`, only `CODEX_HOME` is read) | `auth` |

An explicit `driver: "codex"` is strict and refuses by name; a row's `codex` is a preference that falls back to pi
with a `driver_reason`, and with `requested_driver: "codex"` only while `codex_research` is on (CX-off-2). A started job keeps its driver: `pi` or `claude` on a codex job
refuses naming the lock. A codex row's model must match `openai/gpt-…` (checked in the resolver and in a Settings rubric
write; programme D1: never a vendor check); its effort is `low`…`max` (`off` and `minimal` refuse). The home's `allow`
and `deny_by_role` still apply. Per-driver specs live in `src/drivers/registry.ts`.

**Lifecycle.**

| Step | What happens |
|---|---|
| spawn | `codexSpawnOptions`: the role contract plus the Codex addendum in `<run dir>/codex-system-prompt.md` (0600); env `CP_CODEX_MODEL`, `CP_CODEX_HOME`, `CP_CODEX_MEMORY_MAX` when the parent has `CP_WORKER_MEMORY_MAX` |
| turn | one `runCodexSpike` run per turn, 24 h run timeout (the parent's bounds decide); `<run dir>/native-codex` (0600) records `scratch_dir`, `cwd`, `codex_home`, `totals` (C2), then `thread_id` at the first `turn/started`; every later turn resumes that thread (C2 below) |
| events | `tool_execution_start`/`_end` per call (blocked calls included), `turn_end` per agent message, unlogged `message_update` per token update, one `message_end` at cost 0 with `cost_unknown`, one `native_run` (`driver: "codex"`) |
| Log | `state/sessions/native/<job>.jsonl` (0600): prompt, agent messages, reasoning summaries, each tool call and result |
| end | a reported turn, or a clean `completed` one (C2), settles idle for settle.ts's nudge; a named stop or an unclean end exits 1 and fails on its observed exit |
| teardown | after the observed exit (or a gone pid): `native_thread_deleted` through one contained bare app-server (`codexBareArgs`, web search off, no hook; D5), then `native_scratch_removed`; a delete failure is named and never blocks the lease |

Named stops: a lockdown refusal, a dead hook, a bypass or a containment, CLI or release-dir refusal is `native_run.stop:
"lockdown"` (class `spawn_failed`); a sign-in refusal is `auth` (`model_call_failed`). Neither is nudged.

**Usage (D3).** Tokens come from the CLI's totals; the USD side is 0 with `cost_unknown` on the run status and
`/api/job/<id>`. The job page reads "unknown (tokens only)" (or `$x + unknown` for an estimated Claude run, which sets
the same flag). Fleet, board, stats and mandate USD sums count a codex job as $0.00, so token caps are the bound: the
per-job token budget and a grant's token cap (CX-1j: the turn's tokens pause the grant `token_cap` after the turn, the
running job still reports, the next dispatch refuses).

**Blocked calls (B13).** A hook-denied call gets no item from the CLI, so the run core fires its own
`onTool` start and end pair with the refusal as `output`: bounds count it and the Log shows it.

**`fileChange` order (carry-in 1).** Measured on codex-cli 0.170.0 with zero tokens (picp's `spawnCodexRpc`, the loopback
mock model, an empty throwaway `CODEX_HOME`, slug `gpt-6.2-sol`):

| # | Setup | Observed |
|---|---|---|
| F1 | hook allows `apply_patch`, picp declines | `hook/started`, `hook/completed completed`, `item/started fileChange inProgress`, the approval request (same id as the hook's `tool_use_id`), `item/completed declined`; file absent |
| F2 | hook denies | `hook/completed blocked`; no item, no approval; file absent |
| F3 | hook allows, no handler (`-32601`) | `inProgress`, then `declined`; file absent |
| F4 | a user allow rule for `apply_patch`, hook killed | the approval is still requested; `declined`; file absent |
| F5 | approval accepted | `completed`; the file is written in the worktree, the artifact dir **and a dir outside every profile root** |
| F6 | `apply_patch` heredoc through the shell | the hook names it `Bash` (refused by `shellPatchCommand`); the CLI raises a `fileChange` approval |
| F7 | a patch that fails verification | no item, no approval, nothing written; `failed` was never observed |

Tripwire rule: a `fileChange` kills the run only on an end other than `declined` (`completed`, or a `failed` apply picp
never accepted, Q1). An `inProgress` item is an announcement and no longer kills. picp answers every patch `decline`.
**F5 and F4 are inputs to the C7 re-decision:** the kernel profile does not confine an accepted patch, so C7 must not
accept one without its own bound.

**Follow-ups, revive and steer.** Open since C2: see [C2 follow-ups, revive and steer](#c2-follow-ups-revive-and-steer).

**Memory cap (B14).** A codex app-server's scope is a sibling of the worker's, so the worker's `MemoryMax` did not cover
it (E9). The parent's `CP_WORKER_MEMORY_MAX` now reaches every app-server scope as `-p MemoryMax=… -p MemorySwapMax=0`;
a malformed value refuses the run before any app-server (CX-1o).

**Shipped off: what an older build can still read (main-session condition 2).** While every codex switch is off, picp
writes no codex value anywhere: an explicit codex dispatch refuses before any lease, a queued or armed codex dispatch is
refused before it is written (`codexPersistRefusal`), and a Settings rubric write refuses a new or changed codex row.
So `fleet.json`, the dispatch queue, the armed dispatches, `data/routing.json` and `data/native.json` stay readable by a
build before C1b. The C1b T-row in `tests/e2e/codex-worker.test.ts` pins this with the switches off. A codex row the
operator writes by hand is itself a value an older build cannot read; picp did not write it. A job it routes runs pi and
records `driver: "pi"` and its `driver_reason` with no `requested_driver`, so `fleet.json` and the run log keep the old
shape (T-row CX-off-2). A Settings write that leaves such a row unchanged is not refused, a legacy-role row included
(SD-legacy in `tests/e2e/settings-drivers.test.ts`).

**Recovery for a home that turned codex on.** The supported rollback is the switch: set `codex_research` to `false`
(new jobs route to pi; a live codex job still tears down and deletes its thread). Before running a build older than
C1b: tear down every codex job (`cp_teardown`), remove the four `codex_*` keys from `data/native.json`, remove every
`driver: "codex"` from `data/routing.json`, drop any dispatch-queue or armed entry naming `codex`, and close or remove
fleet records whose `worker.driver` is `codex` or whose `routing` names `codex`; an older build refuses the whole file
otherwise.

**Known limits.** No network; reads only the worktree, its git dir and system paths, so a brief pointing at another
job's artifact or a tool under the home cannot be followed. Resume, revive and steer: see C2 below. A paused grant lets the running turn finish. R1 (a rule-approved command with a dead hook) and R2
stay as accepted for read-only research only; F5 and R1 are re-decided before C7.

**C7 carry-in list** (C5 added R3 on the main session's condition): R1, F5, Q2 (the freeze checkpoint's WIP commit
for codex; `checkpoint` stays refused until then), Q3 (a fresh thread for a moved worktree; the resume stays refused by
name until then) and R3 (MCP resource reads with a dead hook, C5 below). Each was re-decided before any write-capable
codex job: R1, F5 and R3 in [C7a](#c7a-ship-job-groundwork-unwired); Q2 and Q3 are built in
[C7b](#c7b-ship-jobs-wired-shipped-off) (for a ship implementer; research keeps both refusals).

Kill-criteria verdicts (CI: `tests/e2e/codex-worker.test.ts` and `tests/e2e/codex-worker-spike.test.ts` on the fake;
real CLI: `tests/e2e/codex-worker-live-smoke.test.ts` under `CP_LIVE_TESTS=1`):

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes | held (CX-1c through `cp_dispatch`; CX-1m: a declined patch is absent) | held (LS-4o-F pass 1: inProgress, then the approval, then `declined`, file absent; LS-5o-W: a hook-denied `touch` is absent on the worker entry) |
| 2 | a hook crash, timeout or missing socket lets a tool have an effect | held (CX-1g and CX-1h through `cp_dispatch`; CX-1m with a killed hook; CX-1n with a killed hook) | held (LS-4o-F pass 3: an `apply_patch` allow rule plus a killed hook still asked once, target outside the roots absent; LS-4o-R, LS-4o-V2 and LS-4 re-run held) |
| 3 | the report tool accepts another job | held (CX-1a) | none (no CLI part) |
| 5 | a command process survives teardown | held (CX-1f: worker SIGKILLed mid-turn; CX-1n) | held (LS-5o-V: 0 processes naming the worker's scratch root; LS-3d…3d3 re-run held) |
| 6 | an extra loaded surface is not refused | held (CX-1q: an enabled feature fails the dispatched job before any turn) | held (LS-5o-W: lockdown `ok` on the worker entry; LS-3e re-run refused the operator's surface) |

KC4 (usage counted once across a resume) is C2's: see the table below.
Real CLI run once on 2026-11-19 (`CP_LIVE_TESTS=1 XDG_RUNTIME_DIR=/run/user/$UID npm run test:one --
tests/e2e/codex-worker-live-smoke.test.ts`, codex-cli 0.170.0): all 19 cases passed, one pass each. LS-5o-V: the
spawn is denied at picp's hook (`collaborationspawn_agent`), no `subAgentActivity`, report accepted. LS-5 (one live
turn on the worker entry): 36,727 tokens at cost 0, the envelope filed; the first thread delete returned `deleted:
true`, a second `deleted: false` naming the CLI's "no rollout found" error.

### C2 follow-ups, revive and steer

C2 opens the doors C1b refused, still for planner research only and still behind `codex_research`. Each turn is one
`runCodexSpike`, so a resumed turn is one more trust probe and run through `spawnCodexRpc` (one contained scope each)
and the lockdown reads the resumed thread back; no app-server lives between turns, and an idle worker holds none.

| Door | What happens |
|---|---|
| `cp_send` idle (`auto` or `prompt`) | admission (`assertNativeResume`: drain and update hold, model, project, per-job budget, `codexSelectionRefusal`), then one new app-server with `thread/resume` on the recorded thread; `native` starts `resuming:` |
| `cp_send` busy, `follow_up` (or `prompt`) | appended to `native-followups.jsonl`; at the turn end the queue is claimed, admitted again and delivered as the next resumed turn; `native_followup_delivered`, or `native_followup_refused` with the claim returned; a claim settles only after its turn returned |
| `cp_send` busy, `steer` or `auto` (C2b) | `turn/steer` with the live turn id: the CLI's ack is receipt `delivered` with disposition `steered` and run event `native_steered`; `-32600` (no or another active turn) or no live turn queues as a follow-up (`queued`); once this busy period reported, a refused steer fails by name with nothing queued |
| `cp_send` steer after the report | refused by name: a steer never reopens a filed slot. `auto` resolves to `follow_up` instead, which reopens it (`envelope_superseded`) and queues a turn |
| settle nudge | a clean unreported turn (`completed`, lockdown ok, no error) settles; settle.ts's one nudge resumes the thread under the same admission (`ownPrompt`) |
| `cp_revive` / bounded recovery | the plain native revive: `nativeReviveRefusal` needs the record's `thread_id`, then `assertNativeResume`; the respawned worker resumes the thread with picp's revive prompt ("resumed its Codex CLI thread"). Bounded recovery refuses the named stops as for Claude |
| drain | a codex send while draining is refused as a Claude send is; there is no steer into a draining run |

Still refused: `checkpoint` (a research planner has nothing to commit; the WIP commit lands with C7, Q2), a resume
whose worktree moved ("its resume is refused: cp_teardown and dispatch again", Q3; research never re-leases), and a
revive of a record with no thread id (a run stopped before its first `turn/started`).

**Usage across resumes (KC4).** The session record's `totals` is the thread's cumulative total at the last counted run,
written as zero at a fresh session. Each resumed run passes it as the run core's `resume.baseline`, so its usage is the
growth over that total. The worker saves `totals` before it writes the turn's `message_end`, and updates a record that
already holds `totals` even while codex is off (C3, CX-3e); a crash between the two
leaves that run uncounted until the next resume counts it, and never counts it twice. A run with no measured usage saves
nothing, so the next run counts both. Live `message_update` is the same growth, skipped while the total has not grown.
Cost stays 0 with `cost_unknown` (D3).

**Shipped off (main-session condition 2, C2).** `totals` is a new-shape value: the worker writes it only while
job's class switch is on (`codexPersistRefusal`; `codex_research` for a planner, C8). With every codex switch off no codex job runs, so no session record
holds it; CX-off-2 asserts no `native-codex` record, no `totals` and no codex driver value in the fleet, run log, queue,
armed file or `native.json`. A session record without `totals` resumes on the CLI's replayed total.

**Recovery for a home that ran codex under C2.** As for C1b: switch `codex_research` off (new jobs route to pi; a live
codex job's resume, revive and queued follow-ups are refused by name, and it still tears down and deletes its thread),
or revert the PR. Before going back to a C1b build, tear down every codex job: a C1b build cannot read a `native-codex`
record holding `totals` (its schema has `additionalProperties: false`), and the record exists only in a home that
turned codex on.

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1, 2, 6 | forbidden action, dead hook, extra surface | held: CX-1c…1q unchanged; CX-2a asserts `lockdown: "ok"` on the resumed run | LS-3c runs the lockdown on a resumed thread (passed 2026-11-19) |
| 4 | usage double-counted across a resume | held: CX-2a and CX-2b, the status total equals the fake thread's own total | LS-3c (the run core's usage code is unchanged in C2) |
| 5 | a command process survives teardown | held: CX-1f (a pre-spent recovery attempt), CX-2c (parent close mid-turn: every pid gone, every scope killed or collected) | LS-6o-S ends through `scratch(t)`'s survivor count |

LS-6o-S, run once on 2026-11-19 (`CP_LIVE_TESTS=1 XDG_RUNTIME_DIR=/run/user/$UID npm run test:one --
--test-name-pattern='^LS-6o-S' tests/e2e/codex-worker-live-smoke.test.ts`, codex-cli 0.170.0, mock model, throwaway
Codex home): passed. A steer sent while the first model request was held 3 s was acked (`steered: true`) on the live
turn and its text reached the next model request (U1); lockdown `ok`, no bypass, outcome `completed`, no survivor. The
first answer's `exec_command` asked picp nothing (ticket matches 0), so the CLI did not run it; `-32600` on the real
CLI still rests on probe P4 and the fake (U2).

Cases: `tests/e2e/codex-worker-followups.test.ts` (CX-2a…2h), CX-2s in `tests/e2e/codex-worker-spike.test.ts`,
CX-off-2 in `tests/e2e/codex-worker.test.ts`, and the opt-in LS-6o-S in `tests/e2e/codex-worker-live-smoke.test.ts`.

### C3 usage and availability

C3 measures every codex turn and names the usage limit, still for planner research only and behind `codex_research`.

**Totals across a switch flip (KC4).** `totals` is first written only while `codex_research` is on; a record that already
holds it is updated by every counted run, the switch either way. Before C3 a turn that ended after the switch went off
left a stale baseline, and the next resume counted that turn again (1210 tokens against a thread total of 770; CX-3e).

**Every turn end is measured.** The run core's usage is the turn's latest cumulative total minus the baseline whatever
the turn's status, so a completed, failed or interrupted turn carries its tokens (CX-3a), a SIGKILLed turn is counted
once by the run that resumes it (CX-3b), and a run with no token update is `usage_unavailable`, never 0 (CX-3c).
`native_run` gains `turn_status` and `error_info`: the `codexErrorInfo` as a code (a string, or a one-key object's key),
never the CLI's message text. Cost stays 0 with `cost_unknown` (D3); there is no price table.

**The usage limit.** A turn the CLI fails with `codexErrorInfo: "usageLimitExceeded"` is the named stop `window`:
`native_run` carries `stop: "window"`, `window: "usage_limit"` and the reset, the worker exits 1, the failure class is
`provider_limit` with Codex wording, and bounded recovery never revives it (a named stop, `cp_revive` after the reset).
`rateLimitExceeded`, a 429 exhaustion and `unauthorized` mid-turn stay an unclean end (`crash`, one bounded revive): none
was observed on the real CLI and none carries a reset (Q2).

**The limit observation.** The run core merges each `account/rateLimits/updated` of the main allowance (a snapshot whose
`limitId` is another allowance is ignored; a null never clears an earlier value), from the run's own notifications only:
picp sends no `account/rateLimits/read`. After a run the worker relays `native_observation` `{kind: "limit", reached,
resets_at?}` when the turn failed on the usage limit or the merged snapshot carries a `rateLimitReachedType` (a turn
that still completed is no stop, but blocks the next selection), else `{kind: "turn_ok"}` after a clean turn. The reset
is the latest `resetsAt` (epoch seconds) of the windows at 100 % or more; none, or one without a reset, is "reset
unknown". Both rules follow T3's `codexUsageLimits.ts` at the pin (`mergeCodexRateLimits`, `codexUsageLimitResetAt`);
the code is picp's (`src/drivers/codex-observation.ts`). Codes, numbers and times only: no account, plan or percentage.

**The snapshot.** The parent observer routes a codex worker's observation to `state/native-availability-codex.json`
(`{version: 1, limit?: {reached, observed_at, resets_at?}}`, closed schema); the Claude snapshot's file, schema and
behaviour are unchanged. An older limit never replaces a newer one; `turn_ok` clears a limit observed before it whose
reset is unknown or has passed. `NativeDriverSpec.availability` is the driver's snapshot reader, so the resolver and the
resume admission read it for codex as they read S2 for Claude:

| Snapshot | New codex selection | Resume, revive, queued follow-up |
|---|---|---|
| no file, no limit, or a no-reset limit older than `data/native.json`'s mtime | allowed | allowed |
| a limit whose reset is ahead | a row falls back to pi with `window: usage limit reached until <iso>`; an explicit dispatch is refused by name | refused by name |
| a limit whose reset passed | attempted, with the note `usage limit unknown since its reset <iso>` | allowed |
| a no-reset limit newer than the switch file | `window: usage limit reached, reset unknown …` (as above) | refused by name |

A no-reset limit blocks until a completed codex turn or the switch file rewritten after it (off then on), as Claude's
no-reset window does; while it blocks no codex turn runs to clear it (U6). Deleting the file reads unknown again.

**The chat footer.** `/api/workspace/status` gains an optional `codex` item beside `claude` while any codex switch is on
(C8; `codex_research` alone before):
`Codex unknown` (no readable snapshot, a passed or voided limit), `Codex limited until HH:MMZ`, `Codex limited (reset
unknown)` or `Codex ok`, read with a contracts-free parse that accepts exactly what the snapshot schema accepts.

**Shipped off (C3).** With every codex switch off no codex job runs: no codex snapshot is written, the Claude snapshot is
not touched and no `native_observation` is relayed (CX-off-2). The codex snapshot is a new file a C2 build ignores, and
no contract schema changed. Recovery: switch `codex_research` off, delete `state/native-availability-codex.json`, or
revert the PR; no data migration.

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 4 | usage double-counted across a resume | held: CX-3e (off and on), CX-3b (killed turn), CX-2a and CX-2b unchanged | LS-3c (the usage arithmetic is unchanged in C3) |
| 1, 2, 5, 6 | forbidden action, dead hook, surviving process, extra surface | held: C3 edits no approval, tripwire, lockdown or stop-sequence code; CX-1 and CX-0 cases unchanged | unchanged |

Not observed on the real CLI (no live case): the shape of `account/rateLimits/updated` at a spent window (U1) and a turn
failed with `usageLimitExceeded` (U2); both rest on the 0.170.0 schema and T3's adapter. The steer handle and the run's
ready gate are cleared in a `finally` (CX-3f pins the handle's lifetime on every reachable end; no input throws between
the set and the clear today, so the `finally` is defence). Cases: `tests/e2e/codex-worker-usage.test.ts` (CX-3a…3e),
CX-3f in `tests/e2e/codex-worker-spike.test.ts`, S3-codex-line in `tests/e2e/viewer-full-match-status.test.ts`.

### C5 tool parity

C5 gives a Codex planner the four things a pi and a Claude CLI planner already have, still for planner research only
and behind `codex_research` (off). No `data/*.json` or `defaults/routing*.json` was edited.

| Item | What happens |
|---|---|
| `gh_read` | WP1's core moved to the SDK-free `src/drivers/native-gh-read.ts` (Claude's `forgeTools` keeps its `zod` shape and calls it). The run core declares `gh_read` beside `report_result` as a dynamic tool and serves it in the worker process with the worker's env; the hook's guard chain runs first and leaves a ticket, the handler refuses a call with none. Bash `gh` stays refused naming `gh_read` |
| MCP servers | the worker reads `<agent dir>/mcp.json` once (`codexMcpConfig`, `src/worker-mcp.ts`; values resolved from its env as pi does). Each enabled stdio or HTTP server goes into the thread `config` (`mcp_servers.<name>`) on `thread/start` and every `thread/resume` (P2: a resume without it has no server, M13), never on argv, an event or a log line. A disabled or server-hidden entry never loads; a name outside `[A-Za-z0-9_-]`, `auth`, `!command` or an unset `$VAR` is one stderr line and one `native_mcp_skipped` event. The system prompt gains the servers section |
| skills | the manager hands the per-job skill dirs to the spawn (`CP_CODEX_SKILL_DIRS`); each is a `read` root of the kernel profile. A dir that is or holds a home, the Codex home, the agent dir or the CP home refuses the run before any app-server |
| child env | the app-server gets `nativeWorkerChildEnv` with no profile (WP3: pi's non-interactive variables, the job identity, tool, CA and proxy names; never `CP_HOME`, `CP_RUN_DIR`, `GH_*`, `SSH_AUTH_SOCK` or a secret name; a credentialed proxy is one `native_env_dropped` event). The shell policy is `inherit="all"` with `exclude=["CODEX_*","OPENAI_*","INVOCATION_ID"]`: "all" of picp's own allow-list, which still throws on an `OPENAI_*`, `CODEX_*` (but `CODEX_HOME`) or secret-named key |

**The MCP gate.** Every server entry holds `default_tools_approval_mode: "prompt"`, so the CLI asks picp
(`mcpServer/elicitation/request`) before every tool call, a read-only-hinted one included (M8). picp's hook allows a
passed server's visible tool (as `mcp_call` runs unguarded on pi) and leaves a ticket of the tool name and its input;
the approval is `accept` only for a `mcp_tool_call` form of a passed server's visible tool whose ticket is open, else
`decline` (a server's own question included); never `content`, a persist choice or `cancel`. A hidden tool is refused
by name at the hook. Tripwire (P1): an `mcpToolCall` item the hook never allowed, or a tool call that completed with no
accepted approval, kills the run (`bypass: "mcpToolCall"`); once killed, no later call is allowed. Lockdown: the list
before any thread must still be empty; with a server passed the run reads every page of
`mcpServerStatus/list {threadId}` once per run (Q2, starting each stdio server one more time per turn) and refuses any
listed name it did not pass, and the `tool_call_mcp_elicitation` feature must read back on. A stdio server runs outside
the kernel profile with `HOME, LANG, PATH, TMPDIR` (the scratch `HOME`) plus its own `env` (M2), as under the Claude
CLI, and dies with the app-server's scope.

**R3, a C5 limit (accepted by the main session for read-only research only).** `list_mcp_resources`,
`list_mcp_resource_templates` and `read_mcp_resource` are built into the CLI whenever a server is loaded and ask no
approval; no feature or per-server setting removes them (M7, M8, M11). With a dead hook one such call can reach an
operator server before the scope kill. Bound: the MCP read verbs only (`resources/list`, `resources/templates/list`,
`resources/read`), on servers the operator enabled for workers; picp's healthy hook allows the same call with no guard,
so no decision is bypassed; a failed hook kills the run and the job fails by name (`hook_failed`, `stop: "lockdown"`).
R3 is on the C7 carry-in list, re-decided before any write-capable codex job.

**Known limits.** No hosted web search and no network for the shell (D4), so a planner profile with web on pi has none
here; the `ops` profile is `ineligible` (a codex row falls back to pi; an explicit codex dispatch refuses by name),
since the shell has no ssh agent. A server whose name the CLI spells differently in its tool names is not skipped:
`codexMcpConfig` (`src/worker-mcp.ts`) loads a hyphenated name, picp's route then does not recognise its tools and
refuses each call at the hook, so it fails closed (only a name outside `[A-Za-z0-9_-]` is skipped). A thread started before
C5 has no `gh_read` after a resume (dynamic tools are fixed at `thread/start`).

**Shipped off (C5).** C5 persists no new value: no session-record field, no contract schema, no golden change; with
every codex switch off no codex job runs (T-row and CX-off-2 unchanged). Recovery: switch `codex_research` off (new jobs
route to pi; a live codex job still tears down), remove the server from `mcp.json`, or revert the PR. No data migration.

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes | held: CX-5a (Bash `gh`, `-R`), CX-5b (hidden tool) | held (LS-7o-M, added in C7a) |
| 2 | a dead hook lets a tool have an effect | held: CX-5a job B (`gh_read`), CX-5c (MCP tools declined, no server call); R3 is the named residual | held (LS-7o-D, added in C7a: no tool call reached the server; the resource read ran, R3) |
| 5 | a process survives teardown | held: CX-5b (every started scope killed or collected) | M2 (cp-wh89 probes: the server is gone after the exit) |
| 6 | an extra loaded surface is not refused | held: CX-5f (a stray thread server), CX-0e unchanged | unchanged |

Cases: `tests/e2e/codex-worker-tools.test.ts` (CX-5a…5i, CX-5i the `ops` fallback). The opt-in live cases LS-7o-M and
LS-7o-D were added and run in C7a (see there); before that the real-CLI verdicts rested on the cp-wh89 offline probes.

### C6 reviewer

C6 runs a `gate-reviewer` on the Codex CLI behind `codex_review` (off). No `data/*.json` or `defaults/routing*.json`
was edited. `cp_review`, `cp_gate` and the quality panel resolve their reviewer through `resolveReviewerRoute`
(`src/reviewer-route.ts`); a `gate-reviewer` rubric row naming `driver: "codex"` and an explicit `openai/gpt-…` model
runs on Codex when `codex_review` is on and a codex slot is free (`codex_max_concurrent`, shared with research). In
every other case it runs the row's pi fallback, as a Claude row's reviewer does; the delivery check is research-only.

**Surface.** A reviewer's app-servers (trust probe and turn) get `SURFACE_FLAGS` plus `--disable shell_tool`, and the
lockdown requires `shell_tool` to read back off. The thread declares four dynamic tools, served in the worker process:
`report_verdict` (pi's handler through the SDK-free `src/drivers/native-verdict.ts`: lenient check, clamp,
`verdictChecks`, repair cap, write-once `verdict.json`) and `read`, `grep`, `find` (`src/drivers/native-packet-tools.ts`,
`node:` only). Their keys are the guard vocabulary's (`path`, `pattern`), so `reviewerReadGuard` runs at the hook and
again in the tool call, and each handler checks the realpath against the packet itself; a symlink is never followed,
and `grep` matches literal text, never a model-written regular expression. The guard chain is built with the
reviewer's role, so any Bash call is refused ("a reviewer has no Bash") and every patch is declined. The kernel profile
reads the packet and system paths and writes scratch tmp; it has no git dir and no artifact dir. No MCP server, no
`mcp.json` read, no skill dir, no `gh_read`, no network, no `ls`. `report_result` is "not in the tool set".

**Probes** (cp-6sq6, codex 0.170.0, mock model, zero tokens, picp's own `spawnCodexRpc` and profile, a throwaway
Codex home; no login checked):

| # | Setup | Observed |
|---|---|---|
| V0 | `codex features list` | `shell_tool`, `unified_exec` and `hooks` stable and on |
| V1 | default surface, the four dynamic tools | offered: `exec_command`, `write_stdin`, `request_user_input` and the four; the hook fires for `read` under its own name |
| V2 | `--disable shell_tool --disable unified_exec` | `shell_tool` reads back off; offered: `request_user_input` and the four; a model `exec_command` gets no hook, item or approval |
| V3 | `--disable shell_tool` only | as V2: this one flag is enough |
| V4 | `--disable unified_exec` only | nothing changes: the shell stays offered |
| V5 | `gpt-6.2-sol`, shell off | nested tools `apply_patch`, `clock__curr_time`, the MCP resource tools and the four; `exec_command` is not a function; `apply_patch` asks and is declined |
| V6 | a user allow rule for `cat`, a dead hook, shell off | `exec_command` is "unsupported call": no item, no approval, no command (with the shell on the rule-approved `cat` ran unasked) |
| V7 | `gpt-6.2-sol`, dead hook, shell off | `clock__curr_time` answered; `list_mcp_resources` an empty list as an `mcpToolCall` item (the tripwire kills on it); `apply_patch` declined |
| V8 | `gpt-6.2-sol`, `spawn_agent` let through, shell off | the sub-agent has `apply_patch`, `clock__curr_time` and the resource tools: no shell and no packet tool |

R1 does not arise for a reviewer (V6: no shell), and R3 does not either (no MCP server is passed). R2 holds for the
reviewer on its accepted condition: a healthy hook blocks `spawn_agent` and the tripwire kills on `subAgentActivity`;
with the shell off the sub-agent has no shell and no packet tool (V8). The dead-hook residual is the wall clock and an
empty resource list (V7). `request_user_input` stays offered; the hook refuses it.

**End of a review.** A reviewer has no fleet record and no teardown, so its worker ends its one busy period as teardown
ends a job: `deleteCodexThread` (one contained bare app-server, D5), then `removeNativeScratch`, as the run events
`native_thread_deleted` and `native_scratch_removed` in the review's run dir. Its transcript is
`<review run dir>/native-transcript.jsonl`; its `message_end` counts tokens at cost 0 with `cost_unknown` (D3).
`src/quality.ts` now re-routes a voter that lost a codex slot at spawn ("codex concurrency") to pi, as for Claude.

**Shipped off (C6).** No persisted shape, contract schema or golden changed; a reviewer writes codex values only while
`codex_review` is on, and with every switch off a codex reviews row runs pi with no codex value in any file (CX-6d).
Recovery: `codex_review` off or the row's `driver` removed (the next review routes pi; a running one finishes), or revert
the PR. No data migration. The flip, by hand: add the row, then turn on `codex_review`.

**Known limits.** No MCP server and no `ls`; a full codex slot runs pi; a reviewer's limit observation is not recorded
(as a Claude reviewer's is not); since C8 a Settings rubric write keys on the row's own class switch (`codex_review`
for `reviews`) and the footer's Codex item shows while any codex switch is on; a SIGKILLed
reviewer worker leaves its thread and scratch dir; a thread refused between `thread/start` and its first turn is not
deleted, as for the planner. (Until C8 a reviewer's `routing_resolved` event had no `driver`, `driver_reason` or
`requested_driver` field, only `driver=` in its line; C8 (i) adds them.)

**C8 carry-in list** (opened in C6, closed in C8): Q3, `codexPersistRefusal` keyed on `codex_research` alone, so with
only `codex_review` on a Settings rubric write that adds a codex row was refused naming `codex_research`, and a
reviewer's pi fallback record omitted `requested_driver`. Both closed by C8 (h) and (i): see
[C8 carry-ins](#c8-carry-ins).

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes | held: CX-6b (shell, patch), CX-6c (reads outside the packet) | V2-V5 (cp-6sq6 probes) |
| 2 | a dead hook lets a tool have an effect | held: CX-6c part 2 (no packet text, no verdict), CX-6b part 3 | V6, V7 |
| 3 | the verdict tool accepts another job | held: CX-6a (a wrong-job verdict refused) | none (no CLI part) |
| 5 | a process survives the review | held: CX-6a, CX-6c (every started scope, the delete server's included, killed or collected) | not run in C6 |
| 6 | an extra loaded surface is not refused | held: CX-6b part 2 (`shell_tool` read back on) | V2-V5 read-backs |

Cases: `tests/e2e/codex-reviewer.test.ts` (CX-6a…6g). The opt-in live case LS-8o-R was not added in C6; the real-CLI
verdicts above rest on the cp-6sq6 offline probes.

### C7a ship-job groundwork (unwired)

C7a is steps 1-3 of the C7 plan (cp-95u6, approved es-3e598d): the pieces a Codex implementer needs, with **no
selection reaching them**. `codex_ship` still selects nothing, `codexClassOf` and `codex-worker.ts` are unchanged, and no
`data/*.json` or `defaults/routing*.json` was edited. C7b (steps 4-5: selection, spawn env, worker, checkpoint, moved
thread) wires them, with CX-7a…7n in `tests/e2e/codex-ship.test.ts`; see [C7b](#c7b-ship-jobs-wired-shipped-off).

**Profile `picp_implementer`** (`codexPermissionProfile` with `role: "implementer"`, `codexRunRoots`): `/` deny,
`:minimal` read, the worktree **write**; `<worktree>/.git`, the git common dir, the codex release dir, skill dirs,
operator read roots and each excluded path that exists at the run's start read; the artifact dir and scratch tmp write;
no network. Excluded paths (`codexExcludedRoots`): a plain needle joined to the worktree, a glob through `globSync`
(at most 200 hits, `.git` and `node_modules` not walked), each kept only when its realpath stays inside; a missing path
is never listed (the sandbox would create it, PA). A file entry holds (LS-9o-P: `.env.local`). Read roots
(`CP_CODEX_READ_ROOTS`, wired in C7b, a ship implementer's only since C8) are vetted as skill dirs are: never a home,
the Codex home, the agent dir or the CP home.

**Lockdown.** `activePermissionProfile.id` must equal the id picp passed (one of the two). The thread read-back does
not list the writable worktree (the cwd) as a writable root (PA), so an implementer run also reads its profile back
from `config/read`: `permissions.picp_implementer.filesystem` must equal the passed map entry by entry (the CLI's
`glob_scan_max_depth: null` ignored), `extends` must be unset, `default_permissions` must be the id, and every entry
and the default must come from `sessionFlags`. Any miss refuses before any turn.

**Git writes are picp tools (U2).** The Codex sandbox keeps `.git` read-only even under a write root (PC), so the shell
reads git and cannot write it. The implementer's thread declares `report_result` (its description names `head_sha`),
`gh_read`, `git_commit {message}`, `git_merge {ref}` (only `origin/<job>` or `origin/<base>`), `git_fetch` and, for
delivery `pr`, `git_push`, `pr_create`, `pr_edit`. They run in the worker process after the hook's ticket and the guard
chain, through `src/drivers/native-forge.ts` (SDK-free; the Claude forge tools now call the same bodies, texts and argv
unchanged). Every git call of a codex job starts with `GIT_HOOKS_OFF`; commit and merge get only PATH, the locale and
the commit identity (no credential, no HOME). `git_commit` runs `git add -A`, then the staged-path gate: a staged path
that differs from `HEAD` (and from `MERGE_HEAD` during a merge) and matches an `exclude_paths` needle refuses the
commit, unstages, and names up to five paths; it is the complete check for globs and for paths created later.
`codexGitGuard` refuses a git write in the implementer's shell at the hook, naming `git_commit`, `git_merge` or
`git show HEAD:<path> > <path>` (lexical; the kernel is the bound).

**F5 and the C3 finding: no patch is ever accepted.** Every `fileChange` approval stays `decline` for every role, and
the tripwire still kills on any end but `declined`. An implementer's `apply_patch` is refused at the hook naming the
remedy: write files with the shell (a quoted heredoc, `sed -i`, a script).

**R3: no MCP server for the implementer** (as for the reviewer), so R3 does not arise for a write-capable job. R3 stays
accepted for read-only research only.

**Probes** (cp-95u6, codex-cli 0.170.0, picp's `spawnCodexRpc` and profile, the mock model, throwaway homes, no login):

| # | Setup | Observed |
|---|---|---|
| PA | worktree write; `.git`, an excluded dir, the common dir read; healthy hook, approvals accepted | worktree writes work; excluded writes and removals "Read-only file system"; outside absent; `git status`/`diff`/`log` work; `git add`/`commit` fail at `index.lock`; hooks, git config and `.git` read-only |
| PA read-back | `thread/start`, `config/read` | `writableRoots` omits the worktree; `config/read` returns every entry and mode from `sessionFlags` |
| PB | PA's profile, hook killed, approvals declined, allow rules for `touch` and `git` | `touch r1.txt` ran unasked (R1); an excluded `touch` absent; `git config` and `git commit` asked and were declined; `git status` exactly `?? r1.txt` |
| PC | the common dir as a write root | `git add` still fails at `index.lock`: no commit from the shell (U2) |
| PS | `codex sandbox` with the same flags | the same profile applies to a command picp starts itself |
| PF | `codex features list` | no feature turns `apply_patch` off |

**Live verdicts** (`tests/e2e/codex-worker-live-smoke.test.ts` under `CP_LIVE_TESTS=1`, all offline: the real CLI,
the loopback mock model, a throwaway Codex home, zero tokens; run once on 2026-11-19, codex-cli 0.170.0):

| Case | Result |
|---|---|
| LS-7o-M | through `runCodexSpike` with `probe` (hidden `delete_*`) and `probe-x`: lockdown `ok`, no bypass, `completed`; one `call probe read_thing`; the hidden call a hook denial; tickets 2 by id, 1 by payload (the elicitation). **U3:** the CLI spells `probe-x` as `mcp__probe_x__<tool>`; picp's route does not recognise it and refuses it at the hook (fails closed, never ungated) |
| LS-7o-D | killed hook, elicitations declined: 3 failed hooks, 2 elicitations, both tool calls `failed`, **no `call` reached the server (KC2 held)**; **R3:** the `read_mcp_resource` call ran (`resources/read` reached the server), as cp-wh89 measured; accepted for research only, and no implementer gets an MCP server |
| LS-9o-P | `picp_implementer`, healthy hook, all 13 approvals accepted: lockdown `ok` with the `config/read` read-back; worktree writes work; an excluded dir and an excluded file stay unchanged; outside absent; `git status` runs; `git add`/`commit` "Read-only file system"; HEAD, index, hooks, git config and `.git` unchanged |
| LS-9o-R | R1 with a killed hook, allow rules for `touch` and `git`, approvals declined: `touch` ran with 0 approvals, `git config` and `git commit` asked and were declined; `git status` exactly `?? r1.txt`; no excluded file, no config key, HEAD unchanged. **C2 did not fire** |
| LS-9o-W | `runCodexSpike` as an implementer: shell write, `git_commit`, report with `head_sha`: committed, lockdown `ok`, no bypass, tickets 3 by id; durations about 90 ms (shell), 50 ms (`git_commit`), 10 ms (`report_result`) |

**Residual risks** (es-ee4de5 accepted RR1 under conditions C1-C3 above):

- **RR1** (R1). With a dead hook and a user allow rule, one unasked command can write files of the job's own worktree
  before the kill (PB, LS-9o-R). It is uncommitted and stays there; recovery: the failed job names `hook_failed`;
  condition C1 makes a revive surface it by path first; or tear down.
- **RR2.** Worker-side `git add`, `commit` and `merge` run a filter or merge driver the repository's own git config
  names; a config pointing one at a worktree script would run model-written code outside the sandbox, in a
  credential-free env. Hooks and fsmonitor are off (C3); the model cannot write git config (PA).
- **RR3.** The project's commit hooks do not run for a codex job; CI is the check.
- **RR4.** No network and a narrow read set: many repositories cannot install or test. `CP_CODEX_READ_ROOTS` widens
  a ship implementer's reads (never a planner's or reviewer's, C8); whatever it names is readable by that model.
- **RR5.** No `apply_patch`: more turns and tokens per edit; measured once by LS-9 (C7b), not soaked.
- **RR6.** Permission profiles, `hooks.state` trust, dynamic tools and the `.git` protection are experimental or
  undocumented; a CLI update can change them. The lockdown and LS-9o-P fail closed; recovery is the switch.
- **RR7.** CI proves picp's wiring on a lexical fake (`tests/fixtures/fake-codex.ts` now answers a write under no
  `write` entry and every git write "Read-only file system"); every kernel claim rests on the opt-in real-CLI cases.
- **RR8.** The git common dir is readable (a remote URL with embedded credentials would be too), as for planners.

**Known limits.** Commit and merge run with no HOME, so the operator's global git config (an `excludesFile`, signing)
does not apply to them. Excluded globs are listed for the kernel up to 200 hits and not under `node_modules`; the
`git_commit` gate covers the rest. A server name with `-` is unusable on Codex (U3 above).

**Shipped off (C7a).** No persisted shape, contract schema or golden changed, and no selection reaches the implementer
role, so with every switch off nothing writes a codex value (T-row and CX-off-2 unchanged). Recovery: revert the PR.

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes | unchanged (CX-1c, CX-1m); C7b adds CX-7b, CX-7d | held (LS-9o-P, LS-7o-M) |
| 2 | a dead hook lets a tool have an effect outside the implementer's write set, or a picp tool run | unchanged (CX-1g, CX-1h); C7b adds CX-7c | held (LS-9o-R: one worktree file; LS-7o-D: no MCP tool call; R3 recorded) |
| 6 | a differing profile or an extra surface is not refused | unchanged (CX-1d); C7b adds CX-7k | held (LS-9o-P read-back) |

### C7b ship jobs (wired, shipped off)

C7b is steps 4-5 of the C7 plan (cp-95u6): a `kind:ship` job with role implementer and delivery `pr` or `local`, dispatched
with `driver: "codex"` (or matched by a rubric row naming it) and an explicit `openai/gpt-…` model, runs on
`src/drivers/codex-worker.ts` when `data/native.json` `codex_ship` is on. Every switch still ships **off**: no
`data/*.json` or `defaults/routing*.json` was edited and no shipped row names codex.

| Piece | What happens |
|---|---|
| Selection | `codexClassOf` returns `codex_ship` for implementer ship; delivery other than `pr` or `local` is `ineligible`; switch off is `switch: the switch codex_ship is off` (an explicit dispatch refuses before any lease, a row falls back to pi) |
| Spawn | `nativeSpawn` passes `CP_BASE_BRANCH` to codex as to Claude; the addendum is `CODEX_SHIP_ADDENDUM` (pr) or `CODEX_LOCAL_SHIP_ADDENDUM` (local): shell writes, no `apply_patch`, no git writes in the shell, `git_commit`, `git_merge`, `git_push`, `pr_create`, `head_sha`; the parent's `CP_CODEX_READ_ROOTS` passes to an implementer only (C8) |
| Worker | the implementer's artifact path and `exclude_paths` as on Claude; no `mcp.json` read and no MCP server (R3, also refused in the run core); read roots vetted by `codexSkillRoots` (a home, the Codex home, the agent dir or the CP home refuses the run before any app-server); the session record keeps `base` |
| Profile | the worktree entry is its realpath, so a symlinked worktree still holds its read-only `.git` and excluded entries (`codexExcludedRoots` returns realpaths) |
| Git refusals | `codexGitGuard` runs first in the chain and also refuses `git fetch`, `pull` and `push` in the shell, naming `git_fetch` then `git_merge`, or `git_push`; `git_push`'s non-fast-forward refusal names `git_merge` for codex |
| Checkpoint (Q2) | the freeze drain's `checkpoint` aborts the turn (the run's own stop sequence), then `codexCheckpointCommit`: hooks and fsmonitor off, a credential-free commit, the staged-path gate (a gated path stays uncommitted and is named in `native_checkpoint.excluded`), C1's unreviewed paths left uncommitted and named in `native_checkpoint.unreviewed` and the answer (CX-7n), then the best-effort push, none for delivery `local`; then `agent_settled`. Idle, admission-pending and named-stop cases answer as the Claude worker does; research and reviewers stay refused by name |
| Moved worktree (Q4) | a resume whose record names another `cwd` emits `native_session_moved`, deletes the old thread (`native_thread_deleted`), starts a fresh record and thread, and leads the prompt with the brief; research keeps the by-name refusal |
| C1 (RR1) | `cp_revive` (a native continue is the same revive) of a codex implementer whose last `native_run` stopped `lockdown` names its uncommitted paths before the relaunch: in the plan and result text, in `worker_revived.unreviewed_changes`, and after picp's revive prompt, which tells the worker to inspect each before any `git_commit`. The revived worker reads them from `<run dir>/native-unreviewed.json` (`CP_NATIVE_UNREVIEWED_FILE`, C8), so its freeze checkpoint never commits them (CX-7n, CX-8b). A `continue_failed` is this same revive (`src/revive.ts` `plan()`, J7). Nothing is committed by picp |
| Persisted | `totals` in the session record is written for a ship job while `codex_ship` is on. `codexPersistRefusal` follows the value's class switch since C8 (see [C8 carry-ins](#c8-carry-ins)) |

**Shipped off (C7b).** With every switch off an explicit codex ship dispatch refuses before any lease naming
`codex_ship`, and a codex `small-ship` row runs pi with `switch:` and no `requested_driver`; no `native-codex` record and
no codex driver value is written to fleet, queue, armed, run log or `native.json`, so a build before C7b reads every
file (CX-7i). Contract schemas and the golden are unchanged; `worker_revived` may carry `unreviewed_changes` and
`native_checkpoint` may carry `excluded` and `unreviewed`, only in a home that ran a codex ship job. The flip, by hand: add the row (or
dispatch explicitly), then turn on `codex_ship` (since C8 it also admits a queued or armed codex dispatch).
Recovery: `codex_ship` off (new jobs route pi; a live codex job still tears down and deletes its thread), or revert the
PR; no data migration. Before a build older than C7b, tear down every codex ship job.

**Live (LS-9, run once on 2026-11-19, codex-cli 0.170.0, operator's login, one turn).** The worker entry as a local
ship implementer appended a line with the shell, committed through `git_commit` and reported `head_sha`: lockdown `ok`,
51,082 tokens at cost 0, 0 `apply_patch` denials (RR5: none needed for this edit), the thread deleted. Its survivor
assertion (no command, app-server or `picp-codex-*` scope left) was added after that run. **C8 (j):** run once more on
2026-11-20, codex-cli 0.170.0, on the C8 PR 1 tree: exit 0, lockdown `ok`, 51,105 tokens, report accepted, 0
`apply_patch` denials, 0 denials; survivors: commands 0, app-servers 0 (before 0), scopes 0 (before 0). KC5 held.

**Negative controls** (run once each and restored): N1 no excluded carve-outs: CX-7c fails on job B's file; N2 the
`fileChange` approval answered `accept`: CX-7d fails on the dead-hook patch's file; N3 no staged-path gate: CX-7e fails
on the first commit landing; N4 `git_commit` with no ticket check: CX-7c job D fails on HEAD (a killed hook's run is
already killed before the CLI asks for the tool, so job C alone cannot reach the ticket); C1 no dirt lookup: CX-7c
fails on the revive text; the unreviewed exclusion dropped: CX-7n fails on r1.txt in the WIP commit; a local checkpoint
pushing: CX-7n fails on `pushed: true`.

**Known limits.** The C7a limits stand (RR1-RR8). A checkpoint during a merge commits the merge as the WIP. (The
C7b limit that a queued, armed or rubric codex value needed `codex_research` is closed by C8 (h).)

| KC | Criterion | CI (fake) | Real CLI |
|---|---|---|---|
| 1 | a forbidden action executes: a write to `.git`, an existing excluded path or outside; a push beyond `refs/heads/<job>`; an applied patch | held: CX-7a, CX-7b, CX-7d, CX-7e | held (LS-9o-P, LS-9) |
| 2 | a dead hook lets a tool have an effect outside the implementer's write set, or a picp tool run | held: CX-7c (jobs A-C), CX-7c job D (no ticket) | held (LS-9o-R, LS-7o-D) |
| 3 | `report_result` accepts another job | unchanged (CX-1a, same tool) | none |
| 4 | usage counted twice across a checkpoint, resume or moved thread | held: CX-7f | unchanged (LS-3c) |
| 5 | a process survives a stop, a checkpoint or teardown | held: CX-7a, CX-7c, CX-7f (every scope killed or collected) | held (LS-9 survivors 0/0/0, run 2026-11-20, C8 j) |
| 6 | a differing profile or an extra surface is not refused | held: CX-7k | held (LS-9o-P, LS-9) |

Cases: `tests/e2e/codex-ship.test.ts` (CX-7a…7n; CX-7m is a unit check: no entry point leases a symlinked worktree)
and the opt-in LS-9 in `tests/e2e/codex-worker-live-smoke.test.ts`.

### C8 carry-ins

C8's first PR (cp-tmbb plan, PR 1) closes the carry-ins the main session decided on code that is already merged and off.
Every switch still ships **off**; no `data/*.json` or `defaults/routing*.json` was edited.

| Item | Before | Now | Case |
|---|---|---|---|
| a | a `git status` failure in `lockdownChanges` became an "unreviewed path" (`(git status failed: …)`) that matched nothing, so a later freeze committed the dirt | `cp_revive` refuses with the new code `worktree_unreadable`: nothing spawned or committed; fix the checkout and retry, or `cp_teardown` | CX-8a |
| b | a malformed list made `checkpointed()` throw: `native_resume_failed`, the job failed | `readNativeUnreviewed` returns `{ error }`; the checkpoint answers `success: false` ("nothing was checkpointed"), `native_checkpoint.error`, then `agent_settled` | CX-8c |
| c | the whole list rode in one env string (`CP_NATIVE_UNREVIEWED`), past the kernel's 128 KiB per-string limit (E2BIG) for a large dirty tree | `<run dir>/native-unreviewed.json` (0600, tmp + rename) passed as `CP_NATIVE_UNREVIEWED_FILE`; a revive with nothing to name removes a stale one. `codexCheckpointCommit` matches by `Set` and unstages in batches of 500 | CX-8b |
| e | every non-reviewer role got `CP_CODEX_READ_ROOTS` | the spawn passes it to an implementer only and the worker reads it for a ship job only | CX-8e, CX-7l |
| g | no e2e drove `cp_revive continue_failed:true` on a codex implementer | the J7 continue reaches the same `lockdownChanges` naming (`continue_failed_as_revive: true`) | CX-8b |
| h | `codexPersistRefusal` keyed on `codex_research` alone | with a class (a rubric row by role, a row fallback's `requested_driver`, the session record's `totals`) it reads that class's switch; with none (queued and armed dispatches) any codex switch passes, else `… while every codex switch is off …`. All three off refuses everything, as before | SD-codex-class, CX-8i, T-row |
| i | a reviewer's `routing_resolved` had no driver field | `requested_driver`, `driver`, `driver_reason`, each when the decision has it (with codex off: `driver: "pi"` and the switch reason, no `requested_driver`) | CX-8i, CX-6a, CX-6d |

**Persisted shapes.** `<run dir>/native-unreviewed.json` is new and written only by a revive of a lockdown-killed codex
implementer; an older build ignores it. A reviewer's `routing_resolved` gains three open-payload fields, `pi` and a
reason text while codex is off. Nothing else changes shape, and with every codex switch off no file takes a codex
value (T-row, CX-off-2, CX-6d, CX-7i). Recovery: revert the PR; no data migration. A stale `native-unreviewed.json` is
harmless and replaced at the next revive.

| KC | For C8 | Held by |
|---|---|---|
| 1 | picp commits a lockdown-killed run's unreviewed dirt (checkpoint or revive) | CX-8a, CX-8b, CX-8c; CX-7n unchanged |
| 5 | a command, app-server or `picp-codex-*` scope outlives LS-9 | held: LS-9 run once live on 2026-11-20 (survivors 0, 0, 0; see C7b above) |
| 6 | an extra surface reaches a role: read roots in a planner profile | CX-8e |
| C2 | a codex value is persisted while every codex switch is off | T-row, CX-off-2, CX-6d, CX-7i |

Cases: CX-8a…8c in `tests/e2e/codex-ship.test.ts`, CX-8e in `tests/e2e/codex-worker-tools.test.ts`, CX-8i in
`tests/e2e/codex-reviewer.test.ts`, SD-codex-class in `tests/e2e/settings-drivers.test.ts`.

### C8 Settings, doctor and soak

C8's second PR (cp-tmbb plan, PR 2) makes the three codex switches settable from the dashboard, adds the `/doctor` Codex
lines and writes the soak steps ([routing-rollout.md](routing-rollout.md#codex-cli-soak-opt-in)). Every switch still
ships **off**; no `data/*.json` or `defaults/routing*.json` was edited and no shipped row names codex.

- **Settings.** `workers.native_codex_research`, `workers.native_codex_ship` and `workers.native_codex_review` (42
  catalog fields) sit under Native workers beside the Claude switch. On writes `true`; off and restore delete the key,
  so a home that turned codex off again has no codex key. There is no availability check at write time: selection
  refuses by name and `/doctor` explains. The Workers CLI still offers pi and claude only and never touches a codex
  switch; `codex_max_concurrent` and codex rows stay hand-written.
- **`/doctor`** (`src/codex-doctor.ts`, selection's own probes): `codex.containment` (`systemd-run` and
  `CP_WORKER_MEMORY_MAX`), `codex.cli` (`codex --version` against the floor; missing or below it names `codex update`),
  `codex.login` (the `codex login status` exit code only, `HOME=/nonexistent`; named `codex login`) and
  `codex.workers` (the switches, `codex_max_concurrent`, the rows naming codex; a row whose class switch is off, or an
  unreadable `data/native.json`, is `warn`). Each line is `ok` with its fix while no switch is on and no row names
  codex, `warn` once one does, and never `error`: a codex row falls back to pi and an explicit dispatch refuses by name.
- **Footer.** The chat footer's Codex item shows while any codex switch is on.

**Persisted shapes.** `data/native.json` takes `codex_*: true` only after an operator turns a switch on, and loses the
key when it is turned off; `data/settings-audit.jsonl` names the new keys only after such a write. While every codex
switch is off neither file holds a codex value, so the previous build reads both (SD-codex-switches, T-row, CX-off-2).
Recovery: turn the switch off in Settings (the key is deleted), or revert the PR; no data migration.

| KC | For C8 PR 2 | Held by |
|---|---|---|
| C2 | a codex value is persisted while every codex switch is off | SD-codex-switches (off and restore delete the key), T-row, CX-off-2 |
| C8 | `/doctor` or a Settings read writes a file, starts an app-server or reads the Codex home | CX-8d (only `--version` and `login status` reach the CLI; the Codex home listing is unchanged), SD-codex-switches |

Cases: CX-8d in `tests/e2e/codex-doctor.test.ts`, SD-codex-switches in `tests/e2e/settings-drivers.test.ts` and the
`codex_ship` step of S3-codex-line in `tests/e2e/viewer-full-match-status.test.ts`.
