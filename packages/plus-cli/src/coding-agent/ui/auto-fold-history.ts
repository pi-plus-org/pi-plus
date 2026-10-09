/**
 * Auto-fold history thinking and tool calls (pi-plus CLI, interactive TUI).
 *
 * When a new user message enters the chat, every previous turn folds:
 * thinking blocks collapse to the hidden "Thinking..." label and tool rows
 * collapse back to their standard per-tool preview (`setExpanded(false)`).
 * The live turn is excluded by identity (the streaming assistant component
 * and any in-flight `pendingTools` components), so steering mid-run folds
 * the run's completed messages without hiding what is still streaming.
 * Resume and compaction replays build the chat through the same
 * `addMessageToChat` chokepoint, so "everything before the last user turn
 * folded" falls out of the rebuild order naturally.
 *
 * Field handling is deliberately asymmetric:
 * - `toolOutputExpanded` is synced to false after a fold, because every
 *   tool row is visibly collapsed by then — leaving it true would make the
 *   next ctrl+o toggle to "collapse" and burn one dead press repainting
 *   already-collapsed output. With the sync, one ctrl+o re-expands
 *   everything (folded history included) until the next boundary.
 * - `hideThinkingBlock` is left untouched: it is the default for *new*
 *   components, and flipping it would hide the current turn's thinking
 *   too. ctrl+t therefore shows thinking everywhere (including folded
 *   history) and the next boundary refolds.
 *
 * Disable with `PI_AUTO_FOLD_HISTORY=0` (or `false`). Verbose startup
 * (`options.verbose`) never folds. Clicking a folded thinking block or
 * tool row re-opens just that one until the next boundary.
 */

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
}

/**
 * Collapse every foldable child except the identity-excluded ones.
 * Returns the number of components touched. No re-render is requested
 * here: every caller path already renders right after adding the message.
 */
export function foldChatHistory(children: readonly unknown[], excluded?: readonly unknown[]): number {
	let folded = 0;
	for (const child of children) {
		if (excluded?.includes(child)) continue;
		const foldable = child as FoldableChild;
		let touched = false;
		if (typeof foldable.setHideThinkingBlock === "function") {
			foldable.setHideThinkingBlock(true);
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
}

interface ChatMessageLike {
	role: string;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	addMessageToChat(this: AutoFoldHost, message: ChatMessageLike, options?: { populateHistory?: boolean }): void;
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
	if (message.role === "user" && isAutoFoldHistoryEnabled() && this.options?.verbose !== true) {
		const excluded: unknown[] = [this.streamingComponent, ...this.pendingTools.values()].filter(
			(component) => component !== undefined,
		);
		const folded = foldChatHistory(this.chatContainer.children, excluded);
		if (folded > 0) this.toolOutputExpanded = false;
	}
	originalAddMessageToChat.call(this, message, options);
};
