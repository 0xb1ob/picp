// shortcut: a copy of contracts/settings.ts publicUrlError, as the viewer boundary bars ../contracts.ts here;
// tests/settings-retained.test.ts (c) fails if the two disagree on any probe.
const PUBLIC_URL_MAX = 400;

/** Why `value` is not a usable `viewer.public_url`, or undefined: absolute http(s), no userinfo, query or fragment. */
export function publicUrlError(value: unknown): string | undefined {
	if (typeof value !== "string") return "must be a string";
	if (value.length > PUBLIC_URL_MAX) return `must be at most ${PUBLIC_URL_MAX} characters`;
	let url: URL;
	try { url = new URL(value); } catch { return `${JSON.stringify(value)} is not an absolute URL; use https://host[/prefix]`; }
	if (url.protocol !== "https:" && url.protocol !== "http:") return `${url.protocol} is not allowed; use https:// or http://`;
	if (!/^https?:\/\/[^/?#@\\\s]+(?:\/[^?#\\\s]*)?$/i.test(value)) return "must be http(s)://host[:port][/prefix] with no user name, password, query or fragment";
	return undefined;
}
