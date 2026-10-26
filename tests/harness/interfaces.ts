/** `--import` preload: `os.networkInterfaces()` answers `CP_TEST_INTERFACES` (`{"eth0":["10.0.0.5"]}`) when it is set. */
import { syncBuiltinESMExports } from "node:module";
import os, { type NetworkInterfaceInfo } from "node:os";

const spec = process.env.CP_TEST_INTERFACES;
if (spec !== undefined) {
	const named = JSON.parse(spec) as Record<string, string[]>;
	const info = (address: string) => ({ address, netmask: "", family: address.includes(":") ? "IPv6" : "IPv4", mac: "", internal: false, cidr: null }) as NetworkInterfaceInfo;
	const scripted = Object.fromEntries(Object.entries(named).map(([name, addresses]) => [name, addresses.map(info)]));
	os.networkInterfaces = () => scripted;
	syncBuiltinESMExports();
}
