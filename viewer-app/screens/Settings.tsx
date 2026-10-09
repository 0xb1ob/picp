import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { RoutingRule, SettingField, SettingKey, SettingValue, ThinkingLevel } from "../../src/contracts.ts";
import type { SettingsAuditRow, SettingsResponse } from "../../src/viewer/api-types.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { type Drafts, fieldOf, type RestoreSelector, type SettingsView, valueOf } from "../settings-control.ts";
import "./settings.css";

/** The browser bundle takes no values from src/contracts.ts; the type pins this list to `ThinkingLevel`. */
const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_PATTERN = "[^\\s/]+/\\S+";
/** The "Custom…" option's value: never a model id, which always has a slash. */
const CUSTOM = "custom";
const MAX_FALLBACKS = 4;
const PEOPLE_MODELS: SettingKey[] = ["models.parent", "models.operator"];
const GRANTS: SettingKey[] = ["grants.expiry_hours", "grants.spend_usd", "grants.spend_tokens", "grants.token_ceiling", "grants.job_cap", "grants.dispatch_parallelism", "grants.allowed_actions", "grants.ask_on", "grants.exclude_paths"];
const lines = (text: string): string[] => text.split(/[\n,]/).map(line => line.trim()).filter(Boolean);
const pick = (drafts: Drafts, keys: SettingKey[]): Drafts => Object.fromEntries(keys.filter(key => key in drafts).map(key => [key, drafts[key]]));
const omit = (drafts: Drafts, keys: SettingKey[]): Drafts => Object.fromEntries(Object.entries(drafts).filter(([key]) => !keys.includes(key as SettingKey)));

function auditLine(row: SettingsAuditRow): string {
 const reason = typeof row.reason === "string" ? `: ${row.reason}` : "";
 const mode = typeof row.mode === "string" ? ` ${row.mode}` : "";
 return `${row.at} · ${row.type}${mode}${reason}`;
}

function Section({title, help, keys, drafts, setDrafts, view, restore, restoreText, disabled, children}: {title: string; help: string; keys: SettingKey[]; drafts: Drafts; setDrafts: (next: (drafts: Drafts) => Drafts) => void; view: SettingsView; restore: RestoreSelector | null; restoreText: string; disabled: boolean; children: ComponentChildren}) {
 const changes = pick(drafts, keys);
 const unsaved = Object.keys(changes).length;
 const save = async () => { if (await view.save(changes)) setDrafts(current => omit(current, keys)); };
 const reset = async () => {
  if (!restore || !(globalThis.confirm?.(restoreText) ?? true)) return;
  if (await view.restore(restore)) setDrafts(current => omit(current, keys));
 };
 return <section class="settings-section" aria-label={title}>
  <h2>{title}</h2>
  <p class="settings-help">{help}</p>
  {children}
  {restore && <div class="settings-actions">
   <button type="button" class="settings-primary" disabled={disabled || !Object.keys(changes).length} onClick={() => void save()}>Save</button>
   <button type="button" disabled={disabled} onClick={() => void reset()}>Restore defaults</button>
   {unsaved > 0 && <span class="settings-unsaved">{unsaved} unsaved change{unsaved === 1 ? "" : "s"}</span>}
  </div>}
 </section>;
}
/** The inline note under a model input: unlisted values (free text stays allowed) or an unavailable list. */
function ModelNote({models, values}: {models: string[] | null | undefined; values: string[]}) {
 const unlisted = models ? values.filter(value => value && !models.includes(value)) : [];
 return unlisted.length ? <small class="settings-warn" role="status">Not in pi's model list: {unlisted.join(", ")}. It can still be saved.</small> : null;
}

/** pi's models as `<optgroup>`s per provider (the part before the first slash), each alphabetical. */
function ModelGroups({models}: {models: string[]}) {
 const groups = new Map<string, string[]>();
 for (const model of [...models].sort((a, b) => a.localeCompare(b))) {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "other";
  groups.set(provider, [...(groups.get(provider) ?? []), model]);
 }
 return <>{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, ids]) => <optgroup key={provider} label={provider}>{ids.map(id => <option key={id} value={id}>{id}</option>)}</optgroup>)}</>;
}

/** One model dropdown: (unset) where allowed, the current value kept even when pi lacks it, pi's models, then "Custom…" for a typed id. */
function ModelSelect({id, name, label, value, set, models, unset, required, disabled}: {id?: string; name?: string; label: string; value: string; set: (value: string) => void; models: string[] | null | undefined; unset?: boolean; required?: boolean; disabled: boolean}) {
 const [custom, setCustom] = useState(false);
 const list = models?.length ? models : null;
 return <div class="settings-model">
  <select id={id} aria-label={name} value={custom ? CUSTOM : value} disabled={disabled} onChange={event => {
   const next = event.currentTarget.value;
   setCustom(next === CUSTOM);
   if (next !== CUSTOM) set(next);
  }}>
   {unset && <option value="">(unset)</option>}
   {value && !list?.includes(value) && <option value={value}>{list ? `${value} (not in pi's list)` : value}</option>}
   {list && <ModelGroups models={list}/>}
   <option value={CUSTOM}>Custom…</option>
  </select>
  {custom && <input type="text" aria-label={`${label}: custom id`} value={value} pattern={MODEL_PATTERN} required={required} placeholder="provider/model" disabled={disabled} spellcheck={false} onInput={event => set(event.currentTarget.value.trim())}/>}
 </div>;
}

