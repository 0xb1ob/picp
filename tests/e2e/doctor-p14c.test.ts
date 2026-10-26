/**
 * Behavior 15 (P14c): `/doctor --json` and `/doctor` through real pi parents on scratch homes. Host tools are scripts
 * in a scratch bin dir (the only PATH), models come from pi's own registry (API keys and a scratch models.json), and
 * the package is a copy of this checkout, so its profiles and resources can be broken without touching it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import {
	DEFAULT_ORIGIN, type DoctorReport, EMPTY_USAGE, type FleetRecord, JOBS_SIZE_WARNING, LAYOUT, NEVER_COMMIT_PATHS, PARENT_BRIDGE_FLAGS,
	paths, SCHEMA_VERSION, THINKING_LEVELS, validateDoctorReport, type WorkerHandle,
} from "../../src/contracts.ts";
import { DETAIL_MAX, MAX_LINT_DETAIL, whichAll } from "../../src/doctor.ts";
import { FleetStore } from "../../src/fleet.ts";
import { daemonPaths, outerHash } from "../../src/service/daemon-files.ts";
import { controlConfigFile, controlRecordFile, controlSocketFile } from "../../src/viewer/control-files.ts";
import { viewerConfigFile } from "../../src/viewer/host-config.ts";
import { operatorWrapperPath } from "../../src/viewer/launchers.ts";
import { createAgentDir, createScratchHome, type PiChild, REPO_ROOT, startPiChild } from "../harness/index.ts";

type Finding = DoctorReport["findings"][number];
const REAL_PI = realpathSync(join(REPO_ROOT, "node_modules", ".bin", "pi"));
const PI_VERSION = execFileSync(process.execPath, [REAL_PI, "--version"], { encoding: "utf8" }).trim();
const NO_KEYS = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", CP_GATEWAY_ADMIN_KEY: "", CP_TREEHOUSE_ROOT: "" };
const KEYS = { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" };
const LENS = ["typescript-language-server", "ast-grep"];
const TOOLS = ["treehouse", "gh", "npm", "pgrep", "systemctl", "tmux", ...LENS];
const FOREIGN_FILE_TOOL = join(REPO_ROOT, "tests/fixtures/foreign-file-tool.ts");

let pkg = "";
before(() => {
	pkg = mkdtempSync(join(tmpdir(), "cp-p14c-pkg-"));
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8" });
	for (const file of files.split("\0").filter((entry) => entry && existsSync(join(REPO_ROOT, entry)))) cpSync(join(REPO_ROOT, file), join(pkg, file));
	symlinkSync(join(REPO_ROOT, "node_modules"), join(pkg, "node_modules"));
});
after(() => rmSync(pkg, { recursive: true, force: true }));

interface Box { path: string; dir: string; answer(name: string, text: string | undefined): void; calls(): string }

/**
 * A scratch bin dir that is the parent's whole PATH: node, git, `pi` (answers --version and pi's own capability probe,
 * else runs this checkout's pi) and `tools` stubs that answer from answers/<tool>.out|.err|.status and log their argv.
 */
function bin(t: TestContext, tools: readonly string[] = TOOLS, extraPath: string[] = []): Box {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14c-bin-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const answers = join(dir, "answers");
	mkdirSync(answers);
	symlinkSync(process.execPath, join(dir, "node"));
	if (!extraPath.length) symlinkSync(realpathSync(whichAll("git")[0]!), join(dir, "git"));
	const log = `echo "\${0##*/} $*" >> "${dir}/calls.log"`;
	const probe = JSON.stringify({ type: "response", id: "probe", success: true, data: { commands: [{ name: "cp-version", source: "extension" }] } });
	writeFileSync(join(dir, "pi"), `#!/bin/sh\n${log}\n[ "$1" = --version ] && { /bin/cat "${answers}/pi.version"; exit 0; }\ncase "$HOME" in */cp-pi-probe-*) read -r _; echo '${probe}'; exit 0;; esac\nexec "${REAL_PI}" "$@"\n`, { mode: 0o755 });
	writeFileSync(join(answers, "pi.version"), `${PI_VERSION}\n`);
	for (const tool of tools) {
		const body = tool === "pgrep"
			? `f="${answers}/pgrep-\${2##*/}"; [ -f "$f" ] && { /bin/cat "$f"; exit 0; }; exit 1`
			: `A="${answers}/${tool}"; [ "$1" = --version ] && { echo "${tool} 1.2.3"; exit 0; }\n[ -f "$A.err" ] && /bin/cat "$A.err" >&2\n[ -f "$A.out" ] && /bin/cat "$A.out"\nexit "$(/bin/cat "$A.status" 2>/dev/null || echo 0)"`;
		writeFileSync(join(dir, tool), `#!/bin/sh\n${log}\n${body}\n`, { mode: 0o755 });
	}
	return {
		path: [dir, ...extraPath].join(":"),
		dir,
		answer: (name, text) => (text === undefined ? rmSync(join(answers, name), { force: true }) : writeFileSync(join(answers, name), text)),
		calls: () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : ""),
	};
}

async function ask(child: PiChild, message: string, answer: (text: string) => boolean): Promise<string> {
	const from = child.records().length;
	child.send({ id: `d${from}`, type: "prompt", message });
	const hit = await child.waitFor((r) => child.records().indexOf(r) >= from && r.type === "extension_ui_request" && r.method === "notify" && answer(String(r.message)), 120_000);
	return String(hit.message);
}

interface Parent { home: string; child: PiChild; doctor(): Promise<DoctorReport>; text(): Promise<string> }

/** A parent on a fresh scratch home with this package's command-post extension; closed when the test ends. */
async function parent(t: TestContext, box: Box, o: { env?: NodeJS.ProcessEnv; models?: unknown; extensions?: string[]; bridge?: boolean } = {}): Promise<Parent> {
	const scratch = createScratchHome();
	const home = realpathSync(scratch.path);
	const agent = createAgentDir();
	if (o.models) writeFileSync(join(agent.path, "models.json"), JSON.stringify(o.models));
	const child = startPiChild({
		cwd: home,
		extensions: [join(pkg, "extensions/command-post/index.ts"), ...(o.extensions ?? [])],
		...(o.bridge ? { hermetic: false, extraArgs: [...PARENT_BRIDGE_FLAGS] } : {}),
		env: { ...agent.env, CP_HOME: home, CP_MODE: "multi", HOME: join(home, "user"), PI_HOME: join(home, "user", ".pi"), XDG_CONFIG_HOME: join(home, "xdg"), PATH: box.path, ...NO_KEYS, ...o.env },
	});
	t.after(async () => {
		await child.close();
		agent.cleanup();
		scratch.cleanup();
	});
	await ask(child, "/cp-version", (text) => text.startsWith("picp "));
	return {
		home,
		child,
		doctor: async () => JSON.parse(await ask(child, "/doctor --json", (text) => text.trimStart().startsWith("{"))) as DoctorReport,
		text: () => ask(child, "/doctor", (text) => text.startsWith("DOCTOR")),
	};
}

const all = (report: DoctorReport, check: string): Finding[] => report.findings.filter((f) => f.check === check);
const one = (report: DoctorReport, check: string): Finding | undefined => all(report, check)[0];
const put = (home: string, rel: string, text: string) => {
	mkdirSync(dirname(join(home, rel)), { recursive: true });
	writeFileSync(join(home, rel), text);
};
const jobs = (home: string, list: unknown[], prefix = "cp") => put(home, LAYOUT.jobsFile, JSON.stringify({ schema_version: SCHEMA_VERSION, prefix, jobs: list }));
const ROW = { id: "cp-a", title: "t", status: "open", labels: ["project:demo", "delivery:pr"], blocked_by: [], comments: [], created_at: "2026-08-27T11:00:00Z", updated_at: "2026-08-27T11:00:00Z" };
const projects = (home: string, names: string[]) => put(home, LAYOUT.projectsFile, JSON.stringify({ schema_version: SCHEMA_VERSION, updated_at: "2026-08-27T12:00:00Z",
	projects: names.map((name) => ({ name, clone_url: `git@example.com:acme/${name}.git`, delivery: "pr", registered_at: "2026-08-27T12:00:00Z" })) }));
