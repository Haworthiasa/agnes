import { publicFetch, USER_AGENT } from "./net.ts";
import type { AgentReply, ChatTransport, Photo } from "./types.ts";

/** Telegram's sendPhoto limit for uploads. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Downloads an image for upload. Uploading instead of passing the URL to Telegram works with sites that block
 * hotlinking, and the content type check catches a URL that serves an HTML page instead of a picture.
 */
async function downloadPhoto(url: string, fetchFn: typeof fetch): Promise<Photo> {
	const response = await fetchFn(url, {
		headers: { "user-agent": USER_AGENT, accept: "image/*" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	if (!PHOTO_TYPES.has(mimeType)) throw new Error(`not a photo: ${mimeType || "unknown type"}`);
	if (Number(response.headers.get("content-length") ?? 0) > MAX_PHOTO_BYTES) throw new Error("larger than 10 MB");
	const data = new Uint8Array(await response.arrayBuffer());
	if (data.byteLength > MAX_PHOTO_BYTES) throw new Error("larger than 10 MB");
	return { data, mimeType };
}

/**
 * Sends a reply's parts in order, each photo where the model placed it, so a line that introduces a picture sits
 * right above it. An image that fails is skipped and logged; the rest of the answer still arrives.
 */
export async function deliverReply(
	transport: ChatTransport,
	chatId: number,
	reply: AgentReply,
	fetchFn: typeof fetch = publicFetch,
): Promise<void> {
	if (reply.parts.length === 0) return transport.send(chatId, "(không có phản hồi)");
	// Every download starts at once, so a photo is usually ready when its place in the reply comes up.
	const parts = reply.parts.map((part) =>
		"image" in part ? { ...part, photo: downloadPhoto(part.image.url, fetchFn) } : part,
	);
	for (const part of parts) if ("photo" in part) part.photo.catch(() => {});
	for (const part of parts) {
		if (!("photo" in part)) {
			await transport.send(chatId, part.text);
			continue;
		}
		try {
			await transport.sendPhoto(chatId, await part.photo, part.image.alt || undefined);
		} catch (error) {
			console.warn(`[media] skipped image ${part.image.url}: ${(error as Error).message}`);
		}
	}
}
