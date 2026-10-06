import { extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { IncomingFile } from "./types.ts";

/** Telegram's Bot API serves bots files up to this size. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Larger text files would crowd out the conversation. */
const MAX_INLINE_TEXT_BYTES = 100 * 1024;
/** For files sent without a MIME type. pi resizes images and converts other formats to PNG. */
const IMAGE_EXTENSIONS: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
// Decided by name or MIME type, never by trying to decode: PDF and zip files start with readable ASCII.
const TEXT_EXTENSIONS = new Set(
	(
		".txt .md .markdown .csv .tsv .log .json .jsonl .ndjson .xml .yaml .yml .toml .ini .cfg .conf .properties .html .htm " +
		".css .scss .js .mjs .cjs .ts .tsx .jsx .py .sh .bash .zsh .ps1 .bat .c .h .cpp .cc .hpp .cs .java .kt .go .rs .rb " +
		".php .pl .lua .r .swift .scala .sql .graphql .proto .tf .srt .vtt .tex .rst .org"
	).split(" "),
);

/**
 * Turns the file a user sent into what the model reads: an image part, a text file inlined ahead of the message,
 * or a note saying why it was skipped, so the model can tell the user instead of ignoring the file.
 */
export async function readAttachment(
	text: string,
	file: IncomingFile | undefined,
): Promise<{ text: string; images: ImageContent[] }> {
	if (!file) return { text, images: [] };
	const name = file.name.replace(/[^\p{L}\p{N}.\- ]/gu, "_");
	const extension = extname(name).toLowerCase();
	const mimeType = file.mimeType.toLowerCase();
	const imageType = mimeType.startsWith("image/") ? mimeType : IMAGE_EXTENSIONS[extension];
	const withNote = (note: string) => ({ text: [note, text].filter(Boolean).join("\n\n"), images: [] });
	const skip = (reason: string) =>
		withNote(`[Attachment ${name} (${mimeType || "unknown type"}) not read: ${reason}]`);
	if (!imageType && !TEXT_EXTENSIONS.has(extension) && !mimeType.startsWith("text/")) {
		return skip("this bot cannot read this file type");
	}
	const limit = imageType ? MAX_FILE_BYTES : MAX_INLINE_TEXT_BYTES;
	if (file.size !== undefined && file.size > limit) return skip(`larger than ${limit / 1024} KB`);
	let data: Uint8Array;
	try {
		data = await file.download();
	} catch (error) {
		return skip(`download failed: ${(error as Error).message}`);
	}
	if (data.byteLength > limit) return skip(`larger than ${limit / 1024} KB`);
	if (imageType)
		return { text, images: [{ type: "image", data: Buffer.from(data).toString("base64"), mimeType: imageType }] };
	try {
		return withNote(`[Content of ${name}]:\n${new TextDecoder("utf-8", { fatal: true }).decode(data)}`);
	} catch {
		return skip("not UTF-8 text");
	}
}
