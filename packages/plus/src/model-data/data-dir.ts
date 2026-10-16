/**
 * Shared helpers for the fork-side reconcilers that edit the generated model
 * data under `packages/ai/src/providers/data/`.
 *
 * Every helper mirrors `packages/ai/scripts/model-data.ts` (the upstream
 * generator-side code) exactly, because `npm run check:model-data` validates
 * the data directory against those same hashes. Keeping the data
 * self-consistent is what lets the reconcilers stay invisible to core.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 6;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

const MODEL_DATA_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_CLASSIFIER_MODELS, [A-Z][A-Z0-9_]*_IMAGE_MODELS, [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Mirrors `modelDataStructureHash` in packages/ai/scripts/model-data.ts. */
export function modelDataStructureHash(structure: Record<string, Record<string, string>>): string {
	const normalized = sortedRecord(
		Object.entries(structure).map(([provider, models]) => [provider, sortedRecord(Object.entries(models))]),
	);
	return sha256Hex(JSON.stringify(normalized));
}

export function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const aggregator = readFileSync(aggregatorPath, "utf8");
	const providerIds = Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1]).sort();
	if (providerIds.length === 0) throw new Error(`No generated provider imports found in ${aggregatorPath}`);
	return providerIds;
}

export function readDataGroups(path: string): Record<string, Record<string, unknown>> {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	const groups: Record<string, Record<string, unknown>> = {};
	for (const [api, value] of Object.entries(parsed)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		}
		groups[api] = value as Record<string, unknown>;
	}
	return groups;
}

/** Re-serializes `value` with the same JSON style and trailing newline as `reference`. */
export function serializeLike(value: unknown, reference: string): string {
	const indent = reference.match(/^{\n(\s+)"/m)?.[1]?.length ?? 2;
	return `${JSON.stringify(value, null, indent)}\n`;
}

/**
 * Recomputes the hashes of `providerIds` in `<dataDir>/.manifest.json` so the
 * edited data files stay valid for `npm run check:model-data`. The manifest
 * layout (schemaVersion, generatedAt, structureHash, sorted file hashes)
 * mirrors `createModelDataManifest` in packages/ai/scripts/model-data.ts.
 */
export function refreshModelDataManifest(packageRoot: string, providerIds: readonly string[]): void {
	const dataDir = join(packageRoot, "src", "providers", "data");
	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		schemaVersion: number;
		generatedAt: string;
		structureHash: string;
		files: Record<string, string>;
	};

	const structure: Record<string, Record<string, string>> = {};
	for (const providerId of readModelDataProviderIds(packageRoot)) {
		const file = join(dataDir, `${providerId}.json`);
		if (!existsSync(file)) continue;
		const content = readFileSync(file, "utf8");
		const models: Record<string, string> = {};
		for (const [api, group] of Object.entries(readDataGroups(file))) {
			for (const modelKey of Object.keys(group)) models[modelKey] = api;
		}
		structure[providerId] = models;
		if (providerIds.includes(providerId)) manifest.files[`${providerId}.json`] = sha256Hex(content);
	}

	manifest.structureHash = modelDataStructureHash(structure);
	manifest.files = sortedRecord(Object.entries(manifest.files));
	writeFileSync(manifestPath, serializeLike(manifest, readFileSync(manifestPath, "utf8")));
}

/** Provider data files that exist under `<packageRoot>/src/providers/data`. */
export function listProviderDataFiles(packageRoot: string): string[] {
	const dataDir = join(packageRoot, "src", "providers", "data");
	if (!existsSync(dataDir)) return [];
	return readdirSync(dataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.map((entry) => join(dataDir, entry))
		.sort();
}
