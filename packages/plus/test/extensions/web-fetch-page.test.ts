/**
 * Tests for plus/src/extensions/web-search/fetch-page.ts (+ html.ts) — the
 * WebFetch backend: HTML → plain text conversion without deps, the https /
 * private-address guardrails, same-host redirect following vs cross-host
 * reporting, size caps, and the Firecrawl markdown path.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	fetchUrlContent,
	isFirecrawlEnabled,
	MAX_TEXT_LENGTH,
	validateFetchUrl,
} from "../../src/extensions/web-search/fetch-page.ts";
import { decodeEntities, htmlToText } from "../../src/extensions/web-search/html.ts";

/** Minimal Response stand-in — fetch-page only reads status/headers/text/ok/body. */
function mockResponse(
	body: string,
	init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
) {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 400,
		status,
		statusText: init.statusText ?? "OK",
		headers: new Headers(init.headers ?? {}),
		text: async () => body,
		json: async () => JSON.parse(body),
		body: null,
	} as unknown as Response;
}

const MANAGED_ENV_KEYS = ["WEB_FETCH_ALLOW_HTTP", "WEB_FETCH_ALLOW_PRIVATE", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"];
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
	envSnapshot = { ...process.env };
	for (const key of MANAGED_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	vi.unstubAllGlobals();
	// Restore in place — replacing the process.env object would leave vitest's
	// worker holding a dead reference for later files.
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, envSnapshot);
});

describe("decodeEntities", () => {
	it("decodes named, decimal, and hex entities", () => {
		assert.equal(decodeEntities("a &amp; b &#233; &#x2014;"), "a & b é —");
	});

	it("leaves unknown entities alone", () => {
		assert.equal(decodeEntities("&nosuchentity;"), "&nosuchentity;");
	});
});

describe("htmlToText", () => {
	it("drops script/style/comment bodies and normalizes whitespace", () => {
		const text = htmlToText(
			"<html><head><title>T</title></head><body><script>var x = 1;</script><style>p{}</style><!--note--><p>Hello   world</p></body></html>",
		);
		assert.equal(text, "Hello world");
	});

	it("keeps absolute anchor hrefs as `label (url)`", () => {
		const text = htmlToText('<a href="https://x.io/page">Docs</a> and <a href="mailto:a@b.c">mail</a>');
		assert.ok(text.includes("Docs (https://x.io/page)"));
		assert.ok(text.includes("mail (mailto:a@b.c)"));
	});

	it("resolves relative hrefs against the base URL", () => {
		const text = htmlToText('<a href="/next">Next</a>', "https://site.example/base/index.html");
		assert.ok(text.includes("Next (https://site.example/next)"));
	});

	it("turns block boundaries and <br> into newlines", () => {
		const text = htmlToText("<h1>Head</h1><p>One</p>two<br>three");
		assert.equal(text, "Head\nOne\ntwo\nthree");
	});

	it("collapses runs of blank lines", () => {
		const text = htmlToText("<p>a</p><p></p><p></p><p></p><p>b</p>");
		assert.ok(!text.includes("\n\n\n"));
	});
});

describe("validateFetchUrl", () => {
	it("rejects malformed URLs and non-http(s) protocols", () => {
		assert.throws(() => validateFetchUrl("not a url"), /Invalid URL/);
		assert.throws(() => validateFetchUrl("ftp://example.com/x"), /Unsupported protocol/);
	});

	it("requires https unless WEB_FETCH_ALLOW_HTTP=true", () => {
		assert.throws(() => validateFetchUrl("http://example.com/"), /requires https/);
		process.env.WEB_FETCH_ALLOW_HTTP = "true";
		assert.equal(validateFetchUrl("http://example.com/").hostname, "example.com");
	});

	it("blocks loopback and private addresses unless opted in", () => {
		for (const url of [
			"https://localhost/x",
			"https://127.0.0.1/x",
			"https://10.1.2.3/x",
			"https://192.168.0.1/x",
			"https://169.254.1.1/x",
			"https://[::1]/x",
			"https://[::ffff:127.0.0.1]/x",
		]) {
			assert.throws(() => validateFetchUrl(url), /private\/reserved address/, url);
		}
		process.env.WEB_FETCH_ALLOW_PRIVATE = "true";
		assert.equal(validateFetchUrl("https://localhost/x").hostname, "localhost");
	});

	it("lets public https URLs through", () => {
		assert.equal(validateFetchUrl("https://example.com/a?b=1").hostname, "example.com");
	});
});

