/**
 * cp-wfo4: the pure half of cp-daemon. Retained (P14b): the paths equal the layout, env/argv parity with the legacy
 * units and the outer's import boundary are structural pins with no e2e consumer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { layoutForHome } from "../src/contracts/layout.ts";
import { childArgv, childEnv, type DaemonConfig, daemonPaths, OUTER_SOURCES, validateDaemonConfig } from "../src/service/daemon-files.ts";
import { renderUnits, unitPath } from "../src/service/units.ts";

const SERVICE = resolve(import.meta.dirname, "../src/service");

test("daemonPaths equals layoutForHome('multi', home) for a nested and a flat home", () => {
	for (const home of ["/srv/homes/a", "/home/u/.pi-command-post"]) {
		const layout = layoutForHome("multi", home);
		const paths = daemonPaths(home);
		assert.equal(paths.stateDir, join(home, layout.state));
		assert.equal(paths.dataDir, join(home, layout.data));
		assert.equal(paths.lock, join(home, layout.state, "daemon.lock"));
		assert.equal(paths.config, join(home, layout.data, "daemon.json"));
		assert.equal(paths.update, join(home, layout.state, "update.json"));
	}
});


/** The `Environment=` pairs and `ExecStart=` words of a rendered unit, systemd escapes undone. */
function parseUnit(text: string): { env: Record<string, string>; argv: string[] } {
	const words = (line: string, exec: boolean): string[] =>
		[...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => {
			const value = (m[1] as string).replace(/\\(.)/g, "$1").replace(/%%/g, "%");
			return exec ? value.replace(/\$\$/g, "$") : value;
		});
	const env: Record<string, string> = {};
	let argv: string[] = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("Environment=")) {
			const [pair] = words(line, false);
			const at = (pair as string).indexOf("=");
			env[(pair as string).slice(0, at)] = (pair as string).slice(at + 1);
		} else if (line.startsWith("ExecStart=")) argv = words(line, true);
	}
	return { env, argv };
}

test("childEnv/childArgv equal the legacy units' Environment=/ExecStart= words, and leak nothing from the shell", () => {
	const unitFor = { parent: "cp-parent.service", viewer: "cp-view.service", health: "cp-health.service", update: "cp-update.service" } as const;
	const base = { HOME: "/home/u", USER: "u", LOGNAME: "u" };
	for (const extra of [{}, { viewerHost: "100.64.0.7", parentModel: "anthropic/claude-x 100%$" }]) {
		const input = { node: "/opt/node/bin/node", app: "/srv/app", home: "/home/u/.pi-command-post", path: "/usr/bin:/home/u/.fnm/fnm_multishells/1/bin:/bin", port: 7300, ...extra };
		const units = renderUnits(input);
		const config: DaemonConfig = {
			schema_version: 1,
			generated_by: "cp-install",
			backend: "detached",
			node: input.node,
			app: input.app,
			home: input.home,
			path: unitPath(input.node, input.path),
			port: input.port,
			...("viewerHost" in extra ? { viewer_host: extra.viewerHost, parent_model: extra.parentModel } : {}),
		};
		for (const role of ["parent", "viewer", "health", "update"] as const) {
			const unit = parseUnit(units[unitFor[role]] as string);
			const env = childEnv(config, role, { ...base });
			const { HOME, USER, LOGNAME, CP_DAEMON_ROLE, CP_DAEMON_JOB, ...rest } = env;
			assert.deepEqual(rest, unit.env, `${role} env`);
			assert.deepEqual({ HOME, USER, LOGNAME }, base);
			assert.equal(CP_DAEMON_ROLE, role === "viewer" ? "viewer" : undefined);
			assert.equal(CP_DAEMON_JOB, role === "health" || role === "update" ? role : undefined);
			assert.deepEqual(childArgv(config, role), unit.argv, `${role} argv`);
		}
	}
	const config = validateDaemonConfig({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: "/n", app: "/a", home: "/h", path: "/bin", port: 1 });
	const leaked = childEnv(config, "parent", { HOME: "/home/u" });
	assert.equal("ANTHROPIC_API_KEY" in leaked, false);
});


test("the outer and inner import only node:* and ./daemon-*.ts, statically, and OUTER_SOURCES is daemon.ts's whole closure", () => {
	const importsOf = (name: string): string[] => {
		const source = readFileSync(join(SERVICE, name), "utf8");
		assert.doesNotMatch(source, /\bimport\s*\(/, `${name} uses a dynamic import`);
		return [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1] as string);
	};
	const closure = new Set<string>();
	const visit = (name: string): void => {
		if (closure.has(name)) return;
		closure.add(name);
		for (const spec of importsOf(name)) {
			if (spec.startsWith("node:")) continue;
			assert.match(spec, /^\.\/daemon(?:-[a-z]+)?\.ts$/, `${name} imports ${spec}`);
			visit(spec.slice(2));
		}
	};
	visit("daemon.ts");
	assert.deepEqual([...closure].sort(), [...OUTER_SOURCES].sort());
	// Remote dashboard PR 2: the inner may also read the node-only tunnel layout, which imports nothing else, and run the
	// cloudflared controller (PR 2c), whose only other import is the provisioner's fixed argv (node-only too).
	const inner = ["./daemon-files.ts", "./daemon-tunnel-files.ts", "./daemon-tunnel.ts"];
	for (const spec of importsOf("daemon-runtime.ts")) assert.ok(spec.startsWith("node:") || inner.includes(spec), `daemon-runtime.ts imports ${spec}`);
	for (const spec of importsOf("daemon-tunnel.ts")) assert.ok(spec.startsWith("node:") || spec === "./daemon-files.ts" || spec === "./daemon-tunnel-files.ts" || spec === "../tunnel/cloudflared.ts", `daemon-tunnel.ts imports ${spec}`);
	for (const spec of importsOf("../tunnel/cloudflared.ts")) assert.ok(spec.startsWith("node:") || spec === "../service/daemon-files.ts", `cloudflared.ts imports ${spec}`);
	for (const spec of importsOf("daemon-tunnel-files.ts")) assert.ok(spec.startsWith("node:"), `daemon-tunnel-files.ts imports ${spec}`);
});
