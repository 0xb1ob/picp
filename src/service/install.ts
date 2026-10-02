/**
 * `node APP/src/service/install.ts [flags]` — the node half of the one-command
 * install (cp-daemon v1 P2, design D; `scripts/install.sh` places the code and
 * execs this). Idempotent: a second run reports every step `ok`/`skip`. Never
 * sudo; a changed unit, wrapper or data/daemon.json is replaced only with `--force`.
 *
 * It writes `data/daemon.json` and starts cp-daemon, the one runtime per home (parent supervisor, viewer,
 * health, update): the thin `cp-daemon.service` on systemd, detached otherwise (daemon-backend.ts, the only
 * module that runs systemctl). A home still on the legacy cp-* units migrates here (M1, docs/service.md).
 *
 *   --home DIR          the home (default ~/.pi-command-post)
 *   --app DIR           the checkout cp-daemon runs (default: this one)
 *   --port N            the viewer port (default 8766)
 *   --parent-model M    data/daemon.json parent_model and the wrapper's CP_PARENT_MODEL (on a fresh install
 *                       the operator's too, when --operator-model is absent); default: the kept pin, else a
 *                       prompt over the models `pi --no-extensions --list-models` lists as the daemon sees them
 *   --operator-model M  CP_OPERATOR_MODEL in the wrapper: the operator session's --model (its own prompt
 *                       defaults to the parent's pick)
 *   --gateway-url URL   the optional sub2api gateway (https origin): data/capacity.json, written once
 *   --gateway-key-file PATH  its admin key (first line), copied to ~/.config/pi-command-post/gateway.env (0600)
 *   --viewer-host IP    pin the dashboard's bind address (data/daemon.json viewer_host): a Tailscale,
 *                       private-LAN or loopback address of this machine; default: the previous install's,
 *                       else asked (Tailscale recommended), else the Tailscale address when there is one
 *   --push-origin URL   run push-init once when push is not set up
 *   --force             replace changed files; always npm ci
 *   --no-start          enable (systemd) or configure (detached), do not start; a legacy home is not migrated
 *   --no-update         data/update.json enabled:false
 *   --crontab           detached: add one marked `@reboot` line that starts cp-daemon (only when crontab -l works)
 *   --uninstall         stop cp-daemon (never the parent host), remove its unit, the operator files and
 *                       data/daemon.json (home and app untouched)
 *   --dry-run           probe and print; change nothing (never prompts)
 *   --yes, --no-prompt  take every default without asking
 *   --with-br, --no-br  answer the br (beads CLI) prompt
 *   --no-pi-packages    do not `pi install` the worker packages
 *   --no-self-package   accepted, no effect (single-project mode was removed)
 *
 * P2i adds, after the required tools: gh login, the pi-lens host tools, the pi
 * packages workers load (`ROLE_PACKAGES`), and the
 * optional br/tmux/push/provider-login checks. Prompts read /dev/tty, so
 * `curl | sh` still asks; with no terminal every prompt takes its default.
 *
 * Every step prints `ok|changed|skip|fail: <step>: <detail>`; exit 1 on any fail.
 */
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { layoutForHome } from "../contracts.ts";
import { PACKAGE_ROOT, standardHome } from "../home.ts";
import { OPTIONAL_TOOL_INFO, PI_LENS_TOOLS, REQUIRED_TOOLS } from "../tool-manifest.ts";
import { DEFAULT_PORT } from "../viewer/cli.ts";
import { ROLE_PACKAGES } from "../worker-packages.ts";
import { currentHost, ParentHostClient, parentHostPaths } from "../parent-host.ts";
import { ghLoggedIn } from "./health.ts";
import { herdrPiIntegrated, onPath } from "../viewer/launchers.ts";
import { DAEMON_UNIT, installTargets, OPERATOR_RESUME_UNIT, OPERATOR_UNIT, OPERATOR_WRAPPER, PARENT_UNIT, renderDaemonUnit, renderOperatorWrapper, renderUnits, type UnitInput, unitParentModel, unitPath, unitViewerHost, VIEW_UNIT, wrapperModels, wrapperViewerHost } from "./units.ts";
import { activate, type BackendContext, deactivate, detectBackend, legacyPreflight, legacyPresent, linger } from "./daemon-backend.ts";
import { type DaemonConfig, daemonPaths, validateDaemonConfig } from "./daemon-files.ts";
import { chooseModels } from "./models.ts";
import { gatewayStep } from "./gateway.ts";
import { sameLock } from "../worktree-deps.ts";
import { gatewayKeyFile } from "../gateway-key.ts";
import { bindHostRefusal, type HostCandidate, type LocalAddress, localAddresses, parseTailscaleIp, sameAddress, viewerHostCandidates } from "../viewer/bind-host.ts";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type StepStatus = "ok" | "changed" | "skip" | "fail";
export interface RunResult { status: number; stdout: string; stderr: string }

