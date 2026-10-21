# Always on: the parent and the dashboard under cp-daemon

One process per home, **cp-daemon** (`bin/cp-daemon`, `src/service/daemon.ts`), keeps the parent host (so
the parent and its fleet) and the dashboard viewer running across reboots and crashes, with no operator
terminal, and runs the health watchdog and the auto-updater. It is the only runtime on every machine (cp-txbb):

| Backend | When | What starts cp-daemon |
|---|---|---|
| `systemd` | `systemctl --user is-system-running` is `running` or `degraded` | the thin user unit `cp-daemon.service` (`node <app>/src/service/daemon.ts run`), enabled; systemd restarts it `on-failure`, 5 s growing to 300 s, 6 starts in 30 min → `failed`; exit 78 (bad config) is not restarted |
| `detached` | anything else (a container, WSL without systemd, a VM with no user manager) | `cp-daemon start`: a `setsid` child; after a reboot, the printed reboot command (§Without systemd) |

Inside, an outer process (`daemon-outer.ts`: the lock, the control socket `state/daemon.sock`, the log) runs an
inner runtime (`daemon-runtime.ts`) that owns four roles, plus two more on a home that uses the remote dashboard:

| Role | Runs | Restart |
|---|---|---|
| parent | `node <app>/src/service/supervise.ts` — the attach-first supervisor | on a crash, 5 s growing to 300 s; exit 78 → `failed`; a 7th start in 30 min → `failed` (`start-limit-hit`) |
| viewer | `node <app>/src/viewer/cli.ts --home <home> --require-tailnet --port <port>` | 10 s after any exit, unless the updater holds it |
| device-notify (remote dashboard) | `node <app>/src/push/device-notify.ts` — the pairing-alert sender, only while `data/devices.json` or `data/tunnel.json` exists (started at the daemon's start or the first 5 s tick after one appears) | the parent's rules; held down and released with the viewer during an update; never a readiness condition |
| cloudflared (remote dashboard) | the cloudflared `data/tunnel.json` names, with a fixed argv (`src/service/daemon-tunnel.ts`): quick `tunnel --no-autoupdate --url http://127.0.0.1:<port> --http-host-header 127.0.0.1:<port>`, named `tunnel --no-autoupdate run --token-file <file>`; only while that config is enabled | 5 s growing to 300 s after an unexpected exit (reset once a run registers); stopped by `enabled: false`, an update hold, a reload and a stop; never a readiness condition |
| health (P3) | `node <app>/src/service/health.ts`, a oneshot, 3 min after the daemon starts then every 5 min | the schedule repeats it |
| update (P4) | `node <app>/src/service/update.ts`, a oneshot, 10 min after the daemon starts then every 5 min | the schedule repeats it; it survives the `reload` it asks for |

The pairing-alert sender pushes a "new device paired" alert to every paired device whether or not the parent is
running. It runs no agent and holds no parent lock: it sweeps at start and 5 s after each sweep settles, takes the
one-per-home lease `state/device-notify.lock` (a second sender exits 1 while the holder's pid is alive and still this
script), writes only `state/device-notification-deliveries.json`, and exits 0 on SIGTERM, releasing its lease. Its
env is `CP_HOME`, `CP_MODE`, `PATH` and `CP_DAEMON_ROLE=device-notify` plus the base above — no port, host or model.

The cloudflared controller (remote dashboard PR 2c) reconciles `data/tunnel.json` at the inner's start, on every 5 s
tick and on a hold's release. It runs one attached child, never through a shell, with an env of `PATH` and the base
above (no credential: a named token is only a file path). It publishes `state/tunnel-runtime.json`: the child's pid
and exact command line, the config revision it applied, its state (`starting`, `running`, `restarting`, `stopped`,
`failed`) and the binding. The child is `running` once it logs a registered tunnel connection on its origin. That
origin is `https://<hostname>` for a named tunnel, or the first `https://<label>.trycloudflare.com` a quick one printed.
A new origin bumps the generation and so ends the sessions bound to the old one. Stopping sends SIGTERM, then SIGKILL
after 10 s if no exit was observed. A child recorded by a crashed inner is signalled only while `ps` still shows its
exact recorded command line, and nothing new starts until it is gone. An unreadable config stops the child (`failed`,
with the reason). An unreadable runtime record starts nothing. Child output reaches the daemon log only sanitized
(escapes and control bytes removed, long token-like runs redacted, 300 characters per line, 200 lines per run).
An unreadable runtime record is re-read on every reconcile; a child that never reports its exit 10 s after SIGKILL is
dropped from tracking with a log line. Nothing enables a tunnel until `cp-tunnel up` (PR 2d) writes the config;
`cp-tunnel down` disables it. `cp-install` writes only the `~/.local/bin/cp-tunnel` wrapper (removed by `--uninstall`),
never a tunnel config.

No operator unit (cp-rrye): the dashboard's Start session / Resume last session in tmux runs `tmux new-session
-d -s cp-operator ~/.local/bin/cp-operator` (`-c` to resume) from the cp-daemon-run viewer; cp-install removes
the generated `cp-operator.service` / `cp-operator-resume.service` an older install wrote, never stopping them
(on a legacy home only at M1's success, §Migration).

The configuration is one file, `data/daemon.json` (0600, written only by cp-install): `{schema_version,
generated_by, backend, node, app, home, path, port, viewer_host?, parent_model?}`. The children get only
`CP_HOME`, `CP_MODE=multi`, the installing `PATH`, `CP_VIEWER_PORT`, `CP_VIEWER_HOST` when a host is pinned
(step 3b) and `CP_PARENT_MODEL` when pinned (step 3c) — never a secret — plus `HOME`, `USER`, `LOGNAME` and,
when cp-daemon itself has them, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` (the user manager gave the
legacy units these implicitly; a git/gh credential helper may need the session bus). Nothing else from the
starting shell passes.
The wrapper carries `CP_PARENT_MODEL`/`CP_OPERATOR_MODEL` when pinned; the optional gateway admin key lives only in
`gateway.env` (step 7b). The parent
authenticates through `~/.pi/agent/auth.json`, as it does today. cp-daemon and its children never
dispatch, decide or merge, and never write the fleet, the ledger, mandates or
escalations; the only host ops they use are `hello` and `start`, and the
updater's `drain`, `drainCancel`, `stop` and `doctor` (§Auto-update).

## Install

One command, idempotent, never `sudo`:

```sh
# a fresh machine: checks git + node 24, fetches the code, npm ci, then bin/cp-install
curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/bin/cp-bootstrap | sh
curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/bin/cp-bootstrap | sh -s -- [flags]
# from any checkout: bin/cp-install is the same command
bin/cp-install [flags]
sh scripts/install.sh [flags]
```

`bin/cp-bootstrap` (POSIX sh) clones or fast-forwards `--app DIR` (or `--app=DIR`), else `$CP_APP` (default
`~/.pi-command-post/app`), refuses a dirty, off-`main` or ahead checkout, runs
`npm ci` there and execs `bin/cp-install --app <app>` with every flag.

`scripts/install.sh` first refuses a missing git, or node missing or older than 24, before cloning anything (the
same checks as bootstrap). It places the code at `~/.pi-command-post/app` (or `--app DIR`):
it clones `main` when absent (URL: `CP_REPO_URL`, else the running checkout's
`origin`), refuses an existing checkout whose `origin` differs, and fast-forwards
only a clean `main` that is not ahead of `origin/main` (otherwise `skip`, naming
why). It then runs `node <app>/src/service/install.ts`, which prints one
`ok|changed|skip|fail: <step>: <detail>` line per step:

1. preflight: node 24 or newer (checked only, never installed), `git`, then the backend
   (`ok: service: systemctl --user is running: cp-daemon runs as cp-daemon.service`, or detached, naming why);
2. `npm ci` when `node_modules/.package-lock.json` does not match `package-lock.json` (an optional package
   absent for this platform still matches) or with `--force`;
3. `scripts/install-tools.ts`: the required tools (`REQUIRED_TOOLS`: git, treehouse, pi, gh), no prompt.
   treehouse is required, not optional — every dispatch leases a treehouse worktree. pi must be in
   `package.json` `piCompat` (`{min, testedMax}`, read by `src/pi-compat.ts`, the one classifier install-tools,
   `/doctor`'s `host.pi.compat` and `cp_project add`'s readiness share). Its probe is `pi --version` plus the
   command-post extension load in a scratch home (about 2 s). Below `min`: asks, then runs `pi update --self`
   (`--yes` consents; `--no-prompt` declines; `--no-pi-upgrade` and a run inside a pi session refuse, exit 1); never
   a downgrade. A newer major than `testedMax`, or a failed probe: refused naming the range, unless `--force`
   (a warning; the final doctor then accepts `host.pi.compat` as its only error). Newer within `testedMax`'s
   major with the probe passing: a warning only. Then:
   A newer pi released over 7 days ago with no open `qualify pi <version>` PR adds a `host.pi.drift` warning
   (`src/pi-qualify.ts`; never an error). The daily pi-version-watch recipe is `prompts/schedules/pi-version-watch.md`.
   - `gh auth status --active` (only the active account; else `gh api user`); logged out → prints `gh auth login` for you (never run);
   - the pi-lens host tools (`PI_LENS_TOOLS`, shared with `/doctor`) with `npm i -g`; a global
     prefix that needs sudo is a `fail` naming the fix, and nothing is run;
   - every pi package a worker role loads (`ROLE_PACKAGES`) missing from
     `~/.pi/agent/settings.json` → `pi install npm:<name>` (pins kept; your other packages and
     their order untouched; settings.json is never edited here). `--no-pi-packages` skips;
   - `tmux` is reported, never required;
3a. provider login, before those extras and before anything is written: `pi --no-extensions --list-models` with
   cp-daemon's env. No usable model → exit 4 with one `fail: login:` line ending "run `pi`, then /login, then
   re-run: <the exact cp-install command>"; nothing is written or started. A listing that exits nonzero with no
   provider in `~/.pi/agent/auth.json` is the same exit 4. A dry run, `--no-start`, an unrecognized listing, or a
   failed one with an `auth.json` provider reports those providers instead (credentials never handled).
   A failed clone, `npm ci` or tools step likewise names its exact rerun;
3b. the viewer host (`CP_VIEWER_HOST`, see below);
3c. the models (`CP_PARENT_MODEL`, `CP_OPERATOR_MODEL`, see below);
4. the home (default `~/.pi-command-post`, 0700); systemd's `WorkingDirectory=` takes no quotes, so a home
   path with whitespace, a quote, a backslash or a control character is a `fail`;
5. `data/daemon.json`, then (systemd) `cp-daemon.service` and the operator units in `~/.config/systemd/user/`, and
   6. the wrapper `~/.local/bin/cp-operator` — identical → `ok`, absent → written, **different → refused
   without `--force`** (`fail: … differs from what this install renders; rerun with --force to replace it`), and
   then nothing at all is written or started. A home still on the legacy cp-* units passes the migration
   preflight first (§Migration);
7. `data/update.json` `{"enabled": true, "interval_min": 15}` only when absent
   (`--no-update` → `false`; read by the update job, §Auto-update);
7b. the optional sub2api gateway (see below);
8. systemd: linger, checked before step 4 writes anything (`loginctl enable-linger`; if refused it prints the
   `sudo` line, runs nothing and stops: no `data/daemon.json` or unit is left behind);
9. systemd: a legacy home migrates here (§Migration); otherwise `daemon-reload`, `enable --now cp-daemon.service`
   (`enable` only with `--no-start`), `try-restart` when `data/daemon.json` or the unit was replaced this run.
   Detached: `cp-daemon start` when stopped, `restart` when running and replaced, then the reboot command
   (and, with `--crontab`, its `@reboot` line). Either way cp-daemon must be ready within 60 s — the outer
   running, the inner `ready`, the parent and viewer roles `running` — else
   `fail: enable: <why> after 60s; see cp-daemon log` with the log tail;
10. `--push-origin URL` (flag only, never a prompt) with no `data/push/config.json` → `scripts/push-init.ts`;
11. waits ≤ 90 s for the host's parent and prints its `/doctor`, then `cp-daemon status`. Both waits print a
   `… <step>:` line first and `still waiting (Ns)` every 5 s. A fresh home's not-yet-run watchdog is an `ok`
   `service.health` line, not a warning.
12. one summary: `ready:` (cp-daemon ready and `/doctor` passed, with the dashboard URL) or `incomplete:` (with the
   rerun), then `optional steps left (N):` listing every `skip:` step, plus `--crontab` on a host without systemd.

Flags: `--home --app --port --parent-model --operator-model --viewer-host --gateway-url --gateway-key-file --push-origin --force --no-start
--crontab --no-update --uninstall --dry-run --yes --no-prompt
--no-pi-packages --no-pi-upgrade --no-self-package` (`--no-self-package` is accepted and has no effect: the self-package step went with single-project mode). Prompts read `/dev/tty`, so `curl | sh`
still asks; with no terminal, `--yes`, `--no-prompt` or `--dry-run` every prompt
takes its default. `--dry-run` probes and prints and changes nothing (the code
step too: it never runs `git fetch`, so an existing checkout prints "would fetch"; it never runs `gh` or `pi`,
which write their own state under `HOME`, so gh login and the model list are reported unchecked; a required
tool a real run would install is printed and the plan goes on). cp-daemon is started (step 9) only when no
earlier step failed, and a failed step-3 prerequisite or a refused gateway (7b) stops the install before
step 4, leaving no `data/daemon.json`, unit or wrapper behind. A second run reports every step `ok`/`skip`. Never `sudo`: a step that
needs it prints the line for you.

### 3b. The viewer host

The dashboard serves write controls (operator message, Start session, schedule
controls) to anyone who can reach it (`docs/contracts.md` §Dashboard control),
so its bind address is a choice the installer makes with you. First match wins:

1. `--viewer-host IP` — an address on one of this machine's interfaces
   (`os.networkInterfaces()`), in Tailscale/CGNAT `100.64.0.0/10`, private
   `10/8`, `172.16/12`, `192.168/16`, ULA `fc00::/7` or loopback. A wildcard
   (`0.0.0.0`, `::`), link-local, public, IPv4-mapped or zoned address, a
   hostname, or an address not on this machine is `fail: viewer-host:` before
   `npm ci`, and nothing is written.
2. The previous install's choice, read back from `data/daemon.json` `viewer_host` (on a legacy home, its
   generated `cp-view.service`; else the wrapper): kept, never asked —
   `ok: viewer-host: <ip> kept from <home>/data/daemon.json`, or `skip: … none pinned`.
