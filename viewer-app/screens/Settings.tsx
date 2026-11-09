import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { RoutingRule, SettingField, SettingFieldView, SettingKey, SettingValue, ThinkingLevel } from "../../src/contracts.ts";
import type { ModelApplyRow, SettingsAuditRow, SettingsResponse } from "../../src/viewer/api-types.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { ParentRestart } from "../components/ParentRestart.tsx";
import { type Cli, type CliChoices, cliChoices, cliError, type Drafts, fieldError, fieldOf, type RestoreSelector, type SettingsView, valueOf } from "../settings-control.ts";
import "./settings.css";

/** The browser bundle takes no values from src/contracts.ts; the type pins this list to `ThinkingLevel`. */
const THINKING: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODEL_PATTERN = "[^\\s/]+/\\S+";
/** The "Custom…" option's value: never a model id, which always has a slash. */
const CUSTOM = "custom";
const MAX_FALLBACKS = 4;
const PEOPLE_MODELS: SettingKey[] = ["models.parent_driver", "models.parent", "models.parent_thinking", "models.operator", "models.operator_thinking"];
const ROUTING: SettingKey[] = ["models.rubric", "workers.driver"];
const CLI_LABEL: Record<string, string> = {pi: "pi", claude: "Claude CLI"};
/** The shipped and flip-era rubric ids in words; any other row shows its id alone. */
const ROW_LABEL: Record<string, string> = {"planner-default": "Planner", "small-ship": "Small ship", "big-ship": "Big ship", "risky-any": "Risky (any job)", "risky-ship": "Risky ship", reviews: "Reviews", "research-big": "Big research", "native-research": "Native research"};
const rowName = (id: string) => ROW_LABEL[id] ? `${ROW_LABEL[id]} (${id})` : id;
const GRANTS: SettingKey[] = ["grants.expiry_hours", "grants.spend_usd", "grants.spend_tokens", "grants.token_ceiling", "grants.job_cap", "grants.dispatch_parallelism", "grants.allowed_actions", "grants.ask_on", "grants.exclude_paths"];
const COMPACTION: SettingKey[] = ["sessions.parent_compact_at_tokens", "sessions.operator_compact_at_tokens"];
const VIEWER: SettingKey[] = ["viewer.public_url", "viewer.strict_host"];
const WORKERS: SettingKey[] = ["workers.native_claude_research"];
const lines = (text: string): string[] => text.split(/[\n,]/).map(line => line.trim()).filter(Boolean);
const pick = (drafts: Drafts, keys: SettingKey[]): Drafts => Object.fromEntries(keys.filter(key => key in drafts).map(key => [key, drafts[key]]));
const omit = (drafts: Drafts, keys: SettingKey[]): Drafts => Object.fromEntries(Object.entries(drafts).filter(([key]) => !keys.includes(key as SettingKey)));

function auditLine(row: SettingsAuditRow | ModelApplyRow): string {
 if (row.type === "model_apply") return `${row.at} · ${row.session} model ${row.state}${row.reason ? `: ${row.reason}` : ""}`;
 const reason = typeof row.reason === "string" ? `: ${row.reason}` : "";
 const mode = typeof row.mode === "string" ? ` ${row.mode}` : "";
 return `${row.at} · ${row.type}${mode}${reason}`;
}

/** The latest `state/model-apply.jsonl` row of one session, in words. */
function applyText(row: ModelApplyRow): string {
 if (row.state === "queued") return `Applies to the ${row.session} when its current turn ends (a stopped ${row.session} takes it at its next start)`;
 if (row.state === "applied") return `Applied ${row.model ?? "the running model"} · thinking ${row.thinking ?? "unchanged"} at ${row.at}`;
 if (row.state === "cancelled") return row.reason === "changed back before it applied" ? "Cancelled: changed back before it applied" : `Cancelled: ${row.reason ?? "no reason recorded"}`;
 return `Not applied: ${row.reason ?? "no reason recorded"}`;
}

function ApplyStatus({rows}: {rows: ModelApplyRow[]}) {
 const latest = (["parent", "operator"] as const).flatMap(session => rows.filter(row => row.session === session).slice(-1));
 return <>{latest.map(row => <p key={row.session} class={`settings-apply settings-apply-${row.state}`} role="status" data-session={row.session}>{row.session === "parent" ? "Parent" : "Operator"}: {applyText(row)}</p>)}</>;
}
const rowEdited = (row: RoutingRule, was: RoutingRule | undefined): boolean => JSON.stringify(row) !== JSON.stringify(was);


