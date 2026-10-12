import { useState } from "preact/hooks";
import { deliverySummary, type DeviceNoticesState, readCursor, unreadNotices, useDeviceNotices, writeCursor } from "../use-device-notices.ts";

const LIMIT = 3;
const when = (at: string): string => new Intl.DateTimeFormat("en-GB", {day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}).format(new Date(at));

/**
 * The global "New device paired" notice (remote dashboard PR 1d), above every screen. Names are text, never markup.
 * Dismiss moves this browser's own cursor only; another device still sees the notice.
 */
export function DeviceNoticesView({state, cursor, onDismiss}: {state: DeviceNoticesState; cursor: string; onDismiss: (at: string) => void}) {
 if (state.kind === "off" || state.kind === "loading") return null;
 const data = state.data;
 const unread = data ? unreadNotices(data.notices, cursor) : [];
 if (state.kind === "error" && unread.length === 0) return <p class="device-notices device-notices-error" role="status">Pairing notices unavailable ({state.error})</p>;
 if (!data || unread.length === 0) return null;
 return <section class="device-notices" role="status" aria-label="New device paired">
  <ul class="device-notices-list">{unread.slice(0, LIMIT).map(notice => <li key={notice.id} class="device-notice">
   <strong class="device-notice-title">New device paired: {notice.name} · {notice.level === "view" ? "View only" : "Full control"} · <time dateTime={notice.at} title={notice.at}>{when(notice.at)}</time></strong>
   <span class="device-notice-push">{deliverySummary(notice.recipients, data.delivery_error)}</span>
  </li>)}</ul>
  {unread.length > LIMIT && <p class="device-notices-more">+{unread.length - LIMIT} more</p>}
  {state.kind === "error" && <p class="device-notices-more">Pairing notices unavailable ({state.error}); showing the last read</p>}
  <div class="device-notices-actions"><a href="#settings">Devices</a><button type="button" onClick={() => onDismiss(unread[0]!.at)}>Dismiss</button></div>
 </section>;
}

export function DeviceNotices({updatedAt}: {updatedAt: string | null}) {
 const state = useDeviceNotices(updatedAt);
 const [cursor, setCursor] = useState(readCursor);
 return <DeviceNoticesView state={state} cursor={cursor} onDismiss={at => { writeCursor(at); setCursor(at); }}/>;
}
