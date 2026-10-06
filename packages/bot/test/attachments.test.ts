import { describe, expect, it } from "vitest";
import { readAttachment } from "../src/attachments.ts";
import type { IncomingFile } from "../src/types.ts";

function file(
	name: string,
	mimeType: string,
	content: string | Uint8Array,
	size?: number,
): IncomingFile & { downloads: number } {
	const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
	const result = {
		name,
		mimeType,
		size,
		downloads: 0,
		download: async () => {
			result.downloads++;
			return data;
		},
	};
	return result;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe("readAttachment", () => {
	it("passes a photo, or an image document without a MIME type, as an image part", async () => {
		expect(await readAttachment("Ảnh này là gì?", file("photo.jpg", "image/jpeg", PNG))).toEqual({
			text: "Ảnh này là gì?",
			images: [{ type: "image", data: "iVBORw==", mimeType: "image/jpeg" }],
		});
		expect((await readAttachment("", file("screenshot.png", "", PNG))).images).toEqual([
			{ type: "image", data: "iVBORw==", mimeType: "image/png" },
		]);
	});

	it("inlines a text file ahead of the caption", async () => {
		expect(await readAttachment("Tóm tắt giúp tôi", file("notes.md", "text/markdown", "# Kế hoạch\nA"))).toEqual({
			text: "[Content of notes.md]:\n# Kế hoạch\nA\n\nTóm tắt giúp tôi",
			images: [],
		});
	});

	it("explains a skipped file instead of downloading it", async () => {
		const pdf = file("report.pdf", "application/pdf", "%PDF-1.7 ascii header");
		const big = file("big.csv", "text/csv", "a", 200 * 1024);
		expect((await readAttachment("Tóm tắt", pdf)).text).toBe(
			"[Attachment report.pdf (application/pdf) not read: this bot cannot read this file type]\n\nTóm tắt",
		);
		expect((await readAttachment("", big)).text).toBe("[Attachment big.csv (text/csv) not read: larger than 100 KB]");
		expect(pdf.downloads + big.downloads).toBe(0);
	});

	it("reports a file that is not UTF-8 or fails to download", async () => {
		const failing: IncomingFile = {
			name: "a.txt",
			mimeType: "text/plain",
			download: async () => {
				throw new Error("HTTP 404");
			},
		};
		expect((await readAttachment("", file("b.txt", "text/plain", new Uint8Array([0xff, 0xfe, 0x00])))).text).toBe(
			"[Attachment b.txt (text/plain) not read: not UTF-8 text]",
		);
		expect((await readAttachment("", failing)).text).toBe(
			"[Attachment a.txt (text/plain) not read: download failed: HTTP 404]",
		);
	});
});
