import { Icon } from "./icons.tsx";
import { pushMeta, type PushView } from "../push.ts";

/** More → Notifications: Turn on / Turn off Web Push for this device, or say exactly why it cannot. */
export function PushControl({view}: {view: PushView}) {
 const {phase, status} = view;
 const toggleable = phase === "on" || phase === "off" || phase === "busy";
 return <section class="more-push" aria-labelledby="more-push-title">
  <h2 id="more-push-title">Notifications</h2>
  <div class="more-push-row">
   <Icon name="awaiting"/>
   <span class="more-label"><span>Push when you're needed</span><span class="more-meta">{pushMeta(phase, status)}</span></span>
   {toggleable && <button type="button" disabled={phase === "busy"} onClick={view.toggle}>{phase === "on" ? "Turn off" : phase === "busy" ? "Working" : "Turn on"}</button>}
  </div>
  {phase === "insecure" && status?.origin && <a href={`${status.origin}/#more`}>Open the HTTPS dashboard</a>}
  {phase === "install" && <ol class="more-push-steps"><li>Tap Share in Safari</li><li>Choose Add to Home Screen</li><li>Open Command post from the Home Screen, then Turn on here</li></ol>}
  {view.notice && <p role="status" class="more-meta">{view.notice}</p>}
  {view.error && <p role="alert" class="overview-error">{view.error}</p>}
 </section>;
}
