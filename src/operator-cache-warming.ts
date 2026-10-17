/**
 * Operator idle cache warming (cp-c1ur N8): pi's idle estimate (15% chance of a next request) lets the operator's
 * 5-minute gaps lapse into full cache writes. Warm whenever one avoided miss pays for the refresh; pi fires this
 * only under `cacheWarming: "idle"` and itself ends idle warming 30 minutes after the last request.
 */
export function operatorCacheWarming(event: { warmCost: number; missCost: number }): { action: "warm" } | undefined {
	return event.missCost > event.warmCost ? { action: "warm" } : undefined;
}
