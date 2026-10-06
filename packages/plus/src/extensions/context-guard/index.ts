/**
 * pi-plus-context-guard: openclaude-inspired context defense layers that pi's
 * extension API can express without touching upstream:
 *
 * - message_end, per-message detection: token usage is refreshed and checked
 *   after every thinking/response (assistant message end), every tool execution
 *   (toolResult end), and every user/custom message end — not only after each
 *   response boundary. The message-count force trigger fires ctx.compact()
 *   mid-run (a run-scoped flag keeps the rest of the batch and the following
 *   turn_end from re-firing it), and an over-threshold message marks the turn
 *   for pruning even if the turn_end estimate later dips below the threshold.
 * - turn_end, message-count force trigger (CC's 'message-count' reason): when the
 *   projected active message count exceeds PI_MAX_ACTIVE_MESSAGES (default 1000),
 *   force compaction regardless of the token threshold. Bypasses
 *   PI_DISABLE_AUTO_COMPACT, matching CC; PI_DISABLE_COMPACT still wins.
 * - turn_end, relevance pruning (CC's pre-compact prune in autoCompact.ts): when
 *   the projected request reaches the auto-compact threshold (or a message
 *   crossed it earlier this run), omit low-relevance old text entries via
 *   context_edit drafts, so the next request — and any compaction it triggers —
 *   works on a smaller projection (see plus/src/context/pruning.ts).
 *   Prune drafts can only be returned from boundary events, so they are still
 *   emitted at turn_end even though detection runs per message.
 * - session_start, resume compact suggestion (CC's resumeCompactPrompt.ts): offer
 *   to compact immediately when a resumed session is already >= 70% of the
 *   auto-compact threshold. TUI-only, like CC's interactive-only prompt.
 *
 * Time-based micro-compact lives separately in the AgentSession subclass
 * constructor (see plus/src/context/microcompact.ts).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import {
	type DetectionModel,
	getAutoCompactThreshold,
	getCurrentModel,
	isAutoCompactBreakerTripped,
	isAutoCompactDisabled,
	isCompactDisabled,
} from "../../context/detection.ts";
import { estimateContextTokensPlus } from "../../context/estimate.ts";
import { getPruneTailTurns, selectPruneTargets } from "../../context/pruning.ts";

const DEFAULT_MAX_ACTIVE_MESSAGES = 1000;
const RESUME_COMPACT_THRESHOLD_FRACTION = 0.7;
const RESUME_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Hard cap on projected active (non-system) messages, CC's
 * DEFAULT_MAX_ACTIVE_MESSAGES_HARD_CAP. Undefined disables the trigger
 * (PI_MAX_ACTIVE_MESSAGES=0 or unparseable).
 */
