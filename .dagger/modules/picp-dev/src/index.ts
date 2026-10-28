import { dag, Workspace, Directory, Container, File, object, func, check } from "@dagger.io/dagger"

const NODE_IMAGE = "node:24-bookworm"
const SOURCE_EXCLUDE = [
  "node_modules", "**/node_modules", ".git", ".pi-command-post", "state", "dist", "**/*.log", ".dagger", "dagger.toml",
  "dagger.lock",
]
// Fixed dates keep the synthetic commit (and every check after it) keyed on file content alone.
const FIXED_DATE = "2000-01-01T00:00:00Z"

/** The checks of .github/workflows/ci.yml, run in containers with per-step caching. */
@object()
export class PicpDev {
  source: Directory
  deps: Directory
  gitMeta: Directory
  manifest: File

  constructor(ws: Workspace) {
    this.source = ws.directory("/", { gitignore: true, exclude: SOURCE_EXCLUDE })
    this.deps = ws.directory("/", { include: ["package.json", "package-lock.json"] })
    this.gitMeta = ws.git().directory()
    this.manifest = ws.file("src/tool-manifest.ts")
  }

  /** Node 24 as the non-root `node` user, with `npm ci` keyed on package.json + package-lock.json only. */
  @func()
  base(): Container {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withUser("node")
      .withEnvVariable("CI", "true")
      .withMountedCache("/home/node/.npm", dag.cacheVolume("picp-npm"), { owner: "node:node" })
      .withDirectory("/app", this.deps, { owner: "node:node" })
      .withWorkdir("/app")
      .withExec(["npm", "ci", "--no-audit", "--no-fund"])
  }

  /** The installed tree plus the source, committed into a throwaway repo for `git ls-files` users. */
  @func()
  withSource(ctr?: Container): Container {
    return (ctr ?? this.base())
      .withDirectory("/app", this.source, { owner: "node:node" })
      .withEnvVariable("GIT_AUTHOR_DATE", FIXED_DATE)
      .withEnvVariable("GIT_COMMITTER_DATE", FIXED_DATE)
      .withExec(["sh", "-c", "git init -q && git add -A && git -c user.name=ci -c user.email=ci@local commit -qm src"])
  }

  /** npm run check:retired-integration */
  @func()
  @check()
  async retiredIntegration(): Promise<void> {
    await this.withSource().withExec(["npm", "run", "check:retired-integration"]).sync()
  }

  /** node scripts/test-migration-check.ts, against this workspace's real HEAD history. */
  @func()
  @check()
  async migrationLedger(): Promise<void> {
    // shortcut: ws.git().directory() is not byte-stable at beta.21 (pack names, logs), so this step never caches;
    // upgrade when the snapshot becomes content-addressed.
    await this.base()
      .withDirectory("/app", this.source, { owner: "node:node" })
      .withDirectory("/app/.git", this.gitMeta, { owner: "node:node" })
      .withExec(["node", "scripts/test-migration-check.ts"])
      .sync()
  }

  /** npm run check:shards */
  @func()
  @check()
  async checkShards(): Promise<void> {
    await this.withSource().withExec(["npm", "run", "check:shards"]).sync()
  }

  /** npm run typecheck */
  @func()
  @check()
  async typecheck(): Promise<void> {
    await this.withSource().withExec(["npm", "run", "typecheck"]).sync()
  }

  /** npm run eval:check (offline; CP_EVAL_LIVE is never set) */
  @func()
  @check()
  async evalCheck(): Promise<void> {
    await this.withSource().withExec(["npm", "run", "eval:check"]).sync()
  }

  /** node scripts/build-viewer.ts into a throwaway home. */
  @func()
  @check()
  async buildViewer(): Promise<void> {
    await this.withSource().withExec(["node", "scripts/build-viewer.ts", "--home", "/tmp/cp-home"]).sync()
  }

  /** Every static check at once; each stays cached on its own. */
  @func()
  @check()
  async checkAll(): Promise<void> {
    await Promise.all([
      this.retiredIntegration(), this.migrationLedger(), this.checkShards(),
      this.typecheck(), this.evalCheck(), this.buildViewer(),
    ])
  }

  /** One CI test shard (1..8) as `node`, with the pinned treehouse on PATH. Not a check: run one at a time. */
  @func()
  async testShard(shard: number): Promise<void> {
    if (!Number.isInteger(shard) || shard < 1 || shard > 8) throw new Error(`shard must be 1..8, got ${shard}`)
    // Treehouse goes in before the source so a source edit never re-downloads it.
    const ctr = this.withSource(await this.withTreehouse(this.base()))
    await ctr
      .withEnvVariable("CP_TEST_SHARD", String(shard))
      .withEnvVariable("CP_LIVE_TESTS", "")
      .withEnvVariable("NODE_OPTIONS", "--max-old-space-size=4096 --report-on-fatalerror --report-directory=/tmp/cp-node-reports")
      .withExec(["mkdir", "-p", "/tmp/cp-node-reports"])
      .withExec(["npm", "run", "test:shard"])
      .sync()
  }

  /** Treehouse at the version pinned in src/tool-manifest.ts, so this layer never drifts from the manifest. */
  async withTreehouse(ctr: Container): Promise<Container> {
    const text = await this.manifest.contents()
    const pin = /TREEHOUSE_RELEASE[^=]*=\s*\{[^}]*repo:\s*"([^"]+)",\s*version:\s*"([^"]+)"/.exec(text)
    if (!pin) throw new Error("TREEHOUSE_RELEASE not found in src/tool-manifest.ts")
    const [, repo, version] = pin
    const url = `https://github.com/${repo}/releases/download/v${version}/treehouse-v${version}-linux-$(dpkg --print-architecture).tar.gz`
    return ctr
      .withExec(["sh", "-c", `mkdir -p /home/node/.local/bin && curl -fsSL "${url}" | tar -xz -C /home/node/.local/bin`])
      .withEnvVariable("PATH", "/home/node/.local/bin:${PATH}", { expand: true })
      .withExec(["treehouse", "--version"])
  }
}
