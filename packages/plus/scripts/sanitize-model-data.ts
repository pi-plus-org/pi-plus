/**
 * Reconciles the generated model data in packages/ai with the tracked core
 * sources, so `npm run check` type-checks regardless of what the live
 * models.dev catalog publishes today.
 *
 * 1. Strip API groups the core provider factories cannot type (a brand-new
 *    upstream API would otherwise break `tsc --noEmit` in packages/ai).
 * 2. Restore chat models the catalog retired (status "deprecated") while
 *    tracked core tests still resolve them by id.
 *
 * Runs after generate-models/hydrate and before tsc (root build/check scripts).
 */
import { restoreRetiredModels } from "../src/model-data/retired.ts";
import { sanitizeModelData } from "../src/model-data/sanitize.ts";

const packageRoot = new URL("../../ai", import.meta.url).pathname;

const sanitized = sanitizeModelData(packageRoot);
const restored = restoreRetiredModels(packageRoot);

for (const warning of [...sanitized.warnings, ...restored.warnings]) {
	console.warn(`sanitize-model-data: warning: ${warning}`);
}

if (sanitized.removed.length === 0 && restored.restored.length === 0) {
	console.log("sanitize-model-data: every generated API group is implemented by its provider factory.");
	process.exit(0);
}

for (const entry of sanitized.removed) {
	console.warn(
		`sanitize-model-data: dropped ${entry.provider}/${entry.api} (${entry.modelKeys.length} models): ` +
			"the factory does not implement this API.",
	);
}
for (const entry of restored.restored) {
	console.warn(
		`sanitize-model-data: restored ${entry.provider}/${entry.modelKey}: the live catalog retired it but core still references it.`,
	);
}
