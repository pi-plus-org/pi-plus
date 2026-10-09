/**
 * Auto-fold history thinking and tool calls (pi-plus CLI, interactive TUI).
 *
 * Folding is rolling: it fires whenever the transcript moves past a step.
 * - Mid-run: when the agent starts a new assistant message (`message_start`
 *   with role "assistant" in `handleEvent`), the previous messages of the
 *   same run fold — that thinking already led to the tool calls that
 *   answered it, and those tool results have already been consumed.
 * - On a new prompt: when a user message enters the chat, every previous
 *   turn folds.
 * Folded means thinking blocks collapse to the hidden "Thinking..." label
 * and tool rows collapse back to their standard per-tool preview
 * (`setExpanded(false)`). The live step is excluded by identity (the
 * streaming assistant component and any in-flight `pendingTools`
 * components): at an assistant `message_start` the previous streaming
 * component was already cleared at `message_end` and finished tools were
 * already deleted from `pendingTools`, so everything completed folds while
 * the live step is left to its own state (see the tool-parity rules
 * below). Resume and compaction replays
 * build the chat through the same `addMessageToChat` chokepoint, so
 * "everything before the last user turn folded" falls out of the rebuild
 * order naturally.
 *
 * Thinking folds exactly like tool output — one shared state model:
 * - Both flags are synced after a fold: `toolOutputExpanded` to false and
 *   `hideThinkingBlock` to true. Leaving either stale would make its
 *   toggle key burn one dead press repainting already-collapsed content;
 *   with the syncs, one ctrl+o re-expands everything (folded history
 *   included) until the next fold, and one ctrl+t hides/shows cleanly.
 * - New components inherit the current flags, like upstream does for both
 *   kinds: after a fold, a freshly created tool row starts collapsed and
 *   a freshly created assistant message starts with hidden thinking —
 *   including mid-run: from the fold onward, each new assistant message
 *   begins as "Thinking..." and the rolling fold simply re-labels it into
 *   history at the next step. ctrl+o, ctrl+t or a click reveals it.
 * - ctrl+o (`setToolsExpanded`) is the whole-transcript toggle for both
 *   kinds: the sweep covers every tool row *and* every assistant
 *   component — the streaming one included, mirroring upstream's tool
 *   sweep which has no live-step exclusion. Only the folds themselves
 *   exclude the live step (pending tool rows are never touched by a fold;
 *   the streaming component only folds once it is history).
 *
 * Folded thinking carries a visible hint — the "Thinking..." label gets
 * "(ctrl+o to expand)" appended — and expanding via ctrl+o reverts the
 * label to the plain configured one. The thinking coupling is part of
 * the feature: with `PI_AUTO_FOLD_HISTORY=0`, ctrl+o behaves exactly like
 * upstream (tool output only) and thinking stays on ctrl+t.
 *
 * Disable with `PI_AUTO_FOLD_HISTORY=0` (or `false`). Verbose startup
 * (`options.verbose`) never folds. Clicking a folded thinking block or
 * tool row re-opens just that one until the next fold.
 */

import { keyText } from "../../../../coding-agent/src/modes/interactive/components/keybinding-hints.ts";
import { InteractiveMode } from "../../../../coding-agent/src/modes/interactive/interactive-mode.ts";

const AUTO_FOLD_HISTORY_ENV = "PI_AUTO_FOLD_HISTORY";

/** Enabled unless PI_AUTO_FOLD_HISTORY is "0" or "false". */
export function isAutoFoldHistoryEnabled(): boolean {
	const value = process.env[AUTO_FOLD_HISTORY_ENV];
	if (value === undefined || value === "") return true;
	const normalized = value.toLowerCase();
	return normalized !== "0" && normalized !== "false";
}

interface FoldableChild {
	setExpanded?(expanded: boolean): void;
	setHideThinkingBlock?(hide: boolean): void;
	setHiddenThinkingLabel?(label: string): void;
}

/**
 * The hidden-thinking label plus a shortcut hint, e.g.
 * "Thinking... (ctrl+o to expand)". Falls back to the default binding when
 * the keybinding registry is not populated yet (unit tests).
 */
export function foldedThinkingLabel(baseLabel: string): string {
	const key = keyText("app.tools.expand") || "ctrl+o";
	return `${baseLabel} (${key} to expand)`;
}

/**
 * Collapse every foldable child except the identity-excluded ones, giving
 * hidden thinking blocks the `hiddenThinkingLabel` hint when provided.
 * Returns the number of components touched. No re-render is requested
 * here: every caller path already renders right after adding the message.
 */
export function foldChatHistory(
	children: readonly unknown[],
	excluded?: readonly unknown[],
	hiddenThinkingLabel?: string,
): number {
	let folded = 0;
	for (const child of children) {
		if (excluded?.includes(child)) continue;
		const foldable = child as FoldableChild;
		let touched = false;
		if (typeof foldable.setHideThinkingBlock === "function") {
			foldable.setHideThinkingBlock(true);
			if (hiddenThinkingLabel !== undefined && typeof foldable.setHiddenThinkingLabel === "function") {
				foldable.setHiddenThinkingLabel(hiddenThinkingLabel);
			}
			touched = true;
		}
		if (typeof foldable.setExpanded === "function") {
			foldable.setExpanded(false);
			touched = true;
		}
		if (touched) folded += 1;
	}
	return folded;
}

