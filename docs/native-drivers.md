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
| Resume | Not exercised; the SDK's `resume` option exists. Step 2 (P3) measures it before any wiring | — |
| Interrupt | `AbortController` on the run's timeout; not exercised by a test. Step 2 measures it before any wiring | — |
| Usage | T3's `ClaudeTurnTokenUsage.ts` normalizer: `complete` on success; unknown is `unavailable`, never 0 | e2e (7); unit `spikeUsage` |
| Exit | The child's own exit code/signal; after a 10 s grace the driver kills and still reports the observed exit | e2e (7) |

Isolation: every run gets a `mktemp -d` scratch dir (dirs mode 0700) outside the worktree holding `HOME`,
`CLAUDE_CONFIG_DIR` and `TMPDIR`, removed in `finally`. `settingSources: []`, `strictMcpConfig`, no plugins, skills or
agents, `Agent`/`Task`/`WebFetch`/`WebSearch` disallowed. The child env is an allow-list (`PATH`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TZ`) plus the explicit provider variables; a host `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` never reaches it.

### Step-2 gates (before any wiring)

- **Shell write scope must be enforced before wiring.** The Write tool is scoped to the artifact directory
  (`src/drivers/claude-spike.ts:178`), but Bash is not: a redirect (`echo x > file`) or a `cp`/`mv` into the worktree
  passes. Bash is covered only for specific shapes: host auth copies (`src/worker-credential-guard.ts:46`), bulk copies
  of the home (`:183`), history rewrites (`src/worker-history-guard.ts:52`), shell `apply_patch`
  (`src/ci-wait.ts:229`), and key-path reads plus audited remote-host calls (`src/worker-host-guard.ts:44`).
- **Resume and interrupt** are measured before wiring; resume double-counting usage stays a kill condition.

### Versions (as T3 handles them)

- `@anthropic-ai/claude-agent-sdk` `^0.3.318` in `package.json`, exact `0.3.318` in `package-lock.json` (T3:
  `apps/server/package.json:37` `^0.3.284`). `zod` `^4.6.7` is added because it is the SDK's peer. Both are
  `devDependencies` while the driver has no runtime entry point; step 2 moves them to `dependencies`, which
  `tests/structure.test.ts` (runtime dependency allow-list) must approve.
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
| Files | `src/drivers/claude-spike.ts` 444 lines; `tests/harness/claude-mock-provider.ts` 156 lines |

The live smoke (`tests/e2e/native-worker-live-smoke.test.ts`) runs only with `CP_LIVE_TESTS=1`: one no-tool turn
using the operator's login, which `claude` reads from its own settings file; picp passes the path and never reads it.
`report_result` was registered in that run but never called (no tools, one turn).
