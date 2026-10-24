export interface ReviewerSpawnGuard {
	ownerPid: number;
	receiptPath: string;
	terminalPath: string;
}

/** Publish the exec PID before checking ownership, closing the parent-death registration race. */
export function guardedReviewerCommand(binary: string, args: string[], guard?: ReviewerSpawnGuard) {
	if (!guard) return { binary, args };
	const script = [
		'umask 077; set -C; printf "%s\\n" "$$" > "$1" || exit 75',
		'owner="$2"; terminal="$3"; shift 3; kill -0 "$owner" 2>/dev/null || exit 75',
		'if [ -r "/proc/$owner/status" ]; then',
		'zombie=0; single=0; while read -r field value rest; do',
		'case "$field:$value" in State::Z) zombie=1 ;; Threads::1) single=1 ;; esac',
		'done < "/proc/$owner/status" || exit 75; [ "$zombie:$single" != "1:1" ] || exit 75; fi',
		'[ ! -e "$terminal" ] || exit 75; exec "$@"',
	].join("\n");
	return { binary: "/bin/sh", args: ["-c", script, "cp-reviewer-guard", guard.receiptPath,
		String(guard.ownerPid), guard.terminalPath, binary, ...args] };
}
