/**
 * Tests for pi-plus-session-recap (plus/src/extensions/recap/): first-prompt
 * and compaction triggers, manual-rename locking, marker persistence, the
 * title sanitizer, and the provider call through an injected streamFn.
 */
import assert from "node:assert/strict";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { generateRecapTitle, type RecapGenerationOptions } from "../../src/extensions/recap/generate.ts";
import { type RecapDeps, registerRecap } from "../../src/extensions/recap/index.ts";
import { sanitizeRecapTitle } from "../../src/extensions/recap/prompt.ts";

const MODEL = { id: "m", provider: "p", contextWindow: 200_000, maxTokens: 8_192 } as Model<never>;

const NOW = 1_700_000_000_000;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: NOW,
	} as unknown as AgentMessage;
}

function recapMarkerEntry(name: string): unknown {
	return { type: "custom", customType: "pi-plus-session-recap", data: { name } };
}

interface CtxOverrides {
	name?: string;
	entries?: unknown[];
	persisted?: boolean;
	messages?: AgentMessage[];
}

function fakeCtx(overrides: CtxOverrides = {}): ExtensionContext {
	return {
		mode: "tui",
		model: MODEL,
		sessionManager: {
			getEntries: () => overrides.entries ?? [],
			getSessionName: () => overrides.name,
			getSessionFile: () => (overrides.persisted === false ? undefined : "/tmp/session.jsonl"),
			getSessionId: () => "session-1",
			buildSessionProjection: () => ({ messages: overrides.messages ?? [] }),
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
	} as unknown as ExtensionContext;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

interface Harness {
	names: string[];
	appended: { customType: string; data?: unknown }[];
	calls: RecapGenerationOptions[];
	fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<void>;
	fireSync: (event: string, payload: unknown, ctx: ExtensionContext) => void;
}

function captureRecap(generateTitle?: (options: RecapGenerationOptions) => Promise<string>): Harness {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const names: string[] = [];
	const appended: { customType: string; data?: unknown }[] = [];
	const calls: RecapGenerationOptions[] = [];
	const deps: RecapDeps = {
		generateTitle:
			generateTitle ??
			((options) => {
				calls.push(options);
				return Promise.resolve(`Title ${calls.length}`);
			}),
	};
	const pi = {
		on: (event: string, handler: never) => handlers.set(event, handler),
		setSessionName: (name: string) => names.push(name),
		appendEntry: (customType: string, data?: unknown) => appended.push({ customType, data }),
	} as unknown as ExtensionAPI;
	registerRecap(pi, deps);
	return {
		names,
		appended,
		calls,
		fireSync(event: string, payload: unknown, ctx: ExtensionContext) {
			handlers.get(event)?.(payload as never, ctx);
		},
		async fire(event, payload, ctx) {
			// The recap runs fire-and-forget through the serializer; settle the
			// microtask chain (auth + title promises) before asserting.
			this.fireSync(event, payload, ctx);
			await flush();
			await flush();
			await flush();
		},
	};
}

describe("recap triggers", () => {
	it("names the session once the first prompt is answered", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({ messages: [userMessage("fix the login redirect bug"), assistantMessage("done")] });
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(h.calls.length, 1);
		assert.match(h.calls[0].conversationText, /\[User\]: fix the login redirect bug/);
		assert.equal(h.calls[0].sessionId, "session-1");
		assert.deepEqual(h.names, ["Title 1"]);
		assert.deepEqual(h.appended, [{ customType: "pi-plus-session-recap", data: { name: "Title 1" } }]);
	});

	it("keeps working when the ctx is torn down right after the handler returns", async () => {
		// Print mode shuts the extension runtime down as soon as the run
		// settles; the runner's ctx throws assertActive() afterwards, so the
		// scheduled recap must run off the synchronous snapshot only.
		const h = captureRecap();
		const base = fakeCtx({ messages: [userMessage("solo"), assistantMessage("reply")] });
		let dead = false;
		const ctx = new Proxy(Object.create(null) as object, {
			get: (_target, prop) => {
				if (dead) throw new Error("extension context torn down");
				return (base as unknown as Record<string | symbol, unknown>)[prop];
			},
		}) as unknown as ExtensionContext;
		h.fireSync("session_start", { type: "session_start", reason: "new" }, ctx);
		h.fireSync("agent_settled", { type: "agent_settled" }, ctx);
		dead = true;
		await flush();
		await flush();
		await flush();
		assert.deepEqual(h.names, ["Title 1"]);
	});

	it("skips when the settled session has more than one user message", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({
			messages: [userMessage("first"), userMessage("second"), assistantMessage("reply")],
		});
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.names, []);
	});

	it("skips unpersisted sessions", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({ persisted: false, messages: [userMessage("solo"), assistantMessage("reply")] });
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(h.calls.length, 0);
	});

	it("refreshes the recap after compaction from the summary", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({
			name: "Old recap",
			entries: [recapMarkerEntry("Old recap")],
			messages: [userMessage("later")],
		});
		await h.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		// A resume with an existing name must not re-run the first-prompt recap.
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(h.calls.length, 0);
		await h.fire(
			"session_compact",
			{ type: "session_compact", compactionEntry: { summary: "Summary: long compaction summary" } },
			ctx,
		);
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0].conversationText, "Summary: long compaction summary");
		assert.deepEqual(h.names, ["Title 1"]);
		assert.deepEqual(h.appended, [{ customType: "pi-plus-session-recap", data: { name: "Title 1" } }]);
	});

	it("ignores the asynchronously delivered event for its own write", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({ messages: [userMessage("solo"), assistantMessage("reply")] });
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		// The extension runner delivers our setSessionName event after the apply
		// block finished; name-match (not the flag) must keep it from locking.
		await h.fire("session_info_changed", { type: "session_info_changed", name: "Title 1" }, ctx);
		await h.fire("session_compact", { type: "session_compact", compactionEntry: { summary: "s" } }, ctx);
		assert.deepEqual(h.names, ["Title 1", "Title 2"]);
	});

	it("does not overwrite a manual rename before compaction", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({ messages: [userMessage("solo"), assistantMessage("reply")] });
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("session_info_changed", { type: "session_info_changed", name: "Human Name" }, ctx);
		await h.fire("session_compact", { type: "session_compact", compactionEntry: { summary: "s" } }, ctx);
		assert.equal(h.calls.length, 0);
		assert.deepEqual(h.names, []);
	});

	it("treats a resumed non-recap name as manual and skips the first-prompt recap", async () => {
		const h = captureRecap();
		const ctx = fakeCtx({ name: "Human Name", messages: [userMessage("solo"), assistantMessage("reply")] });
		await h.fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.equal(h.calls.length, 0);
	});
});

