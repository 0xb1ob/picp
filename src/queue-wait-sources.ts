/** cp_next and cp_status_block's queue waits, from sources resolved as the dispatcher resolves them. */
import { join } from "node:path";
import { LAYOUT } from "./contracts.ts";
import { nativeDriverSpec } from "./drivers/registry.ts";
import { jobsFile } from "./ledger.ts";
import { queueWaits } from "./viewer/queue-wait.ts";

/** LAYOUT/paths for the files and each CLI's own `maxConcurrent` (the limit its slot refusal enforces). */
export function homeQueueWaits(home: string, now = Date.now()): ReturnType<typeof queueWaits> {
	return queueWaits({ home, stateDir: join(home, LAYOUT.state) }, {
		ledgerFile: jobsFile(home),
		dispatchQueueFile: join(home, LAYOUT.dispatchQueueFile),
		nativeWaitFile: join(home, LAYOUT.nativeWaitFile),
		maxConcurrent: (driver) => (driver === "claude" || driver === "codex" ? nativeDriverSpec(driver).maxConcurrent(home) : undefined),
	}, now);
}
