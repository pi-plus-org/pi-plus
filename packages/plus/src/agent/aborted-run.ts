/**
 * Aborted-run guard for the Agent stream function (pi-plus).
 *
 * Production bug (pi-plus-desktop transcripts 01a12e7e / 01a1330c): the
 * context-guard extension fires `ctx.compact()` from a `message_end` listener,
 * which aborts the active run's controller; the agent loop then still calls
 * the stream function for the next (or first) request of the turn. The
 * request dies before fetch — either immediately (signal already aborted) or
 * inside `lazyStream`'s async setup (auth resolution honors the caller's
 * signal and throws; the pi-plus compaction serializer can queue the abort to
 * land here, which is the shape attachment-heavy sessions hit). Upstream's
 * setup-error path (packages/ai lazy.ts, kept pristine) hardcodes
 * `stopReason: "error"`, so the transcript gained a stub assistant message
 *   { stopReason: "error", errorMessage: "This operation was aborted", durationMs: ~1 }
 * after mid-run compactions.
 *
 * This wrapper neutralizes both timings:
 *  1. Call-time check: if the run signal is already aborted, no provider
 *     request is attempted and the loop receives a clean, empty
 *     `stopReason: "aborted"` message (createPreAbortedMessage).
 *  2. Setup-phase reclassification: while forwarding the inner stream, an
 *     error-event stub with empty content, an abort-shaped errorMessage, and
 *     the run signal aborted at arrival is rewritten to `stopReason:
 *     "aborted"` with no errorMessage — the same outcome as a graceful
 *     mid-stream abort (e.g. the user pressing Esc), not an error. Genuine
 *     provider errors (non-empty content, aborting signal untouched, or a
 *     non-abort message) pass through unchanged.
 *
 * Applied in src/agent/agent.ts to the Agent subclass every pi-plus host
 * (pipi bundle, pi-plus-sdk npm bundle — via the loader redirect for
 * packages/agent/src/agent.ts — and the plus-api/plus test aliases)
 * constructs. Regression: packages/plus/test/agent/aborted-runs.test.ts +
 * packages/plus-api/test/midrun-compaction-resume.test.ts.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
// Deep import: the pi-ai barrel's types module re-exports this class with
// `export type`, which shadows the value under verbatimModuleSyntax.
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createPreAbortedMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		// No errorMessage: unlike a mid-stream abort, nothing was attempted, so
		// there is nothing to report — upstream renderers show a generic abort
		// notice only when an errorMessage is present.
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

/** Upstream's lazySetupError shape: empty stub, abort message, caller aborted. */
function isSetupAbortStub(message: AssistantMessage, signal: AbortSignal | undefined): boolean {
	return (
		signal?.aborted === true &&
		message.stopReason === "error" &&
		message.content.length === 0 &&
		typeof message.errorMessage === "string" &&
		/abort/i.test(message.errorMessage)
	);
}

function toAbortedMessage(message: AssistantMessage): AssistantMessage {
	return { ...message, stopReason: "aborted", errorMessage: undefined };
}

/**
 * Forward an inner provider stream, rewriting setup-abort stubs to clean
 * aborted messages. Mirrors lazy.ts's forwardStream (the pi-ai module's own
 * copy of this pattern): complete on the terminal event, else end with the
 * inner result.
 */
function reclassifySetupAborts(
	inner: AssistantMessageEventStream,
	signal: AbortSignal | undefined,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	let final: AssistantMessage | undefined;
	void (async () => {
		for await (const event of inner) {
			if (event.type === "error" && isSetupAbortStub(event.error, signal)) {
				const aborted = toAbortedMessage(event.error);
				final = aborted;
				outer.push({ type: "error", reason: "aborted", error: aborted } satisfies AssistantMessageEvent);
				continue;
			}
			if (event.type === "error") final = event.error;
			else if (event.type === "done") final = event.message;
			outer.push(event);
		}
		outer.end(final ?? (await inner.result()));
	})().catch((error: unknown) => {
		// Never swallow: forwarding a well-behaved EventStream does not throw
		// (its iterator ends, it never rejects), so this is a defect path —
		// end the outer stream and log rather than hang the consumer.
		console.error("pi-plus: aborted-run guard failed to forward stream:", error);
		outer.end(final);
	});
	return outer;
}

export function withAbortedRunGuard(streamFn: StreamFn): StreamFn {
	return (model, context, options) => {
		const signal = options?.signal;
		if (signal?.aborted) {
			const stream = new AssistantMessageEventStream();
			stream.end(createPreAbortedMessage(model));
			return stream;
		}
		const result = streamFn(model, context, options);
		if (result instanceof AssistantMessageEventStream) return reclassifySetupAborts(result, signal);
		// Promise-returning stream functions: reclassify once the stream lands.
		return Promise.resolve(result).then((stream) => reclassifySetupAborts(stream, signal));
	};
}
