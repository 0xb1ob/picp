/**
 * T5 (remote dashboard PR 2): the cloudflared provisioner. Every download is a fake fetch and every probe a fake
 * runner or a local shell-script stand-in; nothing here reaches Cloudflare or GitHub.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
	CLOUDFLARED_RELEASES,
	type CloudflaredRelease,
	cloudflaredBinDir,
	extractCloudflared,
	namedArgv,
	type ProvisionPorts,
	probeCloudflared,
	provisionCloudflared,
	quickArgv,
	releaseUrl,
	runFile,
	type RunResult,
} from "../src/tunnel/cloudflared.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const BINARY = Buffer.from("#!/bin/sh\necho fake cloudflared\n");
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const HELP = { tunnel: "OPTIONS:\n   --no-autoupdate  ...\n   --url value  ...\n   --http-host-header value  ...", run: "OPTIONS:\n   --token-file value  ..." };

/** A runner that answers like cloudflared `version`, with the given flags in its help. */
function fakeRun(versions: Record<string, string | undefined>, calls: string[][] = [], help = HELP): ProvisionPorts["run"] {
	return async (file, args): Promise<RunResult> => {
		calls.push([file, ...args]);
		const version = Object.entries(versions).find(([suffix]) => file.endsWith(suffix) || file.includes(suffix))?.[1];
		if (!version) return { code: 127, stdout: "", stderr: "not cloudflared" };
		if (args[0] === "--version") return { code: 0, stdout: `cloudflared version ${version} (built 2026-10-01-0000 UTC)\n`, stderr: "" };
		if (args.join(" ") === "tunnel --help") return { code: 0, stdout: help.tunnel, stderr: "" };
		if (args.join(" ") === "tunnel run --help") return { code: 0, stdout: help.run, stderr: "" };
		return { code: 1, stdout: "", stderr: "unexpected argv" };
	};
}

type Route = { status: number; body?: Buffer; location?: string; length?: string };
function fakeFetch(routes: Record<string, Route>, seen: string[] = []): ProvisionPorts["fetch"] {
	return async (url, init) => {
		assert.equal(init.redirect, "manual", "redirects are followed by the provisioner, never by fetch");
		seen.push(url);
		const route = routes[url];
		if (!route) return new Response(null, { status: 404 });
		const headers: Record<string, string> = {};
		if (route.location) headers.location = route.location;
		if (route.length) headers["content-length"] = route.length;
		return new Response(route.body ? new Uint8Array(route.body) : null, { status: route.status, headers });
	};
}

function bench(t: import("node:test").TestContext) {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const binDir = cloudflaredBinDir(home.path);
	const pathDir = join(home.path, "path-bin");
	mkdirSync(pathDir, { recursive: true });
	const place = (dir: string, mode = 0o755): string => {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "cloudflared");
		writeFileSync(file, "#!/bin/sh\n", { mode });
		return file;
	};
	const listBin = (): string[] => {
		try {
			return readdirSync(binDir).sort();
		} catch {
			return [];
		}
	};
	return { home: home.path, binDir, pathDir, place, listBin };
}

const URL_LINUX = releaseUrl("cloudflared-linux-amd64");
const linuxRelease = (bytes: Buffer): Record<string, CloudflaredRelease> => ({ "linux-x64": { asset: "cloudflared-linux-amd64", sha256: sha(bytes), archive: false } });

