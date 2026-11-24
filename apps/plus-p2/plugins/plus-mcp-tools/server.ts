// plus-mcp-tools server facet: serves the per-session tool list from the upstream MCP plugin's manager. Cross-plugin
// imports are contract modules only (plugin-loading.md 14.4): the manager handle comes from the mcp plugin's
// contract.ts, never from its server.ts.

import { defineFacet, deriveTyped, type Factory } from "@p2/app/v1";
import { McpManager } from "p2:plugins/mcp/contract.ts";
import { McpTools } from "./contract.ts";

const toolsView: Factory<typeof McpTools> = ({ session }, _principal, self) => {
	const manager = self.get(McpManager, {});
	return {
		variant: "participant",
		members: {
			tools: deriveTyped(self, [manager.instances, manager.leases], ([instances, leases]) => {
				const used = new Set(leases.filter((lease) => lease.session === session).flatMap((lease) => lease.instances));
				return instances
					.filter((instance) => used.has(instance.id) && instance.error === undefined)
					.flatMap((instance) =>
						instance.tools.map((tool) => ({
							server: instance.server,
							name: tool.name,
							description: tool.description,
						})),
					);
			}),
		},
	};
};

export default defineFacet((host) => {
	host.serve(McpTools, toolsView);
});
