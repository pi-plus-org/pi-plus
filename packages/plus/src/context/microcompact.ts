/**
 * Time-based micro-compact for pi, ported from openclaude/src/services/compact/
 * microCompact.ts (maybeTimeBasedMicrocompact). When a session is resumed after
 * an idle gap (default 60 min), the server prompt cache is dead anyway, so the
 * next request rewrites the whole prefix — clearing the content of old tool
 * results (keeping the newest few) shrinks what gets rewritten.
 *
 * pi adaptations:
 * - Clearing is a context_edit overlay (durable + replay-safe), CC's exact
 *   "[Old tool result content cleared]" marker.
 * - Error results and image-bearing results are kept: unlike text, neither can
 *   be recovered by re-reading from disk (CC clears both).
 * - pi's tool names (bash/edit/write/read/grep/find/ls/powershell + mcp__*)
 *   replace CC's (Read/Shell/Grep/Glob/WebSearch/WebFetch/Edit/Write).
 *
 * A second trigger — pressure micro-compact — fires mid-session from the
 * context-guard extension's turn_end: once the projected request reaches a
 * fraction (default 60%) of the auto-compact threshold, stale compactable tool
 * results are cleared before relevance pruning and full compaction see them.
 * Selection runs on projected entries so already-cleared results (marker
 * content) are skipped and clearing is idempotent.
 *
 * Env: PI_MICROCOMPACT_IDLE_MINUTES — idle gap that triggers clearing (default
 *      60; values <= 0 disable the feature).
 *      PI_MICROCOMPACT_KEEP_RECENT — tool results preserved verbatim (default 5),
 *      shared by the idle and pressure triggers.
 *      PI_MICROCOMPACT_PRESSURE_PCT — pressure trigger as a percent of the
 *      auto-compact threshold (default 60; <= 0 or invalid disables).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ProjectedSessionEntry,
	SessionEntry,
	SessionManager,
} from "../../../coding-agent/src/core/session-manager.ts";

export const TIME_BASED_MC_CLEARED_MESSAGE = "[Old tool result content cleared]";

/** pi's read-only/output tools whose results are safe to clear (CC's COMPACTABLE_TOOLS). */
export const MICROCOMPACTABLE_TOOLS = new Set(["bash", "edit", "write", "read", "grep", "find", "ls", "powershell"]);

const MCP_TOOL_PREFIX = "mcp__";
const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_PRESSURE_PCT = 60;

export function isMicroCompactableTool(name: string): boolean {
	return MICROCOMPACTABLE_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX);
}

function parsePositiveInt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/** Idle gap in ms before clearing fires; <= 0 disables (returns Infinity). */
export function getMicroCompactIdleMs(): number {
	const minutes = parsePositiveInt(process.env.PI_MICROCOMPACT_IDLE_MINUTES) ?? DEFAULT_IDLE_MINUTES;
	return minutes * 60 * 1000;
}

export function getMicroCompactKeepRecent(): number {
	// Floor at 1: CC keeps at least the last result — clearing everything would
	// leave the model with zero working context.
	return Math.max(1, parsePositiveInt(process.env.PI_MICROCOMPACT_KEEP_RECENT) ?? DEFAULT_KEEP_RECENT);
}

/** Pressure trigger as a percent of the auto-compact threshold; 0 disables. */
export function getMicroCompactPressurePct(): number {
	const raw = process.env.PI_MICROCOMPACT_PRESSURE_PCT;
	if (raw === undefined || raw === "") return DEFAULT_PRESSURE_PCT;
	const parsed = Number.parseInt(raw, 10);
	// Garbage and non-positive disable: an unparseable knob must not silently
	// enable mid-session context rewriting.
	if (Number.isNaN(parsed) || parsed <= 0) return 0;
	return Math.min(parsed, 100);
}

/** True when the projected content is exactly the idle/pressure clearing marker. */
function isClearedToolResult(message: AgentMessage): boolean {
	if (message.role !== "toolResult") return false;
	const content = message.content;
	return content.length === 1 && content[0].type === "text" && content[0].text === TIME_BASED_MC_CLEARED_MESSAGE;
}

