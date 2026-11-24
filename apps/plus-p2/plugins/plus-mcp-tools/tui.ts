// plus-mcp-tools TUI facet: MCP tools in the editor's slash completion. Bare "/" queries list the session's MCP
// tools as mcp__<server>__<tool> names alongside the commands (SlashCompletion merges all TuiSlashSources). Picking
// one inserts "/mcp__server__tool "; it names no command and no expansion, so the composer submits it to the
// session's conversation as typed — a regular prompt telling the agent which MCP tool to use.

import { BACKGROUND_CONTEXT, contribute, defineFacet } from "@p2/app/v1";
import { type TuiSlashSource, TuiSlashSources } from "@p2/app/v1/tui";
import { McpTools, type McpToolEntry } from "./contract.ts";

function toolName(tool: McpToolEntry): string {
	return `mcp__${tool.server}__${tool.name}`;
}

const toolsSlashSource: TuiSlashSource = {
	entries(ctx) {
		if (!ctx.identity.session) return [];
		const held = ctx.host.hold(McpTools, { session: ctx.identity.session }, BACKGROUND_CONTEXT);
		if (held.state.value.kind !== "live") return [];
		return held.tools.value.map((tool) => ({
			name: toolName(tool),
			description: tool.description,
		}));
	},
	// `/mcp__server__tool` names no command or expansion: it submits to the session's conversation as typed.
	async expand(_ctx, text) {
		return text;
	},
};

export default defineFacet((host) =>
	contribute(host, "plus.mcp-tools-tui", (self) => {
		self.contribute(TuiSlashSources, { "plus-mcp-tools": toolsSlashSource });
	}),
);
