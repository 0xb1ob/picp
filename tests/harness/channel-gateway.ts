/**
 * The channel gateway e2e fixture: a 0600 (or `tokenMode`) token file outside the home with fake values, then the real
 * role entry as a child pointed at the fake Slack. Teardown SIGTERMs that child and removes the token dir.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { layoutForHome } from "../../src/contracts.ts";
import type { FakeSlack } from "./fake-slack.ts";
import { REPO_ROOT } from "./index.ts";

export const TEAM = "T0CG1";
export const USER = "U0CG1";
export const DM = "D0CG1";
export const CHANNEL = "C0CG1";
export const BOT = "U0CGBOT";
export const DASHBOARD = "https://cp.example.test";
/** Shaped like Slack's tokens, too short for any SECRET_PATTERNS entry. */
export const APP_TOKEN = "xapp-cgfake";
export const BOT_TOKEN = "xoxb-cgfake";
const ENTRY = join(REPO_ROOT, "src/channels/gateway.ts");

type Json = Record<string, any>;

export async function startGateway(t: TestContext, home: string, slack: FakeSlack, options: { tokenMode?: number; config?: boolean } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "cp-cg-tokens-"));
	const tokenFile = join(dir, "slack.env");
	writeFileSync(tokenFile, Object.entries({ SLACK_APP_TOKEN: APP_TOKEN, SLACK_BOT_TOKEN: BOT_TOKEN }).map(([name, value]) => `${name}=${value}\n`).join(""), { mode: 0o600 });
	chmodSync(tokenFile, options.tokenMode ?? 0o600);
	const layout = layoutForHome("multi", home);
	const data = join(home, layout.data);
	const state = join(home, layout.state);
	mkdirSync(data, { recursive: true });
	if (options.config !== false) writeFileSync(join(data, "channels.json"), JSON.stringify({ slack: { token_file: tokenFile, team_id: TEAM, user_ids: [USER], channel_ids: [CHANNEL], dashboard_url: DASHBOARD } }));
	let output = "";
	const child: ChildProcess = spawn(process.execPath, [ENTRY], { env: { ...process.env, CP_HOME: home, CP_MODE: "multi", CP_CHANNELS_SLACK_API: slack.url }, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout!.on("data", (chunk) => { output += String(chunk); });
	child.stderr!.on("data", (chunk) => { output += String(chunk); });
	const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
	const stop = async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await exited;
	};
	t.after(async () => {
		await stop();
		rmSync(dir, { recursive: true, force: true });
	});
	const lines = (file: string): Json[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json) : [];
	return {
		tokenFile,
		exited,
		stop,
		log: () => output,
		journal: () => lines(join(state, "channels", "journal.jsonl")),
		outbox: (): Json => JSON.parse(readFileSync(join(state, "channels", "outbox.json"), "utf8")) as Json,
		bindings: () => lines(join(state, "operator", "turn-bindings.jsonl")),
	};
}
