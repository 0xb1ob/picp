/**
 * A driver process for the abrupt-kill KC5 cases: `node codex-spike-driver.ts <CodexSpikeOptions JSON>` runs one
 * `runCodexSpike` and writes the app-server pid and thread id to `<runDir>/driver.json` as they appear.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CodexSpikeOptions, runCodexSpike } from "../../src/drivers/codex-spike.ts";

const options = JSON.parse(process.argv[2] ?? "{}") as CodexSpikeOptions;
const seen: { appServer?: number; threadId?: string } = {};
const save = () => {
	mkdirSync(options.job.runDir, { recursive: true });
	writeFileSync(join(options.job.runDir, "driver.json"), JSON.stringify(seen));
};
await runCodexSpike({
	...options,
	onAppServer: (pid) => {
		seen.appServer = pid;
		save();
	},
	onMessage: (method, params) => {
		const threadId = (params as { threadId?: unknown } | undefined)?.threadId;
		if (method === "turn/started" && typeof threadId === "string") {
			seen.threadId = threadId;
			save();
		}
	},
});
