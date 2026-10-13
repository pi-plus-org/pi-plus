/**
 * Wrapper for packages/agent/src/agent.ts.
 *
 * Pass-through except the Agent class: the stream function is wrapped to apply
 * the Claude Code effort model per request (env overrides, budgets, ultrathink,
 * see plus/src/reasoning/effort.ts) and the pre-request abort guard (returns a
 * clean "aborted" message instead of letting a mid-run-compaction-aborted
 * request die as a misclassified "error" stub, see
 * plus/src/agent/pre-request-abort.ts).
 */
export * from "../../../agent/src/agent.ts";

import { Agent as UpstreamAgent } from "../../../agent/src/agent.ts";
import { wrapStreamFn } from "../reasoning/effort.ts";
import { withPreRequestAbortGuard } from "./pre-request-abort.ts";

export class Agent extends UpstreamAgent {
	constructor(options: ConstructorParameters<typeof UpstreamAgent>[0]) {
		super(options);
		this.streamFunction = wrapStreamFn(this.streamFunction, () => this.state.thinkingLevel);
		this.streamFunction = withPreRequestAbortGuard(this.streamFunction);
	}
}
