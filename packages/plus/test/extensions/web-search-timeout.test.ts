/**
 * Tests for plus/src/extensions/web-search/timeout.ts — WEB_SEARCH_TIMEOUT_SEC
 * parsing and the AbortSignal.any-based timeout wrapper: timeouts surface as
 * WebSearchTimeoutError while caller cancellation propagates untouched.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	fetchJsonWithWebSearchTimeout,
	getWebSearchTimeoutMs,
	isWebSearchTimeoutError,
	WebSearchTimeoutError,
	withWebSearchTimeout,
} from "../../src/extensions/web-search/timeout.ts";

describe("getWebSearchTimeoutMs", () => {
	it("defaults to 15s when unset or empty", () => {
		assert.equal(getWebSearchTimeoutMs({}), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "" }), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "   " }), 15_000);
	});

	it("falls back for non-numeric, zero, or out-of-range values", () => {
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "soon" }), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "-5" }), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "0" }), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "301" }), 15_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "1e3" }), 15_000);
	});

	it("accepts integers up to the 300s cap, trimming whitespace", () => {
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "20" }), 20_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: " 45 " }), 45_000);
		assert.equal(getWebSearchTimeoutMs({ WEB_SEARCH_TIMEOUT_SEC: "300" }), 300_000);
	});
});

/** Rejects when the given signal aborts — mimics a hung fetch. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
	});
}

describe("withWebSearchTimeout", () => {
	it("returns the operation result when it finishes in time", async () => {
		const value = await withWebSearchTimeout(async () => 42, undefined, { timeoutMs: 5_000 });
		assert.equal(value, 42);
	});

	it("surfaces a slow operation as WebSearchTimeoutError", async () => {
		await assert.rejects(
			withWebSearchTimeout((signal) => hangUntilAborted(signal), undefined, {
				providerName: "Tavily",
				timeoutMs: 10,
			}),
			(err: unknown) => {
				assert.ok(err instanceof WebSearchTimeoutError);
				assert.equal(err.message, "Tavily search timed out after 0.01s");
				assert.ok(isWebSearchTimeoutError(err));
				return true;
			},
		);
	});

	it("propagates a pre-aborted caller signal without running the operation", async () => {
		const controller = new AbortController();
		controller.abort();
		let ran = false;
		await assert.rejects(
			withWebSearchTimeout(
				async () => {
					ran = true;
					return 1;
				},
				controller.signal,
				{ timeoutMs: 5_000 },
			),
			(err: unknown) => (err as Error).name === "AbortError",
		);
		assert.ok(!ran);
	});

	it("caller abort during the operation wins over the timeout", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(
			withWebSearchTimeout((signal) => hangUntilAborted(signal), controller.signal, {
				providerName: "Brave",
				timeoutMs: 5_000,
			}),
			(err: unknown) => {
				assert.equal((err as Error).name, "AbortError");
				assert.ok(!isWebSearchTimeoutError(err));
				return true;
			},
		);
	});

	it("re-throws non-abort operation errors unchanged", async () => {
		await assert.rejects(
			withWebSearchTimeout(
				async () => {
					throw new Error("boom");
				},
				undefined,
				{ timeoutMs: 5_000 },
			),
			/boom/,
		);
	});
});

describe("fetchJsonWithWebSearchTimeout", () => {
	const envSnapshot = { ...process.env };

	beforeEach(() => {
		process.env.WEB_SEARCH_TIMEOUT_SEC = "30";
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.WEB_SEARCH_TIMEOUT_SEC;
		const saved = envSnapshot.WEB_SEARCH_TIMEOUT_SEC;
		if (saved !== undefined) process.env.WEB_SEARCH_TIMEOUT_SEC = saved;
	});

	it("returns the parsed JSON body on success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [1] }) }) as Response),
		);
		const data = await fetchJsonWithWebSearchTimeout(
			"https://api.example.com/search",
			{ method: "POST" },
			undefined,
			{
				providerName: "Tavily",
			},
		);
		assert.deepEqual(data, { results: [1] });
	});

	it("throws a provider-labelled error with the response body on non-OK", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: false,
						status: 429,
						text: async () => "slow down",
					}) as Response,
			),
		);
		await assert.rejects(
			fetchJsonWithWebSearchTimeout("https://api.example.com/search", {}, undefined, { providerName: "Brave" }),
			/Brave search error 429: slow down/,
		);
	});

	it("passes the combined signal to fetch", async () => {
		let sawSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				sawSignal = init?.signal ?? undefined;
				return { ok: true, status: 200, json: async () => ({}) } as Response;
			}),
		);
		const controller = new AbortController();
		await fetchJsonWithWebSearchTimeout("https://api.example.com/search", {}, controller.signal, {
			providerName: "Jina",
		});
		assert.ok(sawSignal);
		assert.ok(!sawSignal.aborted);
		controller.abort();
		assert.ok(sawSignal.aborted, "combined signal follows the caller's abort");
	});
});