export interface InstallPorts {
	/** `env` replaces the process environment (the model listing runs with cp-daemon's view). */
	run(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): RunResult;
	/** File text, or undefined when absent. */
	read(path: string): string | undefined;
	write(path: string, text: string, mode: number): void;
	/** A secret: its dir 0700, the file 0600, written to an exclusive temp file and renamed over. */
	writeSecret(path: string, text: string): void;
	/** Permission bits (`& 0o777`), or undefined when absent. */
	mode(path: string): number | undefined;
	exists(path: string): boolean;
	mkdir(path: string, mode: number): void;
	remove(path: string): void;
	/** Whether this user may write `path` (npm's global prefix: never sudo). */
	writable(path: string): boolean;
	/** One prompt line from the human, or undefined when there is no terminal. */
	ask(question: string): string | undefined;
	env: NodeJS.ProcessEnv;
	/** The node binary cp-daemon runs, and its version. */
	node: { path: string; version: string };
	/** Step 11: wait for the host's parent, then its `/doctor` text (host `doctor` op). */
	doctor(home: string, timeoutMs: number): Promise<{ text: string; level: string }>;
	/** Step 9's verify window between `is-active` polls. */
	sleep(ms: number): Promise<void>;
	log(line: string): void;
	/** This machine's interfaces (`os.networkInterfaces()`): where a --viewer-host must be. */
	interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export interface InstallFlags {
	home?: string;
	app?: string;
	port?: string;
	"parent-model"?: string;
	"operator-model"?: string;
	"gateway-url"?: string;
	"gateway-key-file"?: string;
	"viewer-host"?: string;
	"push-origin"?: string;
	force?: boolean;
	"no-start"?: boolean;
	"no-update"?: boolean;
	crontab?: boolean;
	uninstall?: boolean;
	"dry-run"?: boolean;
	yes?: boolean;
	"no-prompt"?: boolean;
	"with-br"?: boolean;
	"no-br"?: boolean;
	"no-pi-packages"?: boolean;
	"no-self-package"?: boolean;
}

export function parseInstallArgs(argv: readonly string[]): InstallFlags {
	const text = { type: "string" } as const;
	const flag = { type: "boolean" } as const;
	return parseArgs({ args: [...argv], options: { home: text, app: text, port: text, "parent-model": text, "operator-model": text, "gateway-url": text, "gateway-key-file": text, "viewer-host": text, "push-origin": text, force: flag, "no-start": flag, "no-update": flag, crontab: flag, uninstall: flag, "dry-run": flag, yes: flag, "no-prompt": flag, "with-br": flag, "no-br": flag, "no-pi-packages": flag, "no-self-package": flag } }).values;
}


const GENERATED = "Generated by cp-install";

export async function install(flags: InstallFlags, ports: InstallPorts): Promise<number> {
	const dry = flags["dry-run"] === true;
	const force = flags.force === true;
	const noStart = flags["no-start"] === true;
	let failed = false;
	const step = (status: StepStatus, name: string, detail: string): void => {
		if (status === "fail") failed = true;
		ports.log(`${status}: ${name}: ${detail}${dry && status === "changed" ? " (dry-run)" : ""}`);
	};
	const ok = (result: RunResult) => result.status === 0;
	const home = resolve(flags.home ?? standardHome(ports.env));
	const app = resolve(flags.app ?? PACKAGE_ROOT);
	const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
	const { unitDir, binDir } = installTargets(ports.env);
	const paths = daemonPaths(home);
	// Launchers (src/viewer/launchers.ts): the cp-daemon-run viewer runs the absolute tmux on its PATH (the installing
	// PATH, data/daemon.json `path`) and the wrapper itself (cp-rrye); herdr is the absolute herdr on that PATH.
	const tmux = onPath("tmux", ports.env.PATH ?? "", ports.exists);
	const herdr = onPath("herdr", ports.env.PATH ?? "", ports.exists);
	const unitInput: UnitInput = { node: ports.node.path, app, home, path: ports.env.PATH ?? "", port };
	let daemonUnit: string;
	try {
		renderUnits(unitInput); // still the port and env-word check (the legacy renderers stay as childEnv's parity reference)
		daemonUnit = renderDaemonUnit(unitInput);
	} catch (error) {
		step("fail", "unit", (error as Error).message);
		return 1;
	}

	// 1. Preflight.
	const major = Number(/^v?(\d+)/.exec(ports.node.version)?.[1]);
	if (!(major >= 24)) step("fail", "node", `${ports.node.path} is ${ports.node.version}; install node 24 or newer (nodejs.org, fnm or nvm), then rerun — node is never installed here`);
	else step("ok", "node", `${ports.node.path} ${ports.node.version}`);
	// pi, treehouse and gh are step 3's to install; git is needed before anything else.
	if (ok(ports.run("git", ["--version"]))) step("ok", "git", "on PATH");
	else step("fail", "git", "git is not runnable on PATH; install it, then rerun");
	const locals = flags.uninstall ? [] : localAddresses(ports.interfaces());
	let flagHost: string | undefined;
	if (flags["viewer-host"] !== undefined && !flags.uninstall) {
		const picked = localHost(flags["viewer-host"], locals);
		if ("reason" in picked) step("fail", "viewer-host", `${picked.reason}; the dashboard serves write controls, so only a Tailscale, private-LAN or loopback address of this machine is accepted`);
		else flagHost = picked.host;
	}
	if (failed) return 1;
	const { backend, detail: backendDetail } = detectBackend(ports.run);
	const systemd = backend === "systemd";
	step("ok", "service", backendDetail);
	let previousConfig: DaemonConfig | undefined;
	try {
		const text = ports.read(paths.config);
		previousConfig = text === undefined ? undefined : validateDaemonConfig(JSON.parse(text));
	} catch (error) {
		step("skip", "daemon", `${paths.config} is unreadable (${(error as Error).message}); its pins are not kept and --force replaces it`);
	}
	const baseConfig: DaemonConfig = { schema_version: 1, generated_by: "cp-install", backend, node: ports.node.path, app, home, path: unitPath(ports.node.path, ports.env.PATH ?? ""), port };
	const ctx: BackendContext = { ports, config: baseConfig, unitDir, dry, force, noStart, crontab: flags.crontab === true, changed: false, step };
	const operatorUnits = [OPERATOR_UNIT, OPERATOR_RESUME_UNIT];

	if (flags.uninstall) {
		// Never stop cp-operator.service: its ExecStop kills the live tmux operator session. It was never
		// enabled, so there is nothing to disable; a running session keeps running after its unit file goes.
		for (const path of [...operatorUnits.map((name) => join(unitDir, name)), join(binDir, OPERATOR_WRAPPER)]) {
			const text = ports.read(path);
			if (text === undefined) step("skip", "uninstall", `${path} absent`);
			else if (!text.includes(GENERATED)) step("skip", "uninstall", `${path} was not written by cp-install; left in place`);
			else {
				if (!dry) ports.remove(path);
				step("changed", "uninstall", `removed ${path}`);
			}
		}
		// The daemon stops (never the parent host), then its unit files go; data/daemon.json last, the detached stop reads it.
		deactivate({ ...ctx, config: previousConfig ?? baseConfig });
		if (previousConfig) {
			if (!dry) ports.remove(paths.config);
			step("changed", "uninstall", `removed ${paths.config}`);
		}
		const keyFile = gatewayKeyFile(ports.env);
		if (keyFile && ports.exists(keyFile)) step("skip", "uninstall", `${keyFile} kept (your gateway admin key; remove it yourself)`);
		step("ok", "uninstall", `home ${home} kept (data/daemon.json removed) and app ${app} untouched`);
		return failed ? 1 : 0;
	}

	// 2. npm ci when the installed tree does not match the lockfile.
	const lock = ports.read(join(app, "package-lock.json"));
	const installed = ports.read(join(app, "node_modules/.package-lock.json"));
	if (lock === undefined) step("fail", "npm", `${app}/package-lock.json is missing; is --app a pi-command-post checkout?`);
	else if (!force && installed !== undefined && sameLock(lock, installed)) step("ok", "npm", "node_modules matches package-lock.json");
	else if (dry) step("changed", "npm", `would run npm ci in ${app}`);
	else if (ok(ports.run("npm", ["ci"], app))) step("changed", "npm", `npm ci in ${app}`);
	else step("fail", "npm", `npm ci failed in ${app}; run it there and read its error`);
	if (failed) return 1;

	// 3. Tools.
	const tools = ports.run(ports.node.path, [join(app, "scripts/install-tools.ts"), ...(dry ? ["--dry-run"] : [])], app);
	if (!ok(tools)) {
		step("fail", "tools", `scripts/install-tools.ts exited ${tools.status}:\n${tools.stdout}${tools.stderr}`);
		return 1;
	}
	step("ok", "tools", `required tools on PATH: ${REQUIRED_TOOLS.map((tool) => (tool === "treehouse" ? "treehouse (required, not optional: every dispatch leases a treehouse worktree)" : tool)).join(", ")}`);
	const prompting = !dry && flags.yes !== true && flags["no-prompt"] !== true;
	const answer = (question: string): string => (prompting ? ports.ask(question)?.trim() ?? "" : "");
	const yes = (question: string, fallback: boolean): boolean => {
		const reply = answer(`${question} [${fallback ? "Y/n" : "y/N"}] `).toLowerCase();
		return reply === "" ? fallback : reply.startsWith("y");
	};
	extras(flags, ports, app, home, step, yes);

	// 3b. The dashboard's bind host: --viewer-host, else the previous install's (data/daemon.json, else a legacy
	// cp-view.service, else the wrapper), else discovery (cp-5smb). A legacy drop-in is M1's preflight report.
	const wrapperText = ports.read(join(binDir, OPERATOR_WRAPPER));
	const pinned = unitViewerHost(ports.read(join(unitDir, VIEW_UNIT)));
	const previous: PreviousHost = previousConfig
		? { generated: true, host: previousConfig.viewer_host, from: paths.config }
		: pinned.generated ? { generated: true, host: pinned.host, from: VIEW_UNIT } : { generated: wrapperText?.includes(GENERATED) === true, host: wrapperViewerHost(wrapperText), from: join(binDir, OPERATOR_WRAPPER) };
	const viewerHost = chooseViewerHost(ports, step, prompting, answer, flagHost, previous, locals);
	if (viewerHost === false) return 1;

	// 3c. Models (cp-er76): the flags, else the kept pins (data/daemon.json, else a legacy cp-parent.service, else
	// the wrapper), else one prompt over what pi lists for cp-daemon's env.
	const unitModel = unitParentModel(ports.read(join(unitDir, PARENT_UNIT)));
	const wrapped = wrapperModels(wrapperText);
	const kept = { parent: previousConfig ? previousConfig.parent_model : unitModel.generated ? unitModel.model : wrapped.parent, operator: wrapped.operator };
	const agentDir = ports.env.PI_CODING_AGENT_DIR ?? join(ports.env.HOME ?? "", ".pi/agent");
	const models = chooseModels({ flags, ports, home, app, agentDir, fresh: !previousConfig && !unitModel.generated && !wrapped.generated, force, prompting, answer, step, kept });
	if (models === "fail") return 1;
	// A kept parent pin leaves the wrapper's own export as it was (an older wrapper carries none): byte-identical.
	const wrapperParent = models.parent === kept.parent ? wrapped.parent : models.parent;
	ctx.config = { ...baseConfig, ...(viewerHost ? { viewer_host: viewerHost } : {}), ...(models.parent ? { parent_model: models.parent } : {}) };

	// 3d. M1's preflight (docs/service.md §Migration), before anything is written. --no-start leaves a legacy home as is.
	const legacy = systemd ? legacyPresent(ports, unitDir) : [];
	const holdLegacy = legacy.length > 0 && noStart;
	if (legacy.length > 0 && !holdLegacy) {
		const why = legacyPreflight(ctx);
		if (why) {
			step("fail", "migrate", `${why}; nothing was changed`);
			return 1;
		}
	}
	// 8. Linger (systemd) before any write: refused, nothing of cp-daemon's is left on disk.
	if (systemd && !linger(ctx)) return 1;

	// 4. Home.
	if (ports.exists(home)) step("ok", "home", home);
	else {
		if (!dry) ports.mkdir(home, 0o700);
		step("changed", "home", `created ${home} (0700)`);
	}

	// 5–6. data/daemon.json, the thin unit (systemd) and the wrapper: identical → ok; absent →
	// written; different → refused without --force. A replaced config or thin unit restarts a running daemon.
	const files: Array<{ path: string; text: string; mode: number; kind: "daemon" | "unit" | "wrapper" }> = [
		...(holdLegacy ? [] : [{ path: paths.config, text: `${JSON.stringify(ctx.config, null, 2)}\n`, mode: 0o600, kind: "daemon" as const }]),
		...(systemd && !holdLegacy ? [{ path: join(unitDir, DAEMON_UNIT), text: daemonUnit, mode: 0o644, kind: "unit" as const }] : []),
		{ path: join(binDir, OPERATOR_WRAPPER), text: renderOperatorWrapper({ app, home, viewerHost: viewerHost || undefined, parentModel: wrapperParent, operatorModel: models.operator }), mode: 0o755, kind: "wrapper" },
	];
	// Every refusal before any write: a refused wrapper must not leave a new data/daemon.json beside running legacy
	// units (their cp-update would then refuse instead of recording migration_required).
	const planned = files.map((file) => ({ ...file, have: ports.read(file.path) }));
	const refused = !force && planned.some(({ have, text }) => have !== undefined && have !== text);
	for (const { path, text, mode, kind, have } of planned) {
		if (have === text) step("ok", kind, path);
		else if (have !== undefined && !force) step("fail", kind, `${path} differs from what this install renders; rerun with --force to replace it`);
		else if (refused) step("skip", kind, `${path} not written: another file was refused, so nothing is written`);
		else {
			if (!dry) ports.write(path, text, mode);
			// Never the operator session: a replaced wrapper applies at its next start, not mid-conversation.
			if (have !== undefined && (kind === "daemon" || path.endsWith(`/${DAEMON_UNIT}`))) ctx.changed = true;
			step("changed", kind, `${have === undefined ? "wrote" : "replaced"} ${path}`);
		}
	}
	if (refused) return 1;
	// cp-rrye: Start in tmux runs tmux itself, so the cp-operator*.service an older install wrote goes — never
	// stopped (its ExecStop kills the live tmux session; a running one keeps running), removed only when generated.
	// A legacy home: M1 removes them at its success (S8), so a refused or rolled-back migration keeps them, and
	// --no-start leaves them with the rest. Otherwise here, before activate's daemon-reload.
	if (legacy.length > 0) ctx.retire = operatorUnits;
	for (const path of legacy.length > 0 ? [] : operatorUnits.map((name) => join(unitDir, name))) {
		if (!ports.read(path)?.includes(GENERATED)) continue;
		if (!dry) ports.remove(path);
		step("changed", "unit", `removed ${path} (never stopped: Start in tmux runs tmux directly now)`);
	}
	if (!(ports.env.PATH ?? "").split(":").includes(binDir)) step("skip", "wrapper", `${binDir} is not on PATH; add it to run cp-operator from anywhere`);
	step("ok", "launchers", `tmux ${tmux ?? "not on PATH (the dashboard's Start in tmux needs it)"}; herdr ${herdr ?? "not on PATH"}`);
	// Printed, never run: the pi integration writes a global ~/.pi/agent/extensions file.
	if (herdr && !herdrPiIntegrated(ports.run(herdr, ["integration", "status"]).stdout)) step("skip", "herdr", "pi integration not installed; for herdr's sidebar agent state and session resume run yourself: herdr integration install pi");

	// 7. Auto-update config (read by cp-daemon's updater); written only when absent.
	const dataDir = join(home, layoutForHome("multi", home).data);
	const updateFile = join(dataDir, "update.json");
	if (ports.exists(updateFile)) step("ok", "update", `${updateFile} kept as is`);
	else {
		if (!dry) ports.write(updateFile, `${JSON.stringify({ enabled: flags["no-update"] !== true, interval_min: 15 })}\n`, 0o600);
		step("changed", "update", `wrote ${updateFile}`);
	}

	// 7b. The optional sub2api gateway (cp-er76): flags only; no unit changes, the parent host loads the key.
	gatewayStep({ flags, ports, dataDir, keyFile: gatewayKeyFile(ports.env), force, dry, step });

	// 9. Start cp-daemon (daemon-backend.ts): migrate a legacy home (M1) or enable cp-daemon.service on
	// systemd; `cp-daemon start` and the reboot command when detached. Either waits until the daemon is ready.
	await activate(ctx);

	// 10. Web Push, once: --push-origin, or an origin typed at the prompt.
	const pushSetUp = ports.exists(join(dataDir, "push/config.json"));
	const pushOrigin = flags["push-origin"] ?? (pushSetUp ? undefined : answer("Web push origin for the dashboard (https://..., empty to skip): ") || undefined);
	if (pushSetUp) step("ok", "push", "already set up");
	else if (!pushOrigin) step("skip", "push", "not set up; rerun with --push-origin URL to enable it");
	else if (dry) step("changed", "push", `would run push-init --origin ${pushOrigin}`);
	else if (ok(ports.run(ports.node.path, [join(app, "scripts/push-init.ts"), "--origin", pushOrigin, "--home", home], app))) step("changed", "push", `push set up for ${pushOrigin}`);
	else step("fail", "push", "scripts/push-init.ts failed; rerun it by hand to read why");

	// 11. Doctor, on either backend once started.
	if (!dry && !noStart) {
		try {
			const doctor = await ports.doctor(home, 90_000);
			step(doctor.level === "error" ? "fail" : "ok", "doctor", doctor.text);
		} catch (error) {
			step("fail", "doctor", `${(error as Error).message}; see cp-daemon log`);
		}
		ports.log(ports.run(ports.node.path, [join(app, "src/service/daemon.ts"), "status", "--home", home], home).stdout);
	} else step("skip", "doctor", dry ? "dry-run" : "--no-start");
	return failed ? 1 : 0;
}

type Step = (status: StepStatus, name: string, detail: string) => void;

/** The host a previous install pinned: data/daemon.json's, else a legacy cp-view.service's, else the wrapper's; `generated` when cp-install wrote it. */
interface PreviousHost { generated: boolean; host: string | undefined; from: string }

/** `value` as this machine's own address (the interface's canonical string), or why it cannot carry the dashboard. */
function localHost(value: string, locals: readonly LocalAddress[]): { host: string } | { reason: string } {
	const refusal = bindHostRefusal(value);
	if (refusal) return { reason: `${value}: ${refusal}` };
	const local = locals.find((candidate) => sameAddress(candidate.address, value));
	return local ? { host: local.address } : { reason: `${value} is not an address of this machine (os.networkInterfaces)` };
}

function hostPrompt(candidates: readonly HostCandidate[]): string {
	const lines = candidates.map((c, n) => `  ${n + 1}) ${c.address}  ${c.source === "tailscale" ? `Tailscale (${c.iface})` : c.iface} — ${c.why}`);
	const recommended = candidates.findIndex((c) => c.recommended);
	return `Dashboard address — it serves write controls: anyone who can reach it can steer the operator session.\n${lines.join("\n")}\nChoose 1-${candidates.length} or type an IP [${recommended === -1 ? "none" : recommended + 1}]: `;
}

/**
 * Step 3b (cp-5smb): --viewer-host (validated in preflight), else the previous install's choice (kept, never
 * asked), else discovery — one prompt, or the Tailscale address non-interactively. A LAN or loopback address
 * is never picked without a human choosing it. Returns the host to pin, undefined for none, false when refused.
 */
function chooseViewerHost(ports: InstallPorts, step: Step, prompting: boolean, answer: (question: string) => string, flagHost: string | undefined, previous: PreviousHost, locals: readonly LocalAddress[]): string | undefined | false {
	if (flagHost !== undefined) {
		if (previous.host !== undefined && sameAddress(previous.host, flagHost)) step("ok", "viewer-host", `${flagHost} (--viewer-host)`);
		else step("changed", "viewer-host", `${flagHost} (--viewer-host; was ${previous.host ?? "none"})`);
		return flagHost;
	}
	if (previous.generated) {
		const kept = previous.host;
		if (kept === undefined) {
			step("skip", "viewer-host", `none pinned in ${previous.from} (it resolves Tailscale at each start); --viewer-host <ip> --force pins one`);
			return undefined;
		}
		step("ok", "viewer-host", `${kept} kept from ${previous.from}`);
		if (!locals.some((local) => sameAddress(local.address, kept))) step("skip", "viewer-host", `${kept} is not on this machine's interfaces now; cp-daemon's viewer retries until it is`);
		return kept;
	}
	const tailscale = ports.run("tailscale", ["ip", "-4"]);
	const candidates = viewerHostCandidates([...locals], tailscale.status === 0 ? parseTailscaleIp(tailscale.stdout) : undefined);
	const recommended = candidates.find((c) => c.recommended);
	const reply = prompting && candidates.length > 0 ? answer(hostPrompt(candidates)) : "";
	if (reply === "") {
		if (recommended) {
			step("changed", "viewer-host", `${recommended.address} (tailscale; ${recommended.why}; --viewer-host overrides)`);
			return recommended.address;
		}
		step("skip", "viewer-host", "no Tailscale address on this machine; nothing pinned — cp-daemon's viewer looks for one at every start and stays down until one appears; for a LAN or loopback address rerun with --viewer-host <ip> --force (anyone who can reach that address gets the dashboard's write controls)");
		return undefined;
	}
	const numbered = /^\d+$/.test(reply) ? candidates[Number(reply) - 1] : undefined;
	const picked = numbered ? { host: numbered.address } : /^\d+$/.test(reply) ? { reason: `${reply} is not one of the choices 1-${candidates.length}` } : localHost(reply, locals);
	if ("reason" in picked) {
		step("fail", "viewer-host", `${picked.reason}; rerun with --viewer-host <ip>`);
		return false;
	}
	const source = candidates.find((c) => c.address === picked.host)?.source ?? "typed";
	step("changed", "viewer-host", `${picked.host} (${source}; chosen at the prompt)`);
	return picked.host;
}

/** Every package some role loads, once, in ROLE_PACKAGES order; a pinned `name@x.y.z` stays pinned. */
export function workerPackageSpecs(roles: Readonly<Record<string, readonly string[]>> = ROLE_PACKAGES): string[] {
	return [...new Set(Object.values(roles).flat())];
}

/** `@scope/name@1.2.3` → `@scope/name`. */
function packageName(spec: string): string {
	const at = spec.indexOf("@", 1);
	return at === -1 ? spec : spec.slice(0, at);
}

/** settings.json `packages` sources; undefined when the file is not JSON (it is never repaired here). */
function configuredSources(text: string | undefined): string[] | undefined {
	try {
		const packages = (JSON.parse(text ?? "{}") as { packages?: unknown }).packages;
		if (!Array.isArray(packages)) return [];
		return packages.map((entry) => (typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source)).filter((source): source is string => typeof source === "string");
	} catch {
		return undefined;
	}
}

/**
 * `projectTracker`'s two beads sources, by this home's own layout (the process LAYOUT is
 * unconfigured here): an active beads connection in data/trackers.json, or a registered
 * project whose clone has `.beads/beads.db`. Either makes the br prompt default to yes.
 */
function beadsTracked(ports: InstallPorts, home: string): boolean {
	const layout = layoutForHome("multi", home);
	const parsed = <T>(path: string): T | undefined => {
		try {
			return JSON.parse(ports.read(path) ?? "null") ?? undefined;
		} catch {
			return undefined; // unreadable: doctor names it; the prompt keeps its plain default
		}
	};
	const trackers = parsed<{ connections?: Array<{ adapter?: string; status?: string }> }>(join(home, layout.data, "trackers.json"));
	if ((trackers?.connections ?? []).some((connection) => connection.adapter === "beads" && connection.status === "active")) return true;
	const registry = parsed<{ projects?: Array<{ name?: string }> }>(join(home, layout.projectsFile));
	return (registry?.projects ?? []).some((project) => typeof project.name === "string" && ports.exists(join(home, layout.projects, project.name, ".beads", "beads.db")));
}

/** Step 3a (P2i): gh login, pi-lens host tools, worker pi packages, this checkout as a package, optional tools, provider login. */
function extras(flags: InstallFlags, ports: InstallPorts, app: string, home: string, step: Step, yes: (question: string, fallback: boolean) => boolean): void {
	const ok = (command: string, ...args: string[]) => ports.run(command, args).status === 0;
	const run = (name: string, command: string, args: string[]): void => {
		const line = [command, ...args].join(" ");
		if (flags["dry-run"]) step("changed", name, `would run ${line}`);
		else if (ok(command, ...args)) step("changed", name, line);
		else step("fail", name, `${line} failed; run it by hand to read why`);
	};

	if (ghLoggedIn((...args) => ok("gh", ...args))) step("ok", "gh", "logged in");
	else step("skip", "gh", "not logged in; run `gh auth login` yourself (cp_integrate reads PRs and CI through gh)");

	const lens = ["i", "-g", ...PI_LENS_TOOLS.packages];
	if (PI_LENS_TOOLS.commands.every((command) => ok(command, "--version"))) step("ok", "pi-lens", `${PI_LENS_TOOLS.commands.join(", ")} on PATH`);
	else {
		const prefix = ports.run("npm", ["prefix", "-g"]).stdout.trim();
		const modules = join(prefix, "lib/node_modules");
		if (!prefix || !ports.writable(ports.exists(modules) ? modules : prefix)) step("fail", "pi-lens", `npm's global prefix ${prefix || "(unknown)"} needs sudo, so nothing was run; fix: npm config set prefix "$HOME/.local" and rerun, or run yourself: sudo npm ${lens.join(" ")}`);
		else run("pi-lens", "npm", lens);
	}

	const agentDir = ports.env.PI_CODING_AGENT_DIR ?? join(ports.env.HOME ?? "", ".pi/agent");
	const sources = configuredSources(ports.read(join(agentDir, "settings.json")));
	if (sources === undefined) step("fail", "pi-package", `${join(agentDir, "settings.json")} is not valid JSON; fix it by hand, then rerun (it is never edited here)`);
	else {
		if (flags["no-pi-packages"]) step("skip", "pi-package", "--no-pi-packages");
		else for (const spec of workerPackageSpecs()) {
			const have = sources.find((source) => source.startsWith("npm:") && packageName(source.slice(4)) === packageName(spec));
			if (have === undefined) run("pi-package", "pi", ["install", `npm:${spec}`]);
			else if (have === `npm:${spec}`) step("ok", "pi-package", `${packageName(spec)} configured as ${have}`);
			else step("ok", "pi-package", `${packageName(spec)} configured as ${have} (yours, kept; workers name npm:${spec})`);
		}
	}

	const { br, tmux } = OPTIONAL_TOOL_INFO;
	if (ok("br", "--version")) step("ok", "br", "on PATH (optional)");
	else {
		const beads = beadsTracked(ports, home);
		const want = flags["with-br"] === true || (flags["no-br"] !== true && yes(`Install the br (beads) CLI? Optional: ${br.why}${beads ? "; this home has a beads tracker" : ""}.`, beads));
		step("skip", "br", want ? `not on PATH; ${br.install}` : `not on PATH (optional: ${br.why}); not wanted, --with-br says how to get it`);
	}
	if (ok("tmux", "-V")) step("ok", "tmux", "on PATH (optional)");
	else step("skip", "tmux", `not on PATH (optional: ${tmux.why}); ${tmux.install}`);

	const auth = ports.read(join(agentDir, "auth.json"));
	let providers = 0;
	try {
		providers = Object.keys(JSON.parse(auth ?? "{}") as object).length;
	} catch {
		providers = 0; // unreadable reads as no provider, and says so below
	}
	if (providers > 0) step("ok", "login", `${providers} provider(s) in ${join(agentDir, "auth.json")}`);
	else step("skip", "login", `no provider in ${join(agentDir, "auth.json")}${auth === undefined ? "" : " (empty or unreadable)"}: run \`pi\`, then /login (credentials are never handled here)`);
}

/** Step 11: wait for this home's host to run a parent, then return its `/doctor` (host `doctor` op). */
export async function waitForParentDoctor(home: string, timeoutMs: number): Promise<{ text: string; level: string }> {
	const paths = parentHostPaths(home, "multi");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { record } = currentHost(paths);
		const client = record ? await ParentHostClient.connect(record).catch(() => undefined) : undefined;
		if (client) {
			try {
				if (client.parentPid !== undefined) return await client.request("doctor") as { text: string; level: string };
			} finally {
				client.disconnect();
			}
		}
		if (Date.now() > deadline) throw new Error(`no parent running for ${home} after ${Math.round(timeoutMs / 1000)}s`);
		await new Promise((done) => setTimeout(done, 1_000));
	}
}

