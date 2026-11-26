import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

// Same source-aliasing as the other workspace packages: @earendil-works/* imports
// resolve to packages/*/src so the plus-cli tests exercise the real upstream modules.
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

// pi-hub's package.json exports point at dist only; alias to source so the
// tests exercise the real module (kept out of the shared vitest.base.ts,
// which stays identical to upstream). vite takes the FIRST matching alias
// entry, so this goes ahead of any base entry.
merged.resolve.alias = [
	{
		find: /^@earendil-works\/pi-hub$/,
		replacement: fileURLToPath(new URL("../hub/src/index.ts", import.meta.url)),
	},
	...(Array.isArray(merged.resolve.alias) ? merged.resolve.alias : []),
];

export default merged;
