/**
 * Tests for plus/src/extensions/web-search/format.ts — the model-visible
 * WebSearch result text: header line, snippet block, Links JSON, the
 * mandatory-sources REMINDER, and the empty-result backend hint.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	buildEmptyResultHint,
	buildSearchDetails,
	formatSearchResultText,
} from "../../src/extensions/web-search/format.ts";
import type { ProviderOutput, SearchHit } from "../../src/extensions/web-search/types.ts";

function po(hits: SearchHit[], providerName = "brave", durationSeconds = 1.234): ProviderOutput {
	return { hits, providerName, durationSeconds };
}

describe("formatSearchResultText", () => {
	const hits: SearchHit[] = [
		{ title: "First", url: "https://one.example.com/", description: "Snippet one", source: "one.example.com" },
		{ title: "Second", url: "https://two.example.com/", description: "Snippet two" },
	];

	it("renders header, snippets, links, and reminder", () => {
		const text = formatSearchResultText(po(hits), "best llm cli");
		assert.ok(text.startsWith('Web search results for query: "best llm cli" (2 hits in 1.23s via brave)'));
		assert.ok(text.includes("**First** — Snippet one (https://one.example.com/)"));
		assert.ok(text.includes("**Second** — Snippet two (https://two.example.com/)"));
		assert.ok(
			text.includes(
				"REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.",
			),
		);
	});

	it("emits a parseable Links JSON array of title/url pairs", () => {
		const text = formatSearchResultText(po(hits), "q");
		const jsonStart = text.indexOf("Links: ") + "Links: ".length;
		const jsonEnd = text.indexOf("\n", jsonStart);
		const parsed = JSON.parse(text.slice(jsonStart, jsonEnd)) as { title: string; url: string }[];
		assert.deepEqual(parsed, [
			{ title: "First", url: "https://one.example.com/" },
			{ title: "Second", url: "https://two.example.com/" },
		]);
	});

	it("skips the snippet block when no hit has a description", () => {
		const text = formatSearchResultText(po([{ title: "Bare", url: "https://b.example.com/" }]), "q");
		assert.ok(!text.includes("**Bare** —"));
		assert.ok(text.includes("Links: ["));
	});

	it("zero hits renders the actionable backend hint instead of an empty body", () => {
		const text = formatSearchResultText(po([], "duckduckgo", 0.5), "q");
		assert.ok(text.includes("(0 hits in 0.50s via duckduckgo)"));
		assert.ok(text.includes('No results from "duckduckgo" search backend.'));
		assert.ok(text.includes("TAVILY_API_KEY"));
		assert.ok(!text.includes("REMINDER"));
	});
});

describe("buildEmptyResultHint", () => {
	it("lists the configured-backend env vars", () => {
		const hint = buildEmptyResultHint("duckduckgo");
		for (const key of ["OLLAMA_BASE_URL", "FIRECRAWL_API_KEY", "BRAVE_API_KEY", "LINKUP_API_KEY"]) {
			assert.ok(hint.includes(key), `hint should mention ${key}`);
		}
	});
});

describe("buildSearchDetails", () => {
	it("mirrors query/provider/duration/hits", () => {
		const details = buildSearchDetails(po([{ title: "T", url: "https://t.example/" }], "tavily", 2.5), "q");
		assert.deepEqual(details, {
			query: "q",
			providerName: "tavily",
			durationSeconds: 2.5,
			hits: [{ title: "T", url: "https://t.example/" }],
		});
	});
});
