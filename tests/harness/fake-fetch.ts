/**
 * `--import` preload for a child process under test: every `fetch` of an https URL goes to the server at
 * `CP_TEST_FETCH_BASE` instead, as `<base>/<host><path>?<query>`, so a test serves the remote API, never the network.
 */
const base = process.env.CP_TEST_FETCH_BASE;
if (base) {
	const real = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.protocol !== "https:") return Promise.reject(new TypeError(`fake-fetch: only https is served, not ${url.href}`));
		return real(`${base}/${url.host}${url.pathname}${url.search}`, init);
	}) as typeof fetch;
}
