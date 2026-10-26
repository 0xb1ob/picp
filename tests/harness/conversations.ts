/** Shared fixtures for the behavior 19 scenarios: a viewer on a scratch home with an upload root, and raw HTTP. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, relative } from "node:path";
import { dashboard } from "./dashboard.ts";

export type Json = Record<string, any>;
export type Context = Parameters<typeof dashboard>[0];
export const write = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
export const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
export const lines = (file: string): Json[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
export const mode = (path: string) => statSync(path).mode & 0o777;

type Sent = { status: number; headers: Record<string, string | string[] | undefined>; raw: Buffer; body: Json };
/** One HTTP request with a string or byte body, sent as the viewer's own origin unless `headers` say otherwise. */
export function send(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Sent> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: { host: `127.0.0.1:${port}`, ...init.headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks);
				let body: Json = {};
				try { body = JSON.parse(raw.toString("utf8")); } catch { /* bytes */ }
				resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body });
			});
		});
		req.on("error", reject);
		req.end(init.body);
	});
}

/** A viewer on a scratch home, an upload root inside it, and helpers to post as its own origin. */
export async function viewer(t: Context, options: { requireTailnet?: boolean; at?: string; relativeRoot?: boolean; seed?: (stateDir: string, home: string, env: Record<string, string>) => void } = {}) {
	const env: Record<string, string> = {};
	const d = await dashboard(t, { ...options, env, seed: (stateDir, home) => {
		const uploads = join(home, "uploads");
		env.CP_UPLOAD_ROOT = options.relativeRoot ? relative(process.cwd(), uploads) : uploads;
		options.seed?.(stateDir, home, env);
	} });
	const root = join(d.home, "uploads");
	const own = { origin: d.origin, "sec-fetch-site": "same-origin" };
	const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...own, "content-type": "application/json", ...(token ? { "x-cp-control-token": token } : {}), ...extra } });
	const bytes = (token: string | null, body: Buffer, type = "image/png", extra: Record<string, string> = {}) => ({ method: "POST", body, headers: { ...own, "content-type": type, ...(token ? { "x-cp-control-token": token } : {}), ...extra } });
	let clock = Date.now();
	return { ...d, root, own, json, bytes, send: (path: string, init: Parameters<typeof send>[2] = {}) => send(d.port, path, init), tick: () => d.pin(new Date(clock += 61_000).toISOString()) };
}
export const pick = (row: Json, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row[key]]));
