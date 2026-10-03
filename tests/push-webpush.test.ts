import assert from "node:assert/strict";
import { createECDH, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { decryptPayload } from "./harness/push.ts";
import {
	b64url,
	classifyPushStatus,
	deliver,
	encryptPayload,
	fromB64url,
	type PushRequestInit,
	publicKeyOf,
	VAPID_EXPIRY_SECONDS,
	vapidAuthorization,
} from "../src/push/webpush.ts";

// RFC 8291 Appendix A.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};


test("encryptPayload reproduces the RFC 8291 Appendix A body byte for byte", () => {
	const body = encryptPayload(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { senderPrivateKey: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) });
	assert.equal(b64url(body), RFC.body);
	assert.equal(decryptPayload(body, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth)), RFC.plaintext);
});

test("encryptPayload round-trips with a fresh sender key and salt, and refuses oversize or malformed input", () => {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = Buffer.alloc(16, 7);
	const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
	const one = encryptPayload('{"project":"demo"}', keys);
	const two = encryptPayload('{"project":"demo"}', keys);
	assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16), "a fresh salt per message");
	assert.equal(decryptPayload(one, ua.getPrivateKey(), auth), '{"project":"demo"}');
	assert.throws(() => encryptPayload("x".repeat(3994), keys), /at most 3993/);
	assert.doesNotThrow(() => encryptPayload("x".repeat(3993), keys));
	assert.throws(() => encryptPayload("x", { ...keys, auth: b64url(Buffer.alloc(8)) }), /auth is not 16 bytes/);
	assert.throws(() => encryptPayload("x", { ...keys, p256dh: b64url(Buffer.alloc(33, 2)) }), /uncompressed P-256/);
});

test("vapidAuthorization is an ES256 JWT for the endpoint's origin, 12 h, with our public key", () => {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const publicKey = publicKeyOf(privateKey);
	const now = new Date("2026-09-27T00:00:00Z");
	const header = vapidAuthorization({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { publicKey, privateKey, subject: "https://cp.example.com" }, now });
	const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
	assert.ok(match, header);
	const [, h, c, s, k] = match as unknown as [string, string, string, string, string];
	assert.deepEqual(JSON.parse(fromB64url(h).toString()), { typ: "JWT", alg: "ES256" });
	assert.deepEqual(JSON.parse(fromB64url(c).toString()), { aud: "https://fcm.googleapis.com", exp: now.getTime() / 1000 + VAPID_EXPIRY_SECONDS, sub: "https://cp.example.com" });
	assert.ok(VAPID_EXPIRY_SECONDS <= 24 * 3600);
	assert.equal(fromB64url(k).length, 65);
	assert.deepEqual(fromB64url(k), publicKey);
	const signature = fromB64url(s);
	assert.equal(signature.length, 64);
	assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, signature));
	assert.throws(() => vapidAuthorization({ endpoint: "not a url", keys: { publicKey, privateKey, subject: "mailto:a@b.c" }, now }), (error: Error) => !error.message.includes("not a url"));
});

test("classifyPushStatus: 2xx delivered, 404/410 gone, 429/5xx retry, other 4xx rejected", () => {
	assert.equal(classifyPushStatus(201), "delivered");
	for (const status of [404, 410]) assert.equal(classifyPushStatus(status), "gone");
	for (const status of [429, 500, 503]) assert.equal(classifyPushStatus(status), "retry");
	for (const status of [400, 401, 403, 413]) assert.equal(classifyPushStatus(status), "rejected");
});

test("deliver posts once with the RFC 8030 headers and never follows a redirect; errors are retry and never echo the endpoint", async () => {
	const endpoint = "https://fcm.googleapis.com/fcm/send/secret-token";
	const calls: Array<{ url: string; init: PushRequestInit }> = [];
	const ok = await deliver({ endpoint, body: Buffer.from("x"), authorization: "vapid t=a.b.c, k=d", fetch: async (url, init) => (calls.push({ url, init }), { status: 201, text: async () => "" }) });
	assert.deepEqual(ok, { kind: "delivered" });
	assert.equal(calls.length, 1);
	const init = calls[0]!.init;
	assert.equal(init.method, "POST");
	assert.equal(init.redirect, "error");
	assert.deepEqual(init.headers, { TTL: "43200", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: "vapid t=a.b.c, k=d" });
	assert.ok(init.signal instanceof AbortSignal);
	const thrown = await deliver({ endpoint, body: Buffer.from("x"), authorization: "a", fetch: async () => { throw new TypeError(`fetch failed for ${endpoint}`); } });
	assert.equal(thrown.kind, "retry");
	assert.doesNotMatch(JSON.stringify(thrown), /secret-token/);
	assert.deepEqual(await deliver({ endpoint, body: Buffer.from("x"), authorization: "a", fetch: async () => ({ status: 410, text: async () => "" }) }), { kind: "gone", status: 410 });
	const rejected = await deliver({ endpoint, body: Buffer.from("x"), authorization: "a", fetch: async () => ({ status: 403, text: async () => `bad\n  vapid ${"y".repeat(300)}` }) });
	assert.equal(rejected.kind, "rejected");
	assert.match((rejected as { reason: string }).reason, /^HTTP 403 bad vapid y+$/);
	assert.ok((rejected as { reason: string }).reason.length <= 140);
	// A long endpoint is redacted before truncation: no capability fragment survives, in a response or an exception.
	const long = `https://fcm.googleapis.com/fcm/send/${"SYNTHETIC_CAPABILITY_".repeat(12)}`;
	const leaks = [
		await deliver({ endpoint: long, body: Buffer.from("x"), authorization: "a", fetch: async () => ({ status: 403, text: async () => long }) }),
		await deliver({ endpoint: long, body: Buffer.from("x"), authorization: "a", fetch: async () => { throw new TypeError(`fetch failed for ${long}`); } }),
	];
	for (const out of leaks) {
		assert.doesNotMatch(JSON.stringify(out), /SYNTHETIC_CAPABILITY|fcm\.googleapis/);
		assert.match((out as { reason: string }).reason, /<endpoint>/);
	}
});
