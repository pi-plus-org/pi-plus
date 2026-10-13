/**
 * Pre-request abort guard for the Agent stream function (pi-plus).
 *
 * Production bug (pi-plus-desktop transcripts 01a12e7e / 01a1330c): the
 * context-guard extension fires `ctx.compact()` from a `message_end` listener,
 * which aborts the active run's controller; the agent loop then still calls
 * the stream function for the next (or first) request of the turn on that
 * already-aborted signal. The request dies inside `lazyStream`'s async setup
 * (auth resolution honors the caller's signal and throws before fetch), and
 * the setup-error path classifies the death as `stopReason: "error"` — so the
 * transcript gained a stub assistant message
 *   { stopReason: "error", errorMessage: "This operation was aborted", durationMs: ~1 }
 * after every mid-run compaction.
 *
 * The guard short-circuits the stream function when the run signal is already
 * aborted at call time: no provider request is attempted and the loop
 * receives a clean, empty `stopReason: "aborted"` message — the same outcome
 * as a graceful mid-stream abort (e.g. the user pressing Esc), not an error.
 *
 * Applied in src/agent/agent.ts to the Agent subclass every pi-plus host
 * (pipi bundle, pi-plus-sdk bundle — via the loader redirect for
 * packages/agent/src/agent.ts — and the plus-api test alias) constructs.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
// Deep import: the pi-ai barrel's types module re-exports this class with
// `export type`, which shadows the value under verbatimModuleSyntax.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

function createPreAbortedMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// No errorMessage: unlike a mid-stream abort, nothing was attempted, so
		// there is nothing to report — upstream renderers show a generic abort
		// notice only when an errorMessage is present.
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

export function withPreRequestAbortGuard(streamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		if (options?.signal?.aborted) {
			const stream = new AssistantMessageEventStream();
			stream.end(createPreAbortedMessage(model));
			return stream;
		}
		return streamFn(model, context, options);
	};
}
