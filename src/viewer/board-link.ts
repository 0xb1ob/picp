/**
 * The one link builder for a served board (intake's board receipt and `responseReportUrl`); docs/contracts.md
 * "Board links". Never a throw and never a guessed loopback (pi-command-post-1jz): with no address it is relative.
 */
import { tailscaleIp } from "./bind-host.ts";
import { DEFAULT_PORT } from "./cli.ts";
import { publicUrl } from "./host-config.ts";
import { liveTunnelOrigin } from "./remote-runtime.ts";
import { hostHeaderFor } from "./server.ts";
import { resolveStateDir } from "./sessions.ts";

export interface BoardLinkOptions { viewerHost?: string; viewerPort?: number }
/** `note` is set only on the relative fallback and names the remedy. */
export interface BoardLink { url: string; note?: string }

const BOARD_LINK_REMEDY =
	"relative link: no tunnel, public URL, viewer host or tailnet address; set Settings → Dashboard address → Public URL (data/viewer.json public_url) or cp-install --viewer-host <ip>";

/** Tunnel origin, else `viewer.public_url`, else the configured host (loopback too), else the tailnet IPv4, else relative. */
export function boardLink(home: string, slug: string, options: BoardLinkOptions = {}, tailnet: () => string | undefined = tailscaleIp): BoardLink {
	const stateDir = resolveStateDir(home);
	const path = `/boards/${slug}/`;
	const live = liveTunnelOrigin(stateDir);
	if (live) return { url: `${live}${path}` };
	const base = publicUrl(stateDir);
	if (base) return { url: `${base}${path}` };
	const host = options.viewerHost || tailnet();
	if (host) return { url: `http://${hostHeaderFor(host, options.viewerPort ?? DEFAULT_PORT)}${path}` };
	return { url: path, note: BOARD_LINK_REMEDY };
}
