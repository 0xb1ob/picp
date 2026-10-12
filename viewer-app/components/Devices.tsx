import { useState } from "preact/hooks";
import { DEVICE_TRUST, type DevicesResponse, type PairCodeResponse } from "../../src/viewer/api-types.ts";
import { Ecc, QrCode } from "../../src/qr/code.ts";
import type { DeviceLevel } from "../devices-control.ts";
import type { DevicesView } from "../use-devices.ts";

const when = (at: string | null): string => at ? new Intl.DateTimeFormat("en-GB", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}).format(new Date(at)) : "never";
const levelText = (level: DeviceLevel): string => level === "view" ? "View only" : "Full control";
const ROUTES: Record<string, string> = {"cli-up": "cp-tunnel up", "cli-pair": "cp-tunnel pair", "loopback-dashboard": "this machine's dashboard", "tailnet-dashboard": "a tailnet dashboard"};

/** The pairing link as an SVG QR code drawn locally (the vendored encoder), one path, no external service. */
export function PairingQr({link}: {link: string}) {
 const code = QrCode.encodeText(link, Ecc.LOW);
 let path = "";
 for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.getModule(x, y)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
 return <svg class="devices-qr" viewBox={`0 0 ${code.size + 8} ${code.size + 8}`} role="img" aria-label="Pairing QR code"><rect class="devices-qr-light" width="100%" height="100%"/><path class="devices-qr-dark" d={path}/></svg>;
}

function Pairing({pairing, dismiss}: {pairing: PairCodeResponse; dismiss: () => void}) {
 return <div class="devices-pairing" role="status">
  <PairingQr link={pairing.link}/>
  <div class="devices-pairing-text">
   <p><strong>Scan on the new device, or open the link there.</strong> {levelText(pairing.level)} · one use · expires {when(pairing.expires_at)}. The link is a secret: it is not saved anywhere; it disappears at its expiry or when you leave this screen.</p>
   <code class="devices-link">{pairing.link}</code>
   <button type="button" onClick={dismiss}>Hide link</button>
  </div>
 </div>;
}

function List({data, view}: {data: DevicesResponse; view: DevicesView}) {
 const devices = [...data.devices].filter(device => device.state === "active").sort((a, b) => Number(a.revoked_at !== null) - Number(b.revoked_at !== null) || b.created_at.localeCompare(a.created_at));
 const routeOf = new Map(data.events.map(event => [event.device_id, event.route]));
 if (!devices.length) return <p class="settings-readonly devices-empty">No paired devices</p>;
 return <ul class="devices-list">{devices.map(device => {
  const gone = device.revoked_at ? `revoked ${when(device.revoked_at)}` : Date.parse(device.expires_at) <= Date.now() ? `expired ${when(device.expires_at)}` : null;
  return <li key={device.id} class={gone ? "devices-row devices-gone" : "devices-row"}>
   <span class="devices-name"><strong>{device.name}</strong><span class="settings-meta">{levelText(device.level)}{gone ? ` · ${gone}` : ""}</span></span>
   <span class="settings-meta devices-when">Paired {when(device.created_at)}{routeOf.has(device.id) ? ` via ${ROUTES[routeOf.get(device.id)!] ?? routeOf.get(device.id)}` : ""} · last used {when(device.last_seen_at)}</span>
   {data.can_revoke && !gone && <button type="button" disabled={view.busy} onClick={() => view.revoke(device.id, device.name)}>Revoke</button>}
  </li>;
 })}</ul>;
}

/** Settings → Devices (remote dashboard PR 3): list, local-only Add with a QR, Full-control revoke, and the terminal-trust statement. */
export function Devices({view}: {view: DevicesView}) {
 const [level, setLevel] = useState<DeviceLevel>("full");
 const {state} = view;
 const data = state.kind === "ok" || state.kind === "error" ? state.data : null;
 return <section class="settings-section devices" aria-label="Devices">
  <h2>Devices</h2>
  <p class="settings-help devices-trust"><strong>{DEVICE_TRUST}</strong> Every new pairing shows a notice on every paired dashboard and sends a push where it can; the operator is told never to pair devices on a remote request, which is defence in depth, not a sandbox.</p>
  <div class="settings-body">
   {state.kind === "loading" && <p class="settings-readonly" role="status">Loading devices</p>}
   {state.kind === "off" && <p class="settings-readonly" role="status">The remote dashboard is off on this home. Turn it on from a terminal: <code>cp-tunnel up</code>.</p>}
   {state.kind === "error" && <p class="settings-warn" role="alert">Devices unavailable: {state.error}{data ? " · showing the last read" : ""}</p>}
   {data && <>
    {!data.origin && <p class="settings-readonly">The remote dashboard is not running; paired devices sign in again once <code>cp-tunnel up</code> runs.</p>}
    {data.origin && <p class="settings-readonly">Remote address: <code>{data.origin}</code>{data.pending_codes ? ` · ${data.pending_codes} pairing link${data.pending_codes === 1 ? "" : "s"} waiting` : ""}</p>}
    <List data={data} view={view}/>
    {data.can_create ? <div class="settings-actions devices-add">
     <label>Level <select value={level} disabled={view.busy} onChange={event => setLevel((event.currentTarget as HTMLSelectElement).value as DeviceLevel)}><option value="full">Full control</option><option value="view">View only</option></select></label>
     <button type="button" class="settings-primary" disabled={view.busy || !data.origin} onClick={() => view.create(level)}>Add device</button>
    </div> : <p class="settings-readonly">{data.can_revoke ? "Add a device from this machine's dashboard or a terminal (cp-tunnel pair); a remote device can never add one." : "View only: you can see devices but not change them."}</p>}
    {view.pairing && <Pairing pairing={view.pairing} dismiss={view.dismissPairing}/>}
   </>}
   {view.notice && <p class="settings-readonly" role="status">{view.notice}</p>}
   {view.error && <p class="settings-warn" role="alert">{view.error}</p>}
  </div>
 </section>;
}
