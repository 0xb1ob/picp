import { useEffect, useRef, useState } from "preact/hooks";
import type { ControlView } from "../control.ts";
import { stamp } from "../format.ts";
import { pushShort } from "../push.ts";
import { restartInFlight } from "../restart-control.ts";
import { usePush } from "../use-push.ts";
import { badgeView, type VersionState } from "../use-version.ts";
import { Icon } from "./icons.tsx";
import { RestartSession, restartShown } from "./RestartSession.tsx";
import { VersionBadge } from "./VersionBadge.tsx";

/**
 * The shell's ⋮ menu, always shown. Refresh reloads the page (and names the last updated time); Copy link writes
 * this view's URL; Notifications shows the push phase and links to #more, where the toggle stays; Viewer is the
 * version badge. Restart session is the last row, only while a session runs. Esc and a tap outside close it; a dot
 * shows a restart under way or a version alert. The panel mounts only while open.
 */
export function MoreMenu({control, version = {view:null, error:null}, updatedAt = null}: {control: ControlView | undefined; version?: VersionState; updatedAt?: string | null}) {
 const menu = useRef<HTMLDetailsElement>(null);
 const [open,setOpen] = useState(false);
 const [copied,setCopied] = useState<string | null>(null);
 const push = usePush(open);
 useEffect(() => {
  if (!open) return;
  const close = () => { if (menu.current) menu.current.open = false; };
  const key = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); menu.current?.querySelector("summary")?.focus(); } };
  const outside = (e: Event) => { if (menu.current && !menu.current.contains(e.target as Node)) close(); };
  document.addEventListener("keydown",key);
  document.addEventListener("pointerdown",outside);
  return () => { document.removeEventListener("keydown",key); document.removeEventListener("pointerdown",outside); };
 },[open]);
 const busy = !!control && restartInFlight(control.restarting);
 const dot = busy || badgeView(version, null).level === "alert";
 const copy = () => {
  const href = globalThis.location?.href ?? "";
  void navigator.clipboard?.writeText(href).then(() => setCopied("Link copied"), () => setCopied("Couldn't copy the link"));
 };
 return <details class="shell-more" ref={menu} onToggle={e => setOpen(e.currentTarget.open)}>
  <summary aria-label="More actions" title="More actions"><Icon name="vmore"/>{dot && <span class="shell-more-dot" role="status" aria-label={busy ? "Restart in progress" : "Version alert"}/>}</summary>
  {open && <div class="shell-more-panel">
   <button type="button" class="shell-more-row" onClick={() => globalThis.location?.reload()}>Refresh now{updatedAt && <small>{stamp(updatedAt)}</small>}</button>
   <button type="button" class="shell-more-row" onClick={copy}>Copy link to this view</button>
   <p class="shell-more-status" role="status">{copied ?? ""}</p>
   <a class="shell-more-row" href="#more">Notifications · {push ? pushShort(push.phase) : "Checking"}</a>
   <div class="shell-more-version"><span>Viewer</span><VersionBadge state={version} labelled/></div>
   {control && restartShown(control) && <RestartSession control={control}/>}
  </div>}
 </details>;
}
