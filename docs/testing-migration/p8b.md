# Ledger rows: p8b

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P8b (cp-e2e-migration-p8b-dbbn) | behavior 04, second slice: hard bounds, read-only worker MCP and wedged-call notices (04-6..04-12, 04-18) in `tests/e2e/worker-lifecycle-p8b.test.ts`; 22 mapped (9 + 4 + 9), 17 retained verbatim in three `*-retained.test.ts` files with per-declaration reasons; 9 behavior-04 files stay `convert` in p8.md | 3 (`tests/bounds.test.ts`, `tests/worker-mcp.test.ts`, `tests/wedged.test.ts`) |
<!-- /manifest:ledger -->

P8b (job `cp-e2e-migration-p8b-dbbn`) converts three behavior-04 files: `tests/bounds.test.ts`,
`tests/worker-mcp.test.ts` and `tests/wedged.test.ts`. It runs eight cases in `tests/e2e/worker-lifecycle-p8b.test.ts`.
Scope: 3 of the 16 P8-owned behavior-04 files. `git diff origin/main...HEAD | wc -c` measures 92291 bytes for this
slice. P8c has since deleted four more ([p8c.md](p8c.md)); the other 9 stay `convert` in [p8.md](p8.md).
Each control below changed one guard, ran only the named case, failed as stated, and was restored.

