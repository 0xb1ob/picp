import type { PushStatusResponse } from "../src/viewer/api-types.ts";

/** Web Push in this browser (Pier 1.1): what the More screen's Notifications control can say and do. */
export type PushPhase = "checking" | "insecure" | "install" | "unsupported" | "unconfigured" | "denied" | "off" | "on" | "busy" | "error";

export interface PushEnv {
 /** A secure context: HTTPS, or localhost. */
 secure: boolean;
 /** Service workers, PushManager and Notification all exist. */
 supported: boolean;
 /** iPhone/iPad: Web Push exists only in a Home Screen web app. */
 ios: boolean;
 /** Running as an installed web app (`navigator.standalone` or `display-mode: standalone`). */
 standalone: boolean;
 permission: NotificationPermission | "unsupported";
}
export interface PushSubscriptionLike { endpoint: string; toJSON(): PushSubscriptionJSON; unsubscribe(): Promise<boolean> }
export interface PushRegistrationLike {
 pushManager: { getSubscription(): Promise<PushSubscriptionLike | null>; subscribe(options: {userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer>}): Promise<PushSubscriptionLike> };
}
export interface PushDeps {
 env(): PushEnv;
 requestPermission(): Promise<NotificationPermission>;
 /** Register `/sw.js` and resolve with the active registration. */
 register(): Promise<PushRegistrationLike>;
 getRegistration(): Promise<PushRegistrationLike | undefined>;
 fetch(url: string, init?: RequestInit): Promise<Response>;
}
export interface PushView {
 phase: PushPhase;
 status: PushStatusResponse | null | undefined;
 error: string | null;
 notice: string | null;
 toggle(): void;
}

export const SUBSCRIPTION_URL = "/api/push/subscription";

export function browserPushDeps(): PushDeps {
 return {
  env: () => {
   const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
   return {
    secure: window.isSecureContext,
    supported,
    ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    standalone: (navigator as Navigator & {standalone?: boolean}).standalone === true || window.matchMedia("(display-mode: standalone)").matches,
    permission: "Notification" in window ? Notification.permission : "unsupported",
   };
  },
  requestPermission: () => Notification.requestPermission(),
  register: async () => { await navigator.serviceWorker.register("/sw.js", {scope: "/"}); return navigator.serviceWorker.ready; },
  getRegistration: () => navigator.serviceWorker.getRegistration("/"),
  fetch: (url, init) => fetch(url, init),
 };
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
 const text = atob(value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
 const bytes = new Uint8Array(text.length);
 for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
 return bytes;
}

export function pushPhase(env: PushEnv, state: {status: PushStatusResponse | null | undefined; subscribed: boolean | undefined; busy: boolean}): PushPhase {
 if (!env.secure) return "insecure";
 if (env.ios && !env.standalone) return "install";
 if (!env.supported) return "unsupported";
 if (state.status === undefined) return "checking";
 if (state.status === null) return "error";
 if (!state.status.configured) return "unconfigured";
 if (state.busy) return "busy";
 if (env.permission === "denied") return "denied";
 if (state.subscribed === undefined) return "checking";
 return state.subscribed ? "on" : "off";
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function pushMeta(phase: PushPhase, status: PushStatusResponse | null | undefined): string {
 const devices = typeof status?.devices === "number" ? ` · ${plural(status.devices, "device")} on this home` : "";
 const undelivered = status?.undelivered_24h ? ` · ${status.undelivered_24h} undelivered in 24 h${status.last_error ? ` (last: ${status.last_error})` : ""}` : "";
 switch (phase) {
  case "checking": return "Checking this browser";
  case "insecure": return status?.origin ? "Needs the HTTPS address of this dashboard" : "Needs an HTTPS address; push is not set up on this home";
  case "install": return "On iPhone and iPad, add this dashboard to the Home Screen first, then turn it on from there";
  case "unsupported": return "This browser has no Web Push";
  case "unconfigured": return "Not set up on this home: npm run push:init -- --origin https://<dashboard host>";
  case "denied": return "Blocked in browser settings: allow notifications for this site";
  case "busy": return "Waiting for this browser and the home";
  case "error": return "Push status unavailable";
  case "on": return `On for this device${devices}${undelivered}`;
  case "off": return `Off for this device${devices}${undelivered}`;
 }
}
/** Menu-row label for a push phase: the short state, not pushMeta's full sentence. */
export function pushShort(phase: PushPhase): string {
 switch (phase) {
  case "checking": return "Checking";
  case "insecure": return "Needs HTTPS";
  case "install": return "Add to Home Screen";
  case "unsupported": return "Unavailable";
  case "unconfigured": return "Not set up";
  case "denied": return "Blocked";
  case "busy": return "Waiting";
  case "error": return "Unavailable";
  case "on": return "On";
  case "off": return "Off";
 }
}

export async function readSubscribed(deps: PushDeps): Promise<boolean> {
 const registration = await deps.getRegistration();
 return Boolean(await registration?.pushManager.getSubscription());
}

async function failure(response: Response): Promise<string> {
 try { const body = await response.json() as {error?: unknown}; if (typeof body.error === "string") return body.error; } catch { /* no JSON body: the status says enough */ }
 return `HTTP ${response.status}`;
}

/** Rejects with `message` when `promise` has not settled after `ms`, so a stalled browser call never looks like work. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

/** Ask permission (first, inside the tap), register the worker, subscribe and store it on this home. */
export async function enablePush(deps: PushDeps, publicKey: string, subscribeTimeoutMs = 30_000): Promise<"on" | "denied"> {
 if (await deps.requestPermission() !== "granted") return "denied";
 const registration = await deps.register();
 const subscription = await registration.pushManager.getSubscription() ?? await within(registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey)}), subscribeTimeoutMs, "The browser's push service did not answer; try again");
 let response: Response;
 try {
  response = await deps.fetch(SUBSCRIPTION_URL, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(subscription.toJSON())});
 } catch {
  await subscription.unsubscribe().catch(() => false);
  throw new Error("Could not reach this home to store the subscription");
 }
 if (!response.ok) {
  await subscription.unsubscribe().catch(() => false);
  throw new Error(`Not turned on: ${await failure(response)}`);
 }
 return "on";
}

/** Remove this device from the home, then from the browser, even when the home cannot be reached. */
export async function disablePush(deps: PushDeps): Promise<{warning?: string}> {
 const subscription = await (await deps.getRegistration())?.pushManager.getSubscription();
 if (!subscription) return {};
 let warning: string | undefined;
 try {
  const response = await deps.fetch(SUBSCRIPTION_URL, {method: "DELETE", headers: {"content-type": "application/json"}, body: JSON.stringify({endpoint: subscription.endpoint})});
  if (!response.ok) warning = `Removed here; the home drops it on its next push (${await failure(response)})`;
 } catch {
  warning = "Removed here; the home drops it on its next push";
 }
 await subscription.unsubscribe();
 return warning ? {warning} : {};
}
