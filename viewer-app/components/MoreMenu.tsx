import { useEffect, useRef, useState } from "preact/hooks";
import type { ControlView } from "../control.ts";
import { restartInFlight } from "../restart-control.ts";
import { Icon } from "./icons.tsx";
import { RestartSession, restartShown } from "./RestartSession.tsx";

/**
 * The shell's far-right ⋮ menu: Restart session lives here instead of inline (operator 2026-10-04). Shown only when
 * the operator control view is available and a session runs (or restarts). Esc and a tap outside close it; a dot on
 * the button shows a restart under way. The panel mounts only while open, so a half-made confirm never outlives it.
 */
export function MoreMenu({control}: {control: ControlView | undefined}) {
 const menu = useRef<HTMLDetailsElement>(null);
 const [open,setOpen] = useState(false);
 useEffect(() => {
  if (!open) return;
  const close = () => { if (menu.current) menu.current.open = false; };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); menu.current?.querySelector("summary")?.focus(); } };
  const outside = (e: Event) => { if (menu.current && !menu.current.contains(e.target as Node)) close(); };
  document.addEventListener("keydown",key);
  document.addEventListener("pointerdown",outside);
  return () => { document.removeEventListener("keydown",key); document.removeEventListener("pointerdown",outside); };
 },[open]);
 if (!control || !restartShown(control)) return null;
 const busy = restartInFlight(control.restarting);
 return <details class="more-menu" ref={menu} onToggle={e => setOpen(e.currentTarget.open)}>
  <summary aria-label="More actions" title="More actions"><Icon name="vmore"/>{busy && <span class="more-menu-dot" role="status" aria-label="Restart in progress"/>}</summary>
  {open && <div class="more-menu-panel"><RestartSession control={control}/></div>}
 </details>;
}
