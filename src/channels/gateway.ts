/**
 * The cp-daemon `channel-gateway` role entry (run only while `data/channels.json` exists): one outbound Socket Mode
 * connection, the inbound router and the outbound sweep. A bad config or token file exits 78; tokens are never logged.
 */
import { chmodSync, mkdirSync, realpathSync as entryRealpath } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath as entryPath } from "node:url";
import { configureLayout } from "../contracts.ts";
import { EscalationStore } from "../escalation.ts";
import { OperatorAsks } from "../operator-asks.ts";
import { acquireSenderLease, startDeviceNotifyLoop } from "../push/device-notify.ts";
import { daemonPaths, EXIT_CONFIG, pidAlive, psArgs, sameProcess } from "../service/daemon-files.ts";
import { controlRequest } from "../viewer/control-api.ts";
import { publicUrl } from "../viewer/host-config.ts";
import { liveTunnelOrigin } from "../viewer/remote-runtime.ts";
import { type ChannelsConfig, loadChannelsConfig, readSlackTokens, type SlackTokens } from "./config.ts";
import { handleEnvelope } from "./inbound.ts";
import { ChannelOutbound, type GatewayContext } from "./outbound.ts";
import { SlackApi, slackApiBase } from "./slack-api.ts";
import { runSocketMode } from "./socket-mode.ts";
import { ChannelStore, channelsStateDir } from "./store.ts";

/** The `ps` needle that tells this gateway from a reused pid. */
export const CHANNEL_GATEWAY_NEEDLE = "channels/gateway.ts";
export const CHANNEL_SWEEP_MS = 500;
export const channelGatewayLeaseFile = (stateDir: string): string => join(channelsStateDir(stateDir), "gateway.lock");

// Not import.meta.main: that is node 24.2+, and engines admits every 24.x (#375).
if (process.argv[1] !== undefined && (() => { try { return entryRealpath(process.argv[1]) === entryPath(import.meta.url); } catch { return false; } })()) {
	let last = "";
	const log = (line: string): void => {
		if (line === last) return;
		last = line;
		process.stderr.write(`${new Date().toISOString()} cp-daemon channel-gateway[${process.pid}]: ${line}\n`);
	};
	const home = process.env.CP_HOME;
	if (!home) {
		log(`CP_HOME is not set; exiting ${EXIT_CONFIG}`);
		process.exit(EXIT_CONFIG);
	}
	const paths = daemonPaths(home);
	let config: ChannelsConfig;
	let tokens: SlackTokens;
	let base: string;
	try {
		config = loadChannelsConfig(paths.dataDir);
		tokens = readSlackTokens(config.slack.token_file, dirname(paths.dataDir));
		base = slackApiBase(process.env);
	} catch (error) {
		// The messages name paths, modes and fields only: never a token.
		log(`refusing to start: ${(error as Error).message}; exiting ${EXIT_CONFIG}`);
		process.exit(EXIT_CONFIG);
	}
	configureLayout("multi", home);
	const dir = channelsStateDir(paths.stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const lease = acquireSenderLease(paths.stateDir, process.pid, (pid) => sameProcess(pid, CHANNEL_GATEWAY_NEEDLE, { alive: pidAlive, argsOf: psArgs }), channelGatewayLeaseFile(paths.stateDir));
	if (!lease.ok) {
		log(`another channel gateway (pid ${lease.holder ?? "unknown"}) holds ${channelGatewayLeaseFile(paths.stateDir)}; exiting`);
		process.exit(1);
	}
	const api = new SlackApi(base);
	const asks = new OperatorAsks(join(paths.stateDir, "operator", "asks.jsonl"));
	const ctx: GatewayContext = {
		stateDir: paths.stateDir,
		homes: [paths.home, dirname(paths.dataDir)],
		config: config.slack,
		tokens,
		api,
		store: new ChannelStore(paths.stateDir),
		asks: () => asks.list(),
		kindOf: (id) => new EscalationStore({ home: paths.home }).get(id)?.kind,
		origin: () => {
			try { return config.slack.dashboard_url ?? publicUrl(paths.stateDir) ?? liveTunnelOrigin(paths.stateDir); } catch { return null; }
		},
		now: () => new Date(),
		log,
	};
	const outbound = new ChannelOutbound(ctx);
	const failed = (what: string) => (error: unknown) => log(`${what} failed, retrying next round: ${(error instanceof Error ? error.message : "non-Error thrown").replace(/\s+/g, " ").slice(0, 200)}`);
	// The first pass baselines the bindings already on disk before any request can arrive.
	void outbound.sweep().catch(failed("the first sweep")).then(() => {
		const socket = runSocketMode({
			open: async () => {
				const opened = await api.connectionsOpen(tokens.app);
				if (opened.kind !== "ok" || typeof opened.data.url !== "string") throw new Error(opened.kind === "ok" ? "apps.connections.open returned no url" : opened.reason);
				return opened.data.url;
			},
			onEnvelope: (type, payload) => handleEnvelope(type, payload, { ctx, outbound, control: controlRequest }),
			log,
		});
		const loop = startDeviceNotifyLoop(() => outbound.sweep(), CHANNEL_SWEEP_MS, failed("sweep"));
		const shutdown = (): void => {
			socket.stop();
			void loop.stop().then(() => {
				lease.release();
				process.exit(0);
			});
		};
		process.on("SIGTERM", shutdown);
		process.on("SIGINT", shutdown);
	});
}
