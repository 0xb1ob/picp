# Ledger rows: p14-slice

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P14 (cp-e2e-migration-p14-0w42) | behavior 15: session-start nudges through a real parent (P14-nudges), cp-health alerts raised, withdrawn, acknowledged and relayed through a parent and a cp-bridge operator (P14-alerts), cp-install's model, gateway-key and retired-flag steps on a pty (P14-install, P14-install-models), the parent host's gateway key hand-off (P14-gateway-key), the version view through cp-view, a hosted parent, the cp-bridge footer and /cp-version (P14-version-badge, -running, -live, -lock), scripts/install-tools.ts on a stub PATH (P14-install-tools, -os), and the parent supervisor as cp-parent.service runs it (P14-supervise); 68 declarations from 9 files: 64 mapped, 4 retained verbatim in `tests/version-view-retained.test.ts` and `tests/service-supervise-retained.test.ts`; the PR3c retired install-flag assertions (`RETIRED_INSTALL_FLAGS`) in `tests/service-install.test.ts` moved to P14-install | 9 |
<!-- /manifest:ledger -->

P14 converts behavior 15 file by file in one PR; the files still marked `convert` in `p14.md` are its remainder.

Every scenario runs a copy of this checkout's tracked files with stub host tools on a scratch PATH, a scratch HOME
and a scratch home; cp-install runs on a pty (util-linux `script`) so its /dev/tty prompts are answered. Each
control mutated `src/`, failed on the named assertion, and passed once restored.

<!-- manifest:scenarios -->
| ID | E2E file | Test name |
|---|---|---|
| P14-nudges | tests/e2e/service.test.ts | P14-nudges: session start names missing tools and a host pi drift once, and stays silent on what it cannot tell |
| P14-alerts | tests/e2e/service.test.ts | P14-alerts: cp-health failures become one withdrawable command-post escalation each, relayed to the operator |
| P14-install | tests/e2e/service.test.ts | P14-install: cp-install lists models as the service sees them, asks once per target, and keeps the gateway key 0600 |
| P14-install-models | tests/e2e/service.test.ts | P14-install-models: cp-install's model step on an empty, unreadable or long listing, and a parent that picks off-list or none |
| P14-gateway-key | tests/e2e/service.test.ts | P14-gateway-key: the parent host hands a 0600 gateway.env key only to a gateway home's parent, never echoing it |
| P14-version-badge | tests/e2e/version.test.ts | P14-version-badge: /api/version reads each process's record and the updater's run against the checkout, never a token |
| P14-version-running | tests/e2e/version.test.ts | P14-version-running: /api/job/<id> keeps the checkout's ancestry and each process's started-on commit apart |
| P14-version-live | tests/e2e/version.test.ts | P14-version-live: a hosted parent and its host record the commit they loaded; the footer and /cp-version compare it |
| P14-version-lock | tests/e2e/version.test.ts | P14-version-lock: a live holder's lock without a commit, or with a malformed one, is still a lock |
| P14-install-tools | tests/e2e/install-tools.test.ts | P14-install-tools: install-tools installs only what is missing, once, and never shadows, sudoes or fights pi |
| P14-install-tools-os | tests/e2e/install-tools.test.ts | P14-install-tools-os: brew installs a missing tool on macOS once; another platform is reported, not guessed |
| P14-supervise | tests/e2e/supervise.test.ts | P14-supervise: attach-first parent supervisor — model choice, stop and drain holds, newer generations, exits |
<!-- /manifest:scenarios -->

