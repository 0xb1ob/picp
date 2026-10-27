/**
 * Remote dashboard PR 2: the cloudflared provisioner. `cp-tunnel up` needs one cloudflared that can run both tunnel
 * modes; this finds or installs it without sudo, a package manager or a system path:
 *
 *  1. a compatible `cloudflared` on PATH (version and the flags the fixed argv uses, probed — never trusted by name);
 *  2. else the copy an earlier run published to `<home>/bin/cloudflared`, probed the same way;
 *  3. else the pinned official release for Linux/macOS x64/arm64: bounded HTTPS from GitHub only, every redirect
 *     re-checked, the SHA256 verified before anything is written executable, a macOS archive accepted only when it
 *     holds exactly one regular `cloudflared` (no links, directories or other paths), probed in its temp file and then
 *     published by an atomic rename. Any failure removes the temp file: no executable and no success is left behind.
 *
 * Other platforms need a compatible cloudflared on PATH, and say so. The argv is fixed (`quickArgv`/`namedArgv`):
 * no shell, and the named token is a file path, never an argument value or an environment variable.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { daemonPaths } from "../service/daemon-files.ts";

export const CLOUDFLARED_VERSION = "2026.10.4";
/** `tunnel run --token-file` arrived in 2025.4.0. */
export const CLOUDFLARED_MIN_VERSION: readonly [number, number, number] = [2025, 4, 0];
/** `sha256` hashes the downloaded asset; an archive also carries `binarySha256`, the extracted cloudflared. */
export type CloudflaredRelease = { asset: string; sha256: string; archive: boolean; binarySha256?: string };
/**
 * github.com/cloudflare/cloudflared/releases/tag/2026.10.4: `sha256` is GitHub's asset digest (= the notes for Linux);
 * `binarySha256` is the notes' value, which for a macOS tarball names the binary inside it, not the tarball.
 */
export const CLOUDFLARED_RELEASES: Readonly<Record<string, CloudflaredRelease>> = {
	"linux-x64": { asset: "cloudflared-linux-amd64", sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42", archive: false },
	"linux-arm64": { asset: "cloudflared-linux-arm64", sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6", archive: false },
	"darwin-x64": { asset: "cloudflared-darwin-amd64.tgz", sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d", archive: true, binarySha256: "fdec0f9a1c726f4c10283fc0cd70e602d510c72887b737270433c81a08c883a9" },
	"darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f", archive: true, binarySha256: "49e7963072b2ca83fb44c09f4d4a7cda52d390c0c9c6f55bac83454a5bc43910" },
};
export const releaseUrl = (asset: string): string => `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
/** The only hosts a download may touch, the release redirect's object stores included. */
export const DOWNLOAD_HOSTS: readonly string[] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
export const DOWNLOAD_MAX_BYTES = 128 * 1024 * 1024;
export const DOWNLOAD_MAX_REDIRECTS = 5;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 30_000;

/** Where a downloaded cloudflared is published: `bin/` under the home's runtime root, beside `data/` and `state/`. */
export const cloudflaredBinDir = (home: string): string => join(dirname(daemonPaths(home).dataDir), "bin");

export type RunResult = { code: number | null; stdout: string; stderr: string };
export interface ProvisionPorts {
	platform: string;
	arch: string;
	/** `$PATH`; only absolute entries are searched. */
	pathEnv: string | undefined;
	fetch: (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;
	/** Run a binary with a fixed argv and no shell. */
	run: (file: string, args: string[]) => Promise<RunResult>;
	log?: (line: string) => void;
}
export type Provisioned = { ok: true; path: string; source: "path" | "installed" | "download"; version: string } | { ok: false; reason: string };
export type Probe = { ok: true; version: string } | { ok: false; reason: string };

/** The production `run` port: execFile, bounded time and output. */
export const runFile = (file: string, args: string[]): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ code, stdout, stderr });
		});
	});

export const defaultProvisionPorts = (env: NodeJS.ProcessEnv = process.env): ProvisionPorts => ({
	platform: process.platform,
	arch: process.arch,
	pathEnv: env.PATH,
	fetch: (url, init) => fetch(url, init),
	run: runFile,
});

const validPort = (port: number): boolean => Number.isInteger(port) && port >= 1024 && port <= 65535;

/** Quick mode: an accountless trycloudflare.com tunnel to the remote listener, its Host rewritten to that listener. */
export function quickArgv(port: number): string[] {
	if (!validPort(port)) throw new Error(`remote port ${port} is not an integer in 1024–65535`);
	const origin = `127.0.0.1:${port}`;
	return ["tunnel", "--no-autoupdate", "--url", `http://${origin}`, "--http-host-header", origin];
}

/** Named mode: a remotely managed tunnel; its token is read from a file, never passed as a value. */
export function namedArgv(tokenFile: string): string[] {
	if (!isAbsolute(tokenFile) || /[\0-\x1f\x7f]/.test(tokenFile)) throw new Error("the token file must be an absolute path without control characters");
	return ["tunnel", "--no-autoupdate", "run", "--token-file", tokenFile];
}

const atLeast = (version: number[], min: readonly number[]): boolean => {
	for (let i = 0; i < min.length; i += 1) {
		if ((version[i] ?? 0) !== (min[i] ?? 0)) return (version[i] ?? 0) > (min[i] ?? 0);
	}
	return true;
};

/** Is `file` a cloudflared this feature can drive? Its version and both argv shapes' flags, from its own help. */
export async function probeCloudflared(file: string, run: ProvisionPorts["run"]): Promise<Probe> {
	const version = await run(file, ["--version"]);
	const match = /cloudflared version (\d{4})\.(\d{1,2})\.(\d{1,3})\b/.exec(`${version.stdout}\n${version.stderr}`);
	if (version.code !== 0 || !match) return { ok: false, reason: `${file} --version did not report a cloudflared version` };
	const parts = match.slice(1, 4).map(Number);
	const label = parts.join(".");
	if (!atLeast(parts, CLOUDFLARED_MIN_VERSION)) return { ok: false, reason: `${file} is cloudflared ${label}, older than ${CLOUDFLARED_MIN_VERSION.join(".")}` };
	const needs: Array<[string[], string[]]> = [
		[["tunnel", "--help"], ["--no-autoupdate", "--url", "--http-host-header"]],
		[["tunnel", "run", "--help"], ["--token-file"]],
	];
	for (const [args, flags] of needs) {
		const help = await run(file, args);
		const text = `${help.stdout}\n${help.stderr}`;
		// A flag ends at whitespace, a comma, `=` or the end: `--url-foo` is not `--url`.
		const missing = flags.filter((flag) => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=]|$)`).test(text));
		if (missing.length > 0) return { ok: false, reason: `${file} (cloudflared ${label}) lacks ${missing.join(", ")} in \`${args.join(" ")}\`` };
	}
	return { ok: true, version: label };
}

function executableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		return stat.isFile() && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/** Find, else install, a compatible cloudflared. Never throws: every refusal is a named reason. */
export async function provisionCloudflared(binDir: string, ports: ProvisionPorts, releases: Readonly<Record<string, CloudflaredRelease>> = CLOUDFLARED_RELEASES): Promise<Provisioned> {
	const log = ports.log ?? (() => {});
	const rejected: string[] = [];
	const dirs = (ports.pathEnv ?? "").split(":").filter((dir) => isAbsolute(dir));
	for (const dir of [...new Set(dirs)]) {
		const candidate = join(dir, "cloudflared");
		if (!executableFile(candidate)) continue;
		const probe = await probeCloudflared(candidate, ports.run);
		if (probe.ok) return { ok: true, path: candidate, source: "path", version: probe.version };
		rejected.push(probe.reason);
	}
	const target = join(binDir, "cloudflared");
	if (executableFile(target)) {
		const probe = await probeCloudflared(target, ports.run);
		if (probe.ok) return { ok: true, path: target, source: "installed", version: probe.version };
		rejected.push(probe.reason);
	}
	const seen = rejected.length > 0 ? ` (rejected: ${rejected.join("; ")})` : "";
	const release = releases[`${ports.platform}-${ports.arch}`];
	if (!release) return { ok: false, reason: `no compatible cloudflared on PATH${seen}, and no pinned download for ${ports.platform}-${ports.arch}: install cloudflared ${CLOUDFLARED_MIN_VERSION.join(".")} or later on PATH` };
	log(`downloading cloudflared ${CLOUDFLARED_VERSION} (${release.asset})${seen}`);
	let temp: string | undefined;
	try {
		const bytes = await download(releaseUrl(release.asset), ports.fetch);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== release.sha256) throw new Error(`checksum mismatch for ${release.asset}: got ${digest}, expected ${release.sha256}`);
		const binary = release.archive ? extractCloudflared(bytes) : bytes;
		const inner = createHash("sha256").update(binary).digest("hex");
		if (release.archive && inner !== release.binarySha256) throw new Error(`checksum mismatch for the cloudflared inside ${release.asset}: got ${inner}, expected ${release.binarySha256}`);
		mkdirSync(binDir, { recursive: true, mode: 0o700 });
		chmodSync(binDir, 0o700); // an existing bin/ too: mkdir's mode applies only to a directory it creates
		temp = join(binDir, `.cloudflared.${process.pid}.${Date.now()}.tmp`);
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeSync(fd, binary);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(temp, 0o755);
		const probe = await probeCloudflared(temp, ports.run);
		if (!probe.ok) throw new Error(`the verified download does not run here: ${probe.reason}`);
		renameSync(temp, target);
		temp = undefined;
		const dirFd = openSync(binDir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return { ok: true, path: target, source: "download", version: probe.version };
	} catch (error) {
		return { ok: false, reason: `cloudflared ${CLOUDFLARED_VERSION} was not installed: ${(error as Error).message}` };
	} finally {
		if (temp) rmSync(temp, { force: true });
	}
}