describe("fetchUrlContent (direct path)", () => {
	it("converts an HTML page to text with a size/status header on the tool side", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockResponse("<html><body><h1>Hi</h1><p>There</p></body></html>", {
					headers: { "content-type": "text/html" },
				}),
			),
		);
		const result = await fetchUrlContent("https://example.com/page");
		assert.ok(result.page);
		assert.equal(result.page?.statusCode, 200);
		assert.equal(result.page?.markdown, false);
		assert.equal(result.page?.text, "Hi\nThere");
		assert.equal(result.page?.bytes, 49);
	});

	it("sniffs HTML when the content type is missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => mockResponse("<!doctype html><html><body>Doc</body></html>", {})),
		);
		const result = await fetchUrlContent("https://example.com/");
		assert.equal(result.page?.text, "Doc");
	});

	it("passes text/plain bodies through unchanged", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => mockResponse("plain\ttext\nlines", { headers: { "content-type": "text/plain" } })),
		);
		const result = await fetchUrlContent("https://example.com/file.txt");
		assert.equal(result.page?.text, "plain\ttext\nlines");
	});

	it("rejects unsupported content types", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => mockResponse("binary", { headers: { "content-type": "application/octet-stream" } })),
		);
		await assert.rejects(fetchUrlContent("https://example.com/bin"), /Unsupported content type/);
	});

	it("rejects oversized declared responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockResponse("x", { headers: { "content-type": "text/plain", "content-length": "11000000" } }),
			),
		);
		await assert.rejects(fetchUrlContent("https://example.com/big"), /Response too large/);
	});

	it("surfaces non-OK responses with a body excerpt", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => mockResponse("page gone", { status: 404, statusText: "Not Found" })),
		);
		await assert.rejects(fetchUrlContent("https://example.com/missing"), /HTTP 404 Not Found: page gone/);
	});

	it("truncates long text at MAX_TEXT_LENGTH", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockResponse("a".repeat(MAX_TEXT_LENGTH + 10), { headers: { "content-type": "text/plain" } }),
			),
		);
		const result = await fetchUrlContent("https://example.com/long");
		assert.equal(result.page?.truncated, true);
		assert.ok(result.page?.text.endsWith("\n[... truncated]"));
	});

	it("follows same-host redirects", async () => {
		const fetchStub = vi
			.fn()
			.mockResolvedValueOnce(mockResponse("", { status: 302, statusText: "Found", headers: { location: "/next" } }))
			.mockResolvedValueOnce(mockResponse("Arrived", { headers: { "content-type": "text/plain" } }));
		vi.stubGlobal("fetch", fetchStub);

		const result = await fetchUrlContent("https://example.com/start");
		assert.equal(result.page?.url, "https://example.com/next");
		assert.equal(result.page?.text, "Arrived");
		assert.equal(fetchStub.mock.calls.length, 2);
	});

	it("reports cross-host redirects without following them", async () => {
		const fetchStub = vi.fn().mockResolvedValueOnce(
			mockResponse("", {
				status: 301,
				statusText: "Moved Permanently",
				headers: { location: "https://cdn.example.org/page" },
			}),
		);
		vi.stubGlobal("fetch", fetchStub);

		const result = await fetchUrlContent("https://example.com/page");
		assert.equal(result.page, undefined);
		assert.deepEqual(result.redirect, {
			originalUrl: "https://example.com/page",
			redirectUrl: "https://cdn.example.org/page",
			statusCode: 301,
		});
		assert.equal(fetchStub.mock.calls.length, 1);
	});

	it("propagates caller abort as AbortError", async () => {
		const controller = new AbortController();
		controller.abort();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => mockResponse("never")),
		);
		await assert.rejects(
			fetchUrlContent("https://example.com/", controller.signal),
			(err: unknown) => (err as Error).name === "AbortError",
		);
	});
});

describe("fetchUrlContent (Firecrawl path)", () => {
	it("returns markdown when Firecrawl is configured", async () => {
		process.env.FIRECRAWL_API_KEY = "fc-key";
		assert.equal(isFirecrawlEnabled(), true);

		let seenUrl = "";
		let seenInit: RequestInit | undefined;
		const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
			seenUrl = String(input);
			seenInit = init;
			return mockResponse(JSON.stringify({ success: true, data: { markdown: "# Hello" } }));
		});
		vi.stubGlobal("fetch", fetchStub);

		const result = await fetchUrlContent("https://example.com/page");
		assert.equal(result.page?.markdown, true);
		assert.equal(result.page?.text, "# Hello");
		assert.equal(result.page?.bytes, 7);
		assert.equal(seenUrl, "https://api.firecrawl.dev/v2/scrape");
		assert.equal((seenInit?.headers as Record<string, string>).Authorization, "Bearer fc-key");
		const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
		assert.deepEqual(body.formats, ["markdown"]);
		assert.equal(body.origin, "pi-plus");
	});
});
