import { useEffect, useState } from "preact/hooks";
import { type ControlStatus, readControl } from "./control.ts";
import { RESTART_LOOK, RESTART_WAIT_MS, type Restarting, restartDisabled, restartInFlight, restartOperator } from "./restart-control.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Restart session: one `POST /api/operator/restart`, then the control status every 2 s (≤ 90 s): `stopping` while the
 * same session (its `session_started_at`) still serves, `relaunching` while none does, `restarted` once a new one does.
 * Every status read is handed to `onStatus`, so the composer follows the session down and back.
 */
export function useRestart(active: boolean, status: ControlStatus | null, fetcher: Fetch, onStatus: (value: ControlStatus) => void): {restarting: Restarting | null; restart: () => void} {
 const [restarting, setRestarting] = useState<Restarting | null>(null);
 const polling = restarting?.state === "stopping" || restarting?.state === "relaunching";
 useEffect(() => {
  if (!active || !polling || !restarting) return;
  const from = restarting;
  const deadline = Date.now() + RESTART_WAIT_MS;
  let stop = false;
  let sawOffline = false;
  const poll = async () => {
   while (!stop) {
    await new Promise(done => setTimeout(done, 2_000));
    if (stop) return;
    const value = await readControl(fetcher);
    if (stop) return;
    onStatus(value);
    const running = !("error" in value) && value.running && !!value.token;
    if (running && (sawOffline || value.session_started_at !== from.started_at)) return setRestarting({...from, state: "restarted", session_file: value.session_file ?? from.session_file});
    if (!running) sawOffline = true;
    if (Date.now() > deadline) return setRestarting({...from, state: "failed", reason: `the session has not come back within ${RESTART_WAIT_MS / 1000} s; ${RESTART_LOOK}`});
    setRestarting(current => current && restartInFlight(current) ? {...current, state: running ? "stopping" : "relaunching"} : current);
   }
  };
  void poll();
  return () => { stop = true; };
 }, [active, polling]);
 const restart = () => {
  if (restartDisabled(status) || restartInFlight(restarting) || !status || "error" in status) return;
  const from: Restarting = {state: "restarting", reason: null, started_at: status.session_started_at ?? null, session_file: status.session_file};
  setRestarting(from);
  void restartOperator(fetcher, status.token ?? "").then(result => {
   if ("error" in result) setRestarting({...from, state: result.status >= 400 && result.status < 500 ? "refused" : "failed", reason: result.status >= 400 && result.status < 500 ? result.error : `${result.error}; ${RESTART_LOOK}`});
   else setRestarting({...from, state: "stopping", session_file: result.session_file ?? from.session_file});
  });
 };
 return {restarting, restart};
}
