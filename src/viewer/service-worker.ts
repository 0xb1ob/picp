/**
 * The dashboard's Web Push service worker (Pier 1.1), served as `/sw.js`. A plain script string rather
 * than an esbuild entry: its URL must stay stable (a hashed name would re-register on every build) and
 * the worker global scope does not share one tsconfig program with the DOM app. `tests/viewer-service-
 * worker.test.ts` runs it in `node:vm`.
 *
 * A push shows `[project] kind` with the headline as body: no actions, no tag, no icon (the dashboard is
 * read-only). A click opens Awaiting you. Failures are `console.warn`ed so they stay visible in the
 * worker console, and still show something. A remote-dashboard pairing alert (`{type: "pairing", id, name, level,
 * at}`, src/push/device-notifications.ts) shows "New device paired: <name>", tagged per pairing so a resend after a
 * crash replaces rather than stacks, and its click opens Settings; nothing else about the ask path changes.
 */

export const SERVICE_WORKER_PATH = "/sw.js";

export const SERVICE_WORKER_JS = `"use strict";
const AWAITING = "/#awaiting";
const SETTINGS = "/#settings";
const text = (value) => (typeof value === "string" ? value : "");
self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch (error) {
    console.warn("command post push: unreadable payload", error);
  }
  if (data.type === "pairing") {
    const name = text(data.name).slice(0, 80) || "a device";
    const level = data.level === "view" ? "View-only" : "Full control";
    event.waitUntil(self.registration.showNotification("New device paired: " + name, { body: level + (text(data.at) ? " · " + text(data.at) : "") + " · open Settings to review", tag: "pairing-" + text(data.id), data: { url: SETTINGS } }));
    return;
  }
  const project = text(data.project);
  const kind = text(data.kind);
  const headline = text(data.headline);
  const title = project || kind ? ("[" + (project || "project unknown") + "] " + kind).trim() : "Command post needs you";
  event.waitUntil(self.registration.showNotification(title, { body: headline || "Open Awaiting you" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url === SETTINGS ? SETTINGS : AWAITING;
  const url = new URL(target, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((candidate) => new URL(candidate.url).origin === self.location.origin);
    if (!client) {
      await self.clients.openWindow(url);
      return;
    }
    try {
      await client.navigate(url);
    } catch (error) {
      console.warn("command post push: could not open " + target + " in the open window", error);
    }
    await client.focus();
  })());
});
`;
