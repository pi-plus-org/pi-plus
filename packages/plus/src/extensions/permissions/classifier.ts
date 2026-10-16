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
 * The classifier asks the profile the session runs on, and nothing else. Which
 * model of that profile asks is positional, not configured (see
 * `resolveClassifierChoice`): the profile's second declared model, or its only
 * one when it declares just one. The model object and its credentials are both
 * re-resolved through the session's
 * `ModelRegistry` (see `createModelClassifier`), so a host cannot point this
 * call — which carries the transcript tail and raw tool input — at an endpoint
 * the profile never declared. The request is a bounded one-shot: small token
 * budget, `markNoReasoning`, no cache writes, and an explicit small context so
 * the session's system prompt and skill attachments never reach the provider
 * with an empty turn ahead of it.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText, type Message, normalizeContext, type SimpleStreamOptions, uuidv7 } from "@earendil-works/pi-ai";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai/compat";
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
	/**
	 * Model to ask, overriding the profile's positional pick. Only `(provider, id)`
	 * is read from it: the model must resolve through the session's registry, so a
	 * name the active profile does not offer is refused rather than opening some
	 * other endpoint with the session's transcript.
	 */
	model?: Model<any>;
	/** Characters of serialized conversation kept (tail-biased). Default 24k. */
	maxTranscriptChars?: number;
	/** Characters of raw tool input kept. Default 4k. */
	maxInputChars?: number;
	/** Request timeout when the caller gives no signal. Default 15s. */
	timeoutMs?: number;
	/** User allow / deny / environment bullets appended to the system prompt. */
	policyAddendum?: string;
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

/**
 * One completion request. Production binds this to the session's model registry
 * (profile-composed provider, request-time auth); tests inject a fake. It is an
 * internal seam: hosts steer the classifier through `ActionClassifier`, never
 * through a transport of their own.
 */
type ClassifierCall = (
	model: Model<any>,
	context: TranscriptContext,
	options: SimpleStreamOptions & { sessionId: string },
) => Promise<AssistantMessage>;

/**
 * Ask `model` for a verdict on one action. Never throws: every failure path
 * (missing auth, transport error, model error, unparseable answer) comes back
 * as `status: "unavailable"` so the caller can decide what a no-verdict means.
 */
export async function classifyAction(
	action: ClassifierAction,
	params: {
		model: Model<any>;
		call: ClassifierCall;
		transcript: string;
		systemPrompt: string;
		maxInputChars?: number;
		signal?: AbortSignal;
		timeoutMs?: number;
		sessionId?: string;
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

	// Deliberately no retry wrapper (unlike `completeSummarization`, whose policy would be
	// undefined here anyway): this call sits inline in front of every gated tool call, so a
	// dropped stream should cost the user one prompt, not another stretch of the request timeout.
	const streamOptions = markNoReasoning({
		maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
		signal: params.signal ?? AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		cacheRetention: "none",
		sessionId: params.sessionId ?? uuidv7(),
	} as SimpleStreamOptions & { sessionId: string });

	let response: AssistantMessage;
	try {
		response = await params.call(params.model, context, streamOptions);
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
 * The classifier's model for this session, with a label naming where it came
 * from (used in `unavailable` reasons so a misconfigured profile says which
 * slot is broken).
 *
 * The rule needs no settings key because the profile already carries the
 * information: its model scope (`enabledModels`, written by the hub as the
 * profile's declared model list, default model first when the two agree) is the
 * list of models the profile owns, and a profile with more than one model has a
 * spare one — the
 * second — which is exactly the cheap side-call model this one-shot question
 * wants. A single-model profile has nothing to spare, so its only model asks.
 * With no declared scope at all (plain `pi`, or a profile that lists no
 * models) there is no list to pick from and the session model classifies.
 * The scope is the live session list, so enabling an extra model during a
 * session appends it: a one-model profile gains a dedicated classifier model
 * at the moment it has a second one.
 */
function resolveClassifierChoice(
	options: ModelClassifierOptions,
	ctx: ExtensionContext,
): { model: Model<any>; source: string } | undefined {
	if (options.model) return { model: options.model, source: "the configured classifier model" };
	const scoped = Array.isArray(ctx.scopedModels) ? ctx.scopedModels : [];
	if (scoped.length === 1 && scoped[0]?.model) return { model: scoped[0].model, source: "the profile's only model" };
	if (scoped.length > 1 && scoped[1]?.model) return { model: scoped[1].model, source: "the profile's second model" };
	if (ctx.model) return { model: ctx.model, source: "the session model" };
	return undefined;
}

/**
 * The default classifier for auto mode: picks the classifier model from the
 * profile (`resolveClassifierChoice`), resolves it through the session registry
 * so the request can only use a model and endpoint the current profile
 * declares, builds the transcript, and asks. Construct once with the user's
 * policy bullets; the gate calls it per action.
 *
 * Every rejection here is `status: "unavailable"`, never `"block"`, and never a
 * substitution of some other model: a declared classifier the profile cannot
 * serve is a misconfiguration, and the gate's contract for "no verdict" is to
 * ask the human rather than to silently widen or narrow access.
 */
export function createModelClassifier(options: ModelClassifierOptions = {}): ActionClassifier {
	const systemPrompt = buildClassifierSystemPrompt(options.policyAddendum);
	return async (action, ctx, signal) => {
		const registry = ctx.modelRegistry;
		const choice = resolveClassifierChoice(options, ctx);
		if (!choice) return { status: "unavailable", reason: "the session has no model to classify with" };
		const requested = choice.model;
		// The requested model object is treated as an identity (provider + id) only: transport
		// fields such as baseUrl and headers come from the profile's composed model, not from a
		// caller's copy of it.
		const model = registry.find(requested.provider, requested.id);
		if (!model) {
			return {
				status: "unavailable",
				reason: `classifier model ${requested.provider}/${requested.id} (${choice.source}) is not a model of this profile`,
			};
		}
		if (!registry.hasConfiguredAuth(model)) {
			return { status: "unavailable", reason: `no credentials for ${model.provider}/${model.id} in this profile` };
		}
		// Provider-side prompt-cache affinity. A context without a session (sub-agent, test
		// stub) gets no id here, and `classifyAction` generates a fresh one per call.
		let sessionId: string | undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId() || undefined;
		} catch {
			sessionId = undefined;
		}
		return classifyAction(action, {
			model,
			call: (scopedModel, context, requestOptions) =>
				registry.streamSimple(scopedModel, context, requestOptions).result(),
			transcript: buildTranscript(ctx, options.maxTranscriptChars),
			systemPrompt,
			maxInputChars: options.maxInputChars,
			signal,
			timeoutMs: options.timeoutMs,
			sessionId,
		});
	};
}
