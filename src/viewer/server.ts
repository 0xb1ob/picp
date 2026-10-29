/**
 * Read-only dashboard HTTP surface: the app, JSON projections, refresh SSE,
 * published board artifacts and job reports (job-report.ts). Requests read recorded state only, with two
 * write routes: `POST|DELETE /api/push/subscription` stores or removes this
 * browser's Web Push subscription under `data/push/subscriptions/` (push-api.ts),
 * and `POST /api/operator/message` forwards one message, decision click or abort
 * to the operator's own running session over its owner-only control socket (or, with no session running,
 * holds it in `state/operator/inbox.jsonl`) and journals every refusal to `state/operator/dashboard.jsonl`
 * (control-api.ts); `POST /api/operator/start` runs the fixed `<tmux> new-session -d -s cp-operator <wrapper>` (or a herdr workspace);
 * `POST /api/schedules/request` (with its status `GET /api/schedules/control`) journals one Schedules page request;
 * `POST /api/answers/ack` (with its status `GET /api/answers/control`) appends one `acked` line to `state/operator/answers.jsonl`;
 * `POST /api/settings/apply|restore` (with `GET /api/settings`, settings-api.ts) forward one `settings_apply` frame to the
 * operator session, which validates, audits and writes the owner files; the viewer writes no settings file.
 * The one request that reaches the parent does so only as a line in `state/schedule-control.jsonl`, which the
 * parent reads. Every route answers any Host unless `viewer.strict_host` (data/viewer.json) pins the bind Host
 * (host-config.ts); the operator's own Full transcript
 * (`/api/sessions?view=you&transcript=1`), both dashboard-control routes, both schedule-control routes, both answers routes,
 * the three settings routes and the skills list (`/api/skills`, names and descriptions only) are served only by a viewer started with `--require-tailnet` and refused 403 otherwise.
 * Remote dashboard: `dispatch` is also reached through the remote listener's gate (remote-server.ts), which binds an
 * authenticated device context to the request (access.ts); with `devices` set, three device routes are added (devices-api.ts).
 */

import { readFileSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { boardView, jobsView, jobView, jobEvents } from "./jobs-view.ts";
import { statsView } from "./stats-view.ts";
import { statScope } from "./file-cache.ts";
import { prewarm, warming } from "./prewarm.ts";
import { reportsView } from "./reports-view.ts";
import { jobReport, reportImage } from "./job-report.ts";
import { schedulesView } from "./schedules-view.ts";
import { overview } from "./overview-view.ts";
import { sessionsView, readWorkerTranscript } from "./sessions-view.ts";
import { filesView } from "./files-view.ts";
import { dependencyMap } from "./mandates-map-view.ts";
import { APP_CSP, appPage, type ViewerApp } from "./app-page.ts";
import { refreshStream, refreshStreams } from "./refresh-stream.ts";
import { awaitingScreen, decidedScreen, decisionsScreen } from "./decision-views.ts";
import { BOARD_CSP, BOARD_CSS, type BoardWarn, contentType, listBoards, onceWarner, readBoard, resolveBoardFile } from "./boards.ts";
import { gitView, jobRoot, listOrRead, roots, safePatch } from "./explorer.ts";
import { dashboard, jobDetail } from "./fleet-view.ts";
import { sidebar, type ViewerState } from "./sessions.ts";
import { discardBounded, handlePushSubscription, handlePushTest, PUSH_STATUS_PATH, PUSH_SUBSCRIPTION_PATH, PUSH_TEST_PATH, pushStatus } from "./push-api.ts";
import type { PushFetch } from "../push/webpush.ts";
import { ANSWER_ACK_PATH, ANSWERS_CONTROL_PATH, CONTROL_MESSAGE_PATH, CONTROL_STATUS_PATH, type ControlLimiter, handleAnswerAck, handleAnswersControlStatus, handleControlMessage, handleControlStatus, handleOperatorStart, handleScheduleControl, handleScheduleControlStatus, OPERATOR_START_PATH, type OperatorStart, SCHEDULE_CONTROL_PATH, SCHEDULE_CONTROL_STATUS_PATH } from "./control-api.ts";
import { handleSchedulePolicy, SCHEDULE_POLICY_PATH } from "./control-api.ts";
import { handleOperatorRestart } from "./operator-restart.ts";
import { handleOperatorQueue, OPERATOR_QUEUE_PATH } from "./operator-queue.ts";
import { handleSettingsStatus, handleSettingsWrite, SETTINGS_APPLY_PATH, SETTINGS_PATH, SETTINGS_RESTORE_PATH } from "./settings-api.ts";
import { handleSkillsList, SKILLS_PATH } from "./skill-catalog.ts";
import { handleOperatorUpload, OPERATOR_UPLOAD_PATH, OPERATOR_UPLOADS_PREFIX, serveOperatorUpload } from "./operator-upload-api.ts";
import { OPERATOR_RESTART_PATH, PARENT_RESTART_PATH } from "./restart-status.ts";
import { handleParentRestart } from "./parent-restart.ts";
import { SERVICE_WORKER_JS, SERVICE_WORKER_PATH } from "./service-worker.ts";
import { APP_ICONS, appIcon, MANIFEST_JSON, MANIFEST_PATH } from "./app-manifest.ts";
import { readRunning, readVersion } from "./version-view.ts";
import { SHA } from "./git-read.ts";
import { accessOf, canRead, streamValidity } from "./access.ts";
import { diffJson } from "./json-delta.ts";
import { viewVersions } from "./view-versions.ts";
import { strictHost } from "./host-config.ts";
import { DEVICE_NOTICES_PATH, DEVICES_PATH, DEVICES_REVOKE_PATH, type DeviceRoutes, handleDeviceNotices, handleDevicesList, handleDevicesWrite, PAIR_CREATE_PATH } from "./devices-api.ts";

export interface ViewerOptions extends ViewerState {
	app?: ViewerApp;
	appBuildError?: string;
	host: string;
	port: number;
	/**
	 * True when `bin/cp-view` was started with `--require-tailnet` (what
	 * `bin/cp-operator` always passes). The operator's own full transcript — a file
	 * that can contain anything — is served only then; every other route ignores it.
	 */
	requireTailnet?: boolean;
	/** Dashboard-control rate limiter (20 per 60 s per client address); created on first use. A test seam. */
	controlLimiter?: ControlLimiter;
	/** Image attachments: upload root (default `CP_UPLOAD_ROOT`, else /tmp/cp-dashboard-uploads) and the 24/60 s upload limiter. Test seams. */
	uploadRoot?: string;
	/** pi's agent dir for `GET /api/skills` (default `agentDirFor(process.env)`). A test seam. */
	agentDir?: string;
	uploadLimiter?: ControlLimiter;
	/** Start session (`POST /api/operator/start`): test seams and the last start's time. */
	operatorStart?: OperatorStart;
	/** Where a skipped board is reported, once per (slug, reason). Default stderr. */
	log?: (line: string) => void;
	/** Remote dashboard: device management routes (devices-api.ts). Absent — the default — those paths answer 404 as before. */
	devices?: DeviceRoutes;
	/** Remote dashboard PR 2: the quick tunnel's listener (no SSE through it) tells the app to poll. Absent: SSE, as before. */
	refreshTransport?: "poll";
	/** The test-notification send (`POST /api/push/test`). A test seam; default `fetch`. */
	pushFetch?: PushFetch;
}

/** `host:port` as a browser sends it in the Host header (IPv6 bracketed). */
export function hostHeaderFor(host: string, port: number): string {
	return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * DNS-rebinding guard: only the exact configured bind is accepted. A missing Host header, another name for the
 * same address, or another port is refused. The local listener applies it only under `viewer.strict_host`.
 */
export function hostAllowed(header: string | undefined, host: string, port: number): boolean {
	if (!header) return false;
	const got = header.trim().toLowerCase();
	const want = hostHeaderFor(host, port).toLowerCase();
	if (got === want) return true;
	return port === 80 && got === want.slice(0, want.lastIndexOf(":"));
}

const SECURITY_HEADERS = {
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
};

// A remote-listener response is never cached anywhere, whatever the route asked (an attachment's 7-day cache included).
const REMOTE_NO_STORE = { "cache-control": "no-store" };

const COMPRESSIBLE = /^(application\/json|text\/javascript|text\/css|text\/html|text\/plain|application\/manifest\+json)\b/;

/** The HTTP content-coding token for Brotli (RFC 7932). */
const BROTLI = "br" as const;

/** Brotli or gzip when the client offers it (q > 0) for a 200 body worth compressing; `undefined` sends identity. */
function encodingFor(res: ServerResponse, status: number, type: string, size: number): typeof BROTLI | "gzip" | undefined {
	if (status !== 200 || size < 1024 || res.req?.method === "HEAD" || !COMPRESSIBLE.test(type)) return undefined;
	const offered = new Set(String(res.req?.headers["accept-encoding"] ?? "").split(",").flatMap((part) => {
		const [name = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
		const q = params.find((p) => p.startsWith("q="));
		return q && Number(q.slice(2)) === 0 ? [] : [name];
	}));
	return offered.has(BROTLI) ? BROTLI : offered.has("gzip") ? "gzip" : undefined;
}

export function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
	const encoding = encodingFor(res, status, type, Buffer.byteLength(body));
	const encoded = encoding === BROTLI ? brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
		: encoding === "gzip" ? gzipSync(body, { level: 6 }) : body;
	const negotiated = encoding ? { "content-encoding": encoding, vary: "accept-encoding" } : {};
	res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...extra, ...negotiated, ...(accessOf(res.req).kind === "remote" ? REMOTE_NO_STORE : {}) });
	res.end(encoded);
}

