/** picp shim for the two types the pinned `ClaudeTurnTokenUsage.ts` imports (see pin.json). */
declare module "@t3tools/contracts" {
	export type RuntimeTurnState = "completed" | "failed" | "interrupted" | "cancelled";
	interface TurnTokenUsageCommon {
		readonly usageScope: "main_agent";
		readonly cachedInputTokens?: number;
		readonly cacheCreationTokens?: number;
		readonly reasoningTokens?: number;
		readonly hasSubagents: boolean;
		readonly models?: readonly string[];
		readonly localCommand?: boolean;
		readonly otherUsage?: { readonly inputTokens: number; readonly outputTokens: number };
	}
	export type TurnTokenUsage =
		| (TurnTokenUsageCommon & { readonly usageStatus: "complete"; readonly inputTokens: number; readonly outputTokens: number })
		| (TurnTokenUsageCommon & {
				readonly usageStatus: "partial" | "unavailable";
				readonly inputTokens?: number;
				readonly outputTokens?: number;
		  });
}
