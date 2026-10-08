/**
 * Tests for plus/src/extensions/web-search/providers/index.ts — mode
 * selection, the auto fallback chain (filtered by isConfigured), and
 * runSearchChain semantics: auto falls through with a stderr note, explicit
 * modes fail loudly, caller aborts stop immediately.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
	getAvailableProviders,
	getProviderChain,
	getProviderMode,
	runSearch,
	runSearchChain,
} from "../../src/extensions/web-search/providers/index.ts";
import type { ProviderOutput, SearchProvider } from "../../src/extensions/web-search/types.ts";

/** Every env var an isConfigured() check reads — cleared for deterministic chains. */
const PROVIDER_ENV_KEYS = [
	"OLLAMA_BASE_URL",
	"OLLAMA_API_KEY",
	"FIRECRAWL_API_KEY",
	"FIRECRAWL_API_URL",
	"TAVILY_API_KEY",
	"EXA_API_KEY",
	"YOU_API_KEY",
	"JINA_API_KEY",
	"BRAVE_API_KEY",
	"BING_API_KEY",
	"MOJEEK_API_KEY",
	"LINKUP_API_KEY",
	"WEB_SEARCH_API",
	"WEB_PROVIDER",
	"WEB_URL_TEMPLATE",
	"WEB_SEARCH_PROVIDER",
];

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
	envSnapshot = { ...process.env };
	for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	// Restore in place — replacing the process.env object would leave vitest's
	// worker holding a dead reference for later files.
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, envSnapshot);
});

function output(providerName: string): ProviderOutput {
	return { hits: [{ title: "T", url: "https://x.io/" }], providerName, durationSeconds: 0.1 };
}

function stubProvider(
	name: string,
	behavior: { ok?: ProviderOutput; fail?: Error; configured?: boolean; onCall?: () => void },
): SearchProvider {
	return {
		name,
		isConfigured: () => behavior.configured ?? true,
		async search() {
			behavior.onCall?.();
			if (behavior.fail) throw behavior.fail;
			return behavior.ok ?? output(name);
		},
	};
}

describe("getProviderMode", () => {
	it("defaults to auto and keeps only valid modes", () => {
		assert.equal(getProviderMode({}), "auto");
		assert.equal(getProviderMode({ WEB_SEARCH_PROVIDER: "ddg" }), "ddg");
		assert.equal(getProviderMode({ WEB_SEARCH_PROVIDER: "tavily" }), "tavily");
		assert.equal(getProviderMode({ WEB_SEARCH_PROVIDER: "custom" }), "custom");
		assert.equal(getProviderMode({ WEB_SEARCH_PROVIDER: "native" }), "auto");
		assert.equal(getProviderMode({ WEB_SEARCH_PROVIDER: "bogus" }), "auto");
	});
});

describe("getProviderChain / getAvailableProviders", () => {
	it("auto with no keys configured yields only the keyless duckduckgo fallback", () => {
		assert.deepEqual(
			getProviderChain("auto").map((p) => p.name),
			["duckduckgo"],
		);
		assert.deepEqual(
			getAvailableProviders().map((p) => p.name),
			["duckduckgo"],
		);
	});

	it("auto respects priority order between configured providers", () => {
		process.env.TAVILY_API_KEY = "t";
		process.env.BRAVE_API_KEY = "b";
		assert.deepEqual(
			getProviderChain("auto").map((p) => p.name),
			["tavily", "brave", "duckduckgo"],
		);
	});

	it("firecrawl configures on either key and ollama on either of its env vars", () => {
		process.env.FIRECRAWL_API_URL = "http://127.0.0.1:3030";
		process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
		const names = getProviderChain("auto").map((p) => p.name);
		assert.ok(names.includes("firecrawl"));
		assert.ok(names.includes("ollama"));
	});

	it("explicit modes return the single named provider", () => {
		assert.deepEqual(
			getProviderChain("brave").map((p) => p.name),
			["brave"],
		);
		assert.deepEqual(
			getProviderChain("custom").map((p) => p.name),
			["custom"],
		);
	});
});

describe("runSearchChain", () => {
	it("throws a clear error for an empty chain", async () => {
		await assert.rejects(runSearchChain([], "auto", { query: "q" }), /No search providers available for mode "auto"/);
	});

	it("auto falls through failures to the next provider", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const second = stubProvider("second", { ok: output("second") });
		const first = stubProvider("first", { fail: new Error("first down") });
		const result = await runSearchChain([first, second], "auto", { query: "q" });
		assert.equal(result.providerName, "second");
		assert.ok(errorSpy.mock.calls.some((call) => String(call[0]).includes("first failed: first down")));
	});

	it("auto re-throws the single error unchanged when only one provider ran", async () => {
		const first = stubProvider("first", { fail: new Error("only one") });
		await assert.rejects(runSearchChain([first], "auto", { query: "q" }), /only one/);
	});

	it("auto aggregates all errors when every provider fails", async () => {
		const a = stubProvider("a", { fail: new Error("a failed") });
		const b = stubProvider("b", { fail: new Error("b failed") });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await assert.rejects(runSearchChain([a, b], "auto", { query: "q" }), (err: unknown) => {
			const message = (err as Error).message;
			assert.ok(message.startsWith("All 2 search providers failed:"));
			assert.ok(message.includes("1. a failed"));
			assert.ok(message.includes("2. b failed"));
			return true;
		});
		assert.equal(errorSpy.mock.calls.length, 2);
	});

	it("explicit mode fails loudly without trying anything else", async () => {
		const attempted: string[] = [];
		const a = stubProvider("a", { fail: new Error("a failed"), onCall: () => attempted.push("a") });
		const b = stubProvider("b", { ok: output("b"), onCall: () => attempted.push("b") });
		await assert.rejects(runSearchChain([a, b], "tavily", { query: "q" }), /a failed/);
		assert.deepEqual(attempted, ["a"]);
	});

	it("explicit mode refuses an unconfigured provider with setup guidance", async () => {
		const unconfigured = stubProvider("tavily", { configured: false });
		await assert.rejects(
			runSearchChain([unconfigured], "tavily", { query: "q" }),
			/Search provider "tavily" is not configured\. Set the required environment variable .*TAVILY_API_KEY/,
		);
	});

	it("caller abort stops the chain immediately", async () => {
		const attempted: string[] = [];
		const abortErr = new DOMException("Aborted", "AbortError");
		const a = stubProvider("a", { fail: abortErr, onCall: () => attempted.push("a") });
		const b = stubProvider("b", { ok: output("b"), onCall: () => attempted.push("b") });
		await assert.rejects(
			runSearchChain([a, b], "auto", { query: "q" }),
			(err: unknown) => (err as Error).name === "AbortError",
		);
		assert.deepEqual(attempted, ["a"]);
	});
});

describe("runSearch", () => {
	it("runs the selected provider through the real registry (ddg mode, stubbed fetch)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "ddg";
		const html =
			'<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example</a>' +
			'<div class="result__snippet">A snippet</div></div>';
		const fetchStub = vi.fn(async () => ({ ok: true, status: 200, text: async () => html }) as Response);
		vi.stubGlobal("fetch", fetchStub);

		const result = await runSearch({ query: "example" });
		assert.equal(result.providerName, "duckduckgo");
		assert.equal(result.hits.length, 1);
		assert.equal(result.hits[0]?.url, "https://example.com/a");
	});
});
