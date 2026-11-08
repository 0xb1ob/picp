/** A timed-out durable-wake wait's diagnostics: outbox, provider requests, stamped RPC records and child stderr. */
import { DurableWakeupOutbox } from "../../src/wakeup-outbox.ts";
import type { RecordedRequest } from "./mock-provider.ts";
import type { RpcSession } from "./rpc.ts";

const LINE_MAX = 4000;
const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "?");
// A line past gh's 64 KiB log line limit drops the rest of the step log, this trail included.
const cap = (line: string) => (line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)}… [${line.length} chars]` : line);

/** `stamp()` from a wait's read timestamps new RPC records; `explain(error)` adds the trail without ever masking it. */
export function wakeTrail(home: string, child: Pick<RpcSession, "records" | "stderr">, requests: () => readonly RecordedRequest[]) {
	const startedAt = Date.now();
	const rpc: string[] = [];
	let seen = child.records().length;
	return {
		stamp(): void {
			const all = child.records();
			for (; seen < all.length; seen++) rpc.push(`${iso(Date.now())} rpc ${all[seen]!.type}`);
		},
		explain(error: unknown): Error {
			let detail: string;
			try {
				const outbox = new DurableWakeupOutbox({ home }).read();
				detail = [
					`trail started ${iso(startedAt)}; built ${iso(Date.now())}`,
					`outbox pending=${JSON.stringify(outbox.pending.map((e) => ({ id: e.id, queued_at: e.queued_at })))}`,
					`outbox sends=${JSON.stringify(outbox.sends ?? [])}`,
					`outbox delivered=${JSON.stringify(outbox.delivered)} discarded=${JSON.stringify(outbox.discarded ?? [])}`,
					...requests().map((r, i) => `request#${i} at=${iso(r.at)} last=${String(JSON.stringify(r.body.messages?.at(-1))).slice(0, 300)}`),
					"rpc records (first seen by the wait's poll):", ...rpc,
					`stderr: ${child.stderr().slice(-1500)}`,
				].map(cap).join("\n");
			} catch (trailError) {
				detail = `trail unavailable: ${(trailError as Error).message ?? String(trailError)}`;
			}
			return new Error(`${(error as Error).message}\nwake-surface trail:\n${detail}`);
		},
	};
}
