/**
 * Steer interrupt-on-submit machinery (pi-plus steering behavior, Claude Code
 * parity). Two pieces:
 *
 * - A registry of cancel-safe tool names. A tool is cancel-safe when aborting
 *   it mid-execution is harmless: it honors the AbortSignal handed to
 *   AgentTool.execute and discards partial work. pi-plus tool factories opt in
 *   with markToolCancelSafe(); upstream core tools never do, so a run holding
 *   an unflagged tool keeps the default behavior (steered messages are
 *   injected at the next inter-turn boundary).
 * - InFlightToolTracker: the toolCallId -> toolName map a session maintains
 *   from tool_execution_start/end and agent_end events. The steer override
 *   aborts the run only when every in-flight tool is cancel-safe (vacuously
 *   true when none are in flight, e.g. while the model is streaming a reply);
 *   the queued message is then delivered as the first message of the fresh
 *   run the settle boundary starts, instead of waiting for the tools.
 */

const cancelSafeTools = new Set<string>();

/** Mark a tool as cancel-safe so a steered message may interrupt it mid-run. */
export function markToolCancelSafe(toolName: string): void {
	cancelSafeTools.add(toolName);
}

/** Whether a tool name was marked cancel-safe. */
export function isToolCancelSafe(toolName: string): boolean {
	return cancelSafeTools.has(toolName);
}

/** Tracks in-flight tool calls (toolCallId -> toolName) from session events. */
export class InFlightToolTracker {
	private inFlight = new Map<string, string>();

	toolStarted(toolCallId: string, toolName: string): void {
		this.inFlight.set(toolCallId, toolName);
	}

	toolEnded(toolCallId: string): void {
		this.inFlight.delete(toolCallId);
	}

	clear(): void {
		this.inFlight.clear();
	}

	/** True when every in-flight tool is cancel-safe; vacuously true when none are in flight. */
	allCancelSafe(): boolean {
		for (const toolName of this.inFlight.values()) {
			if (!isToolCancelSafe(toolName)) return false;
		}
		return true;
	}
}
