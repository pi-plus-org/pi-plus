/**
 * Tests for plus/src/extensions/web-search/providers/duckduckgo.ts — the
 * dependency-free html.duckduckgo.com scraper: redirect-unwrap, entity-safe
 * parsing of result__a / result__snippet blocks, anomaly detection (fail fast
 * with the env-var hint), and retry classification on transient network errors.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	duckduckgoProvider,
	parseDuckDuckGoHtml,
	unwrapDuckDuckGoHref,
} from "../../src/extensions/web-search/providers/duckduckgo.ts";

describe("unwrapDuckDuckGoHref", () => {
	it("unwraps the /l/?uddg= redirect wrapper", () => {
		assert.equal(
			unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=deadbeef"),
			"https://example.com/a?b=1",
		);
	});

	it("keeps plain absolute URLs untouched", () => {
		assert.equal(unwrapDuckDuckGoHref("https://example.com/x"), "https://example.com/x");
	});

	it("decodes HTML entities in the href", () => {
		assert.equal(unwrapDuckDuckGoHref("https://example.com/a&amp;b"), "https://example.com/a&b");
	});

	it("resolves relative hrefs against the DDG endpoint", () => {
		assert.equal(unwrapDuckDuckGoHref("/l/?uddg=https%3A%2F%2Fexample.com%2F"), "https://example.com/");
	});
});

describe("parseDuckDuckGoHtml", () => {
	it("pairs titles, unwrapped links, and snippets with entity decoding", () => {
		const html = `
			<div class="result">
				<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.example.com%2Fx">One &amp; Co <b>bold</b></a>
				<div class="result__snippet">First <b>snippet</b> text</div>
			</div>
			<div class="result">
				<a class="result__a" href="https://two.example.com/y">Two</a>
				<div class="result__snippet">Second &#8212; snippet</div>
			</div>`;
		const hits = parseDuckDuckGoHtml(html);
		assert.equal(hits.length, 2);
		assert.equal(hits[0]?.title, "One & Co bold");
		assert.equal(hits[0]?.url, "https://one.example.com/x");
		assert.equal(hits[0]?.description, "First snippet text");
		assert.equal(hits[1]?.title, "Two");
		assert.equal(hits[1]?.url, "https://two.example.com/y");
		assert.equal(hits[1]?.description, "Second — snippet");
	});

	it("accepts anchor-shaped snippets too", () => {
		const html = '<a class="result__a" href="https://x.example/">X</a><a class="result__snippet">S</a>';
		assert.equal(parseDuckDuckGoHtml(html)[0]?.description, "S");
	});

	it("returns an empty list for a zero-result page", () => {
		const html = "<body><h1>It looks like there's no relevant result here.</h1></body>";
		assert.deepEqual(parseDuckDuckGoHtml(html), []);
	});

	it("omits the description when no snippet block is present", () => {
		const html = '<a class="result__a" href="https://x.example/">X</a>';
		const hits = parseDuckDuckGoHtml(html);
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.description, undefined);
	});
});

describe("duckduckgoProvider.search", () => {
	const envSnapshot = { ...process.env };

	beforeEach(() => {
		delete process.env.WEB_SEARCH_TIMEOUT_SEC;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.WEB_SEARCH_TIMEOUT_SEC;
		if (envSnapshot.WEB_SEARCH_TIMEOUT_SEC !== undefined)
			process.env.WEB_SEARCH_TIMEOUT_SEC = envSnapshot.WEB_SEARCH_TIMEOUT_SEC;
	});

	it("posts the query as a form body and parses the response", async () => {
		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
			seenUrl = String(input);
			seenInit = init;
			return {
				ok: true,
				status: 200,
				text: async () => '<a class="result__a" href="https://x.example/">X</a>',
			} as Response;
		});
		vi.stubGlobal("fetch", fetchStub);

		const out = await duckduckgoProvider.search({ query: "pi coding agent" });
		assert.equal(out.providerName, "duckduckgo");
		assert.equal(out.hits.length, 1);
		assert.equal(seenUrl, "https://html.duckduckgo.com/html/");
		assert.equal(seenInit?.method, "POST");
		assert.equal(seenInit?.body, "q=pi+coding+agent&kl=wt-wt");
	});

	it("applies domain filters to parsed hits", async () => {
		const page =
			'<a class="result__a" href="https://keep.example.com/a">A</a><a class="result__a" href="https://drop.example.org/b">B</a>';
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, text: async () => page }) as Response),
		);

		const out = await duckduckgoProvider.search({ query: "q", allowed_domains: ["keep.example.com"] });
		assert.deepEqual(
			out.hits.map((h) => h.url),
			["https://keep.example.com/a"],
		);
	});

	it("fails fast on the anomaly page with the configure-a-backend hint (no retries)", async () => {
		const fetchStub = vi.fn(
			async () =>
				({
					ok: true,
					status: 200,
					text: async () =>
						"<body>Unfortunately, bots use DuckDuckGo too. We've seen an anomaly in the request.</body>",
				}) as Response,
		);
		vi.stubGlobal("fetch", fetchStub);

		await assert.rejects(duckduckgoProvider.search({ query: "q" }), (err: unknown) => {
			const message = (err as Error).message;
			assert.match(message, /rate-limited from this network/);
			assert.match(message, /TAVILY_API_KEY/);
			assert.match(message, /BRAVE_API_KEY/);
			return true;
		});
		assert.equal(fetchStub.mock.calls.length, 1, "anomaly hint must not be retried");
	});

	it("retries transient network errors before succeeding", async () => {
		const html = '<a class="result__a" href="https://x.example/">X</a>';
		const fetchStub = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
			.mockResolvedValueOnce({ ok: true, status: 200, text: async () => html } as unknown as Response);
		vi.stubGlobal("fetch", fetchStub);

		const out = await duckduckgoProvider.search({ query: "q" });
		assert.equal(out.hits.length, 1);
		assert.equal(fetchStub.mock.calls.length, 2);
	});

	it("gives up after MAX_RETRIES transient failures", async () => {
		const fetchStub = vi.fn(async () => {
			throw new Error("socket hang up: ETIMEDOUT");
		});
		vi.stubGlobal("fetch", fetchStub);

		// 1s + 2s backoff sleeps between the three attempts.
		await assert.rejects(duckduckgoProvider.search({ query: "q" }), /ETIMEDOUT/);
		assert.equal(fetchStub.mock.calls.length, 3);
	}, 30_000);

	it("stops immediately on caller abort", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchStub = vi.fn();
		vi.stubGlobal("fetch", fetchStub);
		await assert.rejects(
			duckduckgoProvider.search({ query: "q" }, controller.signal),
			(err: unknown) => (err as Error).name === "AbortError",
		);
		assert.equal(fetchStub.mock.calls.length, 0);
	});
});