// Structural view of the InteractiveMode members the patch reads; they are
// TS-private upstream. The original method runs unmodified on the same host.
interface AutoFoldHost {
	chatContainer: { children: readonly unknown[] };
	streamingComponent?: unknown;
	pendingTools: { values(): Iterable<unknown> };
	options?: { verbose?: boolean };
	toolOutputExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	ui?: { requestRender(): void };
}

function excludedLiveSteps(host: AutoFoldHost): unknown[] {
	return [host.streamingComponent, ...host.pendingTools.values()].filter((component) => component !== undefined);
}

/**
 * Run one gated auto-fold pass over the host's chat: env and verbose
 * checks, live-step exclusions, the hint-labeled thinking collapse, and
 * the field syncs (both `toolOutputExpanded` and `hideThinkingBlock`, so
 * the toggle keys never dead-press and new components inherit the folded
 * state, exactly like tool rows inherit the collapsed flag). Shared by
 * both patch points (prompt boundary and rolling mid-run fold).
 */
export function applyAutoFold(host: AutoFoldHost): void {
	if (!isAutoFoldHistoryEnabled() || host.options?.verbose === true) return;
	const folded = foldChatHistory(
		host.chatContainer.children,
		excludedLiveSteps(host),
		foldedThinkingLabel(host.hiddenThinkingLabel),
	);
	if (folded > 0) {
		host.toolOutputExpanded = false;
		host.hideThinkingBlock = true;
	}
}

/**
 * Mirror a ctrl+o toggle onto the thinking, with tool-row parity: the
 * sweep covers every assistant component in the chat — the streaming one
 * included, just like upstream's tool sweep — and syncs the
 * `hideThinkingBlock` field so new components inherit the visible state.
 * Expanding restores the plain label, collapsing re-folds with the hint.
 * Gated like the fold itself — with the feature off, ctrl+o stays
 * tool-output-only like upstream.
 */
function setFoldedThinkingVisible(host: AutoFoldHost, visible: boolean): void {
	if (!isAutoFoldHistoryEnabled() || host.options?.verbose === true) return;
	host.hideThinkingBlock = !visible;
	const label = visible ? host.hiddenThinkingLabel : foldedThinkingLabel(host.hiddenThinkingLabel);
	for (const child of host.chatContainer.children) {
		const foldable = child as FoldableChild;
		if (typeof foldable.setHideThinkingBlock !== "function") continue;
		foldable.setHideThinkingBlock(!visible);
		foldable.setHiddenThinkingLabel?.(label);
	}
}

interface ChatMessageLike {
	role: string;
}

interface AgentEventLike {
	type: string;
	message?: { role?: string };
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	addMessageToChat(this: AutoFoldHost, message: ChatMessageLike, options?: { populateHistory?: boolean }): void;
	handleEvent(this: AutoFoldHost, event: AgentEventLike): Promise<void>;
	setToolsExpanded(this: AutoFoldHost, expanded: boolean): void;
};

const originalAddMessageToChat = interactiveModePrototype.addMessageToChat;

interactiveModePrototype.addMessageToChat = function addMessageToChat(
	this: AutoFoldHost,
	message: ChatMessageLike,
	options?: { populateHistory?: boolean },
): void {
	// Fold before adding the message: anything created at this same
	// boundary (a skill-invocation row, the spacer, the prompt itself)
	// is part of the new turn, not history.
	if (message.role === "user") applyAutoFold(this);
	originalAddMessageToChat.call(this, message, options);
};

const originalHandleEvent = interactiveModePrototype.handleEvent;

interactiveModePrototype.handleEvent = function handleEvent(this: AutoFoldHost, event: AgentEventLike): Promise<void> {
	// Rolling fold: when the agent starts a new assistant message, the
	// previous step's thinking and finished tool rows are history — fold
	// them before the original builds the new streaming component (which
	// is therefore never swept). The original renders right after, so the
	// fold repaints without an extra request.
	if (event.type === "message_start" && event.message?.role === "assistant") applyAutoFold(this);
	return originalHandleEvent.call(this, event);
};

const originalSetToolsExpanded = interactiveModePrototype.setToolsExpanded;

interactiveModePrototype.setToolsExpanded = function setToolsExpanded(this: AutoFoldHost, expanded: boolean): void {
	// The original early-returns (and leaves the flag) when the value is
	// unchanged; only a real toggle should move the folded thinking too.
	const before = this.toolOutputExpanded;
	originalSetToolsExpanded.call(this, expanded);
	if (expanded === before) return;
	setFoldedThinkingVisible(this, expanded);
	this.ui?.requestRender();
};
