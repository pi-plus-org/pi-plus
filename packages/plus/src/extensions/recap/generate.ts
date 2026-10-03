/**
 * One-off recap title generation for the pi-plus-session-recap extension.
 *
 * Mirrors plus/src/compaction/compact.ts's summarization call shape: a
 * single-user-message normalized context handed to upstream
 * completeSummarization, with reasoning suppressed via markNoReasoning (the
 * title is tiny and must not be truncated by thinking tokens). Auth is
 * resolved by the caller from ctx.modelRegistry, and streamFn is injectable,
 * so the helper stays testable without a provider.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { contentText, normalizeContext, type ProviderHeaders, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai/compat";
import {
	completeSummarization,
	getSummarizationFailure,
} from "../../../../coding-agent/src/core/compaction/compaction.ts";
import { markNoReasoning } from "../../reasoning/effort.ts";
import { getRecapPrompt, sanitizeRecapTitle } from "./prompt.ts";

/** Output cap for the title call; generous for an 8-word line, cheap overall. */
const RECAP_MAX_OUTPUT_TOKENS = 128;

/** Abort the title call rather than let it hang the (fire-and-forget) recap. */
const RECAP_TIMEOUT_MS = 30_000;

/** Bound the serialized conversation sent with the prompt (titles need a skim). */
const RECAP_MAX_CONVERSATION_CHARS = 12_000;

export interface RecapGenerationOptions {
	/** Serialized conversation or compaction summary (see index.ts callers). */
	conversationText: string;
	model: Model<any>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
	/** Defaults to a fresh 30s timeout when omitted. */
	signal?: AbortSignal;
	sessionId?: string;
	/** Injectable for tests; defaults to the provider's direct streamSimple. */
	streamFn?: StreamFn;
}

/** Truncate the recap input, keeping head and tail (task intro + latest turns). */
function clampConversationText(text: string): string {
	if (text.length <= RECAP_MAX_CONVERSATION_CHARS) return text;
	const keep = RECAP_MAX_CONVERSATION_CHARS - 40;
	const head = text.slice(0, Math.ceil(keep * 0.7));
	const tail = text.slice(-Math.floor(keep * 0.3));
	return `${head}\n[... middle omitted ...]\n${tail}`;
}

/** Build the standalone recap request context (pattern of compact.ts). */
function buildRecapContext(promptText: string): TranscriptContext {
	return normalizeContext({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	});
}

/**
 * Generate a sanitized recap title, or throw on provider error / empty
 * output. Never returns an empty string.
 */
export async function generateRecapTitle(options: RecapGenerationOptions): Promise<string> {
	const streamOptions = markNoReasoning({
		maxTokens: RECAP_MAX_OUTPUT_TOKENS,
		signal: options.signal ?? AbortSignal.timeout(RECAP_TIMEOUT_MS),
		apiKey: options.apiKey,
		headers: options.headers,
		env: options.env,
		sessionId: options.sessionId,
	} as SimpleStreamOptions);

	const response = await completeSummarization(
		options.model,
		buildRecapContext(getRecapPrompt(clampConversationText(options.conversationText))),
		streamOptions,
		options.streamFn,
	);

	const failure = getSummarizationFailure(response, "Recap");
	if (failure) throw new Error(failure);
	if (response.stopReason === "aborted") throw new Error("Recap generation was aborted");

	const title = sanitizeRecapTitle(contentText(response.content));
	if (!title) throw new Error("Recap generation produced an empty title");
	return title;
}
