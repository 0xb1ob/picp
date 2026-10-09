import { useState } from "preact/hooks";
import type { ScheduleItem, SchedulePolicyResponse } from "../../src/viewer/api-types.ts";
import type { SchedulePolicy } from "../../src/viewer/schedule-policy.ts";
import type { ScheduleControlView } from "../schedule-control.ts";
import { scheduleControlReady } from "../schedule-control.ts";

const LIMITS = [["usd", "USD per run"], ["tokens", "Tokens per run (non-cached)"], ["child_jobs", "Child jobs"], ["parallelism", "At once"], ["run_hours", "Run hours"]] as const;
const ROLES = ["implementer", "planner", "reviewer"] as const;
type LimitKey = (typeof LIMITS)[number][0];
/** Cheap, browser-safe checks only (the viewer bundle cannot import the node-bound policy validator); the server's `schedulePolicyErrors` stays the authority and its errors show under the same fields. */
const limitError = (key: LimitKey, value: number): string[] =>
 !Number.isFinite(value) ? [`/limits/${key}: must be a number`]
 : key === "usd" ? (value > 0 ? [] : [`/limits/${key}: must be above 0`])
 : !Number.isSafeInteger(value) || value < 1 ? [`/limits/${key}: must be a whole number, at least 1`]
 : key === "parallelism" && value > 32 ? [`/limits/${key}: must be at most 32`] : [];

/** The server's refusal text ("invalid schedule policy: /limits/usd: …; …") as one entry per field error. */
export const serverPolicyErrors = (reason: string | null | undefined): string[] => reason?.startsWith("invalid schedule policy: ") ? reason.slice("invalid schedule policy: ".length).split("; ") : [];

/** Errors keyed by the path before the first ": ", so each field shows its own. */
const byPath = (errors: string[]) => {
 const map = new Map<string, string[]>();
 for (const error of errors) {
  const cut = error.indexOf(": ");
  const path = cut < 0 ? "" : error.slice(0, cut);
  map.set(path, [...(map.get(path) ?? []), cut < 0 ? error : error.slice(cut + 2)]);
 }
 return map;
};

/** The typed form: limits and model policy are editable; inherited ceilings and the recipe are read-only. Save sends one `save_policy`. */
export function ScheduleEditor({s, policy, control, onClose}: {s: ScheduleItem; policy: SchedulePolicyResponse; control: ScheduleControlView; onClose: () => void}) {
 const base = policy.policy ?? policy.legacy;
 const [limits, setLimits] = useState<Record<LimitKey, string>>(() => Object.fromEntries(LIMITS.map(([key]) => [key, String(base?.limits[key] ?? "")])) as Record<LimitKey, string>);
 const [mode, setMode] = useState<"routing-default" | "pinned">(base?.model_policy.mode ?? "routing-default");
 const [pins, setPins] = useState<Record<(typeof ROLES)[number], string>>(() => ({implementer: "", planner: "", reviewer: "", ...(base?.model_policy.mode === "pinned" ? base.model_policy.by_role : {})}));
 if (!base) return <p role="alert" class="job-meta">Nothing to edit: no saved policy or legacy template. {policy.blocking.join("; ")}</p>;
 const numbers = Object.fromEntries(LIMITS.map(([key]) => [key, limits[key].trim() === "" ? Number.NaN : Number(limits[key])])) as Record<LimitKey, number>;
 const candidate: SchedulePolicy = {...base, limits: {...base.limits, ...numbers}, model_policy: mode === "pinned" ? {mode: "pinned", by_role: Object.fromEntries(ROLES.filter(role => pins[role].trim()).map(role => [role, pins[role].trim()]))} : {mode: "routing-default"}};
 const own = LIMITS.flatMap(([key]) => limitError(key, numbers[key]));
 const failed = control.failed?.schedule_id === s.id ? serverPolicyErrors(control.failed.reason) : [];
 const errors = byPath([...own, ...failed]);
 const general = [...errors].filter(([path]) => !path.startsWith("/limits/") && !path.startsWith("/model_policy")).flatMap(([path, list]) => list.map(text => `${path}: ${text}`));
 const ready = scheduleControlReady(control.status) && control.sending === null;
 const fieldErrors = (prefix: string) => [...errors].filter(([path]) => path === prefix || path.startsWith(`${prefix}/`)).flatMap(([, list]) => list).map(text => <p key={text} role="alert" class="schedule-field-error">{text}</p>);
 const eff = policy.effective;
 return <div class="schedule-editor" role="group" aria-label={`Edit ${s.name}`}>
  <p class="job-meta">Editing saves a new revision; it applies to the next run, never one already open.</p>
  {LIMITS.map(([key, label]) => <label key={key} class="schedule-field"><span>{label}</span>
   <input type="number" inputMode="decimal" value={limits[key]} aria-invalid={errors.has(`/limits/${key}`)} onInput={event => { const value = (event.currentTarget as HTMLInputElement).value; setLimits(prev => ({...prev, [key]: value})); }}/>
   {fieldErrors(`/limits/${key}`)}
  </label>)}
  <label class="schedule-field"><span>Model policy</span>
   <select value={mode} onChange={event => setMode((event.currentTarget as HTMLSelectElement).value as typeof mode)}><option value="routing-default">Routing default</option><option value="pinned">Pinned by role</option></select>
  </label>
  {mode === "pinned" && ROLES.map(role => <label key={role} class="schedule-field"><span>{role} model</span>
   <input type="text" value={pins[role]} placeholder="provider/model" onInput={event => { const value = (event.currentTarget as HTMLInputElement).value; setPins(prev => ({...prev, [role]: value})); }}/>
  </label>)}
  {fieldErrors("/model_policy")}
  {base.recipe_config && <p class="job-meta schedule-readonly">Org review (set in the description, read-only): {base.recipe_config.org}, up to {base.recipe_config.max_reviewers} reviewers.</p>}
  {eff && <div class="schedule-readonly job-meta"><p>Inherited ceilings (read-only, they can only narrow): ${eff.limits.usd}, {eff.limits.tokens} tokens, {eff.limits.child_jobs} child jobs, {eff.limits.parallelism} at once.</p>
   {eff.exclusions.paths?.length ? <p>Excluded paths: {eff.exclusions.paths.join(", ")}</p> : null}
   {eff.notes.map(note => <p key={note}>{note}</p>)}</div>}
  {general.map(text => <p key={text} role="alert" class="schedule-field-error">{text}</p>)}
  <div class="schedule-editor-actions">
   <button type="button" class="schedule-primary" disabled={!ready || [...errors].length > 0} onClick={() => { control.request("save_policy", s.id, {revision: policy.policy?.revision ?? 0, policy: candidate}); }}>Save settings</button>
   <button type="button" onClick={onClose}>Close</button>
  </div>
 </div>;
}
