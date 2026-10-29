import { useState } from "preact/hooks";
import type { ControlStatus } from "../control.ts";
import { parentRestartDisabled, restartParent } from "../restart-control.ts";

type Mode = "resume" | "clean";
/**
 * Restart the CP parent (resume) or Restart clean (archives its session): a two-tap confirm each, disabled with the
 * drain gate's reason. Advisory only: the parent host re-checks and refuses (409); the outcome arrives as `last`.
 */
export function ParentRestart({status}: {status: ControlStatus | null | undefined}) {
 const [confirm,setConfirm] = useState<Mode | null>(null);
 const [posted,setPosted] = useState<{line: string; failed: boolean; before: string | null} | null>(null);
 const disabled = parentRestartDisabled(status);
 const live = status && !("error" in status) ? status : null;
 const last = live?.parent_restart?.last ?? null;
 const post = (mode: Mode) => {
  setConfirm(null);
  setPosted({line: mode === "clean" ? "Restarting the parent clean…" : "Restarting the parent…", failed: false, before: last});
  void restartParent((url, init) => fetch(url, init), live?.token ?? "", mode).then(result =>
   setPosted({line: "error" in result ? `Refused: ${result.error}` : result.mode === "clean" ? "Restarting the parent clean…" : "Restarting the parent…", failed: "error" in result, before: last}));
 };
 // A posted restart's line holds until a new outcome replaces `last`.
 const line = posted && (posted.failed || last === posted.before) ? posted.line : last ? `Last restart: ${last}` : disabled ?? "Restart stops the CP parent and starts it again";
 const failed = posted?.failed === true || /^(refused|failed):/.test(line.replace(/^Last restart: /,""));
 return <div class="operator-restart parent-restart" role="group" aria-label="Restart the CP parent">
  {confirm && !disabled ? [
   <button key="go" type="button" class="operator-restart-button operator-restart-confirm" onClick={() => post(confirm)}>{confirm === "clean" ? "Tap again to restart the parent clean · archives its session" : "Tap again to restart the parent · resumes its session"}</button>,
   <button key="cancel" type="button" class="operator-restart-cancel" onClick={() => setConfirm(null)}>Cancel</button>,
  ] : [
   <button key="resume" type="button" class="operator-restart-button" disabled={!!disabled} title={disabled ?? undefined} onClick={() => setConfirm("resume")}>Restart parent</button>,
   <button key="clean" type="button" class="operator-restart-button operator-restart-clean" disabled={!!disabled} title={disabled ?? undefined} onClick={() => setConfirm("clean")}>Restart parent clean</button>,
  ]}
  {disabled && line !== disabled && <p class="operator-restart-line">{disabled}</p>}
  <p class={failed ? "operator-restart-line operator-restart-failed" : "operator-restart-line"} role={failed ? "alert" : "status"}>{line}</p>
 </div>;
}
