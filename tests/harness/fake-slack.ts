/**
 * A fake Slack at HTTP/WebSocket: `POST /api/<method>` recorded with time and auth, and a Socket Mode server written on
 * `node:http` upgrade (tests must not import `ws`): `hello` on connect, `emit` an envelope, client frames are `acks`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface SlackCall { at: number; method: string; auth: string | undefined; body: Record<string, any>; status: number; ts?: string }

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
	const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
		: payload.length < 65_536 ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
			: Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
	return Buffer.concat([head, payload]);
}

/** Complete client frames off `buffer` (masked, as RFC 6455 requires of a client), and the rest. */
function readFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
	const frames: Array<{ opcode: number; payload: Buffer }> = [];
	let at = 0;
	for (;;) {
		if (buffer.length - at < 2) break;
		const opcode = buffer[at]! & 0x0f;
		const masked = (buffer[at + 1]! & 0x80) !== 0;
		let length = buffer[at + 1]! & 0x7f;
		let cursor = at + 2;
		if (length === 126) { if (buffer.length < cursor + 2) break; length = buffer.readUInt16BE(cursor); cursor += 2; }
		else if (length === 127) { if (buffer.length < cursor + 8) break; length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8; }
		const key = masked ? buffer.subarray(cursor, cursor + 4) : undefined;
		if (masked) cursor += 4;
		if (buffer.length < cursor + length) break;
		const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
		if (key) for (let i = 0; i < payload.length; i++) payload[i]! ^= key[i % 4]!;
		frames.push({ opcode, payload });
		at = cursor + length;
	}
	return { frames, rest: buffer.subarray(at) };
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, any>; } catch { return {}; }
}

export type FakeSlack = Awaited<ReturnType<typeof startFakeSlack>>;

export async function startFakeSlack() {
	const calls: SlackCall[] = [];
	const acks: string[] = [];
	const fails = new Map<string, number[]>();
	const sockets = new Set<Socket>();
	let upgrades = 0;
	let seq = 0;
	const nextTs = () => `1800000000.${String(++seq).padStart(6, "0")}`;
	const server = createServer((req, res) => {
		void body(req).then((json) => {
			const method = (req.url ?? "").replace(/^\/api\//, "").split("?")[0]!;
			const call: SlackCall = { at: Date.now(), method, auth: req.headers.authorization, body: json, status: 200 };
			calls.push(call);
			const retry = fails.get(method)?.shift();
			const send = (status: number, value: unknown, headers: Record<string, string> = {}) => {
				call.status = status;
				res.writeHead(status, { "content-type": "application/json", ...headers });
				res.end(JSON.stringify(value));
			};
			if (retry !== undefined) return send(429, { ok: false, error: "ratelimited" }, { "retry-after": String(retry) });
			const port = (server.address() as AddressInfo).port;
			if (method === "apps.connections.open") return send(200, { ok: true, url: `ws://127.0.0.1:${port}/socket` });
			if (method === "chat.postMessage") {
				call.ts = nextTs();
				return send(200, { ok: true, channel: json.channel, ts: call.ts });
			}
			if (method === "chat.update") return send(200, { ok: true, channel: json.channel, ts: json.ts });
			return send(200, { ok: false, error: "unknown_method" });
		});
	});
	server.on("upgrade", (req, socket: Socket) => {
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string") return socket.destroy();
		upgrades += 1;
		const accept = createHash("sha1").update(key + GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
		let pending: Buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			const read = readFrames(Buffer.concat([pending, chunk]));
			pending = read.rest;
			for (const { opcode, payload } of read.frames) {
				if (opcode === 0x8) { socket.end(frame(0x8, Buffer.alloc(0))); continue; }
				if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
				if (opcode !== 0x1) continue;
				try {
					const message = JSON.parse(payload.toString("utf8")) as { envelope_id?: unknown };
					if (typeof message.envelope_id === "string") acks.push(message.envelope_id);
				} catch { /* not JSON */ }
			}
		});
		socket.write(frame(0x1, Buffer.from(JSON.stringify({ type: "hello", num_connections: 1 }))));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	const of = (method: string) => calls.filter((call) => call.method === method && call.status === 200);
	return {
		url: `http://127.0.0.1:${port}/api/`,
		calls,
		acks,
		upgrades: () => upgrades,
		connected: () => sockets.size > 0,
		posts: () => of("chat.postMessage"),
		updates: () => of("chat.update"),
		/** The next `count` calls of `method` answer 429 with `retryAfterS`. */
		fail429(method: string, retryAfterS: number, count = 1) { fails.set(method, [...(fails.get(method) ?? []), ...Array<number>(count).fill(retryAfterS)]); },
		/** Sends one Socket Mode envelope to every connected client; resolves to its envelope id. */
		emit(type: "events_api" | "interactive", payload: Record<string, unknown>): string {
			const id = randomUUID();
			for (const socket of sockets) socket.write(frame(0x1, Buffer.from(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false }))));
			return id;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			const closed = new Promise<void>((done) => server.close(() => done()));
			server.closeAllConnections();
			await closed;
		},
	};
}
