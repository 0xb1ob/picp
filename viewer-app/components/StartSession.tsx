import { type ControlView, type Launcher, resumeLaunchers, START_HINTS, startLaunchers, startLine } from "../control.ts";

/** What Resume last session does, including its fallback: pi -c starts fresh when this home has no previous session. */
export const RESUME_LINE = "Resume continues this home's most recent operator session (cp-operator -c); with none, it starts a fresh one";

/**
 * Start session (cp-daemon P3 addendum): shown while no operator session runs. One button per launcher the home
 * offers — Start in herdr (a herdr workspace `cp-operator`) and/or Start in tmux (`<tmux> new-session -d -s
 * cp-operator <wrapper>`, from the cp-daemon-run dashboard) — then Resume in herdr/tmux (the same with the fixed `-c`); none offered is one disabled
 * button with the reason. Never on a message alone: a session
 * spends model tokens. The composer opens once the new session serves the dashboard; held messages arrive with it.
 */
export function StartSession({control}: {control:ControlView}) {
 const status = control.status;
 const starting = control.starting?.state === "starting";
 if (!status || "error" in status || !(status.offline || starting)) return null;
 const offered = startLaunchers(status);
 const resumable = resumeLaunchers(status);
 const hinted: Launcher[] = control.starting?.via && control.starting.state !== "running" ? [control.starting.via] : offered;
 return <div class="start-session" role="group" aria-label="Start the operator session">
  {starting ? <button type="button" class="start-session-button" disabled>Starting…</button>
   : offered.length ? [
    ...offered.map(via => <button key={via} type="button" class="start-session-button" onClick={() => control.start?.(via)}>{`Start in ${via}`}</button>),
    ...resumable.map(via => <button key={`resume-${via}`} type="button" class="start-session-button" onClick={() => control.start?.(via, true)}>{`Resume last session in ${via}`}</button>),
   ]
   : <button type="button" class="start-session-button" disabled>Start session</button>}
  <p class={control.starting?.state === "failed" ? "start-session-line start-session-failed" : "start-session-line"} role="status">{startLine(status, control.starting)}</p>
  {!starting && offered.length && resumable.length ? <p class="start-session-line">{RESUME_LINE}</p> : null}
  {hinted.map(via => <p key={via} class="start-session-line">{START_HINTS[via][0]} <code>{START_HINTS[via][1]}</code></p>)}
 </div>;
}
