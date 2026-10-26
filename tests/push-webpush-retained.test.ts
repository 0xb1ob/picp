/**
 * Retained from tests/push-webpush.test.ts (P22): `encryptPayload` with an injected sender key and salt (the RFC 8291
 * vector) and its 3993-byte cap. No entry point fixes the ephemeral key or builds a payload near the cap.
 */
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { test } from "node:test";
import { decryptPayload } from "./harness/push.ts";
import { b64url, encryptPayload, fromB64url } from "../src/push/webpush.ts";

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
