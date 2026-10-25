import { type ChildProcess, spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { waitFor } from "./state.ts";

/** Screen text with CSI, OSC and APC/DCS sequences removed. */
export const stripTerminal = (text: string): string =>
	text.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[_P][^\x1b]*\x1b\\/g, "");

/** The Kitty CSI-u form of one key: what a Kitty-protocol terminal sends instead of the legacy byte. */
export const csiU = (codepoint: number, modifiers?: number): string =>
	modifiers === undefined ? `\x1b[${codepoint}u` : `\x1b[${codepoint};${modifiers}u`;

export interface Tui {
	/** Everything drawn so far, stripped. */
	screen(): string;
	/** Type `text`, press Enter, and return what is drawn after it once `until` holds. */
	run(text: string, until: (drawn: string) => boolean, what: string): Promise<string>;
	/** Send raw key bytes (no Enter) and return what is drawn after them once `until` holds. */
	press(keys: string, until: (drawn: string) => boolean, what: string): Promise<string>;
}

/**
 * pi's interactive TUI on a pty (util-linux `script`). `kitty: true` answers pi's keyboard-protocol query the way a
 * Kitty-protocol terminal does, so pi decodes CSI-u key sequences from then on.
 */
export function startTui(t: TestContext, cwd: string, env: NodeJS.ProcessEnv, args: string[], options: { kitty?: boolean; columns?: number; lines?: number } = {}): Tui {
	const command = ["pi", ...args].map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
	const child: ChildProcess = spawn("script", ["-qfec", command, "/dev/null"], {
		cwd,
		env: { ...process.env, ...env, TERM: "xterm-256color", COLUMNS: String(options.columns ?? 160), LINES: String(options.lines ?? 60) },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let raw = "";
	let answered = !options.kitty;
	const onData = (chunk: unknown) => {
		raw += String(chunk);
		if (!answered && raw.includes("\x1b[?u")) {
			answered = true;
			child.stdin?.write("\x1b[?1u");
		}
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	const exited = new Promise<void>((done) => child.once("exit", () => done()));
	t.after(async () => {
		child.kill("SIGTERM");
		await exited;
	});
	const screen = () => stripTerminal(raw);
	const press = async (keys: string, until: (drawn: string) => boolean, what: string) => {
		const mark = screen().length;
		child.stdin?.write(keys);
		return waitFor(() => screen().slice(mark), until, { timeoutMs: 30_000, what });
	};
	return {
		screen,
		press,
		async run(text, until, what) {
			const mark = screen().length;
			child.stdin?.write(text);
			await new Promise((done) => setTimeout(done, 400));
			child.stdin?.write("\r");
			return waitFor(() => screen().slice(mark), until, { timeoutMs: 30_000, what });
		},
	};
}
