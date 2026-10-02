# Test harness (m0)

Shared, deterministic, free test infrastructure. **Product code must never
import from `tests/harness/`.**

| Module | What it gives you |
|---|---|
| `mock-provider.ts` | scriptable `openai-completions` server: text, tool-call sequences (args split across deltas), empty answers, HTTP error injection (`429`, `repeat: N`), hangs; per-script cursors and recorded request bodies. A tool call's `args` may be a **function of the request** — the only way to script a call whose arguments contain an id minted at runtime (a `br create` id): the brief is in the request, so the test reads the id back out of it. A throw in that callback answers HTTP 500 rather than hanging the client. |
| `agent-dir.ts` | hermetic `PI_CODING_AGENT_DIR` (temp settings + `models.json`, `defaultProjectTrust: never`, offline) so tests cannot see or touch operator credentials |
| `pi-child.ts` | spawn a pi RPC child; `buildPiArgs` applies the contract trust policy (`WORKER_REQUIRED_FLAGS`); `prompt()`, `waitForSettled()`, `getState()`, `eventsOfType()` |
| `rpc.ts` | strict LF JSONL framing + id-correlated waits (never `node:readline`) |
| `scratch-repo.ts` | git fixture with a bare "remote", dirt/commit helpers, `squashMergeAndDeleteHead()` for the merged-head teardown trap |
| `golden.ts` | `assertGolden(name, actual)` against `tests/golden/<name>`. `CP_UPDATE_GOLDEN=1` rewrites the file **and fails the test**, so a regenerated golden always lands in a diff and never in a green run. |
| `attach.ts` | `TestConsole`: the attach console **minus the terminal** — a real `AttachSession` over the real `applyAttachEffects` ports and real worker events (`workerEventToAttachInput`), with `ctx.ui.custom` replaced by a test driving inputs. It re-implements no rule; rendering and key decoding are pinned separately by goldens in `tests/attach-console.test.ts`. |
| `state.ts` | file-only readers (`readFleet`, `readRunStatus`, `readRunEvents`) that validate against `src/contracts.ts`, plus `assertEventSequence` and `waitFor` |
| `parent-hosts.ts` | `parentHostPids`/`killParentHosts`/`stopParentHosts`: find and kill detached `src/parent-host.ts` processes by their scratch home in argv; `teardownHome(home, ...steps)` runs every step, stops the hosts and removes the home even when one fails; `createScratchHome().cleanup()` kills them first |

## Usage

```ts
const provider = await MockProvider.start();
const model = provider.addScript("my-case", [
  { kind: "tool_calls", calls: [{ name: "bash", args: { command: "echo hi" } }] },
  { kind: "text", text: "done" },
]);
const agentDir = createAgentDir({ provider });      // writes models.json
const child = startPiChild({ cwd: repo.path, model, env: agentDir.env, tools: ["bash"] });
await child.prompt("go");
await child.waitForSettled();
```

Rules that keep suites honest:

- **One script name per child.** Cursors are per script; sharing a name across
  two children interleaves their steps.
- **Scripts fail loudly.** A request past the last step returns HTTP 500, and
  `provider.remaining(name)` must be `0` when a test claims the script ran.
  Register `models.json` *after* all `addScript` calls (or call
  `agentDir.writeModels(provider)` again).
- **No network, no tokens.** `PI_OFFLINE=1` and the mock base URL. Live suites
  are opt-in via `CP_LIVE_TESTS=1` (`LIVE_TESTS_ENABLED`) and are operator-run
  only; CI runs the mock milestones.
