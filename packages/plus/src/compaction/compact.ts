/**
 * Claude Code-style compaction for pi, ported from
 * free-code/src/services/compact/compact.ts and autoCompact.ts.
 *
 * Differences from pi's built-in compaction (documented adaptations):
 * - Single full-conversation summary with the 9-section CC prompt; no cut-point,
 *   no split-turn merge, no incremental update prompt.
 * - Summarization requests never apply the session thinking level: the output cap
 *   is 0.8 × reserveTokens (floored at the 20k summary reservation) and reasoning
 *   tokens count against it, so reasoning could truncate the summary and fail
 *   compaction (marked via reasoning/effort.ts's markNoReasoning so wrapStreamFn
 *   skips effort too).
 * - A summary cut off at the output cap is RECOVERED, not failed: a truncated
 *   response feeds back as an assistant turn and the model continues where it
 *   stopped (up to MAX_SUMMARY_CONTINUATIONS rounds). Long conversations with a
 *   previousSummary merge otherwise fail deterministically once the thorough
 *   9-section output outgrows the cap, and a failed compaction additionally
 *   poisons the auto-compact circuit breaker (aborts excluded).
 * - Prompt-too-long retries drop oldest turn groups (CC truncateHeadForPTLRetry).
 * - Post-compact re-injection of recently read files happens inside the summary
 *   text (pi replaces everything up to firstKeptEntryId; CC uses attachments),
 *   as does re-injection of the active plan file and invoked skills (CC's
 *   createPlanAttachmentIfNeeded / createSkillAttachmentIfNeeded).
 * - The 3-failure circuit breaker lives here because agent-session.ts cannot be edited.
 * - Recompaction analytics (CC's RecompactionInfo) are recorded per session:
 *   persisted in the compaction entry's details and echoed to stderr when
 *   PI_COMPACT_ANALYTICS is set, to diagnose compaction loops.
 */
import { readFileSync } from "node:fs";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { contentText, normalizeContext, uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext, Usage } from "@earendil-works/pi-ai/compat";
import {
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionResult,
	completeSummarization,
} from "../../../coding-agent/src/core/compaction/compaction.ts";
import {
	computeFileLists,
	formatFileOperations,
	serializeConversation,
} from "../../../coding-agent/src/core/compaction/utils.ts";
import { convertToLlm } from "../../../coding-agent/src/core/messages.ts";
import {
	getAutoCompactThreshold,
	getCurrentModel,
	isCompactDisabled,
	MAX_OUTPUT_TOKENS_FOR_SUMMARY,
	recordAutoCompactFailure,
	recordAutoCompactSuccess,
} from "../context/detection.ts";
import { planFilePathFor, readPlan } from "../extensions/plan/plan-file.ts";
import { markNoReasoning } from "../reasoning/effort.ts";
import { formatCompactSummary, getCompactPrompt } from "./prompt.ts";

const MAX_PTL_RETRIES = 3;
const POST_COMPACT_TOKEN_BUDGET = 50_000;
const TOKENS_PER_FILE_CAP = 5_000;
// CC's POST_COMPACT_MAX_FILES_TO_RESTORE (services/compact/compact.ts): at most
// the 5 most-recently-read files are re-injected, newest first.
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
const CHARS_PER_TOKEN = 4;

// Only these text formats are re-injected as excerpts; files with any other
// extension are skipped. Extensionless files (Dockerfile, Makefile, .gitignore)
// pass via the NUL-byte sniff in isTextContent — binaries are full of NUL bytes.
const TEXT_FILE_EXTENSIONS = new Set([
	".bash",
	".bat",
	".c",
	".cc",
	".cfg",
	".cjs",
	".cmd",
	".conf",
	".config",
	".cpp",
	".cs",
	".css",
	".csv",
	".cts",
	".cxx",
	".editorconfig",
	".env",
	".fish",
	".go",
	".h",
	".hh",
	".hpp",
	".htm",
	".html",
	".ini",
	".java",
	".js",
	".json",
	".jsonc",
	".jsonl",
	".jsx",
	".kt",
	".kts",
	".less",
	".lock",
	".log",
	".m",
	".markdown",
	".md",
	".mjs",
	".mm",
	".mts",
	".ndjson",
	".ps1",
	".py",
	".pyi",
	".rb",
	".rs",
	".sass",
	".scss",
	".sh",
	".sql",
	".svelte",
	".svg",
	".swift",
	".toml",
	".ts",
	".tsv",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
	".zsh",
]);

