/**
 * Composer image attachments (cp-br81 plan, PR1): `POST /api/operator/upload` stores one image the composer
 * attached, `GET /api/operator/uploads/<id>` serves it back as the composer's thumbnail. Storage, ids and limits
 * live in src/viewer/uploads.ts; the message route sends ids, and the bridge inlines the bytes (src/dashboard-control.ts).
 *
 * Upload refusal order: the shared chain (`guarded` in image mode: method, --require-tailnet, its own 24/60 s
 * limiter, opt-out, Origin, Sec-Fetch-Site, image Content-Type, 10 MiB), then a live session (409), its CSRF token
 * (403), the magic bytes (415), a safe directory (503), the 256 MiB cap after the 7-day sweep (507), the `upload`
 * journal line first (500, nothing stored), the write (500). Every refusal is one `refused` line (kind `upload`).
 */
import type { IncomingMessage } from "node:http";
import type { OperatorUploadResponse } from "./api-types.ts";
import { appendControlAudit } from "./control-audit.ts";
import { type ControlRouteOptions, type ControlRouteResult, guarded, tokenMatches } from "./control-api.ts";
import { readControlRecord } from "./control-files.ts";
import { operatorSession } from "./control-inbox.ts";
import { ensureUploadDir, isUploadId, isTextUploadId, newUploadId, readUpload, sanitizeUploadName, sniffImage, sweepUploads, textExtension, TEXT_UPLOAD_MAX_BYTES, UPLOAD_DIR_MAX_BYTES, UPLOAD_MAX_AGE_MS, UPLOAD_MAX_BYTES, uploadRoot, validateText, writeUpload } from "./uploads.ts";

export const OPERATOR_UPLOAD_PATH = "/api/operator/upload";
export const OPERATOR_UPLOADS_PREFIX = "/api/operator/uploads/";

export function handleOperatorUpload(req: IncomingMessage, options: ControlRouteOptions, now = new Date()): Promise<ControlRouteResult> {
	const header = req.headers["x-cp-upload-name"];
	let name: string | undefined;
	try { if (typeof header === "string") name = decodeURIComponent(header); } catch { /* refused after the shared guards */ }
	const ext = name === undefined ? undefined : textExtension(name);
	const text = ext !== undefined || (header !== undefined && !/^image\//i.test(req.headers["content-type"] ?? ""));
	return guarded(req, options, now, "upload", async (raw, { peer, refuse }) => {
		const bytes = raw as Buffer;
		const record = readControlRecord(options.stateDir);
		const session = operatorSession(options.stateDir);
		if (record.state !== "ok" || !session.running) return refuse(409, `attachments need a running operator session (${session.reason}); start it, or send text only`);
		if (!tokenMatches(req.headers["x-cp-control-token"], record.record.csrf)) return refuse(403, "control token missing or stale; reload the transcript");
		if (header !== undefined && name === undefined) return refuse(400, "x-cp-upload-name must be a URI-encoded filename");
		if (text && !ext) return refuse(415, "text attachments must have a .txt, .md, .html or .json extension");
		if (text) {
			const checked = validateText(bytes, ext!);
			if ("refused" in checked) return refuse(415, checked.refused);
		}
		const sniffed = text ? { ext: ext!, mime: "text/plain" } : sniffImage(bytes);
		if (!("ext" in sniffed)) return refuse(415, sniffed.refused === "heic" ? "HEIC/HEIF is not supported; share the photo as JPEG" : "not a PNG, JPEG, WebP or GIF image");
		const safeName = name === undefined ? undefined : sanitizeUploadName(name);
		const root = uploadRoot(options.uploadRoot);
		let total: number;
		try {
			ensureUploadDir(root);
			total = sweepUploads(root, now).total;
		} catch (error) {
			return refuse(503, (error as Error).message);
		}
		if (total + bytes.length > UPLOAD_DIR_MAX_BYTES) return refuse(507, `upload space full: ${total} of ${UPLOAD_DIR_MAX_BYTES} bytes used; attachments expire after 7 days, or remove ${root}`);
		const id = newUploadId(sniffed.ext, now);
		// Journal first: an image the journal cannot name is never stored. Ids, mime and size only, never bytes.
		const journaled = appendControlAudit(options.stateDir, { type: "upload", by: "viewer", id, at: now.toISOString(), peer, mime: sniffed.mime, bytes: bytes.length, ...(safeName ? { name: safeName } : {}) });
		if (!journaled.ok) return refuse(500, `audit journal unwritable (${journaled.error}); nothing was stored`);
		try {
			writeUpload(root, id, bytes);
		} catch (error) {
			return refuse((error as Error).name === "UploadDirError" ? 503 : 500, `upload ${id} not stored: ${(error as Error).message}`);
		}
		const body: OperatorUploadResponse = { id, mime: sniffed.mime, bytes: bytes.length, expires_at: new Date(now.getTime() + UPLOAD_MAX_AGE_MS).toISOString(), url: `${OPERATOR_UPLOADS_PREFIX}${id}`, ...(safeName ? { name: safeName } : {}) };
		return { status: 201, body };
	}, { image: UPLOAD_MAX_BYTES, ...(text ? { text: TEXT_UPLOAD_MAX_BYTES } : {}) });
}

const json = (status: number, error: string) => ({ status, type: "application/json; charset=utf-8", body: JSON.stringify({ error }), headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" } });

/** `GET|HEAD /api/operator/uploads/<id>`: tailnet-only like the full transcript; same-origin; gone or expired is 404. */
export function serveOperatorUpload(req: IncomingMessage, options: { requireTailnet?: boolean; uploadRoot?: string }, rawId: string, now = new Date()): { status: number; type: string; body: string | Buffer; headers: Record<string, string> } {
	if (options.requireTailnet !== true) return json(403, "uploads are served only under --require-tailnet");
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") return json(403, "cross-site request refused");
	if (!isUploadId(rawId)) return json(400, "not an upload id");
	const read = readUpload(uploadRoot(options.uploadRoot), rawId, now);
	if (read.state !== "ok") return json(404, isTextUploadId(rawId) ? "file expired" : "image expired");
	return {
		status: 200,
		type: isTextUploadId(rawId) ? "text/plain; charset=utf-8" : read.mime,
		body: read.bytes,
		headers: {
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; img-src 'self'; sandbox",
			"cross-origin-resource-policy": "same-origin",
			"content-disposition": "inline",
			"cache-control": "private, max-age=604800, immutable",
		},
	};
}