const routing = (home: string, rubric: unknown[], allow = ["*/*"]) => put(home, LAYOUT.routingFile, JSON.stringify({ schema_version: SCHEMA_VERSION, allow, rubric }));
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const gitInit = (dir: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, "commit", "--allow-empty", "-qm", "x"], { env: { ...process.env, GIT_DIR: join(dir, ".git") }, stdio: "ignore" });
const repo = (dir: string) => {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	gitInit(dir);
};

function record(o: Partial<Omit<FleetRecord, "worker">> & { job_id: string; worker?: Partial<WorkerHandle> }): FleetRecord {
	const { worker, ...rest } = o;
	return { project: "demo", kind: "ship", delivery: "pr", origin: DEFAULT_ORIGIN, phase: "waiting", worktree: "/worktrees/gone", branch: o.job_id, dispatched_at: "2026-08-27T11:00:00Z",
		usage: EMPTY_USAGE, ...rest, worker: { pid: 4242, session_id: "s", session_file: "/sessions/gone.jsonl", profile: "implementer", role: "implementer",
			model: "anthropic/claude-sonnet-5", started_at: "2026-08-27T11:00:00Z", ...worker } } as FleetRecord;
}

test("P14-doctor-home: a healthy bridge-launched home is green with a fix on every other line, and each fault in its files is named", { timeout: 300_000 }, async (t) => {
	const p = await parent(t, bin(t), { env: KEYS, bridge: true });
	const h = p.home;
	const healthy = await p.doctor();
	assert.equal(healthy.ok, true, JSON.stringify(healthy.findings.filter((f) => f.severity === "error")));
	assert.deepEqual([healthy.counts.error, healthy.schema_version, validateDoctorReport(healthy).ok], [0, SCHEMA_VERSION, true]);
	for (const f of healthy.findings) if (f.severity !== "ok") assert.ok(f.fix, `${f.check} has no fix`);
	assert.deepEqual(["git", "treehouse", "pi", "gh"].map((tool) => one(healthy, `host.${tool}`)?.severity), ["ok", "ok", "ok", "ok"]);
	assert.match(one(healthy, "config.bounds.wall_clock")?.what ?? "", /5400s/);
	assert.match(one(healthy, "config.bounds.tool_call_cap")?.what ?? "", /900 starts/);
	assert.deepEqual([one(healthy, "session.tools")?.severity, one(healthy, "session.tools")?.what], ["ok", "no foreign tools"]);
	assert.equal(one(healthy, "pi-lens.tools")?.severity, "ok");
	assert.match(one(healthy, "mode")?.what ?? "", /^multi-project mode, home /);
	assert.equal(one(healthy, "home.exclude"), undefined, "exclude is a single-mode finding");
	assert.deepEqual(["package.worker_reporter", "package.profiles", "package.briefs"].map((c) => one(healthy, c)?.severity), ["ok", "ok", "ok"]);
	assert.deepEqual(all(healthy, "package.roles"), [], "three roles, one profile each");
	assert.deepEqual(["planner", "implementer", "gate-reviewer"].map((role) => one(healthy, `models.${role}`)?.severity), ["ok", "ok", "ok"]);
	assert.equal(one(healthy, "models.probe"), undefined, "a live parent probes pi's registry");
	assert.equal(one(healthy, "storage.retired_integration"), undefined);
	assert.equal(healthy.home, h);
	assert.match(JSON.stringify(one(healthy, "home.location")), /"ok","what":"home \(CP_HOME\): /);
	for (const key of ["data", "state", "projects"]) assert.equal(one(healthy, `scaffold.${key}`)?.severity, "ok", `${key}/ is scaffolded at session start`);

	// A scaffold dir removed after start is advisory, not broken.
	const projectsDir = join(h, LAYOUT.projects);
	rmSync(projectsDir, { recursive: true });
	const unscaffolded = await p.doctor();
	assert.deepEqual([one(unscaffolded, "scaffold.projects")?.severity, unscaffolded.ok], ["warn", true], "a home that has not run yet is not broken");
	mkdirSync(projectsDir);

	// parent.*: the compact threshold, the standing orders and the recorded context, read when doctor runs.
	for (const rel of [`${LAYOUT.data}/standing-orders.md`, `${LAYOUT.data}/parent.json`]) rmSync(join(h, rel), { force: true });
	const bare = await p.doctor();
	assert.equal(one(bare, "parent.standing_orders")?.severity, "warn");
	assert.match(one(bare, "parent.standing_orders")?.fix ?? "", /standing-orders\.md/);
	assert.match(one(bare, "parent.compact_threshold")?.what ?? "", /default 200000/);
	put(h, `${LAYOUT.data}/parent.json`, '{"compact_at_tokens":0}');
	assert.equal(one(await p.doctor(), "parent.compact_threshold")?.severity, "warn");
	put(h, `${LAYOUT.data}/parent.json`, '{"compact_at_tokens":150000}');
	put(h, `${LAYOUT.data}/standing-orders.md`, "# Standing orders\n");
	put(h, `${LAYOUT.sessions}/cp-parent-context.json`, JSON.stringify({ contextTokens: 42000, lastCompactAt: "2026-09-25T00:00:00Z", lastRotateAt: "2026-09-25T01:00:00Z" }));
	const parentLines = await p.doctor();
	assert.match(one(parentLines, "parent.compact_threshold")?.what ?? "", /150000/);
	assert.match(one(parentLines, "parent.context")?.what ?? "", /42000.*last compact.*last rotate/);
	assert.match(one(parentLines, "parent.standing_orders")?.what ?? "", /modified/);

	// The jobs document: missing, not JSON, off-contract, retired fields, broken ids and dependencies.
	rmSync(join(h, LAYOUT.jobsFile));
	const missing = one(await p.doctor(), "ledger.file");
	assert.equal(missing?.severity, "error");
	assert.match(missing?.fix ?? "", /start a pi session/);
	jobs(h, [ROW]);
	const sound = await p.doctor();
	assert.deepEqual([one(sound, "ledger.file")?.severity, one(sound, "ledger.file")?.what.match(/1 job\(s\), prefix cp/) !== null], ["ok", true]);
	assert.deepEqual(["ledger.ids", "ledger.deps", "ledger.prefix", "ledger.size"].map((c) => one(sound, c)?.severity), ["ok", "ok", "ok", "ok"]);
	put(h, LAYOUT.jobsFile, "{nope");
	assert.match(JSON.stringify(one(await p.doctor(), "ledger.file")), /"error".*not JSON/);
	jobs(h, [{ id: "cp-a" }]);
	const shape = one(await p.doctor(), "ledger.file");
	assert.deepEqual([shape?.severity, /\/jobs\/0/.test(shape?.detail ?? "")], ["error", true]);
	jobs(h, [{ ...ROW, type: "epic", priority: 2 }]);
	const retired = await p.doctor();
	assert.match(JSON.stringify(one(retired, "ledger.file")), /"ok".*1 job\(s\), prefix cp/);
	assert.deepEqual(["ledger.ids", "ledger.deps"].map((c) => one(retired, c)?.severity), ["ok", "ok"]);
	jobs(h, [ROW, ROW, { ...ROW, id: "zz-a" }, { ...ROW, id: "cp-b", blocked_by: ["cp-zzz", "cp-c"] }, { ...ROW, id: "cp-c", blocked_by: ["cp-b"] }]);
	const tangled = await p.doctor();
	assert.match(JSON.stringify(one(tangled, "ledger.ids")), /"error".*duplicate id cp-a.*zz-a does not carry this document's prefix cp-/);
	const deps = one(tangled, "ledger.deps");
	assert.equal(deps?.severity, "error");
	assert.match(deps?.detail ?? "", /unknown cp-zzz.*dependency cycle|dependency cycle.*unknown cp-zzz/);
	assert.match(deps?.fix ?? "", /cp_job dep_remove/);
	jobs(h, [ROW]);

	// Retired integration state: either file alone, malformed or not, is one existence-only warning.
	for (const rel of [`${LAYOUT.data}/trackers.json`, `${LAYOUT.state}/tracker-sync.json`]) {
		put(h, rel, "{nope");
		const f = one(await p.doctor(), "storage.retired_integration");
		assert.deepEqual([f?.severity, f?.detail], ["warn", rel]);
		assert.equal(f?.what, "Retired integration state is present and ignored. Native jobs and history remain available; automatic intake and write-back are disabled.");
		assert.equal(f?.fix, "Keep these files for your records. Ask the operator to configure any external workflow explicitly in home standing orders.");
		rmSync(join(h, rel));
	}

	// Config files: invalid routing and budgets, the gate timeout, an empty allowlist and the per-job budget clamp.
	assert.equal(one(sound, "config.routing")?.severity, "ok");
	put(h, LAYOUT.routingFile, JSON.stringify({ schema_version: 1, allow: "everything" }));
	put(h, LAYOUT.budgetsFile, "{ nope");
	const badConfig = await p.doctor();
	assert.match(JSON.stringify(one(badConfig, "config.routing")), /"error".*routing\.json/);
	assert.deepEqual([one(badConfig, "config.budgets")?.severity, badConfig.ok], ["error", false]);
	rmSync(join(h, LAYOUT.budgetsFile));
	rmSync(join(h, LAYOUT.gateConfigFile), { force: true });
	routing(h, [], []);
	const gateless = await p.doctor();
	assert.match(JSON.stringify(one(gateless, "config.routing.allow")), /"warn".*no model may be used/);
	assert.match(JSON.stringify(one(gateless, "config.gate")), /"ok".*no \.pi-command-post\/data\/gate\.json/);
	assert.match(one(gateless, "config.gate.review_timeout_ms")?.what ?? "", /300000ms \(default\)/);
	rmSync(join(h, LAYOUT.routingFile));
	put(h, LAYOUT.gateConfigFile, JSON.stringify({ schema_version: 1, review_timeout_ms: 60_000 }));
	const gated = await p.doctor();
	assert.equal(one(gated, "config.gate")?.severity, "ok");
	assert.match(one(gated, "config.gate.review_timeout_ms")?.what ?? "", /^(?!.*default).*60000ms/);
	put(h, LAYOUT.gateConfigFile, JSON.stringify({ schema_version: 1, review_timeout_ms: 0 }));
	assert.match(JSON.stringify(one(await p.doctor(), "config.gate")), /"error","what":"\.pi-command-post\/data\/gate\.json is invalid".*fix or remove /);
	rmSync(join(h, LAYOUT.gateConfigFile));
	const budgets = (tokens: number, cost: number) => put(h, LAYOUT.budgetsFile, JSON.stringify({ schema_version: 1, per_job_tokens: tokens, per_job_cost_usd: cost, warn_ratio: 0.8, spawn_cap: 10 }));
	budgets(100_000_000, 100);
	assert.match(JSON.stringify(one(await p.doctor(), "config.budget.implementer")), /"ok".*not clamped/);
	budgets(1_000, 1);
	const clamped = await p.doctor();
	const clamp = one(clamped, "config.budget.implementer");
	assert.match(clamp?.what ?? "", /clamped by the fleet ceiling to 1000 tokens/);
	assert.deepEqual([clamp?.severity, /clamped on: tokens/.test(clamp?.detail ?? ""), /data\/budgets\.json/.test(clamp?.fix ?? ""), clamped.ok], ["warn", true, true, true]);
	rmSync(join(h, LAYOUT.budgetsFile));

	// The home's .gitignore must list the runtime root.
	put(h, ".gitignore", ".pi-command-post/\n");
	assert.equal(one(await p.doctor(), "home.gitignore")?.severity, "ok");
	put(h, ".gitignore", "/data/*\nstate/\nprojects/\n");
	assert.match(JSON.stringify(one(await p.doctor(), "home.gitignore")), /"warn".*\.pi-command-post\//);
	put(h, ".gitignore", "node_modules/\n");
	const ignore = one(await p.doctor(), "home.gitignore");
	assert.equal(ignore?.severity, "warn");
	for (const entry of NEVER_COMMIT_PATHS) assert.ok((ignore?.what ?? "").includes(entry), `${entry} is not demanded: ${ignore?.what}`);
});

test("P14-doctor-fleet: fleet records, the parent lock, the worktree pool, the viewer, dashboard control and leftover units", { timeout: 300_000 }, async (t) => {
	const box = bin(t);
	const p = await parent(t, box, { env: KEYS, extensions: [FOREIGN_FILE_TOOL, NETWORK_TOOL] });
	const h = p.home;
	const first = await p.doctor();
	const foreign = one(first, "session.tools");
	assert.match(foreign?.what ?? "", /^2 foreign tool\(s\); .*outside guard coverage/);
	assert.match(foreign?.detail ?? "", /lens_read \(file_read, outside guard coverage\)/);
	assert.match(foreign?.detail ?? "", /fetch_content \(network\)/);
	assert.match(foreign?.fix ?? "", /^warn only .*--no-extensions/);
	assert.deepEqual([foreign?.severity, first.ok], ["warn", true], "a foreign tool is advisory, never an error");
	assert.equal(one(first, "fleet.file")?.what, "fleet: 0 record(s)");

	// Fleet consistency is read-only: a corrupt file, then dead workers, a vanished worktree and a missing run dir.
	const fleetFile = join(h, LAYOUT.fleetFile);
	writeFileSync(fleetFile, "{ truncated");
	assert.match(JSON.stringify(one(await p.doctor(), "fleet.file")), /"error".*still in the jobs document and in state\/runs/);
	rmSync(fleetFile);
	const fleet = new FleetStore({ home: h });
	put(h, "session.jsonl", "{}\n");
	await fleet.add(record({ job_id: "cp-dead", worker: { pid: deadPid(), session_file: join(h, "session.jsonl") } }));
	mkdirSync(join(h, paths.runDir("cp-dead")), { recursive: true });
	await fleet.add(record({ job_id: "cp-noruns", worker: { pid: deadPid() } }));
	const wrecked = await p.doctor();
	const workers = all(wrecked, "fleet.worker");
	const dead = workers.find((f) => f.what.includes("cp-dead"));
	assert.deepEqual([workers.length, dead?.severity], [2, "warn"], "doctor reports; reconcile is what changes a phase");
	assert.match(dead?.detail ?? "", /session survives/);
	assert.match(dead?.fix ?? "", /cp_revive cp-dead/);
	assert.match(workers.find((f) => f.what.includes("cp-noruns"))?.fix ?? "", /re-dispatch or tear/);
	assert.deepEqual(all(wrecked, "fleet.run_dir").map((f) => /cp-noruns/.test(f.what)), [true], "only the job with no run directory");
	assert.deepEqual(all(wrecked, "fleet.worktree").map((f) => /--force/.test(f.fix ?? "")), [true, true], "both point at a worktree that is gone");
	assert.equal(wrecked.ok, true, "a wrecked fleet is recoverable, so it is not an error");
	rmSync(fleetFile);
	await fleet.add({ ...record({ job_id: "cp-script", delivery: "local" }), worker: undefined, executor: "script", script_path: "scripts/verify.sh",
		script_process: { pid: 4242, started_at: "2026-08-27T12:00:00Z", exited_at: "2026-08-27T12:00:00Z", exit_code: 0 } } as unknown as FleetRecord);
	mkdirSync(join(h, paths.runDir("cp-script")), { recursive: true });
	const script = await p.doctor();
	assert.match(one(script, "fleet.worker")?.what ?? "", /cp-script script scripts\/verify\.sh \(pid 4242\): exited .* \(0\)/);
	assert.equal(all(script, "fleet.worktree").length, 1, "a script job's worktree is still checked");
	rmSync(fleetFile);
	mkdirSync(join(h, "worktree"));
	await fleet.add(record({ job_id: "cp-live", worktree: join(h, "worktree"), worker: { pid: process.pid } }));
	await fleet.add(record({ job_id: "cp-done", phase: "done", closed_at: "2026-08-27T11:30:00Z", reported_at: "2026-08-27T11:20:00Z", worker: { exited_at: "2026-08-27T11:30:00Z" } }));
	for (const id of ["cp-live", "cp-done"]) mkdirSync(join(h, paths.runDir(id)), { recursive: true });
	const quiet = await p.doctor();
	assert.deepEqual([all(quiet, "fleet.worker"), all(quiet, "fleet.worktree"), one(quiet, "fleet.file")?.what], [[], [], "fleet: 2 record(s)"]);

	// One parent per home: this session's own lock, a live foreign holder, a stale one, junk, and none.
	const lock = join(h, LAYOUT.parentLock);
	const mine = readFileSync(lock, "utf8");
	assert.match(JSON.stringify(one(quiet, "parent.lock")), /"ok".*held by this session/);
	const other = spawn("sleep", ["60"]);
	t.after(() => other.kill("SIGKILL"));
	const holder = (pid: number) => writeFileSync(lock, `${JSON.stringify({ schema_version: SCHEMA_VERSION, pid, started_at: "2026-08-27T11:00:00Z", home: h })}\n`);
	holder(other.pid!);
	const live = one(await p.doctor(), "parent.lock");
	assert.match(live?.what ?? "", new RegExp(`another parent process holds this home \\(pid ${other.pid}\\)`));
	assert.deepEqual([live?.severity, /one parent per home/.test(live?.fix ?? "")], ["warn", true]);
	const gone = deadPid();
	holder(gone);
	const stale = one(await p.doctor(), "parent.lock");
	assert.match(stale?.what ?? "", new RegExp(`stale parent lock: pid ${gone} is not alive`));
	assert.deepEqual([stale?.severity, /session_start reclaims it/.test(stale?.fix ?? "")], ["warn", true]);
	writeFileSync(lock, "not json at all\n");
	const junk = one(await p.doctor(), "parent.lock");
	assert.deepEqual([junk?.severity, /rm /.test(junk?.fix ?? "")], ["warn", true]);
	rmSync(lock);
	assert.match(JSON.stringify(one(await p.doctor(), "parent.lock")), /"ok".*no parent lock/);
	writeFileSync(lock, mine);

	// The worktree pool, from treehouse's own answer: ours, foreign (named, bounded) and the questions it could not ask.
	assert.deepEqual(first.findings.filter((f) => f.check.startsWith("pool.")), [], "no registry: silent");
	const clone = join(h, LAYOUT.projects, "demo");
	repo(clone);
	projects(h, ["demo"]);
	const ours = join(h, "pool", "1", "demo");
	execFileSync("git", ["-C", clone, "worktree", "add", "-q", "--detach", ours]);
	const elsewhere = join(h, "elsewhere");
	repo(elsewhere);
	const pool = (list: string[]) => box.answer("treehouse.out", JSON.stringify(list.map((path) => ({ path }))));
	pool([ours]);
	assert.match(JSON.stringify(one(await p.doctor(), "pool.demo")), /"ok".*all this home's clone/);
	pool([ours, elsewhere]);
	const mixed = one(await p.doctor(), "pool.demo");
	assert.match(mixed?.what ?? "", /1 worktree\(s\) in demo's pool belong to another clone/);
	assert.ok(mixed?.detail?.includes(`${elsewhere} -> ${elsewhere}/.git`), mixed?.detail);
	assert.deepEqual([mixed?.severity, /CP_TREEHOUSE_ROOT/.test(mixed?.fix ?? "")], ["warn", true]);
	const twenty = Array.from({ length: 20 }, (_, i) => join(h, "pool", `f${i}`, "x".repeat(60)));
	for (const dir of twenty) repo(dir);
	pool(twenty);
	const crowded = one(await p.doctor(), "pool.demo");
	assert.match(crowded?.what ?? "", /20 worktree\(s\) in demo's pool/);
	assert.ok((crowded?.detail?.length ?? 0) > 1000 && (crowded?.detail?.length ?? 0) <= DETAIL_MAX, `detail is ${crowded?.detail?.length} chars`);
	assert.match(crowded?.detail ?? "", /\(\+\d+ more\) \(expected git-common-dir /);
	for (const out of ["[]", "not json", undefined]) {
		box.answer("treehouse.out", out);
		assert.deepEqual(all(await p.doctor(), "pool.demo"), [], `expected silence for ${out}`);
	}
	pool([ours]);
	box.answer("treehouse.status", "1");
	assert.deepEqual(all(await p.doctor(), "pool.demo"), [], "a failing treehouse is silent");
	assert.match(box.calls(), /^treehouse status --json$/m, "no pool root configured: no --root");
	assert.doesNotMatch(box.calls(), /--root/);

	// The session viewer by command line, the dashboard-control and viewer-host lines.
	box.answer("pgrep-cli.ts", "4321\n");
	assert.match(JSON.stringify(one(await p.doctor(), "viewer")), /"ok".*pid 4321/);
	box.answer("pgrep-cli.ts", undefined);
	const idle = await p.doctor();
	assert.deepEqual([one(idle, "viewer")?.severity, one(idle, "viewer")?.fix], ["ok", undefined], "no operator session: information");
	assert.match(one(idle, "viewer")?.what ?? "", /not running \(no operator session up; bin\/cp-operator starts it\)/);
	const stateDir = join(h, LAYOUT.state);
	const control = all(idle, "dashboard-control");
	assert.deepEqual([control.length, control[0]?.severity], [1, "ok"]);
	assert.match(control[0]?.what ?? "", /^dashboard control: on \(on by default \(no data\/dashboard-control\.json\); no operator session serving it/);
	assert.doesNotMatch(JSON.stringify(control), /allowlist|login|device|user|node/i);
	assert.deepEqual(all(idle, "viewer-host").map((f) => [f.severity, f.what]), [["ok", "viewer Host check off (viewer.strict_host=false): any name that reaches this port is served; set viewer.strict_host=true to pin it"]]);
	box.answer("pgrep-operator.ts", "99\n");
	mkdirSync(dirname(controlRecordFile(stateDir)), { recursive: true });
	writeFileSync(controlRecordFile(stateDir), JSON.stringify({ version: 1, pid: process.pid, socket: controlSocketFile(stateDir), token: "a".repeat(64), csrf: "b".repeat(64), started_at: "2026-09-27T08:00:00Z" }));
	const operator = await p.doctor();
	const orphan = one(operator, "viewer");
	assert.match(orphan?.fix ?? "", /tailscale ip -4.*bin\/cp-operator/);
	assert.match(orphan?.fix ?? "", /CP_VIEWER_HOST/, "a pinned host is named too");
	assert.deepEqual([orphan?.severity, operator.ok], ["warn", true], "the viewer is optional");
	assert.match(one(operator, "dashboard-control")?.what ?? "", new RegExp(`operator session pid ${process.pid} serving .*dashboard\\.sock`));
	mkdirSync(dirname(controlConfigFile(stateDir)), { recursive: true });
	writeFileSync(controlConfigFile(stateDir), '{"enabled": false}');
	assert.deepEqual(all(await p.doctor(), "dashboard-control").map((f) => [f.severity, f.what]), [["ok", "dashboard control: off (data/dashboard-control.json has enabled:false)"]]);
	writeFileSync(controlConfigFile(stateDir), "{not json");
	const invalid = await p.doctor();
	assert.match(JSON.stringify(one(invalid, "dashboard-control")), /"warn","what":"dashboard control: off \(.*unreadable.*remove it/);
	assert.equal(all(invalid, "viewer").length, 1, "the viewer finding is unchanged");
	const viewerFile = viewerConfigFile(stateDir);
	mkdirSync(dirname(viewerFile), { recursive: true });
	writeFileSync(viewerFile, '{"strict_host": true}');
	assert.match(one(await p.doctor(), "viewer-host")?.what ?? "", /^viewer Host check on \(viewer\.strict_host=true\)/);
	writeFileSync(viewerFile, '{"strict_host": "yes"}');
	assert.match(JSON.stringify(one(await p.doctor(), "viewer-host")), /"warn".*remove it/);

	// cp-txbb: a cp-daemon home with the legacy units left over still produces a valid report.
	const unitDir = join(h, "xdg", "systemd/user");
	mkdirSync(unitDir, { recursive: true });
	const units = ["cp-parent.service", "cp-view.service", "cp-health.service", "cp-health.timer", "cp-update.service", "cp-update.timer", "cp-operator.service"];
	for (const name of units) writeFileSync(join(unitDir, name), `ExecStart="${process.execPath}" x\n`);
	const daemon = daemonPaths(h);
	writeFileSync(daemon.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "systemd", node: process.execPath, app: h, home: h, path: "/bin", port: 7300 }));
	box.answer("systemctl.out", "active\n");
	const leftover = await p.doctor();
	assert.ok(validateDoctorReport(leftover).ok, "the report stays on contract");
	const legacy = one(leftover, "service.legacy_units");
	assert.deepEqual([legacy?.severity, legacy?.what], ["warn", `6 legacy unit(s) in ${unitDir}`]);
	for (const name of units.slice(0, 6)) assert.ok(legacy?.detail?.includes(name), `${name} in ${legacy?.detail}`);
	assert.deepEqual([one(leftover, "service.daemon")?.severity, one(leftover, "service.node")?.what], ["ok", "the node binary cp-daemon runs exists"]);
});

// A second foreign tool: network-capable by name, with no file parameter.
const NETWORK_TOOL = join(mkdtempSync(join(tmpdir(), "cp-p14c-tool-")), "network-tool.ts");
writeFileSync(NETWORK_TOOL, `export default function (pi) {
	pi.registerTool({ name: "fetch_content", label: "Fetch", description: "Fetch a URL (fixture)", parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: "x" }], details: {} }; } });
}\n`);
after(() => rmSync(dirname(NETWORK_TOOL), { recursive: true, force: true }));

test("P14-doctor-host: PATH decides the host lines — a missing tool, pi-lens prerequisites, shims, a conflict held at the bound, and the human report", { timeout: 300_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14c-path-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = (...parts: string[]) => {
		mkdirSync(join(root, ...parts), { recursive: true });
		return join(root, ...parts);
	};
	// git once, through a usrmerge-style symlinked dir; a non-executable treehouse; two pi shims of one build.
	const usrBin = dir("usr-bin");
	symlinkSync(realpathSync(whichAll("git")[0]!), join(usrBin, "git"));
	symlinkSync(usrBin, join(root, "bin"));
	writeFileSync(join(dir("plain"), "treehouse"), "#!/bin/sh\necho treehouse 1.0.0\n");
	const shims = ["a", "b"].map((name) => dir("shims", name));
	for (const shim of shims) writeFileSync(join(shim, "pi"), `#!/bin/sh\necho "${PI_VERSION}"\n`, { mode: 0o755 });
	// Five gh installs of different versions under ~450-char dirs: their conflict detail outgrows the contract bound.
	const ghs = Array.from({ length: 5 }, (_, i) => dir(`g${i}`, "p".repeat(220), "q".repeat(220)));
	for (const [i, gh] of ghs.entries()) writeFileSync(join(gh, "gh"), `#!/bin/sh\necho "gh 0.${i}.0"\n`, { mode: 0o755 });
	const box = bin(t, ["npm", "pgrep", "systemctl", "tmux"], [usrBin, join(root, "bin"), join(root, "plain"), ...shims, ...ghs]);
	const p = await parent(t, box, { env: { ...KEYS, CP_LEDGER_PREFIX: "cps" } });
	const report = await p.doctor();
	const treehouse = one(report, "host.treehouse");
	assert.deepEqual([treehouse?.severity, /only from treehouse/.test(treehouse?.fix ?? ""), report.ok], ["error", true, false]);
	assert.equal(one(report, "host.git")?.detail, join(usrBin, "git"), "one file through a symlinked PATH dir is counted once");
	assert.equal(one(report, "host.pi")?.detail, `${join(box.dir, "pi")} (+2 more on PATH)`, "every match, in PATH order");
	assert.equal(one(report, "host.pi.conflict"), undefined, "identical shims are not a conflict");
	const lens = one(report, "pi-lens.tools");
	assert.deepEqual([lens?.severity, lens?.fix], ["warn", "npm i -g typescript-language-server@5.3.0 typescript @ast-grep/cli"]);
	assert.match(lens?.what ?? "", /typescript-language-server, ast-grep/);
	const conflict = one(report, "host.gh.conflict");
	assert.deepEqual([conflict?.severity, conflict?.detail?.length], ["error", DETAIL_MAX], "a 2300-char detail is held at the contract bound");

	// ledger.prefix and ledger.size: the environment's prefix disagrees with the document, which outgrew the cap.
	jobs(p.home, Array.from({ length: JOBS_SIZE_WARNING + 1 }, (_, i) => ({ ...ROW, id: `cp-${i.toString(36).padStart(4, "0")}` })));
	const ledger = await p.doctor();
	assert.match(JSON.stringify(one(ledger, "ledger.prefix")), /"warn".*CP_LEDGER_PREFIX=cps but the document mints cp-/);
	assert.match(JSON.stringify(one(ledger, "ledger.size")), new RegExp(`"warn".*${JOBS_SIZE_WARNING + 1} jobs`));

	// The human report leads with what is broken and ends with the verdict, before the session lines.
	const text = await p.text();
	assert.match(text, /^DOCTOR BROKEN/);
	assert.ok(text.indexOf("✗") < text.indexOf("✓"), "errors come before the green rows");
	assert.match(text, /cannot dispatch until the errors above are fixed\n\n/);
});

test("P14-doctor-drift: a newer host pi warns host.pi.drift until a qualify PR is open, names unreadable npm and gh answers, and the pool asks --root", { timeout: 300_000 }, async (t) => {
	const second = realpathSync(mkdtempSync(join(tmpdir(), "cp-p14c-pi2-")));
	t.after(() => rmSync(second, { recursive: true, force: true }));
	writeFileSync(join(second, "pi"), `#!/bin/sh\necho "${PI_VERSION}"\n`, { mode: 0o755 });
	const box = bin(t, TOOLS);
	box.answer("pi.version", "1.9.9\n");
	box.path = `${box.path}:${second}`;
	const p = await parent(t, box, { env: { ...KEYS, CP_TREEHOUSE_ROOT: "/pools/home-b" } });
	const released = JSON.stringify({ "1.9.9": new Date(Date.now() - 20 * 86_400_000).toISOString() });
	const drift = async () => all(await p.doctor(), "host.pi.drift");
	box.answer("npm.out", released);
	box.answer("gh.out", "[]");
	const first = await p.doctor();
	assert.match(JSON.stringify(one(first, "host.pi.conflict")), /"error","what":"2 different pi versions on PATH"/);
	const warned = all(first, "host.pi.drift");
	assert.deepEqual([warned.length, warned[0]?.severity, warned[0]?.detail], [1, "warn", undefined]);
	assert.match(warned[0]?.what ?? "", /1\.9\.9.*above the tested/);
	box.answer("gh.out", JSON.stringify([{ title: "qualify pi 1.9.9", url: "https://example.test/pull/1" }]));
	assert.deepEqual(await drift(), [], "an open qualify PR silences it");
	box.answer("gh.out", "[]");
	for (const answer of ["npm warn rate limited", ""]) {
		box.answer("npm.out", answer);
		const found = await drift();
		assert.deepEqual([found.length, found[0]?.severity], [1, "warn"]);
		assert.match(found[0]?.detail ?? "", /^npm view .*time --json: /);
	}
	box.answer("npm.out", released);
	box.answer("gh.out", undefined);
	box.answer("gh.status", "1");
	box.answer("gh.err", "gh: To get started with GitHub CLI, run: gh auth login");
	const unknown = (await drift()).find((f) => f.what.includes("unknown"));
	assert.match(unknown?.detail ?? "", /^gh pr list .*: exit 1; stdout: \(empty\); stderr: gh: To get started with GitHub CLI/);
	for (const name of ["gh.status", "gh.err"]) box.answer(name, undefined);
	box.answer("gh.out", "[]");
	assert.equal((await drift()).some((f) => f.what.includes("unknown")), false, "gh answered: no unknown line");

	// CP_TREEHOUSE_ROOT reaches treehouse: the pool asked is the one the leases come from.
	repo(join(p.home, LAYOUT.projects, "demo"));
	projects(p.home, ["demo"]);
	await p.doctor();
	assert.match(box.calls(), /^treehouse --root \/pools\/home-b status --json$/m);
});

/** models.json: a `mock` provider with auth whose models serve every effort, or only the listed ones. */
const mockModels = (models: Record<string, readonly string[] | "all">) => ({ providers: { mock: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "k",
	models: Object.entries(models).map(([id, levels]) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(levels === "all" ? {} : { thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, levels.includes(level) ? level : null])) }) })) } } });

/** A name at the contract's limit: project names run to 64 characters. */
const longName = (prefix: string, index: number) => `${prefix}-${"x".repeat(64 - prefix.length - 1 - `${index}`.padStart(2, "0").length)}${`${index}`.padStart(2, "0")}`;

/** A bounded list names some entries and counts the rest: the two must add up. */
function selfCounting(text: string, entry: RegExp, total: number): boolean {
	const shown = (text.match(entry) ?? []).length;
	return shown <= MAX_LINT_DETAIL && shown + Number(/\(\+(\d+) more\)/.exec(text)?.[1] ?? "0") === total;
}

test("P14-doctor-models: pi's registry decides each route — no auth fails loudly, one provider is a named fallback, and every rubric row is resolved", { timeout: 600_000 }, async (t) => {
	const box = bin(t);
	const roles = ["planner", "implementer", "gate-reviewer"] as const;
	const none = await (await parent(t, box)).doctor();
	for (const role of roles) assert.deepEqual([one(none, `models.${role}`)?.severity, /pi auth/.test(one(none, `models.${role}`)?.fix ?? "")], ["error", true], role);
	const planner = one(none, "models.planner");
	assert.match(planner?.detail ?? "", /no usable model.*every candidate for profile planner was refused/);
	for (const candidate of ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"]) assert.ok(planner?.detail?.includes(`${candidate} (availability)`), `${candidate} must be named`);
	assert.equal(none.ok, false);
	const openai = await (await parent(t, box, { env: { OPENAI_API_KEY: "sk-test" } })).doctor();
	for (const who of [...roles, "qa"]) assert.match(JSON.stringify(one(openai, `models.${who}`)), /"ok","what":"[^"]*openai\/[^"]*fallback from anthropic\//, who);

	const p = await parent(t, box, { env: KEYS, models: mockModels({ shared: "all", plan: "all", capped: ["off", "minimal", "low", "medium"] }) });
	const h = p.home;
	const green = await p.doctor();
	assert.deepEqual([...roles.map((role) => one(green, `models.${role}`)?.severity), green.ok], ["ok", "ok", "ok", true]);

	// A project-scoped row and an L-only row are really resolved, against the registered projects and the whole grid.
	projects(h, ["web", "api"]);
	routing(h, [{ id: "web-ship", role: "implementer", project: "web", model: "pinned/only-for-web" }, { id: "big-ship", role: "implementer", scope: ["L"], model: "pinned/only-for-big-jobs" }]);
	const scoped = await p.doctor();
	const web = one(scoped, "models.implementer.web");
	assert.deepEqual([web?.severity, /implementer in web/.test(web?.what ?? ""), /pinned\/only-for-web/.test(web?.detail ?? ""), /routing\.json/.test(web?.fix ?? "")], ["error", true, true, true]);
	assert.deepEqual([all(scoped, "models.implementer.api"), all(scoped, "models.planner.web"), all(scoped, "models.rubric")], [[], [], []]);
	const big = all(scoped, "models.implementer").find((f) => f.detail?.includes("pinned/only-for-big-jobs"));
	assert.deepEqual([big?.severity, /scope\/risk: L\/low, L\/high/.test(big?.detail ?? "")], ["error", true]);
	assert.ok(all(scoped, "models.implementer").some((f) => f.severity === "ok" && f.detail?.includes("S/low")), "S/low still routes to a reachable model");
	routing(h, [{ id: "risky-ship", role: "implementer", risk: "high", model: "pinned/only-for-risky" }]);
	const grid = await p.doctor();
	const implementer = all(grid, "models.implementer");
	assert.deepEqual(implementer.map((f) => f.severity).sort(), ["error", "ok"], "one ok row and one error row");
	assert.match(implementer.find((f) => f.severity === "ok")?.detail ?? "", /scope\/risk: S\/low, M\/low, L\/low/);
	assert.match(implementer.find((f) => f.severity === "error")?.detail ?? "", /scope\/risk: S\/high, M\/high, L\/high.*pinned\/only-for-risky|pinned\/only-for-risky.*scope\/risk: S\/high, M\/high, L\/high/);
	assert.equal(all(grid, "models.planner").length, 1, "six identical answers are one finding");

	// Two projects routed to one model by two rows: both named when it is unreachable, one shared row when it is not.
	projects(h, ["web", "mobile", "api"]);
	const shared = (model: string) => routing(h, ["web", "mobile"].map((name) => ({ id: `${name}-ship`, role: "implementer", project: name, model })));
	shared("pinned/shared");
	const split = (await p.doctor()).findings.filter((f) => f.check.startsWith("models.implementer."));
	assert.deepEqual(split.map((f) => [f.check, f.severity, /pinned\/shared/.test(f.detail ?? "")]).sort(), [["models.implementer.mobile", "error", true], ["models.implementer.web", "error", true]]);
	assert.match(split.find((f) => f.check.endsWith(".web"))?.what ?? "", /implementer in web:/);
	shared("mock/shared");
	const joined = await p.doctor();
	const one_ = joined.findings.filter((f) => f.check.startsWith("models.implementer."));
	assert.deepEqual([one_.length, one_[0]?.severity, /implementer in web, mobile: mock\/shared/.test(one_[0]?.what ?? ""), /scope\/risk: S\/low/.test(one_[0]?.detail ?? "")], [1, "ok", true, true]);
	assert.deepEqual([all(joined, "models.implementer.api"), all(joined, "models.rubric")], [[], []]);

	// The allowlist and the effort gates name their own fix, never `pi auth`; a duplicate id is a load refusal.
	projects(h, ["web"]);
	routing(h, [{ id: "web-ship", role: "implementer", project: "web", model: "forbidden/model" }], ["anthropic/*", "openai/*"]);
	const allowed = await p.doctor();
	const refused = one(allowed, "models.implementer.web");
	assert.match(refused?.what ?? "", /implementer in web: model refused by the allowlist/);
	assert.match(refused?.detail ?? "", /rubric web-ship names forbidden\/model, which the allowlist refuses/);
	assert.deepEqual([refused?.severity, /add a pattern that covers it/.test(refused?.fix ?? ""), /pi auth/.test(refused?.fix ?? ""), all(allowed, "models.rubric")], ["error", true, false, []]);
	routing(h, [{ id: "ship", role: "implementer", model: "mock/capped", thinking: "xhigh" }]);
	const effort = await p.doctor();
	const unserved = one(effort, "models.implementer");
	assert.match(unserved?.what ?? "", /effort the model cannot serve/);
	assert.deepEqual([unserved?.severity, /name an effort level this model serves/.test(unserved?.fix ?? ""), /pi auth/.test(unserved?.fix ?? ""), all(effort, "models.rubric")], ["error", true, false, []]);
	routing(h, [{ id: "ship", role: "implementer", scope: ["S"], model: "mock/plan" }, { id: "ship", role: "implementer", scope: ["L"], model: "mock/shared" }]);
	const duplicate = await p.doctor();
	assert.match(JSON.stringify(one(duplicate, "config.routing")), /"error".*duplicate rubric id.*rubric\[0\] -> mock\/plan.*rubric\[1\] -> mock\/shared/);
	assert.deepEqual([all(duplicate, "models.implementer"), duplicate.ok], [[], false], "a config that cannot load is not re-diagnosed as a model problem");

	// config.routing.effort: rubric rows and profiles asking for a level the model lacks; unknown metadata is no proof.
	const gate = join(pkg, "profiles", "gate-reviewer.md");
	const original = readFileSync(gate, "utf8");
	t.after(() => writeFileSync(gate, original));
	writeFileSync(gate, original.replace("model: anthropic/claude-opus-5-5", "model: mock/capped"));
	routing(h, [{ id: "risky-ship", role: "implementer", risk: "high", model: "mock/capped", thinking: "xhigh" }]);
	const drift = one(await p.doctor(), "config.routing.effort");
	assert.match(drift?.what ?? "", /configured model\/effort pair\(s\)/);
	assert.match(drift?.detail ?? "", /rubric row risky-ship asks for thinking=xhigh on mock\/capped.*available: off, minimal, low, medium/);
	assert.match(drift?.detail ?? "", /profile gate-reviewer asks for thinking=high on mock\/capped/);
	assert.deepEqual([drift?.severity, /never substitutes/.test(drift?.fix ?? "")], ["error", true]);
	writeFileSync(gate, original);
	routing(h, [{ id: "risky-ship", role: "implementer", risk: "high", model: "pinned/unknown", thinking: "xhigh" }]);
	assert.equal(one(await p.doctor(), "config.routing.effort")?.severity, "ok", "a model pi has no metadata for is never called unsupported");

	// Shadowing: only a row an earlier row covers entirely is dead.
	routing(h, [{ id: "all-ship", role: "implementer", model: "mock/shared" }, { id: "dead-ship", role: "implementer", scope: ["L"], risk: "high", model: "mock/plan" }]);
	const shadow = one(await p.doctor(), "config.routing.shadowed");
	assert.match(shadow?.what ?? "", /1 rubric row\(s\) can never fire/);
	assert.match(shadow?.detail ?? "", /dead-ship \(rubric\[1\]\) <- all-ship \(rubric\[0\]\)/);
	assert.deepEqual([shadow?.severity, /nothing here reorders/.test(shadow?.fix ?? "")], ["warn", true]);
	routing(h, [{ id: "web-ship", role: "implementer", project: "web", scope: ["S"], model: "mock/shared" }, { id: "api-ship", role: "implementer", project: "api", scope: ["S"], model: "mock/shared" },
		{ id: "small-ship", role: "implementer", scope: ["S"], model: "mock/plan" }, { id: "most-ship", role: "implementer", scope: ["S", "M"], model: "mock/shared" },
		{ id: "planning", role: "planner", scope: ["S"], model: "mock/shared" }]);
	assert.deepEqual(all(await p.doctor(), "config.routing.shadowed"), [], "partial or per-project overlap is never a full shadow");

	// Over every bound: 14 long project names on one shared row, 14 unexercised rows and 14 dead ones.
	const names = Array.from({ length: 14 }, (_, i) => longName("proj", i + 1));
	projects(h, names);
	routing(h, [...names.map((name, i) => ({ id: longName("row", i + 1), role: "implementer", project: name, model: "mock/shared" })),
		...Array.from({ length: 14 }, (_, i) => ({ id: longName("unreached", i + 1), role: "implementer", project: "never-registered", model: "mock/nowhere" })),
		{ id: "planning", role: "planner", model: "mock/plan" },
		...Array.from({ length: 14 }, (_, i) => ({ id: longName("dead", i + 1), role: "planner", scope: ["L"], risk: "high", model: "mock/never" }))]);
	const bounded = await p.doctor();
	assert.ok(validateDoctorReport(bounded).ok);
	for (const f of bounded.findings) assert.ok(f.check.length <= 64 && f.what.length <= 200 && (f.detail ?? "").length <= 2000 && (f.fix ?? "").length <= 500, `over a bound: ${f.check}`);
	const wide = bounded.findings.filter((f) => f.check.startsWith("models.implementer."));
	assert.deepEqual([wide.length, selfCounting(wide[0]?.what ?? "", /proj-/g, 14)], [1, true], wide[0]?.what);
	const unexercised = one(bounded, "models.rubric");
	assert.deepEqual([unexercised?.severity, /28 rubric row\(s\) were not exercised/.test(unexercised?.what ?? ""), selfCounting(unexercised?.detail ?? "", /-> /g, 28)], ["warn", true, true]);
	const dead = one(bounded, "config.routing.shadowed");
	assert.deepEqual([dead?.severity, /27 rubric row\(s\) can never fire/.test(dead?.what ?? ""), selfCounting(dead?.detail ?? "", / <- /g, 27)], ["warn", true, true]);
});

test("P14-doctor-package: the package's profiles and resources — newer profiles, pi-lens deactivated, a greedy profile budget, and none at all", { timeout: 300_000 }, async (t) => {
	t.after(() => {
		cpSync(join(REPO_ROOT, "profiles"), join(pkg, "profiles"), { recursive: true });
		cpSync(join(REPO_ROOT, "extensions/worker-reporter"), join(pkg, "extensions/worker-reporter"), { recursive: true });
	});
	const profiles = join(pkg, "profiles");
	for (const name of ["implementer", "planner", "qa", "ops", "gate-reviewer"]) utimesSync(join(profiles, `${name}.md`), new Date(0), new Date(0));
	const p = await parent(t, bin(t, TOOLS.filter((tool) => !LENS.includes(tool))), { env: KEYS });
	const first = await p.doctor();
	assert.deepEqual([all(first, "package.profiles_newer"), one(first, "pi-lens.tools")?.severity], [[], "warn"]);
	const implementer = join(profiles, "implementer.md");
	const original = readFileSync(implementer, "utf8");
	writeFileSync(implementer, original.replace("role: implementer", "role: implementer\npackages: []"));
	const future = new Date(Date.now() + 60_000);
	utimesSync(implementer, future, future);
	const touched = await p.doctor();
	const newer = one(touched, "package.profiles_newer");
	assert.match(newer?.what ?? "", /profiles newer than the loaded code/);
	assert.deepEqual([newer?.severity, /implementer\.md/.test(newer?.detail ?? ""), /restart the parent/.test(newer?.fix ?? "")], ["warn", true, true]);
	assert.deepEqual(all(touched, "pi-lens.tools"), [], "an implementer without pi-lens needs none of its tools");
	writeFileSync(implementer, original.replace(/budget: \{[^}]*\}/, "budget: { tokens: 999000000, cost_usd: 999 }"));
	rmSync(join(p.home, LAYOUT.budgetsFile), { force: true });
	assert.match(JSON.stringify(one(await p.doctor(), "config.budget.implementer")), /"warn".*clamped by the fleet ceiling/);
	rmSync(profiles, { recursive: true });
	rmSync(join(pkg, "extensions/worker-reporter"), { recursive: true });
	const empty = await p.doctor();
	assert.equal(one(empty, "package.worker_reporter")?.severity, "error");
	assert.deepEqual(all(empty, "package.roles").map((f) => [f.severity, /no profile for role/.test(f.what)]), [["error", true], ["error", true], ["error", true]]);
	assert.equal(empty.ok, false);
});

test("P14-doctor-daemon: service.daemon is silent uninstalled, then names a stopped daemon, a failed parent or sender and a stale outer", { timeout: 300_000 }, async (t) => {
	for (const dir of ["profiles", "extensions/worker-reporter"]) cpSync(join(REPO_ROOT, dir), join(pkg, dir), { recursive: true });
	const box = bin(t);
	const p = await parent(t, box, { env: KEYS });
	const daemon = daemonPaths(p.home);
	for (const dir of [daemon.dataDir, daemon.stateDir]) mkdirSync(dir, { recursive: true });
	const bare = await p.doctor();
	assert.deepEqual([all(bare, "service.daemon"), all(bare, "service.legacy_units")], [[], []], "nothing installed is silent");
	assert.match(one(bare, "viewer")?.what ?? "", /not running \(no operator session up/, "no viewer is expected");

	const unitDir = join(p.home, "xdg", "systemd/user");
	mkdirSync(unitDir, { recursive: true });
	writeFileSync(join(unitDir, "cp-parent.service"), "# Generated by cp-install (pi-command-post); edits are refused on reinstall without --force.\n");
	const legacy = all(await p.doctor(), "service.legacy_units");
	assert.deepEqual(legacy.map((f) => [f.severity, /rerun cp-install/.test(f.fix ?? "")]), [["warn", true]]);
	rmSync(join(unitDir, "cp-parent.service"));

	// A detached config with no lock: not running, and its viewer is now expected.
	const config = { schema_version: 1, generated_by: "cp-install", node: "/n", app: pkg, home: p.home, path: "/bin", port: 7300 };
	writeFileSync(daemon.config, JSON.stringify({ ...config, backend: "detached" }));
	const stopped = await p.doctor();
	assert.deepEqual(all(stopped, "service.daemon").map((f) => [f.severity, f.what]), [["warn", "cp-daemon is not running (detached backend)"]]);
	assert.match(one(stopped, "service.daemon")?.fix ?? "", /^start it: "\/n" ".*\/src\/service\/daemon\.ts" start --home ".*"; then cp-daemon status$/);
	assert.match(one(stopped, "viewer")?.what ?? "", /should run the viewer, but none is running/);

	// systemd says active: a ready runtime on the hash of the code on disk is ok; a held viewer is not missing.
	writeFileSync(daemon.config, JSON.stringify({ ...config, backend: "systemd" }));
	box.answer("systemctl.out", "active\n");
	const healthy = { pid: 4242, outer_hash: outerHash(join(pkg, "src/service")), inner: { state: "ready" } };
	writeFileSync(daemon.state, JSON.stringify(healthy));
	const runtime = (units: object) => writeFileSync(daemon.runtime, JSON.stringify({ units: { parent: { state: "running" }, viewer: { state: "running" }, ...units } }));
	runtime({ viewer: { state: "held" } });
	const ok = await p.doctor();
	assert.deepEqual([one(ok, "service.daemon")?.severity, one(ok, "viewer")?.severity], ["ok", "ok"]);
	runtime({ parent: { state: "failed", result: "start-limit-hit" } });
	assert.match(one(await p.doctor(), "service.daemon")?.what ?? "", /parent supervisor is failed \(start-limit-hit\) — a crash loop/);
	runtime({ parent: { state: "failed", result: "exit-code" } });
	const noModel = one(await p.doctor(), "service.daemon");
	assert.match(noModel?.what ?? "", /no parent model \(exit 78\)/);
	assert.match(noModel?.fix ?? "", /Settings.*read-only unless an operator session.*cp-daemon reload.*cp-install --parent-model <provider\/model> --force.*cp_parent start/);
	runtime({ "device-notify": { state: "failed", result: "start-limit-hit" } });
	const sender = one(await p.doctor(), "service.daemon");
	assert.deepEqual([sender?.severity, sender?.what.endsWith("is failed (start-limit-hit); new pairings still show on every dashboard, but no push goes out")], ["warn", true]);
	runtime({ "device-notify": { state: "running" } });
	assert.equal(one(await p.doctor(), "service.daemon")?.severity, "ok", "a running sender is fine");
	writeFileSync(daemon.state, JSON.stringify({ ...healthy, outer_hash: "0".repeat(64) }));
	const stale = one(await p.doctor(), "service.daemon");
	assert.deepEqual([stale?.severity, /predates the code on disk/.test(stale?.what ?? ""), /cp-daemon restart/.test(stale?.fix ?? "")], ["warn", true, true]);
});

test("P14-doctor-service: service.legacy_units, service.health and service.launchers, and every service finding fits the report", { timeout: 300_000 }, async (t) => {
	const box = bin(t);
	const p = await parent(t, box, { env: KEYS });
	const unitDir = join(p.home, "xdg", "systemd/user");
	mkdirSync(unitDir, { recursive: true });
	const health = (at: number, checks: object = {}) => put(p.home, `${LAYOUT.state}/health.json`, JSON.stringify({ schema_version: 1, last_run_at: new Date(at).toISOString(), checks }));
	const launchers = async () => one(await p.doctor(), "service.launchers")?.what;
	assert.equal(one(await p.doctor(), "service.health"), undefined, "nothing installed, never ran: no line");

	// Four legacy units (the cp-operator.service is no legacy unit) warn with a short summary; the timer never ran.
	for (const name of ["cp-parent.service", "cp-view.service", "cp-health.service", "cp-health.timer", "cp-operator.service"]) {
		writeFileSync(join(unitDir, name), `ExecStart="${process.execPath}" x\n`);
	}
	const legacy = await p.doctor();
	assert.deepEqual([one(legacy, "service.legacy_units")?.severity, one(legacy, "service.legacy_units")?.what], ["warn", `4 legacy unit(s) in ${unitDir}`]);
	assert.equal(one(legacy, "service.legacy_units")?.detail, "cp-parent.service, cp-view.service, cp-health.service, cp-health.timer");
	assert.equal(one(legacy, "service.node")?.severity, "ok");
	assert.equal(one(legacy, "service.health")?.severity, "warn", "timer installed, never ran");
	// service.health: the last run, what fails, and a stale watchdog.
	health(Date.now() - 5 * 60_000);
	assert.deepEqual(one(await p.doctor(), "service.health"), { check: "service.health", severity: "ok", what: "health last ran 5 min ago: all ok" });
	health(Date.now() - 5 * 60_000, { disk: { status: "fail", detail: "3 GiB free" } });
	assert.match(one(await p.doctor(), "service.health")?.what ?? "", /failing: disk \(3 GiB free\)/);
	health(Date.now() - 70 * 60_000);
	assert.match(one(await p.doctor(), "service.health")?.fix ?? "", /not running every 5 min: cp-daemon status/);

	// Launchers: tmux needs cp-daemon, tmux on the viewer's PATH and the wrapper; herdr runs only when on PATH.
	const wrapper = operatorWrapperPath({ HOME: join(p.home, "user") });
	mkdirSync(dirname(wrapper), { recursive: true });
	writeFileSync(wrapper, "#!/bin/sh\n");
	assert.equal(await launchers(), "tmux no, herdr binary no, herdr server running no", "tmux and the wrapper, no cp-daemon: no");
	assert.doesNotMatch(box.calls(), /herdr/, "no herdr on PATH: never run");
	const viewerBin = join(p.home, "viewer-bin");
	mkdirSync(viewerBin);
	const daemon = daemonPaths(p.home);
	mkdirSync(daemon.dataDir, { recursive: true });
	writeFileSync(daemon.config, JSON.stringify({ schema_version: 1, generated_by: "cp-install", backend: "detached", node: process.execPath, app: pkg, home: p.home, path: viewerBin, port: 4000 }));
	assert.match(await launchers() ?? "", /^tmux no,/, "tmux only on the caller's PATH: the viewer cannot launch it");
	writeFileSync(join(viewerBin, "tmux"), "");
	writeFileSync(join(box.dir, "herdr"), `#!/bin/sh\necho "$0 $*" >> "${box.dir}/calls.log"\n/bin/cat "${box.dir}/answers/herdr.out"\n`, { mode: 0o755 });
	box.answer("herdr.out", '{"running":true}');
	assert.equal(await launchers(), "tmux yes, herdr binary yes, herdr server running yes");
	assert.match(box.calls(), new RegExp(`^${box.dir}/herdr status server --json$`, "m"), "the absolute herdr, fixed argv");
	box.answer("herdr.out", '{"running":false}');
	assert.equal(await launchers(), "tmux yes, herdr binary yes, herdr server running no");
	rmSync(wrapper);
	assert.match(await launchers() ?? "", /^tmux no,/, "no wrapper: no tmux");

	// Maximal inputs — all seven legacy units on a gone node, a failed runtime, 300-character details, a legacy home —
	// still make a report the schema accepts, for each update record.
	const long = "x".repeat(300);
	for (const name of ["cp-update.service", "cp-update.timer"]) writeFileSync(join(unitDir, name), `ExecStart="${join(p.home, "gone", "node")}" x\n`);
	mkdirSync(join(p.home, "user", ".pi", "command-post", ".pi-command-post"), { recursive: true });
	mkdirSync(daemon.stateDir, { recursive: true });
	writeFileSync(daemon.runtime, JSON.stringify({ units: { parent: { state: "failed", result: "start-limit-hit" }, viewer: { state: "failed" } } }));
	health(Date.now() - 70 * 60_000, Object.fromEntries(["parent", "viewer", "supervisor", "disk", "git", "gh", "update", "relay"].map((name) => [name, { status: "fail", detail: long }])));
	const seen = new Set<string>();
	const config = readFileSync(daemon.config, "utf8");
	const updates = [{ phase: "rolling_back", last_result: "rollback_failed", to: "a".repeat(40), detail: long }, { phase: "idle", last_result: "rollback_failed", detail: long },
		{ phase: "idle", last_result: "failed", to: "b".repeat(40), detail: long }, { phase: "idle", last_result: "failed", detail: long },
		{ phase: "idle", last_result: "skipped_busy", since: "2026-09-20T00:00:00Z", behind: 99, detail: long }, "{not json"];
	// Each record under an answering and a refusing ("no user manager") systemctl, with and without data/daemon.json.
	for (const manager of [["active\n", undefined, undefined], [undefined, "1", "Failed to connect to bus: no user manager"]]) {
		for (const [i, ext] of ["out", "status", "err"].entries()) box.answer(`systemctl.${ext}`, manager[i]);
		for (const withConfig of [true, false]) {
			if (withConfig) writeFileSync(daemon.config, config);
			else rmSync(daemon.config, { force: true });
			for (const update of updates) {
				put(p.home, `${LAYOUT.state}/update.json`, typeof update === "string" ? update : JSON.stringify({ schema_version: 1, last_run_at: new Date().toISOString(), ...update }));
				const report = await p.doctor();
				for (const finding of report.findings) if (finding.check.startsWith("service.")) seen.add(finding.check);
				const valid = validateDoctorReport(report);
				assert.ok(valid.ok, `${manager[2] ?? "active"} ${withConfig} ${JSON.stringify(update).slice(0, 60)}: ${valid.ok ? "" : valid.errors.join("; ")}`);
			}
		}
	}
	assert.deepEqual([...seen].sort(), ["service.daemon", "service.health", "service.launchers", "service.legacy_home", "service.legacy_units", "service.node", "service.update"]);
});
