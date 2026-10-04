/**
 * Read-only dashboard HTTP surface: the app, JSON projections, refresh SSE,
 * and published board artifacts. Requests read recorded state only, with two
 * write routes: `POST|DELETE /api/push/subscription` stores or removes this
 * browser's Web Push subscription under `data/push/subscriptions/` (push-api.ts),
 * and `POST /api/operator/message` forwards one message, decision click or abort
 * to the operator's own running session over its owner-only control socket (or, with no session running,
 * holds it in `state/operator/inbox.jsonl`) and journals every refusal to `state/operator/dashboard.jsonl`
 * (control-api.ts); `POST /api/operator/start` runs the fixed `<tmux> new-session -d -s cp-operator <wrapper>` (or a herdr workspace);
 * `POST /api/schedules/request` (with its status `GET /api/schedules/control`) journals one Schedules page request;
 * `POST /api/answers/ack` (with its status `GET /api/answers/control`) appends one `acked` line to `state/operator/answers.jsonl`.
 * The one request that reaches the parent does so only as a line in `state/schedule-control.jsonl`, which the
 * parent reads. Every route answers only
 * its own bind Host; the operator's own Full transcript
 * (`/api/sessions?view=you&transcript=1`), both dashboard-control routes, both schedule-control routes and both answers routes are
 * served only by a viewer started with `--require-tailnet` and refused 403 otherwise.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { boardView, jobsView, jobView, jobEvents } from "./jobs-view.ts";
import { reportsView } from "./reports-view.ts";
import { schedulesView } from "./schedules-view.ts";
import { overview } from "./overview-view.ts";
import { sessionsView } from "./sessions-view.ts";
import { filesView } from "./files-view.ts";
import { dependencyMap } from "./mandates-map-view.ts";
import { APP_CSP, appPage, type ViewerApp } from "./app-page.ts";
import { refreshStream, refreshStreams } from "./refresh-stream.ts";
import { awaitingScreen, decidedScreen, decisionsScreen } from "./decision-views.ts";
import { BOARD_CSP, BOARD_CSS, type BoardWarn, contentType, listBoards, onceWarner, readBoard, resolveBoardFile } from "./boards.ts";
import { gitView, jobRoot, listOrRead, roots, safePatch } from "./explorer.ts";
import { dashboard, jobDetail } from "./fleet-view.ts";
import { sidebar, type ViewerState } from "./sessions.ts";
import { handlePushSubscription, PUSH_STATUS_PATH, PUSH_SUBSCRIPTION_PATH, pushStatus } from "./push-api.ts";
import { ANSWER_ACK_PATH, ANSWERS_CONTROL_PATH, CONTROL_MESSAGE_PATH, CONTROL_STATUS_PATH, type ControlLimiter, handleAnswerAck, handleAnswersControlStatus, handleControlMessage, handleControlStatus, handleOperatorStart, handleScheduleControl, handleScheduleControlStatus, OPERATOR_START_PATH, type OperatorStart, SCHEDULE_CONTROL_PATH, SCHEDULE_CONTROL_STATUS_PATH } from "./control-api.ts";
import { handleOperatorRestart } from "./operator-restart.ts";
import { handleOperatorUpload, OPERATOR_UPLOAD_PATH, OPERATOR_UPLOADS_PREFIX, serveOperatorUpload } from "./operator-upload-api.ts";
import { OPERATOR_RESTART_PATH } from "./restart-status.ts";
import { SERVICE_WORKER_JS, SERVICE_WORKER_PATH } from "./service-worker.ts";
import { APP_ICONS, appIcon, MANIFEST_JSON, MANIFEST_PATH } from "./app-manifest.ts";

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
	uploadLimiter?: ControlLimiter;
	/** Start session (`POST /api/operator/start`): test seams and the last start's time. */
	operatorStart?: OperatorStart;
	/** Where a skipped board is reported, once per (slug, reason). Default stderr. */
	log?: (line: string) => void;
}

/** `host:port` as a browser sends it in the Host header (IPv6 bracketed). */
export function hostHeaderFor(host: string, port: number): string {
	return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * DNS-rebinding guard: only the exact configured bind is accepted. A missing
 * Host header, another name for the same address, or another port is refused.
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

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
	res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...extra });
	res.end(body);
}

