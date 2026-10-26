/**
 * `--import` preload for a child process under test: every `fetch` of an https URL goes to the server at
 * `CP_TEST_FETCH_BASE` instead, as `<base>/<host><path>?<query>`, so a test serves the remote API, never the network.
 * A 599 answer becomes a rejected fetch whose message is the body, as a network error would reject.
 */
const base = process.env.CP_TEST_FETCH_BASE;
if (base) {
	let real = globalThis.fetch;
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.protocol !== "https:") throw new TypeError(`fake-fetch: only https is served, not ${url.href}`);
		const response = await real(`${base}/${url.host}${url.pathname}${url.search}`, init);
		if (response.status === 599) throw new TypeError(await response.text());
		return response;
	}) as typeof fetch;
	// pi installs its own global fetch at startup: that becomes the transport, never a way around the stand-in.
	Object.defineProperty(globalThis, "fetch", { configurable: true, get: () => fake, set: (next: typeof fetch) => void (real = next) });
}
