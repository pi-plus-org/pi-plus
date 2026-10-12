/**
 * Integration test: a compaction that fires mid-run (the context-guard
 * pattern — ctx.compact() from a message_end/turn_end handler) aborts the
 * in-flight run; the plus AgentSession wrapper must resume the task
 * afterwards by re-engaging the model with a silent continuation message.
 *
 * Built on the upstream suite harness pieces (faux provider, in-memory
 * session/settings/registry) with the *plus* AgentSession wrapper in place of
 * the upstream class — the upstream createHarness cannot be reused because it
 * constructs the upstream AgentSession directly.
 */
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../../coding-agent/src/core/extensions/index.ts";
import { convertToLlm } from "../../../coding-agent/src/core/messages.ts";
import { SessionManager } from "../../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../coding-agent/src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../../coding-agent/src/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../../coding-agent/test/utilities.ts";
import { AgentSession, type AgentSessionEvent } from "../../src/coding-agent/core/agent-session.ts";
import { COMPACTION_RESUME_CUSTOM_TYPE } from "../../src/compaction/resume.ts";

const RESUME_TEXT = "task finished after compaction";

/**
 * A faux response that hangs until the request is aborted (or a safety
 * timeout), then reports an aborted assistant message — mirroring a provider
 * stream interrupted by AgentSession.abort() mid-run.
 */
const hangingUntilAbort: FauxResponseStep = async (_context, options) => {
	await new Promise<void>((resolve) => {
		const signal = options?.signal;
		if (signal?.aborted) {
			resolve();
			return;
		}
		signal?.addEventListener("abort", () => resolve(), { once: true });
		setTimeout(resolve, 15_000);
	});
	return fauxAssistantMessage("partial work", { stopReason: "aborted" });
};

async function createPlusHarness(options: { extension: InlineExtension }) {
	const fauxProvider = registerFauxProvider();
	fauxProvider.setResponses([hangingUntilAbort, fauxAssistantMessage(RESUME_TEXT)]);
	const model = fauxProvider.getModel();

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: fauxProvider.api,
		models: fauxProvider.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			inputLimits: registeredModel.inputLimits,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const agent = new Agent({
		getApiKey: () => "faux-key",
		streamFn: streamSimple,
		initialState: { model, systemPrompt: "", tools: [] },
		convertToLlm,
		transformContext: async (messages: AgentMessage[]) => messages,
	});
	const extensionsResult = await createTestExtensionsResult([options.extension], process.cwd());
	const resourceLoader: ResourceLoader = createTestResourceLoader({ extensionsResult });

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		extensionRunnerRef,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	// Seed enough history that prepareCompaction finds material mid-run.
	const now = Date.now();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "earlier request" }],
		timestamp: now - 1000,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("earlier answer"),
		timestamp: now - 500,
	});
	session.agent.state.messages = sessionManager.buildSessionContext().messages;

	return { session, sessionManager, faux: fauxProvider, events, cleanup: () => fauxProvider.unregister() };
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("mid-run compaction resume (integration)", () => {
	it("resumes the interrupted task after the compaction lands", async () => {
		const { session, sessionManager, faux, events, cleanup } = await createPlusHarness({
			extension: (pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "summary from extension",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		});
		try {
			const promptPromise = session.prompt("do the task");
			await waitFor(() => session.isStreaming && faux.getPendingResponseCount() < 2, "the run to start");
			assert.equal(session.isStreaming, true);

			await session.compact();
			await promptPromise;
			await session.waitForIdle();

			// The compaction completed through the manual path (ctx.compact()).
			const compactionEnd = events.find((event) => event.type === "compaction_end");
			expect(compactionEnd).toBeDefined();
			if (compactionEnd?.type === "compaction_end") {
				expect(compactionEnd.aborted).toBe(false);
				expect(compactionEnd.result?.summary).toBe("summary from extension");
			}

			// The provider answered twice: the original run (hanging, aborted)
			// and the resumed run after compaction.
			expect(faux.state.callCount).toBeGreaterThanOrEqual(2);

			// The silent resume message is in the session, after the compaction entry.
			const entries = sessionManager.getEntries();
			const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
			assert.notEqual(compactionIndex, -1, "compaction entry exists");
			const resumeEntry = entries.find(
				(entry) => entry.type === "custom_message" && entry.customType === COMPACTION_RESUME_CUSTOM_TYPE,
			);
			assert.ok(resumeEntry, "resume custom message entry exists");
			assert.ok(entries.indexOf(resumeEntry) > compactionIndex, "resume entry lands after the compaction entry");

			// The model actually responded after the compaction: the second faux
			// response closed the resumed run.
			const texts = entries.slice(compactionIndex).flatMap((entry) => {
				if (entry.type !== "message" || entry.message.role !== "assistant") return [];
				const content = entry.message.content;
				if (typeof content === "string") return [content];
				if (!Array.isArray(content)) return [];
				return content.filter((part) => part.type === "text").map((part) => part.text);
			});
			expect(texts).toContain(RESUME_TEXT);
		} finally {
			cleanup();
		}
	});
});
