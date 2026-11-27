/**
 * The Slack Web API calls over `fetch`: `apps.connections.open` (app token), `chat.postMessage` and `chat.update` (bot
 * token). Results are ok, retry (429 with Retry-After, 5xx, network) or fail; tokens are never logged or returned.
 */

export type SlackResult = { kind: "ok"; data: Record<string, unknown> } | { kind: "retry"; afterS: number | null; reason: string } | { kind: "fail"; reason: string };
export const SLACK_TIMEOUT_MS = 10_000;
const DEFAULT_BASE = "https://slack.com/api/";

/** `CP_CHANNELS_SLACK_API` is a test seam: only a loopback http base is taken, anything else is refused. */
export function slackApiBase(env: NodeJS.ProcessEnv): string {
	const override = env.CP_CHANNELS_SLACK_API;
	if (override === undefined || override === "") return DEFAULT_BASE;
	let url: URL;
	try { url = new URL(override); } catch { throw new Error("CP_CHANNELS_SLACK_API is not a URL"); }
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("CP_CHANNELS_SLACK_API must be an http://127.0.0.1:<port>/ base (a test seam)");
	return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

export class SlackApi {
	readonly #base: string;
	readonly #fetch: typeof fetch;
	constructor(base: string, fetchImpl: typeof fetch = fetch) {
		this.#base = base;
		this.#fetch = fetchImpl;
	}

	async call(method: string, token: string, body?: Record<string, unknown>): Promise<SlackResult> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#base}${method}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify(body ?? {}),
				signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
			});
		} catch (error) {
			return { kind: "retry", afterS: null, reason: `${method}: ${(error as Error).name === "TimeoutError" ? "timed out" : "network error"}` };
		}
		if (response.status === 429) {
			const after = Number(response.headers.get("retry-after"));
			return { kind: "retry", afterS: Number.isFinite(after) && after >= 0 ? after : 30, reason: `${method}: HTTP 429` };
		}
		if (response.status >= 500) return { kind: "retry", afterS: null, reason: `${method}: HTTP ${response.status}` };
		let data: Record<string, unknown>;
		try { data = (await response.json()) as Record<string, unknown>; } catch { return { kind: "fail", reason: `${method}: HTTP ${response.status}, not JSON` }; }
		if (data?.ok !== true) return { kind: "fail", reason: `${method}: ${typeof data?.error === "string" ? data.error.slice(0, 80) : `HTTP ${response.status}`}` };
		return { kind: "ok", data };
	}

	connectionsOpen(appToken: string): Promise<SlackResult> { return this.call("apps.connections.open", appToken); }
	postMessage(botToken: string, message: { channel: string; thread_ts: string; text: string; blocks: unknown[] }): Promise<SlackResult> {
		return this.call("chat.postMessage", botToken, { ...message, unfurl_links: false, unfurl_media: false });
	}
	update(botToken: string, message: { channel: string; ts: string; text: string; blocks: unknown[] }): Promise<SlackResult> {
		return this.call("chat.update", botToken, message);
	}
}
