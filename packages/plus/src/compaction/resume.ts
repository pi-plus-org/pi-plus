/**
 * Mid-run compaction resume (pi-plus).
 *
 * The context-guard extension fires `ctx.compact()` mid-run when a message
 * crosses the auto-compact threshold or the active-message cap (see
 * src/extensions/context-guard/). `ctx.compact()` reaches
 * `AgentSession.compact()` — the manual path — whose upstream contract is to
 * abort the in-flight run and never continue it. Without a resume step the
 * interrupted task simply stops: `compaction_end` fires, the TUI returns to
 * the idle prompt, and the model is never re-engaged.
 *
 * The AgentSession wrapper (src/coding-agent/core/agent-session.ts) captures
 * `isStreaming` before compacting and fires resumeAfterMidRunCompact()
 * afterwards: a silent custom message (display: false, projected to the model
 * as a user message) with triggerTurn re-engages the model — starting a fresh
 * run when idle, or steering into a run the user already started during
 * compaction instead of racing it.
 */

import type { AgentSession } from "../../../coding-agent/src/core/agent-session.ts";

export const COMPACTION_RESUME_CUSTOM_TYPE = "pi-plus.compaction-resume";

export const COMPACTION_RESUME_MESSAGE =
	"The context was compacted mid-task to free space. The summary above preserves the relevant state — " +
	"continue the task from where you left off without asking the user for confirmation.";

/**
 * Re-engage the model after a compaction that aborted an in-flight run.
 * Fire-and-forget: failures are logged, never thrown, so a failed resume
 * cannot turn an already-successful compaction into an error.
 */
export function resumeAfterMidRunCompact(session: AgentSession): void {
	void (async () => {
		try {
			await session.sendCustomMessage(
				{
					customType: COMPACTION_RESUME_CUSTOM_TYPE,
					content: COMPACTION_RESUME_MESSAGE,
					display: false,
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			console.error("pi-plus: failed to resume after mid-run compaction:", error);
		}
	})();
}
