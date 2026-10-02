/**
 * Hermetic pi config dir for tests.
 *
 * `PI_CODING_AGENT_DIR` moves settings, auth, trust and models.json into a
 * throwaway directory, so a test can never read the operator's credentials,
 * trust decisions or installed packages — and can never write them either.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockProvider } from "./mock-provider.ts";

export interface AgentDirOptions {
	provider?: MockProvider;
	/** Extra settings.json keys (merged over the hermetic defaults). */
	settings?: Record<string, unknown>;
}

export interface AgentDir {
	path: string;
	/** Env additions every pi child in this test must carry. */
	env: NodeJS.ProcessEnv;
	/** Rewrite models.json after registering more scripts. */
	writeModels(provider: MockProvider): void;
	cleanup(): void;
}

export function createAgentDir(options: AgentDirOptions = {}): AgentDir {
	const path = mkdtempSync(join(tmpdir(), "cp-agent-"));
	const settings = {
		// Never trust project-local `.pi/` in a fixture repo.
		defaultProjectTrust: "never",
		quietStartup: true,
		enableInstallTelemetry: false,
		...options.settings,
	};
	writeFileSync(join(path, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

	const writeModels = (provider: MockProvider): void => {
		writeFileSync(join(path, "models.json"), `${JSON.stringify(provider.modelsJson(), null, 2)}\n`);
	};
	if (options.provider) writeModels(options.provider);

	return {
		path,
		env: {
			PI_CODING_AGENT_DIR: path,
			PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
		},
		writeModels,
		cleanup() {
			rmSync(path, { recursive: true, force: true });
		},
	};
}
