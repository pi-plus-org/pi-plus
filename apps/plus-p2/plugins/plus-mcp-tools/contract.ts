// What the "plus.mcp-tools" plugin serves: one instance per session, listing the MCP tools the
// session's workers connected. Fork-owned (the `plus.*` namespace; upstream owns `p2.*`).
// Session participants hold the tools view read-only; there are no methods.
import { arr, obj, str } from "@earendil-works/pi-schema";
import {
  grantable,
  param,
  remote,
  type RefWith,
  sessionHost,
} from "@p2/app/v1";

export const McpToolEntrySchema = obj({
  name: str(),
  description: str(),
  schema: str(),
});
export type McpToolEntry = {
  name: string;
  description: string;
  schema: string;
};

/** Grant: the session participants' view (the only view). */
export const MCP_TOOLS_PARTICIPANT = ["tools"] as const;

export const McpTools = remote("plus.mcp-tools", {
  // 2: grantable members replaced variants (the framework dropped variants; older versions are refused, their pages reload)
  version: 2,
  params: { session: param.str() },
  hostAddress: sessionHost,
  state: {
    /** The MCP tools the session's workers connected, sorted by name. */
    tools: grantable(arr(McpToolEntrySchema)),
  },
  methods: {},
});
export type McpToolsRef = typeof McpTools;
export type McpToolsParticipantView = RefWith<
  typeof McpTools,
  (typeof MCP_TOOLS_PARTICIPANT)[number]
>;