/** The "Add fallback" dropdown: picking a model appends it; "Custom…" takes a typed id, appended on change. */
function AddFallback({rowId, models, add, disabled}: {rowId: string; models: string[] | null | undefined; add: (model: string) => void; disabled: boolean}) {
 const [custom, setCustom] = useState(false);
 const list = models?.length ? models : null;
 return <div class="settings-model">
  <select aria-label={`Add a fallback to ${rowId}`} value={custom ? CUSTOM : ""} disabled={disabled} onChange={event => {
   const next = event.currentTarget.value;
   setCustom(next === CUSTOM);
   if (next && next !== CUSTOM) add(next);
  }}>
   <option value="">Add fallback…</option>
   {list && <ModelGroups models={list}/>}
   <option value={CUSTOM}>Custom…</option>
  </select>
  {custom && <input type="text" aria-label={`Add a fallback to ${rowId}: custom id`} pattern={MODEL_PATTERN} placeholder="provider/model" disabled={disabled} spellcheck={false} onChange={event => {
   const added = event.currentTarget.value.trim();
   if (!added) return;
   setCustom(false);
   add(added);
  }}/>}
 </div>;
}

function Rubric({rows, setRow, disabled, models}: {rows: RoutingRule[]; setRow: (index: number, patch: Partial<RoutingRule>) => void; disabled: boolean; models: string[] | null | undefined}) {
 return <ol class="settings-rules"><li class="settings-rules-head" aria-hidden="true"><span>Rule</span><span>Model</span><span>Fallbacks, in order</span><span>Thinking</span></li>{rows.map((row, index) => {
  const fallbacks = row.fallbacks ?? [];
  return <li key={row.id} class="settings-rule">
  <div class="settings-rule-head"><code>{row.id}</code><span class="settings-chips" title={row.note}>{[row.role, row.scope?.join("/"), row.risk && `risk:${row.risk}`, row.project].filter(Boolean).join(" · ")}</span></div>
  <label><span class="settings-label">Model</span><ModelSelect label={`Model of ${row.id}`} value={row.model} set={model => setRow(index, {model})} models={models} required disabled={disabled}/><ModelNote models={models} values={[row.model]}/></label>
  <div class="settings-fallbacks" role="group" aria-label={`Fallbacks of ${row.id}`}><span class="settings-label">Fallbacks</span>
   {fallbacks.map((fallback, at) => <div key={at} class="settings-fallback">
    <ModelSelect name={`Fallback ${at + 1} of ${row.id}`} label={`Fallback ${at + 1} of ${row.id}`} value={fallback} set={next => setRow(index, {fallbacks: fallbacks.map((item, i) => i === at ? next : item)})} models={models} required disabled={disabled}/>
    <button type="button" aria-label={`Remove fallback ${fallback || at + 1} from ${row.id}`} disabled={disabled} onClick={() => setRow(index, {fallbacks: fallbacks.filter((_, i) => i !== at)})}>×</button>
   </div>)}
   {fallbacks.length < MAX_FALLBACKS && <AddFallback rowId={row.id} models={models} disabled={disabled} add={added => { if (!fallbacks.includes(added)) setRow(index, {fallbacks: [...fallbacks, added]}); }}/>}
   <ModelNote models={models} values={fallbacks}/></div>
  <label><span class="settings-label">Thinking</span><select value={row.thinking ?? ""} disabled={disabled} onChange={event => setRow(index, {thinking: (event.currentTarget.value || undefined) as ThinkingLevel | undefined})}>
   <option value="">profile default</option>
   {THINKING.map(level => <option key={level} value={level}>{level}</option>)}
  </select></label>
 </li>;
 })}</ol>;
}

