/**
 * pi-plus-mcp-autocomplete: list MCP tools in the "/" completion menu.
 *
 * Typing "/" in the TUI editor opens the slash-command completion. This
 * extension wraps the autocomplete provider so MCP tools (mcp__<server>__<tool>)
 * are listed there too: picking one inserts `/mcp__<server>__<tool> `, which
 * matches no registered slash command, so on submit it reaches the model as a
 * regular prompt and tells the agent which MCP tool to use. Tool names are
 * read live from pi.getAllTools() on every query, so servers that connect
 * after startup appear without a /reload; hidden tools stay excluded.
 */

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolInfo } from "../../../../coding-agent/src/core/extensions/types.ts";
import { isMcpToolName } from "../../../../coding-agent/src/core/mcp-servers.ts";

export function registerMcpAutocomplete(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// No-op UI contexts (print/SDK hosts) ignore addAutocompleteProvider.
		ctx.ui.addAutocompleteProvider((provider) => new McpAutocompleteProvider(provider, () => pi.getAllTools()));
	});
}

class McpAutocompleteProvider implements AutocompleteProvider {
	private readonly inner: AutocompleteProvider;
	private readonly getTools: () => ToolInfo[];

	constructor(inner: AutocompleteProvider, getTools: () => ToolInfo[]) {
		this.inner = inner;
		this.getTools = getTools;
	}

	get triggerCharacters(): string[] | undefined {
		return this.inner.triggerCharacters;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const inner = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		const commandText = lines[cursorLine].slice(0, cursorCol).trimStart();
		// Only augment bare slash-command names ("/git"), not file paths
		// ("src/main.ts") or command arguments ("/cd /path").
		if (!commandText.startsWith("/") || commandText.slice(1).includes("/") || commandText.includes(" ")) {
			return inner;
		}
		const mcpItems = this.mcpItems(commandText.slice(1));
		if (mcpItems.length === 0) return inner;
		if (!inner) return { items: mcpItems, prefix: commandText };
		return { items: [...inner.items, ...mcpItems], prefix: inner.prefix };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		// MCP items carry the same shape as slash-command items, so the inner
		// provider's slash insertion (`/<value> `) applies unchanged.
		return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	private mcpItems(query: string): AutocompleteItem[] {
		const tools = fuzzyFilter(
			this.getTools().filter((tool) => isMcpToolName(tool.name) && tool.exposure !== "hidden"),
			query,
			(tool) => tool.name,
		);
		return tools.map((tool) => ({ value: tool.name, label: tool.name, description: tool.description }));
	}
}
