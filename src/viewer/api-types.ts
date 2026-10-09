import type { Listing, Root } from "./explorer.ts";
import type { SessionRow } from "./sessions.ts";
import type { Schedule } from "./schedule-core.ts";
import type { SettingField, SettingKey, SettingsSnapshot, SettingValue } from "../contracts.ts";

export type SessionTier = "you" | "parent" | "workers";
/**
 * Context-window usage (src/viewer/context-usage.ts): tokens in context against the model's
 * window, pi's footer number — never spend. Unknown is a null with `reason`, never 0.
 */
export interface ContextUsage {
 tokens: number | null; window: number | null; percent: number | null;
 /** ok < 70% ≤ warn < 90% ≤ high; null when the percent is unknown. */
 level: "ok" | "warn" | "high" | null; reason: string | null;
 model: string | null; last_compact_at: string | null;
 /** The session's latest `thinking_level_change`; null (never rendered) when the file records none. */
 thinking: string | null;
}
export interface SessionEntry {
 id: string; at: string; kind: "say" | "tool" | "via" | "decision" | "ask" | "system";
 who: string; text: string; name: string | null; send_id: string | null;
 tag: string | null; failed: boolean; summary?: string;
 trace: {id: string; label: string; at: string | null; detail: string}[];
 /** Full transcript: a message the dashboard injected (its `dc-…` id), the ask a card or click is about, and the card itself. */
 dashboard_id?: string; ask_id?: string; ask?: TranscriptAsk;
 /** Full transcript: the upload ids a dashboard message's marker names (`; images=`), shown as thumbnails from `/api/operator/uploads/<id>`. */
 images?: string[];
 /** Text upload ids and display metadata from the upload journal; links serve text/plain only. */
 files?: string[];
 file_metadata?: Record<string, { name: string; bytes: number }>;
 /** A cp-bridge notice's own `paths:` block (src/cp-bridge.ts formatBridgeRelay), each already a viewer link. */
 paths?: { path: string; href: string | null; read: string | null }[];
 /** Each bare `.pi-command-post` path in `text` the viewer can open (src/viewer/linkify.ts), path → href. */
 links?: Record<string, string>;
 /** Say-entry project chip: a `projects/*` name stripped from a leading `[name]` (slice F). */
 project?: string | null;
 /** A cp-bridge notice parsed off its first line (slice F). */
 bridge?: {kind:string; job:string|null; id:string|null; receipt:string|null} | null;
 /** Full transcript (cp-xmw2): the th- id this entry is filed under, by the turn rule (src/viewer/thread-turns.ts). */
 thread?: string;
 /** Full transcript (cp-xmw2): a system entry without a bound job, or the inbox replay. Shown in a thread only inside that thread's own span. */
 shared?: true;
 /** Full transcript: the `ans-` id a `cp_parent answer` call posted (or, on a duplicate, the first one it names). */
 answer_id?: string;
}
/** An operator ask as its card renders inline in the Full transcript; state comes from the ask journal only. */
export interface TranscriptAsk {
 id: string; question: string; options: {label: string; consequence: string; reply: string}[]; recommendation: string;
 state: "open" | "answered" | "withdrawn"; answer: string | null; answered_at: string | null; reason: string | null;
}
/** Composer request and its durable status projection; attachment ids stay on the original body for retry. */
export type ControlMessageBody = {kind: "message"; text: string; deliver?: "followUp" | "steer"; images?: string[]; files?: string[]; thread?: string; client_id?: string};
export interface ControlPendingSend { id: string; at: string; state: "queued" | "held" | "delivered" | "failed" | "dropped"; reason: string | null; ask_id: string | null; body: ControlMessageBody }
/** `GET /api/operator/control`: can this page steer the operator session, and the session's CSRF token when it can. */
export interface ControlStatusResponse {
 generated_at: string; enabled: boolean; running: boolean; reason: string | null; token: string | null;
 busy: boolean | null; pending: boolean | null; session_file: string | null;
 recent: {id: string; kind: string; state: string; at: string; reason: string | null; ask_id: string | null}[];
 /** Journal-backed sends for reload recovery; recent delivered rows update known bubbles until the transcript arrives. */
 sends?: ControlPendingSend[]; sends_error?: string | null;
 /** cp-daemon P3: no operator session runs; a send is held (`held` waiting) with this viewer's `inbox_token`. */
 offline: boolean; held: number; inbox_token: string | null;
 /** Why Start session cannot work here (no tmux start from this viewer and no running herdr); null when it can. */
 start_unavailable: string | null;
 /** What Start session can use: tmux = cp-daemon runs this viewer, tmux on PATH, the wrapper installed; herdr = its binary and server running (checked ≤ 30 s ago). */
 launchers: {tmux: boolean; herdr: boolean};
 /** What Resume last session can use: as launchers (the wrapper with the fixed `-c`). */
 resume: {tmux: boolean; herdr: boolean};
 /** Restart session (running only): whether this session can restart now, its blockers and the one reason it cannot. */
 restart?: RestartStatus;
 /** The running session's dashboard record `started_at`: a new value after a restart is the relaunched session. */
 session_started_at?: string | null;
 /** Running only: true when this session's cp-bridge takes image attachments (`send_images`); absent otherwise. */
 images?: boolean;
 /** Running only: text attachments via send_files (also accepts images). */
 files?: boolean;
}
/** `POST /api/operator/upload` stored an attachment: 201 with its upload id (the composer sends ids, never bytes). */
export interface OperatorUploadResponse { id: string; mime: string; bytes: number; expires_at: string; url: string; name?: string }
export interface RestartStatus { supported: boolean; blockers: string[]; reason: string | null }
/** `POST /api/operator/restart` `{"restart": true}` accepted: the session journaled it, wrote its marker and stops; its launcher resumes `session_file`. */
export interface OperatorRestartResponse { state: "restarting"; id: string; session_file: string | null }
/** One `data/settings-audit.jsonl` line as the operator session returns it (src/settings-write.ts `SettingsAuditLine`). */
export interface SettingsAuditRow { v: 1; type: "intent" | "applied" | "failed" | "recovered" | "refused"; id: string | null; at: string; [field: string]: unknown }
/** `GET /api/settings`: read through the operator session; offline or unsupported is `snapshot: null`, never a projection. */
export interface SettingsResponse {
	generated_at: string;
	enabled: boolean;
	running: boolean;
	supported: boolean;
	writable: boolean;
	reason: string | null;
	snapshot: SettingsSnapshot | null;
	catalog: SettingField[] | null;
	audit: SettingsAuditRow[];
	/** `provider/id` models pi can use here, for the pickers; null when the list is unavailable (`models_error` says why). Absent while offline. */
	available_models?: string[] | null;
	models_error?: string | null;
	/** True while the first `pi --list-models` run has not landed; the page asks again shortly. */
	models_loading?: boolean;
}
/** `POST /api/settings/apply|restore`: the owner transaction's result, passed through with its status. */
export interface SettingsWriteResponse {
	status: number;
	state: "planned" | "unchanged" | "applied" | "stale" | "refused" | "failed";
	error?: string;
	errors?: string[];
	revision?: string;
	snapshot?: SettingsSnapshot;
	changes?: Array<{ key: SettingKey; file_key: string; action: "set" | "delete"; old: SettingValue; old_source: string; new: SettingValue }>;
	audit_warning?: string;
	audit?: string;
}
/** `POST /api/operator/message` accepted: 202 (`held` while the operator session is offline). */
export interface ControlSendResponse {
	id: string; state: "queued" | "delivered" | "held"; deliver: "prompt" | "followUp" | "steer" | "abort";
	/** cp-xmw2: present when the send named a `thread`; `error` says why the dc- id was not filed (the send still stands). */
	thread?: { tag: string; id: string | null; error: string | null };
}
/**
 * `POST /api/operator/start` `{"via": "herdr" | "tmux", "resume"?: true}`: a herdr workspace, or `<tmux> new-session -d -s
 * cp-operator <wrapper>` (resume: `<wrapper> -c`); fixed argv. Resume runs `cp-operator -c`: pi continues
 * this home's most recent session, or starts a fresh one when there is none.
 */
