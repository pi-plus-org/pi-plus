/**
 * Tests for plus/src/extensions/mcp-autocomplete/index.ts — MCP tools in the
 * editor's slash completion: bare "/" queries get mcp__<server>__<tool> items
 * appended to the inner provider's suggestions, while paths and command
 * arguments pass through untouched, hidden tools stay excluded, and
 * applyCompletion delegates to the inner provider.
 */

import assert from "node:assert/strict";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import type { ExtensionAPI, ToolInfo } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerMcpAutocomplete } from "../../src/extensions/mcp-autocomplete/index.ts";

function toolInfo(name: string, description: string, exposure: ToolInfo["exposure"] = "direct"): ToolInfo {
	return { name, description, exposure } as ToolInfo;
}

function fakePi(tools: ToolInfo[]) {
	const handlers = new Map<string, (event: never, ctx: unknown) => void>();
	const pi = {
		getAllTools: () => tools,
		on: (event: string, handler: (e: never, ctx: unknown) => void) => handlers.set(event, handler),
	};
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

/** A stub inner provider: fixed suggestions, an applyCompletion spy. */
function fakeInner(items: AutocompleteItem[] | null) {
	const applied: unknown[] = [];
	const inner: AutocompleteProvider = {
		async getSuggestions(): Promise<AutocompleteSuggestions | null> {
			return items && { items, prefix: "/" };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			applied.push([lines, cursorLine, cursorCol, item, prefix]);
			return { lines, cursorLine, cursorCol };
		},
	};
	return { inner, applied };
}

const TOOLS = [
	toolInfo("mcp__github__create_issue", "Create a GitHub issue"),
	toolInfo("mcp__github__search_repos", "Search GitHub repositories"),
	toolInfo("mcp__filesystem__read_file", "Read a file"),
	toolInfo("mcp__internal__secret", "Hidden tool", "hidden"),
	toolInfo("bash", "Run a shell command"),
];

const OPTIONS = { signal: new AbortController().signal };

describe("registerMcpAutocomplete", () => {
	it("wraps the autocomplete provider on session_start", () => {
		const { pi, handlers } = fakePi(TOOLS);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(fakeInner(null).inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		assert.ok(wrapped);
	});

	it("appends MCP tools to the inner provider's slash-command suggestions", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		const { inner, applied } = fakeInner([{ value: "git", label: "git", description: "Git commands" }]);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		const result = await wrapped!.getSuggestions(["/"], 0, 1, OPTIONS);
		assert.ok(result);
		assert.deepEqual(
			result.items.map((item) => item.value),
			["git", "mcp__github__create_issue", "mcp__github__search_repos", "mcp__filesystem__read_file"],
		);
		assert.equal(result.prefix, "/");
		// The MCP item carries the tool's description for the completion menu.
		const mcp = result.items.find((item) => item.value === "mcp__github__create_issue")!;
		assert.equal(mcp.description, "Create a GitHub issue");
		void applied;
	});

	it("fuzzy-matches the query against tool names", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(fakeInner(null).inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		const result = await wrapped!.getSuggestions(["/create"], 0, 7, OPTIONS);
		assert.ok(result);
		assert.deepEqual(
			result.items.map((item) => item.value),
			["mcp__github__create_issue"],
		);
		assert.equal(result.prefix, "/create");
	});

	it("excludes hidden tools and non-MCP tools", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(fakeInner(null).inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		const result = await wrapped!.getSuggestions(["/"], 0, 1, OPTIONS);
		assert.ok(result);
		const values = result.items.map((item) => item.value);
		assert.ok(!values.includes("mcp__internal__secret"));
		assert.ok(!values.includes("bash"));
	});

	it("returns the inner suggestions unchanged for paths and command arguments", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		const { inner } = fakeInner([{ value: "cd", label: "cd", description: "Change directory" }]);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);

		for (const text of ["src/main.ts", "/cd /tmp", "/a b"]) {
			const result = await wrapped!.getSuggestions([text], 0, text.length, OPTIONS);
			assert.deepEqual(
				result?.items.map((item) => item.value),
				["cd"],
				`expected inner-only suggestions for "${text}"`,
			);
		}
	});

	it("falls back to MCP-only suggestions when the inner provider has none", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(fakeInner(null).inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		const result = await wrapped!.getSuggestions(["/github"], 0, 7, OPTIONS);
		assert.ok(result);
		assert.deepEqual(
			result.items.map((item) => item.value),
			["mcp__github__create_issue", "mcp__github__search_repos"],
		);
	});

	it("delegates applyCompletion to the inner provider", async () => {
		const { pi, handlers } = fakePi(TOOLS);
		const { inner, applied } = fakeInner(null);
		let wrapped: AutocompleteProvider | undefined;
		const ctx = {
			ui: {
				addAutocompleteProvider: (wrap: (provider: AutocompleteProvider) => AutocompleteProvider) => {
					wrapped = wrap(inner);
				},
			},
		};
		registerMcpAutocomplete(pi);
		handlers.get("session_start")!({} as never, ctx);
		const lines = ["/"];
		const result = wrapped!.applyCompletion(
			lines,
			0,
			1,
			{ value: "mcp__github__create_issue", label: "mcp__github__create_issue" },
			"/",
		);
		assert.deepEqual(applied, [
			[lines, 0, 1, { value: "mcp__github__create_issue", label: "mcp__github__create_issue" }, "/"],
		]);
		assert.deepEqual(result, { lines, cursorLine: 0, cursorCol: 1 });
	});
});
