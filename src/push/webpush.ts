/**
 * Web Push on the wire (Pier 1.1), `node:crypto` only — written from the RFCs, not from any library:
 *
 *  - RFC 8291 message encryption over RFC 8188 `aes128gcm` (one record, rs 4096);
 *  - RFC 8292 VAPID: an ES256 JWT for the push service's origin, plus our public key;
 *  - RFC 8030 delivery: one POST, classified into delivered / gone / retry / rejected.
 *
 * Nothing here logs. A reason string never carries the endpoint, a key or the payload.
 */

import { createCipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, type JsonWebKey, type KeyObject, randomBytes, sign } from "node:crypto";

export const PUSH_TTL_SECONDS = 43_200;
export const VAPID_EXPIRY_SECONDS = 43_200;
export const PUSH_RECORD_SIZE = 4096;
/** RFC 8291 §4: 4096 − 86 bytes of header and tag − 1 padding delimiter … rounded to what a push service must accept. */
export const PUSH_MAX_PLAINTEXT_BYTES = 3993;
export const PUSH_FETCH_TIMEOUT_MS = 10_000;

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** The uncompressed 65-byte P-256 point of a JWK. */
export function publicKeyFromJwk(jwk: JsonWebKey): Buffer {
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("not an EC public key");
	return Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]);
}

/** The public point a private key implies — derived from `d`, never trusted from a stored x/y. */
export function publicKeyOf(privateKey: KeyObject): Buffer {
	return publicKeyFromJwk(createPublicKey(privateKey).export({ format: "jwk" }));
}

export function generateVapidKeyPair(): { publicKey: Buffer; privateJwk: JsonWebKey } {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	return { publicKey: publicKeyOf(privateKey), privateJwk: privateKey.export({ format: "jwk" }) };
}

export interface PushTargetKeys {
	p256dh: string;
	auth: string;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * RFC 8291 §3.4 + RFC 8188 §2: `salt ‖ rs ‖ idlen ‖ as_public ‖ AES-128-GCM(plaintext ‖ 0x02)`. `seed` pins the
 * sender key and salt for the RFC 8291 Appendix A vector; production always draws fresh ones per message.
 */
export function encryptPayload(plaintext: string | Uint8Array, target: PushTargetKeys, seed?: { senderPrivateKey?: Buffer; salt?: Buffer }): Buffer {
	const data = Buffer.from(plaintext);
	if (data.length > PUSH_MAX_PLAINTEXT_BYTES) throw new Error(`push payload is ${data.length} bytes; at most ${PUSH_MAX_PLAINTEXT_BYTES} fit one record`);
	const uaPublic = fromB64url(target.p256dh);
	const auth = fromB64url(target.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
	if (auth.length !== 16) throw new Error("auth is not 16 bytes");
	const ecdh = createECDH("prime256v1");
	if (seed?.senderPrivateKey) ecdh.setPrivateKey(seed.senderPrivateKey);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const ikm = hkdf(ecdh.computeSecret(uaPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
	const salt = seed?.salt ?? randomBytes(16);
	const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const sealed = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(PUSH_RECORD_SIZE, 16);
	header[20] = asPublic.length;
	return Buffer.concat([header, asPublic, sealed]);
}

export interface VapidSigner {
	publicKey: Buffer;
	privateKey: KeyObject;
	subject: string;
}

/** RFC 8292 §3: `vapid t=<ES256 JWT>, k=<public key>` for the endpoint's origin, valid 12 h. */
export function vapidAuthorization(input: { endpoint: string; keys: VapidSigner; now: Date }): string {
	const part = (value: Record<string, unknown>) => b64url(Buffer.from(JSON.stringify(value)));
	let aud: string;
	try {
		aud = new URL(input.endpoint).origin;
	} catch {
		throw new Error("push endpoint is not a URL"); // never echo the endpoint: it is a capability
	}
	const claims = { aud, exp: Math.floor(input.now.getTime() / 1000) + VAPID_EXPIRY_SECONDS, sub: input.keys.subject };
	const signingInput = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
	const signature = sign("sha256", Buffer.from(signingInput), { key: input.keys.privateKey, dsaEncoding: "ieee-p1363" });
	return `vapid t=${signingInput}.${b64url(signature)}, k=${b64url(input.keys.publicKey)}`;
}

export type PushStatusClass = "delivered" | "gone" | "retry" | "rejected";

/** 2xx delivered; 404/410 the subscription is gone; 429 and 5xx are worth retrying; any other status is final. */
export function classifyPushStatus(status: number): PushStatusClass {
	if (status >= 200 && status < 300) return "delivered";
	if (status === 404 || status === 410) return "gone";
	if (status === 429 || status >= 500) return "retry";
	return "rejected";
}

export type PushOutcome = { kind: "delivered" } | { kind: "gone"; status: number } | { kind: "retry"; reason: string } | { kind: "rejected"; reason: string };

export interface PushRequestInit {
	method: "POST";
	headers: Record<string, string>;
	body: Uint8Array<ArrayBuffer>;
	redirect: "error";
	signal: AbortSignal;
}
export type PushFetch = (url: string, init: PushRequestInit) => Promise<{ status: number; text(): Promise<string> }>;

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** One POST to one push service. Never throws: a network error or timeout is `retry`. */
export async function deliver(input: { endpoint: string; body: Uint8Array; authorization: string; fetch?: PushFetch; timeoutMs?: number }): Promise<PushOutcome> {
	const redact = (text: string) => text.split(input.endpoint).join("<endpoint>");
	const send: PushFetch = input.fetch ?? ((url, init) => fetch(url, init));
	try {
		const response = await send(input.endpoint, {
			method: "POST",
			headers: {
				TTL: String(PUSH_TTL_SECONDS),
				Urgency: "high",
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				Authorization: input.authorization,
			},
			body: new Uint8Array(input.body),
			redirect: "error",
			signal: AbortSignal.timeout(input.timeoutMs ?? PUSH_FETCH_TIMEOUT_MS),
		});
		const kind = classifyPushStatus(response.status);
		if (kind === "delivered") return { kind };
		if (kind === "gone") return { kind, status: response.status };
		const text = await response.text().catch(() => "");
		return { kind, reason: redact(oneLine(`HTTP ${response.status}${text ? ` ${oneLine(text, 120)}` : ""}`, 140)) };
	} catch (error) {
		const cause = (error as { cause?: { message?: unknown } }).cause?.message;
		const message = `${(error as Error).message ?? String(error)}${typeof cause === "string" ? `: ${cause}` : ""}`;
		return { kind: "retry", reason: redact(oneLine(message, 140)) };
	}
}