const JSON_CSP = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };

export function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(value), { ...JSON_CSP, ...extra });
}

/**
 * A 200 screen view tagged `x-cp-version`. With `x-cp-delta-base` naming a version still held for this principal and
 * URL, the body is a keyed delta (json-delta.ts) and the base is echoed; otherwise the full body, as before.
 */
function sendView(req: IncomingMessage, res: ServerResponse, value: unknown, extra: Record<string, string> = {}): void {
	const json = JSON.stringify(value);
	const access = accessOf(req);
	const key = `${access.kind === "remote" ? `remote:${access.device_id}` : "local"}|${req.url ?? "/"}`;
	const asked = req.headers["x-cp-delta-base"];
	const base = typeof asked === "string" ? viewVersions.base(key, asked) : undefined;
	const version = viewVersions.record(key, json);
	if (base !== undefined) {
		const delta = JSON.stringify(diffJson(JSON.parse(base), JSON.parse(json)) ?? {});
		if (delta.length < json.length / 2) return send(res, 200, "application/json; charset=utf-8", delta, { ...JSON_CSP, ...extra, "x-cp-version": version, "x-cp-delta-base": asked as string });
	}
	send(res, 200, "application/json; charset=utf-8", json, { ...JSON_CSP, ...extra, "x-cp-version": version });
}

/** `git diff base...head` for a held job, from its live worktree or its project clone; never fetched. */
async function diff(res: ServerResponse, options: ViewerOptions, id: string): Promise<void> {
	const job = jobDetail(options, id);
	if (!job) return sendJson(res, 404, { error: "no such job" });
	if (!job.head || !job.base) return sendJson(res, 200, { available: false, reason: "no head/base sha recorded" });
	const root = jobRoot(options, id);
	if (!root) return sendJson(res, 200, { available: false, reason: "no worktree or project clone to read" });
	const out = await safePatch(root.path, "diff", `${job.base}...${job.head}`);
	if (!out.ok) return sendJson(res, 200, { available: false, reason: out.reason });
	sendJson(res, 200, { available: true, base: job.base, head: job.head, root: root.id, truncated: out.truncated, text: out.stdout });
}

