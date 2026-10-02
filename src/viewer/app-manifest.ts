/**
 * Home Screen install for the dashboard (Pier 1.1, choice C2): a same-origin web app manifest and its icons.
 * iOS delivers Web Push only to a Home Screen web app, so this is what makes push work on an iPhone.
 * Opening the installed app lands on Awaiting you.
 *
 * The icons are drawn here, not shipped as binaries: the Awaiting-you glyph from `viewer-app/components/
 * icons.tsx` (`M4 4h16v12H8l-4 4z`, bar `M9 10h6`) filled in amber on the shell background, encoded as
 * RGB PNG with `node:zlib`. Both colours are existing palette tokens (`--background`, `--amber` in
 * `viewer-app/styles/tokens.css`); a test pins them there.
 */

import { crc32, deflateSync } from "node:zlib";

export const MANIFEST_PATH = "/manifest.webmanifest";
export const APPLE_TOUCH_ICON_PATH = "/apple-touch-icon.png";
/** `--background` and `--amber`. */
export const APP_COLORS = { background: "#111110", accent: "#f0b35a" } as const;
/** Icon URL → edge in pixels. 180 px is the apple-touch-icon size. */
export const APP_ICONS: Readonly<Record<string, number>> = { "/icon-192.png": 192, "/icon-512.png": 512, [APPLE_TOUCH_ICON_PATH]: 180 };

export const MANIFEST_JSON = JSON.stringify({
	id: "/",
	name: "Command post",
	short_name: "Command post",
	start_url: "/#awaiting",
	scope: "/",
	display: "standalone",
	background_color: APP_COLORS.background,
	theme_color: APP_COLORS.background,
	icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" })),
});

const rgb = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

/** Whether a point of the 24-unit icon grid is inside the filled glyph (bubble minus its bar). */
function inGlyph(u: number, v: number): boolean {
	const bar = u >= 9 && u <= 15 && v >= 9.2 && v <= 10.8;
	const box = u >= 4 && u <= 20 && v >= 4 && v <= 16;
	const tail = u >= 4 && v >= 16 && u + v <= 24;
	return (box || tail) && !bar;
}

function chunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

const cache = new Map<number, Buffer>();

/** A square RGB PNG of the app icon, `size` pixels on each edge. */
export function appIcon(size: number): Buffer {
	const hit = cache.get(size);
	if (hit) return hit;
	const [background, accent] = [rgb(APP_COLORS.background), rgb(APP_COLORS.accent)];
	const rows = Buffer.alloc(size * (1 + size * 3));
	for (let y = 0; y < size; y++) {
		const row = y * (1 + size * 3); // filter byte 0: none
		for (let x = 0; x < size; x++) {
			const colour = inGlyph(((x + 0.5) * 24) / size, ((y + 0.5) * 24) / size) ? accent : background;
			rows.set(colour, row + 1 + x * 3);
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter, no interlace
	const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
	cache.set(size, png);
	return png;
}
