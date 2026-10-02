/**
 * cp-install step 7b (cp-er76): the optional sub2api gateway, opt-in by flags only. `--gateway-url`
 * writes `data/capacity.json` once; the admin key comes only from `--gateway-key-file` (never an argv
 * value, a prompt or the environment) and is copied to `gateway.env` (`src/gateway-key.ts`). No unit
 * changes; the parent host loads the key at the next parent start. The key is never printed.
 */
import { join, resolve } from "node:path";
import { gatewayKeyFrom, renderGatewayKeyFile, validGatewayKey } from "../gateway-key.ts";
import type { InstallFlags, InstallPorts, StepStatus } from "./install.ts";

/** The sub2api admin concurrency path (fixed by its contract; `src/capacity.ts`). */
export const CAPACITY_PATH = "/api/v1/admin/ops/concurrency";
const ADD_LATER = "cp-install --gateway-url https://<gateway> --gateway-key-file <file>";

/** `input` as the https origin `loadCapacityConfig` accepts (`src/quota.ts`), or why not. */
export function gatewayOrigin(input: string): { url?: string; error?: string } {
	let base: URL;
	try {
		base = new URL(input);
	} catch {
		return { error: `${input} is not a URL` };
	}
	if (base.protocol !== "https:") return { error: `${input} is not https (the admin key travels in a header)` };
	if (base.username || base.password || base.search || base.hash || base.pathname !== "/") return { error: `${input} must be a bare origin: no user, path, query or fragment (the admin paths are fixed)` };
	return { url: base.href };
}

export interface GatewayContext {
	flags: InstallFlags;
	ports: InstallPorts;
	dataDir: string;
	keyFile: string | undefined;
	force: boolean;
	dry: boolean;
	step: (status: StepStatus, name: string, detail: string) => void;
}

/** Kept → ok; the flags add, or with --force replace; every refusal comes before any write. */
export function gatewayStep(ctx: GatewayContext): void {
	const { flags, ports, keyFile, step } = ctx;
	const capacityFile = join(ctx.dataDir, "capacity.json");
	const capacityText = ports.read(capacityFile);
	const keyText = keyFile ? ports.read(keyFile) : undefined;
	const urlFlag = flags["gateway-url"];
	const keyFlag = flags["gateway-key-file"];
	const fail = (detail: string) => step("fail", "gateway", `${detail}; nothing written`);
	/** A kept key file: ok when 0600, else rewritten 0600 (parentGatewayKey refuses group/other bits). */
	const keepKey = () => {
		if (!keyFile || keyText === undefined) return;
		if (((ports.mode(keyFile) ?? 0) & 0o077) === 0) return step("ok", "gateway-key", `${keyFile} kept`);
		if (!ctx.dry) ports.writeSecret(keyFile, keyText);
		return step("changed", "gateway-key", `tightened ${keyFile} to 0600`);
	};

	if (urlFlag === undefined && keyFlag === undefined) {
		if (capacityText === undefined) return step("skip", "gateway", `not set up (optional: capacity-aware routing through a sub2api gateway); add it later: ${ADD_LATER}`);
		step("ok", "gateway", `${capacityFile} kept`);
		if (!keyFile || keyText === undefined) return step("skip", "gateway-key", `${keyFile ?? "no HOME"}: absent, so no parent has the admin key (quota=off:no admin key); add it: cp-install --gateway-key-file <file>`);
		return keepKey();
	}
	if (!keyFile) return fail("no XDG_CONFIG_HOME or HOME: nowhere to keep the admin key");
	let url: string | undefined;
	if (urlFlag !== undefined) {
		const origin = gatewayOrigin(urlFlag);
		if (origin.error !== undefined) return fail(origin.error);
		url = origin.url;
	} else if (capacityText === undefined) return fail(`--gateway-key-file needs --gateway-url: ${capacityFile} is absent`);
	let key: string | undefined;
	if (keyFlag !== undefined) {
		const line = ports.read(resolve(keyFlag))?.split("\n")[0]?.trim().replace(/^CP_GATEWAY_ADMIN_KEY=/, "");
		if (line === undefined) return fail(`--gateway-key-file ${keyFlag} is not readable`);
		const bad = validGatewayKey(line);
		if (bad) return fail(`--gateway-key-file ${keyFlag}: ${bad}`);
		key = line;
	} else if (keyText === undefined) return fail(`--gateway-url needs the admin key: put it on the first line of a 0600 file and pass --gateway-key-file <file>`);

	let capacityNext: string | undefined;
	if (url !== undefined) {
		if (capacityText === undefined) capacityNext = `${JSON.stringify({ url, path: CAPACITY_PATH })}\n`;
		else {
			let have: Record<string, unknown>;
			try {
				have = JSON.parse(capacityText) as Record<string, unknown>;
			} catch {
				return fail(`${capacityFile} is not JSON; fix or remove it by hand`);
			}
			if (have.url !== url) {
				if (!ctx.force) return fail(`${capacityFile} names ${String(have.url)}; rerun with --force to replace its url`);
				capacityNext = `${JSON.stringify({ ...have, url })}\n`;
			}
		}
	}
	const keyChanged = key !== undefined && (keyText === undefined ? true : gatewayKeyFrom(keyText) !== key);
	if (keyChanged && keyText !== undefined && !ctx.force) return fail(`${keyFile} holds another key; rerun with --force to replace it`);

	if (capacityNext === undefined) step("ok", "gateway", `${capacityFile} kept`);
	else {
		if (!ctx.dry) ports.write(capacityFile, capacityNext, 0o600);
		step("changed", "gateway", `${capacityText === undefined ? "wrote" : "replaced the url in"} ${capacityFile} (${url}); read live at each capacity check`);
	}
	if (!keyChanged) keepKey();
	else {
		if (!ctx.dry) ports.writeSecret(keyFile, renderGatewayKeyFile(key as string));
		step("changed", "gateway-key", `${keyText === undefined ? "wrote" : "replaced"} ${keyFile} (0600, dir 0700; never printed); the parent loads it at its next start (cp_parent stop + start, a relaunch or an update restart)`);
	}
}