test("the pinned release table is the plan's official SHA256s, and the argv is fixed for both modes", () => {
	assert.deepEqual(
		Object.fromEntries(Object.entries(CLOUDFLARED_RELEASES).map(([key, release]) => [key, release.sha256])),
		{
			"linux-x64": "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
			"linux-arm64": "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
			"darwin-x64": "0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da",
			"darwin-arm64": "72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830",
		},
	);
	assert.equal(URL_LINUX, "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64");
	assert.deepEqual(quickArgv(8767), ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8767", "--http-host-header", "127.0.0.1:8767"]);
	assert.deepEqual(namedArgv("/home/u/.pi-command-post/data/tunnel/token"), ["tunnel", "--no-autoupdate", "run", "--token-file", "/home/u/.pi-command-post/data/tunnel/token"]);
	for (const port of [80, 1023, 65536, 8767.5, Number.NaN]) assert.throws(() => quickArgv(port), /1024–65535/);
	for (const file of ["token", "../token", "/tmp/a\nb"]) assert.throws(() => namedArgv(file), /absolute path/);
});

test("A11: no sudo, shell or package manager anywhere in the provisioner", () => {
	const code = readFileSync(join(REPO_ROOT, "src/tunnel/cloudflared.ts"), "utf8")
		.split("\n")
		.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
		.join("\n");
	assert.doesNotMatch(code, /\bsudo\b|\bshell:\s*true|\bexecSync\b|\bspawnSync\b|\b(?:apt|brew|dnf|yum)\b/);
});

test("A10: a compatible cloudflared on PATH wins and nothing is downloaded; relative PATH entries are never searched", async (t) => {
	const b = bench(t);
	const onPath = b.place(b.pathDir);
	b.place(join(b.home, "relative-dir"));
	const seen: string[] = [];
	const calls: string[][] = [];
	const result = await provisionCloudflared(b.binDir, { platform: "linux", arch: "x64", pathEnv: `relative-dir:${b.pathDir}`, fetch: fakeFetch({}, seen), run: fakeRun({ [onPath]: "2025.4.0" }, calls) }, linuxRelease(BINARY));
	assert.deepEqual(result, { ok: true, path: onPath, source: "path", version: "2025.4.0" });
	assert.deepEqual(seen, []);
	assert.deepEqual(b.listBin(), []);
	assert.ok(calls.every(([file]) => file === onPath));
});

test("A10: an old or flag-less PATH binary is rejected and the verified pinned download is published atomically under <home>/bin", async (t) => {
	const b = bench(t);
	const old = b.place(b.pathDir);
	const calls: string[][] = [];
	const lines: string[] = [];
	const result = await provisionCloudflared(
		b.binDir,
		{ platform: "linux", arch: "x64", pathEnv: b.pathDir, fetch: fakeFetch({ [URL_LINUX]: { status: 200, body: BINARY } }), run: fakeRun({ [old]: "2025.3.9", ".cloudflared.": "2026.10.0", [join(b.binDir, "cloudflared")]: "2026.10.0" }, calls), log: (line) => lines.push(line) },
		linuxRelease(BINARY),
	);
	assert.deepEqual(result, { ok: true, path: join(b.binDir, "cloudflared"), source: "download", version: "2026.10.0" });
	assert.deepEqual(b.listBin(), ["cloudflared"], "the temp file was renamed, nothing left beside it");
	assert.deepEqual(readFileSync(join(b.binDir, "cloudflared")), BINARY);
	assert.equal(statSync(join(b.binDir, "cloudflared")).mode & 0o777, 0o755);
	assert.ok(calls.some(([file]) => file?.includes(".cloudflared.")), "the download is probed before it is published");
	assert.match(lines.join("\n"), /rejected: .*2025\.3\.9, older than 2025\.4\.0/);

	const again = await provisionCloudflared(b.binDir, { platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch({}), run: fakeRun({ [join(b.binDir, "cloudflared")]: "2026.10.0" }) }, linuxRelease(BINARY));
	assert.deepEqual(again, { ok: true, path: join(b.binDir, "cloudflared"), source: "installed", version: "2026.10.0" });

	const flagless = b.place(join(b.home, "other-path"));
	const probe = await probeCloudflared(flagless, fakeRun({ [flagless]: "2026.10.0" }, [], { ...HELP, run: "OPTIONS:\n   --token value" }));
	assert.deepEqual(probe, { ok: false, reason: `${flagless} (cloudflared 2026.10.0) lacks --token-file in \`tunnel run --help\`` });
});

test("A10: a checksum mismatch, an unrunnable download, an HTTP error or an unsupported platform publishes nothing", async (t) => {
	const b = bench(t);
	const ports = (routes: Record<string, Route>, versions: Record<string, string> = { ".cloudflared.": "2026.10.0" }): ProvisionPorts => ({ platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch(routes), run: fakeRun(versions) });
	const tampered = await provisionCloudflared(b.binDir, ports({ [URL_LINUX]: { status: 200, body: Buffer.from("tampered") } }), linuxRelease(BINARY));
	assert.equal(tampered.ok, false);
	assert.match(tampered.ok ? "" : tampered.reason, /checksum mismatch for cloudflared-linux-amd64/);
	assert.deepEqual(b.listBin(), [], "no executable before the checksum");

	const wrongArch = await provisionCloudflared(b.binDir, ports({ [URL_LINUX]: { status: 200, body: BINARY } }, {}), linuxRelease(BINARY));
	assert.match(wrongArch.ok ? "" : wrongArch.reason, /the verified download does not run here/);
	assert.deepEqual(b.listBin(), [], "the temp file is removed");

	const missing = await provisionCloudflared(b.binDir, ports({ [URL_LINUX]: { status: 404 } }), linuxRelease(BINARY));
	assert.match(missing.ok ? "" : missing.reason, /HTTP 404 from github\.com/);

	const huge = await provisionCloudflared(b.binDir, ports({ [URL_LINUX]: { status: 200, body: BINARY, length: String(1024 * 1024 * 1024) } }), linuxRelease(BINARY));
	assert.match(huge.ok ? "" : huge.reason, /over the \d+-byte cap/);

	const windows = await provisionCloudflared(b.binDir, { ...ports({}), platform: "win32", arch: "x64" });
	assert.deepEqual(windows, { ok: false, reason: "no compatible cloudflared on PATH, and no pinned download for win32-x64: install cloudflared 2025.4.0 or later on PATH" });
	assert.deepEqual(b.listBin(), []);
});

test("A10: redirects are followed only over https to the GitHub release hosts, at most five times", async (t) => {
	const b = bench(t);
	const objects = "https://objects.githubusercontent.com/asset?sig=1";
	const seen: string[] = [];
	const run = fakeRun({ ".cloudflared.": "2026.10.0" });
	const follow = await provisionCloudflared(b.binDir, { platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch({ [URL_LINUX]: { status: 302, location: objects }, [objects]: { status: 200, body: BINARY } }, seen), run }, linuxRelease(BINARY));
	assert.equal(follow.ok, true);
	assert.deepEqual(seen, [URL_LINUX, objects]);

	const refused = async (location: string): Promise<string> => {
		const result = await provisionCloudflared(join(b.home, "other-bin"), { platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch({ [URL_LINUX]: { status: 302, location }, [location]: { status: 200, body: BINARY } }), run }, linuxRelease(BINARY));
		assert.equal(result.ok, false);
		return result.ok ? "" : result.reason;
	};
	assert.match(await refused("http://objects.githubusercontent.com/asset"), /refusing to download from http:\/\/objects\.githubusercontent\.com/);
	assert.match(await refused("https://evil.example/cloudflared"), /refusing to download from https:\/\/evil\.example/);
	assert.match(await refused("https://user:pw@github.com/x"), /refusing to download/);
	assert.match(await refused("https://github.com:8443/x"), /refusing to download/);
	const loop: Record<string, Route> = {};
	for (let hop = 0; hop < 7; hop += 1) loop[hop === 0 ? URL_LINUX : `https://github.com/hop/${hop}`] = { status: 302, location: `https://github.com/hop/${hop + 1}` };
	const looped = await provisionCloudflared(join(b.home, "loop-bin"), { platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch(loop), run }, linuxRelease(BINARY));
	assert.match(looped.ok ? "" : looped.reason, /more than 5 redirects/);
	assert.deepEqual(readdirSync(b.home).filter((entry) => entry.endsWith("-bin") && entry !== "path-bin" && entry !== "other-bin" && entry !== "loop-bin"), []);
});

/** One ustar entry (the parser reads name, size, type, magic and prefix; the checksum is the SHA256's job). */
function tarEntry(name: string, body: Buffer, type = "0"): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000755\0", 100);
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write(type, 156);
	header.write("ustar\0", 257);
	header.write("00", 263);
	return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}
