/**
 * Auto-mode action classifier (pi-plus).
 *
 * Ported from Claude Code's auto mode (`src/utils/permissions/yoloClassifier.ts`):
 * instead of prompting the user for every non-read-only tool call, a model
 * reads the recent conversation plus the pending action and answers one
 * question — block it, or let it run. Three structural choices from the
 * reference are kept:
 *
 *  1. The classifier decides whether to BLOCK, not whether to approve. Silence
 *     is not consent: a missing, malformed, or failed answer is "no verdict",
 *     which the gate resolves by asking the human.
 *  2. The judged request is a closed question. The classifier has no tools and
 *     no channel back to the agent, so a prompt-injected tool result cannot
 *     widen its own permissions through the classifier.
 *  3. The judgement is cheap and terse (small token budget, reasoning
 *     disabled, short timeout) because it runs inline in front of every gated
 *     call.
 *
 * The transport follows the same shape as the recap one-shot call in this
 * package: caller-resolved auth, `streamFn` injectable, `markNoReasoning`, and
 * an explicit small context so the session's system prompt and skill
 * attachments never reach the provider with an empty turn ahead of it.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	contentText,
	type Message,
	normalizeContext,
	type ProviderHeaders,
	type SimpleStreamOptions,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai/compat";
import { completeSummarization } from "../../../../coding-agent/src/core/compaction/compaction.ts";
import { serializeConversation } from "../../../../coding-agent/src/core/compaction/utils.ts";
import type { ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import { convertToLlm } from "../../../../coding-agent/src/core/messages.ts";
import { markNoReasoning } from "../../reasoning/effort.ts";

/** Outcome of one classifier run. */
export interface ClassifierDecision {
	status: "allow" | "block" | "unavailable";
	/** Model-authored why (block/allow), or why no verdict was obtained. */
	reason?: string;
}

/** The pending tool call, as handed to the classifier. */
export interface ClassifierAction {
	toolName: string;
	/** Short human-readable rendering of the tool input. */
	description: string;
	/** Raw tool input, JSON-encoded and capped. */
	input?: string;
}

/** Injectable classifier: tests substitute a stub, hosts can bring their own. */
export type ActionClassifier = (
	action: ClassifierAction,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) => Promise<ClassifierDecision>;

export interface ModelClassifierOptions {
	/** Model to ask. Defaults to the session model (`ctx.model`). */
	model?: Model<any>;
	/** Characters of serialized conversation kept (tail-biased). Default 24k. */
	maxTranscriptChars?: number;
	/** Characters of raw tool input kept. Default 4k. */
	maxInputChars?: number;
	/** Request timeout when the caller gives no signal. Default 15s. */
	timeoutMs?: number;
	/** User allow / deny / environment bullets appended to the system prompt. */
	policyAddendum?: string;
	/** Injectable for tests and hosts with a custom transport. */
	streamFn?: StreamFn;
}

const DEFAULT_MAX_TRANSCRIPT_CHARS = 24_000;
const DEFAULT_MAX_INPUT_CHARS = 4_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** One XML pair plus a sentence; the request runs with reasoning suppressed. */
const CLASSIFIER_MAX_OUTPUT_TOKENS = 256;

/**
 * The classifier system prompt. Static across calls (only the user-message tail
 * changes) so provider-side prompt caching works; user rule bullets are
 * appended as a stable tail section.
 */