/** Bytes inspected for the NUL-byte heuristic before deciding a file is text. */
const BINARY_SNIFF_LENGTH = 8192;

/**
 * True when a read file is safe to re-inject as a text excerpt: whitelisted text
 * extension, or no extension at all (Dockerfile, Makefile, .gitignore) with no
 * NUL bytes in the head of the file.
 */
function isTextContent(file: string, buffer: Buffer): boolean {
	const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return !buffer.subarray(0, BINARY_SNIFF_LENGTH).includes(0);
	return TEXT_FILE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

// CC createPlanAttachmentIfNeeded / createSkillAttachmentIfNeeded budgets.
const PLAN_TOKEN_CAP = 5_000;
const SKILL_TOKEN_CAP = 5_000;
const SKILLS_TOTAL_TOKEN_BUDGET = 25_000;
const SKILL_TRUNCATION_MARKER = "[... skill content truncated for compaction ...]";

const OVERFLOW_ERROR_PATTERN =
	/prompt is too long|prompt too long|context (window )?(too long|length)|maximum context|input is too long|reduce the (length|input)/i;

function isPromptTooLongError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return OVERFLOW_ERROR_PATTERN.test(message);
}

/** Stderr diagnostics for PI_COMPACT_DEBUG (pinpoints which compaction stage is running). */
function compactDebug(message: string, data?: Record<string, unknown>): void {
	if (process.env.PI_COMPACT_DEBUG === undefined || process.env.PI_COMPACT_DEBUG === "") return;
	console.error(`[pi-plus/compact] ${message}`, data ? JSON.stringify(data) : "");
}

/** Drop the oldest user+assistant round so the retry prompt fits (CC truncateHeadForPTLRetry). */
function dropOldestTurn(messages: AgentMessage[]): AgentMessage[] {
	const next = [...messages];
	// Drop the leading user message and everything up to and including the first assistant reply.
	while (next.length > 0 && next[0].role !== "assistant") {
		next.shift();
	}
	if (next.length > 0) {
		next.shift();
	}
	return next;
}

/** Extra rounds allowed to finish a summary the output cap cut off. */
const MAX_SUMMARY_CONTINUATIONS = 2;

const SUMMARY_CONTINUATION_INSTRUCTION =
	"Your summary above was cut off by the output token limit. Continue it exactly where it stopped: " +
	"do not repeat anything already written, do not restart the analysis or summary sections, and resume " +
	"mid-sentence if that is where the text ended. Finish all remaining required content and close any " +
	"open tags. Respond with plain text only — no tool calls.";

/** Build the provider context for a standalone summary request. */
function buildSummarizationContext(promptText: string): TranscriptContext {
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
 * Build the continuation context for a truncated summary: the original prompt,
 * the response so far as an assistant turn (text blocks only, so reasoning/tool
 * debris never re-enters the request), and the continue instruction.
 */
function buildSummaryContinuationContext(promptText: string, response: AssistantMessage): TranscriptContext {
	return normalizeContext({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
			{ ...response, content: [{ type: "text", text: contentText(response.content) }] },
			{
				role: "user",
				content: [{ type: "text", text: SUMMARY_CONTINUATION_INSTRUCTION }],
				timestamp: Date.now(),
			},
		],
	});
}

