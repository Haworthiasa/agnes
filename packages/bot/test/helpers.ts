import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChatTransport, IncomingMessage } from "../src/types.ts";

export interface FauxRuntime {
	faux: FauxProviderRegistration;
	modelRuntime: ModelRuntime;
	dataDir: string;
	cleanup(): void;
}

export async function createFauxRuntime(): Promise<FauxRuntime> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});
	const dataDir = mkdtempSync(join(tmpdir(), "pi-bot-test-"));
	return {
		faux,
		modelRuntime,
		dataDir,
		cleanup: () => {
			faux.unregister();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}

/** In-memory transport: tests push messages in and read what the bot sent. */
export class FakeTransport implements ChatTransport {
	readonly sent: Array<{ chatId: number; text: string }> = [];

	async *receive(): AsyncIterable<IncomingMessage> {}

	async send(chatId: number, text: string): Promise<void> {
		this.sent.push({ chatId, text });
	}

	async typing(): Promise<void> {}
}
