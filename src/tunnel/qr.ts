/**
 * Remote dashboard PR 2: the pairing link as a terminal QR code, drawn by the vendored encoder (`src/qr/`), never an
 * online service. A pairing link carries a secret, so it is written only to the controlling terminal (`/dev/tty`):
 * redirected stdout, a log or a status record never sees it. No controlling terminal is a named refusal, not a
 * fallback to stdout. This keeps the secret out of routine logs; it is no defence against the user's own shell.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { Ecc, QrCode } from "../qr/code.ts";

/** Light modules around the code, as the QR standard asks, so a phone finds its edges on a dark terminal too. */
export const QUIET_ZONE = 4;
const DARK_ON_LIGHT = "\x1b[30;47m";
const RESET = "\x1b[0m";

/** The QR code as terminal lines: two modules per character (half blocks), black on an explicit white background. */
export function terminalQr(text: string): string[] {
	const code = QrCode.encodeText(text, Ecc.LOW);
	const span = code.size + QUIET_ZONE * 2;
	const dark = (x: number, y: number): boolean => code.getModule(x - QUIET_ZONE, y - QUIET_ZONE);
	const lines: string[] = [];
	for (let y = 0; y < span; y += 2) {
		let line = "";
		for (let x = 0; x < span; x += 1) {
			const top = dark(x, y);
			const bottom = y + 1 < span && dark(x, y + 1);
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(`${DARK_ON_LIGHT}${line}${RESET}`);
	}
	return lines;
}

export type TtyOpen = () => number;
export type ShowResult = { ok: true } | { ok: false; reason: string };

/** Write the pairing QR and link to the controlling terminal only. Nothing is written anywhere when it is absent. */
export function showPairingOnTty(link: string, open: TtyOpen = () => openSync("/dev/tty", "w")): ShowResult {
	let fd: number;
	try {
		fd = open();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		return { ok: false, reason: `pairing display refused: no controlling terminal (/dev/tty: ${code}); run this from an interactive terminal` };
	}
	try {
		writeSync(fd, `${[...terminalQr(link), "", `Pairing link (secret, one use, five minutes): ${link}`, ""].join("\n")}\n`);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `pairing display failed on /dev/tty: ${(error as NodeJS.ErrnoException).code ?? "write error"}` };
	} finally {
		closeSync(fd);
	}
}
