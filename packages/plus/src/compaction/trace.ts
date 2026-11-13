/**
 * Compaction call tracing (pi-plus diagnostics).
 *
 * Production sessions showed a second compact() landing ~10ms after a
 * compaction entry, aborting the freshly-resumed run and failing with
 * "Nothing to compact (session too small)" — but neither the TUI nor the
 * desktop host explains the caller's identity or timing. Set
 * PI_COMPACT_DEBUG=1 (or PI_COMPACT_DEBUG=<file>) and every AgentSession
 * compact() entry, join, and pre-flight short-circuit is appended to
 * ~/.pi/agent/pi-plus-compact-debug.log (or <file>) with the call stack, so
 * the next occurrence names its caller. Tracing is append-only and must never
 * fail compaction, so write errors are swallowed with intent.
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CompactionTraceState {
	/** Where in the compact() override the trace fires: enter | join | block. */
	stage: string;
	customInstructions?: string;
	isStreaming: boolean;
	joinActive: boolean;
	resumePending: boolean;
	/** Present on stage "block": the pre-flight failure that short-circuited. */
	blocker?: string;
}

function traceTarget(): string | undefined {
	const setting = process.env.PI_COMPACT_DEBUG;
	if (!setting) return undefined;
	if (setting === "1" || setting === "true") {
		return join(homedir(), ".pi", "agent", "pi-plus-compact-debug.log");
	}
	return setting;
}

export function traceCompactionCall(state: CompactionTraceState): void {
	const path = traceTarget();
	if (!path) return;
	// Frames 2..8: below this helper, down through compact() and its caller —
	// enough to name the subsystem that requested the compaction.
	const stack = (new Error().stack ?? "")
		.split("\n")
		.slice(2, 8)
		.map((frame) => frame.trim())
		.join(" <- ");
	const line =
		`${new Date().toISOString()} compact ${state.stage}` +
		` streaming=${state.isStreaming ? 1 : 0}` +
		` join=${state.joinActive ? 1 : 0}` +
		` resumePending=${state.resumePending ? 1 : 0}` +
		(state.blocker ? ` blocker="${state.blocker}"` : "") +
		(state.customInstructions ? ` instructions="${state.customInstructions.slice(0, 80)}"` : "") +
		` stack: ${stack}\n`;
	try {
		appendFileSync(path, line);
	} catch {
		// Diagnostics must never break the compaction itself.
	}
}