function Field({field, value, source, set, disabled, models}: {field: SettingField; value: SettingValue | undefined; source: string | undefined; set: (value: SettingValue) => void; disabled: boolean; models: string[] | null | undefined}) {
 const id = `setting-${field.key.replace(/\./g, "-")}`;
 const meta = <span class="settings-meta">{source ? `from ${source}` : ""}</span>;
 if (field.type === "enum_list") {
  const chosen = Array.isArray(value) ? value as string[] : [];
  return <fieldset class="settings-field" disabled={disabled}><legend>{field.label} {meta}</legend><p class="settings-help">{field.help}</p>
   <div class="settings-checks">{(field.enum ?? []).map(option => <label key={option}><input type="checkbox" checked={chosen.includes(option)} onChange={event => set(event.currentTarget.checked ? [...chosen, option] : chosen.filter(item => item !== option))}/>{option}</label>)}</div>
  </fieldset>;
 }
 const input = field.type === "string_list"
  ? <textarea id={id} rows={3} disabled={disabled} onChange={event => set(lines(event.currentTarget.value))} value={Array.isArray(value) ? (value as string[]).join("\n") : ""}/>
  : field.type === "model_ref"
   ? <ModelSelect id={id} label={field.label} value={typeof value === "string" ? value : ""} set={next => set(next || null)} models={models} unset disabled={disabled}/>
   : <input id={id} type="number" value={typeof value === "number" ? String(value) : ""} min={field.minimum ?? field.exclusive_minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} disabled={disabled} onInput={event => set(event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}/>;
 return <div class="settings-field"><label for={id}>{field.label} {meta}</label><p class="settings-help">{field.help}</p>{input}{field.type === "model_ref" && typeof value === "string" && <ModelNote models={models} values={[value]}/>}</div>;
}

export function Settings({view}: {view: SettingsView}) {
 const [drafts, setDrafts] = useState<Drafts>({});
 const status = view.status;
 const header = <header class="settings-heading"><PageHeader title="Settings" context="This machine"/></header>;
 if (!status) return <div class="settings-screen">{header}<p role="status">Loading</p></div>;
 if ("error" in status || !status.snapshot || !status.catalog) return <div class="settings-screen">{header}<p role="alert" class="overview-error">Settings unavailable: {"error" in status ? status.error : status.reason ?? "no snapshot"}</p></div>;
 const data: SettingsResponse = status;
 const disabled = !data.writable || !view.token || view.busy;
 const set = (key: SettingKey, value: SettingValue) => setDrafts(current => ({...current, [key]: value}));
 const view_ = (key: SettingKey) => data.snapshot?.fields.find(field => field.key === key);
 const routingAbsent = status.snapshot.owners.find(owner => owner.owner === "routing")?.state === "absent";
 const rows = (valueOf(data, drafts, "models.rubric") ?? []) as RoutingRule[];
 const setRow = (index: number, patch: Partial<RoutingRule>) => set("models.rubric", rows.map((row, at) => {
  if (at !== index) return row;
  const next: RoutingRule = {...row, ...patch};
  if (!next.thinking) delete next.thinking;
  if (!next.fallbacks?.length) delete next.fallbacks;
  return next;
 }) as SettingValue);
 const field = (key: SettingKey) => {
  const spec = fieldOf(data, key);
  return spec && <Field key={key} field={spec} value={valueOf(data, drafts, key)} source={view_(key)?.source} set={value => set(key, value)} disabled={disabled} models={models}/>;
 };
 const models = data.available_models;
 const modelsNote = models === null ? <p class="settings-readonly" role="status">{data.models_loading ? "Loading the model list…" : `Model list unavailable${data.models_error ? ` (${data.models_error})` : ""}: type a provider/model.`}</p> : null;
 const notice = view.notice;
 return <div class="settings-screen">
  {header}
  {!data.writable || !view.token ? <p role="status" class="settings-readonly">Read only: {data.reason ?? "no operator session serves dashboard control; start it to change settings"}</p> : null}
  {notice && <div role={notice.kind === "ok" ? "status" : "alert"} class={`settings-notice settings-${notice.kind}`}><p>{notice.text}</p>{notice.errors.length > 0 && <ul>{notice.errors.map(error => <li key={error}>{error}</li>)}</ul>}</div>}
  <Section title="Model routing" help="First matching rule wins. Model, fallbacks and thinking apply from the next job or review; role, scope and risk stay fixed." keys={["models.rubric"]} drafts={drafts} setDrafts={setDrafts} view={view} restore={routingAbsent ? null : {keys: ["models.rubric"]}} restoreText="Restore the shipped model, fallbacks and thinking on every rubric row whose id matches? Rows you added stay." disabled={disabled}>
   {routingAbsent ? <p class="settings-readonly">No data/routing.json: workers use each profile's own model.</p> : <Rubric rows={rows} setRow={setRow} disabled={disabled} models={models}/>}
   {modelsNote}
  </Section>
  <Section title="Parent and operator models" help="Empty means unset: the env pin, else today's behaviour. Nothing switches live." keys={PEOPLE_MODELS} drafts={drafts} setDrafts={setDrafts} view={view} restore={{keys: PEOPLE_MODELS}} restoreText="Unset the parent and operator models?" disabled={disabled}>
   {PEOPLE_MODELS.map(field)}
  </Section>
  <Section title="Grant defaults" help="What a new grant starts with (data/mandate-defaults.json); grants already issued keep theirs." keys={GRANTS} drafts={drafts} setDrafts={setDrafts} view={view} restore={{section: "grants"}} restoreText="Restore every grant default?" disabled={disabled}>
   {GRANTS.map(field)}
  </Section>
  <footer class="settings-audit"><h2>Recent changes</h2>{data.audit.length ? <ul>{data.audit.slice(-5).reverse().map((row, index) => <li key={`${row.at}-${index}`} class="job-meta">{auditLine(row)}</li>)}</ul> : <p class="job-meta">No settings change recorded</p>}</footer>
 </div>;
}
