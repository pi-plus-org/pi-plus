/**
 * Tests for plus/src/extensions/web-search/index.ts + prompt.ts — the tool
 * registration surface: WebSearch/WebFetch tool names and validation rules,
 * the before_agent_start system-prompt section (mandatory Sources + current
 * month/year), and WebFetch's redirect-result wording.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerWebSearch } from "../../src/extensions/web-search/index.ts";
import {
	buildWebSearchSection,
	getCurrentMonthYear,
	WEB_SEARCH_SECTION_NAME,
} from "../../src/extensions/web-search/prompt.ts";

interface FakeTool {
	name: string;
	description: string;
	executionMode?: string;
	annotations?: Record<string, boolean>;
	execute: (
		toolCallId: string,
		params: never,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

function fakePi() {
	const tools = new Map<string, FakeTool>();
	const handlers = new Map<string, (event: never) => Promise<void>>();
	const pi = {
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		on: (event: string, handler: (e: never) => Promise<void>) => handlers.set(event, handler),
	};
	return { pi: pi as unknown as ExtensionAPI, tools, handlers };
}

describe("prompt", () => {
	it("section name is a valid system-prompt section key", () => {
		assert.match(WEB_SEARCH_SECTION_NAME, /^[a-z][a-z0-9_-]*$/);
	});

	it("getCurrentMonthYear renders a long month + year", () => {
		assert.equal(
			getCurrentMonthYear(new Date(Date.UTC(2026, 9, 8))),
			new Date("2026-10-08T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }),
		);
	});

	it("section mandates a Sources list and carries the current date hint", () => {
		const section = buildWebSearchSection(new Date("2026-03-01T12:00:00"));
		assert.ok(section.includes("Sources:"));
		assert.ok(section.includes("markdown hyperlinks"));
		assert.ok(section.includes("March 2026"));
		assert.ok(section.includes("WebFetch"));
		assert.ok(section.includes("authenticated or private URLs"));
	});
});

describe("registerWebSearch", () => {
	const envSnapshot = { ...process.env };

	beforeEach(() => {
		for (const key of ["WEB_SEARCH_PROVIDER", "WEB_SEARCH_TIMEOUT_SEC", "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL"]) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, envSnapshot);
	});

	it("registers WebSearch and WebFetch as parallel read-only open-world tools", () => {
		const { pi, tools } = fakePi();
		registerWebSearch(pi);
		assert.deepEqual([...tools.keys()], ["WebSearch", "WebFetch"]);
		for (const tool of tools.values()) {
			assert.equal(tool.executionMode, "parallel");
			assert.equal(tool.annotations?.readOnlyHint, true);
			assert.equal(tool.annotations?.openWorldHint, true);
		}
		assert.match(tools.get("WebFetch")!.description, /fail for authenticated or private URLs/);
	});

	it("before_agent_start injects the web-search section", async () => {
		const { pi, handlers } = fakePi();
		registerWebSearch(pi);
		const handler = handlers.get("before_agent_start");
		assert.ok(handler);
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handler!(event as never);
		assert.match(event.systemPromptOptions.sections[WEB_SEARCH_SECTION_NAME]!, /Sources:/);
	});

	it("WebSearch rejects empty queries and conflicting domain filters", async () => {
		const { pi, tools } = fakePi();
		registerWebSearch(pi);
		const webSearch = tools.get("WebSearch")!;
		await assert.rejects(
			webSearch.execute("t1", { query: "   " } as never, undefined, undefined, undefined),
			/Missing query/,
		);
		await assert.rejects(
			webSearch.execute(
				"t1",
				{ query: "q", allowed_domains: ["a.com"], blocked_domains: ["b.com"] } as never,
				undefined,
				undefined,
				undefined,
			),
			/Cannot specify both allowed_domains and blocked_domains/,
		);
	});

	it("WebSearch formats a successful provider run (ddg mode, stubbed fetch)", async () => {
		process.env.WEB_SEARCH_PROVIDER = "ddg";
		const html = '<a class="result__a" href="https://one.example.com/a">One</a><div class="result__snippet">SN</div>';
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200, text: async () => html }) as Response),
		);

		const { pi, tools } = fakePi();
		registerWebSearch(pi);
		const result = await tools
			.get("WebSearch")!
			.execute("t1", { query: "one" } as never, undefined, undefined, undefined);
		const text = result.content[0]!.text;
		assert.match(text, /^Web search results for query: "one" \(1 hits in .*s via duckduckgo\)/);
		assert.match(text, /\*\*One\*\* — SN \(https:\/\/one\.example\.com\/a\)/);
		assert.match(text, /REMINDER: You MUST include the sources/);
		assert.deepEqual((result.details as { hits: unknown[] }).hits.length, 1);
	});

	it("WebFetch rejects empty urls and reports cross-host redirects verbatim", async () => {
		const { pi, tools } = fakePi();
		registerWebSearch(pi);
		const webFetch = tools.get("WebFetch")!;
		await assert.rejects(
			webFetch.execute("t1", { url: "" } as never, undefined, undefined, undefined),
			/Missing url/,
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: false,
						status: 301,
						statusText: "Moved",
						headers: new Headers({ location: "https://other.example/x" }),
					}) as Response,
			),
		);
		const result = await webFetch.execute(
			"t1",
			{ url: "https://example.com/x", prompt: "find Y" } as never,
			undefined,
			undefined,
			undefined,
		);
		const text = result.content[0]!.text;
		assert.match(text, /REDIRECT DETECTED: The URL redirects to a different host\./);
		assert.match(text, /Original URL: https:\/\/example\.com\/x/);
		assert.match(text, /Redirect URL: https:\/\/other\.example\/x/);
		assert.match(text, /call WebFetch again with url: "https:\/\/other\.example\/x"/);
	});

	it("WebFetch renders the page header including truncation and focus note", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					({
						ok: true,
						status: 200,
						statusText: "OK",
						headers: new Headers({ "content-type": "text/plain" }),
						text: async () => "hello body",
					}) as Response,
			),
		);
		const { pi, tools } = fakePi();
		registerWebSearch(pi);
		const result = await tools
			.get("WebFetch")!
			.execute(
				"t1",
				{ url: "https://example.com/a", prompt: "the answer" } as never,
				undefined,
				undefined,
				undefined,
			);
		const text = result.content[0]!.text;
		assert.match(text, /^Fetched 10 B from example\.com \(HTTP 200 OK\)\n\nLooking for: the answer\nhello body$/);
	});
});