function Section({title, help, keys, drafts, setDrafts, view, restore, restoreText, disabled, invalid, unsavedCount, children}: {title: string; help: string; keys: SettingKey[]; drafts: Drafts; setDrafts: (next: (drafts: Drafts) => Drafts) => void; view: SettingsView; restore: RestoreSelector | null; restoreText: string; disabled: boolean; invalid?: boolean; unsavedCount?: number; children: ComponentChildren}) {
 const changes = pick(drafts, keys);
 const unsaved = unsavedCount ?? Object.keys(changes).length;
 const [busy, setBusy] = useState(false);
 // Only this section's own write locks its buttons: another section's click queues behind it instead of being dropped.
 const run = async (write: () => Promise<boolean>) => {
  if (busy) return;
  setBusy(true);
  try { if (await write()) setDrafts(current => omit(current, keys)); } finally { setBusy(false); }
 };
 const reset = () => { if (restore && (globalThis.confirm?.(restoreText) ?? true)) void run(() => view.restore(restore)); };
 return <section class="settings-section" aria-label={title}>
  <h2>{title}</h2>
  <p class="settings-help">{help}</p>
  <div class="settings-body">{children}</div>
  {restore && <div class="settings-actions">
   <button type="button" class="settings-primary" disabled={disabled || busy || invalid || !Object.keys(changes).length} onClick={() => void run(() => view.save(changes))}>Save</button>
   <button type="button" disabled={disabled || busy} onClick={reset}>Restore defaults</button>
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
function ModelSelect({id, name, label, value, set, models, unset, required, disabled, outside = "not in pi's list"}: {id?: string; name?: string; label: string; value: string; set: (value: string) => void; models: string[] | null | undefined; unset?: boolean; required?: boolean; disabled: boolean; outside?: string}) {
 const [custom, setCustom] = useState(false);
 const list = models?.length ? models : null;
 return <div class="settings-model">
  <select id={id} aria-label={name} value={custom ? CUSTOM : value} disabled={disabled} onChange={event => {
   const next = event.currentTarget.value;
   setCustom(next === CUSTOM);
   if (next !== CUSTOM) set(next);
  }}>
   {unset && <option value="">(unset)</option>}
   {value && !list?.includes(value) && <option value={value}>{list ? `${value} (${outside})` : value}</option>}
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
 return <div class="settings-model settings-chip settings-add">
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

/** The one CLI every worker type runs; when the rows disagree it says so and offers both. */
function WorkersCli({field, cli, saved, set, disabled}: {field: SettingField | undefined; cli: Cli | null; saved: SettingFieldView | undefined; set: (cli: string) => void; disabled: boolean}) {
 if (!field) return null;
 return <div class="settings-field settings-cli">
  <label for="setting-workers-driver">{field.label} <span class="settings-meta">{saved?.source ? `from ${saved.source}` : ""}</span></label>
  <p class="settings-help">{field.help}</p>
  <select id="setting-workers-driver" value={cli ?? ""} disabled={disabled} onChange={event => set(event.currentTarget.value)}>
   {cli === null && <option value="" disabled>(rows disagree)</option>}
   {(field.enum ?? []).map(value => <option key={value} value={value}>{CLI_LABEL[value] ?? value}</option>)}
  </select>
  {saved?.diagnostic && <small class="settings-meta settings-cli-note">{saved.diagnostic}</small>}
 </div>;
}

/** `choices` filter each row's model and thinking by the workers CLI; fallbacks keep pi's whole list. */
function Rubric({rows, original, setRow, disabled, models, choices, errors}: {rows: RoutingRule[]; original: RoutingRule[]; setRow: (index: number, patch: Partial<RoutingRule>) => void; disabled: boolean; models: string[] | null | undefined; choices: CliChoices; errors: (string | null)[]}) {
 return <ol class="settings-rules"><li class="settings-rules-head" aria-hidden="true"><span>Rule</span><span>Model</span><span>Fallbacks, in order</span><span>Thinking</span></li>{rows.map((row, index) => {
  const fallbacks = row.fallbacks ?? [];
  const error = errors[index];
  return <li key={row.id} class={`settings-rule${rowEdited(row, original[index]) ? " settings-rule-edited" : ""}${error ? " settings-rule-invalid" : ""}`}>
  <div class="settings-rule-head">{ROW_LABEL[row.id] && <strong class="settings-rule-name">{ROW_LABEL[row.id]}</strong>}<code>{row.id}</code><span class="settings-chips" title={row.note}>{[row.role, row.scope?.join("/"), row.risk && `risk:${row.risk}`, row.project].filter(Boolean).join(" · ")}</span></div>
  <label><span class="settings-label">Model</span><ModelSelect label={`Model of ${row.id}`} value={row.model} set={model => setRow(index, {model})} models={choices.models} required disabled={disabled} outside={choices.cli === "claude" && choices.native && !choices.native.test(row.model) ? "not a Claude model" : undefined}/><ModelNote models={models} values={[row.model]}/></label>
  <div class="settings-fallbacks" role="group" aria-label={`Fallbacks of ${row.id}`}><span class="settings-label">Fallbacks</span>
   {fallbacks.map((fallback, at) => <span key={at} class="settings-chip">
    <ModelSelect name={`Fallback ${at + 1} of ${row.id}`} label={`Fallback ${at + 1} of ${row.id}`} value={fallback} set={next => setRow(index, {fallbacks: fallbacks.map((item, i) => i === at ? next : item)})} models={models} required disabled={disabled}/>
    <button type="button" aria-label={`Remove fallback ${fallback || at + 1} from ${row.id}`} disabled={disabled} onClick={() => setRow(index, {fallbacks: fallbacks.filter((_, i) => i !== at)})}>×</button>
   </span>)}
   {fallbacks.length < MAX_FALLBACKS && <AddFallback rowId={row.id} models={models} disabled={disabled} add={added => { if (!fallbacks.includes(added)) setRow(index, {fallbacks: [...fallbacks, added]}); }}/>}
   <ModelNote models={models} values={fallbacks}/></div>
  <label><span class="settings-label">Thinking</span><select value={row.thinking ?? ""} disabled={disabled} onChange={event => setRow(index, {thinking: (event.currentTarget.value || undefined) as ThinkingLevel | undefined})}>
   <option value="">profile default</option>
   {row.thinking && !choices.efforts.includes(row.thinking) && <option value={row.thinking}>{row.thinking}</option>}
   {choices.efforts.map(level => <option key={level} value={level}>{level}</option>)}
  </select></label>
  {error && <small class="settings-warn settings-rule-error" role="alert">{error}</small>}
 </li>;
 })}</ol>;
}

/** What is in force now and where it comes from; an off or fallen-back value says why. */
function Effective({field}: {field: SettingFieldView | undefined}) {
 if (!field) return null;
 const why = field.diagnostic ? `: ${field.diagnostic}` : "";
 return <p class="settings-meta settings-effective" role="status">{field.status === "disabled" ? `Off${why}` : `In force: ${String(field.value)} tokens, from ${field.source}${why}`}</p>;
}

/** `choices` (a parent field's CLI) filter its models and levels; `models` stays pi's list for the note. */
function Field({field, value, source, error, set, disabled, models, choices}: {field: SettingField; value: SettingValue | undefined; source: string | undefined; error?: string | null; set: (value: SettingValue) => void; disabled: boolean; models: string[] | null | undefined; choices?: CliChoices}) {
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
   ? <ModelSelect id={id} label={field.label} value={typeof value === "string" ? value : ""} set={next => set(next || null)} models={choices?.models ?? models} unset disabled={disabled} outside={choices?.cli === "claude" && choices.native && typeof value === "string" && !choices.native.test(value) ? "not a Claude model" : undefined}/>
   : field.type === "thinking_level"
   ? <select id={id} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => set(event.currentTarget.value || null)}><option value="">(unset)</option>{typeof value === "string" && choices && !choices.efforts.includes(value) && <option value={value}>{value}</option>}{(choices?.efforts ?? THINKING).map(level => <option key={level} value={level}>{level}</option>)}</select>
   : field.type === "driver"
   ? <select id={id} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => set(event.currentTarget.value)}>{(field.enum ?? []).map(cli => <option key={cli} value={cli}>{CLI_LABEL[cli] ?? cli}</option>)}</select>
   : field.type === "url"
   ? <input id={id} type="text" inputMode="url" spellcheck={false} autoComplete="off" placeholder="https://dash.example.test/" value={typeof value === "string" ? value : ""} aria-invalid={error ? true : undefined} disabled={disabled} onInput={event => set(event.currentTarget.value.trim() || null)}/>
   : field.type === "boolean"
   ? <div class="settings-checks"><label><input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={event => set(event.currentTarget.checked)}/>{value === true ? "On" : "Off"}</label></div>
   : <input id={id} type="number" value={typeof value === "number" ? String(value) : ""} min={field.minimum ?? field.exclusive_minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} aria-invalid={error ? true : undefined} disabled={disabled} onInput={event => set(event.currentTarget.value === "" ? null : Number(event.currentTarget.value))}/>;
 return <div class="settings-field"><label for={id}>{field.label} {meta}</label><p class="settings-help">{field.help}</p>{input}{error && <small class="settings-warn" role="alert">{error}</small>}{field.type === "model_ref" && typeof value === "string" && <ModelNote models={models} values={[value]}/>}</div>;
}

/** `children`: Devices and Notifications (remote dashboard PR 3), shown even while operator Settings are loading or unavailable. */
export function Settings({view, children}: {view: SettingsView; children?: ComponentChildren}) {
 const [drafts, setDrafts] = useState<Drafts>({});
 const status = view.status;
 const header = <header class="settings-heading"><PageHeader title="Settings" context="This machine"/></header>;
 if (!status) return <div class="settings-screen">{header}<p role="status">Loading</p>{children}</div>;
 if ("error" in status || !status.snapshot || !status.catalog) return <div class="settings-screen">{header}<p role="alert" class="overview-error">Settings unavailable: {"error" in status ? status.error : status.reason ?? "no snapshot"}</p>{children}</div>;
 const data: SettingsResponse = status;
 const disabled = !data.writable || !view.token;
 const editing = disabled || view.busy;
 const set = (key: SettingKey, value: SettingValue) => setDrafts(current => ({...current, [key]: value}));
 const view_ = (key: SettingKey) => data.snapshot?.fields.find(field => field.key === key);
 const routingAbsent = status.snapshot.owners.find(owner => owner.owner === "routing")?.state === "absent";
 const rows = (valueOf(data, drafts, "models.rubric") ?? []) as RoutingRule[];
 const original = (view_("models.rubric")?.value ?? []) as RoutingRule[];
 const setRow = (index: number, patch: Partial<RoutingRule>) => set("models.rubric", rows.map((row, at) => {
  if (at !== index) return row;
  const next: RoutingRule = {...row, ...patch};
  if (!next.thinking) delete next.thinking;
  if (!next.fallbacks?.length) delete next.fallbacks;
  return next;
 }) as SettingValue);
 const models = data.available_models;
 const cliOf = (key: SettingKey): Cli | null => { const cli = valueOf(data, drafts, key); return cli === "pi" || cli === "claude" ? cli : null; };
 // Picking the saved CLI again drops the draft, so an unchanged switch never posts.
 const setCli = (key: SettingKey, cli: SettingValue) => setDrafts(current => cli === view_(key)?.value ? omit(current, [key]) : {...current, [key]: cli});
 const workersCli = cliOf("workers.driver");
 const routeChoices = cliChoices(data, workersCli, THINKING);
 const rowErrors = rows.map(row => cliError(routeChoices, row.model, row.thinking));
 const needNew = rows.filter((_, index) => rowErrors[index]).map(row => rowName(row.id));
 const parentChoices = cliChoices(data, cliOf("models.parent_driver"), THINKING);
 const parentModel = valueOf(data, drafts, "models.parent"), parentThinking = valueOf(data, drafts, "models.parent_thinking");
 const parentErrors: Partial<Record<SettingKey, string | null>> = {
  "models.parent": cliError(parentChoices, typeof parentModel === "string" ? parentModel : null, null),
  "models.parent_thinking": cliError(parentChoices, null, typeof parentThinking === "string" ? parentThinking : null),
 };
 const field = (key: SettingKey) => {
  const spec = fieldOf(data, key);
  // A server refusal (a bad Public URL) shows under its field too, beside the notice's list.
  const refused = view.notice?.kind === "error" ? view.notice.errors.find(error => error.includes(key)) ?? null : null;
  const parent = key === "models.parent" || key === "models.parent_thinking";
  return spec && <Field key={key} field={spec} value={valueOf(data, drafts, key)} source={view_(key)?.source} error={parentErrors[key] ?? (key in drafts ? fieldError(spec, drafts[key]) ?? refused : null)} set={value => spec.type === "driver" ? setCli(key, value) : set(key, value)} disabled={editing} models={models} choices={parent ? parentChoices : undefined}/>;
 };
 const invalid = (keys: SettingKey[]) => keys.some(key => { const spec = fieldOf(data, key); return !!parentErrors[key] || (!!spec && key in drafts && fieldError(spec, drafts[key]) !== null); });
 const modelsNote = models === null ? <p class="settings-readonly" role="status">{data.models_loading ? "Loading the model list…" : `Model list unavailable${data.models_error ? ` (${data.models_error})` : ""}: type a provider/model.`}</p> : null;
 const notice = view.notice;
 const recent = [...data.audit, ...(data.model_apply ?? [])].sort((a, b) => a.at.localeCompare(b.at)).slice(-5).reverse();
 return <div class="settings-screen">
  {header}
  {!data.writable || !view.token ? <p role="status" class="settings-readonly">Read only: {data.reason ?? "no operator session serves dashboard control; start it to change settings"}</p> : null}
  {notice && <div role={notice.kind === "ok" ? "status" : "alert"} class={`settings-notice settings-${notice.kind}`}><p>{notice.text}</p>{notice.errors.length > 0 && <ul>{notice.errors.map(error => <li key={error}>{error}</li>)}</ul>}</div>}
  <Section title="Model routing" help="First matching rule wins. The workers CLI, model, fallbacks and thinking apply from the next job or review; role, scope and risk stay fixed." keys={ROUTING} drafts={drafts} setDrafts={setDrafts} view={view} restore={routingAbsent ? null : {keys: ROUTING}} restoreText="Restore the shipped model, fallbacks and thinking on every rubric row whose id matches, and pi for every worker (native switches off)? Rows you added stay." disabled={disabled} invalid={needNew.length > 0} unsavedCount={rows.filter((row, index) => rowEdited(row, original[index])).length + ("workers.driver" in drafts ? 1 : 0)}>
   {routingAbsent ? <p class="settings-readonly">No data/routing.json: every worker route is refused until it exists.</p> : <>
    <WorkersCli field={fieldOf(data, "workers.driver")} cli={workersCli} saved={view_("workers.driver")} set={cli => setCli("workers.driver", cli)} disabled={editing}/>
    {needNew.length > 0 && <p class="settings-warn settings-cli-block" role="alert">The Claude CLI needs a new model or effort on {needNew.join(", ")}. Save stays off until each row is valid.</p>}
    <Rubric rows={rows} original={original} setRow={setRow} disabled={editing} models={models} choices={routeChoices} errors={rowErrors}/>
   </>}
   {modelsNote}
  </Section>
  <Section title="Parent and operator models" help="Empty means unset. A model or thinking change switches the running session at its next idle point. The Parent CLI applies only when the parent restarts; nothing restarts on its own." keys={PEOPLE_MODELS} drafts={drafts} setDrafts={setDrafts} view={view} restore={{keys: PEOPLE_MODELS}} restoreText="Unset the parent and operator models and thinking, and put the parent back on pi (from its next start)?" disabled={disabled} invalid={invalid(PEOPLE_MODELS)}>
   {PEOPLE_MODELS.map(field)}
   <ApplyStatus rows={data.model_apply ?? []}/>
   {view.restart && <div class="settings-restart"><p class="settings-meta" role="status">Parent CLI saved: the parent keeps its current CLI until it restarts. Restart it here once the fleet is drained.</p><ParentRestart status={view.control}/></div>}
  </Section>
  <Section title="Grant defaults" help="What a new grant starts with (data/mandate-defaults.json); grants already issued keep theirs." keys={GRANTS} drafts={drafts} setDrafts={setDrafts} view={view} restore={{section: "grants"}} restoreText="Restore every grant default?" disabled={disabled} invalid={invalid(GRANTS)}>
   {GRANTS.map(field)}
  </Section>
  <Section title="Auto-compaction" help="A session compacts once its context reaches this many tokens; a change takes effect at the next compaction check. A whole number of at least 1: an invalid parent value turns parent auto-compaction off." keys={COMPACTION} drafts={drafts} setDrafts={setDrafts} view={view} restore={{keys: COMPACTION}} restoreText="Restore the parent and operator compaction thresholds to their defaults?" disabled={disabled} invalid={invalid(COMPACTION)}>
   {COMPACTION.flatMap(key => [field(key), <Effective key={`${key}-effective`} field={view_(key)}/>])}
  </Section>
  <Section title="Dashboard address" help="Public URL applies to the next board or report link; the Host pin applies to the next dashboard request. Neither restarts anything." keys={VIEWER} drafts={drafts} setDrafts={setDrafts} view={view} restore={{keys: VIEWER}} restoreText="Unset the public URL and turn the Host pin off?" disabled={disabled}>
   {VIEWER.map(field)}
  </Section>
  <Section title="Native workers" help="Off by default, and pi stays every job's driver; no shipped routing rule names claude. The Workers CLI under Model routing sets this switch too: on with the Claude CLI, off with pi." keys={WORKERS} drafts={drafts} setDrafts={setDrafts} view={view} restore={{keys: WORKERS}} restoreText="Turn Claude CLI research workers off?" disabled={disabled}>
   {WORKERS.map(field)}
  </Section>
  {children}
  <footer class="settings-audit"><h2>Recent changes</h2>{recent.length ? <ul>{recent.map((row, index) => <li key={`${row.at}-${index}`} class="job-meta">{auditLine(row)}</li>)}</ul> : <p class="job-meta">No settings change recorded</p>}</footer>
 </div>;
}