describe("recap failure policy", () => {
	const originalConsoleError = console.error;

	afterEach(() => {
		console.error = originalConsoleError;
	});

	it("logs and swallows generation errors without renaming", async () => {
		const logged: unknown[] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		const h = captureRecap(() => Promise.reject(new Error("provider down")));
		const ctx = fakeCtx({ messages: [userMessage("solo"), assistantMessage("reply")] });
		await h.fire("session_start", { type: "session_start", reason: "new" }, ctx);
		await h.fire("agent_settled", { type: "agent_settled" }, ctx);
		assert.deepEqual(h.names, []);
		assert.equal(logged.length, 1);
		assert.match(String(logged[0]), /session recap failed/);
	});
});

describe("sanitizeRecapTitle", () => {
	it("strips quotes, prefixes, trailing periods, and extra lines", () => {
		assert.equal(sanitizeRecapTitle('"Fix login redirect"\nwith more text'), "Fix login redirect");
		assert.equal(sanitizeRecapTitle("Title: fix the bug."), "fix the bug");
		assert.equal(sanitizeRecapTitle("**Fix the bug**"), "Fix the bug");
		assert.equal(sanitizeRecapTitle("   "), "");
	});

	it("truncates at a word boundary past the 60-char cap", () => {
		const title = sanitizeRecapTitle(
			"Refactor the authentication middleware so sessions expire consistently across services",
		);
		assert.ok(title.length <= 60);
		assert.ok(!title.endsWith(" "));
		assert.equal(title, "Refactor the authentication middleware so sessions expire");
	});
});

