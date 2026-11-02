/**
 * P2 review guide (docs/viewer-app.md): what a teammate needs to read a handed-off PR, built from recorded reviews,
 * parking, the batched watch and CI only. Reads are confined and bounded; nothing here writes, spawns or fetches.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseChangeRequestUrl } from "../forge-url.ts";
import { redactSecrets } from "../redact-secrets.ts";
import type { ReviewGuide, ReviewGuideStop } from "./api-types.ts";
import { scopedRealpath } from "./file-cache.ts";
import { CI_UNREADABLE, forwardedCi } from "./overview-jobs.ts";
import { nonnegative, parseObject, readBounded, timestamp } from "./overview-read.ts";
import { obj, readObject, str, type Json, type ViewerState } from "./sessions.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;
const ATTEMPTS_MAX = 5;
const EQUIVALENT_MAX = 5;
const STOPS_MAX = 10;
const STOP_CHARS = 400;
const TASK_CHARS = 600;
const RECORD_BYTES = 256 * 1024;
const FLAGS = ["destructive_scope", "scope_growth", "blocking_unknowns"] as const;
const full = (value: unknown): value is string => typeof value === "string" && FULL_SHA.test(value);

interface Verdict {
 name: string; attempt: number; head: string; verdict: string; decided_at: string; model: string | null;
 revisions: string[]; reasons: string[]; flags: string[]; delta_from: string | null;
 equivalent: {head: string; attempt: number} | null; files: number; truncated: boolean;
}
/** One recorded CI outcome event (`ci_observed`) for the job, read by the caller from the job's own run log. */
export interface CiSeen { ci: string; head: string; at: string }

/** `runs/<id>/<name>` only when it is a regular file inside the runs root: a symlink out of it is refused. */
function runFile(state: ViewerState, id: string, name: string): string | undefined {
 try {
  const file = join(scopedRealpath(join(state.stateDir, "runs")), id, name);
  return realpathSync.native(file) === file && statSync(file).isFile() ? file : undefined;
 } catch { return undefined; }
}

function verdictOf(json: Json | undefined, id: string, name: string): Verdict | undefined {
 const stat = obj(json?.diff_stat); const attempt = json?.attempt; const eq = obj(json?.equivalent_to);
 if (!json || json.job_id !== id || !Number.isInteger(attempt) || (attempt as number) < 1 || !full(json.head_sha)) return undefined;
 if (!/^[a-z_]{1,20}$/.test(str(json.verdict) ?? "") || !timestamp(json.decided_at) || !stat || typeof stat.truncated !== "boolean" || nonnegative(stat.files) === null) return undefined;
 const equivalent = eq && full(eq.head_sha) && Number.isInteger(eq.attempt) && (eq.attempt as number) >= 1 ? {head: eq.head_sha, attempt: eq.attempt as number} : null;
 if (eq && !equivalent) return undefined;
 const list = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && /\S/.test(v)) : [];
 const model = str(json.model);
 return {name, attempt: attempt as number, head: json.head_sha, verdict: String(json.verdict), decided_at: json.decided_at, model: model ? clip(model, 120) : null,
  revisions: list(json.revisions), reasons: list(json.reasons), flags: FLAGS.filter(f => obj(json.flags)?.[f] === true),
  delta_from: str(json.delta_from) ?? null, equivalent, files: nonnegative(stat.files)!, truncated: stat.truncated};
}

/** Numbered attempts (newest five) and patch-equivalent passes (target head first); malformed ones counted. */
function readVerdicts(state: ViewerState, id: string, target: string | null): {verdicts: Verdict[]; rejected: number} {
 let names: string[] = [];
 try { names = readdirSync(join(scopedRealpath(join(state.stateDir, "runs")), id)).sort(); } catch { return {verdicts: [], rejected: 0}; }
 const numbered = names.flatMap(n => { const m = /^review-([1-9]\d{0,2})\.json$/.exec(n); return m ? [{n, attempt: Number(m[1])}] : []; })
  .sort((a, b) => a.attempt - b.attempt).slice(-ATTEMPTS_MAX);
 const equivalents = names.filter(n => /^review-equivalent-[0-9a-f]{40}\.json$/.test(n));
 const wanted = target ? `review-equivalent-${target}.json` : "";
 const shown = [...equivalents.filter(n => n === wanted), ...equivalents.filter(n => n !== wanted).slice(-EQUIVALENT_MAX)].slice(0, EQUIVALENT_MAX);
 let rejected = 0; const verdicts: Verdict[] = [];
 const read = (name: string, ok: (v: Verdict) => boolean) => {
  const file = runFile(state, id, name); let text: string | undefined;
  try { text = file ? readBounded(file, RECORD_BYTES) : undefined; } catch { text = undefined; }
  const v = verdictOf(text === undefined ? undefined : parseObject(text), id, name);
  if (v && ok(v)) verdicts.push(v); else rejected++;
 };
 for (const {n, attempt} of numbered) read(n, v => v.attempt === attempt && !v.equivalent);
 for (const n of shown) read(n, v => !!v.equivalent && n === `review-equivalent-${v.head}.json`);
 return {verdicts: verdicts.sort(order), rejected};
}
const order = (a: Verdict, b: Verdict) => a.decided_at.localeCompare(b.decided_at) || a.attempt - b.attempt || a.name.localeCompare(b.name);

