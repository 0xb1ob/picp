/**
 * Slack Socket Mode on Node's global `WebSocket` (no dependency, no listener): ack each envelope first, handle them one
 * at a time, reconnect on `disconnect` or close with a fresh URL (1 s doubling to 60 s, reset on `hello`).
 */

export interface SocketModeOptions {
	/** A fresh `wss://` URL (apps.connections.open), or an Error naming why there is none. */
	open(): Promise<string>;
	onEnvelope(type: string, payload: unknown): void | Promise<void>;
	log(line: string): void;
	minBackoffMs?: number;
	maxBackoffMs?: number;
}

export function runSocketMode(options: SocketModeOptions): { stop(): void } {
	const min = options.minBackoffMs ?? 1_000;
	const max = options.maxBackoffMs ?? 60_000;
	let backoff = min;
	let stopped = false;
	let socket: WebSocket | undefined;
	let timer: NodeJS.Timeout | undefined;
	let chain: Promise<void> = Promise.resolve();

	const later = (why: string): void => {
		if (stopped || timer) return;
		options.log(`socket mode: ${why}; reconnecting in ${Math.round(backoff / 1000)}s`);
		timer = setTimeout(() => {
			timer = undefined;
			void connect();
		}, backoff);
		backoff = Math.min(backoff * 2, max);
	};

	const connect = async (): Promise<void> => {
		if (stopped) return;
		let url: string;
		try {
			url = await options.open();
		} catch (error) {
			return later(`no connection URL (${(error as Error).message})`);
		}
		if (stopped) return;
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (error) {
			return later(`cannot open the socket (${(error as Error).message})`);
		}
		socket = ws;
		let closed = false;
		const lost = (why: string): void => {
			if (closed) return;
			closed = true;
			if (socket === ws) socket = undefined;
			try { ws.close(); } catch { /* already closing */ }
			later(why);
		};
		ws.addEventListener("message", (event) => {
			let frame: { type?: unknown; envelope_id?: unknown; payload?: unknown; reason?: unknown };
			try { frame = JSON.parse(String(event.data)) as typeof frame; } catch { return options.log("socket mode: a frame that is not JSON was ignored"); }
			if (frame?.type === "hello") {
				backoff = min;
				return options.log("socket mode: connected");
			}
			if (frame?.type === "disconnect") return lost(`Slack asked to reconnect (${typeof frame.reason === "string" ? frame.reason.slice(0, 40) : "no reason"})`);
			if (typeof frame?.envelope_id === "string") {
				try { ws.send(JSON.stringify({ envelope_id: frame.envelope_id })); } catch { /* the close handler reconnects */ }
				if (typeof frame.type === "string") {
					// One envelope at a time, in arrival order: routing reads what the previous one journaled.
					chain = chain
						.then(() => options.onEnvelope(frame.type as string, frame.payload))
						.catch((error: unknown) => options.log(`envelope ${frame.type as string} failed: ${error instanceof Error ? error.message.slice(0, 200) : "non-Error thrown"}`));
				}
			}
		});
		ws.addEventListener("close", () => lost("the connection closed"));
		ws.addEventListener("error", () => lost("the connection failed"));
	};

	void connect();
	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
			try { socket?.close(); } catch { /* closing */ }
		},
	};
}
