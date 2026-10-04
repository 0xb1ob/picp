import { useState } from "preact/hooks";
import type { ControlView } from "../control.ts";
import { restartDisabled, restartInFlight, restartLine } from "../restart-control.ts";

/**
 * Restart session (cp-aqxl): shown while an operator session runs (and while its restart is under way). A two-tap
 * confirm naming the session file it resumes; disabled with the reason when the session cannot restart or must
 * wait. The page never stops or starts a process: the session stops itself and its cp-operator relaunches it.
 */
export function RestartSession({control}: {control:ControlView}) {
 const [confirm,setConfirm] = useState(false);
 const status = control.status;
 const restarting = control.restarting ?? null;
 const running = !!status && !("error" in status) && status.running && !!status.token;
 if (!running && !restarting) return null;
 const busy = restartInFlight(restarting);
 const disabled = restartDisabled(status);
 const file = (status && !("error" in status) ? status.session_file : null) ?? restarting?.session_file ?? "this session";
 const failed = restarting?.state === "refused" || restarting?.state === "failed";
 return <div class="operator-restart" role="group" aria-label="Restart the operator session">
  {busy ? <button type="button" class="operator-restart-button" disabled>Restarting…</button>
   : !running ? null
   : confirm && !disabled ? [
    <button key="go" type="button" class="operator-restart-button operator-restart-confirm" onClick={() => { setConfirm(false); control.restart?.(); }}>{`Tap again to restart · resumes ${file}`}</button>,
    <button key="cancel" type="button" class="operator-restart-cancel" onClick={() => setConfirm(false)}>Cancel</button>,
   ]
   : <button type="button" class="operator-restart-button" disabled={!!disabled} title={disabled ?? undefined} onClick={() => setConfirm(true)}>Restart session</button>}
  <p class={failed ? "operator-restart-line operator-restart-failed" : "operator-restart-line"} role={failed ? "alert" : "status"}>{restartLine(status, restarting)}</p>
 </div>;
}
