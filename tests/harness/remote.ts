/**
 * Remote dashboard test rig: a scratch home, a device store on a fake clock, the default local viewer and the remote
 * listener on ephemeral loopback ports, and a plain HTTP client. No tunnel, no network beyond 127.0.0.1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT } from "../../src/contracts.ts";
import { DeviceStore } from "../../src/viewer/device-store.ts";
import type { DeviceBinding } from "../../src/viewer/devices-api.ts";
import { createRemoteViewer, type RemoteOptions } from "../../src/viewer/remote-server.ts";
import { createViewer, type ViewerOptions } from "../../src/viewer/server.ts";
import { createScratchHome } from "./index.ts";

export const REMOTE_ORIGIN = "https://cp.example.test";
export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: Record<string, unknown> };
export type Init = { method?: string; headers?: Record<string, string>; body?: string };

export function call(port: number, path: string, init: Init = {}): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const length = init.body === undefined ? {} : { "content-length": String(Buffer.byteLength(init.body)) };
		const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...length, ...init.headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				let body: Record<string, unknown> = {};
				try { body = JSON.parse(text); } catch { /* not JSON */ }
				resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
			});
		});
		req.on("error", reject);
		req.end(init.body);
	});
}

/** `localDevices`: also give the local listener the device routes (the opt-in Add device / list / revoke). */
export async function remoteRig(t: { after(fn: () => void): void }, { localDevices = false, pushFetch }: { localDevices?: boolean; pushFetch?: ViewerOptions["pushFetch"] } = {}) {
	const home = createScratchHome();
	const uploads = mkdtempSync(join(tmpdir(), "cp-remote-uploads-"));
	t.after(() => { home.cleanup(); rmSync(uploads, { recursive: true, force: true }); });
	const stateDir = join(home.path, LAYOUT.state), dataDir = join(home.path, LAYOUT.data);
	let now = Date.now();
	const clock = { advance: (ms: number) => { now += ms; } };
	const store = new DeviceStore(dataDir, stateDir, { now: () => new Date(now) });
	const bound: { current: DeviceBinding | null } = { current: { origin: REMOTE_ORIGIN, generation: 1 } };
	const devices = { store, binding: () => bound.current };
	const logs: string[] = [];
	const options: ViewerOptions = { home: home.path, stateDir, host: "127.0.0.1", port: 0, uploadRoot: uploads, log: (line) => logs.push(line), ...(localDevices ? { devices } : {}), ...(pushFetch ? { pushFetch } : {}) };
	const localServer = createViewer(options);
	await new Promise<void>((done) => localServer.listen(0, "127.0.0.1", done));
	options.port = (localServer.address() as AddressInfo).port;
	const remote: RemoteOptions = { port: 0, devices, now: () => new Date(now) };
	const remoteServer = createRemoteViewer(options, remote);
	await new Promise<void>((done) => remoteServer.listen(0, "127.0.0.1", done));
	remote.port = (remoteServer.address() as AddressInfo).port;
	t.after(() => { localServer.close(); remoteServer.close(); });
	/** Pair straight through the store (the HTTP claim has its own tests); returns the Cookie header value. */
	const pair = (name: string, level: "full" | "view" = "full"): { cookie: string; id: string } => {
		const issued = store.issueCode({ ...bound.current!, route: "cli-pair", level });
		assert.ok(issued.ok);
		const claimed = store.claim({ ...bound.current!, code: issued.code, name });
		assert.ok(claimed.ok);
		return { cookie: `__Host-cp_device=${claimed.cookie}`, id: claimed.device.id };
	};
	return {
		home, stateDir, dataDir, store, bound, clock, options, remote, uploads, logs, pair, devices,
		r: (path: string, init: Init = {}) => call(remote.port, path, init),
		l: (path: string, init: Init = {}) => call(options.port, path, init),
	};
}
