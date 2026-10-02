# Always on: the parent and the dashboard under cp-daemon

One process per home, **cp-daemon** (`bin/cp-daemon`, `src/service/daemon.ts`), keeps the parent host (so
the parent and its fleet) and the dashboard viewer running across reboots and crashes, with no operator
terminal, and runs the health watchdog and the auto-updater. It is the only runtime on every machine (cp-txbb):

| Backend | When | What starts cp-daemon |
|---|---|---|
| `systemd` | `systemctl --user is-system-running` is `running` or `degraded` | the thin user unit `cp-daemon.service` (`node <app>/src/service/daemon.ts run`), enabled; systemd restarts it `on-failure`, 5 s growing to 300 s, 6 starts in 30 min → `failed`; exit 78 (bad config) is not restarted |
| `detached` | anything else (a container, WSL without systemd, a VM with no user manager) | `cp-daemon start`: a `setsid` child; after a reboot, the printed reboot command (§Without systemd) |

Inside, an outer process (`daemon-outer.ts`: the lock, the control socket `state/daemon.sock`, the log) runs an
inner runtime (`daemon-runtime.ts`) that owns four roles:

| Role | Runs | Restart |
|---|---|---|
| parent | `node <app>/src/service/supervise.ts` — the attach-first supervisor | on a crash, 5 s growing to 300 s; exit 78 → `failed`; a 7th start in 30 min → `failed` (`start-limit-hit`) |
| viewer | `node <app>/src/viewer/cli.ts --home <home> --require-tailnet --port <port>` | 10 s after any exit, unless the updater holds it |
| health (P3) | `node <app>/src/service/health.ts`, a oneshot, 3 min after the daemon starts then every 5 min | the schedule repeats it |
| update (P4) | `node <app>/src/service/update.ts`, a oneshot, 10 min after the daemon starts then every 5 min | the schedule repeats it; it survives the `reload` it asks for |

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

`bin/cp-bootstrap` (POSIX sh) clones or fast-forwards `$CP_APP` (default
`~/.pi-command-post/app`), refuses a dirty, off-`main` or ahead checkout, runs
`npm ci` there and execs `bin/cp-install --app <app>` with every flag.

`scripts/install.sh` places the code at `~/.pi-command-post/app` (or `--app DIR`):
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
   treehouse is required, not optional — every dispatch leases a treehouse worktree. Then:
   - `gh auth status --active` (only the active account; else `gh api user`); logged out → prints `gh auth login` for you (never run);
   - the pi-lens host tools (`PI_LENS_TOOLS`, shared with `/doctor`) with `npm i -g`; a global
     prefix that needs sudo is a `fail` naming the fix, and nothing is run;
   - every pi package a worker role loads (`ROLE_PACKAGES`) missing from
     `~/.pi/agent/settings.json` → `pi install npm:<name>` (pins kept; your other packages and
     their order untouched; settings.json is never edited here). `--no-pi-packages` skips;
   - `br` (beads CLI), **optional**, prompt default **no**, **yes** when `data/trackers.json` has an
     active beads connection or a registered project's clone has `.beads/beads.db`; `--with-br`/`--no-br` answer it. Its install method is not verifiable
     here, so the installer prints how instead of guessing a URL. `tmux` is reported, never required;
   - no provider in `~/.pi/agent/auth.json` → prints "run `pi`, then /login" (credentials never handled);
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
10. `--push-origin URL` (or an origin typed at the prompt) with no `data/push/config.json` → `scripts/push-init.ts`;
11. waits ≤ 90 s for the host's parent and prints its `/doctor`, then `cp-daemon status`.

Flags: `--home --app --port --parent-model --operator-model --viewer-host --gateway-url --gateway-key-file --push-origin --force --no-start
--crontab --no-update --uninstall --dry-run --yes --no-prompt --with-br --no-br
--no-pi-packages --no-self-package` (`--no-self-package` is accepted and has no effect: the self-package step went with single-project mode). Prompts read `/dev/tty`, so `curl | sh`
still asks; with no terminal, `--yes`, `--no-prompt` or `--dry-run` every prompt
takes its default. `--dry-run` probes and prints and changes nothing (the code
step too). A second run reports every step `ok`/`skip`. Never `sudo`: a step that
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

### 3c. The models

