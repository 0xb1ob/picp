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

- **G1, shell write scope: deny-by-default Bash policy shipped** (`src/drivers/claude-bash-policy.ts`, called from the
  Bash guard in `src/drivers/claude-spike.ts`). The SDK `sandbox` option was tried first: on this host bubblewrap works
  but `socat` is missing, and `sandbox: { enabled: true, failIfUnavailable: true }` fails closed at startup ("socat not
  installed"), so it is never silently unsandboxed but cannot run here. The OS sandbox needs `socat` and stays a later
  option; picp does not install it. The policy lexes the command and runs it only when every segment is a named
  read-only command (`rg`, `grep`, `ls`, `cat`, `head`, `wc`, `sort`, `find`, read-only `git` subcommands,
  `gh <noun> view|list|…`, and similar) using only options on that command's own allow-list: short clusters are
  checked letter by letter (`git grep -nOrm` is refused at `O`) and long options match exactly, `=` form included; a
  value is attached (`--opt=v`, `-n5`) or the next word, which must not start with `-` (so `git log -n --output=f`
  is refused); git's optional-value `--pretty`/`--format` count only as `--pretty=…` and `-U` only as `-U<digits>`;
  `find` takes only its listed primaries. A deny-list of dangerous flags did not converge (`sort --compress-program`,
  `rg --hostname-bin`, `git grep -O`, `file -C` each turned up in review), so nothing outside the lists runs and
  `file` is gone. Also refused: redirects (other than to `/dev/null` or fd dup), command substitution, every `$`
  expansion but `$?` (`$NAME`, `${…}`, `$'…'`, `$"…"`, `$[…]`), unquoted braces, `~` and globs (`*`, `?`, `[`: the
  shell expands them after the check, so a planted link could name a secret), subshells, background jobs, env
  assignments and unknown commands. The Write tool stays scoped to the artifact dir.
- **R1, env and secret paths.** A passed settings file's `env` reaches the CLI and every Bash child, so it is kept out
  in layers: `printenv`, `cd`, `env`, `set`, `declare`, `export`, `typeset` and `compgen` are not on the list, `$`
  expansion is refused, and a secret-path guard refuses Read, Grep, Glob and Bash arguments that are, link to, or
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
request refuses as `refused: <job> cannot run on the native claude driver: <reason>`, in this order:

| Condition | Refusal names |
|---|---|
| switch file unreadable or off | the setting and where to turn it on |
| owned by a pipeline (`state/pipelines/<research id>`) | pipeline research stays on pi (D2) |
| not research (role `planner`, delivery `local` or `answer`) | the job's kind/role/delivery; ship implementers run native since [N4f](#native-ship-jobs-n4f); review, plan, parent and operator roles never do |
| the home's native slots are full (fleet records with `worker.driver`, no observed exit, the job's own excluded) | `max_concurrent` and the live jobs ([N4i](#native-concurrency-and-the-flip-n4i)) |
| `claude` missing or below the pinned floor `CLAUDE_VERSION_FLOOR` | `claude update` / install remedy |

`WorkerManager.spawn` refuses a native worker past `max_concurrent` again (`SpawnSafetyError`) before admission. A `driver: "claude"`
dispatch held by the spawn cap (queued) or by open blockers (armed) keeps its driver (`QueuedDispatchRequestSchema.driver`,
`toDispatchRequest`), so its release re-runs this selection: it runs native or is refused, never on pi.

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
| Ledger and dashboard | job detail shows `native claude` next to the model |
| Log transcript | each top-level assistant/user message (text, tool calls, tool result text, thinking text; never signatures, the init message or CLI config) is appended, flushed per message, as pi session lines to `state/sessions/native/<job>.jsonl` (mode 0600); each block is capped at 64 KiB with a visible truncation marker, a resumed run appends a "resumed" entry to the same file, and run status records it as `transcript_file`, which the dashboard Log reads. It survives teardown; only the scratch dir is removed (`src/drivers/claude-transcript.ts`) |

**Follow-ups.** N3c replaced the N3b "Refused until N3c" list; see [N3c follow-ups](#n3c-follow-ups).

**Turn limit.** Each native claude process runs with an SDK turn cap of 500 (`NATIVE_MAX_TURNS` in
`src/drivers/claude-worker.ts`); `CP_NATIVE_MAX_TURNS` overrides it with a positive integer, and any other value keeps
500. Every `native_run` event records `max_turns`; a run the SDK ends with `error_max_turns` adds `stop: "max_turns"`
and a stderr line. If the worker then exits without a report, the job fails as `turn_limit` ("Stopped at turn limit"),
not `crash`; the worktree and session are kept, and like every native failure it is never auto-recovered.

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
usage. A run with no result message (the process was stopped first), an unreadable `modelUsage` or zero tokens writes no
measurement: the worker emits `usage_unavailable`, run status carries `usage_unavailable: true` and the dashboard shows
"unavailable (not measured)". Accounting then adds nothing for that run (never a measured zero) and admission does not
wait on it. Every `native_run` event names `result_subtype`, `usage_status` (`complete`, `unavailable` or
`unbaselined`) and `denied`: at most 5 `tool: reason` lines of at most 200 characters, paths and env values redacted.
A teardown that reaches a turn still in flight (typically after its `report_result`, before the closing `result`)
waits up to `NATIVE_RESULT_GRACE_MS` (4 s, under the parent's 5 s stdin grace) for that result, measures it, then
stops; queued follow-ups stay queued. A result that does not arrive in time is abandoned and the run stays unavailable.

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

| Follow-up | pi | native claude |
|---|---|---|
| `cp_send`, worker idle | prompt into the live session | admission, then ONE new claude process resumes the session with the message; worker disposition `resuming` (admitted, process starting, not yet run), ack `native: resuming: …`; a resume that throws journals `native_resume_failed` and the worker exits non-zero |
| `cp_send`, worker busy (auto/follow_up) | steer (auto) or follow_up | queued in `native-followups.jsonl`; ack `receipt: queued`, `native: queued until the current turn ends …` |
| `cp_send` mode `steer` | steer into the turn | refused by name; nothing sent |
| `cp_revive` | respawn idle | respawn, then resume with picp's revive prompt (also from `failed`) |
| `cp_revive continue_failed` / bounded recovery | continue / automatic | refused (`native_refused`): a plain revive already resumes under admission |

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
| explicit `model` override, no `driver` | pi | (the row is not consulted) |
| matching row `driver: "claude"` | claude | pi, `driver_reason` names the condition |
| row without `driver` (legacy) or `pi` | pi | — |
| a job whose fleet record already started (D1) | the recorded driver | a native job refuses rather than move to pi |

**Fallback reasons** (`driver_reason` is `<code>: <why>`): `denied` (the native primary is outside `allow` or hit by
`deny_by_role`), `switch`, `pipeline`, `ineligible`, `occupied`, `cli_missing`, `cli_version`, and from S2 `window`,
`auth`, `lockdown` (below). The pi lane is the row's `[model, ...fallbacks]` through `resolveWithCapacity`, unchanged.

**Model and effort.** The native model is the row's own `model` (or an explicit override's), an explicit
`anthropic/claude-…` id; any other ref refuses the dispatch with no lease. The row's effort maps to SDK options: `off`
disables thinking, `low`/`medium`/`high`/`xhigh`/`max` set `effort`, `minimal` refuses, absent leaves the CLI default and
the reason records `effort CLI default`. The worker gets it as `CP_NATIVE_THINKING`; revive passes the same level.

**Eligibility (D2).** Only local and answer research (role `planner`) routes native; a pipeline's research child is
recognised by its pipeline record, not its role, and stays on pi.

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
[`docs/routing-rollout.md`](routing-rollout.md#native-claude-research-soak-opt-in).

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
never the CLI child. Its Bash (`src/drivers/claude-ship-policy.ts`) runs pi's pattern guards first, then a default-deny
allow-list: the read-only list, local git verbs, `npm ci|run typecheck|test:one|lint|build|changelog:*`, `node`/`npx
tsx` on worktree scripts, and `mkdir|mv|cp|rm` and redirects on worktree paths only. Push, fetch, `gh`, `cd`, env dumps
and `$` expansion are denied; there is no network tool beyond `npm ci`/`npx tsx`, which reach the package registry, and
network actions arrive as picp tools in N4d. The honest limit: `npm run`
and `node` execute repo code, so this is defence in depth at pi parity, not a sandbox. Selection stays research-only
until N4f, so no production job reaches this yet.

## Implementer forge tools (N4d)

`src/drivers/claude-forge-tools.ts` gives the implementer its network as in-process picp MCP tools beside
`report_result`. They run in the claude-worker process, which holds the inherited worker env, so no credential enters
the CLI child; the lockdown expects them for the implementer only. `git_push` pushes `HEAD` to `origin/<CP_JOB_ID>` in
the worktree and refuses `force`, main, the base branch (`CP_BASE_BRANCH`) and any other branch by name; a rejected
non-fast-forward push is refused by name too, never retried forced. `git_fetch` fetches `origin` in the worktree and
refuses any other `cwd`, the canonical clone included. `pr_create` opens a draft from the job branch (to
`CP_BASE_BRANCH` when set, else the repository's default) and records it in the run dir; a second call returns that
URL. `pr_edit` edits the title and/or body of that PR and refuses any other number. `gh_read` runs `pr view|checks`
on that PR or `run view <id> [--log-failed]` in this repo; `pr checks` and a status `run view` share one snapshot per
worker process, then the ci-wait repeat refusal answers. Every output passes `redactGithubTokens` and is capped at 20,000
characters. The worker also reads `user.name`/`user.email` from the worktree's git config and passes them as
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`, so `git commit` works under the scratch HOME; no token, HOME or credential helper is
passed. The same slice makes `git checkout -- <path>` and `git restore` paths honour `exclude_paths`. N4f sets
`CP_BASE_BRANCH` at spawn (below).

## Native ship jobs (N4f)

**The switch.** `data/native.json` key `claude_ship` (no Settings row; N4j was cut) is OFF by default. It changes
nothing on its own: an implementer runs native only when its routing row (or the dispatch) says `driver: "claude"`,
the job is `kind:ship` with delivery `pr` or `local`, and `claude_ship` is on. Off, a claude row falls back to pi with
`driver_reason` `switch: the switch workers.native_claude_ship is off …`; an explicit `driver: "claude"` is refused
with no lease. The other keys: `claude_research` (unchanged), `claude_review` (validated, gates nothing until N4h; a
gate-reviewer stays on pi) and `max_concurrent` (integer 1–4, default 1; applied since
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
