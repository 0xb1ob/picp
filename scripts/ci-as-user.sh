#!/usr/bin/env bash
# Run a command unprivileged when CI is root (self-hosted nomad): root ignores chmod, so
# permission-failure tests would pass their writes. Hosted runners are non-root and exec as-is.
set -euo pipefail
if [ "$(id -u)" != 0 ]; then exec "$@"; fi
user=cpci
id "$user" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$user"
getent group docker >/dev/null && usermod -aG docker "$user"
chown -R "$user" "${GITHUB_WORKSPACE:-$PWD}" "/home/$user" ${RUNNER_TEMP:+"$RUNNER_TEMP"}
exec setpriv --reuid="$user" --regid="$user" --init-groups env "HOME=/home/$user" "$@"
