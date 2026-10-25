/** Retained (P12c): from tests/viewer-device-store.test.ts, the access peer table. Telling tailnet and LAN socket peers
 * from loopback needs requests from those addresses, which a test host cannot originate; remote-mint and View-only
 * refusals are pinned through cp-view in tests/e2e/remote-devices.test.ts (P12c-store).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { canControl, canMint, canRead, canRevoke, LOCAL_ACCESS, mintPeer, remoteAccess } from "../src/viewer/access.ts";

const ORIGIN = "https://cp.example.test";

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
