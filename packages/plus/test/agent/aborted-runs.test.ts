/**
 * Pre-request abort guard + setup-abort reclassification (pi-plus).
 *
 * Reproduces the residual mid-run-compaction failure observed on hosts that
 * carry the guard fix: with attachment-heavy prompts (spreadsheets, images)
 * the context-guard compaction queues its abort behind the session's
 * compaction serializer, so the abort no longer lands before the loop's next
 * streamFn call (where the call-time guard would catch it) but during
 * lazyStream's async setup (auth resolution `throwIfAborted`). The request
 * never reaches fetch, and upstream's setup-error path (packages/ai
 * lazy.ts, kept pristine) hardcodes stopReason "error" — producing the
 * persisted stub { stopReason: "error", errorMessage: "This operation was
 * aborted" } that the guard alone cannot suppress. The wrapper must also
 * reclassify that setup-phase abort stub into a clean aborted message.
 */

// Deep import (same as the guard module): the pi-ai barrel's types module
// re-exports these names with `export type`, shadowing the values.
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
	TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { withAbortedRunGuard } from "../../src/agent/aborted-run.ts";

const model = {
	id: "test-model",
	api: "openai-completions",
	provider: "test",
} as Model<"openai-completions">;

const context = { messages: [] } as unknown as TranscriptContext;

function successMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* successEvents(): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "done", reason: "stop", message: successMessage() };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("aborted-run guard", () => {
	it("short-circuits a call whose signal is already aborted", async () => {
		let innerCalled = false;
		const guarded = withAbortedRunGuard(() => {
			innerCalled = true;
			throw new Error("inner streamFn must not be called");
		});
		const controller = new AbortController();
		controller.abort();
		const stream = await guarded(model, context, { signal: controller.signal });
		const message = await stream.result();
		expect(innerCalled).toBe(false);
		expect(message.stopReason).toBe("aborted");
		expect(message.content).toEqual([]);
		expect(message.errorMessage).toBeUndefined();
	});

	it("reclassifies a setup-phase abort stub into a clean aborted message", async () => {
		// Upstream shape: lazyStream runs async setup (auth resolution honors the
		// caller's signal and throws before fetch); the mid-run compaction abort
		// lands inside that window, after the call-time guard already passed.
		const upstreamStreamFn = (m: Model<Api>, _ctx: TranscriptContext, options?: { signal?: AbortSignal }) =>
			lazyStream(m, async () => {
				await delay(50); // auth resolution / module load window
				options?.signal?.throwIfAborted(); // packages/ai auth/resolve.ts behavior
				return successEvents();
			});
		const guarded = withAbortedRunGuard(upstreamStreamFn);

		const controller = new AbortController();
		const stream = await guarded(model, context, { signal: controller.signal });
		// The compaction abort lands while setup is still running — too late for
		// the call-time check.
		await delay(10);
		controller.abort();

		const message = await stream.result();
		// Without reclassification this is upstream's misclassified stub:
		expect(message.stopReason, `errorMessage=${message.errorMessage}`).toBe("aborted");
		expect(message.errorMessage ?? "").not.toContain("This operation was aborted");
	});

	it("leaves genuine setup errors untouched", async () => {
		const upstreamStreamFn = (m: Model<Api>) =>
			lazyStream(m, async () => {
				await delay(10);
				throw new Error("boom: bad credentials");
			});
		const guarded = withAbortedRunGuard(upstreamStreamFn);
		const stream = await guarded(model, context, {});
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("boom");
	});
});