const JSON_CSP = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(value), { ...JSON_CSP, ...extra });
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
	if (!hostAllowed(req.headers.host, options.host, options.port)) {
		send(res, 421, "text/plain; charset=utf-8", `refused: Host must be ${hostHeaderFor(options.host, options.port)}\n`);
		return;
	}
	const requestPath = (req.url ?? "/").split("?")[0];
	if (requestPath === PUSH_SUBSCRIPTION_PATH || requestPath === CONTROL_MESSAGE_PATH || requestPath === OPERATOR_START_PATH || requestPath === OPERATOR_RESTART_PATH || requestPath === OPERATOR_UPLOAD_PATH || requestPath === SCHEDULE_CONTROL_PATH || requestPath === ANSWER_ACK_PATH) {
		(requestPath === PUSH_SUBSCRIPTION_PATH ? handlePushSubscription(req, options) : requestPath === CONTROL_MESSAGE_PATH ? handleControlMessage(req, options) : requestPath === SCHEDULE_CONTROL_PATH ? handleScheduleControl(req, options) : requestPath === ANSWER_ACK_PATH ? handleAnswerAck(req, options) : requestPath === OPERATOR_RESTART_PATH ? handleOperatorRestart(req, options) : requestPath === OPERATOR_UPLOAD_PATH ? handleOperatorUpload(req, options) : handleOperatorStart(req, options))
			.then((out) => sendJson(res, out.status, out.body, out.headers))
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
	// passes); the Host guard above still runs first, for every route.
	if (url.searchParams.get("transcript") === "1" && options.requireTailnet !== true) {
		sendJson(res, 403, { error: "the operator transcript is served only under --require-tailnet" });
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
			send(res, options.app ? 200 : 503, "text/html; charset=utf-8", appPage(options.app), { "content-security-policy": APP_CSP });
			return;
		case "/api/identity":
			sendJson(res, 200, { viewer: "command-post", home: resolve(options.home) });
			return;
		case "/healthz":
			send(res, 200, "text/plain; charset=utf-8", "ok\n");
			return;
		case PUSH_STATUS_PATH:
			sendJson(res, 200, pushStatus(options));
			return;
		case CONTROL_STATUS_PATH:
			handleControlStatus(req, options)
				.then((out) => sendJson(res, out.status, out.body, out.headers))
				.catch(() => {
					if (!res.headersSent) sendJson(res, 500, { error: "internal" });
				});
			return;
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
    sendJson(res,view ? 200 : 404,view ?? {error:"no such session"}); return;
   }
			send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ...sidebar(options), boards: listBoards(options, warn) }));
			return;
  }
		case "/api/jobs":
			sendJson(res, 200, jobsView(options));
			return;
		case "/api/board":
			sendJson(res, 200, boardView(options));
			return;
		case "/api/reports":
			sendJson(res, 200, reportsView(options, warn));
			return;
		case "/api/schedules":
			sendJson(res, 200, schedulesView(options, warn));
			return;
		case "/api/overview":
			sendJson(res, 200, overview(options));
			return;
		case "/api/map":
			sendJson(res, 200, dependencyMap(options));
			return;
		case "/api/dashboard":
			sendJson(res, 200, dashboard(options));
			return;
		case "/api/awaiting":
			sendJson(res, 200, awaitingScreen(options));
			return;
		case "/api/decided":
			sendJson(res, 200, decidedScreen(options));
			return;
		case "/api/decisions":
			sendJson(res, 200, decisionsScreen(options));
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
    sendJson(res,view ? 200 : 404,view ?? {error:"no such path"}); return;
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
			if (["overview", "awaiting", "decided", "decisions", "sessions", "files", "map", "jobs", "job", "board", "reports", "schedules"].includes(url.searchParams.get("view") ?? "")) { refreshStream(req, res); return; }
			send(res, 404, "text/plain; charset=utf-8", "no such view\n");
			return;
		}
		default:
			if (url.pathname.startsWith("/api/job/")) {
				const match = /^\/api\/job\/([^/]+)(\/events)?$/.exec(url.pathname);
				let id = ""; try { id = decodeURIComponent(match?.[1] ?? ""); } catch { /* Invalid encoding is not a job id. */ }
				const job = jobView(options, id);
				if (job && match?.[2]) {
					const log = jobEvents(options, id);
					send(res, log === undefined ? 404 : 200, "text/plain; charset=utf-8", log ?? "Run log unavailable (missing or exceeds 16 MiB).\n", { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
					return;
				}
				sendJson(res, job ? 200 : 404, job ?? { error: "no such job" });
				return;
			}
			if (url.pathname.startsWith("/assets/viewer/")) {
				const asset = options.app && Object.hasOwn(options.app.assets, url.pathname) ? options.app.assets[url.pathname] : undefined;
				send(res, asset ? 200 : 404, asset?.mime ?? "text/plain; charset=utf-8", asset ? Buffer.from(asset.bytes) : "not found\n", { "content-security-policy": APP_CSP });
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

export function createViewer(options: ViewerOptions): Server {
	const warn = onceWarner(options.log ?? ((line) => process.stderr.write(line)));
	return createServer((req, res) => handle(req, res, options, warn));
}
