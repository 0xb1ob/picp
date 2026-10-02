/**
 * The one `/doctor` line for worker web access (cp-if9x): which provider
 * pi-web-access would use, which profiles load it, or why workers get no web
 * tools and what fixes it. Reads config and env names only — no network probe.
 * Kept out of doctor.ts, which sits at its size ceiling.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorFinding } from "./contracts.ts";
import { listProfiles } from "./profiles.ts";
import { AUTH_PROVIDERS, webSearchAvailability } from "./web-provider.ts";
import { activePackagesForRole, tryResolveWorkerPackages, webSearchConfigPath, type WorkerPackageResolution } from "./worker-packages.ts";

export interface WebAccessOptions {
	packageRoot: string;
	env?: NodeJS.ProcessEnv;
	/** Injected in tests; defaults to a fresh resolution over this home's pi settings. */
	resolve?: () => Promise<WorkerPackageResolution>;
	configPath?: string;
}

const RESTART = " — workers get no web tools until then";

export async function webAccessFindings(o: WebAccessOptions): Promise<DoctorFinding[]> {
	const env = o.env ?? process.env;
	const path = o.configPath ?? webSearchConfigPath(env);
	// The doctor's own env picks the agent dir too, as pi's getAgentDir() does from process.env.
	const r = await (o.resolve ?? (() => tryResolveWorkerPackages(env.PI_CODING_AGENT_DIR || undefined, { env, webConfigPath: path })))();
	const one = (severity: DoctorFinding["severity"], what: string, fix?: string, detail?: string): DoctorFinding[] => [{
		check: "web.search",
		severity,
		what: what.slice(0, 200),
		...(detail ? { detail: detail.slice(0, 2000) } : {}),
		...(fix ? { fix: fix.slice(0, 500) } : {}),
	}];
	if (r.error) {
		return one("warn", "web search: unavailable (worker packages could not be resolved)", "repair ~/.pi/agent/settings.json, then re-run /doctor", r.error.slice(0, 600));
	}
	const withheld = r.withheld?.["pi-web-access"];
	if (withheld) {
		const a = webSearchAvailability(path, env);
		return one("warn", `web search: unavailable (${withheld})`, `${a.available ? "restart the parent" : a.fix}${RESTART}`, path);
	}
	if (!r.packages["pi-web-access"]?.tools?.length) {
		return one("ok", "web search: unavailable (pi-web-access is not installed or not enabled in pi settings)", "pi install npm:pi-web-access, then restart the parent (optional)");
	}
	const active = listProfiles(join(o.packageRoot, "profiles"))
		.filter((p) => activePackagesForRole(r.packages, p.frontmatter.role, p.frontmatter.packages).tools?.includes("web_search"))
		.map((p) => p.frontmatter.name);
	if (active.length === 0) {
		return one("ok", "web search: installed, but no worker profile activates it", "add pi-web-access to ROLE_PACKAGES or a profile's packages:, then restart the parent");
	}
	const a = webSearchAvailability(path, env);
	// The snapshot said available; the config changed since the parent started.
	if (!a.available) return one("warn", `web search: unavailable (${a.reason})`, a.fix);
	const detail = `config ${path}${existsSync(path) ? "" : " (absent)"}; keys set: ${a.keysPresent.join(", ") || "none"}`;
	if (a.note === "unverified") {
		const [key, envName] = AUTH_PROVIDERS[a.provider] ?? ["a provider key", "a provider key env var"];
		return one(
			"warn",
			`web search: unverified (${a.provider} configured with no key; relies on pi auth or Gemini sign-in) for ${active.join(", ")}`,
			`set ${envName} or ${key} in ${path}`,
			detail,
		);
	}
	const label = a.note === "auto"
		? "auto (keyless Exa MCP unless a key is configured)"
		: a.note === "keyless" ? `${a.provider} (keyless)` : a.note === "unchecked" ? `${a.provider} (key not checked by doctor)` : a.provider;
	return one("ok", `web search: available via ${label} to ${active.join(", ")}`, `optional: set searchProvider or a provider key in ${path}`, detail);
}