<!-- manifest:prs -->
| PR | Behavior | Target | Proposed cases |
|---|---|---|---|
| P8b | 04 | tests/e2e/worker-lifecycle-p8b.test.ts | 8 |
<!-- /manifest:prs -->

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| 04-6 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: dispatch freezes the resolved hard bounds, and a bad worker-bounds.json refuses before any lease |
| 04-7 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a delivered send starts a fresh wall-clock round, and tool starts carry across it |
| 04-8 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a bound names the job, bound and work on disk, and the redispatched worker is bounded again |
| 04-9 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b bounds: a legacy record without frozen bounds revives on env bounds, never the home file |
| 04-10 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b MCP: dispatched read-only workers reach enabled servers through mcp_call; writers and disabled homes get none |
| 04-11 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b wedged: the parent announces a silent open tool call once, never a progressing one, and a new silent call again |
| 04-12 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b wedged: two workers silent in one tick are one notice naming both |
| 04-18 | tests/e2e/worker-lifecycle-p8b.test.ts | P8b wedged: at the default threshold a 31-minute silent call is news and a /status row; a talking or closed call is neither |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/bounds.test.ts | defaults match limen-scale caps and sit past the wedge warning | 04-6 | mapped | Default dispatch freezes 5400 s / 900 calls on the fleet record. |
| tests/bounds.test.ts | env override, malformed values keep the default | 04-6 | mapped | Env 12/4 is frozen; "nope"/"0" fall back to the defaults. |
| tests/bounds.test.ts | per-dispatch override wins over env | 04-6 | mapped | cp_dispatch override 8/3 beats env 99/99. |
| tests/bounds.test.ts | wall clock precedence: explicit override > home data/worker-bounds.json > env > default | 04-6 | mapped | Home file 1800 beats env; override 8 beats the file; tool cap ignores the file. |
| tests/bounds.test.ts | a present but malformed data/worker-bounds.json refuses, naming the file and field | 04-6 | mapped | Ten malformed bodies refuse dispatch with no fleet record. |
| tests/bounds.test.ts | allow_dispatch_override=false enforces the machine value | 04-6 | mapped | Equal override dispatches; different wall/cap refuse, flag-only file uses env then default. |
| tests/bounds.test.ts | rearm starts a fresh wall-clock round without resetting the tool count (fake clock) | 04-7 | mapped | Real cp_send rearms the 10 s round; a pre-send tool start still trips cap 2. |
| tests/bounds.test.ts | the wall-clock timer trips even when it fires 1 ms before Date.now() shows the full cap | — | retained | Verbatim in tests/bounds-retained.test.ts: timer/clock skew needs a mocked clock no entry point offers. |
| tests/bounds.test.ts | tool-call cap trips at the limit; wall-clock uses spawn or open-tool age | — | retained | Verbatim in tests/bounds-retained.test.ts. No caller passes currentToolSeconds (the guard passes only elapsed time and starts), so open-tool age has no entry point. The cap and wall-clock halves are pinned by 04-7 and 04-8. |
| tests/bounds.test.ts | the notice names the job, the bound, and what is on disk | 04-8 | mapped | onHardBound notice names job, cap, the uncommitted file and the untouched worktree. |
| tests/bounds.test.ts | a revived worker re-arms the hard bound guard for the same jobId | 04-8 | mapped | Bounded recovery redispatches the same job id and its new worker trips the cap again. |
| tests/worker-mcp.test.ts | agentDirOf follows PI_CODING_AGENT_DIR like pi's getAgentDir | — | retained | Verbatim in tests/worker-mcp-retained.test.ts. The HOME default and `~` forms would resolve the operator's real ~/.pi/agent, so no isolated entry point exists. The PI_CODING_AGENT_DIR half is 04-10 (NC-P8b-mcp-agentdir). |
| tests/worker-mcp.test.ts | readUserMcpServers: missing is none, invalid is an error without the content | 04-10 | mapped | A missing, disabled-only or invalid mcp.json gives no gateway. /doctor names each case and never quotes the file. |
| tests/worker-mcp.test.ts | workerMcpConfig keeps every server, credentials and all, and makes non-hidden tools direct | — | retained | Verbatim in tests/worker-mcp-retained.test.ts. URL servers (oauth, headers) need a network endpoint, and pi resolves `!pass` credentials itself. The hidden/direct half is 04-10 (NC-P8b-mcp-hidden). |
| tests/worker-mcp.test.ts | mcpReadOnlyRefusal fails closed: only readOnlyHint true and not destructive passes | 04-10 | mapped | Planner and qa get read_thing; plain and delete_thing refuse with their reasons and never reach a server. |
| tests/worker-mcp.test.ts | withWorkerMcp: read-only profiles only, and only when the agent dir has an enabled server | 04-10 | mapped | Planner and qa get mcp_call; implementer, disabled-only and invalid mcp.json dispatches do not. The gate-reviewer profile is not dispatched in 04-10. |
| tests/worker-mcp.test.ts | a planner's spawn plan carries the gateway next to report_result; an implementer's does not | 04-10 | mapped | Dispatched planner calls mcp_call and report_result; the implementer's mcp_call is not found. |
| tests/wedged.test.ts | a wedged call is announced once, and again only if it is a different call | 04-11 | mapped | Parent notices: one per silent call across ticks, none for the loud call, again after a resumed call re-silences. |
| tests/wedged.test.ts | two wedged workers are one notice naming both | 04-12 | mapped | Two barrier calls fall silent together: one "2 workers" notice names both jobs, says nothing was killed, and points at /watch. |
| tests/wedged.test.ts | an unmatched tool_execution_start older than the threshold is surfaced | 04-18 | mapped | An open bash call seeded 31 min old is one WEDGED notice and a /status "possibly wedged" row, and no phase says stalled. |
| tests/wedged.test.ts | a matched start/end pair is not surfaced, however long ago it ran | 04-18 | mapped | A worker ends three quick bash calls, then hangs: no notice, no row (NC-P8b-end-clears). |
| tests/wedged.test.ts | a long-but-progressing tool call is never surfaced | 04-18 | mapped | A call open 1 h with progress 60 s ago gets the long-running row, no notice and no wedged row (NC-P8b-long-row, NC-P8b-default-idle). |
| tests/wedged.test.ts | the threshold is configurable, and its default is 30 minutes | 04-18 | mapped | A typo env falls back to the 30-min default: 31 min silent is news (NC-P8b-default-threshold, NC-P8b-env-fallback). Env half: 04-11. |
| tests/wedged.test.ts | a dead worker's open call is not a wedged call | — | retained | Verbatim in tests/wedged-retained.test.ts. Bounded recovery relaunches a killed worker on a fresh run before any tick. A SIGKILL control never reached this guard, so no entry point shows a dead worker with an open call. |
| tests/wedged.test.ts | a job that is not working is not surfaced | — | retained | Verbatim in tests/wedged-retained.test.ts. Same reason: a dead or settled worker never keeps an open call in the live projection. |
| tests/wedged.test.ts | a run projection written before last_progress_at existed still works | 04-18 | mapped | The silent job's status.json is seeded without last_progress_at; idle falls back to the start (NC-P8b-legacy-progress). |
| tests/wedged.test.ts | an assembled snapshot with no idle measurement is never wedged | — | retained | Verbatim in tests/wedged-retained.test.ts. Older snapshot shape; current assembly always measures idle time. |
| tests/wedged.test.ts | an open ask_operator call is never a wedged call, however long the human takes | — | retained | Verbatim in tests/wedged-retained.test.ts. Workers no longer get ask_operator (cur.3.1; tests/e2e/questions.test.ts skips it), so no live call opens one. |
| tests/wedged.test.ts | review: an open report_result held for review is never a wedged call | — | retained | Verbatim in tests/wedged-retained.test.ts. The planner console review that held report_result open left the planner path in cur.3.1. |
| tests/wedged.test.ts | a bash call silent for 31 minutes is still a notice | 04-18 | mapped | Notice "bash open 31m, silent 31m" and the 31m /status row (NC-P8b-status-row). |
| tests/wedged.test.ts | the exclusion is the tool name from the projection, not a feature flag | — | retained | Verbatim in tests/wedged-retained.test.ts. It needs an open ask_operator call, which no worker can make (cur.3.1). |
| tests/wedged.test.ts | a completed auto-retry is not a wedged tool call | — | retained | Verbatim in tests/wedged-retained.test.ts. pi retries a model call between turns, never inside an open tool call; only a fabricated projection pairs them. |
| tests/wedged.test.ts | an in-flight auto-retry is not a wedged tool call | — | retained | Verbatim in tests/wedged-retained.test.ts. Same reason: a live retry never overlaps an open tool call. |
| tests/wedged.test.ts | an unmatched agent_start is not evidence of a wedged tool call | — | retained | Verbatim in tests/wedged-retained.test.ts. Projection-level: agent_start reaches the notice only through current_tool. No single mutation separates it at the consumer. |
| tests/wedged.test.ts | a healthy job with matched tool counts and recent activity is never flagged | 04-18 | mapped | The closed worker's matched calls and fresh activity raise no notice and no row. |
| tests/wedged.test.ts | a retry across an open tool call restarts the silence clock | — | retained | Verbatim in tests/wedged-retained.test.ts. A live retry never overlaps an open tool call. |
| tests/wedged.test.ts | the retrying exclusion is belt and braces with the progress mark | — | retained | Verbatim in tests/wedged-retained.test.ts. Same reason: no live entry point combines retrying with an open call. |
| tests/wedged.test.ts | tool_execution_update refreshes progress for its own call, and only its own | — | retained | Verbatim in tests/wedged-retained.test.ts. The "only its own" half needs an update for a closed call id, which live pi never emits. Own-call refresh is 04-11 (NC-P8b-wedged-idle). |
| tests/wedged.test.ts | a new tool call starts with a clean progress mark | — | retained | Verbatim in tests/wedged-retained.test.ts. A live call always starts after the previous call's last update, so only fabricated timestamps can show a stale mark. |
<!-- /manifest:assertions -->

