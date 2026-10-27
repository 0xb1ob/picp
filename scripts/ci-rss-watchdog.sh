#!/usr/bin/env bash
# One sampler tick: a cpci node process over the RSS limit gets a diagnostic report, then SIGKILL (once per pid).
set -u
state=${1:?usage: ci-rss-watchdog.sh <handled-pids-file>}
limit_kb=${CP_RSS_LIMIT_KB:-3145728}
dir=/tmp/cp-node-reports
touch "$state"
# The sampler runs outside cpci's uid: signal it directly, else through sudo.
sig() { kill "-$1" "$2" 2>/dev/null || sudo -n kill "-$1" "$2" 2>/dev/null || true; }
print_report='const r=require(process.argv[1]);
console.log("javascriptStack:",r.javascriptStack?.message);
console.log((r.javascriptStack?.stack||[]).slice(0,40).join("\n"));
console.log("nativeStack (head):");
console.log((r.nativeStack||[]).slice(0,15).map((s)=>s.symbol||s.pc).join("\n"));
console.log("resourceUsage:",JSON.stringify(r.resourceUsage))'
ps -u cpci -o pid=,rss=,args= 2>/dev/null | while read -r pid rss exe _; do
  # comm is MainThread on node 24, so match the executable name instead.
  [ "${exe##*/}" = node ] && [ "$rss" -gt "$limit_kb" ] || continue
  grep -qx "$pid" "$state" && continue
  echo "$pid" >> "$state"
  echo "=== RSS watchdog: node pid $pid at $((rss / 1024)) MB (limit $((limit_kb / 1024)) MB)" || true
  ps -o pid=,args= -p "$pid" 2>/dev/null | cut -c1-300 || true
  sig USR2 "$pid"
  printed=
  for _ in $(seq 100); do
    for f in "$dir"/report.*."$pid".*.json; do
      # A report still being written fails to parse; the loop retries until it is whole.
      [ -e "$f" ] && node -e "$print_report" "$f" 2>/dev/null && printed=1 && break 2
    done
    sleep 0.1
  done
  [ -n "$printed" ] || echo "no diagnostic report for pid $pid" || true
  sig KILL "$pid"
done
exit 0
