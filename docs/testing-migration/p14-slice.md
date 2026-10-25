# Ledger rows: p14-slice

<!-- manifest:ledger -->
| PR | Scope | Baseline files deleted |
|---|---|---|
| P14 (cp-e2e-migration-p14-0w42) | behavior 15, first PR: session-start nudges through a real parent (P14-nudges), cp-health alerts raised, withdrawn, acknowledged and relayed through a parent and a cp-bridge operator (P14-alerts), and cp-install's model, gateway-key and retired-flag steps on a pty (P14-install, P14-install-models); 21 declarations from 4 files: 21 mapped, 0 retained; 44 controls; the PR3c `--with-br`/`--no-br` assertions in `tests/service-install.test.ts` moved to P14-install; the other 15 files stay `convert`, owned by the P14 follow-on | 4 |
<!-- /manifest:ledger -->

P14 stopped after four of its nineteen files, well below the ~250 KB cap: the limit was this worker's session budget,
not the size cap or a product blocker. The 15 remaining files stay `convert` for one follow-on job. P14-install
already pins two of `tests/gateway-key.test.ts`'s four declarations (key path, key validation); its other two
(`readGatewayKey`, `parentGatewayKey`) are reached only through a parent spawned by the parent host (`parentEnv`).

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
<!-- /manifest:assertions -->

<!-- manifest:incoming -->
| File | PR | Note |
|---|---|---|
| tests/e2e/service.test.ts | cp-e2e-migration-p14-0w42 | P14 behavior 15: nudges, service alerts and cp-install through real entry points |
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
| P14-NC-br-note | tests/service-install.test.ts | P14-install | install.ts drops the retired-flag warning | --with-br is deprecated and ignored |
| P14-NC-br-parse | tests/service-install.test.ts | P14-install | install.ts stops parsing the retired flags | --with-br is deprecated and ignored |
| P14-NC-gk-xdg | tests/gateway-key.test.ts | P14-install | gateway-key.ts ignores XDG_CONFIG_HOME | the key file under XDG_CONFIG_HOME |
| P14-NC-gk-home | tests/gateway-key.test.ts | P14-install | gateway-key.ts uses HOME/.cfg | the key file under HOME/.config |
| P14-NC-gk-valid | tests/gateway-key.test.ts | P14-install | gateway-key.ts accepts whitespace | fail: gateway: --gateway-key-file ...; nothing written |
| P14-NC-gk-echo | tests/gateway-key.test.ts | P14-install | gateway-key.ts quotes the key in its refusal | the refusal never echoes the key |
| P14-NC-gk-render | tests/gateway-key.test.ts | P14-install | gateway-key.ts writes KEY= instead of CP_GATEWAY_ADMIN_KEY= | the CP_GATEWAY_ADMIN_KEY= line |
| P14-NC-gk-mode | tests/gateway-key.test.ts | P14-install | install.ts writes the secret 0644 | the key file is 0600 |
<!-- /manifest:regressions -->