export interface OperatorStartResponse { state: "starting" | "already_running" | "unavailable"; via?: "herdr" | "tmux"; resume?: true; reason?: string }
export interface SessionsResponse {
 generated_at: string; selected: SessionTier; session_id: string | null;
 parent: SessionRow; workers: SessionRow[]; entries: SessionEntry[];
 title: string; subtitle: string; warnings: string[]; truncated: boolean;
 /** Operator tier's Full transcript only: the recorded session files, newest first, and the one shown. */
 transcript?: boolean; operator_sessions?: {id: string; at: string}[]; operator_session?: string | null;
 /** The operator session's context; `parent.context` and each `workers[].context` carry theirs. */
 operator_context?: ContextUsage;
 /** Full transcript only: every open ask, oldest first, for the block pinned above the composer — never windowed. */
 open_asks?: AwaitingDetail[];
}
export interface FileRoot extends Root { phase: string | null; head: string | null; pr_url: string | null; paused: boolean }
export interface FilesResponse {
 generated_at: string; roots: FileRoot[]; selected: string | null; path: string; listing: Listing | null;
}

export type JobPhase = "queued" | "launching" | "working" | "held" | "done" | "failed" | "waiting" | "idle";
export interface ViewerRoutingFacts {
 scope: string | null; risk: string | null;
 provenance: {scope: string | null; risk: string | null};
 rule: string | null; reasons: string[];
}
export interface ViewerJob extends FlightJob {
 board_lane_id?: string;
 phase: JobPhase; ledger_status: string | null; ledger_disagrees: boolean; mandate_id: string | null;
 cost_usd: number | null; pr_url: string | null; pr_status: string | null; finished_at: string | null;
 finished_today: boolean; merge_sha: string | null; failure: string | null; blockers: string[];
 /** The envelope headline, one line of at most 80 chars; null until the run reports. */
 summary: string | null;
 /** The live or last worker's context; null when the job never had a worker session. */
 context?: ContextUsage | null;
 /** Selected recorded routing fields; absent on older payloads, null when nothing was recorded. */
 routing_facts?: ViewerRoutingFacts | null;
}
export interface JobsResponse {
 generated_at: string; awaiting_count: number | null;
 jobs: ViewerJob[]; projects: {name:string; paused:boolean}[]; warnings: {section:string;message:string}[];
}
export interface JobResponse {
 generated_at: string; awaiting_count: number | null; job: ViewerJob;
 timeline: {at:string;label:string;meta:string;tone:string}[]; timeline_truncated: boolean;
 files_href: string | null; artifact_href: string | null; artifact_name: string | null; run_href: string | null;
 /** Published reports, newest revision per job set, matching this job. */
 reports: ReportItem[];
 asks: Ask[]; questions: Question[]; warnings: {section:string;message:string}[];
}
export interface BoardResponse extends JobsResponse {
 columns: {key:JobPhase;name:string;hint:string}[];
 lanes: {id:string;status:string;active:boolean;objective:string;expiry:string | null;ask_on:string[];spend:number | null;cap:number | null;note:string | null}[];
 revoked_hidden: number; stranded_count: number | null;
}
/** `GET /api/stats` (docs/viewer-app.md, Stats definitions). Instants are UTC ISO; null is unknown, never 0. */
export interface StatsBucket { start: string; end: string }
export interface StatsMandateRow {
 /** A grant id, or `unassigned` for finished jobs no grant covers. */
 id: string; objective: string | null; status: string | null; jobs: number;
 spend_usd: number | null; spend_cap_usd: number | null; tokens: number | null; token_cap: number | null; time_left_seconds: number | null;
}
export interface StatsResponse {
 generated_at: string;
 /** `tz` is the IANA zone the day buckets follow ("UTC" when the request sent none); `bucket_seconds` is nominal for day buckets (DST days are 23h/25h; use start/end). */
 range: { from: string; to: string; key: "1h" | "24h" | "7d" | "custom"; bucket_seconds: number; tz: string };
 availability: SourceAvailability; warnings: {section:string;message:string}[];
 filters: { projects: string[]; mandates: {id:string;objective:string}[]; project: string | null; mandate: string | null };
 kpis: {
  spend_usd: number | null; /** Whole percent vs the equal window ending at `from`; null when the prior is 0 or unknown. */ spend_delta_pct: number | null;
  merge_rate: number | null; ci_green_first_try: number | null; median_queue_wait_seconds: number | null; median_wall_clock_seconds: number | null;
  decisions: number | null; /** input + output. */ tokens: number | null; tokens_input: number | null; tokens_output: number | null;
 };
 jobs_finished: { merged: number | null; closed: number | null; buckets: (StatsBucket & { merged: number; closed: number })[] };
 phases: { queued_seconds: number | null; working_seconds: number | null; held_seconds: number | null; review_seconds: number | null };
 tokens_by_model: { models: string[]; buckets: (StatsBucket & { tokens: Record<string, number> })[] };
 spend_by_model: { model: string; usd: number }[];
 decisions: { for_you: number | null; by_you: number | null; worth: number | null };
 mandates: StatsMandateRow[];
}
/** A published web board as the Reports page lists it (`href` is the served path, not an absolute URL). */
export interface ReportItem {
	slug: string;
	title: string;
	description: string;
	created_at: string;
	job_ids: string[];
	href: string;
}
export interface ReportsResponse {
	generated_at: string;
	reports: ReportItem[];
}
/** One run of a schedule: an anchor job (a fire or Run now) plus the jobs it fanned out to. */
export interface ScheduleRunView {
	run_id: string; anchor_id: string; via: "slot" | "dashboard" | "cp_schedule"; at: string; missed: boolean;
	status: "open" | "closed"; jobs_open: number; jobs_total: number; job_ids: string[];
	result: { kind: "board" | "pull_request" | "answer" | "report" | "branch" | "job"; job_id: string; href: string } | null;
}
/** One ledger job a schedule fired (labelled `schedule:<id>`), newest first. */
export interface ScheduleHistoryJob {
	id: string; title: string | null; status: string; close_reason: string | null; created_at: string | null; pr_url: string | null; board_href: string | null;
	/** The envelope headline and when it was reported; null until the run reports. */
	summary: string | null; reported_at: string | null;
	/** `delivery:answer` only: the answer from `state/artifacts/<id>/`, capped at 8 KiB. */
	answer: { text: string; bytes: number; truncated: boolean } | null;
	/** The run (anchor id) this job belongs to; null when no run claims it. */
	run_id: string | null;
}
/** A saved schedule as the Schedules page shows it; `next_at` is the next cron slot, or a watch's next check. */
export type ScheduleItem = Omit<Schedule, "last_output_sha"> & {
	next_at: string | null; next_note: string | null;
	mandate_status: "active" | "paused" | "expired" | "revoked" | "missing";
	/** The grant's `pause_reason` while paused, else null: a schedule's pointer re-mints past a cap pause, never an operator one. */
	mandate_pause_reason: string | null;
	/** Whether the fire path refuses the next fire on this pointer (`operatorStop`, the predicate `pointerRefusal` uses). */
	grant_stopped: boolean;
	/** cp-org-pr-review only (else null): what one Run now fans out to, from the description config; `error` names a bad config. */
	fan_out: { reviewers: number; org: string | null; user: string | null; teams: string[]; holds: number; error: string | null } | null;
	/** cp-org-pr-review only: the seed's standing operator risk:high pre-approval a Run now click carries — its quote's sha12, never the quote. */
	run_now_clearance: { quote_sha: string; granted_at: string } | null;
	history: ScheduleHistoryJob[];
	/** The newest runs (at most 5), newest first; totals are over the whole ledger. */
	runs: ScheduleRunView[];
	last_run: { job_id: string; at: string; via: ScheduleRunView["via"]; missed: boolean } | null;
	run_count: number; job_count: number;
	lands: "board" | "report" | "branch" | "pull_request" | "plan" | "answer";
};
/** `/api/schedules`: `error` names an unreadable or invalid `state/schedules.json`; it is never silently empty. */
export interface SchedulesResponse { generated_at: string; error: string | null; schedules: ScheduleItem[] }
/** cp-hhuf P6: one Schedules page request and its latest state in `state/schedule-control.jsonl`. */
export interface ScheduleControlRequestView {
	id: string; at: string; op: "enable" | "disable" | "run_now" | "remove"; schedule_id: string;
	state: "queued" | "applying" | "done" | "refused" | "expired" | "interrupted"; reason: string | null; job_id: string | null;
}
/** `GET /api/schedules/control` (--require-tailnet only): the CSRF token only while control is on. */
export interface ScheduleControlStatusResponse {
	generated_at: string; enabled: boolean; reason: string | null; token: string | null;
	parent: { running: boolean; pid: number | null; reason: string };
	requests: ScheduleControlRequestView[]; error: string | null;
}
/** `POST /api/schedules/request` accepted: 202 once its `request` line is on disk. */
export interface ScheduleControlSendResponse { id: string; state: "queued" }
export type SourceAvailability = "ok" | "missing" | "unavailable";
export interface Ask {
 id: string; project: string; question: string; created_at: string;
 options: {label: string; consequence: string; reply: string}[];
 recommendation: string; source_escalation: string | null; job_ids: string[];
 /** The ask's optional plain-text background (≤ 2,000 chars) and its evidence paths, as recorded. */
 context: string | null; evidence_paths: string[];
}
export interface Question { id: string; question: string; kind: string; created_at: string; job_ids: string[]; age_seconds: number }
export interface Decision { id: string; question: string; answer: string; answered_at: string; job_ids: string[] }
export interface DecisionDetail extends Decision {
 source: "operator-delegated" | "you" | "schedule-run"; project: string | null; source_escalation: string | null;
 quote: string | null; rule: string | null; worth: ("risk" | "scope" | "override" | "judgement")[]; today: boolean;
 /** The escalation kind behind it (`mission_end`, `scope_expansion`, …); null when none is recorded. */
 kind: string | null;
 /** How the delegation was authorized, from the recorded rule only. */
 basis?: {kind:"words"|"standing"|"judgement"|"run"; ref:string|null};
}
export interface AwaitingDetail extends Ask {
 reason: string | null; source_created_at: string | null; mandate_id: string | null;
 mandate_status: string | null; spend: number | null; spend_cap: number | null;
 mandate_objective: string | null;
 /** Each `job_ids` entry as the jobs view builds it; `title` null when the ledger and fleet never recorded it. */
 jobs: {id: string; title: string | null; phase: string | null; model: string | null; cost_usd: number | null; pr_url: string | null; ci: string | null; review: string | null}[];
 /** The parent's own escalation: `recommended` is its option label; `differs` when it is not the operator session's recommendation. */
 escalation: {id: string; kind: string | null; question: string; recommended: string | null; differs: boolean} | null;
 /** Each evidence path: `href` opens it in the viewer (Files, a job, a report), `read` is the body when it is an artifact or report. */
 evidence: {path: string; href: string | null; read: string | null}[];
}
export interface DecisionScreenResponse {
 generated_at: string;
 availability: Record<"asks" | "escalations", SourceAvailability>;
 awaiting_count: number | null; parent_questions: Question[];
 decided_today: {count: number | null; worth_count: number | null; by_you?: number | null};
}
export interface AwaitingResponse extends DecisionScreenResponse { items: AwaitingDetail[] }
export interface DecidedResponse extends DecisionScreenResponse { items: DecisionDetail[] }
/** The one Decisions page (dashboard audit P4 #24): Awaiting's asks as `items`, then the Decided log. */
/** One answer the operator asked for (cp-mxk4): `short` is its first paragraph, `evidence`/`links` only what `evidenceLink` resolves. */
export interface AnswerItem {
 id: string; project: string; question: string; answer: string; short: string; posted_at: string; acked_at: string | null;
 job: {id: string; href: string; read: string | null} | null;
 evidence: AwaitingDetail["evidence"];
 links: Record<string, string>;
}
export interface AnswersView {
 availability: SourceAvailability; open: AnswerItem[]; open_count: number | null;
 history: AnswerItem[]; history_total: number | null; warning: string | null;
}
/** `GET /api/answers/control` (--require-tailnet only): the ack CSRF token only while control is on. */
export interface AnswersControlStatusResponse { generated_at: string; enabled: boolean; reason: string | null; token: string | null }
/** `POST /api/answers/ack` accepted: 202 once its `acked` line is on disk. */
export interface AnswerAckResponse { id: string; state: "acked"; acked_at: string }
/** cp-xmw2: one operator thread with its derived state (`waiting` null while asks or answers are unreadable). */
export interface ThreadView {
 id: string; tag: string; state: "open" | "waiting" | "done";
 waiting: { asks: number; answers: number } | null;
 /** `jobs_working`: job refs that are live workers; null while fleet.json is unreadable. */
 counts: { messages: number; asks: number; answers: number; jobs_working: number | null };
 opened_at: string; last_at: string; done_at: string | null;
}
/** `GET /api/threads` (--require-tailnet only): the list, and the done CSRF token only while control is on. */
export interface ThreadsResponse { generated_at: string; availability: SourceAvailability; enabled: boolean; reason: string | null; token: string | null; threads: ThreadView[]; total: number; warning: string | null }
/** `POST /api/threads/done` accepted: 202 once its `done` line is on disk. */
export interface ThreadDoneResponse { id: string; state: "done"; done_at: string }
export interface DecisionsResponse extends AwaitingResponse { decided: DecisionDetail[]; answers: AnswersView }
export interface FlightJob {
 id: string; project: string; title: string | null; phase: string; model: string | null; script_path: string | null;
 elapsed_seconds: number | null; limit_seconds: number | null;
 head: string | null; ci: string | null; review: string | null; review_attempts: number;
 routing: string | null; note: string | null; pr_url?: string | null;
 /** The live worker's context, when a screen has it. Overview fills this; absent on older payloads. */
 context?: ContextUsage | null;
 cost_usd?: number | null;
}
export interface ShippedJob { id: string; title: string | null; merged_at: string; merge_sha: string; pr_url: string; cost_usd: number | null }
/** A fleet job in phase `failed`; `failure` is its headline, one line of at most 80 chars. */
export interface FailedJob { id: string; project: string; title: string | null; failure: string | null }
/** One `state/main-ci.json` row: that project's main is latched red (src/main-ci.ts). No row is no latch, never proof of green. */
export interface MainCiRed { project: string; red_since_sha: string; red_since_at: string; workflow: string | null; failing: string | null }
export interface BlockedJob { id: string; title: string | null; blockers: {id: string; phase: string | null; grant_status: string | null; mandate_id: string | null; stranded: boolean}[] }
export interface OverviewMandate {
 id: string; status: string; projects: string[]; objective: string; expiry: string; pause_reason: string | null;
 ask_on: string[]; spend_cap: {usd: number | null; tokens: number | null}; job_cap: number | null; dispatch_parallelism: number | null;
 spend: {usd: number; tokens: number; jobs: number; inFlight: number} | null;
}
export interface MandateItem extends OverviewMandate { job_ids: string[]; closed_at?: string }
export interface MandatesResponse {
 generated_at: string;
 availability: Record<"mandates" | "fleet" | "ledger" | "escalations", SourceAvailability>;
 items: MandateItem[]; active_count: number | null; paused_count: number | null; revoked_count: number | null;
}
export interface MapNode {
 id: string; title: string; project: string; mandate_id: string | null;
 phase: string; ledger_status: string | null; model: string | null; cost_usd: number | null;
 pr_url: string | null; ci: string | null; pr_status?: string;
 context?: ContextUsage | null;
}
export interface MapEdge { from: string; to: string; kind: "open" | "satisfied" | "stranded" | "unknown" }
export interface MapResponse extends MandatesResponse { nodes: MapNode[]; edges: MapEdge[]; stranded_count: number | null }
export interface ParentHealth {
 model: string | null; pid: number | null; activity: "recent" | "idle" | "unknown";
 /** The recorded lock holder is probed, never assumed: a lock a crashed parent left behind is not alive. */
 alive: boolean;
 /** The stale lock's `started_at`, set only when the recorded pid is not alive. */
 stale_since: string | null;
 context_tokens: number | null; compact_at_tokens: number | null; last_turn_cost_usd: number | null;
 last_activity: string | null; last_compact_at: string | null;
}
/** The operator (main) session: its dashboard record probed, and the inbox messages held for it. `held` null: unreadable. */
export interface OperatorHealth { running: boolean; pid: number | null; since: string | null; held: number | null }
export interface QuotaObservation {
 observed_at: string; source_job_id: string; historical: true;
 providers: {provider: string; five_hour: number | null; seven_day: number | null; tight: boolean; free_slots: number | null}[];
}
export interface OverviewResponse {
 generated_at: string;
 availability: Record<"asks" | "escalations" | "fleet" | "ledger" | "mandates", SourceAvailability>;
 awaiting: {count: number | null; items: Ask[]}; parent_questions: Question[];
 decided_today: {count: number | null; items: Decision[]; worth_count: null; by_you?: number | null}; all_questions_delegated: boolean;
 in_flight: FlightJob[]; shipped_today: ShippedJob[];
 /** Jobs done today without a merge receipt; with `shipped_today`, the Board's "Landed today". Null: fleet or ledger unreadable. */
 closed_today: number | null;
 blocked: {items: BlockedJob[]; stranded_count: number | null};
 /** Audit P3 #17: failed fleet jobs, listed under Blocked & failed. */
 failed: FailedJob[];
 /** Audit P3 #19: `state/main-ci.json`, re-read by the viewer; `missing` is no latch file, `unavailable` unreadable or off-schema. */
 main_ci: {availability: SourceAvailability; red: MainCiRed[]};
 mandates: {active_count: number | null; paused_count: number | null; paused_projects: string[]; revoked_hidden_count: number | null; items: OverviewMandate[]};
 fleet: {parent: ParentHealth; workers: {live: number | null; working: number | null; idle_held: number | null; unknown: number}; operator: OperatorHealth};
 /** cp-daemon P3: the watchdog's last run (`state/health.json`); null when it never ran. */
 services: {health: {last_run_at: string; failing: {check: string; detail: string; since: string}[]} | null};
 /** cp-6fyl PR2: did the operator session see what the parent sent (`state/operator/relay-{outbox.json,acks.jsonl}`)? Null counts: unreadable, never zero. */
 delivery: {availability: SourceAvailability; unseen: number | null; oldest_id: string | null; oldest_kind: string | null; oldest_age_seconds: number | null; consumer_seen_at: string | null; alarm: boolean};
 quota: QuotaObservation | null;
 navigation: {project_count: number; worktree_count: number};
 warnings: {section: string; message: string}[];
}
/** `/api/push`: public push setup and delivery health. Null is unreadable, never zero; never an endpoint or secret. */
export interface PushStatusResponse {
 generated_at: string; configured: boolean; origin: string | null; public_key: string | null;
 devices: number | null; last_sent_at: string | null; undelivered_24h: number | null; last_error: string | null;
}
/** The version badge (cp-kz20): ok green, warn amber, alert red, unknown grey. */
export type VersionLevel = "ok" | "warn" | "alert" | "unknown";
export type ProcessRole = "viewer" | "host" | "parent" | "operator";
/** One running process against the checkout: `current`/`stale` by its recorded commit; `down` when no record or a dead pid. */
export interface ProcessVersion {
 role: ProcessRole; state: "current" | "stale" | "unknown" | "down"; commit: string | null; started_at: string | null;
 pid_alive: boolean; why: string; fix: string | null;
}
/** The checkout against the local `origin/main` ref the updater fetches; `checked_at` only when that ref is known fresh. */
export interface UpstreamVersion {
 state: "current" | "behind" | "ahead" | "diverged" | "unknown"; behind: number | null; ahead: number | null; reason: string | null;
 checked_at: string | null;
 /** `state/update.json` + `data/update.json`; null when the updater never ran. */
 updater: {enabled: boolean; result: string | null; since: string | null; last_run_at: string | null; detail: string | null; fetch_failures: number} | null;
}
/** `GET /api/version`: picked fields only, never a token, csrf or socket. */
export interface VersionResponse {
 generated_at: string;
 deployed: {sha: string; at: string} | null;
 upstream: UpstreamVersion;
 processes: ProcessVersion[];
 /** The app script this server serves; a page whose own script differs is outdated. */
 bundle: {script: string | null};
 overall: {level: VersionLevel; label: string};
}
