/**
 * Channel gateway config: `data/channels.json` (its presence starts the role) and the owner-only Slack token file it
 * names. Errors name a path, a mode or a field, never a token byte (docs/contracts.md, Channel gateway).
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export interface SlackConfig {
	token_file: string;
	team_id: string;
	user_ids: string[];
	/** Public or private channels where an @mention is accepted; DMs are always allowed. Shared channels never are. */
	channel_ids: string[];
	/** The dashboard origin links point at; absent: the viewer's public URL, else the live tunnel, else no link. */
	dashboard_url?: string;
}
export interface ChannelsConfig { slack: SlackConfig }
export interface SlackTokens { app: string; bot: string }

export const channelsConfigFile = (dataDir: string): string => join(dataDir, "channels.json");

const TEAM_RE = /^T[A-Z0-9]{2,20}$/;
const USER_RE = /^[UW][A-Z0-9]{2,20}$/;
const CHANNEL_RE = /^[CG][A-Z0-9]{2,20}$/;

/** Strict: unknown keys and the first bad field are named; an absent file says so. */
export function loadChannelsConfig(dataDir: string): ChannelsConfig {
	const file = channelsConfigFile(dataDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${file} is absent; the channel gateway runs only when it exists`);
		throw new Error(`${file} is unreadable: ${(error as Error).message}`);
	}
	const bad = (field: string, want: string): never => {
		throw new Error(`${file}: ${field} must be ${want}`);
	};
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("the file", "a JSON object");
	const top = raw as Record<string, unknown>;
	const extraTop = Object.keys(top).filter((key) => key !== "slack");
	if (extraTop.length) bad(extraTop.join(", "), "absent (the only key is slack)");
	const slack = top.slack as Record<string, unknown> | undefined;
	if (slack === null || typeof slack !== "object" || Array.isArray(slack)) bad("slack", "an object");
	const s = slack as Record<string, unknown>;
	const extra = Object.keys(s).filter((key) => !["token_file", "team_id", "user_ids", "channel_ids", "dashboard_url"].includes(key));
	if (extra.length) bad(`slack.${extra.join(", slack.")}`, "absent (unknown key)");
	if (typeof s.token_file !== "string" || !isAbsolute(s.token_file)) bad("slack.token_file", "an absolute path");
	if (typeof s.team_id !== "string" || !TEAM_RE.test(s.team_id)) bad("slack.team_id", "a Slack team id (T…)");
	if (!Array.isArray(s.user_ids) || s.user_ids.length < 1 || s.user_ids.length > 10 || !s.user_ids.every((id) => typeof id === "string" && USER_RE.test(id))) bad("slack.user_ids", "1-10 Slack user ids (U…)");
	const channels = s.channel_ids ?? [];
	if (!Array.isArray(channels) || channels.length > 20 || !channels.every((id) => typeof id === "string" && CHANNEL_RE.test(id))) bad("slack.channel_ids", "0-20 Slack channel ids (C… or G…)");
	if (s.dashboard_url !== undefined) {
		let url: URL | undefined;
		try { url = new URL(String(s.dashboard_url)); } catch { url = undefined; }
		const loopback = url?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if (!url || (url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) bad("slack.dashboard_url", "an https (or loopback http) origin with no credentials, query or fragment");
	}
	return {
		slack: {
			token_file: s.token_file as string,
			team_id: s.team_id as string,
			user_ids: [...(s.user_ids as string[])],
			channel_ids: [...(channels as string[])],
			...(s.dashboard_url !== undefined ? { dashboard_url: String(s.dashboard_url).replace(/\/+$/, "") } : {}),
		},
	};
}

/**
 * The app-level (`xapp-`) and bot (`xoxb-`) tokens: a regular file (no symlink) this user owns, mode no wider than
 * 0600, outside `runtimeRoot`, holding `SLACK_APP_TOKEN=…` and `SLACK_BOT_TOKEN=…` lines.
 */
export function readSlackTokens(file: string, runtimeRoot: string): SlackTokens {
	let stat;
	try {
		stat = lstatSync(file);
	} catch (error) {
		throw new Error(`token file ${file} is unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`);
	}
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`token file ${file} must be a regular file, not a symlink`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`token file ${file} is owned by uid ${stat.uid}, not this user`);
	if ((stat.mode & 0o077) !== 0) throw new Error(`token file ${file} is mode 0${(stat.mode & 0o777).toString(8)}; chmod 600 it (wider than 0600 is refused)`);
	const real = realpathSync(file);
	const root = realpathSync(runtimeRoot);
	if (real === root || real.startsWith(`${root}${sep}`)) throw new Error(`token file ${file} lies inside the CP runtime root ${root}; keep it outside`);
	const values = new Map<string, string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const match = /^\s*(SLACK_APP_TOKEN|SLACK_BOT_TOKEN)\s*=\s*(\S+)\s*$/.exec(line);
		if (match) values.set(match[1]!, match[2]!);
	}
	const app = values.get("SLACK_APP_TOKEN");
	const bot = values.get("SLACK_BOT_TOKEN");
	if (!app?.startsWith("xapp-")) throw new Error(`token file ${file} has no SLACK_APP_TOKEN line with an xapp- token`);
	if (!bot?.startsWith("xoxb-")) throw new Error(`token file ${file} has no SLACK_BOT_TOKEN line with an xoxb- token`);
	return { app, bot };
}
