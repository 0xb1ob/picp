/**
 * Tool install manifest — the single list `doctor.ts` diagnoses and
 * `install-tools.ts` acts on.
 *
 * `REQUIRED_TOOLS` used to be declared inline in `src/doctor.ts`. It now lives
 * here and `doctor.ts` imports it, so there is exactly one array: a tool added
 * to one without the other is impossible, not just disciplined. `TOOL_INSTALL`
 * is typed as `Record<RequiredTool, ToolInstallSpec>`, so adding a tool to
 * `REQUIRED_TOOLS` without adding its install spec here is a **typecheck
 * failure**, not a silent gap — that is the drift guarantee, and
 * `tests/tool-manifest.test.ts` pins it further (identity, not just value
 * equality, against what `doctor.ts` sees).
 *
 */

export const REQUIRED_TOOLS = ["git", "treehouse", "pi", "gh"] as const;
export type RequiredTool = (typeof REQUIRED_TOOLS)[number];

/** How the script actually gets a tool onto PATH. No shell strings hidden in prose. */
export type InstallStep =
	| { kind: "brew"; formula: string }
	| { kind: "npm"; pkg: string; flags?: readonly string[] }
	| { kind: "curl"; url: string }
	/** No automated path here (usually: needs sudo, or the platform varies too much to guess). */
	| { kind: "manual"; summary: string };

export interface ToolInstallSpec {
	tool: RequiredTool;
	/** One source install-tools.ts recognises, per platform it supports. */
	macos: InstallStep;
	linux: InstallStep;
}

/**
 * One source per tool, taken from each project's own published quick-install
 * (not guessed): treehouse ships a `curl | sh` one-liner that detects the
 * platform itself; pi is `npm install -g`, matching this repo's own README
 * requirement. git is the one case with no single cross-distro command —
 * Homebrew on macOS, and "not automated" on Linux, because every route there
 * needs sudo and this script does not run sudo silently.
 */
export const TOOL_INSTALL: Readonly<Record<RequiredTool, ToolInstallSpec>> = Object.freeze({
	git: {
		tool: "git",
		macos: { kind: "brew", formula: "git" },
		linux: {
			kind: "manual",
			summary:
				"install git with your distro's package manager (e.g. `sudo apt-get install -y git`) — " +
				"this needs sudo, so it is not run automatically",
		},
	},
	treehouse: {
		tool: "treehouse",
		macos: { kind: "curl", url: "https://kunchenguid.github.io/treehouse/install.sh" },
		linux: { kind: "curl", url: "https://kunchenguid.github.io/treehouse/install.sh" },
	},
	pi: {
		tool: "pi",
		macos: { kind: "npm", pkg: "@earendil-works/pi-coding-agent", flags: ["-g", "--ignore-scripts"] },
		linux: { kind: "npm", pkg: "@earendil-works/pi-coding-agent", flags: ["-g", "--ignore-scripts"] },
	},
	/**
	 * cp-vk1 made `gh` load-bearing (the merge receipt is what `gh pr view`
	 * reported) and cp-uug made it structural: `cp_integrate` asks `gh` about the
	 * PR, the CI runs and the merge itself. Undeclared, its absence surfaced as a
	 * confusing refusal deep inside a merge instead of as a `/doctor` finding.
	 */
	gh: {
		tool: "gh",
		macos: { kind: "brew", formula: "gh" },
		linux: {
			kind: "manual",
			summary:
				"install the GitHub CLI from https://github.com/cli/cli/blob/trunk/docs/install_linux.md — " +
				"every route needs sudo, so it is not run automatically",
		},
	},
});

/** The one place doctor's `fix` text should point an operator. */
export function installScriptHint(tool: RequiredTool): string {
	return `node scripts/install-tools.ts ${tool}`;
}

/**
 * Optional host tools (P2i): doctor reports them as optional (never a warning),
 * and `src/service/install.ts` reports them and never fails on them. br has no
 * install method verifiable from `br --help` or this repo, so none is run: the
 * installer prints `install` instead of guessing a URL.
 */
export const OPTIONAL_TOOLS = ["br", "tmux"] as const;
export type OptionalTool = (typeof OPTIONAL_TOOLS)[number];
export const OPTIONAL_TOOL_INFO: Readonly<Record<OptionalTool, { why: string; install: string }>> = Object.freeze({
	br: { why: "only beads-backed projects need the beads CLI", install: "install br (beads_rust) with the method its own repository README documents; no URL is guessed or run here" },
	tmux: { why: "only a remote operator seat uses it (ssh or tmux onto the session)", install: "install tmux with your package manager (e.g. `sudo apt-get install -y tmux`, `brew install tmux`); sudo is never run here" },
});

/** pi-lens's host tools (`npm i -g`): doctor checks `commands`, the installer installs `packages`. */
export const PI_LENS_TOOLS = Object.freeze({
	commands: Object.freeze(["typescript-language-server", "ast-grep"]) as readonly string[],
	packages: Object.freeze(["typescript-language-server@5.3.0", "typescript", "@ast-grep/cli"]) as readonly string[],
});
