/**
 * Whether pi-web-access can search on this home, read from its config and env
 * names only — never a network probe (cp-if9x). Pure: the caller names the
 * config path (`webSearchConfigPath` in worker-packages.ts) and the env.
 *
 * The rules mirror pi-web-access 0.31.0 (`gemini-search.ts`): no config, or a
 * `searchProvider`/`provider` of `auto`/`all`, reaches Exa's keyless public MCP;
 * a configured provider is used directly with no fallback, so a keyed provider
 * without its key cannot search. The key names below are only the ones the
 * package's own "No search provider available" message lists; any other named
 * provider is "key not checked", never guessed and never withheld.
 */
import { existsSync, readFileSync } from "node:fs";

/** provider → [config key, env var]; a configured one with neither set cannot search. */
export const KEYED_PROVIDERS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
	brave: ["braveApiKey", "BRAVE_API_KEY"],
	parallel: ["parallelApiKey", "PARALLEL_API_KEY"],
	tinyfish: ["tinyfishApiKey", "TINYFISH_API_KEY"],
	search1api: ["search1apiApiKey", "SEARCH1API_KEY"],
	searchinfinity: ["searchinfinityApiKey", "SEARCHINFINITY_API_KEY"],
	querit: ["queritApiKey", "QUERIT_API_KEY"],
	tavily: ["tavilyApiKey", "TAVILY_API_KEY"],
	firecrawl: ["firecrawlBaseUrl", "FIRECRAWL_BASE_URL"],
	jina: ["jinaApiKey", "JINA_API_KEY"],
	serpdive: ["serpdiveApiKey", "SERPDIVE_API_KEY"],
	kagi: ["kagiApiKey", "KAGI_API_KEY"],
	bocha: ["bochaApiKey", "BOCHA_API_KEY"],
	ollama: ["ollamaApiKey", "OLLAMA_API_KEY"],
	searxng: ["searxngBaseUrl", "SEARXNG_BASE_URL"],
	perplexity: ["perplexityApiKey", "PERPLEXITY_API_KEY"],
});

/** Providers that may still work without a key (pi auth, ADC, browser sign-in): unverified, never withheld. */
export const AUTH_PROVIDERS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
	openai: ["openaiApiKey", "OPENAI_API_KEY"],
	gemini: ["geminiApiKey", "GEMINI_API_KEY"],
});

export const KEYLESS_PROVIDERS = ["exa", "duckduckgo", "anysearch"] as const;

const EXA_KEY = ["exaApiKey", "EXA_API_KEY"] as const;

export type WebAvailability =
	| { available: true; provider: string; note: "auto" | "keyed" | "keyless" | "unverified" | "unchecked"; keysPresent: string[] }
	| { available: false; provider?: string; reason: string; fix: string };

export function webSearchAvailability(configPath: string, env: NodeJS.ProcessEnv): WebAvailability {
	let raw: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf8"));
		} catch {
			parsed = undefined;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { available: false, reason: "web-search.json does not parse", fix: `fix the JSON in ${configPath}; pi-web-access refuses to search until it parses` };
		}
		raw = parsed as Record<string, unknown>;
	}
	const sel = raw.searchProvider ?? raw.provider;
	const list = typeof sel === "string"
		? [sel.trim().toLowerCase()]
		: Array.isArray(sel) ? sel.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()) : [];
	const set = ([ck, ev]: readonly [string, string]) => [
		...(typeof raw[ck] === "string" && (raw[ck] as string).trim() !== "" ? [ck] : []),
		...((env[ev]?.trim() ?? "") !== "" ? [ev] : []),
	];
	const has = (p: string) => {
		const pair = KEYED_PROVIDERS[p] ?? AUTH_PROVIDERS[p];
		return pair !== undefined && set(pair).length > 0;
	};
	const keysPresent = [...Object.values(KEYED_PROVIDERS), ...Object.values(AUTH_PROVIDERS), EXA_KEY].flatMap(set);
	if (list.length === 0 || (list.length === 1 && (list[0] === "auto" || list[0] === "all"))) {
		return { available: true, provider: "auto", note: "auto", keysPresent };
	}
	const provider = list.join("+");
	const usable = list.filter((p) => !KEYED_PROVIDERS[p] || has(p));
	if (usable.length === 0) {
		return {
			available: false,
			provider,
			reason: `${provider} configured without a key`,
			fix: `set ${list.map((p) => KEYED_PROVIDERS[p]![1]).join(" or ")} in the parent's environment, or ${list.map((p) => KEYED_PROVIDERS[p]![0]).join("/")} in ${configPath}, then restart the parent`,
		};
	}
	const p = usable[0]!;
	const note = KEYED_PROVIDERS[p]
		? "keyed"
		: AUTH_PROVIDERS[p]
			? has(p) ? "keyed" : "unverified"
			: (KEYLESS_PROVIDERS as readonly string[]).includes(p) ? "keyless" : "unchecked";
	return { available: true, provider, note, keysPresent };
}
