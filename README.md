# picp: pi command post

You give the orders in plain words; a parent agent plans and coordinates; workers ship reviewed PRs.

Homepage: https://picp.ai

Command post runs a small team of [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
coding agents for you, across as many git repositories as you like. You say
what you want in plain words; a **parent** agent breaks it into jobs, starts a
**worker** agent per job in its own git worktree, has plans and pull requests
reviewed, merges what passes CI, and asks you only when a decision is really
yours. A web **dashboard** shows everything as it happens.

It is for people who already use pi (or another coding agent), keep their
code on GitHub, and want agents to work through a backlog on a machine that
stays on — with the guard rails in code rather than in prompts.

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Words you will see](#words-you-will-see)
- [Where things live](#where-things-live)
- [Update and uninstall](#update-and-uninstall)
- [Develop](#develop)
- [Not in scope](#not-in-scope)
- [Further reading](#further-reading)

## How it works

There are three layers, smallest first:

1. **You and the operator session.** `cp-operator` opens a pi session you
   talk to. It passes your requests to the parent and relays the parent's
   questions and results back to you. It never runs jobs itself.
2. **The parent.** A headless pi session with the fleet tools. It records
   jobs, leases a worktree per job, starts workers, waits for their reports,
   runs reviews, and merges or tears jobs down. It never writes code itself.
3. **Workers.** One headless pi session per job, in its own
   [treehouse](https://github.com/kunchenguid/treehouse) worktree on a branch
   named after the job. A worker finishes by calling a `report_result` tool
   with a checked report; for code changes it pushes the branch and opens a
   draft pull request.

The parent only acts inside a **mandate** you gave it (a project, an
objective, and caps from the home's defaults). Anything outside it — a risky
change, more scope, an exhausted budget, a merge the repository refuses —
comes back to you as one question.

### GitHub delivery, GitLab recovery

Automated delivery is **GitHub only**: workers open draft pull requests with
`gh`, and the parent reads CI, reviews, and merges through `gh`. GitLab
support is **landed-work recovery**, not delivery. The parent can read a
merge request you name, record its merge, notice when it merges or closes,
and finish a job whose MR is already merged. It never creates, rebases,
approves or merges an MR, and it never reads GitLab CI.

**CI means GitHub Actions.** The parent reads CI only from the Actions REST
API: the workflow runs on a PR's exact head and each run's jobs. It never reads
the Checks API, commit statuses or `statusCheckRollup`, so a check that does
not come from an Actions workflow is not seen (a *required* one still blocks
the merge on GitHub's side). Every check on the current repos is an Actions
workflow. The `gh` token needs **Actions read**; a fine-grained PAT also needs
Contents, Metadata and Pull requests read, a classic token needs `repo`. When
the token cannot read Actions, the PR shows `CI unreadable` and `/doctor` says
so; "Checks read" or "Commit statuses read" grants do not fix it.

gitlab.com is recognised from the remote. A self-managed GitLab needs a
`forge` block on its project, because a hostname does not say which software
serves it:

```text
cp_project forge name=app forge={"kind":"gitlab","web_base_url":"https://git.example.test","token_env":"APP_GITLAB_TOKEN"}
```

`token_env` is the **name** of an environment variable. The token itself never
goes into a config value, a tool argument, a log or a receipt. It is sent only
in the `PRIVATE-TOKEN` header of the one read request. gitlab.com uses
`GITLAB_TOKEN` by default. With no token, the parent tries an anonymous read,
and a private project answers with a named failure.

A job can also be torn down when no forge API can be reached. Teardown then
checks git itself: every file the job changed must appear, with the same
content, in one commit reachable from the remote base. This covers squash,
rebase and a deleted source branch. The proof says the work is in the base, not
that an MR merged, so it writes no merge receipt. Close the job yourself
afterwards with `cp_job close` and that reason. When the proof cannot be
completed, the lease stays and teardown names what is missing.

## Requirements

| What | Needed? | Notes |
|---|---|---|
| Node.js 24 or newer | yes | checked, never installed; use nodejs.org, fnm or nvm |
| `git` | yes | install it yourself first; the bootstrap stops without it |
| `pi` | yes | the installer runs `npm install -g @earendil-works/pi-coding-agent` when it is missing |
| a model login for pi | yes, by you | run `pi`, then `/login`; the installer never handles credentials |
| `treehouse` | yes | every job runs in a treehouse worktree; the installer fetches it |
| [`gh`](https://cli.github.com), logged in | yes, for pull requests | reading PRs, CI and merging go through `gh`; on Linux install it yourself, then `gh auth login`. GitLab needs no CLI ([recovery only](#github-delivery-gitlab-recovery)) |
| `systemd --user` (Linux) | optional | cp-daemon keeps the parent and dashboard running everywhere; with `systemd --user` it also comes back after a reboot by itself, without it you run the printed start command (or `--crontab`) |
| [Tailscale](https://tailscale.com) | recommended | the dashboard binds to one address of this machine; the Tailscale one keeps it to your tailnet |
| `tmux` or herdr | optional | lets the dashboard's **Start session** button open an operator session |

The installer also installs the pi packages workers load and the pi-lens host
tools (`typescript-language-server`, `typescript`, `@ast-grep/cli`) with
`npm i -g`. It never runs `sudo`: a step that needs it prints the command for
you instead.

## Install

On a fresh machine, one command. It is safe to rerun; a second run prints only
`ok` and `skip` lines.

```bash
curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/bin/cp-bootstrap | sh
```

This checks git and Node, clones the code to `~/.pi-command-post/app`, runs
`npm ci`, then runs `bin/cp-install`, which prints one
`ok|changed|skip|fail: <step>: <detail>` line per step. Questions are asked on
your terminal even through `curl | sh`; `--yes` takes every default.

The usual sequence on a new machine:

1. Run the command above. It installs `pi` if needed. With no model login yet it stops before
   writing or starting anything (exit 4) and prints one line: run `pi`, then /login, then re-run
   the exact command it names.
2. Run `pi`, type `/login`, pick your provider, then quit pi.
3. Run that printed command (`~/.pi-command-post/app/bin/cp-install` with your flags). It lists
   models as the service sees them, so a login that does not reach the service stops it again.
   `--no-start` installs without a login and starts nothing.

Pass flags after `sh -s --` (bootstrap) or straight to `bin/cp-install`:

```bash
curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/bin/cp-bootstrap | sh -s -- --yes --parent-model <provider/model>
~/.pi-command-post/app/bin/cp-install --viewer-host 100.101.102.103 --dry-run
```

The flags you are most likely to need:

| Flag | What it does |
|---|---|
| `--viewer-host <ip>` | the address the dashboard listens on. Without it a fresh install asks, recommending this machine's Tailscale address. A LAN address means anyone on that network can use the dashboard's controls; public, wildcard and link-local addresses are refused. |
| `--parent-model <provider/model>` | the parent's model. Without it a fresh install lists the models pi can use and asks. On a fresh install without `--operator-model` it also sets the operator's model. |
| `--operator-model <provider/model>` | the operator session's model; sets only that one. Without it a fresh install asks from the same list, defaulting to the parent's pick (Enter twice uses one model for both). |
| `--gateway-url https://<gateway> --gateway-key-file <file>` | **optional**: a sub2api gateway the parent consults for capacity when routing work. The key is read from the first line of the file, never from the command line, and stored in `~/.config/pi-command-post/gateway.env` (0600). Without these flags the step is skipped. |
| `--push-origin <https-url>` | optional phone notifications (needs an HTTPS proxy in front of the dashboard; see [docs/viewer-app.md](docs/viewer-app.md#web-push)). |
| `--dry-run` | show what would change, change nothing (no `git fetch`; gh login and pi's model list are not checked). |
| `--force` | replace `data/daemon.json`, a unit or the wrapper that changed, or change a pinned choice (for example `--parent-model X --force`). |
| `--uninstall` | remove the services and the wrapper (see below). |

A reinstall keeps the address and models you chose. Every flag and every step
is in [docs/service.md](docs/service.md) — including
[the dashboard address](docs/service.md#3b-the-viewer-host),
[the models](docs/service.md#3c-the-models) and
[the gateway](docs/service.md#7b-the-optional-gateway).

The install writes `data/daemon.json` and starts **cp-daemon**, one process per home that runs the parent,
the dashboard, a health watchdog and the auto-updater — through `cp-daemon.service` with `systemd --user`,
else as a detached process (it prints the command to start it again after a reboot). It also writes
`~/.local/bin/cp-operator`. Put `~/.local/bin` on your `PATH` if it is not already. An older install with
the `cp-parent`/`cp-view` units moves to cp-daemon when you rerun the installer
([migration](docs/service.md#migration)).

## First run

1. **Start the operator session.**

   ```bash
   cp-operator
   ```

   It attaches to the parent the service already runs (without the service
   it starts one on first need). Ask it to "run doctor" if anything looks
   wrong: it runs the parent's `/doctor`, and every finding names its fix.

2. **Give it a mandate.** Name a project and what you want done, in plain
   words, for example:

   > Mandate for github.com/you/my-app (clone url git@github.com:you/my-app.git):
   > fix the failing date parsing in issue #12 and add a test.

   The operator session issues the mandate and echoes what it granted — caps,
   expiry and allowed actions come from the home's defaults
   (`data/mandate-defaults.json`), so you are not asked for them. Saying
   `stop` revokes it. The parent registers and clones the project, records
   the jobs and starts workers.

3. **Watch the dashboard.** Open `http://<dashboard-address>:8766/` (the
   address you pinned, usually your Tailscale IP) from any device on your
   tailnet. Overview, Awaiting you, Jobs, Board and Sessions show jobs,
   pull requests, CI, reviews and the agents' transcripts. You can also send
   messages to the operator session from there and, with tmux or herdr,
   start one.

   Away from your tailnet (opt-in): `cp-tunnel up` publishes the dashboard on
   an HTTPS address through Cloudflare — a quick tunnel needs no account but its
   hostname changes on restart; `--hostname H --api-token-file F` sets up a
   named tunnel with a scoped Cloudflare API token (`--token-file F` uses one
   you made by hand). Only paired devices get in. A Full-control device is trusted like
   your terminal; use View only for a less-trusted one. Setup, pairing and
   revoke: [`docs/service.md`](docs/service.md) (Remote dashboard).

4. **Answer when asked.** Questions arrive in the operator session and under
   **Awaiting you** on the dashboard. Reply in plain words. Everything else —
   plan approval within the mandate, review findings, test failures, merging
   when the repository allows it — the parent decides by itself.

The operator session reaches the parent through one tool, `cp_parent`
(`start`, `send`, `status`, `doctor`, `version`, `drain`, `stop`, …); you just
ask in words. The parent's own commands (`/status`, `/watch <job-id>`,
`/doctor`) are described in [AGENTS.md](AGENTS.md).

## Words you will see

| Word | Meaning |
|---|---|
| **mandate** | the authority you give up front: one topic's projects, objective, expiry, allowed actions, and spend/job caps. The parent acts only within it. |
| **grant** | one issued mandate record, shown by its id (`md-…`). A topic can hold more than one grant; each has its own caps and expiry. |
| **supplement** | a later grant that names specific jobs (`job_ids`). When an earlier named grant has reached its job cap, a supplement covering the job carries it instead. |
| **job** | one unit of work in the ledger, with a project and a delivery (`pr`, `local`, `pipeline`, `answer`). Its id is also its git branch. |
| **planner** | a worker that reads code and writes a plan, without changing anything. |
| **ship** | a job that changes code; its worker (the implementer) pushes a branch and, for `delivery: pr`, opens a draft pull request. |
| **gate** | a fresh reviewer that checks a planner's plan before anyone implements it; at most one revise round. |
| **checkpoint** | the plan-approval step after a gate passes: a mandate that allows it decides it, otherwise it waits for you as a plan-approval question. |
| **review** | a fresh reviewer that checks a pull request's diff for its current head. A PR merges only with a passing review and green CI, and only when GitHub allows the merge. |
| **final_fix** | after a PR's fifth and last review still has findings: one last fix you approve by quoting it; only the next fix head may merge. |
| **human_handoff** | a project setting (`merge_policy`) under which picp never merges: a reviewed, green PR is handed to the team to merge. |
| **parked** / **awaiting_merge** | a `human_handoff` PR waiting on a human merge. Its worker is closed and it holds no slot; Overview lists it under "With the team". |
| **escalation** | the one question the parent raises when a decision is outside the mandate: risk, scope, budget, a refused merge, the end of a mission. |
| **ask** | a question the operator session puts to you and records until you answer. Separately, a *small question* about a project can be answered by a read-only worker as an answer card (`cp_ask`), with no code change. |

## Where things live

| Path | What |
|---|---|
| `~/.pi-command-post/app/` | the code (a git checkout of `main`) |
| `~/.pi-command-post/` | the **home**: `data/` (settings, mandate defaults, memory), `state/` (jobs in flight, run logs, transcripts, reports), `projects/` (clones of your repositories), `operator/` (the operator session's notes), `jobs.json` (the job ledger) |
| `~/.treehouse/` | worker worktrees (set `CP_TREEHOUSE_ROOT` to move them) |
| `~/.pi-command-post/data/daemon.json` | cp-daemon's settings (written by the installer) |
| `~/.config/systemd/user/cp-daemon.service`, `cp-operator*.service` | the service (with `systemd --user`) |
| `~/.local/bin/cp-operator` | the operator launcher |
| `~/.config/pi-command-post/gateway.env` | the optional gateway key |
| `~/.pi/agent/` | pi's own settings, login and packages |

`CP_HOME=/some/dir` runs a separate home. Only one parent runs per home at a
time. Every file and who may write it: [docs/storage.md](docs/storage.md).

Logs: `~/.pi-command-post/app/bin/cp-daemon log` (`state/daemon.log`); each job's run log is
`state/runs/<job-id>/events.jsonl`.

## Update and uninstall

**Update.** cp-daemon checks for a new `origin/main` every
15 minutes by default. It waits until no worker is mid-turn, updates, restarts
the parent and dashboard, checks they came back, and rolls back if not. Turn
it off with `data/update.json` `{"enabled": false}` (or install with
`--no-update`). To update by hand, drain and stop the parent (below), rerun
the bootstrap command, run `cp-daemon reload` (it restarts the dashboard and the
supervisor) and ask the operator session to start the parent again if it has not.
Details: [docs/service.md](docs/service.md#auto-update-p4).

**Stop.** In the operator session, ask it to drain and stop the parent
(`cp_parent drain`, then `cp_parent stop`). `cp-daemon stop`
stops only the daemon and the supervisor; running workers keep going.

**Uninstall.**

```bash
~/.pi-command-post/app/bin/cp-install --uninstall
```

This stops cp-daemon and removes the services, `data/daemon.json` and the `cp-operator` wrapper. It
never deletes your home, the code or the gateway key file; remove
`~/.pi-command-post` and `~/.config/pi-command-post/` yourself if you want
them gone. See [docs/service.md](docs/service.md#uninstall).

## Develop

Run it from a checkout instead of the installed app:

```bash
git clone https://github.com/0xb1ob/picp.git
cd picp
npm install
./bin/cp-operator          # the operator session, against this checkout as its home
```

It also loads as a pi package (`pi install git:github.com/0xb1ob/picp`),
which uses `~/.pi-command-post` as its home.

```bash
npm run typecheck
npm test                                      # everything, against a mock model: no tokens, no network
npm run test:one -- tests/contract.test.ts    # one file
npm run e2e:phase3                            # research → gate → checkpoint → implement
CP_LIVE_TESTS=1 npm run e2e:live              # real models, operator-run only
```

Tests, CI, the repository layout and running several homes on one machine:
[docs/development.md](docs/development.md).

## Reporting a problem

Open an issue at https://github.com/0xb1ob/picp/issues/new and attach:

- the `/doctor` output (or `cp_parent doctor` from the operator session);
- the version from the dashboard badge;
- the job id(s) involved;
- what you expected, and what happened instead.

Redact secrets, tokens and any paths you consider private before you post.

## Not in scope

Slack relays or threads, workers on other agent CLIs than pi, and an HTML
dashboard served by the parent itself (the old `--serve` flag) — the
dashboard is the separate `cp-view` service. Known thin spots: repositories
with no CI, `delivery: local` jobs (no PR, so no review), and work marked
destructive. [docs/parity.md](docs/parity.md) accounts for every capability
of the two predecessor tools.

## Further reading

- [AGENTS.md](AGENTS.md) — the parent's operating rules
- [docs/service.md](docs/service.md) — the installer, services, updates, logs
- [docs/autonomy.md](docs/autonomy.md) — the three layers and the mandate
- [docs/viewer-app.md](docs/viewer-app.md) — the dashboard, its security, Web Push
- [docs/storage.md](docs/storage.md) — every file and who writes it
- [docs/contracts.md](docs/contracts.md) — the full contracts and why they exist
- [docs/development.md](docs/development.md) — tests, CI, layout
- [docs/build-history.md](docs/build-history.md) — how it got here
- [CHANGELOG.md](CHANGELOG.md)