const pax = (records: Record<string, string>): Buffer =>
	Buffer.from(
		Object.entries(records)
			.map(([key, value]) => {
				const line = ` ${key}=${value}\n`;
				let length = line.length + 1;
				while (`${length}${line}`.length !== length) length += 1;
				return `${length}${line}`;
			})
			.join(""),
	);
const tgz = (...entries: Buffer[]): Buffer => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

test("A10: a verified macOS archive yields only its one regular cloudflared; links, traversal, directories and extras refuse", async (t) => {
	const b = bench(t);
	assert.deepEqual(extractCloudflared(tgz(tarEntry("cloudflared", BINARY))), BINARY);
	assert.deepEqual(extractCloudflared(tgz(tarEntry("PaxHeader", pax({ "LIBARCHIVE.xattr.com.apple.provenance": "AQ" }), "x"), tarEntry("./cloudflared", BINARY))), BINARY);
	const hostile: Array<[string, Buffer, RegExp]> = [
		["symlink", tgz(tarEntry("cloudflared", Buffer.alloc(0), "2")), /non-regular entry \(type "2"\)/],
		["hard link", tgz(tarEntry("cloudflared", Buffer.alloc(0), "1")), /non-regular entry \(type "1"\)/],
		["traversal", tgz(tarEntry("../cloudflared", BINARY)), /unexpected entry "\.\.\/cloudflared"/],
		["absolute", tgz(tarEntry("/usr/local/bin/cloudflared", BINARY)), /unexpected entry/],
		["directory", tgz(tarEntry("./", Buffer.alloc(0), "5"), tarEntry("cloudflared", BINARY)), /non-regular entry \(type "5"\)/],
		["extra file", tgz(tarEntry("cloudflared", BINARY), tarEntry("._cloudflared", Buffer.from("x"))), /unexpected entry "\._cloudflared"/],
		["twice", tgz(tarEntry("cloudflared", BINARY), tarEntry("cloudflared", BINARY)), /cloudflared twice/],
		["pax rename", tgz(tarEntry("PaxHeader", pax({ path: "../../.bashrc" }), "x"), tarEntry("cloudflared", BINARY)), /unexpected entry "\.\.\/\.\.\/\.bashrc"/],
		["pax link", tgz(tarEntry("PaxHeader", pax({ linkpath: "/etc/passwd" }), "x"), tarEntry("cloudflared", BINARY)), /is a link/],
		["global header", tgz(tarEntry("pax_global_header", pax({ comment: "x" }), "g"), tarEntry("cloudflared", BINARY)), /non-regular entry \(type "g"\)/],
		["empty", tgz(), /holds no cloudflared/],
		["truncated", gzipSync(tarEntry("cloudflared", Buffer.alloc(2000, 1)).subarray(0, 1024)), /truncated/],
	];
	for (const [label, archive, reason] of hostile) {
		const release = { "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: sha(archive), archive: true } };
		const url = releaseUrl("cloudflared-darwin-arm64.tgz");
		const result = await provisionCloudflared(b.binDir, { platform: "darwin", arch: "arm64", pathEnv: "", fetch: fakeFetch({ [url]: { status: 200, body: archive } }), run: fakeRun({ ".cloudflared.": "2026.10.0" }) }, release);
		assert.equal(result.ok, false, label);
		assert.match(result.ok ? "" : result.reason, reason, label);
		assert.deepEqual(b.listBin(), [], `${label}: nothing published`);
	}
	const good = tgz(tarEntry("cloudflared", BINARY));
	const url = releaseUrl("cloudflared-darwin-arm64.tgz");
	const result = await provisionCloudflared(b.binDir, { platform: "darwin", arch: "arm64", pathEnv: "", fetch: fakeFetch({ [url]: { status: 200, body: good } }), run: fakeRun({ ".cloudflared.": "2026.10.0" }) }, { "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: sha(good), archive: true } });
	assert.equal(result.ok, true);
	assert.deepEqual(readFileSync(join(b.binDir, "cloudflared")), BINARY);
});

test("the production runner probes a real executable with a fixed argv and no shell", async (t) => {
	const b = bench(t);
	const script = (dir: string, help: string): string => {
		const file = b.place(join(b.home, dir));
		writeFileSync(
			file,
			`#!/bin/sh\ncase "$*" in\n  --version) echo "cloudflared version 2026.10.0 (built 2026-10-01-0000 UTC)" ;;\n  "tunnel --help") echo "  --no-autoupdate  --url value  --http-host-header value" ;;\n  "tunnel run --help") echo "${help}" ;;\n  *) exit 3 ;;\nesac\n`,
		);
		chmodSync(file, 0o755);
		return file;
	};
	const good = script("good", "  --token-file value");
	assert.deepEqual(await probeCloudflared(good, runFile), { ok: true, version: "2026.10.0" });
	const bad = script("bad", "  --token value");
	assert.deepEqual(await probeCloudflared(bad, runFile), { ok: false, reason: `${bad} (cloudflared 2026.10.0) lacks --token-file in \`tunnel run --help\`` });
	const result = await provisionCloudflared(b.binDir, { platform: "linux", arch: "x64", pathEnv: `${join(b.home, "bad")}:${join(b.home, "good")}`, fetch: fakeFetch({}), run: runFile }, {});
	assert.deepEqual(result, { ok: true, path: good, source: "path", version: "2026.10.0" });
});
