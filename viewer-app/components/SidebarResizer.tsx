import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export const SIDEBAR_WIDTH_KEY = "cp-sidebar-width";
const SIDEBAR_VAR = "--sidebar-width";
export const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480, SIDEBAR_STEP = 16;
const DRAG_THRESHOLD = 3;
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
 * The desktop sidebar's user-chosen width as `--sidebar-width` on the document root (absent until the user resizes),
 * as viewport-fit sets its variables; `handle(fallback)` draws the separator for a column whose CSS default is `fallback`.
 */
export function useSidebarWidth() {
 const [width,setWidth] = useState<number | null>(stored);
 const commit = (px:number | null) => { setWidth(px); persist(px); };
 const drag = useRef<(() => void) | null>(null);
 useEffect(() => () => drag.current?.(), []);
 useLayoutEffect(() => {
  const root = document.documentElement.style;
  if (width === null) root.removeProperty(SIDEBAR_VAR); else root.setProperty(SIDEBAR_VAR, `${width}px`);
  return () => root.removeProperty(SIDEBAR_VAR);
 }, [width]);
 const handle = (fallback:number) => {
  const now = width ?? fallback;
  const down = (event:JSX.TargetedPointerEvent<HTMLDivElement>) => {
   if (event.button !== 0) return;
   event.preventDefault();
   drag.current?.();
   const startX = event.clientX;
   let last: number | null = null;
   // A plain click must store nothing, or a column's fallback would become every column's width.
   const move = (e:PointerEvent) => { if (last === null && Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return; last = clamp(now + e.clientX - startX); setWidth(last); };
   const detach = () => { window.removeEventListener("pointermove",move); window.removeEventListener("pointerup",up); window.removeEventListener("pointercancel",up); drag.current = null; };
   const up = () => { detach(); if (last !== null) commit(last); };
   window.addEventListener("pointermove",move);
   window.addEventListener("pointerup",up);
   window.addEventListener("pointercancel",up);
   drag.current = detach;
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
 return { width, handle };
}