<!-- manifest:assertions -->
| Unit file | Assertion | Scenario | Disposition | Note |
|---|---|---|---|---|
| tests/install-nudge.test.ts | computeInstallNudge is silent when every required tool resolves | P14-nudges | mapped | NC-in-silent |
| tests/install-nudge.test.ts | computeInstallNudge names the exact install command when a tool is missing | P14-nudges | mapped | NC-in-first; the notice names `npm run doctor:install`, never sudo |
| tests/install-nudge.test.ts | computeInstallNudge lists every missing tool, not just the first | P14-nudges | mapped | NC-in-first |
| tests/install-nudge.test.ts | computeInstallNudge never mutates anything: which is the only call it makes | P14-nudges | mapped | NC-in-installs |
| tests/pi-version-nudge.test.ts | a mismatch warns, naming both versions, the piCompat range and the devDependency as CI's tested pin | P14-nudges | mapped | NC-pv-spelling, NC-pv-advice |
| tests/pi-version-nudge.test.ts | matching versions are silent | P14-nudges | mapped | NC-pv-same |
| tests/pi-version-nudge.test.ts | no resolvable host pi is silent: unknown is not a mismatch | P14-nudges | mapped | NC-pv-ours: the package's own pi is never the host's |
| tests/pi-version-nudge.test.ts | an unreadable host version is silent | P14-nudges | mapped | NC-pv-probe |
| tests/pi-version-nudge.test.ts | an absent or unreadable installed package is silent | P14-nudges | mapped | NC-pv-installed |
| tests/pi-version-nudge.test.ts | it never throws: a probe that explodes is silence, not a failed startup | P14-nudges | mapped | NC-pv-probe: a host pi that exits 1 leaves the session silent |
| tests/pi-version-nudge.test.ts | the host pi is never probed when there is no installed copy to compare it to | P14-nudges | mapped | NC-pv-noprobe |
| tests/service-alerts.test.ts | rollback_failed alerts at once; any other check only after 10 min | P14-alerts | mapped | NC-al-after-900, NC-al-after-0, NC-al-sticky |
| tests/service-alerts.test.ts | two syncs make one open escalation; a changed detail is still one; recovery withdraws it | P14-alerts | mapped | NC-al-dedupe, NC-al-detail, NC-al-withdraw |
| tests/service-alerts.test.ts | an acknowledged alert is not raised again for the same failure; a new key is a new alert | P14-alerts | mapped | NC-al-answered; the relay is `[command-post]` (NC-al-project) |
| tests/service-models.test.ts | parseModelList: rows in order; none available is []; not the table is undefined; unsafe ids dropped | P14-install-models | mapped | NC-md-parse, NC-md-empty, NC-md-notable |
| tests/service-models.test.ts | rubricModels: the shipped rubric's models in row order; invalid JSON is [] | P14-install-models | mapped | NC-md-rubric, NC-md-badjson |
| tests/service-models.test.ts | piDefaultModel: both settings keys, else undefined | P14-install | mapped | NC-md-pidefault; a lone defaultModel adds nothing in P14-install-models |
| tests/service-models.test.ts | modelShortlist: listed only, deduped, in preference order, at most 9; nothing preferred listed falls back to the listing | P14-install-models | mapped | NC-md-shortlist, NC-md-cap, NC-md-fallback |
| tests/service-models.test.ts | modelPrompt: one target, numbered, the first marked recommended, default [1]; a fallback shows as its number, its ref or none | P14-install-models | mapped | NC-md-enter, NC-md-inherit, NC-md-enterref, NC-md-none |
| tests/service-models.test.ts | pickModelReply: empty, a number, a listed ref and none pick; out of range and unlisted refs are errors | P14-install | mapped | NC-md-range, NC-md-unlisted, NC-md-none, NC-md-yes |
| tests/service-models.test.ts | serviceListEnv: HOME, USER, LOGNAME and the unit PATH only — a shell-only provider key never reaches the listing | P14-install | mapped | NC-md-env, NC-md-dedupe |
| tests/service-install.test.ts | parseInstallArgs: each retired tracker flag still parses, is dropped and warns it is deprecated and ignored | P14-install | mapped | both RETIRED_INSTALL_FLAGS on the pty: `--<flag> is deprecated and ignored: the optional tracker step was removed`; NC-rf-note, NC-rf-parse |
| tests/gateway-key.test.ts | gatewayKeyFile: XDG_CONFIG_HOME, else HOME/.config, else undefined | P14-gateway-key | mapped | NC-gk-xdg, NC-gk-home (P14-install), NC-gk-nohome |
| tests/gateway-key.test.ts | validGatewayKey: printable ASCII without whitespace, quotes or backslash, 1-4096 chars; the reason never quotes the key | P14-install | mapped | NC-gk-valid, NC-gk-echo |
| tests/gateway-key.test.ts | readGatewayKey: the rendered key back; a 0644 file is refused naming chmod 600, without the key; absent is neither | P14-gateway-key | mapped | NC-gk-loose, NC-gk-keyline, NC-gk-absent, NC-gk-stderr, NC-gk-logecho; the rendered file: NC-gk-render |
| tests/gateway-key.test.ts | parentGatewayKey: only for a home with data/capacity.json | P14-gateway-key | mapped | NC-gk-capacity, NC-gk-envwins |
| tests/version-records.test.ts | parent.lock: a valid commit round-trips; a malformed one and a pre-cp-kz20 lock without one still parse | P14-version-lock | mapped | NC-pl-commit, NC-pl-legacy; the written commit: NC-pl-write (P14-version-live) |
| tests/version-records.test.ts | parent-host.<gen>.json: the host writes the commit it loaded | P14-version-live | mapped | NC-ph-write |
| tests/version-view.test.ts | green: every process on HEAD, HEAD at a freshly fetched origin/main → ok, latest | P14-version-badge | mapped | NC-vv-gen, NC-vv-fresh |
| tests/version-view.test.ts | amber: origin/main moved on and the updater skipped while busy → warn, N behind (skipped_busy) | P14-version-badge | mapped | NC-vv-quiet |
| tests/version-view.test.ts | #325: the updater's phase and result read as a clocked sentence from state/update.json | P14-version-badge | mapped | NC-vv-settle, NC-vv-phase, NC-vv-retry, NC-vv-dirty, NC-vv-applied |
| tests/version-view.test.ts | #325: the sentence's drain wait, retry factor and defaults match the updater's own constants | — | retained | verbatim in tests/version-view-retained.test.ts; no entry point exposes the updater's own drain wait or retry factor (update.json records neither), so the viewer's mirror can drift unseen |
| tests/version-view.test.ts | ahead and diverged are neutral; a stale host is amber with its restart | P14-version-badge | mapped | NC-vv-ahead, NC-vv-fix |
| tests/version-view.test.ts | red: the operator session is stale, or the update failed, or the fetch keeps failing | P14-version-badge | mapped | NC-vv-session, NC-vv-failures |
| tests/version-view.test.ts | grey: no update.json and legacy records without a commit → unknown, never green; dead pids are down, not unknown | P14-version-badge | mapped | NC-vv-legacy, NC-vv-legacy-green, NC-vv-alive |
| tests/version-view.test.ts | no origin/main: upstream unknown with git's reason, never a throw | P14-version-badge | mapped | NC-vv-noref |
| tests/version-view.test.ts | the git read is cached per repository for 10 s on the injected clock | P14-version-badge | mapped | NC-vv-cache0, NC-vv-cache30 |
| tests/version-view.test.ts | formatTerminal: this session's own loaded commit decides the operator layer | P14-version-live | mapped | NC-ft-own |
| tests/version-view.test.ts | version line: refresh = readVersion then formatTerminal into setStatus; nothing without a UI; cleared on stop | P14-version-live | mapped | NC-ft-key, NC-ft-tick, NC-ft-clear |
| tests/version-view.test.ts | badge: an outdated page lifts ok/unknown to amber with a reload; alert stays red; loading and errors are grey | — | retained | verbatim in tests/version-view-retained.test.ts; badgeView renders only in the viewer page's browser bundle, and the e2e harness has no browser entry point |
| tests/version-view.test.ts | #324: merged vs running here — checkout ancestry and each process's started-on commit stay separate | P14-version-running | mapped | NC-vr-ancestry, NC-vr-from, NC-vr-after, NC-vr-procs |
| tests/version-view.test.ts | GET /api/version: a VersionResponse with no token, csrf or socket from the records it read | P14-version-badge | mapped | NC-vv-leak, NC-vv-detail, NC-vv-fetched |
| tests/version-view.test.ts | #324 GET /api/job/<id>: a merged job carries `running`; a merge this checkout lacks is unknown, never not-running | P14-version-running | mapped | NC-vr-unknown; /cp-version: NC-cv-state, NC-cv-unchecked (P14-version-live) |
| tests/install-tools.test.ts | planOrInstall: every tool already on PATH is ok, and nothing is run | P14-install-tools | mapped | NC-it-verdict, NC-it-idem |
| tests/install-tools.test.ts | planOrInstall: missing tool with a step gets installed, and re-running is idempotent | P14-install-tools | mapped | NC-it-idem, NC-it-landed, NC-it-asset; brew: NC-it-brew (P14-install-tools-os) |
| tests/install-tools.test.ts | planOrInstall: more than one match on PATH is a conflict, never a second install | P14-install-tools | mapped | NC-it-shadow |
| tests/install-tools.test.ts | planOrInstall: dry run plans without mutating and fails preflight when something is missing | P14-install-tools | mapped | NC-it-dry |
| tests/install-tools.test.ts | installExitCode: 0 when ok, 3 for a dry run that only planned installs, 1 when a human must act | P14-install-tools | mapped | NC-it-exit3, NC-it-manual, NC-it-shadow, NC-it-landed |
| tests/install-tools.test.ts | planOrInstall: dry run with everything present reports ok and mutates nothing | P14-install-tools | mapped | NC-it-verdict, NC-it-dry |
| tests/install-tools.test.ts | planOrInstall: git on Linux has no non-sudo path and is reported, not run | P14-install-tools | mapped | NC-it-manual |
| tests/install-tools.test.ts | planOrInstall: unsupported platform is reported, not guessed at | P14-install-tools-os | mapped | NC-it-unsupported |
| tests/install-tools.test.ts | planOrInstall: pi missing while running inside a pi session refuses to touch it | P14-install-tools | mapped | NC-it-session, NC-it-header |
| tests/install-tools.test.ts | planOrInstall: pi missing with no pi session in env falls through to the normal install step | P14-install-tools | mapped | NC-it-agent |
| tests/install-tools.test.ts | runningUnderPi reads PI_SESSION_ID and PI_CODING_AGENT, and only those | P14-install-tools | mapped | NC-it-sessionid, NC-it-agent |
| tests/install-tools.test.ts | describeStep renders a runnable command for every non-manual step kind | P14-install-tools | mapped | NC-it-npmdesc, NC-it-reldesc, NC-it-manual; brew: NC-it-brew (P14-install-tools-os) |
| tests/install-tools.test.ts | formatInstallReport names every tool and the overall verdict | P14-install-tools | mapped | NC-it-verdict, NC-it-header |
| tests/install-tools.test.ts | real script: --dry-run mutates nothing and names every required tool | P14-install-tools | mapped | NC-it-dry, NC-it-verdict |
| tests/install-tools.test.ts | real script: an unknown tool argument is rejected before anything runs | P14-install-tools | mapped | NC-it-unknown |
| tests/install-tools.test.ts | real script: restricting to one already-present tool exits 0 | P14-install-tools | mapped | NC-it-idem, NC-it-retry |
| tests/service-supervise.test.ts | no model: a host running no parent and no CP_PARENT_MODEL or saved model exits 78, starting nothing | P14-supervise | mapped | NC-sv-78 |
| tests/service-supervise.test.ts | start: CP_PARENT_MODEL wins over the saved model; the saved model is the fallback | P14-supervise | mapped | NC-sv-order, NC-sv-logmodel |
| tests/service-supervise.test.ts | start: a data/parent.json model avoids exit 78 with no env or saved model; the supervisor never sends modelExplicit | P14-supervise | mapped | a home with only data/parent.json starts its parent on the file model; modelExplicit's absence is read from its effect (the file model beats CP_PARENT_MODEL in the parent's argv); NC-sv-explicit, NC-sv-logmodel |
| tests/service-supervise.test.ts | start: a parent already running is logged without a model, since it keeps whatever it runs | — | retained | verbatim in tests/service-supervise-retained.test.ts; the host answers `already` only to a parent started between its hello and the start, a race no entry point can stage |
| tests/service-supervise.test.ts | a live foreign lock is retried every 60 s and logged once; any other attach failure exits 1 | P14-supervise | mapped | NC-sv-foreign, NC-sv-once, NC-sv-retry, NC-sv-attachfail |
| tests/service-supervise.test.ts | host lost: a drain file or a stop marker for the watched generation waits without spawning, then joins a newer generation | P14-supervise | mapped | NC-sv-stop, NC-sv-drain, NC-sv-waitonce, NC-sv-newer |
| tests/service-supervise.test.ts | host lost with a stale drained record and no update in flight: stops waiting when it is old or its target is HEAD | P14-supervise | mapped | NC-sv-age, NC-sv-head |
| tests/service-supervise.test.ts | host lost: a draining record, an update in flight, or a fresh drained record keeps waiting | P14-supervise | mapped | NC-sv-state, NC-sv-inflight, NC-sv-fresh |
| tests/service-supervise.test.ts | a blip reconnects to the same live generation | — | retained | verbatim in tests/service-supervise-retained.test.ts; no entry point drops a supervisor's host connection while that host lives |
| tests/service-supervise.test.ts | real host: spawns when none, a second supervisor adds no generation, a stop writes the marker and nothing respawns, SIGKILL exits 1 | P14-supervise | mapped | NC-sv-stop, NC-sv-gone, NC-sv-sigterm |
<!-- /manifest:assertions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/service.test.ts | cp-e2e-migration-p14-0w42 | P14 behavior 15: nudges, service alerts and cp-install through real entry points |
| tests/e2e/version.test.ts | cp-e2e-migration-p14-0w42 | P14 behavior 15: the version view through cp-view, a hosted parent, the cp-bridge footer and /cp-version |
| tests/version-view-retained.test.ts | cp-e2e-migration-p14-0w42 | two verbatim version-view declarations no entry point reaches (browser badge, updater-constant mirror) |
| tests/e2e/install-tools.test.ts | cp-e2e-migration-p14-0w42 | P14 behavior 15: scripts/install-tools.ts on a scratch PATH of logging stubs |
| tests/e2e/supervise.test.ts | cp-e2e-migration-p14-0w42 | P14 behavior 15: node src/service/supervise.ts on scratch homes with the fake parent |
| tests/service-supervise-retained.test.ts | cp-e2e-migration-p14-0w42 | two verbatim supervisor declarations no entry point reaches (connection blip, start race) |
<!-- /manifest:incoming -->