/** Sum the numeric fields of two usage records (continuation rounds accumulate). */
function mergeUsage(base: Usage, extra: Usage): Usage {
	const merged = { ...base } as Record<keyof Usage, unknown>;
	for (const [key, value] of Object.entries(extra) as [keyof Usage, unknown][]) {
		const previous = merged[key];
		if (typeof value === "number" && typeof previous === "number") {
			merged[key] = previous + value;
		} else if (
			value !== null &&
			typeof value === "object" &&
			previous !== null &&
			typeof previous === "object" &&
			!Array.isArray(value) &&
			!Array.isArray(previous)
		) {
			merged[key] = mergeUsage(previous as Usage, value as Usage);
		}
	}
	return merged as Usage;
}

function createSummaryOptions(
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
) {
	// Summaries never reason. The output cap is 0.8 × reserveTokens and reasoning
	// tokens count against it, so the session's thinking level (e.g. "high" on a
	// reasoning model) can exhaust the budget and truncate the summary mid-generation,
	// failing compaction. markNoReasoning additionally stops the session's
	// wrapStreamFn effort wrapper from re-applying the session level to this call.
	return markNoReasoning({ maxTokens, signal, apiKey, headers, env, sessionId } as Parameters<
		typeof completeSummarization
	>[2]);
}

/**
 * CC-style summary of an error-free response check, matching pi's getSummarizationFailure semantics.
 */
function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	if (response.stopReason === "aborted") {
		// An aborted stream may carry partial text; never persist it as the summary.
		// Without this check the partial summary is accepted and the failure only
		// surfaces later, when the compaction-level aborted check discards it.
		return `${label} failed: generation was aborted before the summary completed`;
	}
	return undefined;
}

/**
 * Generate a Claude Code-style conversation summary and return its provider usage.
 * Overrides pi's generateSummaryWithUsage; used by compact() below and exported so the
 * wrapper module can replace the upstream export.
 *
 * `_thinkingLevel` is part of the upstream signature but intentionally ignored:
 * summaries never reason (see createSummaryOptions).
 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	_thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// Floor the cap at the 20k summary reservation (MAX_OUTPUT_TOKENS_FOR_SUMMARY):
	// 0.8 × the 16k default reserve (13.1k) does not fit a thorough 9-section
	// summary once the compacted conversation passes ~90k tokens or carries a
	// previousSummary to merge, and the resulting "length" stop failed compaction
	// deterministically. Still clamped by the model's own output limit.
	const maxTokens = Math.min(
		Math.max(Math.floor(0.8 * reserveTokens), MAX_OUTPUT_TOKENS_FOR_SUMMARY),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}

	const instructions = [
		customInstructions,
		previousSummary
			? "A summary of the earlier conversation is provided in <previous-summary> tags. Merge it into your new summary: preserve all information it contains that is still relevant, and structure the result with the 9 sections described above."
			: undefined,
	].filter((part): part is string => part !== undefined);
	promptText += getCompactPrompt(instructions.join("\n\n"));

	// Trace the streamFn hand-off under PI_COMPACT_DEBUG: if "streamFn:entered" prints
	// without a matching settle line, the hang is inside the provider stream call.
	let tracedStreamFn = streamFn;
	if (streamFn && process.env.PI_COMPACT_DEBUG !== undefined && process.env.PI_COMPACT_DEBUG !== "") {
		const inner = streamFn;
		tracedStreamFn = ((model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
			compactDebug("streamFn:entered", { model: model.id, aborted: options?.signal?.aborted });
			const result = inner(model, context, options);
			Promise.resolve(result).then(
				() => compactDebug("streamFn:settled"),
				(error: unknown) => compactDebug("streamFn:rejected", { error: String(error) }),
			);
			return result;
		}) as StreamFn;
	}

	compactDebug("summary:prompt-built", { chars: promptText.length, maxTokens });
	let context = buildSummarizationContext(promptText);
	let mergedText = "";
	let usage: Usage | undefined;
	// A summary cut off at the output cap is recovered by continuing generation from
	// the partial text, up to MAX_SUMMARY_CONTINUATIONS extra rounds. Pi's #7048
	// invariant is kept: a still-truncated summary is never persisted as complete.
	for (let round = 0; ; round++) {
		const response = await completeSummarization(
			model,
			context,
			createSummaryOptions(maxTokens, apiKey, headers, env, signal, sessionId),
			tracedStreamFn,
			retry,
			callbacks,
		);
		compactDebug("summary:response-received", { stopReason: response.stopReason, round });
		usage = usage ? mergeUsage(usage, response.usage) : response.usage;
		if (response.content.some((block) => block.type === "toolCall")) {
			throw new Error("Summarization attempted to call a tool");
		}
		const text = contentText(response.content);
		mergedText += text;
		const failure = getSummarizationFailure(response, "Summarization");
		if (!failure) break;
		if (
			response.stopReason === "length" &&
			text.trim() !== "" &&
			round < MAX_SUMMARY_CONTINUATIONS &&
			!signal?.aborted
		) {
			context = buildSummaryContinuationContext(promptText, {
				...response,
				content: [{ type: "text", text: mergedText }],
			});
			continue;
		}
		throw new Error(failure);
	}

	return { text: formatCompactSummary(mergedText), usage };
}

/** CC-style generateSummary; overrides the upstream export. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/**
 * Last-read timestamp per file, newest first, from the summarized messages —
 * CC selects re-injection candidates from its readFileState cache by recency
 * (`sort((a, b) => b.timestamp - a.timestamp).slice(0, maxFiles)`), and the
 * transcript is pi's equivalent. Mirrors extractFileOpsFromMessage's traversal:
 * assistant toolCall blocks plus nested calls recorded on script tool results.
 * Files only present in fileOps (read before the last compaction boundary) are
 * excluded: CC's cache is cleared at every compaction, so a file is never
 * re-injected across compactions without having been re-read since.
 */