function getMaxActiveMessagesLimit(): number | undefined {
	const raw = process.env.PI_MAX_ACTIVE_MESSAGES;
	if (raw === undefined || raw === "") return DEFAULT_MAX_ACTIVE_MESSAGES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** True when the session has prior content: explicit resume/fork, or CLI -r/-c
 *  (reported as "startup"; non-empty branch is the sdk.ts heuristic). */
function isResumedSession(reason: string, hasEntries: boolean): boolean {
	return reason === "resume" || reason === "fork" || (reason === "startup" && hasEntries);
}

/** Active (non-system) message count vs. the PI_MAX_ACTIVE_MESSAGES hard cap. */
function isOverActiveMessageLimit(messages: readonly AgentMessage[], limit: number): boolean {
	return messages.filter((message) => message.role !== "system").length > limit;
}

/** Whether the estimated request has reached the CC auto-compact threshold. */
function exceedsAutoCompactThreshold(messages: readonly AgentMessage[], model: DetectionModel): boolean {
	return estimateContextTokensPlus(messages).tokens >= getAutoCompactThreshold(model);
}

export function registerContextGuard(pi: ExtensionAPI): void {
	// Run-scoped detection state, reset when a run starts or settles:
	// - forceCompactionFired: the message-count trigger already called
	//   ctx.compact() mid-run; later messages and the turn_end of the
	//   interrupted run must not request compaction again.
	// - thresholdCrossedMidRun: a message already pushed the estimate to the
	//   auto-compact threshold; turn_end prunes even if its own estimate dips
	//   below (e.g. concurrent context edits), so a per-message crossing is
	//   never lost between boundaries.
	let forceCompactionFired = false;
	let thresholdCrossedMidRun = false;

	const resetRunState = (): void => {
		forceCompactionFired = false;
		thresholdCrossedMidRun = false;
	};

	pi.on("agent_start", () => resetRunState());
	pi.on("agent_settled", () => resetRunState());

	// Detect and refresh token usage after each thinking/response, tool
	// execution, and user/custom message — every message_end, not only the turn
	// boundary. At message_end the just-finished message is not persisted yet
	// (AgentSession appends it after dispatching the event), so it is folded
	// into the projection explicitly.
	pi.on("message_end", (event, ctx) => {
		if (isCompactDisabled()) return;

		const projection = ctx.sessionManager.buildSessionProjection();
		const messages: readonly AgentMessage[] = [...projection.messages, event.message];

		// 1. Message-count force trigger: fire compaction immediately, without
		//    waiting for the rest of the batch or the turn boundary.
		const limit = getMaxActiveMessagesLimit();
		if (!forceCompactionFired && limit !== undefined && isOverActiveMessageLimit(messages, limit)) {
			forceCompactionFired = true;
			ctx.compact();
			return;
		}

		// 2. Threshold detection: pruning needs boundary drafts, so only mark
		//    the crossing here; turn_end emits the context_edit drafts.
		if (isAutoCompactDisabled() || isAutoCompactBreakerTripped() || thresholdCrossedMidRun) return;
		const model = getCurrentModel() ?? ctx.model;
		if (!model) return; // no window math possible; upstream's reserve-based fallback applies
		if (exceedsAutoCompactThreshold(messages, model)) thresholdCrossedMidRun = true;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (isCompactDisabled()) return;

		const projection = ctx.sessionManager.buildSessionProjection();

		// 1. Message-count force trigger (skipped when the per-tool detection
		// already fired it for this run).
		const limit = getMaxActiveMessagesLimit();
		if (!forceCompactionFired && limit !== undefined && isOverActiveMessageLimit(projection.messages, limit)) {
			ctx.compact();
			return;
		}

		// 2. Relevance pruning at the auto-compact threshold (or when a message
		// crossed it earlier this run).
		if (isAutoCompactDisabled() || isAutoCompactBreakerTripped()) return;
		const model = getCurrentModel() ?? ctx.model;
		if (!model) return; // no window math possible; upstream's reserve-based fallback applies
		const threshold = getAutoCompactThreshold(model);
		const { tokens } = estimateContextTokensPlus(projection.messages);
		if (tokens < threshold && !thresholdCrossedMidRun) return;
		thresholdCrossedMidRun = false;
		const targets = selectPruneTargets(projection.entries, tokens, threshold, getPruneTailTurns(), Date.now());
		if (targets.length === 0) return;
		return {
			entries: targets.map((targetId) => ({ type: "context_edit" as const, targetId, replacement: null })),
		};
	});

	pi.on("session_start", async (event, ctx) => {
		if (!isResumedSession(event.reason, ctx.sessionManager.getBranch().length > 0)) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (isAutoCompactDisabled() || isAutoCompactBreakerTripped()) return;
		const model = getCurrentModel() ?? ctx.model;
		if (!model) return;
		const threshold = getAutoCompactThreshold(model);
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens ?? 0;
		if (tokens < threshold * RESUME_COMPACT_THRESHOLD_FRACTION) return;

		const percent = usage?.percent ?? Math.max(0, Math.round((tokens / model.contextWindow) * 100));
		const yes = await ctx.ui.confirm(`Context is ${percent}% full`, "Compact now before continuing?", {
			timeout: RESUME_PROMPT_TIMEOUT_MS,
		});
		if (yes) {
			// compact() synchronously emits compaction_start, but the TUI only
			// renders it once it has subscribed to session events — and that
			// subscription happens after extension binding, i.e. after this
			// handler returns. Defer to the next macrotask (microtasks — the
			// rest of startup, including the subscription — always drain first)
			// so the "Compacting context..." indicator actually shows.
			setTimeout(() => {
				ctx.compact();
			}, 0);
		}
	});
}