function clip(text: string, max: number): string {
 const line = redactSecrets(text.replace(/\s+/g, " ").trim());
 return line.length <= max ? line : `${line.slice(0, max - 1)}\u2026`;
}

/** A verdict's own concerns, revisions before reasons in stored order; identical text in one attempt kept once. */
function stopsOf(v: Verdict, historical: boolean): ReviewGuideStop[] {
 const seen = new Set<string>(); const stops: ReviewGuideStop[] = [];
 for (const list of ["revisions", "reasons"] as const) for (const raw of v[list]) {
  const text = clip(raw, STOP_CHARS);
  if (!text || seen.has(text)) continue;
  seen.add(text);
  stops.push({text, list, attempt: v.equivalent?.attempt ?? v.attempt, head: v.equivalent?.head ?? v.head, verdict: v.verdict, historical});
 }
 return stops;
}

export interface GuideInput {
 id: string; project: string; entry: Json | undefined; task: string | null; pr_url: string | null;
 merged: {at: string; sha: string} | null; ci_seen: CiSeen[];
}

/** The job's guide; null unless handed off (parked) or merged with a retained record. Full-SHA comparisons only. */
export function reviewGuide(state: ViewerState, input: GuideInput): ReviewGuide | null {
 const {id, project, entry, merged} = input;
 const parked = entry?.phase === "awaiting_merge" ? obj(entry.awaiting_merge) : undefined;
 const handed = parked && full(parked.head_sha) ? parked.head_sha : null;
 const cycle = parked && Number.isInteger(parked.cycle) ? parked.cycle as number : null;
 const {verdicts, rejected} = readVerdicts(state, id, handed);
 if (!handed && !(merged && verdicts.length)) return null;
 const prUrl = [str(parked?.pr_url), input.pr_url].find(u => u && parseChangeRequestUrl(u)) ?? null;
 const ref = prUrl ? parseChangeRequestUrl(prUrl) : undefined;
 const incomplete: string[] = [];
 const repoAgrees = !ref || ref.kind !== "github" || !str(parked?.repo) || ref.path === parked!.repo;
 if (!repoAgrees) incomplete.push("The PR link and the recorded repository disagree; no GitHub links are built.");
 const onHanded = handed ? verdicts.filter(v => v.head === handed) : [];
 const selected = (onHanded.length ? onHanded : verdicts).at(-1);
 if (!verdicts.length) incomplete.push("No review record is retained for this job.");
 else if (handed && !onHanded.length) incomplete.push(`No review record names the handed-off head ${handed}; the latest retained record is shown.`);
 if (rejected) incomplete.push(`${rejected} review record${rejected === 1 ? " was" : "s were"} unreadable or malformed and skipped.`);
 if (selected?.equivalent && !verdicts.some(v => !v.equivalent && v.attempt === selected.equivalent!.attempt && v.head === selected.equivalent!.head)) {
  incomplete.push(`The source review (attempt ${selected.equivalent.attempt} on ${selected.equivalent.head}) is not retained.`);
 }
 if (merged) incomplete.push("Retained after merge: a historical summary of local records; later PR activity is not recorded here.");

 // Observations of the PR head from this hand-off cycle only; the parking head is an identity, not an observation.
 const observations: {head: string; at: string; source: "pending" | "watch" | "ci_watch"}[] = [];
 const pending = obj(parked?.pending);
 if (pending && full(pending.head_sha) && timestamp(pending.observed_at)) observations.push({head: pending.head_sha, at: pending.observed_at, source: "pending"});
 const watched = readObject(join(state.stateDir, "awaiting-merge-watch.json"))?.prs;
 const watch = parked && cycle !== null ? (Array.isArray(watched) ? watched.map(obj) : []).find(r => r?.job_id === id && r.cycle === cycle && r.pr_url === parked.pr_url) : undefined;
 if (watch && full(watch.head_sha) && timestamp(watch.observed_at)) observations.push({head: watch.head_sha, at: watch.observed_at, source: "watch"});
 const ciRows = readObject(join(state.stateDir, "ci-watch.json"))?.jobs;
 const ciRow = (Array.isArray(ciRows) ? ciRows.map(obj) : []).find(r => r?.job_id === id);
 const sinceHandoff = (at: string) => !parked || !timestamp(parked.handed_at) || at >= parked.handed_at;
 if (ciRow && full(ciRow.head_sha) && timestamp(ciRow.head_observed_at) && sinceHandoff(ciRow.head_observed_at)) observations.push({head: ciRow.head_sha, at: ciRow.head_observed_at, source: "ci_watch"});
 const observed = merged ? undefined : observations.sort((a, b) => a.at.localeCompare(b.at)).at(-1);

 const freshness: ReviewGuide["freshness"] = merged ? "historical" : !selected ? "unknown" : selected.head !== handed ? "historical"
  : !observed ? "unknown" : observed.head === selected.head ? "current" : "historical";
 const kind: ReviewGuide["kind"] = !selected ? null : selected.equivalent ? "equivalent" : selected.delta_from ? "delta" : "full";
 const github = ref?.kind === "github" && repoAgrees ? `${ref.origin}/${ref.path}` : null;
 const filesHref = !ref || !repoAgrees ? null : ref.kind === "github" ? `${github}/pull/${ref.number}/files` : `${ref.origin}/${ref.path}/-/merge_requests/${ref.number}/diffs`;
 const compareHref = github && kind === "delta" && full(selected!.delta_from) ? `${github}/compare/${selected!.delta_from}..${selected!.head}` : null;
 if (kind === "delta" && !full(selected!.delta_from)) incomplete.push("The recorded delta base is not a full commit id; no comparison link is offered.");

 const stops = selected ? [...stopsOf(selected, false), ...verdicts.filter(v => !v.equivalent && v.attempt < selected.attempt).reverse().flatMap(v => stopsOf(v, true))] : [];

 const reviewed = selected?.head ?? null;
 const unreadable = ciRow?.last_ci === CI_UNREADABLE;
 const watchCi = reviewed && ciRow?.head_sha === reviewed && /^[a-z_]{1,40}$/.test(str(ciRow.last_ci) ?? "") ? String(ciRow.last_ci) : null;
 const event = reviewed && !watchCi ? input.ci_seen.findLast(e => e.head === reviewed) : undefined;
 const ci: ReviewGuide["ci"] = {head: reviewed, state: watchCi ?? event?.ci ?? "missing", source: watchCi ? "watch" : event ? "event" : null,
  at: watchCi ? (timestamp(ciRow?.last_checked_at) ? ciRow!.last_checked_at as string : null) : event?.at ?? null,
  read_failure: unreadable, forwarded: forwardedCi(state, id, reviewed)};

 const activity = [parked?.last_human_activity_at, watch?.last_human_activity_at].filter(timestamp).sort().at(-1) ?? null;
 const required = nonnegative(watch?.approvals_required);
 const handoffState: ReviewGuide["handoff"]["state"] = merged || watch?.state === "merged" ? "merged" : !parked ? "not_parked" : pending ? "pending" : watch?.state === "closed" ? "closed" : "with_team";
 return {
  key: [project, id, prUrl ?? "-", observed?.head ?? "unknown", selected?.attempt ?? "-"].join("|"), project, job_id: id, pr_url: prUrl,
  task: input.task ? clip(input.task, TASK_CHARS) || null : null,
  reviewed_head: reviewed, attempt: selected?.attempt ?? null, verdict: selected?.verdict ?? null, reviewed_at: selected?.decided_at ?? null, model: selected?.model ?? null,
  kind, source_head: selected?.equivalent?.head ?? null, source_attempt: selected?.equivalent?.attempt ?? null,
  delta_from: kind === "delta" ? selected!.delta_from : null, compare_href: compareHref, files_href: filesHref,
  file_count: selected?.files ?? null, truncated: selected?.truncated ?? false, flags: selected?.flags ?? [],
  observed_head: observed?.head ?? null, observed_at: observed?.at ?? null, observed_source: observed?.source ?? null,
  freshness, cycle, handed_head: handed,
  stops: stops.slice(0, STOPS_MAX), omitted_count: Math.max(0, stops.length - STOPS_MAX), ci,
  handoff: {state: handoffState, pending: str(pending?.kind) ?? null, pending_at: timestamp(pending?.observed_at) ? pending!.observed_at as string : null,
   handed_at: timestamp(parked?.handed_at) ? parked!.handed_at as string : null, approvals: watch ? nonnegative(watch.approvals) : null,
   approvals_required: required === null ? null : Math.floor(required), last_human_activity_at: activity, watched_at: watch && timestamp(watch.observed_at) ? watch.observed_at : null,
   merged_at: merged?.at ?? null, merge_sha: merged?.sha ?? null},
  incomplete,
 };
}