function collectReadFilesByRecency(messages: readonly AgentMessage[], exclude: ReadonlySet<string>): string[] {
	const lastReadMs = new Map<string, number>();
	const record = (path: string | undefined, timestamp: number): void => {
		if (!path || exclude.has(path)) return;
		const previous = lastReadMs.get(path);
		if (previous === undefined || timestamp > previous) lastReadMs.set(path, timestamp);
	};
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const call of message.nestedCalls?.calls ?? []) {
				if (call.name !== "read") continue;
				const path = call.arguments?.path;
				record(typeof path === "string" ? path : undefined, message.timestamp);
			}
			continue;
		}
		if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("name" in block) || block.name !== "read" || !("arguments" in block)) continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			const path = typeof args?.path === "string" ? args.path : undefined;
			record(path, message.timestamp);
		}
	}
	return [...lastReadMs.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path);
}

/**
 * Re-inject the read files into the summary text, matching CC's post-compact
 * attachments: the newest 5 files (CC's POST_COMPACT_MAX_FILES_TO_RESTORE),
 * ~5k tokens per file, 50k total. Skipped files (binary, unreadable) do not
 * consume a slot. Unlike CC, files already visible in the kept tail may be
 * re-injected: compact() only receives the summarized messages, so it cannot
 * diff against what survived the cut.
 */
function buildRecentFilesSection(candidates: string[]): string {
	if (candidates.length === 0) return "";

	let totalChars = 0;
	let injected = 0;
	const maxTotalChars = POST_COMPACT_TOKEN_BUDGET * CHARS_PER_TOKEN;
	const sections: string[] = [];

	for (const file of candidates) {
		if (injected >= POST_COMPACT_MAX_FILES_TO_RESTORE) break;
		const remaining = maxTotalChars - totalChars;
		const perFileCap = Math.min(TOKENS_PER_FILE_CAP * CHARS_PER_TOKEN, remaining);
		if (perFileCap <= 0) break;
		try {
			const buffer = readFileSync(file);
			if (!isTextContent(file, buffer)) continue;
			const content = buffer.toString("utf8");
			const excerpt = content.length > perFileCap ? `${content.slice(0, perFileCap)}\n… [truncated]` : content;
			totalChars += excerpt.length;
			injected++;
			sections.push(`### \`${file}\`\n\n\`\`\`\n${excerpt}\n\`\`\``);
		} catch {
			// Unreadable file (deleted, permission): skip, matching CC's tolerant restore.
		}
	}

	if (sections.length === 0) return "";
	return `\n\n## Recently Read Files (post-compact context)\n\n${sections.join("\n\n")}`;
}