One choice for the parent (`parent_model` in `data/daemon.json`, `CP_PARENT_MODEL` in the
wrapper) and the operator session (`CP_OPERATOR_MODEL` in the wrapper, which
`bin/cp-operator` turns into pi's `--model`). The candidates are what
`pi --no-extensions --list-models` lists, run with the environment cp-daemon's children
have (`HOME`, `USER`, `LOGNAME`, the installing `PATH`): a provider key exported only
in your shell never reaches the service, so it is never offered. Per target,
first match wins:

1. `--parent-model M` / `--operator-model M` — on a fresh install one flag sets
   both. A value pi does not list is `fail: model:`; with an empty or unreadable
   listing it is written with a `skip: model: … written unchecked` note.
2. An existing install keeps what it pins (`data/daemon.json`, a legacy `cp-parent.service`, the wrapper: `ok: model: … kept`);
   an unpinned one stays unpinned (`skip`) unless `--force`, which re-opens only
   unpinned choices. A pinned choice is never re-asked.
3. A fresh install asks once, numbered (at most 9): the parent's own default
   first (`CP_PARENT_MODEL`/`PI_PROVIDER`+`PI_MODEL` in the installing env, then the
   saved `cp-parent-control.json` model), then the routing rubric's models
   (`data/routing.json`, else `defaults/routing.default.json`), then pi's saved
   default (`settings.json` `defaultProvider/defaultModel`), else the first
   listed — each only when pi lists it; the first is recommended. Enter takes it,
   a number or a listed `provider/model` picks, `none` pins nothing, anything
   else fails and writes nothing. `--yes`, `--no-prompt` or no terminal take the
   recommendation (`changed: model: parent <m> (recommended: …; --parent-model overrides)`).

No listed model prints "run `pi`, then /login, then rerun cp-install" and pins
nothing. Changing a pin needs the flag and `--force`; it applies at the next
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
  was subscribed) arrives as `cp-bridge` messages. A closed connection
  re-attaches after 5, 15 and 45 s; after that the next `cp_parent` call does.
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

## Stop, drain, restart

- **Stopping the fleet stays `cp_parent drain` + `cp_parent stop`.** A
  completed `stop` writes `state/parent-host.stopped.json` `{gen, at}` before
  the host exits; the supervisor then waits without spawning (polling every
  10 s) and joins a newer generation when `cp_parent start` makes one.
- While `state/drain.json` exists, a host loss also waits without spawning.
  A boot starts regardless: the boot is the restart the drain prepared, and
  the parent's `session_start` reports and clears it.
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
`failed`, `/doctor` `service.daemon` says no parent model): set `--parent-model` and reinstall with
`--force`, or start the parent once with `cp_parent start`.

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
result. It pushes once when a check starts failing, once per distinct updater
failure, and once on recovery; its record is `state/health.json`. It reads the
VAPID key and subscriptions but never writes the push ledger or deletes a
subscription (`docs/contracts.md` §Web Push).

## Auto-update (P4)

cp-daemon's update job (`CP_HOME=<home> node <app>/src/service/update.ts --dry-run` probes by hand and changes
nothing; a run that is not cp-daemon's job, `CP_DAEMON_JOB=update`, is refused) applies a
moved `origin/main` of the app checkout when the fleet is drained. A detached oneshot, so reloading the
inner never kills it mid-step. `data/update.json` `{"enabled": false}` (or no file) turns it
off; `interval_min` (default 15) spaces the attempts, 4× after a drain timeout. Each run records
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
- **drain:** host `drain 600`, then up to 660 s for `drained`. Still draining or timed out → host
  `drainCancel` (`/cp-drain cancel`: dispatch reopens) → `drain_timeout`; nothing is stopped;
- **update:** host `stop` (unlanded sends stay queued; the stop marker keeps the supervisor from
  respawning), cp-daemon `hold` (the viewer stops and stays down), `git merge --ff-only <to>`, `npm ci` only
  when `package-lock.json` changed, cp-daemon `reload` (a new inner on the new code: the supervisor starts a
  fresh host, the viewer restarts, the hold is released);
- **verify** (≤ 120 s): a host running a parent whose `/doctor` is not an error, and the viewer's
  `/api/identity` → `updated`;
- **rollback:** a failure after the merge first drains again, because a restarted parent has already
  cleared the drain and reopened dispatch. If a live worker does not settle within 660 s, or no host
  answers while `fleet.json` still names one, nothing is stopped: `rollback_failed` with phase
  `rolling_back` and `held: true`, and the next run retries after 4× `interval_min`. A held rollback
  has no run in flight, so the watchdog keeps checking the parent and viewer; they are suppressed only
  while a run is actually working. `service.update` warns. A rollback kills no live worker. Once drained it
  stops, runs `git reset --keep <from>` (only after the clean/not-ahead check, only to the recorded
  sha), `npm ci` if the lock changed, restarts and verifies → `rolled_back` with `bad_sha` (never
  retried) or `rollback_failed`. A failure before the merge reloads cp-daemon → `failed`. A run that
  died mid-phase takes this path at its next start; one that died mid-drain cancels the drain, or,
  when it had already reached `drained` (which cancel refuses, and which keeps dispatch closed until
  the parent restarts), stops and restarts the drained parent → `failed`. The restart runs even when
  the stop fails, and the record names both errors: then the drain may stay latched until
  `cp_parent stop` + `start`.

Every failure (`failed`, `drain_timeout`, `rolled_back`, `rollback_failed`, `config_invalid`, and
`fetch_failed` from its third run in a row on) asks cp-daemon for a health run, which pushes exactly once per
distinct failure (result + target sha) and once on recovery at the next `updated`/`up_to_date`; the
updater itself never pushes. A `rollback_failed` whose reset, npm ci, restart or verify failed (phase `idle`) is sticky: nothing runs until you check the
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
`/doctor` `service.daemon`, a health push). Read `cp-daemon log`, fix the cause, then `cp-daemon reload`
(a fresh inner starts the supervisor again). cp-daemon itself under systemd: six starts in 30 min leave
`cp-daemon.service` `failed`; read `journalctl --user -u cp-daemon.service` and `cp-daemon log`, then
`systemctl --user reset-failed cp-daemon.service && systemctl --user start cp-daemon.service`.
