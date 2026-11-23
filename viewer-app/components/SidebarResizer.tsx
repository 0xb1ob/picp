import type { JSX } from "preact";
import { useState } from "preact/hooks";

export const SIDEBAR_WIDTH_KEY = "cp-sidebar-width";
export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480, SIDEBAR_STEP = 16;
const clamp = (px:number) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px)));

/** The stored width, clamped; null (each column's own default) when absent, unreadable or not a number. */
function stored(): number | null {
 let raw: string | null = null;
 try { raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_KEY) ?? null; } catch { return null; }
 const px = raw === null || raw.trim() === "" ? NaN : Number(raw);
 return Number.isFinite(px) ? clamp(px) : null;
}
function persist(px:number | null) {
 try { if (px === null) globalThis.localStorage?.removeItem(SIDEBAR_WIDTH_KEY); else globalThis.localStorage?.setItem(SIDEBAR_WIDTH_KEY, String(px)); }
 catch { /* storage refused: the width holds for this view only */ }
}

/**
 * The desktop sidebar's user-chosen width: `style` sets `--sidebar-width` on the shell (absent until the user resizes),
 * `handle(fallback)` draws the drag/keyboard separator for a column whose CSS default is `fallback` px.
 */
export function useSidebarWidth() {
 const [width,setWidth] = useState<number | null>(stored);
 const commit = (px:number | null) => { setWidth(px); persist(px); };
 const handle = (fallback:number) => {
  const now = width ?? fallback;
  const down = (event:JSX.TargetedPointerEvent<HTMLDivElement>) => {
   if (event.button !== 0) return;
   event.preventDefault();
   const startX = event.clientX;
   let last = now;
   const move = (e:PointerEvent) => { last = clamp(now + e.clientX - startX); setWidth(last); };
   const up = () => { window.removeEventListener("pointermove",move); window.removeEventListener("pointerup",up); window.removeEventListener("pointercancel",up); commit(last); };
   window.addEventListener("pointermove",move);
   window.addEventListener("pointerup",up);
   window.addEventListener("pointercancel",up);
  };
  const key = (event:JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
   const next = event.key === "ArrowLeft" ? now - SIDEBAR_STEP : event.key === "ArrowRight" ? now + SIDEBAR_STEP
    : event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : null;
   if (next === null) return;
   event.preventDefault();
   commit(clamp(next));
  };
  return <div class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabindex={0}
   aria-valuenow={now} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} title="Drag to resize; double-click to reset"
   onPointerDown={down} onKeyDown={key} onDblClick={() => commit(null)}/>;
 };
 return { width, style: width === null ? undefined : { "--sidebar-width": `${width}px` }, handle };
}