<!-- manifest:regressions -->
| ID | Unit file | Guard | Scenario | Control | Evidence | Failing assertion | Fixed |
|---|---|---|---|---|---|---|---|
| NC-P8b-env-parse | tests/bounds.test.ts | src/bounds.ts parsePositiveInt | 04-6 | accept a non-positive env value | — | dispatch of env-typo refused writing an invalid fleet.json | pass |
| NC-P8b-precedence | tests/bounds.test.ts | src/bounds.ts resolveJobHardBounds | 04-6 | env wall clock before the home file | — | home-file bounds deepEqual | pass |
| NC-P8b-missing-field | tests/bounds.test.ts | src/bounds.ts homeWorkerBounds | 04-6 | accept a file with no wall_clock_seconds | — | Missing expected rejection: bad-0 | pass |
| NC-P8b-enforce | tests/bounds.test.ts | src/bounds.ts resolveJobHardBounds | 04-6 | ignore allow_dispatch_override=false | — | Missing expected rejection: enforced-wall | pass |
| NC-P8b-rearm | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch rearm | 04-7 | rearm keeps the spawn round's start | — | the spawn round's 10s passed; the new round has not | pass |
| NC-P8b-count-reset | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch rearm | 04-7 | rearm resets the tool-start count | — | tool-round never failed (timed out) | pass |
| NC-P8b-retrip | tests/bounds.test.ts | src/bounds.ts HardBoundsWatch watch | 04-8 | keep the tripped mark across a respawn | — | timed out waiting for a second bound | pass |
| NC-P8b-notice | tests/bounds.test.ts | src/bounds.ts formatBoundNotice | 04-8 | drop "worktree left untouched" | — | notice does not match /job recorded failed; worktree left untouched/ | pass |
| NC-P8b-legacy | tests/bounds.test.ts | src/revive.ts hardBounds fallback | 04-9 | legacy revive reads the home file | — | legacy-bounds never failed at 4 s (timed out) | pass |
| NC-P8b-mcp-readonly | tests/worker-mcp.test.ts | src/worker-mcp.ts mcpReadOnlyRefusal | 04-10 | pass tools without readOnlyHint | — | planner list includes plain | pass |
| NC-P8b-mcp-destructive | tests/worker-mcp.test.ts | src/worker-mcp.ts mcpReadOnlyRefusal | 04-10 | report destructive tools as not read-only | — | planner destructive reason | pass |
| NC-P8b-mcp-profile | tests/worker-mcp.test.ts | src/worker-mcp.ts withWorkerMcp | 04-10 | give writing profiles the gateway | — | implementer mcp_call deepEqual | pass |
| NC-P8b-mcp-enabled | tests/worker-mcp.test.ts | src/worker-mcp.ts enabledServers | 04-10 | count disabled servers as enabled | — | ro-disabled mcp_call isError | pass |
| NC-P8b-mcp-hidden | tests/worker-mcp.test.ts | src/worker-mcp.ts workerMcpConfig | 04-10 | make hidden servers direct | — | planner list includes mcp__hidden__ | pass |
| NC-P8b-wedged-once | tests/wedged.test.ts | src/wedged.ts WedgedWatch.observe | 04-11 | announce on every tick | — | three notices expected, more observed | pass |
| NC-P8b-wedged-forget | tests/wedged.test.ts | src/wedged.ts WedgedWatch.observe | 04-11 | never forget an unwedged call | — | three notices expected, two observed | pass |
| NC-P8b-wedged-idle | tests/wedged.test.ts | src/status-render.ts isWedgedToolCall | 04-11 | measure open time, not silence | — | every notice is a silence past the threshold | pass |
| NC-P8b-wedged-env | tests/wedged.test.ts | src/wedged.ts wedgedToolCallSeconds | 04-11 | ignore CP_WEDGED_TOOL_CALL_SECONDS | — | three notices expected, none observed | pass |
| NC-P8b-wedged-two | tests/wedged.test.ts | src/wedged.ts formatWedgedNotice | 04-12 | singular header for any count | — | notice does not match the "2 workers" header | pass |
| NC-P8b-mcp-agentdir | tests/worker-mcp.test.ts | src/worker-mcp.ts agentDirOf | 04-10 | ignore PI_CODING_AGENT_DIR | — | ro-missing /doctor finding | pass |
| NC-P8b-mcp-missing | tests/worker-mcp.test.ts | src/worker-mcp.ts readUserMcpServers | 04-10 | treat a missing mcp.json as invalid | — | ro-missing /doctor finding | pass |
| NC-P8b-mcp-quote | tests/worker-mcp.test.ts | src/mcp-access.ts mcpFindings | 04-10 | put the parse error in the finding detail | — | ro-invalid: the finding never quotes the file | pass |
| NC-P8b-default-threshold | tests/wedged.test.ts | src/contracts/limits.ts WEDGED_TOOL_CALL_SECONDS | 04-18 | default threshold one hour | — | the 31-minute silence only: no notice | pass |
| NC-P8b-env-fallback | tests/wedged.test.ts | src/wedged.ts wedgedToolCallSeconds | 04-18 | a non-numeric env value becomes the threshold | — | the 31-minute silence only: no notice | pass |
| NC-P8b-status-row | tests/wedged.test.ts | src/status.ts possibly-wedged row | 04-18 | never render the wedged /status row | — | /status lacks "no progress from bash for 31m" | pass |
| NC-P8b-long-row | tests/wedged.test.ts | src/status-render.ts isLongToolCall | 04-18 | long-call threshold past a day | — | /status lacks "long-running tool call: bash for 1h" | pass |
| NC-P8b-end-clears | tests/wedged.test.ts | src/run-artifacts.ts tool_execution_end | 04-18 | keep current_tool after its end | — | notice is not the "1 worker" notice | pass |
| NC-P8b-legacy-progress | tests/wedged.test.ts | src/status.ts current_tool_idle_seconds | 04-18 | a missing last_progress_at reads as no silence | — | the 31-minute silence only: no notice | pass |
| NC-P8b-default-idle | tests/wedged.test.ts | src/status-render.ts isWedgedToolCall | 04-18 | measure open time, not silence | — | notice is not the "1 worker" notice | pass |
<!-- /manifest:regressions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/worker-lifecycle-p8b.test.ts | P8b | behavior 04 bounds, MCP and wedged notices; 8 runtime cases |
| tests/bounds-retained.test.ts | P8b | 2 declarations retained/moved verbatim; timer skew and open-tool age |
| tests/worker-mcp-retained.test.ts | P8b | 2 declarations retained/moved verbatim; HOME agent dir and URL/credential shaping |
| tests/wedged-retained.test.ts | P8b | 13 declarations retained/moved verbatim; per-declaration reasons above |
<!-- /manifest:incoming -->

<!-- manifest:baseline -->
| File | Disposition | Owner | Evidence |
|---|---|---|---|
| `tests/bounds.test.ts` | deleted | P8b | behavior 04: 9 assertions mapped to 04-6..04-9, 2 retained in tests/bounds-retained.test.ts |
| `tests/worker-mcp.test.ts` | deleted | P8b | behavior 04: 4 assertions mapped to 04-10, 2 retained in tests/worker-mcp-retained.test.ts |
| `tests/wedged.test.ts` | deleted | P8b | behavior 04: 9 assertions mapped to 04-11, 04-12 and 04-18, 13 retained in tests/wedged-retained.test.ts |
<!-- /manifest:baseline -->