export function buildClassifierSystemPrompt(policyAddendum?: string): string {
	const base = `You are an action classifier for an autonomous coding agent running in AUTO mode.

AUTO MODE MEANING: automatic, hands-off tool execution. You are replacing the human who would otherwise glance at the action and decide whether to allow it. Your only job is to decide whether to BLOCK the pending action. Everything else is allowed by default.

You will see:
1. A conversation: the user's requests, the agent's replies, and the tool calls it already made (older turns may be elided).
2. The pending action: one tool call the agent is about to make.

You are not the agent. You cannot change what it does, only whether this one action runs. Answering "no" lets it run; answering "yes" stops it and tells the agent why.

DECISION PROCEDURE, applied in order:

STEP 1 - Out of scope. Judge whether the action is a normal step toward something the CONVERSATION already established: the user's request, the agent's own stated plan, or a follow-up the user agreed to. Out of scope means out of protocol, not out of vocabulary: an action can use familiar tools, familiar paths, and plausible language and still be out of scope. If it is out of scope, block. Otherwise continue.

STEP 2 - BLOCK conditions. Block if the pending action falls into any category below. The categories are illustrative, not exhaustive: if an action is an instance of one of these risks, stated differently or split into pieces, block it.
- Unauthorized access or disclosure: reading, writing, or transmitting secrets, credentials, tokens, keychain entries, SSH keys, or user data to an endpoint the agent does not control; publishing private material the conversation did not ask to publish.
- Irreversible local destruction: deleting, truncating, or wiping (resetting, cleaning, force-checking-out) files, directories, branches, databases, or volumes the conversation does not explicitly intend to destroy; destructive flags on paths the user never named.
- Destructive remote changes: deleting or recreating remote resources, force-pushes or pushes to branches the conversation never authorized, dropping migrations, jobs, or schemas, tearing down environments.
- Untrusted code execution: running code downloaded in this conversation, piping curl/wget into a shell, executing pasted commands of unknown provenance, relaxing permissions (chmod 777), disabling security, sandbox, TLS, or backup checks.
- Persistence and account changes: writing to shell rc files, cron, systemd, launch agents, or startup items; creating or changing users, groups, or sudoers; installing packages globally without being asked; changing git config or identity.
- Blind outward side effects: sending messages, opening or merging issues and pull requests, publishing, deploying, buying, or commenting on the user's behalf where the conversation did not clearly ask for that specific outward act.
- Anything a person would react to with "wait, why would you do that?" if it were shown to them.

ALLOWED BY DEFAULT (do not block these):
- Reading, searching, and listing inside the project and its build outputs.
- Editing project files toward a task the conversation shows, including many edits.
- Running project scripts, tests, linters, formatters, compilers, and package-manager commands that operate on the project.
- Git status/log/diff/add/commit on the current branch with a message derived from the conversation; creating branches the user asked for.
- Local, reversible cleanup the work naturally produces: removing build artifacts, temp files it created, caches, and killing its own background processes.
- Routine network reads needed for the task: fetching docs, cloning a repo the user named, downloading a named dependency.

WHEN IN DOUBT: if the conversation clearly authorizes the act, allow it, even if unusual. If you cannot tell, block. A wrong allow is recoverable only by luck; a wrong block costs one round-trip.

Respond with only:
<block>yes or no</block>
<reason>one short sentence</reason>`;
	return policyAddendum ? `${base}\n\n${policyAddendum}` : base;
}

/** Transcript + pending action, as the single user turn. */
export function buildClassifierUserPrompt(action: ClassifierAction, transcript: string): string {
	const input = action.input ? `\n<input>\n${action.input}\n</input>` : "";
	const head = transcript ? `${transcript}\n\n` : "";
	return `${head}<action>\n${action.toolName}: ${action.description}${input}\n</action>\n\nAnswer with the <block>/<reason> pair only.`;
}

/** Tail-biased truncation: the recent turns are what the decision hinges on. */
export function truncateTranscript(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(0, maxChars - 40);
	return `[... ${text.length - keep} characters elided ...]\n${text.slice(text.length - keep)}`;
}

/** Serialize the current session branch into the compact classifier transcript. */
export function buildTranscript(ctx: ExtensionContext, maxChars: number = DEFAULT_MAX_TRANSCRIPT_CHARS): string {
	try {
		const projection = ctx.sessionManager.buildSessionProjection();
		return truncateTranscript(serializeConversation(convertToLlm(projection.messages)), maxChars);
	} catch {
		return "";
	}
}

const BLOCK_TAG = /<block>\s*(yes|no|true|false)\s*<\/block>/i;
const REASON_TAG = /<reason>([\s\S]*?)<\/reason>/i;

