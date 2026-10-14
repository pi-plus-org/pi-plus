/**
 * Regression: a manual compact() issued while a compaction is already in
 * flight must JOIN the running compaction, not queue behind it.
 *
 * Production bug (pi-plus-desktop session 01a138f0, 2026-10-14): the
 * context-guard fired its mid-run threshold compaction (#1, a 70s summary);
 * a second manual compact() — a /compact typed during the compaction, which
 * the TUI executes immediately because the /compact intercept runs before the
 * queue-during-compaction check — serialized behind #1 and started the
 * instant #1 landed. It aborted the freshly-resumed run (the resume custom
 * message never persisted) and then failed with "Compaction failed: Nothing
 * to compact (session too small)", because #1 had just shrunk the session.
 *
 * The plus AgentSession.compact override now hands later callers the
 * in-flight promise (see the override's comment in
 * src/coding-agent/core/agent-session.ts).
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

/** A faux response that hangs until the request is aborted, mirroring the
 *  mid-run production run that was still streaming when #1 fired. */
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

async function createPlusHarness(options: { extension: InlineExtension; responses: FauxResponseStep[] }) {
	const fauxProvider = registerFauxProvider();
	fauxProvider.setResponses(options.responses);
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

	// Seed enough history that prepareCompaction finds material.
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

/**
 * session_before_compact that holds the compaction open (like the production
 * 70s summary) so a second compact() can arrive while #1 is in flight.
 */
const holdExtension =
	(holdMs: number): InlineExtension =>
	(pi) => {
		pi.on("session_before_compact", async (event) => {
			await new Promise((resolve) => setTimeout(resolve, holdMs));
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};

function compactionEnds(events: readonly AgentSessionEvent[]) {
	return events.filter((event) => event.type === "compaction_end");
}

describe("concurrent manual compaction", () => {
	it("joins an in-flight compaction instead of running a second one (idle session)", async () => {
		const { session, events, cleanup } = await createPlusHarness({
			extension: holdExtension(300),
			responses: [fauxAssistantMessage("unused")],
		});
		try {
			const first = session.compact();
			await waitFor(() => events.some((event) => event.type === "compaction_start"), "compaction_start");
			// A second request arrives while the compaction is still summarizing —
			// the /compact-during-compaction shape.
			const second = session.compact("focus instructions from the second caller");

			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(secondResult).toBe(firstResult);

			const starts = events.filter((event) => event.type === "compaction_start");
			expect(starts.length).toBe(1);
			const ends = compactionEnds(events);
			expect(ends.length).toBe(1);
			const end = ends[0];
			if (end?.type === "compaction_end") {
				expect(end.errorMessage).toBeUndefined();
				expect(end.result?.summary).toBe("summary from extension");
			}
		} finally {
			cleanup();
		}
	});

	it("a second compact() during a mid-run compaction must not strand the resumed run", async () => {
		const { session, sessionManager, faux, events, cleanup } = await createPlusHarness({
			extension: holdExtension(300),
			responses: [hangingUntilAbort, fauxAssistantMessage(RESUME_TEXT)],
		});
		try {
			const promptPromise = session.prompt("do the task");
			await waitFor(() => session.isStreaming && faux.getPendingResponseCount() < 2, "the run to start");

			// #1: the context-guard pattern — manual compact() mid-run.
			const first = session.compact();
			await waitFor(() => events.some((event) => event.type === "compaction_start"), "compaction_start #1");
			// #2: a /compact issued while #1 is still summarizing. Pre-fix this
			// serialized behind #1 and, once it landed, aborted the resume run
			// and failed with "Nothing to compact (session too small)".
			const second = session.compact();

			const firstResult = await first;
			expect(await second).toBe(firstResult);

			await promptPromise;
			await session.waitForIdle();

			const ends = compactionEnds(events);
			expect(ends.length).toBe(1);
			const end = ends[0];
			if (end?.type === "compaction_end") {
				expect(end.errorMessage).toBeUndefined();
				expect(end.result?.summary).toBe("summary from extension");
			}

			// The resume custom message survived (pre-fix: never persisted —
			// #2's abort killed the run before the message landed).
			const entries = sessionManager.getEntries();
			const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
			assert.notEqual(compactionIndex, -1, "compaction entry exists");
			const resumeEntry = entries.find(
				(entry) => entry.type === "custom_message" && entry.customType === COMPACTION_RESUME_CUSTOM_TYPE,
			);
			assert.ok(resumeEntry, "resume custom message entry exists");
			assert.ok(entries.indexOf(resumeEntry) > compactionIndex, "resume entry lands after the compaction entry");

			// And the resumed task actually finished, with no abort stub after it.
			const assistantAfter = entries.slice(compactionIndex).filter((entry) => {
				if (entry.type !== "message" || entry.message.role !== "assistant") return false;
				const message = entry.message as { stopReason?: string; content: unknown };
				if (message.stopReason === "aborted") return true;
				const content = message.content;
				return Array.isArray(content) && content.some((part) => part.type === "text" && part.text === RESUME_TEXT);
			});
			expect(
				assistantAfter.filter(
					(entry) => (entry as { message?: { stopReason?: string } }).message?.stopReason === "aborted",
				).length,
			).toBe(0);
			expect(assistantAfter.length).toBeGreaterThan(0);
		} finally {
			cleanup();
		}
	});
});
