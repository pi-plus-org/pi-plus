/**
 * Model-data sanitizer for the fork build flow (wired into the root
 * `build`, `build:offline`, and `check` scripts).
 *
 * `packages/ai` regenerates `src/providers/data/*.json` from the models.dev
 * catalog on every network build. When the catalog gains a model whose API the
 * hand-written provider factory does not implement — e.g. OpenCode Go picking
 * up a `@ai-sdk/google` model while `opencode-go.ts` declares only
 * anthropic-messages / openai-completions / openai-responses — upstream's own
 * `tsc` fails on that factory's `models: Object.values(...)` line, and the
 * Override Policy keeps upstream packages pristine, so the fix cannot land in
 * `packages/ai`. The data files are generated artifacts (gitignored), not
 * source, so the fork-side fix is: strip API groups the provider factory
 * cannot type-check and rewrite the `.manifest.json` hashes to match (the
 * upstream validator cross-checks file hashes, a structure hash, and the JSON
 * contents — all against the data directory itself, so a consistent rewrite
 * passes cleanly).
 *
 * A provider "implements" an API when its factory source mentions the API id
 * as a quoted string literal — either as a key in the inline `api: { ... }` /
 * `classifiers: { ... }` map or inside the `Provider<"...">` return-type
 * annotation. This is deliberately generous: once upstream widens the provider
 * (or we sync such a fix), the literal appears and the sanitizer becomes a
 * no-op without any change here. A false "supported" verdict only restores the
 * status quo (tsc complains and the loud build error points at the factory);
 * a false "unsupported" verdict would silently drop models, so an absent or
 * unreadable factory file leaves the data untouched and only warns.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

const PROVIDER_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_CLASSIFIER_MODELS, [A-Z][A-Z0-9_]*_IMAGE_MODELS, [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

const QUOTED_LITERAL_PATTERN = /"([^"\n]*)"/g;

export interface UnsupportedApiGroup {
	api: string;
	modelKeys: string[];
}

export interface ProviderSanitization extends UnsupportedApiGroup {
	provider: string;
}

export interface SanitizeModelDataResult {
	removed: ProviderSanitization[];
	warnings: string[];
}

/** All double-quoted string literals in a TypeScript source (biome style). */
export function quotedStringLiterals(source: string): Set<string> {
	const literals = new Set<string>();
	for (const match of source.matchAll(QUOTED_LITERAL_PATTERN)) literals.add(match[1]);
	return literals;
}

/** API groups present in the generated data but never named in the factory. */
export function findUnsupportedApiGroups(
	dataGroups: Record<string, Record<string, unknown>>,
	factorySource: string,
): UnsupportedApiGroup[] {
	const literals = quotedStringLiterals(factorySource);
	const unsupported: UnsupportedApiGroup[] = [];
	for (const [api, models] of Object.entries(dataGroups)) {
		if (!literals.has(api)) unsupported.push({ api, modelKeys: Object.keys(models) });
	}
	return unsupported;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Mirrors `modelDataStructureHash` in packages/ai/scripts/model-data.ts. */
export function modelDataStructureHash(structure: Record<string, Record<string, string>>): string {
	const normalized = sortedRecord(
		Object.entries(structure).map(
			([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
		),
	);
	return sha256Hex(JSON.stringify(normalized));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDataGroups(path: string, providerId: string): Record<string, Record<string, unknown>> {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`${providerId}: model data file is not a JSON object: ${path}`);
	const groups: Record<string, Record<string, unknown>> = {};
	for (const [api, value] of Object.entries(parsed)) {
		if (!isRecord(value)) throw new Error(`${providerId}: API group ${JSON.stringify(api)} is not an object`);
		groups[api] = value;
	}
	return groups;
}

/** Re-serialize matching the generator's style (compact, or 2-space when the file is pretty). */
function serializeLike(original: string, value: unknown): string {
	const pretty = `${JSON.stringify(value, null, 2)}\n`;
	if (original === pretty) return pretty;
	return `${JSON.stringify(value)}\n`;
}

/**
 * Provider ids exactly as the upstream validator derives them: by parsing the
 * aggregator's per-provider three-name import lines in src/models.generated.ts.
 */
function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const aggregator = readFileSync(aggregatorPath, "utf8");
	return Array.from(aggregator.matchAll(PROVIDER_IMPORT_PATTERN), (match) => match[1]).sort();
}

/**
 * Strip API groups the provider factories do not implement from the generated
 * model data under `packageRoot` (a packages/ai root), then rewrite the
 * manifest hashes so `check:model-data` stays self-consistent. No-op when
 * nothing is unsupported; returns the removals and warnings for the caller to
 * report.
 */
export function sanitizeModelData(packageRoot: string): SanitizeModelDataResult {
	const warnings: string[] = [];
	const removed: ProviderSanitization[] = [];
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	if (!existsSync(dataDir) || !existsSync(join(packageRoot, "src", "models.generated.ts"))) {
		warnings.push(`no generated model data under ${dataDir}; run npm run hydrate:model-data`);
		return { removed, warnings };
	}

	const providerIds = readModelDataProviderIds(packageRoot);
	for (const providerId of providerIds) {
		const dataPath = join(dataDir, `${providerId}.json`);
		if (!existsSync(dataPath)) continue; // the upstream validator reports missing files
		const factoryPath = join(providersDir, `${providerId}.ts`);
		if (!existsSync(factoryPath)) {
			warnings.push(`${providerId}: provider factory not found at ${factoryPath}; leaving data untouched`);
			continue;
		}

		const original = readFileSync(dataPath, "utf8");
		const groups = readDataGroups(dataPath, providerId);
		const unsupported = findUnsupportedApiGroups(groups, readFileSync(factoryPath, "utf8"));
		if (unsupported.length === 0) continue;
		for (const group of unsupported) {
			delete groups[group.api];
			removed.push({ provider: providerId, api: group.api, modelKeys: group.modelKeys });
		}
		if (Object.keys(groups).length === 0) {
			throw new Error(
				`${providerId}: every API group in its generated model data (${unsupported.map((g) => g.api).join(", ")}) ` +
					`is unsupported by the provider factory — refusing to empty the data file. ` +
					"Either the factory needs the API (upstream fix) or the catalog entry is wrong.",
			);
		}
		writeFileSync(dataPath, serializeLike(original, groups));
	}

	if (removed.length === 0) return { removed, warnings };

	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	if (!existsSync(manifestPath)) {
		warnings.push("model data changed but no .manifest.json exists; run npm run hydrate:model-data");
		return { removed, warnings };
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!isRecord(manifest) || !isRecord(manifest.files))
		throw new Error(`unreadable model data manifest: ${manifestPath}`);

	// Rebuild the manifest from the on-disk data so it is self-consistent:
	// keep schemaVersion/generatedAt, recompute the structure hash and every
	// file hash (validation compares both against the data directory).
	const structure: Record<string, Record<string, string>> = {};
	const fileHashes: Record<string, string> = {};
	for (const providerId of providerIds) {
		const dataPath = join(dataDir, `${providerId}.json`);
		if (!existsSync(dataPath)) continue;
		const content = readFileSync(dataPath, "utf8");
		fileHashes[`${providerId}.json`] = sha256Hex(content);
		const models: Record<string, string> = {};
		for (const [api, group] of Object.entries(readDataGroups(dataPath, providerId))) {
			for (const modelKey of Object.keys(group)) models[modelKey] = api;
		}
		structure[providerId] = models;
	}
	manifest.structureHash = modelDataStructureHash(structure);
	manifest.files = sortedRecord(Object.entries(fileHashes));
	writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
	return { removed, warnings };
}