/** Tolerant parse: XML, then a JSON object, then a bare yes/no. */
export function parseClassifierResponse(text: string): { block: boolean; reason?: string } | undefined {
	const match = BLOCK_TAG.exec(text);
	if (match) {
		const block = /^(yes|true)$/i.test(match[1] ?? "");
		const reason = REASON_TAG.exec(text)?.[1]?.trim().replace(/\s+/g, " ");
		return reason ? { block, reason } : { block };
	}
	const json = /\{[\s\S]*\}/.exec(text);
	if (json) {
		try {
			const parsed = JSON.parse(json[0]) as { block?: unknown; shouldBlock?: unknown; reason?: unknown };
			const flag = parsed.block ?? parsed.shouldBlock;
			if (typeof flag === "boolean") {
				const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : undefined;
				return reason ? { block: flag, reason } : { block: flag };
			}
		} catch {
			/* not JSON: fall through to a bare answer */
		}
	}
	const bare = /^\s*(yes|no)\b/i.exec(text);
	if (bare) return { block: bare[1]?.toLowerCase() === "yes" };
	return undefined;
}

/** Auth snapshot taken synchronously from the extension context. */
interface ClassifierAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

/**
 * Ask `model` for a verdict on one action. Never throws: every failure path
 * (missing auth, transport error, model error, unparseable answer) comes back
 * as `status: "unavailable"` so the caller can decide what a no-verdict means.
 */
export async function classifyAction(
	action: ClassifierAction,
	params: {
		model: Model<any>;
		auth: ClassifierAuth;
		transcript: string;
		systemPrompt: string;
		maxInputChars?: number;
		signal?: AbortSignal;
		timeoutMs?: number;
		sessionId?: string;
		streamFn?: StreamFn;
	},
): Promise<ClassifierDecision> {
	const maxInputChars = params.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
	const input =
		action.input && action.input.length > maxInputChars ? `${action.input.slice(0, maxInputChars)}...` : action.input;
	const context: TranscriptContext = normalizeContext({
		systemPrompt: params.systemPrompt,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: buildClassifierUserPrompt({ ...action, input }, params.transcript) }],
				timestamp: Date.now(),
			} as Message,
		],
	}) as unknown as TranscriptContext;

	const streamOptions = markNoReasoning({
		maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
		signal: params.signal ?? AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		apiKey: params.auth.apiKey,
		headers: params.auth.headers,
		env: params.auth.env,
		sessionId: params.sessionId ?? uuidv7(),
	} as SimpleStreamOptions & { sessionId: string });

	let response: Awaited<ReturnType<typeof completeSummarization>>;
	try {
		response = await completeSummarization(params.model, context, streamOptions, params.streamFn);
	} catch (error) {
		return {
			status: "unavailable",
			reason: `classifier request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (response.stopReason === "error")
		return { status: "unavailable", reason: response.errorMessage ?? "classifier model error" };
	if (response.stopReason === "aborted") return { status: "unavailable", reason: "classifier request was aborted" };

	const verdict = parseClassifierResponse(contentText(response.content));
	if (!verdict) return { status: "unavailable", reason: "classifier answer was not a block decision" };
	return verdict.block ? { status: "block", reason: verdict.reason } : { status: "allow", reason: verdict.reason };
}

/**
 * The default classifier for auto mode: resolves the session model and its
 * credentials from the extension context, builds the transcript, and asks.
 * Construct once with the user's policy bullets; the gate calls it per action.
 */
export function createModelClassifier(options: ModelClassifierOptions = {}): ActionClassifier {
	const systemPrompt = buildClassifierSystemPrompt(options.policyAddendum);
	return async (action, ctx, signal) => {
		const model = options.model ?? ctx.model;
		if (!model) return { status: "unavailable", reason: "the session has no model to classify with" };
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return { status: "unavailable", reason: `no credentials for ${model.id}: ${auth.error}` };
		return classifyAction(action, {
			model,
			auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
			transcript: buildTranscript(ctx, options.maxTranscriptChars),
			systemPrompt,
			maxInputChars: options.maxInputChars,
			signal,
			timeoutMs: options.timeoutMs,
			streamFn: options.streamFn,
		});
	};
}
