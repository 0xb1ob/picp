/**
 * Forge identity from a git remote or a change-request URL (forge PR 1).
 *
 * Pure on purpose: no network, no contract or TypeBox import, so the project
 * registry, the forge observers and (later) the viewer share one parser. A
 * repository is its whole namespace path — GitLab nests groups, so it is never
 * shortened to owner/repo — and URL substring matching is never identity.
 *
 * github.com and gitlab.com are recognised from the remote. Any other host is
 * `unsupported` until its project declares a `forge` block: a hostname does not
 * reveal which software serves it, and guessing would send credentials to it.
 * The block names a token's environment variable, never the token.
 */

export type ForgeKind = "github" | "gitlab";

/** A project's optional `forge` block (ProjectSchema). `token_env` is a variable NAME. */
export interface ForgeConfig {
	kind: ForgeKind;
	/** HTTPS installation root, optional port and path prefix (GitLab only). */
	web_base_url?: string;
	/** HTTPS REST root; defaults to `<web_base_url>/api/v4` (GitLab only). */
	api_base_url?: string;
	/** Environment variable holding the GitLab token (GitLab only). */
	token_env?: string;
}

export interface RemoteIdentity {
	/** Lower-cased host; an https remote keeps a non-default port. */
	host: string;
	/** Whole namespace path, `.git` and trailing slashes removed, never case-folded. */
	path: string;
	transport: "https" | "ssh";
}

export interface ForgeRepository {
	kind: ForgeKind;
	/** HTTPS installation root without a trailing slash. */
	web_base_url: string;
	/** GitLab REST root; absent for GitHub, which is read through `gh`. */
	api_base_url?: string;
	/** Project path on the forge: owner/repo, or group/sub/project. */
	path: string;
	token_env?: string;
}

export type ForgeResolution =
	| { ok: true; repository: ForgeRepository }
	| { ok: false; reason: "unsupported" | "invalid"; detail: string };

/** A parsed GitHub pull request or GitLab merge request link. */
export interface ChangeRequestRef {
	kind: ForgeKind;
	/** `https://host[:port]`, lower-cased by URL parsing. */
	origin: string;
	/** Everything between the origin and `/pull/` or `/-/merge_requests/`, installation prefix included. */
	path: string;
	number: number;
}

