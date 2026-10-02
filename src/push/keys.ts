/**
 * VAPID keys for Web Push (RFC 8292), home-local. `initPush` generates one P-256 key pair once:
 * `data/push/vapid.key` (0600, the private JWK, read only by the parent's sweep) and `data/push/config.json`
 * (the public half, origin and subject, read by the viewer). Keys are never overwritten, and no message here
 * ever carries key material — not even a JSON parse error, whose text can quote the file.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createPrivateKey, type JsonWebKey, type KeyObject } from "node:crypto";
import { dirname } from "node:path";
import { isoTimestamp, SCHEMA_VERSION } from "../contracts.ts";
import { atomicWriteJson } from "../json-store.ts";
import { pushConfigFile, readPushConfig, vapidKeyFile } from "../viewer/push-files.ts";
import { b64url, fromB64url, generateVapidKeyPair, publicKeyOf, type VapidSigner } from "./webpush.ts";

export class PushConfigError extends Error {}

/** The dashboard's HTTPS origin: `https:`, no path, query, fragment or credentials. */
export function normalizeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PushConfigError(`origin ${JSON.stringify(value)} is not a URL; pass the dashboard's HTTPS origin, e.g. --origin https://cp.example.com`);
	}
	if (url.protocol !== "https:") throw new PushConfigError(`origin must be https: (Web Push needs a secure context), not ${url.protocol}`);
	if (url.username || url.password) throw new PushConfigError("origin must not carry credentials");
	if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) throw new PushConfigError("origin must have no path, query or fragment");
	return url.origin;
}

function normalizeSubject(value: string): string {
	if (/^mailto:[^\s@]+@[^\s@]+$/.test(value)) return value;
	try {
		return normalizeOrigin(value);
	} catch {
		throw new PushConfigError("subject must be mailto:<address> or an https: URL (RFC 8292 §2.1)");
	}
}

/** Read the private key; throws PushConfigError naming the file, never its content. */
function readPrivateKey(file: string): KeyObject {
	let jwk: unknown;
	try {
		jwk = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new PushConfigError(`${file} is missing or not valid JSON`);
	}
	const key = jwk as { kty?: unknown; crv?: unknown; d?: unknown };
	if (key === null || typeof key !== "object" || key.kty !== "EC" || key.crv !== "P-256" || typeof key.d !== "string") {
		throw new PushConfigError(`${file} is not a P-256 private JWK`);
	}
	try {
		// SAFETY: shape checked above (kty EC, crv P-256, string d); createPrivateKey validates the rest.
		return createPrivateKey({ key: jwk as JsonWebKey, format: "jwk" });
	} catch {
		throw new PushConfigError(`${file} is not a usable P-256 private key`);
	}
}

export interface InitPushResult {
	origin: string;
	/** A key pair was generated this run. */
	created: boolean;
	/** config.json was (re)written this run. */
	configWritten: boolean;
	originChanged: boolean;
	configFile: string;
	keyFile: string;
}

export function initPush(options: { dataDir: string; origin: string; subject?: string; now?: Date }): InitPushResult {
	const origin = normalizeOrigin(options.origin);
	const subject = normalizeSubject(options.subject ?? origin);
	const configFile = pushConfigFile(options.dataDir);
	const keyFile = vapidKeyFile(options.dataDir);
	mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
	let created = false;
	let publicKey: Buffer;
	if (existsSync(keyFile)) {
		publicKey = publicKeyOf(readPrivateKey(keyFile));
	} else {
		const pair = generateVapidKeyPair();
		const tmp = `${keyFile}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(pair.privateJwk)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(tmp, keyFile);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw new PushConfigError(`cannot write ${keyFile}: ${(error as NodeJS.ErrnoException).code ?? "write failed"}`);
		}
		chmodSync(keyFile, 0o600);
		publicKey = pair.publicKey;
		created = true;
	}
	const existing = existsSync(configFile) ? readPushConfig(options.dataDir) : undefined;
	const public_key = b64url(publicKey);
	const same = existing?.origin === origin && existing.subject === subject && existing.public_key === public_key;
	if (!same) {
		atomicWriteJson(configFile, { schema_version: SCHEMA_VERSION, origin, subject, public_key, created_at: existing?.created_at ?? isoTimestamp(options.now ?? new Date()) });
	}
	return { origin, created, configWritten: !same, originChanged: existing !== undefined && existing.origin !== origin, configFile, keyFile };
}

export interface VapidKeys extends VapidSigner {
	origin: string;
}

/**
 * The signing keys, or undefined when push is not set up (no config.json). A config without a usable key, or a
 * key whose public half is not the one devices subscribed with, is a PushConfigError: sending would be refused.
 */
export function readVapidKeys(dataDir: string): VapidKeys | undefined {
	const configFile = pushConfigFile(dataDir);
	if (!existsSync(configFile)) return undefined;
	const config = readPushConfig(dataDir);
	if (!config) throw new PushConfigError(`${configFile} is not a valid push config`);
	const privateKey = readPrivateKey(vapidKeyFile(dataDir));
	const publicKey = publicKeyOf(privateKey);
	if (!publicKey.equals(fromB64url(config.public_key))) throw new PushConfigError(`${vapidKeyFile(dataDir)} does not match the public key in ${configFile}`);
	return { origin: config.origin, subject: config.subject, publicKey, privateKey };
}
