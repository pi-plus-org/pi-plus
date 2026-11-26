// Facet serving `plus.mcp-tools` (see contract.ts): per session, the MCP tools its workers
// connected, for the TUI's slash autocomplete. Global plugin (host scope): it holds the mcp
// plugin's manager (host-internal) and derives each session's list from its leases.
import {
  defineFacet,
  deriveTyped,
  grantBy,
  isGuest,
  notGranted,
  type Factory,
} from "@p2/app/v1";
import { McpManager } from "p2:plugins/mcp/contract.ts";
import {
  MCP_TOOLS_PARTICIPANT,
  McpTools,
  type McpToolEntry,
} from "./contract.ts";

export default defineFacet((host) => {
  host.serve(McpTools, FACTORY, {
    admit: grantBy((principal) =>
      isGuest(principal) ? [] : [...MCP_TOOLS_PARTICIPANT],
    ),
  });
});

const FACTORY: Factory<typeof McpTools> = (
  params,
  principal,
  _admitted,
  self,
) => {
  const manager = self.get(McpManager, {});
  return {
    tools: isGuest(principal)
      ? notGranted
      : () =>
          deriveTyped(
            self,
            [manager.instances, manager.leases],
            ([instances, leases]) => {
              const used = new Set<string>();
              for (const lease of leases) {
                if (lease.session !== params.session) continue;
                for (const id of lease.instances) used.add(id);
              }
              const entries: McpToolEntry[] = [];
              for (const instance of instances) {
                if (!used.has(instance.id) || instance.status !== "connected")
                  continue;
                for (const tool of instance.tools) {
                  entries.push({
                    name: `mcp__${instance.server}__${tool.name}`,
                    description: tool.description ?? "",
                    schema: JSON.stringify(tool.inputSchema),
                  });
                }
              }
              return entries.sort((a, b) => a.name.localeCompare(b.name));
            },
          ),
  };
};