/**
 * Select source-entry ids of stale compactable tool results under token
 * pressure, mirroring the idle path's protections (error/image results kept,
 * newest keepRecent preserved) but reading projected entries so results
 * already cleared by a previous overlay are skipped — the operation is
 * idempotent across turns.
 */
export function selectToolResultsToClearUnderPressure(
	entries: readonly ProjectedSessionEntry[],
	keepRecent: number,
): string[] {
	const compactable: { id: string; timestamp: number }[] = [];
	for (const entry of entries) {
		if (entry.sourceEntry.type !== "message") continue;
		const message = entry.messages.find((m) => m.role === "toolResult" && isMicroCompactableTool(m.toolName));
		if (!message || message.role !== "toolResult") continue;
		if (message.isError) continue;
		if (message.content.some((block) => block.type === "image")) continue;
		if (isClearedToolResult(message)) continue;
		compactable.push({ id: entry.sourceEntry.id, timestamp: message.timestamp });
	}

	const keepIds = new Set(compactable.slice(-Math.max(1, keepRecent)).map((c) => c.id));
	return compactable.filter((c) => !keepIds.has(c.id)).map((c) => c.id);
}

export interface MicroCompactSelection {
	clearEntryIds: string[];
	keptRecent: number;
	gapMinutes: number;
}

/**
 * Select tool-result entries to clear after an idle gap, mirroring CC's
 * evaluateTimeBasedTrigger + collectCompactableToolIds: the trigger is the gap
 * since the newest assistant message (the cache died while the user was away),
 * and only compactable-tool results outside the newest keepRecent are cleared.
 * Returns undefined when the trigger does not fire or there is nothing to clear.
 */
export function selectToolResultsToClear(
	entries: readonly SessionEntry[],
	nowMs: number,
	idleMs: number,
	keepRecent: number,
): MicroCompactSelection | undefined {
	if (idleMs <= 0) return undefined;

	let lastAssistantMs = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			lastAssistantMs = Math.max(lastAssistantMs, entry.message.timestamp);
		}
	}
	if (lastAssistantMs === 0) return undefined;

	const gapMs = nowMs - lastAssistantMs;
	if (gapMs < idleMs) return undefined;

	const compactable: { id: string; timestamp: number }[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message;
		if (!isMicroCompactableTool(message.toolName)) continue;
		if (message.isError) continue;
		if (message.content.some((block) => block.type === "image")) continue;
		compactable.push({ id: entry.id, timestamp: message.timestamp });
	}

	const keepIds = new Set(compactable.slice(-Math.max(1, keepRecent)).map((c) => c.id));
	const clearEntryIds = compactable.filter((c) => !keepIds.has(c.id)).map((c) => c.id);
	if (clearEntryIds.length === 0) return undefined;

	return { clearEntryIds, keptRecent: keepIds.size, gapMinutes: Math.round(gapMs / 60_000) };
}

/**
 * Apply time-based micro-compact to a session: when the transcript's last
 * assistant message is older than the idle gap, clear the content of old
 * compactable tool results via context_edit overlays. Called from the plus
 * AgentSession subclass constructor so it runs exactly once per (re)opened
 * session, before the first request rebuilds the dead cache prefix.
 * Returns the number of cleared results (0 when the trigger does not fire).
 */
export function applyIdleMicroCompact(sessionManager: SessionManager, nowMs = Date.now()): number {
	const selection = selectToolResultsToClear(
		sessionManager.getBranch(),
		nowMs,
		getMicroCompactIdleMs(),
		getMicroCompactKeepRecent(),
	);
	if (!selection) return 0;
	for (const entryId of selection.clearEntryIds) {
		sessionManager.appendContextEdit(entryId, { content: [{ type: "text", text: TIME_BASED_MC_CLEARED_MESSAGE }] });
	}
	return selection.clearEntryIds.length;
}