/**
 * Re-inject the active plan file's content, matching CC's
 * createPlanAttachmentIfNeeded (pi-plus plan mode keeps the plan at
 * <agentDir>/plans/<sessionId>.md). The plan system-prompt section survives
 * compaction, but re-injecting the content saves the model a Read before it
 * can act on the plan. Skipped when there is no plan file or no sessionId.
 */
async function buildPlanSection(sessionId: string | undefined): Promise<string> {
	if (!sessionId) return "";
	let content: string;
	try {
		content = await readPlan(planFilePathFor(sessionId));
	} catch {
		return "";
	}
	if (content.trim() === "") return "";
	const capChars = PLAN_TOKEN_CAP * CHARS_PER_TOKEN;
	const excerpt = content.length > capChars ? `${content.slice(0, capChars)}\n${SKILL_TRUNCATION_MARKER}` : content;
	return `\n\n## Current Plan (post-compact context)\n\n\`\`\`\n${excerpt}\n\`\`\``;
}

// Same shape as pi's parseSkillBlock (agent-session.ts): invocations expand to a
// user message wrapping the SKILL.md body, so the summarized messages carry a
// complete record of which skills were used — no separate tracking needed.
const SKILL_INVOCATION_PATTERN = /<skill name="([^"]+)" location="([^"]+)">/g;

/**
 * Re-inject the content of invoked skills, matching CC's
 * createSkillAttachmentIfNeeded (5k tokens per skill with a truncation marker,
 * 25k total budget, most-recent invocation first). Files are re-read from disk
 * rather than reusing the transcript copy so the model sees current content.
 */
function buildSkillsSection(messages: readonly AgentMessage[]): string {
	const invocations = new Map<string, string>(); // location -> name, most recent last
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = contentText(message.content);
		SKILL_INVOCATION_PATTERN.lastIndex = 0;
		for (
			let match = SKILL_INVOCATION_PATTERN.exec(text);
			match !== null;
			match = SKILL_INVOCATION_PATTERN.exec(text)
		) {
			if (!invocations.has(match[2])) invocations.set(match[2], match[1]);
		}
	}
	if (invocations.size === 0) return "";

	let totalChars = 0;
	const maxTotalChars = SKILLS_TOTAL_TOKEN_BUDGET * CHARS_PER_TOKEN;
	const sections: string[] = [];
	// Most-recent-first, matching CC's invocation ordering.
	for (const [location, name] of [...invocations.entries()].reverse()) {
		const remaining = maxTotalChars - totalChars;
		const perSkillCap = Math.min(SKILL_TOKEN_CAP * CHARS_PER_TOKEN, remaining);
		if (perSkillCap <= 0) break;
		try {
			const content = readFileSync(location, "utf8");
			const excerpt =
				content.length > perSkillCap ? `${content.slice(0, perSkillCap)}\n${SKILL_TRUNCATION_MARKER}` : content;
			totalChars += excerpt.length;
			sections.push(`### ${name} (\`${location}\`)\n\n${excerpt}`);
		} catch {
			// Deleted/unreadable skill file: skip, like CC's tolerant restore.
		}
	}

	if (sections.length === 0) return "";
	return `\n\n## Active Skills (post-compact context)\n\n${sections.join("\n\n")}`;
}

/** CC's RecompactionInfo, recorded per session to diagnose compaction loops. */
export interface RecompactionAnalytics {
	isRecompactionInChain: boolean;
	turnsSincePreviousCompact: number;
	previousTokensBefore: number | undefined;
	willRetriggerNextTurn: boolean;
}

/** Last compaction per session, for cross-compaction comparisons. */
const lastCompactionBySession = new Map<string, { tokensBefore: number }>();

function isEnvTruthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Build recompaction analytics for this compaction and remember it as the
 * session's latest. turnsSincePreviousCompact counts the user messages inside
 * the summarized region (the turns consumed since the last boundary).
 * willRetriggerNextTurn predicts whether the post-compact projection — summary
 * plus the retained tail budget — lands back at/above the auto-compact threshold.
 */
function recordRecompactionAnalytics(
	sessionId: string | undefined,
	messagesToSummarize: readonly AgentMessage[],
	previousSummary: string | undefined,
	tokensBefore: number,
	keepRecentTokens: number,
	summaryText: string,
): RecompactionAnalytics {
	const turnsSincePreviousCompact = messagesToSummarize.filter((message) => message.role === "user").length;
	const estimatedTokensAfter =
		Math.ceil(summaryText.length / CHARS_PER_TOKEN) + Math.min(tokensBefore, keepRecentTokens);
	const threshold = getAutoCompactThreshold(getCurrentModel());
	const analytics: RecompactionAnalytics = {
		isRecompactionInChain: previousSummary !== undefined,
		turnsSincePreviousCompact,
		previousTokensBefore: sessionId ? lastCompactionBySession.get(sessionId)?.tokensBefore : undefined,
		willRetriggerNextTurn: estimatedTokensAfter >= threshold,
	};
	if (sessionId) lastCompactionBySession.set(sessionId, { tokensBefore });
	if (isEnvTruthy(process.env.PI_COMPACT_ANALYTICS)) {
		console.error(
			"[pi-plus/recompact]",
			JSON.stringify({
				sessionId,
				tokensBefore,
				estimatedTokensAfter,
				autoCompactThreshold: threshold,
				...analytics,
			}),
		);
	}
	return analytics;
}

/**
 * Claude Code-style compaction: one full-conversation summary, PTL retry, circuit breaker,
 * file re-injection. Signature-compatible with pi's compact(); overrides the upstream export.
 *
 * firstKeptEntryId stays pi's cut point (the recent tail must survive for session-tree
 * structure); the summary itself always covers the whole conversation since the last
 * compaction boundary.
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult> {
	if (isCompactDisabled()) {
		throw new Error("Compaction is disabled (PI_DISABLE_COMPACT is set)");
	}

	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
	if (allMessages.length === 0) {
		throw new Error("Nothing to compact");
	}

	compactDebug("compact:enter", { tokensBefore, messages: allMessages.length, sessionId });

	let messages = allMessages;
	let result: { text: string; usage: Usage };
	for (let attempt = 0; ; attempt++) {
		try {
			result = await generateSummaryWithUsage(
				messages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId ?? uuidv7(),
			);
			break;
		} catch (error) {
			if (isPromptTooLongError(error) && messages.length > 1 && attempt < MAX_PTL_RETRIES) {
				messages = dropOldestTurn(messages);
				continue;
			}
			// A user-cancelled compaction is intent, not a compaction defect: counting
			// aborts trips the (process-global) auto-compact breaker, which then
			// suppresses automatic compaction for every session in the host.
			const message = error instanceof Error ? error.message : String(error);
			if (!signal?.aborted && !/was aborted/i.test(message)) {
				recordAutoCompactFailure();
			}
			throw error;
		}
	}
	recordAutoCompactSuccess();
	compactDebug("compact:summary-ok", { chars: result.text.length });

	let summary = result.text;

	// Keep pi's file-ops trailer convention (the TUI and details field rely on it)…
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	// …then CC-style post-compact re-injection inside the summary text.
	summary += buildRecentFilesSection(collectReadFilesByRecency(allMessages, new Set(modifiedFiles)));
	summary += await buildPlanSection(sessionId);
	summary += buildSkillsSection(allMessages);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	const recompaction = recordRecompactionAnalytics(
		sessionId,
		messagesToSummarize,
		previousSummary,
		tokensBefore,
		settings.keepRecentTokens,
		summary,
	);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		estimatedTokensAfter:
			Math.ceil(summary.length / CHARS_PER_TOKEN) + Math.min(tokensBefore, settings.keepRecentTokens),
		usage: result.usage,
		details: { readFiles, modifiedFiles, recompaction } as CompactionDetails,
	};
}