/** GET over HTTPS from `DOWNLOAD_HOSTS` only, following at most `DOWNLOAD_MAX_REDIRECTS` re-checked redirects, bounded in bytes and time. */
export async function download(url: string, fetchPort: ProvisionPorts["fetch"]): Promise<Buffer> {
	const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
	let current = url;
	for (let hop = 0; hop <= DOWNLOAD_MAX_REDIRECTS; hop += 1) {
		let target: URL;
		try {
			target = new URL(current);
		} catch {
			throw new Error("refusing a download location that is not a URL");
		}
		if (target.protocol !== "https:" || !DOWNLOAD_HOSTS.includes(target.hostname) || target.port !== "" || target.username !== "" || target.password !== "") {
			throw new Error(`refusing to download from ${target.protocol}//${target.host}: only https on ${DOWNLOAD_HOSTS.join(", ")}`);
		}
		const response = await fetchPort(target.href, { redirect: "manual", signal });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error(`HTTP ${response.status} without a Location`);
			current = new URL(location, target).href;
			continue;
		}
		if (response.status !== 200 || !response.body) {
			await response.body?.cancel();
			throw new Error(`HTTP ${response.status} from ${target.host}`);
		}
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > DOWNLOAD_MAX_BYTES) {
			await response.body.cancel();
			throw new Error(`the download declares ${declared} bytes, over the ${DOWNLOAD_MAX_BYTES}-byte cap`);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		const reader = response.body.getReader();
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			total += read.value.byteLength;
			if (total > DOWNLOAD_MAX_BYTES) {
				await reader.cancel();
				throw new Error(`the download passed the ${DOWNLOAD_MAX_BYTES}-byte cap`);
			}
			chunks.push(Buffer.from(read.value));
		}
		return Buffer.concat(chunks);
	}
	throw new Error(`more than ${DOWNLOAD_MAX_REDIRECTS} redirects`);
}

const field = (block: Buffer, start: number, length: number): string => {
	const raw = block.subarray(start, start + length);
	const end = raw.indexOf(0);
	return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
};

/** A ustar size field: octal, or GNU base-256 (high bit set, big-endian, never negative). Anything else refuses. */
function headerSize(header: Buffer): number {
	const first = header[124] ?? 0;
	if (first & 0x80) {
		if (first & 0x40) throw new Error("archive entry has a negative size");
		let size = first & 0x3f;
		for (let i = 125; i < 136; i += 1) size = size * 256 + (header[i] ?? 0);
		if (!Number.isSafeInteger(size)) throw new Error("archive entry has an unreadable size");
		return size;
	}
	const text = field(header, 124, 12).trim();
	if (!/^[0-7]+$/.test(text)) throw new Error("archive entry has an unreadable size");
	return Number.parseInt(text, 8);
}

/**
 * The binary from a verified macOS release archive: gzip, then ustar/pax, holding exactly one regular file named
 * `cloudflared`. pax extended headers are read only for a path and a size (which overrides the next entry's); a link,
 * directory, global header, other entry, unreadable size or a second copy refuses the whole archive.
 */
export function extractCloudflared(archive: Buffer): Buffer {
	const tar = gunzipSync(archive, { maxOutputLength: DOWNLOAD_MAX_BYTES });
	let found: Buffer | undefined;
	let paxPath: string | undefined;
	let paxSize: number | undefined;
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = paxSize ?? headerSize(header);
		paxSize = undefined;
		const body = tar.subarray(offset + 512, offset + 512 + size);
		if (body.length !== size) throw new Error("archive is truncated");
		offset += 512 + Math.ceil(size / 512) * 512;
		const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
		if (type === "x") {
			for (const record of body.toString("utf8").split("\n").filter(Boolean)) {
				const [key, ...value] = record.replace(/^\d+ /, "").split("=");
				if (key === "linkpath") throw new Error("archive entry is a link");
				if (key === "path") paxPath = value.join("=");
				if (key === "size") {
					const text = value.join("=");
					if (!/^\d{1,15}$/.test(text)) throw new Error("archive pax header has an unreadable size");
					paxSize = Number(text);
				}
			}
			continue;
		}
		const ustar = field(header, 257, 6) === "ustar";
		const prefix = ustar ? field(header, 345, 155) : "";
		const name = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
		paxPath = undefined;
		if (type !== "0") throw new Error(`archive holds a non-regular entry (type ${JSON.stringify(type)}): ${JSON.stringify(name.slice(0, 120))}`);
		if (name.replace(/^\.\//, "") !== "cloudflared") throw new Error(`archive holds an unexpected entry ${JSON.stringify(name.slice(0, 120))}`);
		if (found) throw new Error("archive holds cloudflared twice");
		found = Buffer.from(body);
	}
	if (!found) throw new Error("archive holds no cloudflared");
	return found;
}
