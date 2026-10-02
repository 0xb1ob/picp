function escapeHtml(text: string): string {
 return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const APP_CSP = "default-src 'none'; script-src 'self'; script-src-attr 'none'; worker-src 'self'; manifest-src 'self'; style-src 'self'; style-src-attr 'none'; font-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export interface AppAsset { readonly bytes: Uint8Array; readonly mime: string }
export interface ViewerApp {
 readonly script: string;
 readonly stylesheet: string;
 readonly assets: Readonly<Record<string, AppAsset>>;
 readonly duration_ms: number;
 readonly bytes: number;
}
/**
 * No zooming on the app/PWA page (operator 2026-09-27): `viewport-fit=cover` makes the safe-area insets
 * non-zero, and `interactive-widget=resizes-content` makes Android Chrome shrink the layout viewport for
 * the keyboard instead of overlaying the composer with it (iOS keeps its own visual-viewport pan, which
 * `viewer-app/viewport-fit.ts` follows).
 */
export const APP_VIEWPORT = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";
export function appPage(app?: ViewerApp): string {
 const content = app
  ? `<link rel="stylesheet" href="${escapeHtml(app.stylesheet)}"></head><body><div id="app"></div><script type="module" src="${escapeHtml(app.script)}"></script>`
  : '</head><body><h1>Viewer build unavailable</h1><p>The app could not be built. See the viewer startup diagnostic.</p>';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="${APP_VIEWPORT}"><title>Command post</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">${content}</body></html>`;
}
