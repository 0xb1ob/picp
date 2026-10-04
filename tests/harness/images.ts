/**
 * Synthetic image bytes for the dashboard image-attachment tests (cp-br81): a real, decodable PNG built in
 * memory, plus magic-byte stubs for the other formats. No fixture file, nothing from a camera or a person.
 */
import { crc32, deflateSync } from "node:zlib";

const chunk = (type: string, data: Buffer): Buffer => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
};

/** A `width`×`height` RGB PNG, a diagonal gradient so a resize has something to do. */
export function syntheticPng(width = 2, height = 2): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	const rows = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		const at = y * (width * 3 + 1);
		for (let x = 0; x < width; x++) rows.set([(x * 255) / Math.max(1, width - 1), (y * 255) / Math.max(1, height - 1), 128], at + 1 + x * 3);
	}
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Magic bytes only (not decodable): enough for the sniff. */
export const STUBS = {
	jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]),
	gif: Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"),
	webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8 ")]),
	heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(12)]),
	svg: Buffer.from('\uFEFF  <svg xmlns="http://www.w3.org/2000/svg"/>'),
	text: Buffer.from("just some text"),
};