describe("generateRecapTitle", () => {
	function fakeStreamFn(message: Partial<AssistantMessage>): StreamFn {
		return (() => ({
			result: () =>
				Promise.resolve({
					role: "assistant",
					content: [{ type: "text", text: "" }],
					stopReason: "stop",
					...message,
				} as unknown as AssistantMessage),
		})) as unknown as StreamFn;
	}

	const base: Omit<RecapGenerationOptions, "conversationText" | "model"> = {};

	it("runs the title through completeSummarization with the prompt", async () => {
		const seen: { text: string }[] = [];
		const streamFn = ((..._args: unknown[]) => {
			const [, context] = _args as [unknown, { messages: { content: { text?: string }[] }[] }];
			seen.push({ text: context.messages[0].content[0].text ?? "" });
			return {
				result: () =>
					Promise.resolve({
						role: "assistant",
						content: [{ type: "text", text: '  "Fix login bug"  ' }],
						stopReason: "stop",
					} as unknown as AssistantMessage),
			};
		}) as unknown as StreamFn;
		const title = await generateRecapTitle({
			...base,
			conversationText: "[User]: fix it",
			model: MODEL,
			streamFn,
		});
		assert.equal(title, "Fix login bug");
		assert.match(seen[0].text, /at most 8 words/);
		assert.match(seen[0].text, /\[User\]: fix it/);
	});

	it("rejects on a provider error response", async () => {
		await assert.rejects(
			generateRecapTitle({
				...base,
				conversationText: "x",
				model: MODEL,
				streamFn: fakeStreamFn({ stopReason: "error", errorMessage: "boom" }),
			}),
			/Recap failed: boom/,
		);
	});

	it("salvages a truncated title from a length-capped response", async () => {
		// A model that rambles past the token cap still yields a usable title:
		// sanitizeRecapTitle keeps the first line and truncates at a word
		// boundary, so a "length" stop must not fail the whole recap.
		const title = await generateRecapTitle({
			...base,
			conversationText: "x",
			model: MODEL,
			streamFn: fakeStreamFn({
				content: [{ type: "text", text: "Fix login redirect bug\nand then also polish the" }],
				stopReason: "length",
			}),
		});
		assert.equal(title, "Fix login redirect bug");
	});

	it("rejects a length-capped response with no usable text", async () => {
		await assert.rejects(
			generateRecapTitle({
				...base,
				conversationText: "x",
				model: MODEL,
				streamFn: fakeStreamFn({ content: [{ type: "text", text: "   " }], stopReason: "length" }),
			}),
			/hit the token cap before producing a usable title/,
		);
	});

	it("clamps a too-long conversation, keeping head and tail", async () => {
		let promptLength = 0;
		const streamFn = ((..._args: unknown[]) => {
			const [, context] = _args as [unknown, { messages: { content: { text?: string }[] }[] }];
			promptLength = (context.messages[0].content[0].text ?? "").length;
			return {
				result: () =>
					Promise.resolve({
						role: "assistant",
						content: [{ type: "text", text: "Title" }],
						stopReason: "stop",
					} as unknown as AssistantMessage),
			};
		}) as unknown as StreamFn;
		await generateRecapTitle({ ...base, conversationText: "a".repeat(50_000), model: MODEL, streamFn });
		assert.ok(promptLength < 13_000);
	});
});