export const GITLAB_COM_TOKEN_ENV = "GITLAB_TOKEN";
export const TOKEN_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const KNOWN_HOSTS: Readonly<Record<string, ForgeKind>> = { "github.com": "github", "gitlab.com": "gitlab" };
// A leading dot is a real repo name (`.github`); exactly "." or ".." is path traversal and never a segment.
const SEGMENT = /^(?!\.\.?$)[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const POSITIVE = /^[1-9][0-9]{0,9}$/;
const SCP = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/)(\S+)$/;
// Checked on the raw text: URL parsing would silently resolve dot segments (also percent-encoded) away.
const UNSAFE = /[?#\s]|\/(?:\.|%2e){1,2}(?:\/|$)/i;

function urlOf(text: string): URL | undefined {
	try {
		return new URL(text);
	} catch {
		return undefined;
	}
}

/** `a/b/c` with valid segments, or undefined. `.git` and trailing slashes are noise, not identity. */
function cleanPath(raw: string, minSegments = 2): string | undefined {
	const segments = raw.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
	if (segments.length < minSegments || !segments.every((segment) => SEGMENT.test(segment))) return undefined;
	return segments.join("/");
}

/** Parse an https, scp-style (`git@host:group/project.git`) or `ssh://` remote. Credentials, queries and fragments are refused. */
export function parseRemote(url: string): RemoteIdentity | undefined {
	const text = url.trim();
	if (UNSAFE.test(text)) return undefined;
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
	if (scheme === "https" || scheme === "http" || scheme === "ssh") {
		const parsed = urlOf(text);
		// An ssh user name (git@) is not a secret; any http(s) user info or any password is refused.
		if (!parsed || parsed.password || (scheme !== "ssh" && parsed.username)) return undefined;
		const hostname = parsed.hostname.toLowerCase();
		const path = cleanPath(parsed.pathname.slice(1));
		if (!HOSTNAME.test(hostname) || !path) return undefined;
		if (scheme === "ssh") return { host: hostname, path, transport: "ssh" };
		return { host: parsed.port ? `${hostname}:${parsed.port}` : hostname, path, transport: "https" };
	}
	if (scheme) return undefined;
	const scp = SCP.exec(text);
	const host = scp?.[1]?.toLowerCase();
	const path = scp ? cleanPath(scp[2] as string) : undefined;
	return host && path && HOSTNAME.test(host) ? { host, path, transport: "ssh" } : undefined;
}

/** `https://host[:port][/prefix]` without a trailing slash, or undefined for anything else. */
export function normalizeBaseUrl(url: string): string | undefined {
	const text = url.trim();
	if (UNSAFE.test(text) || !/^https:\/\//i.test(text)) return undefined;
	const parsed = urlOf(text);
	if (!parsed || parsed.username || parsed.password || !HOSTNAME.test(parsed.hostname)) return undefined;
	const prefix = parsed.pathname.replace(/\/+$/, "");
	if (prefix && !cleanPath(prefix.slice(1), 1)) return undefined;
	return `${parsed.origin}${prefix}`;
}

/** Why a `forge` block is unusable; empty when it is valid. Never echoes a value that might be a secret. */
export function forgeConfigErrors(config: ForgeConfig): string[] {
	const errors: string[] = [];
	if (config.kind !== "github" && config.kind !== "gitlab") return [`forge.kind must be github or gitlab`];
	if (config.kind === "github") {
		// GitHub is read through gh, which owns its own host and auth; GitHub Enterprise is not implemented.
		for (const key of ["web_base_url", "api_base_url", "token_env"] as const) {
			if (config[key] !== undefined) errors.push(`forge.${key} is GitLab-only; a github forge takes only kind (github.com through gh)`);
		}
		return errors;
	}
	for (const key of ["web_base_url", "api_base_url"] as const) {
		const value = config[key];
		if (value !== undefined && !normalizeBaseUrl(value)) {
			errors.push(`forge.${key} must be an https URL with no credentials, query or fragment`);
		}
	}
	if (config.token_env !== undefined && !TOKEN_ENV_PATTERN.test(config.token_env)) {
		errors.push(`forge.token_env must be an environment variable NAME (${TOKEN_ENV_PATTERN.source}), never a token`);
	}
	return errors;
}

/**
 * The forge repository a clone url names, under an optional project `forge`
 * block. An https remote on another host than the configured web root is
 * refused, so a configured token is never aimed at a host the remote is not on.
 */
export function resolveForgeRepository(cloneUrl: string, config?: ForgeConfig): ForgeResolution {
	const remote = parseRemote(cloneUrl);
	if (!remote) {
		return { ok: false, reason: "invalid", detail: "the remote is not an https, scp-style or ssh:// url with a namespace/project path (credentials, queries and fragments are refused)" };
	}
	if (config) {
		const errors = forgeConfigErrors(config);
		if (errors.length > 0) return { ok: false, reason: "invalid", detail: errors.join("; ") };
	}
	const kind = config?.kind ?? KNOWN_HOSTS[remote.host];
	if (!kind) {
		return { ok: false, reason: "unsupported", detail: `${remote.host} is not a recognised forge; declare it with cp_project forge (kind gitlab, web_base_url)` };
	}
	if (kind === "github") {
		if (remote.host !== "github.com") return { ok: false, reason: "unsupported", detail: `${remote.host}: only github.com is supported for GitHub (no GitHub Enterprise)` };
		if (remote.path.split("/").length !== 2) return { ok: false, reason: "invalid", detail: "a GitHub remote path is exactly owner/repo" };
		return { ok: true, repository: { kind, web_base_url: "https://github.com", path: remote.path } };
	}
	const web = normalizeBaseUrl(config?.web_base_url ?? `https://${remote.host}`);
	const webUrl = web ? urlOf(web) : undefined;
	if (!web || !webUrl) return { ok: false, reason: "invalid", detail: "no usable https web root for this remote; set forge.web_base_url" };
	let path = remote.path;
	if (remote.transport === "https") {
		if (remote.host !== webUrl.host) {
			return { ok: false, reason: "invalid", detail: `the https remote is on ${remote.host}, not the configured ${webUrl.host}` };
		}
		const prefix = webUrl.pathname.replace(/^\/+|\/+$/g, "");
		if (prefix) {
			if (!path.startsWith(`${prefix}/`)) return { ok: false, reason: "invalid", detail: `the https remote is not under the configured installation path /${prefix}` };
			path = path.slice(prefix.length + 1);
		}
		if (!cleanPath(path)) return { ok: false, reason: "invalid", detail: "a GitLab project path is namespace/project" };
	}
	const api = normalizeBaseUrl(config?.api_base_url ?? `${web}/api/v4`) as string;
	// The default gitlab.com token goes only to the gitlab.com API, never to another configured API host.
	const tokenEnv = config?.token_env ?? (urlOf(api)?.host === "gitlab.com" ? GITLAB_COM_TOKEN_ENV : undefined);
	return {
		ok: true,
		repository: {
			kind,
			web_base_url: web,
			api_base_url: api,
			path,
			...(tokenEnv ? { token_env: tokenEnv } : {}),
		},
	};
}

/**
 * Parse a GitHub `/pull/<n>` (github.com only) or GitLab
 * `/<namespace>/-/merge_requests/<iid>` link (any https host). HTTPS only; no
 * credentials, query or fragment; a positive number. Undefined otherwise.
 */
export function parseChangeRequestUrl(url: string): ChangeRequestRef | undefined {
	const text = url.trim();
	if (UNSAFE.test(text) || !/^https:\/\//i.test(text)) return undefined;
	const parsed = urlOf(text);
	if (!parsed || parsed.username || parsed.password || !HOSTNAME.test(parsed.hostname)) return undefined;
	const pathname = parsed.pathname.replace(/\/+$/, "");
	const gitlab = /^\/(.+)\/-\/merge_requests\/([^/]+)$/.exec(pathname);
	if (gitlab && cleanPath(gitlab[1] as string) === gitlab[1] && POSITIVE.test(gitlab[2] as string)) {
		return { kind: "gitlab", origin: parsed.origin, path: gitlab[1] as string, number: Number(gitlab[2]) };
	}
	const github = /^\/([^/]+\/[^/]+)\/pull\/([^/]+)$/.exec(pathname);
	if (github && parsed.host === "github.com" && cleanPath(github[1] as string) === github[1] && POSITIVE.test(github[2] as string)) {
		return { kind: "github", origin: parsed.origin, path: github[1] as string, number: Number(github[2]) };
	}
	return undefined;
}

/** Safe-link predicate for a PR/MR url (shape only, never trust in an API endpoint). */
export function isSafeChangeRequestUrl(url: string): boolean {
	return parseChangeRequestUrl(url) !== undefined;
}

/** The canonical web url of change request `number` in `repository`. */
export function changeRequestUrl(repository: ForgeRepository, number: number): string {
	return `${repository.web_base_url}/${repository.path}${repository.kind === "github" ? "/pull/" : "/-/merge_requests/"}${number}`;
}

/** True when `ref` is a change request of exactly this repository (host, installation prefix and whole path). */
export function changeRequestBelongsTo(ref: ChangeRequestRef, repository: ForgeRepository): boolean {
	return ref.kind === repository.kind && `${ref.origin}/${ref.path}` === `${repository.web_base_url}/${repository.path}`;
}
