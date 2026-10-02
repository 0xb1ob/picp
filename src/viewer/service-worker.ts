/**
 * The dashboard's Web Push service worker (Pier 1.1), served as `/sw.js`. A plain script string rather
 * than an esbuild entry: its URL must stay stable (a hashed name would re-register on every build) and
 * the worker global scope does not share one tsconfig program with the DOM app. `tests/viewer-service-
 * worker.test.ts` runs it in `node:vm`.
 *
 * A push shows `[project] kind` with the headline as body: no actions, no tag, no icon (the dashboard is
 * read-only). A click opens Awaiting you. Failures are `console.warn`ed so they stay visible in the
 * worker console, and still show something.
 */

export const SERVICE_WORKER_PATH = "/sw.js";

export const SERVICE_WORKER_JS = `"use strict";
const AWAITING = "/#awaiting";
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
  const project = text(data.project);
  const kind = text(data.kind);
  const headline = text(data.headline);
  const title = project || kind ? ("[" + (project || "project unknown") + "] " + kind).trim() : "Command post needs you";
  event.waitUntil(self.registration.showNotification(title, { body: headline || "Open Awaiting you" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(AWAITING, self.location.origin).href;
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
      console.warn("command post push: could not open Awaiting you in the open window", error);
    }
    await client.focus();
  })());
});
`;
