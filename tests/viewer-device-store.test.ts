/**
 * Remote dashboard PR 1 (A2/A3/A4/A6/A8 at the store boundary): codes, sessions, the 0600 hash-only store, the
 * three-commit pairing transaction and its crash recovery, and the access helpers that keep remote callers from minting.
 */
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { LAYOUT } from "../src/contracts.ts";
import { canControl, canMint, canRead, canRevoke, LOCAL_ACCESS, mintPeer, remoteAccess } from "../src/viewer/access.ts";
import { appendControlAudit } from "../src/viewer/control-audit.ts";
import { controlJournalFile } from "../src/viewer/control-files.ts";
import { auditedPairings, DEVICE_CODE_TTL_MS, DEVICE_SESSION_TTL_MS, devicesFile, readDeviceState } from "../src/viewer/device-files.ts";
import { type DeviceAuditLine, DeviceStore, type DeviceStorePorts, sessionCookie } from "../src/viewer/device-store.ts";

const ORIGIN = "https://cp.example.test";
const BIND = { origin: ORIGIN, generation: 1 };
const T0 = Date.parse("2026-10-01T00:00:00Z");

function scratch(t: { after(fn: () => void): void }, ports: DeviceStorePorts = {}) {
	const root = mkdtempSync(join(tmpdir(), "cp-devices-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dataDir = join(root, LAYOUT.data), stateDir = join(root, LAYOUT.state);
	let now = T0;
	const clock = { advance: (ms: number) => { now += ms; } };
	const make = (extra: DeviceStorePorts = {}) => new DeviceStore(dataDir, stateDir, { now: () => new Date(now), ...ports, ...extra });
	const audit = (): DeviceAuditLine[] => {
		try { return readFileSync(controlJournalFile(stateDir), "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row)); } catch { return []; }
	};
	return { root, dataDir, stateDir, clock, make, store: make(), audit };
}

function pair(store: DeviceStore, name: string, level: "full" | "view" = "full") {
	const issued = store.issueCode({ ...BIND, route: "cli-pair", level });
	assert.equal(issued.ok, true);
	const claimed = store.claim({ ...BIND, code: (issued as { code: string }).code, name });
	assert.equal(claimed.ok, true, JSON.stringify(claimed));
	return claimed as Extract<typeof claimed, { ok: true }>;
}

test("a pairing stores only hashes in a 0600 file, returns a 256-bit session once and sets a __Host- cookie", (t) => {
	const { store, dataDir, stateDir, audit } = scratch(t);
	const issued = store.issueCode({ ...BIND, route: "loopback-dashboard" });
	assert.ok(issued.ok);
	assert.equal(issued.level, "full", "full by default");
	assert.equal(Buffer.from(issued.code, "base64url").length, 32, "at least 128 random bits");
	assert.equal(issued.expires_at, new Date(T0 + DEVICE_CODE_TTL_MS).toISOString());
	const claimed = store.claim({ ...BIND, code: issued.code, name: "  Phone  " });
	assert.ok(claimed.ok);
	assert.equal(claimed.device.name, "Phone");
	assert.equal(claimed.device.state, "active");
	const [, secret] = claimed.cookie.split(".");
	assert.equal(Buffer.from(secret!, "base64url").length, 32, "at least 256 random bits");
	assert.equal(statSync(devicesFile(dataDir)).mode & 0o777, 0o600);
	assert.equal(statSync(dataDir).mode & 0o777, 0o700);
	const raw = readFileSync(devicesFile(dataDir), "utf8");
	const journal = readFileSync(controlJournalFile(stateDir), "utf8");
	for (const sentinel of [issued.code, secret!]) {
		assert.equal(raw.includes(sentinel), false, "no secret in devices.json");
		assert.equal(journal.includes(sentinel), false, "no secret in the audit journal");
	}
	assert.equal("session_digest" in claimed.device, false, "views never carry the digest");
	assert.deepEqual(audit().map((line) => line.event), ["code_issued", "paired"]);
	assert.equal(audit().every((line) => line.id === null), true, "composer readers skip device lines");
	const cookie = sessionCookie(claimed.cookie);
	assert.match(cookie, /^__Host-cp_device=/);
	for (const part of ["Max-Age=2592000", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(cookie.split("; ").includes(part), part);
	assert.doesNotMatch(cookie, /Domain/i);
	const auth = store.authenticate(claimed.cookie, BIND, { touch: true });
	assert.ok(auth.ok);
	assert.equal(auth.device.id, claimed.device.id);
});

test("a code is single-use, expires at five minutes and at most three live codes exist", (t) => {
	const { store, clock } = scratch(t);
	const one = store.issueCode({ ...BIND, route: "cli-pair" });
	assert.ok(one.ok);
	assert.ok(store.claim({ ...BIND, code: one.code, name: "a" }).ok);
	assert.deepEqual(store.claim({ ...BIND, code: one.code, name: "b" }), { ok: false, reason: "code_invalid" }, "a replay is refused");
	const codes = [1, 2, 3].map(() => store.issueCode({ ...BIND, route: "cli-pair" }));
	assert.ok(codes.every((code) => code.ok));
	assert.deepEqual(store.issueCode({ ...BIND, route: "cli-pair" }), { ok: false, reason: "too_many_codes" });
	clock.advance(DEVICE_CODE_TTL_MS - 1);
	assert.ok(store.claim({ ...BIND, code: (codes[0] as { code: string }).code, name: "c" }).ok, "valid just before five minutes");
	clock.advance(1);
	assert.deepEqual(store.claim({ ...BIND, code: (codes[1] as { code: string }).code, name: "d" }), { ok: false, reason: "code_expired" });
	assert.ok(store.issueCode({ ...BIND, route: "cli-pair" }).ok, "expired codes free their slots");
});

// In-process ordering only: the store's synchronous read-change-replace serializes claims inside one viewer process.
// The cross-process single winner (one owner, its socket, one claim winner) is tests/viewer-device-control.test.ts.
test("in-process concurrent claims of one code have exactly one winner", async (t) => {
	const { store, make } = scratch(t);
	const issued = store.issueCode({ ...BIND, route: "cli-up" });
	assert.ok(issued.ok);
	const results = await Promise.all(["x", "y", "z"].map(async (name) => make().claim({ ...BIND, code: issued.code, name })));
	assert.equal(results.filter((result) => result.ok).length, 1);
	const read = readDeviceState(scratchData(store));
	assert.equal(read.state === "ok" && read.store.devices.length, 1);
});
const scratchData = (store: DeviceStore): string => (store as unknown as { dataDir: string }).dataDir;

test("the level is fixed at issue, names are required and unique, and origin/generation bind codes and sessions", (t) => {
	const { store } = scratch(t);
	const view = store.issueCode({ ...BIND, route: "tailnet-dashboard", level: "view" });
	assert.ok(view.ok);
	assert.equal(store.claim({ ...BIND, code: view.code, name: "p", level: "full" }).ok, false, "a supplied different level refuses");
	for (const name of ["", "   ", "a\u0007b", "x".repeat(81), 42]) assert.deepEqual(store.claim({ ...BIND, code: view.code, name }), { ok: false, reason: "name_invalid" });
	assert.deepEqual(store.claim({ ...BIND, generation: 2, code: view.code, name: "p" }), { ok: false, reason: "origin_mismatch" });
	assert.deepEqual(store.claim({ ...BIND, origin: "https://evil.example", code: view.code, name: "p" }), { ok: false, reason: "origin_mismatch" });
	const claimed = store.claim({ ...BIND, code: view.code, name: "Tablet" });
	assert.ok(claimed.ok);
	assert.equal(claimed.device.level, "view");
	const again = store.issueCode({ ...BIND, route: "cli-pair" });
	assert.ok(again.ok);
	assert.deepEqual(store.claim({ ...BIND, code: again.code, name: "tablet" }), { ok: false, reason: "name_taken" });
	assert.deepEqual(store.authenticate(claimed.cookie, { ...BIND, generation: 2 }, { touch: false }), { ok: false, reason: "session_invalid" }, "a new quick generation invalidates the session");
	for (const bad of ["garbage", `${claimed.device.id}.${"A".repeat(43)}`, `${claimed.cookie}.x`]) assert.deepEqual(store.authenticate(bad, BIND, { touch: false }), { ok: false, reason: "session_invalid" });
	assert.deepEqual(store.authenticate(undefined, BIND, { touch: false }), { ok: false, reason: "no_session" });
});

test("sessions slide 30 days on touch only; revoke denies the next request and keeps the row", (t) => {
	const { store, clock, audit } = scratch(t);
	const phone = pair(store, "Phone");
	clock.advance(DEVICE_SESSION_TTL_MS - 1000);
	assert.ok(store.authenticate(phone.cookie, BIND, { touch: false }).ok);
	clock.advance(500);
	assert.ok(store.authenticate(phone.cookie, BIND, { touch: true }).ok, "a real request slides the expiry");
	clock.advance(DEVICE_SESSION_TTL_MS - 1);
	assert.ok(store.authenticate(phone.cookie, BIND, { touch: false }).ok);
	clock.advance(1);
	assert.equal(store.authenticate(phone.cookie, BIND, { touch: false }).ok, false, "expired at 30 days without use");
	const laptop = pair(store, "Laptop");
	assert.deepEqual(store.revoke("nope"), { ok: false, reason: "not_found" });
	const revoked = store.revoke("LAPTOP");
	assert.ok(revoked.ok);
	assert.equal(revoked.device.id, laptop.device.id);
	assert.equal(store.authenticate(laptop.cookie, BIND, { touch: true }).ok, false);
	const listed = store.list();
	assert.ok(listed.ok);
	assert.ok(listed.devices.find((device) => device.id === laptop.device.id)?.revoked_at, "the row stays, marked revoked");
	assert.equal(store.revoke(laptop.device.id).ok, false, "a revoked device is not revoked twice");
	assert.ok(audit().some((line) => line.event === "revoked" && line.device_id === laptop.device.id));
	assert.ok(audit().some((line) => line.event === "signin_refused" && line.reason === "session_invalid"));
});

test("a revoke's push cleanup runs after the durable revoke, and its failure is reported, never undoes the revoke", (t) => {
	const removed: string[] = [];
	const { store, make } = scratch(t, { unsubscribe: (id) => void removed.push(id) });
	const phone = pair(store, "Phone");
	const revoked = store.revoke(phone.device.id);
	assert.ok(revoked.ok);
	assert.deepEqual([removed, revoked.cleanup_error], [[phone.device.id], null]);
	let durable: string | null | undefined;
	const failing = make({
		unsubscribe: () => {
			const listed = failing.list();
			durable = listed.ok ? listed.devices.find((device) => device.id === tablet.device.id)?.revoked_at : undefined;
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		},
	});
	const tablet = pair(failing, "Tablet");
	const refused = failing.revoke("tablet");
	assert.ok(refused.ok);
	assert.ok(durable, "the revoke was already durable when cleanup ran");
	assert.equal(refused.cleanup_error, "push subscription cleanup failed: EACCES");
	assert.equal(failing.authenticate(tablet.cookie, BIND, { touch: true }).ok, false, "the revoke stands");
});

test("malformed storage fails closed for every operation and is never reset", (t) => {
	const { store, dataDir } = scratch(t);
	mkdirSync(dataDir, { recursive: true });
	for (const body of ["{not json", JSON.stringify({ schema_version: 2, devices: [], codes: [], events: [] }), JSON.stringify({ schema_version: 1, devices: [{ id: "x" }], codes: [], events: [] })]) {
		writeFileSync(devicesFile(dataDir), body);
		assert.equal((store.issueCode({ ...BIND, route: "cli-pair" }) as { reason: string }).reason, "store_invalid");
		assert.equal((store.claim({ ...BIND, code: "A".repeat(43), name: "x" }) as { reason: string }).reason, "store_invalid");
		assert.equal((store.authenticate(`dev-${"0".repeat(16)}.${"A".repeat(43)}`, BIND, { touch: true }) as { reason: string }).reason, "store_invalid");
		assert.equal(store.revoke("x").ok, false);
		assert.equal(store.list().ok, false);
		assert.equal(store.recover().ok, false);
		assert.equal(readFileSync(devicesFile(dataDir), "utf8"), body, "bytes untouched");
	}
});

test("a pairing event snapshots every active device (full and view) plus the new one; revoked and stale-generation devices are not recipients", (t) => {
	const { store } = scratch(t);
	const stale = store.issueCode({ ...BIND, generation: 0, route: "cli-up" });
	assert.ok(stale.ok);
	assert.ok(store.claim({ ...BIND, generation: 0, code: stale.code, name: "Stale" }).ok);
	const full = pair(store, "Full");
	const view = pair(store, "View", "view");
	const gone = pair(store, "Gone");
	assert.ok(store.revoke(gone.device.id).ok);
	const fresh = pair(store, "Fresh");
	const listed = store.list();
	assert.ok(listed.ok);
	const event = listed.events.find((item) => item.id === fresh.pairing_id);
	assert.deepEqual(event?.recipients, [full.device.id, view.device.id, fresh.device.id]);
	assert.equal(event?.route, "cli-pair");
	assert.equal(listed.events.length, 5, "one event per successful pairing");
});

test("a code whose audit or write fails is never stored, so it can never be claimed", (t) => {
	const { make, dataDir, stateDir } = scratch(t);
	const noAudit = make({ audit: (line) => (line.event === "code_issued" ? { ok: false, error: "ENOSPC" } : appendControlAudit(stateDir, line)) });
	assert.deepEqual(noAudit.issueCode({ ...BIND, route: "cli-pair" }), { ok: false, reason: "audit_failed" });
	const read = readDeviceState(dataDir);
	assert.equal(read.state === "absent" || (read.state === "ok" && read.store.codes.length === 0), true, "no unaudited code on disk");
	if (process.getuid?.() === 0) return; // root ignores the read-only directory below
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const store = make({ audit: (line) => { if (line.event === "code_issued") chmodSync(dataDir, 0o500); return appendControlAudit(stateDir, line); } });
	let failed: ReturnType<DeviceStore["issueCode"]>;
	try { failed = store.issueCode({ ...BIND, route: "cli-pair" }); } finally { chmodSync(dataDir, 0o700); } // restored even if issueCode throws
	assert.equal(failed.ok, false);
	assert.equal((failed as { reason: string }).reason, "write_failed");
	assert.equal("code" in failed, false, "no code is handed out");
	const after = readDeviceState(dataDir);
	assert.equal(after.state === "absent" || (after.state === "ok" && after.store.codes.length === 0), true, "the failed write left no claimable code");
});

test("failed and replayed claims leave a failure audit only, never a pairing event", (t) => {
	const { store, audit } = scratch(t);
	const issued = store.issueCode({ ...BIND, route: "cli-up" });
	assert.ok(issued.ok);
	assert.equal(store.claim({ ...BIND, code: "B".repeat(43), name: "x" }).ok, false);
	assert.equal(store.claim({ ...BIND, code: "?code=leak", name: "x" }).ok, false);
	assert.ok(store.claim({ ...BIND, code: issued.code, name: "x" }).ok);
	assert.equal(store.claim({ ...BIND, code: issued.code, name: "y" }).ok, false);
	assert.deepEqual(audit().map((line) => [line.event, line.reason]), [["code_issued", null], ["claim_refused", "code_invalid"], ["claim_refused", "code_invalid"], ["paired", null], ["claim_refused", "code_invalid"]]);
	const listed = store.list();
	assert.ok(listed.ok);
	assert.equal(listed.events.length, 1);
	assert.equal(JSON.stringify(audit()).includes("leak"), false, "raw input never reaches the audit");
});

test("an audit failure returns no cookie and no active device; recovery audits and activates once, never reviving the code", (t) => {
	const { make, audit, dataDir, stateDir } = scratch(t);
	const broken = make({ audit: (line) => (line.event === "paired" ? { ok: false, error: "ENOSPC" } : appendControlAudit(stateDir, line)) });
	const issued = broken.issueCode({ ...BIND, route: "cli-pair" });
	assert.ok(issued.ok);
	assert.deepEqual(broken.claim({ ...BIND, code: issued.code, name: "Phone" }), { ok: false, reason: "audit_failed" });
	const read = readDeviceState(dataDir);
	assert.ok(read.state === "ok");
	assert.equal(read.store.devices[0]?.state, "pending");
	assert.equal(read.store.codes.length, 0, "the code is consumed");
	const healthy = make();
	assert.deepEqual((healthy.list() as { events: unknown[] }).events, [], "a pending event is not a committed notice");
	assert.equal(healthy.claim({ ...BIND, code: issued.code, name: "Phone" }).ok, false, "the code is not revived");
	const recovered = healthy.recover();
	assert.ok(recovered.ok);
	assert.equal(recovered.recovered.length, 1);
	assert.equal(audit().filter((line) => line.event === "paired").length, 1);
	assert.deepEqual(healthy.recover(), { ok: true, recovered: [] }, "recovery is idempotent");
});

for (const stage of ["pending_written", "audited"] as const) {
	test(`a crash after ${stage} recovers exactly one logical pairing and one paired audit line`, (t) => {
		const { make, audit, dataDir } = scratch(t);
		const crashing = make({ crash: (at) => { if (at === stage) throw new Error("crash"); } });
		const issued = crashing.issueCode({ ...BIND, route: "loopback-dashboard" });
		assert.ok(issued.ok);
		assert.throws(() => crashing.claim({ ...BIND, code: issued.code, name: "Phone" }), /crash/);
		assert.equal(audit().filter((line) => line.event === "paired").length, stage === "audited" ? 1 : 0);
		const restarted = make();
		const recovered = restarted.recover();
		assert.ok(recovered.ok);
		assert.equal(recovered.recovered.length, 1);
		const lines = audit().filter((line) => line.event === "paired");
		assert.equal(lines.length, 1, "never a second success line");
		const read = readDeviceState(dataDir);
		assert.ok(read.state === "ok");
		assert.equal(read.store.devices.length, 1, "never a second device");
		assert.equal(read.store.devices[0]?.state, "active");
		assert.equal(read.store.events[0]?.id, lines[0]?.pairing_id, "audit and event share the pairing id");
	});
}

test("recovery refuses when the journal cannot be read rather than appending a duplicate success", (t) => {
	const { make, stateDir } = scratch(t);
	const crashing = make({ crash: (at) => { if (at === "audited") throw new Error("crash"); } });
	const issued = crashing.issueCode({ ...BIND, route: "cli-pair" });
	assert.ok(issued.ok);
	assert.throws(() => crashing.claim({ ...BIND, code: issued.code, name: "Phone" }));
	rmSync(controlJournalFile(stateDir));
	mkdirSync(controlJournalFile(stateDir)); // a directory where the journal should be: unreadable
	assert.equal((make().recover() as { reason: string }).reason, "audit_failed");
});

test("the audit scan stays bounded across chunk boundaries", (t) => {
	const { stateDir } = scratch(t);
	mkdirSync(dirname(controlJournalFile(stateDir)), { recursive: true });
	appendFileSync(controlJournalFile(stateDir), `${JSON.stringify({ type: "refused", pad: "x".repeat(1024 * 1024 - 40) })}\n`);
	const id = "pair-0123456789abcdef";
	appendFileSync(controlJournalFile(stateDir), `${JSON.stringify({ type: "device", event: "paired", pairing_id: id })}\n`);
	assert.deepEqual([...auditedPairings(stateDir, new Set([id, "pair-ffffffffffffffff"])).found], [id]);
});

test("access: remote devices never mint; View-only never controls; only loopback/tailnet socket peers mint locally", () => {
	const full = remoteAccess({ id: "dev-0000000000000001", name: "F", level: "full", origin: ORIGIN });
	const view = remoteAccess({ id: "dev-0000000000000002", name: "V", level: "view", origin: ORIGIN });
	assert.ok(Object.isFrozen(full));
	for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.101.2.3", "fd7a:115c:a1e0::5"]) {
		assert.equal(mintPeer(peer), true, peer);
		assert.equal(canMint(LOCAL_ACCESS, peer), true, peer);
		assert.equal(canMint(full, peer), false, `remote full via ${peer}`);
		assert.equal(canMint(view, peer), false);
	}
	for (const peer of ["192.168.1.5", "10.0.0.2", "8.8.8.8", "fe80::1%eth0", "::ffff:192.168.1.5", "", undefined]) assert.equal(canMint(LOCAL_ACCESS, peer), false, String(peer));
	assert.equal(canControl(full), true);
	assert.equal(canControl(view), false);
	assert.equal(canControl(LOCAL_ACCESS), true);
	assert.equal(canRead(view, false), true);
	assert.equal(canRead(LOCAL_ACCESS, false), false, "the local flag keeps its meaning");
	assert.equal(canRevoke(full, undefined), true);
	assert.equal(canRevoke(view, "127.0.0.1"), false);
	assert.equal(canRevoke(LOCAL_ACCESS, "192.168.1.5"), false);
});
