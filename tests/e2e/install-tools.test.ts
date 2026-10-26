/**
 * Behavior 15 (P14): `node scripts/install-tools.ts` on a scratch PATH of logging stubs and a scratch HOME. Nothing
 * reaches the network, the host's tools or its env; the OS is the one fact faked, by a `process.platform` preload.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { whichAll } from "../../src/doctor.ts";
import { TOOL_INSTALL } from "../../src/tool-manifest.ts";
import { REPO_ROOT } from "../harness/index.ts";

const SCRIPT = join(REPO_ROOT, "scripts/install-tools.ts");
const CHMOD = realpathSync(whichAll("chmod")[0]!);
const PI_PKG = "npm install -g --ignore-scripts @earendil-works/pi-coding-agent";

/** A scratch host: `bin` and `$HOME/.local/bin` on PATH, stubs that log `name args` and run `body`. */
function host(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), "cp-p14-tools-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const local = join(home, ".local/bin");
	const prefix = join(root, "npm-prefix");
	for (const dir of [bin, local, prefix]) mkdirSync(dir, { recursive: true });
	symlinkSync(realpathSync(whichAll("mv")[0]!), join(bin, "mv"));
	const log = join(root, "calls.log");
	const stub = (name: string, body = "exit 0", dir = bin) =>
		writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> ${log}\n${body}\n`, { mode: 0o755 });
	const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
	const run = (args: string[], env: Record<string, string> = {}, platform?: string) => {
		const fake = platform ? ["--import", `data:text/javascript,Object.defineProperty(process,"platform",{value:"${platform}"})`] : [];
		const before = calls().length;
		const ran = spawnSync(process.execPath, [...fake, SCRIPT, ...args], {
			encoding: "utf8", timeout: 60_000, env: { PATH: `${local}:${bin}`, HOME: home, ...env },
		});
		return { status: ran.status, out: ran.stdout, err: ran.stderr, calls: calls().slice(before) };
	};
	stub("npm", `[ "$1" = prefix ] && echo ${prefix}; exit 0`);
	return { home, bin, local, prefix, stub, run };
}

test("P14-install-tools: install-tools installs only what is missing, once, and never shadows, sudoes or fights pi", { timeout: 120_000 }, async (t) => {
	const h = host(t);
	const release = TOOL_INSTALL.treehouse.linux;
	assert.equal(release.kind, "release");
	if (release.kind !== "release") return;
	const asset = `treehouse-v${release.version}-linux-${arch() === "arm64" ? "arm64" : "amd64"}.tar.gz`;
	const fetch = `download ${release.repo} v${release.version} from its GitHub release`;

	// A dry run plans the release download and the npm install, runs neither, and exits 3; twice, identically.
	const dry = h.run(["--dry-run", "treehouse", "pi"]);
	assert.equal(dry.status, 3, dry.out + dry.err);
	assert.match(dry.out, /^install-tools \(dry run\) · os=linux\n\n/);
	assert.ok(dry.out.includes(`… treehouse: missing — would run: ${fetch}\n`), dry.out);
	assert.ok(dry.out.includes(`… pi: missing — would run: ${PI_PKG} (into npm's global prefix ${h.prefix})\n`), dry.out);
	assert.match(dry.out, /some tools still need attention \(see above\)/);
	assert.equal(dry.calls, "npm prefix -g\n", "a dry run reads npm's prefix and runs nothing");
	assert.deepEqual(h.run(["--dry-run", "treehouse", "pi"]).out, dry.out, "a second dry run reports the same plan");

	// A real run fetches the pinned asset, lands treehouse in ~/.local/bin, and a rerun leaves it alone.
	h.stub("curl");
	h.stub("tar", `printf '#!/bin/sh\\n' > "$4/treehouse" && ${CHMOD} 755 "$4/treehouse"`);
	const first = h.run(["treehouse"]);
	assert.equal(first.status, 0, first.out + first.err);
	assert.ok(first.out.includes(`✓ treehouse: ${fetch} -> ${join(h.local, "treehouse")}\n`), first.out);
	assert.match(first.calls, new RegExp(`^curl -fsSL https://github\\.com/${release.repo}/releases/download/v${release.version}/${asset} -o `));
	const again = h.run(["treehouse"]);
	assert.deepEqual([again.status, again.calls], [0, ""], "an installed tool is never installed again");
	assert.ok(again.out.includes(`✓ treehouse: already installed at ${join(h.local, "treehouse")}\n`));

	// Two copies on PATH are a conflict: nothing is downloaded and a human must act.
	h.stub("treehouse", "exit 0");
	const twice = h.run(["--dry-run", "treehouse"]);
	assert.deepEqual([twice.status, twice.calls], [1, ""]);
	assert.match(twice.out, /✗ treehouse: 2 copies already on PATH \(.*\) — not installing another; resolve the duplicate first/);

	// git on Linux has no non-sudo path: reported, never run, never planned.
	const git = h.run(["--dry-run", "git"]);
	assert.equal(git.status, 1, "manual is never planned");
	assert.match(git.out, /✗ git: .*sudo/);
	assert.equal(git.calls, "");

	// An npm install that does not land pi fails with its retry; inside a pi session pi is not touched at all.
	const lost = h.run(["pi"]);
	assert.equal(lost.status, 1, lost.out);
	assert.ok(lost.out.includes(`✗ pi: ran ${PI_PKG} (into npm's global prefix ${h.prefix}) but pi is still not on PATH`), lost.out);
	assert.ok(lost.out.includes(`after fixing the above, retry: ${process.execPath} ${SCRIPT} pi`), lost.out);
	for (const [env, session] of [[{ PI_SESSION_ID: "abc-123" }, "abc-123"], [{ PI_CODING_AGENT: "true" }, "pi-coding-agent"]] as const) {
		const guarded = h.run(["pi"], env);
		assert.equal(guarded.status, 1);
		assert.ok(guarded.out.includes(`running inside a pi session (${session}); pi will not be reinstalled`), guarded.out);
		assert.match(guarded.out, new RegExp(`✗ pi: not on PATH, but this process is running inside a pi session \\(${session}\\)`));
		assert.equal(guarded.calls, "", "inside a pi session not even npm's prefix is read");
	}
	const notPi = h.run(["--dry-run", "pi"], { PI_CODING_AGENT: "false" });
	assert.deepEqual([notPi.status, notPi.out.includes("would run: npm install")], [3, true], "only PI_CODING_AGENT=true marks a session");

	// Everything on PATH: ok, nothing run, the verdict says so; an unknown tool is refused before anything runs.
	for (const tool of ["git", "pi", "gh"]) h.stub(tool, "exit 0", h.local);
	const all = h.run(["--dry-run"]);
	assert.equal(all.status, 1, "treehouse still has two copies");
	rmSync(join(h.bin, "treehouse"));
	const ok = h.run(["--dry-run"]);
	assert.equal(ok.status, 0, ok.out);
	assert.doesNotMatch(ok.calls, /^(npm|curl|tar|brew|pi) /m, "nothing is installed or probed");
	for (const tool of ["git", "treehouse", "pi", "gh"]) assert.ok(ok.out.includes(`✓ ${tool}: already installed at ${join(h.local, tool)}`), tool);
	assert.match(ok.out, /\nall required tools are on PATH\n/);
	const unknown = h.run(["--dry-run", "not-a-real-tool"]);
	assert.equal(unknown.status, 2);
	assert.doesNotMatch(unknown.calls, /^(npm|curl|tar|brew|pi) /m);
	assert.match(unknown.err, /install-tools: unknown tool "not-a-real-tool" \(known: git, treehouse, pi, gh\)/);
});

test("P14-install-tools-os: brew installs a missing tool on macOS once; another platform is reported, not guessed", { timeout: 60_000 }, async (t) => {
	const h = host(t);
	h.stub("brew", `printf '#!/bin/sh\\n' > "$HOME/.local/bin/$2" && ${CHMOD} 755 "$HOME/.local/bin/$2"`);
	const mac = h.run(["git"], {}, "darwin");
	assert.equal(mac.status, 0, mac.out + mac.err);
	assert.ok(mac.out.includes(`✓ git: brew install git -> ${join(h.local, "git")}\n`), mac.out);
	assert.equal(mac.calls, "brew install git\n");
	assert.equal(h.run(["git"], {}, "darwin").calls, "", "a re-run does not install again");

	const other = h.run(["--dry-run", "treehouse"], {}, "aix");
	assert.equal(other.status, 1);
	assert.ok(other.out.includes("✗ treehouse: no supported install path on this platform (unsupported)"), other.out);
	assert.equal(other.calls, "");
});
