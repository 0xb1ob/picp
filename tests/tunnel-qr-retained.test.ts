/**
 * Retained from tests/tunnel-qr.test.ts (P12b): the vendored MIT encoder's upstream-verified vectors, its attribution,
 * and the A3 display port on a real file handle. The terminal QR itself is pinned by e2e P12b-pair.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Ecc, QrCode } from "../src/qr/code.ts";
import { Mode, QrSegment } from "../src/qr/segments.ts";
import { showPairingOnTty, terminalQr } from "../src/tunnel/qr.ts";
import { createScratchHome, REPO_ROOT } from "./harness/index.ts";

const rows = (code: QrCode): string[] => Array.from({ length: code.size }, (_, y) => Array.from({ length: code.size }, (_, x) => (code.getModule(x, y) ? "1" : "0")).join(""));
const digest = (code: QrCode): string => createHash("sha256").update(rows(code).join("\n")).digest("hex");
const LINK = `https://abc-def-ghi-jkl.trycloudflare.com/pair#${"Zm9vYmFy".repeat(5)}abc`;

test("vendored encoder: upstream-equivalent vectors (version, mask, boosted ECC and every module)", () => {
	const hello = QrCode.encodeText("Hello, world!", Ecc.LOW);
	assert.deepEqual([hello.version, hello.mask, hello.errorCorrectionLevel], [1, 2, Ecc.MEDIUM], "ECC is boosted when it costs no version");
	assert.deepEqual(rows(hello), [
		"111111100000101111111",
		"100000100101001000001",
		"101110101011101011101",
		"101110101000001011101",
		"101110101100101011101",
		"100000101111001000001",
		"111111101010101111111",
		"000000001010000000000",
		"101111100111001111100",
		"000110011000110011101",
		"000100101110111001110",
		"011001010011110101100",
		"110111101000101100001",
		"000000001000011111000",
		"111111100110111100110",
		"100000101010110101110",
		"101110101101111010011",
		"101110101010000111000",
		"101110101111101100100",
		"100000100010110011100",
		"111111101101001010010",
	]);
	const vectors: Array<[string, Ecc, number, number, string]> = [
		["https://cp.example.test/pair#k3Jv-9_Qa", Ecc.MEDIUM, 3, 2, "77c3b3a22d6f6332730d75d0402ffe7d504339aa6dfe461c73dea96c4eb0be7c"],
		["314159265358979323846264338327950288419716939937510", Ecc.MEDIUM, 2, 3, "d0129455064596bea021c4e790cba26c102911928209b9da42873b2eadf511a4"],
		[LINK, Ecc.LOW, 5, 7, "5503cda353f626ad4a04d13f4a484b0030a19467f4042ad8c83b253fa7aac2d3"],
	];
	for (const [text, ecl, version, mask, hash] of vectors) {
		const code = QrCode.encodeText(text, ecl);
		assert.deepEqual([code.version, code.mask, digest(code)], [version, mask, hash], text);
	}
	assert.equal(QrSegment.makeSegments("314159")[0]?.mode, Mode.NUMERIC);
	assert.equal(QrSegment.makeSegments("HTTPS://X.TEST/")[0]?.mode, Mode.ALPHANUMERIC);
	assert.equal(QrSegment.makeSegments(LINK)[0]?.mode, Mode.BYTE);
	assert.throws(() => QrCode.encodeText("x".repeat(2954), Ecc.LOW), /Data too long/);
	assert.throws(() => QrCode.encodeSegments([], Ecc.LOW, 1, 40, 8), /Invalid value/);
});

test("vendored encoder: MIT attribution and the cited revision in every file, no namespace or parameter properties, local imports only", () => {
	for (const file of ["src/qr/bits.ts", "src/qr/segments.ts", "src/qr/code.ts"]) {
		const text = readFileSync(join(REPO_ROOT, file), "utf8");
		assert.match(text, /Copyright \(c\) Project Nayuki\. \(MIT License\)/, file);
		assert.match(text, /Permission is hereby granted, free of charge/, file);
		assert.match(text, /QR-Code-generator\/tree\/3c6d0b3cefb4e049dc337e82237c9644399716a8\/typescript-javascript/, file);
		assert.doesNotMatch(text, /^\s*namespace\b|constructor\([^)]*\b(?:public|private|readonly)\s/m, file);
		assert.deepEqual([...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1]).filter((from) => !from?.startsWith("./")), [], file);
	}
	const display = readFileSync(join(REPO_ROOT, "src/tunnel/qr.ts"), "utf8");
	assert.deepEqual([...display.matchAll(/from "([^"]+)"/g)].map((match) => match[1]), ["node:fs", "../qr/code.ts"], "no network, no online QR service");
});

test("A3: the pairing link and QR go to the controlling terminal only; no terminal is a named refusal that writes nothing", (t) => {
	const home = createScratchHome();
	t.after(() => home.cleanup());
	const writes: string[] = [];
	const stdout = process.stdout.write.bind(process.stdout);
	const stderr = process.stderr.write.bind(process.stderr);
	const spy = (chunk: string | Uint8Array): boolean => {
		writes.push(String(chunk));
		return true;
	};
	const tty = join(home.path, "tty");
	let shown: ReturnType<typeof showPairingOnTty>;
	let refused: ReturnType<typeof showPairingOnTty>;
	process.stdout.write = spy as typeof process.stdout.write;
	process.stderr.write = spy as typeof process.stderr.write;
	try {
		shown = showPairingOnTty(LINK, () => openSync(tty, "w", 0o600));
		refused = showPairingOnTty(LINK, () => {
			throw Object.assign(new Error("ENXIO: no such device or address, open '/dev/tty'"), { code: "ENXIO" });
		});
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
	assert.deepEqual(shown, { ok: true });
	const text = readFileSync(tty, "utf8");
	assert.ok(text.startsWith(terminalQr(LINK).join("\n")));
	assert.match(text, new RegExp(`Pairing link \\(secret, one use, five minutes\\): ${LINK.replace(/[.?/]/g, "\\$&")}\\n`));
	assert.deepEqual(refused, { ok: false, reason: "pairing display refused: no controlling terminal (/dev/tty: ENXIO); run this from an interactive terminal" });
	assert.deepEqual(writes, [], "neither stdout nor stderr saw the secret or the QR");

	const failed = showPairingOnTty(LINK, () => openSync(tty, "r")); // a descriptor that refuses the write
	assert.deepEqual(failed, { ok: false, reason: "pairing display failed on /dev/tty: EBADF" }, "reported, never retried elsewhere");
});
