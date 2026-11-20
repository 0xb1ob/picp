/**
 * `/doctor` Codex lines (C8): selection's own probes (containment, `codex --version`, the `login status` exit code) and
 * the switches and rows using codex. Advisory: `ok` with its fix while nothing uses codex, `warn` once something does.
 * Never opens the Codex home; kept out of doctor.ts, which sits at its ceiling.
 */
import type { DoctorFinding, RoutingRule } from "./contracts.ts";
import { codexHomeOf, codexRowClass } from "./drivers/codex.ts";
import { codexLoginRefusal, resolveCodexAsync } from "./drivers/codex-cli.ts";
import { resolveCodexContainment } from "./drivers/codex-containment.ts";
import { loadRoutingConfig } from "./routing.ts";
import { CODEX_CLASSES, loadNativeConfig, type NativeConfig, nativeConfigFile } from "./worker-driver.ts";
import { WORKER_MEMORY_MAX_ENV } from "./worker-scope.ts";

const finding = (check: string, severity: DoctorFinding["severity"], what: string, fix?: string, detail?: string): DoctorFinding =>
	({ check, severity, what: what.slice(0, 200), ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });

export async function codexFindings(o: { home: string; env?: NodeJS.ProcessEnv }): Promise<DoctorFinding[]> {
	const env = o.env ?? process.env;
	let config: NativeConfig | undefined;
	let unreadable: string | undefined;
	try {
		config = loadNativeConfig(nativeConfigFile(o.home));
	} catch (error) {
		unreadable = (error as Error).message;
	}
	let rows: RoutingRule[] = [];
	try {
		rows = loadRoutingConfig(o.home).rubric.filter((row) => row.driver === "codex");
	} catch {
		// an unreadable routing file is named by its own config.routing line
	}
	const on = CODEX_CLASSES.filter((name) => config?.[name] === true);
	const sev: DoctorFinding["severity"] = on.length || rows.length ? "warn" : "ok";
	const out: DoctorFinding[] = [];

	const memory = env[WORKER_MEMORY_MAX_ENV];
	try {
		const contained = resolveCodexContainment({ ...env, ...(memory ? { CP_CODEX_MEMORY_MAX: memory } : {}) });
		out.push(finding("codex.containment", "ok", "codex containment: systemd-run found", undefined, `${contained.systemdRun}; the first codex run proves the user scope`));
	} catch (error) {
		out.push(finding("codex.containment", sev, (error as Error).message,
			"install systemd (systemd-run) with a user manager (lingering enabled for this user), or fix CP_WORKER_MEMORY_MAX; codex never runs uncontained"));
	}
	let path: string | undefined;
	try {
		const codex = await resolveCodexAsync(env);
		path = codex.path;
		out.push(finding("codex.cli", "ok", `codex ${codex.version}`, undefined, codex.path));
	} catch (error) {
		const missing = (error as { cli?: string }).cli === "missing";
		out.push(finding("codex.cli", sev, (error as Error).message, missing ? "install the Codex CLI, then run `codex update`" : "run `codex update`"));
	}
	if (path !== undefined) {
		const login = await codexLoginRefusal(path, { codexHome: codexHomeOf(env), home: "/nonexistent", pathEnv: env.PATH ?? "" });
		out.push(login === undefined ? finding("codex.login", "ok", "codex is signed in") : finding("codex.login", sev, login, "run `codex login` as the user picp runs as"));
	}

	const switches = CODEX_CLASSES.map((name) => `${name} ${config?.[name] ? "on" : "off"}`).join(", ");
	const named = rows.length ? `rows naming codex: ${rows.map((row) => row.id).join(", ")}` : "no rubric row names codex";
	if (unreadable !== undefined) {
		out.push(finding("codex.workers", "warn", "Codex workers: data/native.json is unreadable, so every codex switch reads off",
			"fix data/native.json by hand (or restore it in Settings → Native workers)", `${unreadable.slice(0, 600)}; ${named}`));
		return out;
	}
	const dark = rows.filter((row) => {
		const codexClass = codexRowClass(row.role);
		return codexClass === undefined || !config?.[codexClass];
	});
	const detail = `${switches}; codex_max_concurrent ${config?.codex_max_concurrent ?? 1}; ${named}`;
	out.push(dark.length
		? finding("codex.workers", "warn", `Codex workers: ${dark.length} codex row(s) run pi because their class switch is off`,
			`turn ${[...new Set(dark.map((row) => codexRowClass(row.role) ?? `no class for ${row.role}`))].join(", ")} on in Settings → Native workers, or remove the driver from ${dark.map((row) => row.id).join(", ")}`,
			detail)
		: finding("codex.workers", "ok", on.length ? `Codex workers: ${on.join(", ")} on` : "Codex workers: every codex switch off (shipped default)", undefined, detail));
	return out;
}
