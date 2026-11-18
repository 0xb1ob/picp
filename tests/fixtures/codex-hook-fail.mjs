// A PreToolUse hook that fails on purpose, for the CX-0c control and the live LS-3b probe:
// `exit1` exits 1, `stall` never answers, `selfkill` dies by SIGKILL. It reads stdin and decides nothing.
const mode = process.argv[2] ?? "exit1";
process.stdin.resume();
if (mode === "exit1") {
	process.stderr.write("codex-hook-fail: exit 1\n");
	process.exit(1);
}
if (mode === "selfkill") process.kill(process.pid, "SIGKILL");
if (mode === "stall") setInterval(() => {}, 60_000);