/** Streams whose refresh intervals are still running in this process. */
export function pollingStreams(): number {
	return refreshStreams();
}

/** `/boards/…`: the built-in stylesheet, or one static file from a board's `site/`. */
function board(res: ServerResponse, pathname: string, options: ViewerOptions, warn: BoardWarn): void {
	const csp = { "content-security-policy": BOARD_CSP };
	if (pathname === "/boards/board.css") {
		send(res, 200, "text/css; charset=utf-8", BOARD_CSS, csp);
		return;
	}
	const [, slug = "", rest] = /^\/boards\/([^/]*)(?:\/(.*))?$/s.exec(pathname) ?? [];
	if (rest === undefined && readBoard(options, slug, warn)) {
		send(res, 308, "text/plain; charset=utf-8", "", { ...csp, location: `/boards/${slug}/` });
		return;
	}
	const file = rest === undefined ? undefined : resolveBoardFile(options, slug, rest, warn);
	let body: Buffer | undefined;
	try {
		body = file ? readFileSync(file) : undefined;
	} catch {
		body = undefined;
	}
	if (!file || !body) send(res, 404, "text/plain; charset=utf-8", "no such board file\n", csp);
	else send(res, 200, contentType(file), body, csp);
}

export function handle(req: IncomingMessage, res: ServerResponse, options: ViewerOptions, warn: BoardWarn = () => {}): void {
	if (strictHost(options.stateDir) && !hostAllowed(req.headers.host, options.host, options.port)) {
		send(res, 421, "text/plain; charset=utf-8", `refused: Host must be ${hostHeaderFor(options.host, options.port)}\n`);
		return;
	}
	dispatch(req, res, options, warn);
}

