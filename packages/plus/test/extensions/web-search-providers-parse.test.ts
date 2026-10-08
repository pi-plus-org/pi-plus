/**
 * Spot tests for the REST provider adapters (tavily/brave/exa/you) and the
 * custom provider: response parsing shapes, auth headers, request bodies,
 * domain-filter placement, and the custom adapter's SSRF guardrails. All
 * network I/O goes through a stubbed global fetch.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { braveProvider } from "../../src/extensions/web-search/providers/brave.ts";
import {
	customProvider,
	extractHits,
	isPrivateHostname,
	readPositiveEnvNumber,
	resetCustomSearchAuditLog,
} from "../../src/extensions/web-search/providers/custom.ts";
import { exaProvider } from "../../src/extensions/web-search/providers/exa.ts";
import { sanitizeApiKey } from "../../src/extensions/web-search/providers/ollama.ts";
import { tavilyProvider } from "../../src/extensions/web-search/providers/tavily.ts";
import { youProvider } from "../../src/extensions/web-search/providers/you.ts";

const MANAGED_ENV_KEYS = [
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"EXA_API_KEY",
	"YOU_API_KEY",
	"WEB_SEARCH_API",
	"WEB_PROVIDER",
	"WEB_URL_TEMPLATE",
	"WEB_KEY",
	"WEB_AUTH_HEADER",
	"WEB_AUTH_SCHEME",
	"WEB_JSON_PATH",
	"WEB_PARAMS",
	"WEB_HEADERS",
	"WEB_METHOD",
	"GOOGLE_CSE_ID",
	"WEB_CUSTOM_ALLOW_HTTP",
	"WEB_CUSTOM_ALLOW_PRIVATE",
	"WEB_SEARCH_TIMEOUT_SEC",
];

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
	envSnapshot = { ...process.env };
	for (const key of MANAGED_ENV_KEYS) delete process.env[key];
	vi.spyOn(console, "warn").mockImplementation(() => {});
	resetCustomSearchAuditLog();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	// Restore in place — replacing the process.env object would leave vitest's
	// worker holding a dead reference for later files.
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, envSnapshot);
});

function stubJsonFetch(payload: unknown) {
	const fetchStub = vi.fn(
		async (_input: unknown, _init?: RequestInit) =>
			({ ok: true, status: 200, json: async () => payload }) as Response,
	);
	vi.stubGlobal("fetch", fetchStub);
	return fetchStub;
}

describe("tavilyProvider", () => {
	it("POSTs the query and maps results[].content into descriptions", async () => {
		process.env.TAVILY_API_KEY = "t";
		const fetchStub = stubJsonFetch({
			results: [{ title: "A", url: "https://x.io/a", content: "Body text" }],
		});

		const out = await tavilyProvider.search({ query: "hello world" });
		assert.equal(out.providerName, "tavily");
		assert.deepEqual(out.hits, [{ title: "A", url: "https://x.io/a", description: "Body text", source: "x.io" }]);

		const [url, init] = fetchStub.mock.calls[0]!;
		assert.equal(url, "https://api.tavily.com/search");
		assert.equal(init?.method, "POST");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer t");
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		assert.equal(body.query, "hello world");
		assert.equal(body.max_results, 15);
	});

	it("applies client-side domain filters", async () => {
		process.env.TAVILY_API_KEY = "t";
		stubJsonFetch({ results: [{ title: "A", url: "https://x.io/a" }] });
		const out = await tavilyProvider.search({ query: "q", blocked_domains: ["x.io"] });
		assert.deepEqual(out.hits, []);
	});
});

describe("braveProvider", () => {
	it("sends the bare subscription token and parses web.results", async () => {
		process.env.BRAVE_API_KEY = "b";
		const fetchStub = stubJsonFetch({
			web: { results: [{ title: "T", url: "https://y.io/t", description: "D" }] },
		});

		const out = await braveProvider.search({ query: "some query" });
		assert.equal(out.providerName, "brave");
		assert.equal(out.hits[0]?.description, "D");
		assert.equal(out.hits[0]?.source, "y.io");

		const [url, init] = fetchStub.mock.calls[0]!;
		const parsed = new URL(String(url));
		assert.equal(parsed.pathname, "/res/v1/web/search");
		assert.equal(parsed.searchParams.get("q"), "some query");
		assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "b");
	});

	it("survives a response without a web field", async () => {
		process.env.BRAVE_API_KEY = "b";
		stubJsonFetch({});
		const out = await braveProvider.search({ query: "q" });
		assert.deepEqual(out.hits, []);
	});
});

describe("exaProvider", () => {
	it("joins up to 3 highlights and requests server-side domain filtering", async () => {
		process.env.EXA_API_KEY = "e";
		const fetchStub = stubJsonFetch({
			results: [
				{ title: "T", url: "https://z.io/t", highlights: ["h1", "h2", "h3", "h4"] },
				{ title: "U", url: "https://z.io/u", text: "plain body" },
			],
		});

		const out = await exaProvider.search({ query: "q", allowed_domains: ["z.io"] });
		assert.equal(out.hits[0]?.description, "h1 … h2 … h3");
		assert.equal(out.hits[1]?.description, "plain body");

		const [, init] = fetchStub.mock.calls[0]!;
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		assert.deepEqual(body.includeDomains, ["z.io"]);
		assert.equal((body.contents as Record<string, unknown>).highlights, true);
	});

	it("does not re-filter client-side (Exa filters server-side)", async () => {
		process.env.EXA_API_KEY = "e";
		stubJsonFetch({ results: [{ title: "T", url: "https://other.example/t" }] });
		const out = await exaProvider.search({ query: "q", blocked_domains: ["other.example"] });
		assert.equal(out.hits.length, 1);
	});
});

describe("youProvider", () => {
	it("parses the nested results.web shape with snippets arrays", async () => {
		process.env.YOU_API_KEY = "y";
		const fetchStub = stubJsonFetch({
			results: { web: [{ title: "T", url: "https://w.io/t", snippets: ["s1", "s2"] }] },
		});

		const out = await youProvider.search({ query: "q" });
		assert.equal(out.hits[0]?.description, "s1");
		const [url, init] = fetchStub.mock.calls[0]!;
		assert.equal((init?.headers as Record<string, string>)["X-API-Key"], "y");
		assert.ok(String(url).includes("num_web_results=10"));
	});

	it("parses the flat results array shape with a direct snippet", async () => {
		process.env.YOU_API_KEY = "y";
		stubJsonFetch({ results: [{ title: "T", url: "https://w.io/t", snippet: "direct" }] });
		const out = await youProvider.search({ query: "q" });
		assert.equal(out.hits[0]?.description, "direct");
	});
});

describe("customProvider", () => {
	it("is configured by WEB_SEARCH_API alone", () => {
		assert.equal(customProvider.isConfigured(), false);
		process.env.WEB_SEARCH_API = "https://api.example.com/search";
		assert.equal(customProvider.isConfigured(), true);
	});

	it("GETs WEB_SEARCH_API with bearer WEB_KEY and auto-detects the results array", async () => {
		process.env.WEB_SEARCH_API = "https://api.example.com/search";
		process.env.WEB_KEY = "k";
		const fetchStub = stubJsonFetch({ results: [{ title: "T", url: "https://x.io/a", snippet: "S" }] });

		const out = await customProvider.search({ query: "hello" });
		assert.equal(out.providerName, "custom");
		assert.deepEqual(out.hits, [{ title: "T", url: "https://x.io/a", description: "S" }]);

		const [url, init] = fetchStub.mock.calls[0]!;
		assert.equal(new URL(String(url)).searchParams.get("q"), "hello");
		assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer k");
	});

	it("honours WEB_JSON_PATH for unusual shapes", async () => {
		process.env.WEB_SEARCH_API = "https://api.example.com/search";
		process.env.WEB_JSON_PATH = "data.items";
		stubJsonFetch({ data: { items: [{ name: "N", link: "https://x.io/", text: "T" }] } });

		const out = await customProvider.search({ query: "q" });
		assert.deepEqual(out.hits, [{ title: "N", url: "https://x.io/", description: "T" }]);
	});

	it("uses the google preset adapter and fails fast without GOOGLE_CSE_ID", async () => {
		process.env.WEB_PROVIDER = "google";
		process.env.WEB_KEY = "k";
		const fetchStub = stubJsonFetch({
			items: [{ title: "T", link: "https://g.io/t", snippet: "S", displayLink: "g.io" }],
		});

		await assert.rejects(customProvider.search({ query: "q" }), /requires environment variable GOOGLE_CSE_ID/);
		assert.equal(fetchStub.mock.calls.length, 0);

		process.env.GOOGLE_CSE_ID = "engine";
		const out = await customProvider.search({ query: "q" });
		assert.deepEqual(out.hits, [{ title: "T", url: "https://g.io/t", description: "S", source: "g.io" }]);
		const [url, init] = fetchStub.mock.calls[0]!;
		// Google authenticates via ?key= — no Authorization header.
		assert.equal(new URL(String(url)).searchParams.get("key"), "k");
		assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, undefined);
	});

	it("blocks private target URLs unless WEB_CUSTOM_ALLOW_PRIVATE=true", async () => {
		process.env.WEB_SEARCH_API = "https://127.0.0.1:8080/search";
		await assert.rejects(customProvider.search({ query: "q" }), /private\/reserved address/);
		process.env.WEB_CUSTOM_ALLOW_PRIVATE = "true";
		const fetchStub = stubJsonFetch({ results: [] });
		await customProvider.search({ query: "q" });
		assert.equal(fetchStub.mock.calls.length, 1);
	});

	it("requires https unless WEB_CUSTOM_ALLOW_HTTP=true", async () => {
		process.env.WEB_SEARCH_API = "http://api.example.com/search";
		await assert.rejects(customProvider.search({ query: "q" }), /must use https/);
	});

	it("does not retry 4xx responses", async () => {
		process.env.WEB_SEARCH_API = "https://api.example.com/search";
		const fetchStub = vi.fn(
			async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) }) as Response,
		);
		vi.stubGlobal("fetch", fetchStub);
		await assert.rejects(customProvider.search({ query: "q" }), /returned 404/);
		assert.equal(fetchStub.mock.calls.length, 1);
	});

	it("enforces the header allowlist for WEB_HEADERS", async () => {
		process.env.WEB_SEARCH_API = "https://api.example.com/search";
		process.env.WEB_HEADERS = "X-Weird-Internal: 1";
		await assert.rejects(customProvider.search({ query: "q" }), /not in the safe allowlist/);

		process.env.WEB_HEADERS = "Accept: application/json";
		stubJsonFetch({ results: [] });
		await customProvider.search({ query: "q" });
	});
});

describe("extractHits", () => {
	it("walks json paths when given", () => {
		const hits = extractHits({ a: { b: [{ url: "https://x.io/", title: "T" }] } }, "a.b");
		assert.equal(hits.length, 1);
		assert.equal(hits[0]?.title, "T");
	});

	it("finds arrays under common keys and one nesting level into objects", () => {
		assert.equal(extractHits({ results: [{ url: "https://x.io/" }] }).length, 1);
		assert.equal(extractHits({ web: { results: [{ url: "https://x.io/" }] } }).length, 1);
		assert.deepEqual(extractHits({ unrelated: { nope: 1 } }), []);
	});

	it("accepts a bare array", () => {
		assert.equal(extractHits([{ title: "T", url: "https://x.io/" }]).length, 1);
	});
});

describe("isPrivateHostname", () => {
	it("classifies IPv4 ranges", () => {
		for (const host of [
			"localhost",
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"127.5.6.7",
			"169.254.9.9",
			"172.16.0.1",
			"192.168.4.4",
		]) {
			assert.equal(isPrivateHostname(host), true, host);
		}
		for (const host of ["example.com", "8.8.8.8", "100.128.0.1", "172.32.0.1", "192.169.0.1"]) {
			assert.equal(isPrivateHostname(host), false, host);
		}
	});

	it("classifies IPv6 literals (with URL brackets)", () => {
		assert.equal(isPrivateHostname("[::1]"), true);
		assert.equal(isPrivateHostname("[::]"), true);
		assert.equal(isPrivateHostname("[fe80::1]"), true);
		assert.equal(isPrivateHostname("[fc00::1]"), true);
		assert.equal(isPrivateHostname("[::ffff:10.0.0.1]"), true);
		assert.equal(isPrivateHostname("[2606:4700:4700::1111]"), false);
	});
});

describe("readPositiveEnvNumber", () => {
	it("rescues negatives and infinities, not just NaN and zero", () => {
		assert.equal(readPositiveEnvNumber("12", 5), 12);
		assert.equal(readPositiveEnvNumber(undefined, 5), 5);
		assert.equal(readPositiveEnvNumber("", 5), 5);
		assert.equal(readPositiveEnvNumber("0", 5), 5);
		assert.equal(readPositiveEnvNumber("-5", 5), 5);
		assert.equal(readPositiveEnvNumber("Infinity", 5), 5);
		assert.equal(readPositiveEnvNumber("abc", 5), 5);
	});
});

describe("sanitizeApiKey (ollama)", () => {
	it("trims real keys and rejects placeholder values", () => {
		assert.equal(sanitizeApiKey("  secret  "), "secret");
		assert.equal(sanitizeApiKey("null"), undefined);
		assert.equal(sanitizeApiKey("undefined"), undefined);
		assert.equal(sanitizeApiKey("sua_chave"), undefined);
		assert.equal(sanitizeApiKey(""), undefined);
	});
});