<!-- manifest:regressions -->
| ID | Unit file | Scenario | Control | Failing assertion |
|---|---|---|---|---|
| P14-NC-in-first | tests/install-nudge.test.ts | P14-nudges | install-nudge.ts lists only the first missing tool | every missing tool, and only those |
| P14-NC-in-silent | tests/install-nudge.test.ts | P14-nudges | install-nudge.ts nudges with nothing missing | a full PATH shows no install notice |
| P14-NC-in-installs | tests/install-nudge.test.ts | P14-nudges | install-nudge.ts runs `npm run doctor:install` itself | the nudge ran no installer |
| P14-NC-pv-same | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts warns on equal versions | a full PATH shows no mismatch notice |
| P14-NC-pv-spelling | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts compares the raw first line, no version parse | the drift names 0.84.4 and 0.85.0 |
| P14-NC-pv-ours | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts takes the first pi on PATH, the package's own included | the drift names the host pi's path |
| P14-NC-pv-probe | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts reads a failed probe's output | a host pi exiting 1 shows no mismatch notice |
| P14-NC-pv-installed | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts reads an unreadable installed package as a version | an unreadable installed package shows no mismatch notice |
| P14-NC-pv-noprobe | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts probes the host before reading the installed copy | no probe on a machine with nothing to compare |
| P14-NC-pv-advice | tests/pi-version-nudge.test.ts | P14-nudges | pi-version-nudge.ts drops the `pi update --self` advice | the drift names pi update --self |
| P14-NC-al-after-900 | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts waits 900 s | update and viewer, not the 9-minute disk |
| P14-NC-al-after-0 | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts waits 0 s | update and viewer, not the 9-minute disk |
| P14-NC-al-sticky | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts drops the rollback_failed fast path | update and viewer, not the 9-minute disk |
| P14-NC-al-dedupe | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts raises an open alert again | only the disk alert is new |
| P14-NC-al-detail | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts keys an alert by its live detail | only the disk alert is new |
| P14-NC-al-withdraw | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts never withdraws a recovered alert | the second tick withdrew the viewer alert |
| P14-NC-al-answered | tests/service-alerts.test.ts | P14-alerts | service-alerts.ts raises an answered alert again | the answered alert stays answered |
| P14-NC-al-project | tests/service-alerts.test.ts | P14-alerts | project-report.ts drops the service-health → command-post rule | the command post's own project |
| P14-NC-md-parse | tests/service-models.test.ts | P14-install | models.ts keeps ids MODEL_REF refuses | the unsafe id is dropped from the count |
| P14-NC-md-empty | tests/service-models.test.ts | P14-install-models | models.ts reads "No models available" as no table | skip: no model pi can use as the service sees it |
| P14-NC-md-notable | tests/service-models.test.ts | P14-install-models | models.ts parses any output as a table | skip: gave no model table |
| P14-NC-md-rubric | tests/service-models.test.ts | P14-install | models.ts reads no rubric models | the rubric first, the unsafe id dropped |
| P14-NC-md-badjson | tests/service-models.test.ts | P14-install-models | models.ts reads an unreadable rubric as the shipped model | 13 available, p0/m0 recommended: listed by pi |
| P14-NC-md-pidefault | tests/service-models.test.ts | P14-install | models.ts never reads pi's saved default | 3) openai-codex/gpt-6.1-sol your pi default |
| P14-NC-md-shortlist | tests/service-models.test.ts | P14-install | models.ts caps the shortlist at 2 | 2) and 3) shortlist rows |
| P14-NC-md-cap | tests/service-models.test.ts | P14-install-models | models.ts caps the shortlist at 12 | Choose 1-9 |
| P14-NC-md-fallback | tests/service-models.test.ts | P14-install-models | models.ts never falls back to the listing | 13 available, p0/m0 recommended: listed by pi |
| P14-NC-md-enter | tests/service-models.test.ts | P14-install | models.ts shows one constant default in brackets | Choose 1-3, type a provider/model, or none [1] |
| P14-NC-md-inherit | tests/service-models.test.ts | P14-install | models.ts never passes the parent's pick to the operator | operator prompt or none [2] |
| P14-NC-md-enterref | tests/service-models.test.ts | P14-install-models | models.ts shows an off-list fallback as [1] | an off-list pick is the operator's default by its ref |
| P14-NC-md-none | tests/service-models.test.ts | P14-install-models | models.ts reads "none" as an unlisted ref | operator prompt or none [none] |
| P14-NC-md-range | tests/service-models.test.ts | P14-install | models.ts takes an out-of-range number as the first choice | exit 1 on a reply of 9 |
| P14-NC-md-unlisted | tests/service-models.test.ts | P14-install | models.ts takes any typed ref | fail: x/y is not a model pi can use |
| P14-NC-md-yes | tests/service-models.test.ts | P14-install-models | install.ts prompts under --yes | --yes shows no Choose prompt |
| P14-NC-md-env | tests/service-models.test.ts | P14-install | models.ts passes the whole shell env to the listing | a shell-only key never reaches the listing |
| P14-NC-md-dedupe | tests/service-models.test.ts | P14-install | units.ts keeps a duplicate PATH dir | the unit PATH: node's dir first, deduplicated |
| P14-NC-rf-note | tests/service-install.test.ts | P14-install | install.ts drops the retired-flag warning | `--<retired flag> is deprecated and ignored` |
| P14-NC-rf-parse | tests/service-install.test.ts | P14-install | install.ts stops parsing the retired flags | `--<retired flag> is deprecated and ignored` |
| P14-NC-gk-xdg | tests/gateway-key.test.ts | P14-install | gateway-key.ts ignores XDG_CONFIG_HOME | the key file under XDG_CONFIG_HOME |
| P14-NC-gk-home | tests/gateway-key.test.ts | P14-install | gateway-key.ts uses HOME/.cfg | the key file under HOME/.config |
| P14-NC-gk-valid | tests/gateway-key.test.ts | P14-install | gateway-key.ts accepts whitespace | fail: gateway: --gateway-key-file ...; nothing written |
| P14-NC-gk-echo | tests/gateway-key.test.ts | P14-install | gateway-key.ts quotes the key in its refusal | the refusal never echoes the key |
| P14-NC-gk-render | tests/gateway-key.test.ts | P14-install | gateway-key.ts writes KEY= instead of CP_GATEWAY_ADMIN_KEY= | the CP_GATEWAY_ADMIN_KEY= line |
| P14-NC-gk-mode | tests/gateway-key.test.ts | P14-install | install.ts writes the secret 0644 | the key file is 0600 |
| P14-NC-gk-nohome | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts reads `.config` relative to cwd with no HOME | nowhere to look is no key |
| P14-NC-gk-loose | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts ignores group/other bits | a 0644 key file is refused |
| P14-NC-gk-keyline | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts reads a file with no key line as absent | holds no CP_GATEWAY_ADMIN_KEY= line |
| P14-NC-gk-absent | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts reports an absent file as a problem | an absent key file is neither a key nor a problem |
| P14-NC-gk-stderr | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts drops the host-log line for a refused file | gateway admin key not loaded ... chmod 600 |
| P14-NC-gk-logecho | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts appends the file's text to the chmod refusal | the host log never holds the key |
| P14-NC-gk-capacity | tests/gateway-key.test.ts | P14-gateway-key | gateway-key.ts skips the capacity.json gate | no capacity.json: another home keeps quota off |
| P14-NC-gk-envwins | tests/gateway-key.test.ts | P14-gateway-key | cp-bridge.ts never sets the loaded key on the parent env | a gateway home's parent gets the key |
| P14-NC-pl-commit | tests/version-records.test.ts | P14-version-lock | parent-lock.ts refuses to parse a lock with a malformed commit | a live holder's lock is refused, naming its pid |
| P14-NC-pl-legacy | tests/version-records.test.ts | P14-version-lock | parent-lock.ts refuses to parse a lock without a commit | a live holder's lock is refused, naming its pid |
| P14-NC-pl-write | tests/version-records.test.ts | P14-version-live | parent-lock.ts drops the commit when it writes the lock | the parent's lock carries the commit it loaded |
| P14-NC-ph-write | tests/version-records.test.ts | P14-version-live | parent-host.ts drops the commit from its record | and so does its host's record |
| P14-NC-vv-gen | tests/version-view.test.ts | P14-version-badge | version-view.ts reads the lowest parent-host generation | the host layer is current, not down |
| P14-NC-vv-leak | tests/version-view.test.ts | P14-version-badge | version-view.ts spreads the raw records into the response | the response never holds the token |
| P14-NC-vv-fresh | tests/version-view.test.ts | P14-version-badge | UPSTREAM_FRESH_MS = 60 min | an old fetch proves nothing |
| P14-NC-vv-cache0 | tests/version-view.test.ts | P14-version-badge | GIT_CACHE_MS = 0 | reused for 10 s |
| P14-NC-vv-cache30 | tests/version-view.test.ts | P14-version-badge | GIT_CACHE_MS = 30 s | behind 2 after the cache expires |
| P14-NC-vv-quiet | tests/version-view.test.ts | P14-version-badge | version-view.ts treats every run as quiet | 2 behind (skipped_busy) |
| P14-NC-vv-settle | tests/version-view.test.ts | P14-version-badge | version-view.ts ignores update.json quiet_min | first_seen_at + quiet_min |
| P14-NC-vv-phase | tests/version-view.test.ts | P14-version-badge | version-view.ts never reads the draining phase | phase beats the prior result |
| P14-NC-vv-retry | tests/version-view.test.ts | P14-version-badge | version-view.ts retries after 3× interval | 4× interval_min |
| P14-NC-vv-dirty | tests/version-view.test.ts | P14-version-badge | version-view.ts drops the skipped_dirty sentence | 1 behind (local changes) |
| P14-NC-vv-applied | tests/version-view.test.ts | P14-version-badge | version-view.ts labels an updated run | an applied update adds nothing to the label |
| P14-NC-vv-alive | tests/version-view.test.ts | P14-version-badge | version-view.ts treats every pid as alive | dead pids are down |
| P14-NC-vv-legacy | tests/version-view.test.ts | P14-version-badge | version-view.ts never compares a legacy record to the last update | started before the last update |
| P14-NC-vv-legacy-green | tests/version-view.test.ts | P14-version-badge | version-view.ts reads a legacy record as current | legacy records are unknown, never green |
| P14-NC-vv-detail | tests/version-view.test.ts | P14-version-badge | DETAIL_MAX = 600 | detail is capped |
| P14-NC-vv-fetched | tests/version-view.test.ts | P14-version-badge | version-view.ts counts rolled_back as a fetch | a rollback proves no fetch |
| P14-NC-vv-failures | tests/version-view.test.ts | P14-version-badge | version-view.ts alerts only from 4 fetch failures | fetch failing ×3 |
| P14-NC-vv-session | tests/version-view.test.ts | P14-version-badge | version-view.ts never raises session stale | session stale — restart |
| P14-NC-vv-fix | tests/version-view.test.ts | P14-version-badge | version-view.ts drops the host's restart hint | restart the parent host |
| P14-NC-vv-noref | tests/version-view.test.ts | P14-version-badge | version-view.ts reads a missing origin/main as 0/0 | upstream unknown |
| P14-NC-vv-ahead | tests/version-view.test.ts | P14-version-badge | version-view.ts reads ahead as behind | ahead is neutral |
| P14-NC-vr-unknown | tests/version-view.test.ts | P14-version-running | version-view.ts reads an unknown merge as not_included | a merge this checkout lacks is unknown |
| P14-NC-vr-ancestry | tests/version-view.test.ts | P14-version-running | version-view.ts treats every merge as an ancestor | not_included |
| P14-NC-vr-from | tests/version-view.test.ts | P14-version-running | version-view.ts dates an update whose from already had the merge | since null |
| P14-NC-vr-after | tests/version-view.test.ts | P14-version-running | version-view.ts dates an update recorded before the merge | since null |
| P14-NC-vr-procs | tests/version-view.test.ts | P14-version-running | version-view.ts reads every process as loaded | not_loaded |
| P14-NC-ft-own | tests/version-view.test.ts | P14-version-live | version-view.ts reads this session as current always | this session stale … restart |
| P14-NC-ft-tick | tests/version-view.test.ts | P14-version-live | version-line.ts refreshes only on the 60 s period | the stale line within one 10 s tick |
| P14-NC-ft-key | tests/version-view.test.ts | P14-version-live | version-line.ts writes under another status key | version: latest |
| P14-NC-ft-clear | tests/version-view.test.ts | P14-version-live | version-line.ts leaves the line on stop | the line is cleared when the session stops |
| P14-NC-cv-state | tests/version-view.test.ts | P14-version-live | helpers.ts reads the deployed commit as current | deployed … (stale — rotate at a quiet point …) |
| P14-NC-cv-unchecked | tests/version-view.test.ts | P14-version-live | helpers.ts drops the (unchecked) mark | upstream current (unchecked) |
| P14-NC-it-shadow | tests/install-tools.test.ts | P14-install-tools | install-tools.ts conflicts only past 2 copies | 2 copies: exit 1, nothing downloaded |
| P14-NC-it-idem | tests/install-tools.test.ts | P14-install-tools | install-tools.ts reinstalls a present treehouse/git | an installed tool is never installed again |
| P14-NC-it-dry | tests/install-tools.test.ts | P14-install-tools | install-tools.ts runs steps on a dry run | a dry run plans the download and the npm install |
| P14-NC-it-manual | tests/install-tools.test.ts | P14-install-tools | install-tools.ts runs a manual step | manual is never planned |
| P14-NC-it-session | tests/install-tools.test.ts | P14-install-tools | install-tools.ts skips the pi-session guard | ✗ pi: not on PATH, but … inside a pi session |
| P14-NC-it-agent | tests/install-tools.test.ts | P14-install-tools | install-tools.ts takes any PI_CODING_AGENT as a session | only PI_CODING_AGENT=true marks a session |
| P14-NC-it-sessionid | tests/install-tools.test.ts | P14-install-tools | install-tools.ts ignores PI_SESSION_ID | running inside a pi session (abc-123) |
| P14-NC-it-exit3 | tests/install-tools.test.ts | P14-install-tools | install-tools.ts exits 1 for a planned-only dry run | dry run exits 3 |
| P14-NC-it-landed | tests/install-tools.test.ts | P14-install-tools | install-tools.ts trusts a step that did not land | ✗ pi: ran … but pi is still not on PATH |
| P14-NC-it-npmdesc | tests/install-tools.test.ts | P14-install-tools | install-tools.ts renders the package before the npm flags | would run: npm install -g --ignore-scripts … |
| P14-NC-it-reldesc | tests/install-tools.test.ts | P14-install-tools | install-tools.ts renders a release step without its source | download … from its GitHub release |
| P14-NC-it-verdict | tests/install-tools.test.ts | P14-install-tools | install-tools.ts changes the ok verdict | all required tools are on PATH |
| P14-NC-it-header | tests/install-tools.test.ts | P14-install-tools | install-tools.ts drops the session header wording | running inside a pi session (…); pi will not be reinstalled |
| P14-NC-it-brew | tests/install-tools.test.ts | P14-install-tools-os | install-tools.ts renders brew without the formula | ✓ git: brew install git -> … |
| P14-NC-it-unsupported | tests/install-tools.test.ts | P14-install-tools-os | install-tools.ts guesses the Linux step on another platform | exit 1, no supported install path |
| P14-NC-it-retry | tests/install-tools.test.ts | P14-install-tools | scripts/install-tools.ts drops the retry line | after fixing the above, retry: … pi |
| P14-NC-it-unknown | tests/install-tools.test.ts | P14-install-tools | scripts/install-tools.ts exits 1 for an unknown tool | exit 2 |
| P14-NC-it-asset | tests/install-tools.test.ts | P14-install-tools | scripts/install-tools.ts fetches the latest asset | curl … /releases/download/v<pinned>/<asset> |
| P14-NC-sv-78 | tests/service-supervise.test.ts | P14-supervise | EXIT_NO_MODEL = 1 | no model: exit 78 |
| P14-NC-sv-order | tests/service-supervise.test.ts | P14-supervise | supervise.ts prefers the saved model | started parent … (env/m) |
| P14-NC-sv-explicit | tests/service-supervise.test.ts | P14-supervise | supervise.ts sends modelExplicit | never modelExplicit: the file model reaches the parent |
| P14-NC-sv-logmodel | tests/service-supervise.test.ts | P14-supervise | supervise.ts logs the env model, not the configured one | started parent … (file/m) |
| P14-NC-sv-foreign | tests/service-supervise.test.ts | P14-supervise | supervise.ts exits on a foreign lock | a parent already holds …; retrying every 60s |
| P14-NC-sv-once | tests/service-supervise.test.ts | P14-supervise | supervise.ts logs every retry | logged once across retries |
| P14-NC-sv-retry | tests/service-supervise.test.ts | P14-supervise | FOREIGN_LOCK_RETRY_MS = 30 s | retrying every 60s |
| P14-NC-sv-attachfail | tests/service-supervise.test.ts | P14-supervise | supervise.ts exits 78 on another attach failure | attach failed: exit 1 |
| P14-NC-sv-stop | tests/service-supervise.test.ts | P14-supervise | supervise.ts ignores the stop marker | an operator stop closed generation 1: waiting |
| P14-NC-sv-drain | tests/service-supervise.test.ts | P14-supervise | supervise.ts ignores state/drain.json | state/drain.json is present: waiting |
| P14-NC-sv-waitonce | tests/service-supervise.test.ts | P14-supervise | supervise.ts logs the wait on every poll | waiting without spawning, once |
| P14-NC-sv-newer | tests/service-supervise.test.ts | P14-supervise | supervise.ts rejoins only the watched generation | attached to newer host generation 2 |
| P14-NC-sv-age | tests/service-supervise.test.ts | P14-supervise | STALE_DRAIN_MS = 60 min | an old timed-out drain holds nothing |
| P14-NC-sv-head | tests/service-supervise.test.ts | P14-supervise | supervise.ts never matches the drain target to HEAD | a drain spent on HEAD holds nothing |
| P14-NC-sv-state | tests/service-supervise.test.ts | P14-supervise | supervise.ts lets a draining record go stale | state/drain.json is present: waiting |
| P14-NC-sv-inflight | tests/service-supervise.test.ts | P14-supervise | supervise.ts never sees update.json mid-run | no "stopped holding" while an update runs |
| P14-NC-sv-fresh | tests/service-supervise.test.ts | P14-supervise | supervise.ts takes any drained age as stale | no "stopped holding" for a fresh drain |
| P14-NC-sv-sigterm | tests/service-supervise.test.ts | P14-supervise | supervise.ts exits 1 on SIGTERM | SIGTERM exits 0 |
| P14-NC-sv-gone | tests/service-supervise.test.ts | P14-supervise | supervise.ts exits 0 on a lost host | a lost host exits 1 |
<!-- /manifest:regressions -->
