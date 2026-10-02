/**
 * Web Push test helpers: the user agent's side of RFC 8291 (decrypt), written independently of
 * src/push/webpush.ts so a round trip proves the sender, and a throwaway device subscription.
 */
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from "node:crypto";

export function decryptPayload(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
	const salt = body.subarray(0, 16);
	assert.equal(body.readUInt32BE(16), 4096);
	const idlen = body[20] as number;
	const asPublic = body.subarray(21, 21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const uaPublic = ecdh.getPublicKey();
	const hkdf = (ikm: Buffer, s: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync("sha256", ikm, s, info, length));
	const ikm = hkdf(ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
	const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
	const sealed = body.subarray(21 + idlen);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
	assert.equal(padded[padded.length - 1], 2, "last record ends with the 0x02 delimiter");
	return padded.subarray(0, padded.length - 1).toString("utf8");
}

export interface TestDevice {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	ecdh: ECDH;
	auth: Buffer;
	decrypt(body: Buffer): string;
}

/** A device with real ECDH keys, as a browser's `PushSubscription.toJSON()` would describe it. */
export function testDevice(endpoint: string): TestDevice {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		endpoint,
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
		ecdh,
		auth,
		decrypt: (body) => decryptPayload(body, ecdh.getPrivateKey(), auth),
	};
}
