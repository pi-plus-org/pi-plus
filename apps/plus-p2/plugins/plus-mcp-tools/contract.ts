// plus-mcp-tools contract: the per-session MCP tool list for the TUI's slash completion. The upstream MCP plugin
// owns the manager and its state; this view derives the tools a session's workers lease (the same rule the
// supervisor uses), so completion only offers tools the agent can actually call.

import { arr, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { param, remote, serverHost } from "@p2/app/v1";

/** A callable tool of one of the session's MCP server instances. */
export const McpToolEntrySchema = obj({ server: str(), name: str(), description: opt(str()) });
export type McpToolEntry = Static<typeof McpToolEntrySchema>;

/** The session's MCP tools, derived from the MCP manager's instances and the session's leases. */
export const McpTools = remote("plus.mcp-tools", {
	version: 1,
	params: { session: param.str() },
	hostAddress: serverHost,
	variants: { participant: { state: { tools: arr(McpToolEntrySchema) } } },
});
