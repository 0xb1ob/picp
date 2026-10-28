/** Retained (P12c): the cloudflared provisioner units of tests/tunnel-cloudflared.test.ts that no entry point reaches.
 * A published or extracted binary needs a body matching the pinned SHA256 (the real release); the pin table and A11 are
 * structural; the runner probes a real executable. PATH, refusals and redirects are in tests/e2e/remote-tunnel.test.ts.
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
		Object.fromEntries(Object.entries(CLOUDFLARED_RELEASES).map(([key, release]) => [key, [release.sha256, release.binarySha256]])),
		{
			"linux-x64": ["ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42", undefined],
			"linux-arm64": ["2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6", undefined],
			"darwin-x64": ["f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d", "fdec0f9a1c726f4c10283fc0cd70e602d510c72887b737270433c81a08c883a9"],
			"darwin-arm64": ["68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f", "49e7963072b2ca83fb44c09f4d4a7cda52d390c0c9c6f55bac83454a5bc43910"],
		},
	);
	assert.equal(URL_LINUX, "https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-linux-amd64");
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


/** One ustar entry (the parser reads name, size, type, magic and prefix; the checksum is the SHA256's job). */
function tarEntry(name: string, body: Buffer, type = "0", size?: Buffer): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000755\0", 100);
	if (size) size.copy(header, 124);
	else header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
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
		const release = { "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: sha(archive), archive: true, binarySha256: sha(BINARY) } };
		const url = releaseUrl("cloudflared-darwin-arm64.tgz");
		const result = await provisionCloudflared(b.binDir, { platform: "darwin", arch: "arm64", pathEnv: "", fetch: fakeFetch({ [url]: { status: 200, body: archive } }), run: fakeRun({ ".cloudflared.": "2026.10.0" }) }, release);
		assert.equal(result.ok, false, label);
		assert.match(result.ok ? "" : result.reason, reason, label);
		assert.deepEqual(b.listBin(), [], `${label}: nothing published`);
	}
	const good = tgz(tarEntry("cloudflared", BINARY));
	const url = releaseUrl("cloudflared-darwin-arm64.tgz");
	const result = await provisionCloudflared(b.binDir, { platform: "darwin", arch: "arm64", pathEnv: "", fetch: fakeFetch({ [url]: { status: 200, body: good } }), run: fakeRun({ ".cloudflared.": "2026.10.0" }) }, { "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", sha256: sha(good), archive: true, binarySha256: sha(BINARY) } });
	assert.equal(result.ok, true);
	assert.deepEqual(readFileSync(join(b.binDir, "cloudflared")), BINARY);
});

/* Given a pinned darwin release, When cloudflared is provisioned with a wrong inner binarySha256, Then it is refused naming
   the inner binary; with a wrong tarball sha256, Then it is refused naming the asset. Neither case publishes anything. */
test("A10: a macOS archive is verified twice, the tarball before extraction and the inner binary before publishing", async (t) => {
	const b = bench(t);
	const good = tgz(tarEntry("cloudflared", BINARY));
	const url = releaseUrl("cloudflared-darwin-arm64.tgz");
	const run = fakeRun({ ".cloudflared.": "2026.10.0" });
	const asset = "cloudflared-darwin-arm64.tgz";
	const cases: Array<[string, { sha256: string; binarySha256?: string }, RegExp]> = [
		["inner mismatch", { sha256: sha(good), binarySha256: sha(Buffer.from("other")) }, /inside cloudflared-darwin-arm64\.tgz/],
		["outer mismatch", { sha256: sha(Buffer.from("other")), binarySha256: sha(BINARY) }, /checksum mismatch for cloudflared-darwin-arm64\.tgz/],
		["inner hash missing", { sha256: sha(good) }, /inside cloudflared-darwin-arm64\.tgz/],
		["notes hash on the tarball", { sha256: sha(BINARY), binarySha256: sha(BINARY) }, /checksum mismatch for cloudflared-darwin-arm64\.tgz/],
	];
	for (const [label, hashes, reason] of cases) {
		const result = await provisionCloudflared(b.binDir, { platform: "darwin", arch: "arm64", pathEnv: "", fetch: fakeFetch({ [url]: { status: 200, body: good } }), run }, { "darwin-arm64": { asset, archive: true, ...hashes } });
		assert.equal(result.ok, false, label);
		assert.match(result.ok ? "" : result.reason, reason, label);
		assert.deepEqual(b.listBin(), [], `${label}: nothing published`);
	}
});

/** A 12-byte GNU base-256 size field: the high bit set, then the value big-endian. */
const base256 = (value: number, first = 0x80): Buffer => {
	const out = Buffer.alloc(12);
	out[0] = first;
	out.writeUIntBE(value, 6, 6);
	return out;
};

test("#248 review: a pax size overrides the next entry's, GNU base-256 sizes read, and unreadable sizes still refuse", () => {
	const zeros = Buffer.from("00000000000\0");
	assert.deepEqual(extractCloudflared(tgz(tarEntry("PaxHeader", pax({ size: String(BINARY.length) }), "x"), tarEntry("cloudflared", BINARY, "0", zeros))), BINARY);
	assert.deepEqual(extractCloudflared(tgz(tarEntry("cloudflared", BINARY, "0", base256(BINARY.length)))), BINARY);
	const refused: Array<[string, Buffer, RegExp]> = [
		["pax size not a number", tgz(tarEntry("PaxHeader", pax({ size: "12k" }), "x"), tarEntry("cloudflared", BINARY)), /pax header has an unreadable size/],
		["negative base-256", tgz(tarEntry("cloudflared", BINARY, "0", base256(BINARY.length, 0xff))), /negative size/],
		["size field garbage", tgz(tarEntry("cloudflared", BINARY, "0", Buffer.from("zz\0"))), /unreadable size/],
		["pax size past the end", tgz(tarEntry("PaxHeader", pax({ size: "999999" }), "x"), tarEntry("cloudflared", BINARY, "0", zeros)), /truncated/],
	];
	for (const [label, archive, reason] of refused) assert.throws(() => extractCloudflared(archive), reason, label);
});

test("#248 review: a flag is matched whole (`--url-foo` is not `--url`), and an existing bin/ is narrowed to 0700", async (t) => {
	const b = bench(t);
	const fake = b.place(join(b.home, "fake"));
	const probe = await probeCloudflared(fake, fakeRun({ [fake]: "2026.10.0" }, [], { ...HELP, tunnel: "   --no-autoupdate  --url-foo value  --http-host-header value" }));
	assert.deepEqual(probe, { ok: false, reason: `${fake} (cloudflared 2026.10.0) lacks --url in \`tunnel --help\`` });
	assert.deepEqual(await probeCloudflared(fake, fakeRun({ [fake]: "2026.10.0" }, [], { ...HELP, tunnel: "--no-autoupdate, --url=value, --http-host-header" })), { ok: true, version: "2026.10.0" });
	mkdirSync(b.binDir, { recursive: true, mode: 0o755 });
	chmodSync(b.binDir, 0o755);
	const result = await provisionCloudflared(b.binDir, { platform: "linux", arch: "x64", pathEnv: "", fetch: fakeFetch({ [URL_LINUX]: { status: 200, body: BINARY } }), run: fakeRun({ ".cloudflared.": "2026.10.0" }) }, linuxRelease(BINARY));
	assert.equal(result.ok, true);
	assert.equal(statSync(b.binDir).mode & 0o777, 0o700);
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