/** One line from /dev/tty (so `curl | sh` still asks); undefined when there is no terminal. */
function askTty(question: string): string | undefined {
	let fd: number;
	try {
		fd = openSync("/dev/tty", "r+");
	} catch {
		return undefined; // no controlling terminal: every prompt takes its default
	}
	try {
		writeSync(fd, question);
		const buffer = Buffer.alloc(1024);
		let text = "";
		while (!text.includes("\n")) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			text += buffer.toString("utf8", 0, read);
		}
		return text.split("\n")[0];
	} finally {
		closeSync(fd);
	}
}

export function productionPorts(): InstallPorts {
	return {
		run: (command, args, cwd, env) => {
			const result = spawnSync(command, [...args], { cwd, encoding: "utf8", ...(env ? { env } : {}) });
			return { status: result.status ?? 127, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
		},
		read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
		write: (path, text, mode) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text, { mode });
			chmodSync(path, mode);
		},
		writeSecret: (path, text) => {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			chmodSync(dirname(path), 0o700);
			const temp = `${path}.${process.pid}.tmp`;
			rmSync(temp, { force: true });
			writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
			renameSync(temp, path);
		},
		mode: (path) => (existsSync(path) ? statSync(path).mode & 0o777 : undefined),
		exists: existsSync,
		mkdir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
		remove: (path) => rmSync(path, { force: true }),
		writable: (path) => {
			try {
				accessSync(path, constants.W_OK);
				return true;
			} catch {
				return false;
			}
		},
		ask: askTty,
		env: process.env,
		node: { path: process.execPath, version: process.version },
		doctor: waitForParentDoctor,
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		log: (line) => process.stdout.write(`${line}\n`),
		interfaces: networkInterfaces,
	};
}

if (import.meta.main) {
	const code = await install(parseInstallArgs(process.argv.slice(2)), productionPorts());
	process.exit(code);
}