/** Every route, after the listener's own Host guard (the local one above, or the remote gate in remote-server.ts). */
export function dispatch(req: IncomingMessage, res: ServerResponse, options: ViewerOptions, warn: BoardWarn = () => {}): void {
	const requestPath = (req.url ?? "/").split("?")[0];
	const devices = options.devices;
	if (devices && (requestPath === PAIR_CREATE_PATH || requestPath === DEVICES_REVOKE_PATH)) {
		handleDevicesWrite(req, options, devices, requestPath === PAIR_CREATE_PATH ? "create" : "revoke")
			.then((out) => sendJson(res, out.status, out.body, out.headers))
			.catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			});
		return;
	}
	if (requestPath === PUSH_SUBSCRIPTION_PATH || requestPath === PUSH_TEST_PATH || requestPath === CONTROL_MESSAGE_PATH || requestPath === OPERATOR_START_PATH || requestPath === OPERATOR_RESTART_PATH || requestPath === PARENT_RESTART_PATH || requestPath === OPERATOR_QUEUE_PATH || requestPath === OPERATOR_UPLOAD_PATH || requestPath === SCHEDULE_CONTROL_PATH || requestPath === ANSWER_ACK_PATH || requestPath === SETTINGS_APPLY_PATH || requestPath === SETTINGS_RESTORE_PATH) {
		(requestPath === PUSH_SUBSCRIPTION_PATH ? handlePushSubscription(req, options) : requestPath === PUSH_TEST_PATH ? handlePushTest(req, options) : requestPath === CONTROL_MESSAGE_PATH ? handleControlMessage(req, options) : requestPath === SCHEDULE_CONTROL_PATH ? handleScheduleControl(req, options) : requestPath === ANSWER_ACK_PATH ? handleAnswerAck(req, options) : requestPath === OPERATOR_RESTART_PATH ? handleOperatorRestart(req, options) : requestPath === PARENT_RESTART_PATH ? handleParentRestart(req, options) : requestPath === OPERATOR_QUEUE_PATH ? handleOperatorQueue(req, options) : requestPath === OPERATOR_UPLOAD_PATH ? handleOperatorUpload(req, options) : requestPath === SETTINGS_APPLY_PATH ? handleSettingsWrite(req, options, "set") : requestPath === SETTINGS_RESTORE_PATH ? handleSettingsWrite(req, options, "restore") : handleOperatorStart(req, options))
			.then((out) => { sendJson(res, out.status, out.body, out.headers); if (out.discard) discardBounded(req, res, out.discard); })
			.catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			});
		return;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		send(res, 405, "text/plain; charset=utf-8", "read-only viewer: GET only\n", { allow: "GET, HEAD" });
		return;
	}
	let url: URL;
	try {
		url = new URL(req.url ?? "/", "http://viewer.invalid");
	} catch {
		send(res, 400, "text/plain; charset=utf-8", "bad request\n");
		return;
	}
	const requestedPath = (req.url ?? "/").split("?")[0] ?? "/";
	if ((requestedPath.startsWith("/assets/viewer/") || url.pathname.startsWith("/assets/viewer/")) && requestedPath !== url.pathname) {
		send(res, 404, "text/plain; charset=utf-8", "not found\n", { "content-security-policy": APP_CSP });
		return;
	}
	// The operator's own full transcript can contain anything, so it is served only
	// when this viewer was started under `--require-tailnet` (what bin/cp-operator
	// passes); the Host guard above (when on) still runs first, for every route.
	if (url.searchParams.get("transcript") === "1" && !canRead(accessOf(req), options.requireTailnet === true)) {
		sendJson(res, 403, { error: "the operator transcript is served only under --require-tailnet" });
		return;
	}
	if (devices && url.pathname === DEVICES_PATH) {
		const out = handleDevicesList(req, devices);
		sendJson(res, out.status, out.body);
		return;
	}
	if (devices && url.pathname === DEVICE_NOTICES_PATH) {
		const out = handleDeviceNotices(req, devices, options.stateDir);
		sendJson(res, out.status, out.body);
		return;
	}
	if (url.pathname.startsWith(OPERATOR_UPLOADS_PREFIX)) {
		const out = serveOperatorUpload(req, options, url.pathname.slice(OPERATOR_UPLOADS_PREFIX.length));
		send(res, out.status, out.type, out.body, out.headers);
		return;
	}
	switch (url.pathname) {
		case "/boards/":
			send(res, 302, "text/plain; charset=utf-8", "", { location: "/#reports" });
			return;
		case "/":
			send(res, options.app ? 200 : 503, "text/html; charset=utf-8", appPage(options.app, options.refreshTransport), { "content-security-policy": APP_CSP });
			return;
		case "/api/identity":
			sendJson(res, 200, { viewer: "command-post", home: resolve(options.home) });
			return;
		case "/api/version":
			readVersion({ home: options.home, stateDir: options.stateDir, script: options.app?.script ?? null })
				.then((view) => sendJson(res, 200, view))
				.catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "internal" });
				});
			return;
		case "/healthz":
			send(res, 200, "text/plain; charset=utf-8", "ok\n");
			return;
		case PUSH_STATUS_PATH:
			sendJson(res, 200, pushStatus(options));
			return;
		case CONTROL_STATUS_PATH:
			handleControlStatus(req, options)
				.then((out) => out.status === 200 ? sendView(req, res, out.body, out.headers) : sendJson(res, out.status, out.body, out.headers))
				.catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "internal" });
				});
			return;
		case SETTINGS_PATH:
			handleSettingsStatus(req, options)
				.then((out) => sendJson(res, out.status, out.body, out.headers))
				.catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "internal" });
				});
			return;
		case SCHEDULE_POLICY_PATH: {
			const out = handleSchedulePolicy(req, options);
			sendJson(res, out.status, out.body, out.headers);
			return;
		}
		case SCHEDULE_CONTROL_STATUS_PATH: {
			const out = handleScheduleControlStatus(req, options);
			sendJson(res, out.status, out.body, out.headers);
			return;
		}
		case ANSWERS_CONTROL_PATH: {
			const out = handleAnswersControlStatus(req, options);
			sendJson(res, out.status, out.body, out.headers);
			return;
		}
		case SKILLS_PATH: {
			const out = handleSkillsList(options, new Date(), accessOf(req));
			sendJson(res, out.status, out.body);
			return;
		}
		case SERVICE_WORKER_PATH:
			send(res, 200, "text/javascript; charset=utf-8", SERVICE_WORKER_JS, { "content-security-policy": APP_CSP });
			return;
		case MANIFEST_PATH:
			send(res, 200, "application/manifest+json; charset=utf-8", MANIFEST_JSON, JSON_CSP);
			return;
		case "/api/sessions": {
   const tier=url.searchParams.get("view");
   if (tier !== null) {
    const view=["you","parent","workers"].includes(tier) ? sessionsView(options,tier as "you" | "parent" | "workers",url.searchParams.get("id"),{transcript:url.searchParams.get("transcript") === "1",session:url.searchParams.get("session")}) : undefined;
    if (view) sendView(req,res,view); else sendJson(res,404,{error:"no such session"}); return;
   }
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ...sidebar(options), boards: listBoards(options, warn) }));
			return;
  }
		case "/api/stats":
			afterWarm(res, options, "stats", () => {
				const out = statScope(() => statsView(options, url.searchParams, Date.now()));
				if (out.status === 200) sendView(req, res, out.body); else sendJson(res, out.status, out.body);
			});
			return;
		case "/api/jobs":
			afterWarm(res, options, "jobs", () => sendView(req, res, statScope(() => jobsView(options))));
			return;
		case "/api/board":
			afterWarm(res, options, "jobs", () => sendView(req, res, statScope(() => boardView(options))));
			return;
		case "/api/reports":
			sendView(req, res, reportsView(options, warn));
			return;
		case "/api/schedules":
			sendView(req, res, statScope(() => schedulesView(options, warn)));
			return;
		case "/api/overview":
			sendView(req, res, statScope(() => overview(options)));
			return;
		case "/api/map":
			afterWarm(res, options, "map", () => sendView(req, res, statScope(() => dependencyMap(options))));
			return;
		case "/api/dashboard":
			sendJson(res, 200, statScope(() => dashboard(options)));
			return;
		case "/api/awaiting":
			sendView(req, res, statScope(() => awaitingScreen(options)));
			return;
		case "/api/decided":
			sendView(req, res, statScope(() => decidedScreen(options)));
			return;
		case "/api/decisions":
			sendView(req, res, statScope(() => decisionsScreen(options)));
			return;
		case "/api/job": {
			const job = jobDetail(options, url.searchParams.get("id") ?? "");
			if (job) sendJson(res, 200, job);
			else sendJson(res, 404, { error: "no such job" });
			return;
		}
		case "/api/diff":
			diff(res, options, url.searchParams.get("id") ?? "").catch(() => {
				if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			});
			return;
		case "/api/roots":
			sendJson(res, 200, { roots: roots(options) });
			return;
		case "/api/files": {
   if (url.searchParams.get("view") === "screen") {
    const view=filesView(options,url.searchParams.get("root"),url.searchParams.get("path") ?? "");
    if (view) sendView(req,res,view); else sendJson(res,404,{error:"no such path"}); return;
   }
			const listing = listOrRead(options, url.searchParams.get("root") ?? "", url.searchParams.get("path") ?? "");
			if (listing) sendJson(res, 200, listing);
			else sendJson(res, 404, { error: "no such path" });
			return;
		}
		case "/api/git": {
			const q = url.searchParams;
			gitView(options, q.get("root") ?? "", q.get("view") ?? "", q.get("sha") ?? undefined)
				.then((out) => sendJson(res, out.status, out.body))
				.catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "internal" });
				});
			return;
		}
		case "/api/stream": {
			if (["overview", "awaiting", "decided", "decisions", "sessions", "files", "map", "jobs", "job", "board", "reports", "report", "schedules", "stats"].includes(url.searchParams.get("view") ?? "")) { refreshStream(req, res, streamValidity(req)); return; }
			send(res, 404, "text/plain; charset=utf-8", "no such view\n");
			return;
		}
		default:
			if (url.pathname.startsWith("/api/report/")) {
				const match = /^\/api\/report\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\/files\/(.+))?$/.exec(url.pathname);
				if (match?.[2] !== undefined) {
					const image = reportImage(options, match[1]!, match[2]);
					if (image) send(res, 200, image.type, image.body, { "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox" });
					else send(res, 404, "text/plain; charset=utf-8", "no such report image\n");
					return;
				}
				const report = match ? jobReport(options, match[1]!) : undefined;
				if (report) sendView(req, res, report);
				else sendJson(res, 404, { error: "no such report" });
				return;
			}
			if (url.pathname.startsWith("/api/job/")) {
				const match = /^\/api\/job\/([^/]+)(\/events|\/transcript)?$/.exec(url.pathname);
				let id = ""; try { id = decodeURIComponent(match?.[1] ?? ""); } catch { /* Invalid encoding is not a job id. */ }
				const job = jobView(options, id);
				if (job && match?.[2] === "/transcript") { sendView(req, res, readWorkerTranscript(options, id)); return; }
				if (job && match?.[2]) {
					const log = jobEvents(options, id);
					send(res, log === undefined ? 404 : 200, "text/plain; charset=utf-8", log ?? "Run log unavailable (missing or exceeds 16 MiB).\n", { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
					return;
				}
				if (!job) { sendJson(res, 404, { error: "no such job" }); return; }
				const merge = job.job.merge_sha?.toLowerCase();
				if (!merge || !SHA.test(merge)) { sendView(req, res, job); return; }
				// With a merge_sha, finished_at is the merge receipt's merged_at (jobs-view.ts).
				readRunning(merge, { home: options.home, stateDir: options.stateDir }, job.job.finished_at)
					.then((running) => sendView(req, res, { ...job, running }))
					.catch(() => { if (!res.headersSent) sendView(req, res, { ...job, running: { checkout: "unknown", since: null, why: "version read failed", processes: [] } }); });
				return;
			}
			if (url.pathname.startsWith("/assets/viewer/")) {
				const asset = options.app && Object.hasOwn(options.app.assets, url.pathname) ? options.app.assets[url.pathname] : undefined;
				// Asset names are content-hashed (build.ts), so a local client may keep them; remote stays no-store in send().
				send(res, asset ? 200 : 404, asset?.mime ?? "text/plain; charset=utf-8", asset ? Buffer.from(asset.bytes) : "not found\n", { "content-security-policy": APP_CSP, ...(asset ? { "cache-control": "public, max-age=31536000, immutable" } : {}) });
				return;
			}
			const iconSize = Object.hasOwn(APP_ICONS, url.pathname) ? APP_ICONS[url.pathname] : undefined;
			if (iconSize !== undefined) {
				send(res, 200, "image/png", appIcon(iconSize), JSON_CSP);
				return;
			}
			if (url.pathname.startsWith("/boards/")) {
				board(res, url.pathname, options, warn);
				return;
			}
			send(res, 404, "text/plain; charset=utf-8", "not found\n");
	}
}

/** A slow view requested during the start-up warm waits for its stage: one scan of each run, never two side by side. */
function afterWarm(res: ServerResponse, options: ViewerOptions, view: Parameters<typeof warming>[1], respond: () => void): void {
	const fail = () => { if (!res.headersSent) sendJson(res, 500, { error: "internal error" }); else res.destroy(); };
	void (warming(options, view) ?? Promise.resolve()).then(respond).catch(fail);
}

export function createViewer(options: ViewerOptions): Server {
	const log = options.log ?? ((line) => process.stderr.write(line));
	const warn = onceWarner(log);
	const server = createServer((req, res) => handle(req, res, options, warn));
	// After listen, never before: the build runs in small turns behind requests. Each warm view emits `warm` (its name).
	server.once("listening", () => prewarm(options, log, (view) => server.emit("warm", view)));
	return server;
}
