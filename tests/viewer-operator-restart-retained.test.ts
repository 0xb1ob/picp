/**
 * Restart session (cp-aqxl), the viewer's half: the viewer holds no process control at all (it forwards one frame;
 * the session stops itself, its cp-operator relaunches it). The route itself is pinned by S27-viewer-route.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "./harness/index.ts";

test("the viewer has no process control: the restart route and page code import no child_process and never spawn, exec, kill or reach tmux/herdr", () => {
	const files = ["src/viewer/operator-restart.ts", "src/viewer/restart-status.ts", "viewer-app/restart-control.ts", "viewer-app/use-restart.ts", "viewer-app/components/RestartSession.tsx"];
	for (const file of files) {
		const code = readFileSync(join(REPO_ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		for (const banned of [/child_process/, /\bspawn\w*\(/, /\bexec\w*\(/, /\.kill\(/, /process\.kill/, /launchers/, /herdrCommand|tmuxCommand/, /\.(tmux|herdr)\b/]) assert.doesNotMatch(code, banned, `${file}: ${banned}`);
	}
});