3. A fresh install asks once, listing this machine's Tailscale address
   (recommended: only devices on your tailnet reach it), its other private
   addresses (anyone on that network reaches it) and loopback (this machine
   only) as numbered choices; Enter takes the recommendation, a number picks,
   a typed IP is checked as in 1. With `--yes`, `--no-prompt`, `--dry-run` or
   no terminal the Tailscale address is pinned when there is one; otherwise
   nothing is pinned and cp-daemon's viewer looks for `tailscale ip -4` at every
   start. A LAN or loopback address is never picked without you choosing it.

A pinned host is written as `viewer_host` in `data/daemon.json` — cp-daemon passes `CP_VIEWER_HOST=<ip>` to
the viewer, the parent supervisor, health and update — and exported by the `cp-operator` wrapper, so the viewer,
the watchdog, the updater's verify and board links agree on one address.
Changing it needs `--viewer-host <ip> --force`; the running parent host picks
it up at its next restart (`cp_parent stop` + start), since restarting cp-daemon
restarts only the supervisor, never the host. Unpinning is
`--uninstall`, then a reinstall. On a legacy home, a `cp-view.service.d` drop-in that sets
another `CP_VIEWER_HOST` is reported by the migration preflight, never adopted or edited. For a LAN
bind, `data/dashboard-control.json` `{"enabled": false}` stays the kill switch.
`cp-view --require-tailnet` applies the same policy at start: a hand-edited
`CP_VIEWER_HOST=0.0.0.0` (or a public or non-IP `--host`) exits instead of serving.

