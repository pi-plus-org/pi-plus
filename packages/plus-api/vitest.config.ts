import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

// Source-aliasing as in the other workspace packages (@earendil-works/* ->
// packages/*/src), plus one pi-plus redirect: @earendil-works/pi-agent-core
// resolves to the plus Agent wrapper (abort guard, effort model) instead of the
// upstream agent barrel — the test-time mirror of the loader redirect for
// packages/agent/src/agent.ts in the pipi and pi-plus-sdk bundles. Without it
// the SDK tests would exercise the upstream Agent and silently miss plus
// behavior that shipping hosts (bundled through the redirect table) do get.
const merged = mergeConfig(
	base,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30000,
			include: ["test/**/*.test.ts"],
		},
		resolve: { conditions: ["source"] },
		ssr: { resolve: { conditions: ["source"] } },
	}),
);

// mergeConfig concatenates alias arrays base-first, and vite takes the FIRST
// matching alias entry — so the plus redirect must be reordered ahead of
// base's pi-agent-core entry after the merge.
const agentCoreAlias = /^@earendil-works\/pi-agent-core$/;
merged.resolve.alias = [
	{
		find: agentCoreAlias,
		replacement: fileURLToPath(new URL("../plus/src/agent/index.ts", import.meta.url)),
	},
	...(Array.isArray(merged.resolve.alias)
		? merged.resolve.alias.filter((entry) => String((entry as { find: unknown }).find) !== String(agentCoreAlias))
		: []),
];

export default merged;
