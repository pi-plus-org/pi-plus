#!/usr/bin/env node
/**
 * CLI hook for the root build/build:offline/check scripts: strips generated
 * model-data API groups that the upstream provider factories do not implement
 * so packages/ai keeps type-checking. Logic and rationale: src/model-data/sanitize.ts.
 */
import { resolve } from "node:path";
import { sanitizeModelData } from "../src/model-data/sanitize.ts";

const packageRoot = resolve(import.meta.dirname, "../../ai");
const { removed, warnings } = sanitizeModelData(packageRoot);

for (const warning of warnings) console.warn(`sanitize-model-data: warning: ${warning}`);
if (removed.length === 0) {
	console.log("sanitize-model-data: every generated API group is implemented by its provider factory.");
} else {
	for (const entry of removed) {
		console.log(
			`sanitize-model-data: ${entry.provider}: stripped API "${entry.api}" ` +
				`(${entry.modelKeys.length} model(s): ${entry.modelKeys.join(", ")})`,
		);
	}
}
