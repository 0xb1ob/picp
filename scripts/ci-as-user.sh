#!/usr/bin/env bash
# Run a command as the unprivileged cpci user: root ignores chmod (self-hosted nomad), and on hosted runners
# (re-entered as root via sudo) no test may share Runner.Worker's uid, where a stray kill(-1) cancels the job.
set -euo pipefail
if [ "$(id -u)" != 0 ]; then
  if [ "${GITHUB_ACTIONS:-}" = true ] && sudo -n true 2>/dev/null; then
    # Hosted sudo ignores --preserve-env (env_reset); a 0600 file, not argv, carries the job env and its token.
    envfile=$(mktemp); env -0 > "$envfile"
    exec sudo -n bash "$0" --cp-env "$envfile" "$@"
  fi
  exec "$@"
fi
if [ "${1:-}" = --cp-env ]; then
  while IFS= read -r -d '' kv; do export "$kv" 2>/dev/null || true; done < "$2"
  rm -f "$2"; shift 2
fi
if [ "${GITHUB_ACTIONS:-}" = true ]; then PS4='+ ${EPOCHREALTIME} '; set -x; fi # after the env load: xtrace would print secrets
user=cpci
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
sock=/var/run/docker.sock
if [ -S "$sock" ] && [ "$(stat -c %g "$sock")" != 0 ]; then
  gid=$(stat -c %g "$sock")
  grp=$(getent group "$gid" | cut -d: -f1 || true)
  [ -n "$grp" ] || { grp=cpcidocker; groupadd -g "$gid" "$grp"; }
  usermod -aG "$grp" "$user"
fi
cache=/root/.npm
temp=${RUNNER_TEMP:-}
if [ -n "${SUDO_USER:-}" ]; then
  # Hosted runner: its user's npm cache, a traversable workspace path; RUNNER_TEMP stays the runner's.
  cache="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.npm"
  temp=
  dir=${GITHUB_WORKSPACE:-$PWD}
  while [ "$dir" != / ]; do dir=$(dirname "$dir"); chmod o+x "$dir"; done
fi
# setup-node restored the npm cache for the runner's user; seed cpci's own ~/.npm from it
[ -d "$cache" ] && [ ! -e "/home/$user/.npm" ] && cp -a "$cache" "/home/$user/.npm"
chown -R "$user" "${GITHUB_WORKSPACE:-$PWD}" "/home/$user" ${temp:+"$temp"}
exec setpriv --reuid="$user" --regid="$user" --init-groups env -u SUDO_USER -u SUDO_UID -u SUDO_GID -u SUDO_COMMAND \
  "HOME=/home/$user" "$@"