**Opening the dashboard through a proxy (Coder port-forward, etc.).** It just works: the viewer serves whatever name
the proxy forwards as Host (`https://8766--…/`), and the controls accept that page's own origin. Keep the proxy
owner-only — whoever gets through it has full local control, with no device pairing. Pairing and revoking devices
stay on the bind address. `data/viewer.json` `{"strict_host": true}` (Settings → viewer) restores the Host check and
with it the DNS-rebinding guard; the proxy then gets 421. `/doctor` `[viewer-host]` says which is in force.

### 3c. The models

Two choices from one list: the parent (`parent_model` in `data/daemon.json`, `CP_PARENT_MODEL` in the
wrapper) and the operator session (`CP_OPERATOR_MODEL` in the wrapper, which
`bin/cp-operator` turns into pi's `--model`). The candidates are what
`pi --no-extensions --list-models` lists, run with the environment cp-daemon's children
have (`HOME`, `USER`, `LOGNAME`, the installing `PATH`): a provider key exported only
in your shell never reaches the service, so it is never offered. Per target,
first match wins:

1. `--parent-model M` / `--operator-model M` — each sets only its own target,
   except a lone `--parent-model` on a fresh install, which sets both. A value pi does not list is `fail: model:`; with an empty or unreadable
   listing it is written with a `skip: model: … written unchecked` note.
2. An existing install keeps what it pins (`data/daemon.json`, a legacy `cp-parent.service`, the wrapper: `ok: model: … kept`);
   an unpinned one stays unpinned (`skip`) unless `--force`, which re-opens only
   unpinned choices. A pinned choice is never re-asked.
3. A fresh install asks the parent's model, then the operator's, from the same numbered list (at most 9): the parent's own default
   first (`CP_PARENT_MODEL`/`PI_PROVIDER`+`PI_MODEL` in the installing env, then the
   saved `cp-parent-control.json` model), then the routing rubric's models
   (`data/routing.json`, else `defaults/routing.default.json`), then pi's saved
   default (`settings.json` `defaultProvider/defaultModel`), else the first
   listed — each only when pi lists it; the first is recommended. Enter takes it
   for the parent; the operator's question defaults to the parent's pick, so Enter twice
   pins one model for both. A number or a listed `provider/model` picks, `none` pins nothing, anything
   else fails and writes nothing. `--yes`, `--no-prompt` or no terminal take the
   recommendation for both (`changed: model: parent <m> (recommended: …; --parent-model overrides)`).

No listed model stops a starting install at step 3a (above); with `--no-start` it prints
"run `pi`, then /login, then rerun cp-install" and pins nothing, and after the login the rerun
must be `cp-install --force` (a plain rerun keeps
the unpinned choice and lists nothing; `--force` also runs `npm ci` and replaces generated files that differ). Changing a pin needs the flag and `--force`; it applies at the next
session and host start. `settings.json` is never edited.

### 7b. The optional gateway

Opt-in, never asked: without flags the step is `skip: gateway: not set up …; add
it later: cp-install --gateway-url https://<gateway> --gateway-key-file <file>`.
`--gateway-url` (an https origin, no user, path, query or fragment) writes
`data/capacity.json` `{"url", "path": "/api/v1/admin/ops/concurrency"}` (0600)
once. The admin key comes only from `--gateway-key-file` (its first line) —
never an argv value, a prompt or the environment — and is copied to
`${XDG_CONFIG_HOME:-~/.config}/pi-command-post/gateway.env` (0600 in a 0700
dir, outside the home and every unit); it is never printed. A url without an
obtainable key fails and writes nothing. A rerun keeps both (`ok`); another url
or key needs `--force` (`--force` replaces capacity.json's `url` only). No unit
changes: the parent host loads the key when it spawns a parent (`parentEnv`,
`docs/contracts.md` §Advisory gateway capacity), so it applies at the next parent
start (`cp_parent stop` + start, a relaunch or an update restart). Removal is by
hand: delete `data/capacity.json` and `gateway.env`.

**A home that keeps its own checkout** (a `CP_HOME` home such as
`/home/ubuntu/workspace/pi-command-post`) installs against itself:

```sh
sh scripts/install.sh --home /home/ubuntu/workspace/pi-command-post --app /home/ubuntu/workspace/pi-command-post --dry-run
sh scripts/install.sh --home /home/ubuntu/workspace/pi-command-post --app /home/ubuntu/workspace/pi-command-post
```

With a host already running, the supervisor joins it: the highest
`state/parent-host.<gen>.json` stays the same and no second parent starts.

## Uninstall

`sh scripts/install.sh --uninstall` stops cp-daemon (`disable --now cp-daemon.service`, or `cp-daemon stop`),
removes the files it wrote — `cp-daemon.service`, any leftover legacy cp-* unit, the operator units (never
stopped: a running operator session in tmux stays up), the wrapper (a file it did not write stays) and, last,
`data/daemon.json` — and, detached, removes only its own `# cp-daemon <home>` crontab line. It never touches the rest of
the home or the app. The running host, parent and workers stay up (cp-daemon stops only the supervisor); you
are back on the manual `bin/cp-operator` path. A `gateway.env` is kept and named (`skip: uninstall: … kept`):
remove it yourself.

## Migration

A home installed before cp-txbb runs six legacy units: `cp-parent.service`, `cp-view.service` and the
`cp-health`/`cp-update` service+timer pairs. Auto-update never reruns the installer, so such a home pulls the
new code under its legacy units (they keep working; `/doctor` warns `service.legacy_units`) and every later
legacy `cp-update.service` run records `migration_required` and changes nothing. Its health watchdog skips
the supervisor probe (no `state/daemon-runtime.json`) until migrated.

**M1 — rerun `cp-install` (the primary path).** On the systemd backend with any legacy generated file in
the unit dir, before anything is written:

- every legacy file present must carry `Generated by cp-install` (else refused: hand-written unit);
- `cp-update.service` must not be active (else refused: an update run is in flight; rerun after it finishes);
- `state/update.json` must be `idle`, or `--force` (a dead run is recovered by cp-daemon's first update job);
- a `cp-view.service.d` `CP_VIEWER_HOST` drop-in and `state/drain.json` are reported, never acted on.

Then: write `data/daemon.json` and `cp-daemon.service` (pins kept from the legacy units), `daemon-reload`,
`disable --now` both timers, re-check `cp-update.service` (a timer may have fired: re-enable the timers and
fail), `disable --now cp-view.service`, `disable --now cp-parent.service` (`KillMode=process`: only the
supervisor gets SIGTERM; host, parent and workers keep running), `enable --now cp-daemon.service`, and verify
it ready within 60 s. Only then are the six legacy files removed, with a generated `cp-operator.service` /
`cp-operator-resume.service` (cp-rrye; removed, never stopped, so a live tmux session keeps running; a
hand-written one stays), and
`changed: migrate: …` printed. `--dry-run` prints the whole plan. `--no-start` migrates nothing: the legacy
units keep running untouched, no `data/daemon.json` is written, and the step says "rerun without --no-start
to migrate".

**Rollback.** When `enable --now cp-daemon.service` or the 60 s verify fails: `disable --now
cp-daemon.service` (the host is untouched), remove its unit **and `data/daemon.json`**, `daemon-reload`,
`enable --now` the four legacy units (their files, and the operator units', were kept), wait for cp-parent and cp-view to be active,
and fail with the cp-daemon log tail. `data/daemon.json` is removed so the legacy updater keeps recording
`migration_required` rather than refusing to run.

**Caveat.** The live host stays in the old `cp-parent.service` control group until the next update replaces
it. Never run `systemctl --user stop|kill cp-parent.service` on a migrated home.

**M2 — manual, the fallback:**

1. optional: `cp_parent drain`;
2. `systemctl --user disable --now cp-health.timer cp-update.timer cp-view.service cp-parent.service`;
3. `sh scripts/install.sh --force <same flags>`;
4. `cp-daemon status`.

To roll back M2: `git -C <app> checkout <previous tag/sha>`, then rerun the install from that checkout; it
rewrites the legacy units.

## Remote dashboard (opt-in): `cp-tunnel`

Off by default: a home where `cp-tunnel up` never ran has no tunnel, no remote listener and no device routes, and
the loopback/tailnet dashboard is unchanged. Turning it on publishes the dashboard on an HTTPS address through
Cloudflare; only paired devices get past its gate. Contract: [`docs/contracts.md`](contracts.md) (Remote devices).

> **A Full-control remote device is trusted like your terminal. The dashboard's pairing and device APIs prevent remote
> devices from creating additional devices; this does not prevent shell actions requested through the operator agent.
> Use View only for a less-trusted device.**

Prerequisite: cp-install ran (the tunnel runs under cp-daemon; `cp-tunnel up` starts a stopped daemon, it never
installs one). cloudflared comes from `PATH` when compatible, else a checksum-verified official binary is installed
under `<home>/.pi-command-post/bin/`.

**Quick tunnel** (no Cloudflare account): `cp-tunnel up`. stdout prints the `https://….trycloudflare.com` origin; a
one-use pairing QR and link (five minutes) go to the controlling terminal only. Limits: the hostname changes whenever
cloudflared restarts (`up`, a daemon restart or reload, a crash) and every device must then pair again; there is no
uptime guarantee; Quick Tunnels carry no SSE, so the remote dashboard polls every 2 s while visible. Push stays where
it was.

**Named tunnel** (stable hostname), automated: create a Cloudflare API token (My Profile → API Tokens → Create Custom
Token) with exactly two permissions, **Account › Cloudflare Tunnel › Edit** and **Zone › DNS › Edit** (limit both to
the account and zone you use), save it to a file, then
`cp-tunnel up --hostname cp.example.com --api-token-file ~/cf-token`. One command finds the zone, refuses if any DNS
record already exists for the hostname (except this home's own CNAME, so a re-run is idempotent), creates or reuses
the tunnel `picp-<home id>`, writes its ingress (`http://127.0.0.1:<remote port>`, Host header the same), adds the
proxied CNAME, fetches the run token into `data/tunnel/token` (0600) and records the hostname, tunnel, zone and account
ids in `data/tunnel.json`. The API token is held in memory only: never saved, logged or echoed. If a step after the
tunnel exists fails, the tunnel stays; re-run the same command. Afterwards, delete the API token in Cloudflare; it is
only needed to change the hostname. A 403 names the missing permission.

`cloudflared tunnel login` is not used: its `cert.pem` can manage every tunnel in the account, the API token only
what its two scopes allow.

Manual fallback: create a tunnel and a public hostname for it in the Cloudflare dashboard, with that public hostname's
Service set to `HTTP` → `127.0.0.1:<remote port>` (default `127.0.0.1:8767`; the port `cp-tunnel up` uses,
`--remote-port`). The remote listener answers Host `127.0.0.1:<port>` or the configured hostname (any case, bare or
`:443`) and 421 to any other name. Save the tunnel token to a file, then
`cp-tunnel up --hostname cp.example.com --token-file ~/tunnel-token`. The token is copied to `data/tunnel/token`
(0600) once cloudflared is provisioned; your file is not needed afterwards.

Either way, Web Push can move to the named origin only with consent: `--push-origin accept`, or "y" at the prompt (no
terminal or no answer keeps the current push origin and keys). Optional: put Cloudflare Access in front of the
hostname for a second sign-in; the device gate still applies behind it.

**Pairing.** `cp-tunnel pair [--level full|view]` (terminal), or Settings → **Devices** → Add device on this machine's
or a tailnet dashboard (it shows the QR in the page). Open the link on the new device and give it a name. Full control
is the default; choose View only for anything you would not hand your terminal. A remote device can never add a device.
Every new pairing shows "New device paired" on every paired dashboard and sends a push where push is set up and the
device subscribed; each recipient's state (pending, delivered to push service, not subscribed, unavailable, retrying,
failed, expired, revoked) is shown, never assumed.

**Revoke and recovery.** `cp-tunnel devices` lists, `cp-tunnel revoke <name-or-id>` (or Revoke in Settings → Devices,
Full control or local only) ends a device's session at its next request and closes its stream within 2 s. A lost phone:
revoke it, then check the operator transcript for requests it sent (each is labelled with its device). `cp-tunnel
status` shows the tunnel and the viewer's ack; `cp-tunnel down` stops the tunnel and closes the remote listener (pending
pairing alerts still go out). On a machine without a tailnet address the viewer runs **remote-only** while the tunnel is
enabled: no local listener, health probed through the device socket. `cp-daemon status` shows the `device-notify`
sender; `/doctor` warns when it failed.

## Without systemd

The detached backend has no outer watchdog: if the cp-daemon outer itself dies, nothing restarts it until
you do (`cp-daemon start`; `/doctor` warns `service.daemon`). Its children are still restarted by it as above.
After a reboot, run the command cp-install and `cp-daemon status` print — no root needed, absolute node, so
fnm shells do not matter:

```sh
"<node>" "<app>/src/service/daemon.ts" start --home "<home>"
```

`--crontab` (opt-in) appends `@reboot <that command> >/dev/null 2>&1 # cp-daemon <home>` to your crontab
when absent (written through `state/daemon-crontab.tmp` + `crontab <file>`); a crontab that cannot be read
is a `skip` naming the command. Without `--crontab`, crontab is never touched.

## The operator session: `cp-operator`

The generated wrapper is
`export CP_HOME=<home> CP_MODE=multi CP_OPERATOR_VIEWER=service; cd "$CP_HOME"; exec <app>/bin/cp-operator "$@"`,
so it runs from any directory — inside another git repository too — against
this home in multi mode. It is not named `cp` (that would shadow coreutils in
`~/.local/bin`); `alias cp-o=cp-operator` if you like.

- At `session_start` the session attaches **read-only** to the running host: it
  never spawns one. The host's relay backlog (≤ 200 relays, kept while nobody
  was subscribed) arrives as `cp-bridge` messages. A closed connection (a
  `cp-daemon reload`, a host restart) re-attaches read-only on its own, with a 1 s backoff doubling to a 30 s
  cap, for as long as the session lives; it never starts a host or parent and needs no `cp_parent` call. The
  status line says `cp-parent: reattached (pid <host>)` once, and every open escalation the session never
  received (raised in the gap) is relayed once through the escalation relay ledger.
- `CP_OPERATOR_VIEWER=service`: `cp-view.service` serves the dashboard, so the
  session starts no competing viewer.
- **No session running** (P3): the dashboard says *operator session offline · N
  held*; composer sends wait in `state/operator/inbox.jsonl` and arrive once, as
  one dated message, at the next session start (older than 24 h: dropped and
  listed). **Start session** on the Overview line or the composer starts one —
  in herdr or in tmux, below (never on a message alone: a session spends model
  tokens). With neither available the button is disabled and says why
  (`docs/contracts.md` §Dashboard control).

### Start from the dashboard: herdr or tmux

The offline line and the composer show **Start in herdr** and/or **Start in
tmux**, one button per launcher this home has (`GET /api/operator/control`
`launchers`); `/doctor` prints `service.launchers` (tmux yes/no, herdr binary
yes/no, herdr server running yes/no). The click posts `{"via": "herdr"}` or
`{"via": "tmux"}` — nothing else reaches a command.

- **tmux** (cp-rrye) — needs the viewer cp-daemon runs (its `CP_DAEMON_ROLE=viewer`; a legacy `cp-view.service`
  or a hand-run `bin/cp-view` never starts tmux: the session would live and die in that viewer's cgroup or
  terminal), the absolute `tmux` on the viewer's PATH (the installing PATH) and the wrapper. Runs
  `<tmux> new-session -d -s cp-operator <absolute ~/.local/bin/cp-operator>` directly, on both backends, with
  the viewer's env minus `CP_DAEMON_*` (the wrapper sets `CP_HOME`, `CP_MODE` and `CP_OPERATOR_VIEWER`). An
  existing `cp-operator` tmux session is 409 `already_running`. Under systemd the tmux server joins
  `cp-daemon.service`'s cgroup and `KillMode=process` keeps it across a daemon stop or restart; detached, tmux
  daemonizes on its own. Attach: `tmux attach -t cp-operator`.
- **herdr** — needs the absolute `herdr` on the viewer's PATH (the installing
  PATH) and its background server running (`herdr status server`; it is not a
  systemd unit, so after a reboot start herdr once). Runs `herdr workspace create
  --cwd <home> --label cp-operator --env CP_HOME=<home> --no-focus`, then
  `herdr pane run <pane> "'<absolute ~/.local/bin/cp-operator>'"` (one sh-quoted command
  argument: herdr would parse a loose `--session` itself); if that fails the new
  workspace is closed. Attach: open herdr → workspace `cp-operator`.
  cp-install suggests `herdr integration install pi` (sidebar agent state,
  session resume) and never runs it; workers start with `--no-extensions`, so
  the global `~/.pi/agent/extensions` file it writes never loads in a worker.

**Resume last session in herdr/tmux** sits after the Start buttons (`resume` in
the control status). The click posts `{"via": …, "resume": true}`; only a
literal `true` is taken and the only change is the fixed `-c` on the wrapper, so
pi continues this home's most recent session — and, with no previous session,
starts a fresh one (the button's line says so). herdr types
`'<cp-operator>' '-c'`; tmux runs `<tmux> new-session -d -s cp-operator <cp-operator> -c`
(same session name).

**Restart session** (cp-aqxl) shows while an operator session runs (`restart` in the control status: `supported`,
`blockers`, `reason`). Two taps (the second names the session file) post `POST /api/operator/restart`
`{"restart": true}` with the CSRF token through the same guard chain as a message, one accepted restart per 60 s.
The viewer only forwards one `restart` frame to the session's control socket; it spawns, signals and locates no
process. The bridge journals the request, refuses with the reason while the kill switch is off, while the session is
busy or has queued messages, while a dashboard message or answer click is not yet seen by the session, or while a
`cp_parent send` from the last 24 h has no observed outcome (an unreadable outbox refuses too). Otherwise it writes
`state/operator/relaunch.json` (0600: `{version, id, pid, session_file, at}`) and calls pi's own `ctx.shutdown()`
once compaction is idle. `cp-operator`, the parent of that pi, relaunches it in the same terminal with exactly
`--session <file>` (`-c` if the file is gone) only when the marker names the pid of the child that just exited; at
most 3 relaunches in 10 min, then it prints how to resume by hand. A signalled `cp-operator` never relaunches. A pi
not started by a relaunching `cp-operator` (no `CP_OPERATOR_RELAUNCH_FILE`) reports unsupported: `/quit`, then
`cp-operator -c`, once. The page follows the restart (stopping → relaunching → restarted, by a new
`session_started_at`) and blocks the composer meanwhile; after 90 s it says where to look.

## Stop, drain, restart

- **Stopping the fleet stays `cp_parent drain` + `cp_parent stop`.** A
  completed `stop` writes `state/parent-host.stopped.json` `{gen, at}` before
  the host exits; the supervisor then waits without spawning (polling every
  10 s) and joins a newer generation when `cp_parent start` makes one.
- While `state/drain.json` exists, a host loss also waits without spawning.
  A boot starts regardless: the boot is the restart the drain prepared, and
  the parent's `session_start` reports and clears it.
- A `drained` or `timeout` record does not wait forever (cp-drain-stale-record-3): with no update run in flight
  (a live updater in `daemon-runtime.json`, or `state/update.json` mid-run) the supervisor stops waiting once
  `finished_at` is over 15 min old or the record's auto-update target is the checkout HEAD, logs why, and exits 1
  so cp-daemon respawns the host and parent; the new parent's startup clears the record. It never deletes the
  file, and a `draining` record or a stop marker keeps the wait. If the updater's own restart fails after a
  drain (`drain_timeout` with a failed `drainCancel`, a `rollback_failed` after the rollback's drain), this
  rule is what covers the leftover record; `update.ts` is unchanged.
- `cp-daemon stop` / `start` / `restart` (`--home H`, else `CP_HOME`, else — `bin/cp-daemon` run from an installed
  home's `<home>/app` with `<home>/data/daemon.json` present — that enclosing home; on the systemd backend they run
  `systemctl --user stop|start|restart cp-daemon.service`) stop and start the **daemon** only: it SIGTERMs the
  supervisor (disconnect, exit 0; `KillMode=process`), and host, parent and workers stay up. `cp-daemon
  reload` replaces only the inner runtime (supervisor and viewer restart) from the code on disk; the outer, its
  lock and socket stay. stop/restart/reload refuse while an update is in flight unless `--force`. `cp-daemon
  status` exits 0 running, 3 not, and prints the start command.
- A host that dies unexpectedly (`kill -9`): the supervisor exits 1, cp-daemon
  restarts it with backoff, it claims the next generation, and the parent
  relaunches the same session (`cp-parent-control.json`); reconcile journals
  one `cp-recovery` wake. A parent that dies inside a live host is not
  restarted by the supervisor (the bridge's relaunch cap decided).
- A live parent lock with no responsive host is retried every 60 s, logged once.

## Models

A host that runs no parent is started with `CP_PARENT_MODEL` (`parent_model` in `data/daemon.json`:
`--parent-model` or step 3c's choice), else the saved `state/sessions/cp-parent-control.json`
model. With neither, the supervisor exits 78 and cp-daemon does not restart it (the parent role is
`failed`, `/doctor` `service.daemon` says no parent model): set the parent model in dashboard Settings
(`data/parent.json`, beats `CP_PARENT_MODEL`; Settings is read-only until an operator session serves dashboard
control) and run `cp-daemon reload`, or set `--parent-model` and reinstall with `--force`, or start the parent
once with `cp_parent start`.

The operator session started through the wrapper runs `pi --model
$CP_OPERATOR_MODEL` unless its argv already picks a model (`--model`,
`--models`, `--provider`) or resumes a session (`-c`, `--continue`, `-r`,
`--resume`, `--session`, `--session-id`, `--fork`): pi restores a resumed
session's own model. For one session, `cp-operator --model X`; to change the
pin, reinstall with `--operator-model X --force`. The wrapper's
`CP_PARENT_MODEL` makes an operator-started `cp_parent start` use the same model
the supervisor would.

## Logs and doctor

- `cp-daemon log [-n N]` — the tail of `state/daemon.log` (over 5 MiB it rolls to `daemon.prev.log`): the
  outer's and every role's output, `supervise: …` lines included; the host keeps `state/parent-host.log`. On
  the systemd backend `journalctl --user -u cp-daemon.service` has the outer's start and exit.
- `/doctor` adds, once installed: `service.daemon` (from `data/daemon.json`: not running, unreadable records,
  the inner `crash_looping`/`failed`/`not_ready`, a failed parent supervisor — exit 78 is no parent model,
  `start-limit-hit` the crash loop — a stopped viewer, or an outer older than the code on disk, which
  only `cp-daemon restart` replaces; always a warning, never an error), `service.legacy_units` (legacy cp-*
  unit files left over: §Migration), `service.node` (the node binary cp-daemon runs still exists; after an
  fnm upgrade: reinstall with `--force`) and, when the retired `~/.pi/command-post` holds a
  runtime root, `service.legacy_home`. While cp-daemon runs a viewer that no update holds, a missing
  viewer is a warning rather than information. `service.health` is the watchdog's last run and what it finds
  failing (a run older than 15 min warns: its schedule is not running).

## Health watchdog (P3)

cp-daemon's health job (`node <app>/src/service/health.ts` runs it by hand; `cp-daemon health` runs it now)
checks the parent (a
responsive host running a parent, the lock held by a live pid; 2 runs in a row,
never mid-update), the viewer (`/api/identity` for this home within 3 s; 2 runs),
the supervisor (the parent role `failed` / `start-limit-hit` in `state/daemon-runtime.json`; skipped on a
legacy home), disk (< 5 GiB or < 10 % free),
`git ls-remote origin` and `gh auth status` (hourly) and the updater's last
result. Hourly (a persisted `warn_checked_at` stamp in `state/health.json`) it also logs a warn-only
`health: warn host.pi.drift: …` line (never a check, a failure or an escalation) when the host pi is
above `piCompat.testedMax` for over 7 days with no open `qualify pi <version>` PR. It records each check (failing, its key, since when, recovered) in `state/health.json` and pushes nothing:
the Overview `health failing` line shows a failure at once, and the parent raises a `service_health` escalation
for it on the dashboard (`docs/contracts.md` §Escalation, §Web Push).

## Auto-update (P4)

cp-daemon's update job (`CP_HOME=<home> node <app>/src/service/update.ts --dry-run` probes by hand and changes
nothing; a run that is not cp-daemon's job, `CP_DAEMON_JOB=update`, is refused) applies a
moved `origin/main` of the app checkout when the fleet is drained. A detached oneshot, so reloading the
inner never kills it mid-step. `data/update.json` `{"enabled": false}` (or no file) turns it
off; `interval_min` (default 15) spaces the attempts, 4× after a drain timeout; `quiet_min` (default 10, a number
≥ 0, anything else is `config_invalid`; 0 keeps the old drain-at-once behaviour) is how long `origin/main` must
stay unchanged before a drain starts, so a burst of merges is one restart. Each run records
one result in `state/update.json` (its only writer):

- **legacy:** a legacy `cp-update.service` (no `data/daemon.json`) records `migration_required` and changes
  nothing (§Migration);
- **skips, nothing changed:** `skipped_disabled`, `skipped_dirty`, `skipped_branch` (not on
  `main`), `fetch_failed` (counted), `skipped_ahead` (`git rev-list --count origin/main..HEAD` > 0),
  `up_to_date`, `skipped_bad_sha` (the target rolled back before), `skipped_busy` (a live script
  pid, or a live worker mid-turn — run `status.json` not `idle`, or unreadable — nothing is
  drained). An idle held/waiting worker does not block: the drain answers `drained` and the
  restart leaves it `revivable`. Nothing revives it automatically: once the restarted parent is up,
  it acts on the `cp-recovery` wake and runs `cp_revive` for each held worker the wake lists.
  After 4× `interval_min` of `skipped_busy`, only a script still skips: the run drains anyway
  and the drain decides (`drained`, or `drain_timeout`);
- **settling:** `skipped_settling` while the `origin/main` tip is not yet `quiet_min` old, measured from when the
  updater first saw it (`first_seen_sha`/`first_seen_at` in `state/update.json`; a different tip restarts the
  clock); the detail names the tip and when it is eligible. Nothing is drained, and it never delays a
  rollback or a run resuming after `drained`;
- **drain:** host `drain 600` with cause `auto-update` and the target sha (so the refusal and notices say it is
  an update that restarts the parent by itself), then up to 660 s for `drained`. Still draining or timed out → host
  `drainCancel` (`/cp-drain cancel`: dispatch reopens) → `drain_timeout`; nothing is stopped;
- **update:** host `stop` (unlanded sends stay queued; the stop marker keeps the supervisor from
  respawning), cp-daemon `hold` (the viewer stops and stays down), `git merge --ff-only <to>`, `npm ci` only
  when `package-lock.json` changed, cp-daemon `reload` (a new inner on the new code: the supervisor starts a
  fresh host, the viewer restarts, the hold is released);
  the new parent clears the drained record at session start (and any start gate clears a spent one); a record that
  still survives is withdrawn with `cp_parent drain_cancel`, never by hand;
- **verify** (≤ 120 s): a host running a parent whose `/doctor` is not an error, and the viewer's
  `/api/identity` → `updated`; + ≤ 300 s while the parent is alive but busy (`#settledProc`'s
  "parent must be settled with no pending send", or a doctor queued behind the host's serial queue while
  the host's `status` read names the same live parent pid), then accepted with `doctor deferred: parent busy
  420s` at the end of the `updated` detail. An absent parent, a `/doctor` error or any other doctor
  rejection, and a down viewer are never extended and never accepted;
- **rollback:** a failure after the merge first drains again, because a restarted parent has already
  cleared the drain and reopened dispatch. If a live worker does not settle within 660 s, or no host
  answers while `fleet.json` still names one, nothing is stopped: `rollback_failed` with phase
  `rolling_back` and `held: true`, and the next run retries after 4× `interval_min`. A held rollback
  has no run in flight, so the watchdog keeps checking the parent and viewer; they are suppressed only
  while a run is actually working. `service.update` warns. A rollback kills no live worker. Once drained it
  stops, runs `git reset --keep <from>` (only after the clean/not-ahead check, only to the recorded
  sha), `npm ci` if the lock changed, restarts and verifies → `rolled_back` with `bad_sha` (never
  retried) or `rollback_failed` (`bad_sha` unchanged: a failure it cannot attribute never marks the
  target bad; the sticky `rollback_failed` holds it). A failure before the merge reloads cp-daemon → `failed`. A run that
  died mid-phase takes this path at its next start; one that died mid-drain cancels the drain, or,
  when it had already reached `drained` (which cancel refuses, and which keeps dispatch closed until
  the parent restarts), stops and restarts the drained parent → `failed`. The restart runs even when
  the stop fails, and the record names both errors: then the drain may stay latched until
  `cp_parent stop` + `start`.

Every failure (`failed`, `drain_timeout`, `rolled_back`, `rollback_failed`, `config_invalid`, and
`fetch_failed` from its third run in a row on) asks cp-daemon for a health run, which records it under one key per
distinct failure (result + target sha; a `drain_timeout` is one key per episode, result + `since`) and records the recovery at the next `updated`/`up_to_date`;
nothing pushes. A `rollback_failed` whose reset, npm ci, restart or verify failed (phase `idle`) is sticky: nothing runs until you check the
checkout and remove `state/update.json`. `/doctor` `service.update` shows on/off and the last result,
and warns on a failure or on a skip that has lasted over 24 h with `origin/main` ahead.

A `CP_HOME` home that is its own checkout (this one) updates the same way: `--app` is the home.

`reload` never replaces the outer (`daemon-outer.ts`, `daemon.ts` and the `daemon-*.ts` it imports): an update
that changes them leaves `/doctor` `service.daemon` warning that the outer predates the code — run `cp-daemon
restart` at a quiet point. A commit that bumps the outer/inner protocol (`DAEMON_PROTOCOL`) cannot apply under
an old outer: the new inner refuses, the update rolls back as `bad_sha`, and its CHANGELOG `Migration:` line
says to run `cp-daemon restart` (then the next update applies it).

## Crash loop

A 7th parent-supervisor start within 30 minutes leaves the parent role `failed` (`start-limit-hit`;
`/doctor` `service.daemon`, the dashboard's `health failing` line). Read `cp-daemon log`, fix the cause, then `cp-daemon reload`
(a fresh inner starts the supervisor again). cp-daemon itself under systemd: six starts in 30 min leave
`cp-daemon.service` `failed`; read `journalctl --user -u cp-daemon.service` and `cp-daemon log`, then
`systemctl --user reset-failed cp-daemon.service && systemctl --user start cp-daemon.service`.
