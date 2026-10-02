/** cp-5smb: the dashboard bind-address policy and discovery (src/viewer/bind-host.ts). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindHostRefusal, localAddresses, parseTailscaleIp, sameAddress, tailscaleIp, viewerHostCandidates } from "../src/viewer/bind-host.ts";

test("bindHostRefusal: overlay, private, ULA and loopback pass; wildcard, public, link-local, mapped, zoned and non-IP are refused", () => {
	for (const ok of ["100.70.1.2", "10.0.0.5", "172.16.0.1", "192.168.1.5", "127.0.0.1", "::1", "fd7a:115c:a1e0::1"]) assert.equal(bindHostRefusal(ok), undefined, ok);
	const refused: Record<string, RegExp> = {
		"0.0.0.0": /wildcard/, "::": /wildcard/, "0:0:0:0:0:0:0:0": /wildcard/,
		"8.8.8.8": /public/, "2001:4860::8888": /public/, "224.0.0.1": /public or non-unicast/, "255.255.255.255": /non-unicast/,
		"fe80::1": /link-local/, "169.254.1.1": /link-local/, "fe80::1%eth0": /zone id/,
		"::ffff:10.0.0.1": /IPv4-mapped/, "0:0:0:0:0:ffff:a00:1": /IPv4-mapped/,
		localhost: /not an IP/, "": /not an IP/,
	};
	for (const [address, reason] of Object.entries(refused)) assert.match(bindHostRefusal(address) ?? "", reason, address);
});

const info = (address: string) => ({ address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "", internal: false, cidr: null }) as never;

test("candidates: Tailscale (recommended) > private > loopback; a Tailscale address no interface carries is dropped", () => {
	const locals = localAddresses({ lo: [info("127.0.0.1"), info("::1")], enp3s0: [info("192.168.1.5"), info("fe80::1")], tailscale0: [info("100.80.0.1")], cgnat: [info("100.99.0.9")] });
	assert.ok(!locals.some((local) => local.address === "fe80::1"), "link-local drops out");
	const all = viewerHostCandidates(locals, "100.80.0.1");
	assert.deepEqual(all.map((c) => [c.address, c.source, c.recommended]), [
		["100.80.0.1", "tailscale", true], ["192.168.1.5", "private", false], ["100.99.0.9", "private", false], ["127.0.0.1", "loopback", false], ["::1", "loopback", false],
	]);
	assert.match(all.find((c) => c.address === "100.99.0.9")!.why, /shared address space/);
	assert.ok(!viewerHostCandidates(locals, undefined).some((c) => c.recommended), "no Tailscale, nothing recommended");
	const ghost = viewerHostCandidates(locals, "100.64.0.1");
	assert.ok(!ghost.some((c) => c.recommended || c.address === "100.64.0.1"), "tool output only labels an interface address");
	assert.deepEqual(viewerHostCandidates([], "100.80.0.1"), []);
});

test("sameAddress: IPv6 by value, IPv4 by string", () => {
	assert.ok(sameAddress("FD7A:115C:A1E0:0:0:0:0:1", "fd7a:115c:a1e0::1"));
	assert.ok(!sameAddress("fd7a:115c:a1e0::1", "fd7a:115c:a1e0::2"));
	assert.ok(sameAddress("10.0.0.1", "10.0.0.1"));
	assert.ok(!sameAddress("10.0.0.1", "::ffff:10.0.0.1"));
	assert.ok(!sameAddress("x", "x"));
});

test("parseTailscaleIp and tailscaleIp: first line, an acceptable IPv4, else undefined", () => {
	assert.equal(parseTailscaleIp("100.70.1.2\n100.1.1.1\n"), "100.70.1.2");
	for (const garbage of ["", "Tailscale is stopped.\n", "8.8.8.8\n", "fd7a::1\n"]) assert.equal(parseTailscaleIp(garbage), undefined, garbage);
	const calls: string[] = [];
	assert.equal(tailscaleIp((command, args) => (calls.push([command, ...args].join(" ")), "100.80.0.1\n")), "100.80.0.1");
	assert.deepEqual(calls, ["tailscale ip -4"]);
	assert.equal(tailscaleIp(() => { throw new Error("ENOENT"); }), undefined);
});
