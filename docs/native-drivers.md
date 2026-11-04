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
