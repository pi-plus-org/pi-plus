/**
 * Wrapper for packages/agent/src/agent.ts.
 *
 * Pass-through except the Agent class: the stream function is wrapped to apply
 * the Claude Code effort model per request (env overrides, budgets, ultrathink,
 * see plus/src/reasoning/effort.ts) and the aborted-run guard (clean
 * "aborted" messages instead of misclassified "error" stubs when a mid-run
 * compaction aborts the run, see plus/src/agent/aborted-run.ts).
 */
export * from "../../../agent/src/agent.ts";

import { Agent as UpstreamAgent } from "../../../agent/src/agent.ts";
import { wrapStreamFn } from "../reasoning/effort.ts";
import { withAbortedRunGuard } from "./aborted-run.ts";

export class Agent extends UpstreamAgent {
	constructor(options: ConstructorParameters<typeof UpstreamAgent>[0]) {
		super(options);
		this.streamFunction = wrapStreamFn(this.streamFunction, () => this.state.thinkingLevel);
		this.streamFunction = withAbortedRunGuard(this.streamFunction);
	}
}
