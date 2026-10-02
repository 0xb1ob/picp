#!/bin/sh
# One-command install (cp-daemon v1 P2; docs/service.md). POSIX sh, never sudo.
#   curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/scripts/install.sh | sh -s -- [flags]
#   sh scripts/install.sh [flags]      (from any checkout; bin/cp-install runs this)
# Places the code at APP (default ~/.pi-command-post/app, or --app DIR): clones when
# absent, fast-forwards a clean, not-ahead main, runs npm ci when node_modules is missing or older
# than package-lock.json, then execs node APP/src/service/install.ts.
set -eu
APP="$HOME/.pi-command-post/app"
DRY=0
prev=""
for arg in "$@"; do
	case "$prev" in --app) APP=$arg ;; esac
	case "$arg" in --app=*) APP=${arg#--app=} ;; --dry-run) DRY=1 ;; esac
	prev=$arg
done
ROOT=""
case "$0" in */install.sh) ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) ;; esac
[ -n "$ROOT" ] && [ ! -f "$ROOT/src/service/install.ts" ] && ROOT=""
URL=${CP_REPO_URL:-}
[ -z "$URL" ] && [ -n "$ROOT" ] && URL=$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)
[ -z "$URL" ] && URL="https://github.com/0xb1ob/picp.git"
say() { printf '%s: code: %s\n' "$1" "$2"; }
if [ ! -e "$APP/.git" ]; then
	if [ "$DRY" = 1 ]; then
		say changed "would git clone --branch main $URL $APP (dry-run)"
		[ -n "$ROOT" ] || exit 0
		exec node "$ROOT/src/service/install.ts" "$@"
	fi
	mkdir -p "$(dirname -- "$APP")"
	git clone --branch main "$URL" "$APP"
	say changed "cloned $URL into $APP"
else
	have=$(git -C "$APP" remote get-url origin 2>/dev/null || true)
	if [ "$have" != "$URL" ]; then
		say fail "$APP has origin '$have', not $URL; set CP_REPO_URL or pass another --app"
		exit 1
	fi
	branch=$(git -C "$APP" rev-parse --abbrev-ref HEAD)
	if [ -n "$(git -C "$APP" status --porcelain)" ]; then
		say skip "$APP has uncommitted changes; left as is"
	elif [ "$branch" != main ]; then
		say skip "$APP is on $branch, not main; left as is"
	elif ! git -C "$APP" fetch --quiet origin main; then
		say skip "git fetch origin main failed in $APP; left as is"
	elif [ "$(git -C "$APP" rev-list --count origin/main..HEAD)" != 0 ]; then
		say skip "$APP has commits not on origin/main; left as is"
	elif [ "$(git -C "$APP" rev-parse HEAD)" = "$(git -C "$APP" rev-parse origin/main)" ]; then
		say ok "$APP is at origin/main"
	elif [ "$DRY" = 1 ]; then
		say changed "would fast-forward $APP to origin/main (dry-run)"
	else
		git -C "$APP" merge --quiet --ff-only origin/main
		say changed "fast-forwarded $APP to origin/main"
	fi
fi
# install.ts imports npm packages: a fresh clone (or a lockfile newer than node_modules) needs npm ci first.
lock="$APP/node_modules/.package-lock.json"
if [ ! -f "$APP/package-lock.json" ]; then
	:
elif [ -f "$lock" ] && [ -z "$(find "$APP/package-lock.json" -newer "$lock")" ]; then
	say ok "$APP/node_modules is current"
elif [ "$DRY" = 1 ]; then
	say changed "would run npm ci in $APP (dry-run)"
else
	(cd "$APP" && npm ci --no-audit --no-fund --loglevel=error) || { say fail "npm ci failed in $APP; run it there and read its error"; exit 1; }
	say changed "npm ci in $APP"
fi
exec node "$APP/src/service/install.ts" "$@"
