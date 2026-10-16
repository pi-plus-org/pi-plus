/**
 * Fork-side sanitizer for the generated model data under
 * `packages/ai/src/providers/data/`.
 *
 * The upstream generator (`packages/ai/scripts/generate-models.ts`) builds the
 * data shards straight from the live models.dev catalog, so a brand-new API
 * group can appear in the data before a provider factory knows how to type
 * it. The generated provider shard then widens the provider's `models.api`
 * union and `tsc --noEmit` fails inside `packages/ai/src/providers/<p>.ts`.
 *
 * The fork-side fix is: drop every API group in `<provider>.json` that the
 * tracked factory file does not mention as a string literal, and rewrite the
 * manifest hashes to match.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	listProviderDataFiles,
	MODEL_DATA_MANIFEST_FILE,
	readDataGroups,
	refreshModelDataManifest,
	serializeLike,
} from "./data-dir.ts";

export { MODEL_DATA_MANIFEST_FILE, modelDataStructureHash, sha256Hex } from "./data-dir.ts";

export interface SanitizedModel {
	provider: string;
	api: string;
	/** Data-file keys (e.g. `chat:gemini-3-flash`) that were dropped. */
	modelKeys: string[];
}

export interface SanitizeResult {
	removed: SanitizedModel[];
	warnings: string[];
}

const PROVIDER_FACTORY_PATH = (packageRoot: string, providerId: string): string =>
	join(packageRoot, "src", "providers", `${providerId}.ts`);

/**
 * Collects double-quoted string literals in `source`. Deliberately generous:
 * a mention anywhere in the factory - including the `Provider<...>` return
 * type and the api/classifiers maps - counts as support.
 */
export function quotedStringLiterals(source: string): Set<string> {
	const literals = new Set<string>();
	const pattern = /"([^"\\\r\n]*)"/g;
	for (const match of source.matchAll(pattern)) literals.add(match[1]);
	return literals;
}

/**
 * Strips unsupported API groups from every generated provider data file and
 * keeps the manifest self-consistent. No-op when nothing is unsupported.
 */
export function sanitizeModelData(packageRoot: string): SanitizeResult {
	const result: SanitizeResult = { removed: [], warnings: [] };
	const dataDir = join(packageRoot, "src", "providers", "data");
	if (!existsSync(dataDir)) {
		result.warnings.push(`no generated model data under ${dataDir}; run npm run hydrate:model-data`);
		return result;
	}

	const files = listProviderDataFiles(packageRoot);
	if (files.length === 0) {
		result.warnings.push(`no generated model data under ${dataDir}; run npm run hydrate:model-data`);
		return result;
	}

	const touched = new Set<string>();
	for (const file of files) {
		const providerId = file.slice(dataDir.length + 1, -".json".length);
		const factoryPath = PROVIDER_FACTORY_PATH(packageRoot, providerId);
		if (!existsSync(factoryPath)) {
			result.warnings.push(`${providerId}: provider factory not found, data left untouched`);
			continue;
		}
		const supported = quotedStringLiterals(readFileSync(factoryPath, "utf8"));

		const groups = readDataGroups(file);
		let changed = false;
		for (const [api, group] of Object.entries(groups)) {
			if (supported.has(api)) continue;
			const modelKeys = Object.keys(group).sort();
			if (modelKeys.length === 0) continue;
			delete groups[api];
			changed = true;
			result.removed.push({ provider: providerId, api, modelKeys });
		}

		if (!changed) continue;
		if (Object.keys(groups).length === 0) {
			throw new Error(`sanitize-model-data: refusing to empty the data file: ${providerId}.json`);
		}
		const content = readFileSync(file, "utf8");
		writeFileSync(file, serializeLike(groups, content));
		touched.add(providerId);
	}

	if (touched.size > 0) {
		if (!existsSync(join(dataDir, MODEL_DATA_MANIFEST_FILE))) {
			result.warnings.push("model data changed but no .manifest.json exists; run npm run hydrate:model-data");
		} else {
			refreshModelDataManifest(packageRoot, Array.from(touched));
		}
	}
	return result;
}
