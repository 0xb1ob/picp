#!/bin/sh
# One-command install (cp-daemon v1 P2; docs/service.md). POSIX sh, never sudo.
#   curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/scripts/install.sh | sh -s -- [flags]
#   sh scripts/install.sh [flags]      (from any checkout; bin/cp-install runs this)
# Checks git and node 24+ first, then places the code at APP (default ~/.pi-command-post/app, or --app DIR): clones
# when absent, fast-forwards a clean, not-ahead main, runs npm ci when node_modules does not match package-lock.json,
# then execs node APP/src/service/install.ts. A failed clone or npm ci names its exact rerun.
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
die() {
	say fail "$1"
	exit 1
}
# The exact rerun: the user's own flags, single-quoted.
ARGS=
for arg in "$@"; do ARGS="$ARGS '$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"; done
if [ -n "$ROOT" ]; then RERUN="sh '$ROOT/scripts/install.sh'$ARGS"; else RERUN="curl -fsSL https://raw.githubusercontent.com/0xb1ob/picp/main/scripts/install.sh | sh -s --$ARGS"; fi
# Before any clone (#375 P4): install.ts needs node 24+, and npm alone would only fail later naming npm.
command -v git >/dev/null 2>&1 || die "git is not on PATH; install it (e.g. sudo apt-get install -y git, or xcode-select --install), then rerun"
command -v node >/dev/null 2>&1 || die "node is not on PATH; install node 24 or newer (nodejs.org, fnm or nvm), then rerun"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] 2>/dev/null || die "node $(node --version) is older than 24; install node 24 or newer (e.g. fnm install 24), then rerun"
if [ ! -e "$APP/.git" ]; then
	if [ "$DRY" = 1 ]; then
		say changed "would git clone --branch main $URL $APP (dry-run)"
		[ -n "$ROOT" ] || exit 0
		exec node "$ROOT/src/service/install.ts" "$@"
	fi
	mkdir -p "$(dirname -- "$APP")"
	git clone --branch main "$URL" "$APP" || die "git clone --branch main $URL $APP failed (its error is above); fix the network or URL, then rerun: $RERUN"
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
	elif [ "$DRY" = 1 ]; then
		# git fetch writes FETCH_HEAD, refs and objects: a dry run never fetches.
		say changed "would fetch origin main and fast-forward $APP when behind and not ahead (dry-run: nothing fetched)"
	elif ! git -C "$APP" fetch --quiet origin main; then
		say skip "git fetch origin main failed in $APP; left as is"
	elif [ "$(git -C "$APP" rev-list --count origin/main..HEAD)" != 0 ]; then
		say skip "$APP has commits not on origin/main; left as is"
	elif [ "$(git -C "$APP" rev-parse HEAD)" = "$(git -C "$APP" rev-parse origin/main)" ]; then
		say ok "$APP is at origin/main"
	else
		git -C "$APP" merge --quiet --ff-only origin/main || die "git merge --ff-only origin/main failed in $APP (its error is above); fix that, then rerun: $RERUN"
		say changed "fast-forwarded $APP to origin/main"
	fi
fi
# install.ts imports npm packages: a fresh clone (or node_modules that differs from the lockfile) needs npm ci first.
# The comparison is install.ts's own (sameLock), so the two never disagree; without it, npm ci runs.
lock="$APP/node_modules/.package-lock.json"
deps="$APP/src/worktree-deps.ts"
[ -f "$deps" ] || deps="$ROOT/src/worktree-deps.ts"
same() {
	[ -f "$lock" ] && [ -f "$deps" ] && node --input-type=module -e '
const [deps, app] = process.argv.slice(1);
const { readFileSync } = await import("node:fs");
const { sameLock } = await import(deps);
process.exit(sameLock(readFileSync(`${app}/package-lock.json`, "utf8"), readFileSync(`${app}/node_modules/.package-lock.json`, "utf8")) ? 0 : 1);
' "$deps" "$APP" 2>/dev/null
}
if [ ! -f "$APP/package-lock.json" ]; then
	:
elif same; then
	say ok "$APP/node_modules matches package-lock.json"
elif [ "$DRY" = 1 ]; then
	say changed "would run npm ci in $APP (dry-run)"
else
	(cd "$APP" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $APP (its error is above); fix that (network, npm cache), then rerun: sh '$APP/bin/cp-install'$ARGS"
	say changed "npm ci in $APP"
fi
exec node "$APP/src/service/install.ts" "$@"
