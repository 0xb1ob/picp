#!/usr/bin/env bash
# Run a command unprivileged when CI is root (self-hosted nomad): root ignores chmod, so
# permission-failure tests would pass their writes. Hosted runners are non-root and exec as-is.
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec "$@"; fi
user=cpci
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
sock=/var/run/docker.sock
if [ -S "$sock" ] && [ "$(stat -c %g "$sock")" != 0 ]; then
  gid=$(stat -c %g "$sock")
  grp=$(getent group "$gid" | cut -d: -f1 || true)
  [ -n "$grp" ] || { grp=cpcidocker; groupadd -g "$gid" "$grp"; }
  usermod -aG "$grp" "$user"
fi
# setup-node restored the npm cache for root; seed cpci's own ~/.npm from it
[ -d /root/.npm ] && [ ! -e "/home/$user/.npm" ] && cp -a /root/.npm "/home/$user/.npm"
chown -R "$user" "${GITHUB_WORKSPACE:-$PWD}" "/home/$user" ${RUNNER_TEMP:+"$RUNNER_TEMP"}
exec setpriv --reuid="$user" --regid="$user" --init-groups env "HOME=/home/$user" "$@"
