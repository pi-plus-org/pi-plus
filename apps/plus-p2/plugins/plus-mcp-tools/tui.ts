// Facet contributing the "plus-mcp-tools" slash source to p2's TUI: the session's MCP tools
// appear in slash autocomplete as `mcp__<server>__<tool>` entries (names carry no slash, like
// core commands'). The expand hook leaves the text unchanged, so submitting `/mcp__...` sends
// it as a plain prompt. Global plugin: host-scope `defineFacet` (plugin-loading.md §8).
import {
  BACKGROUND_CONTEXT,
  contribute,
  defineFacet,
  liveWith,
} from "@p2/app/v1";
import { type TuiSlashSource, TuiSlashSources } from "@p2/app/v1/tui";
import { MCP_TOOLS_PARTICIPANT, McpTools } from "./contract.ts";

export default defineFacet((host) => {
  contribute(host, "plus-mcp-tools-tui", (self) => {
    self.contribute(TuiSlashSources, { "plus-mcp-tools": slashSource });
  });
});

const slashSource: TuiSlashSource = {
  entries(ctx) {
    const session = ctx.identity.session;
    if (session === undefined) return [];
    const held = ctx.host.hold(McpTools, { session }, BACKGROUND_CONTEXT);
    const view = liveWith(held, ...MCP_TOOLS_PARTICIPANT);
    if (!view || view.state.value.kind !== "live") return [];
    return view.tools.value.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  },
  // No expansion: `/mcp__server__tool` submits as a plain prompt.
  expand: (_ctx, _text) => Promise.resolve(undefined),
};
