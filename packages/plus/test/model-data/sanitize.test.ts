/**
 * Tests for plus/src/model-data/sanitize.ts — the generated model-data
 * sanitizer that strips API groups upstream provider factories cannot
 * type-check (e.g. the OpenCode Go google-generative-ai breakage).
 * Fixtures mimic the packages/ai layout the upstream validator reads:
 * src/models.generated.ts aggregator + src/providers/data/*.json + manifest.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	MODEL_DATA_MANIFEST_FILE,
	modelDataStructureHash,
	quotedStringLiterals,
	sanitizeModelData,
	sha256Hex,
} from "../../src/model-data/sanitize.ts";

interface FixtureProvider {
	id: string;
	factory: string;
	groups: Record<string, Record<string, unknown>>;
}

interface FixtureManifest {
	schemaVersion: number;
	generatedAt: string;
	structureHash: string;
	files: Record<string, string>;
}

const CHAT_MODEL = { id: "a", name: "A", api: "x", provider: "p", input: ["text"], cost: {} };

const MAP_FACTORY = `export function pProvider(): Provider<"x-api" | "y-api"> {
	return createProvider({
		id: "p",
		models: Object.values(P_MODELS),
		api: {
			"x-api": xApi(),
			"y-api": yApi(),
		},
	});
}
`;

function aggregatorLine(providerId: string): string {
	const base = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return `import { ${base}_CLASSIFIER_MODELS, ${base}_IMAGE_MODELS, ${base}_MODELS } from "./providers/${providerId}.models.ts";\n`;
}

/** Builds a fake packages/ai root with a self-consistent data directory. */
function makeFixture(providers: FixtureProvider[]): string {
	const root = mkdtempSync(join(tmpdir(), "plus-sanitize-"));
	const providersDir = join(root, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	let aggregator = "";
	const fileHashes: Record<string, string> = {};
	const structure: Record<string, Record<string, string>> = {};
	for (const provider of providers) {
		aggregator += aggregatorLine(provider.id);
		writeFileSync(join(providersDir, `${provider.id}.ts`), provider.factory);
		const content = `${JSON.stringify(provider.groups)}\n`;
		writeFileSync(join(dataDir, `${provider.id}.json`), content);
		fileHashes[`${provider.id}.json`] = sha256Hex(content);
		structure[provider.id] = modelApiMap(provider.groups);
	}
	writeFileSync(join(root, "src", "models.generated.ts"), aggregator);
	const manifest: FixtureManifest = {
		schemaVersion: 6,
		generatedAt: "2026-10-14T00:00:00.000Z",
		structureHash: modelDataStructureHash(structure),
		files: fileHashes,
	};
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
	return root;
}

function modelApiMap(groups: Record<string, Record<string, unknown>>): Record<string, string> {
	const models: Record<string, string> = {};
	for (const [api, group] of Object.entries(groups)) {
		for (const modelKey of Object.keys(group)) models[modelKey] = api;
	}
	return models;
}

function dataDirOf(root: string): string {
	return join(root, "src", "providers", "data");
}

function readGroups(root: string, provider: string): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(join(dataDirOf(root), `${provider}.json`), "utf8"));
}

function readManifest(root: string): FixtureManifest {
	return JSON.parse(readFileSync(join(dataDirOf(root), MODEL_DATA_MANIFEST_FILE), "utf8"));
}

describe("quotedStringLiterals", () => {
	it("collects double-quoted literals, deliberately generously", () => {
		// A quoted mention anywhere in the factory — even inside a comment — counts
		// as support. A false keep only restores the previous (loudly broken) tsc
		// state; a false strip would silently drop models, so err toward keeping.
		const literals = quotedStringLiterals(`const a = "x-api"; // note the "y-api"\nimport b from "./z.lazy.ts";`);
		assert.ok(literals.has("x-api"));
		assert.ok(literals.has("y-api"));
		assert.ok(!literals.has("z-api"));
	});
});

describe("sanitizeModelData", () => {
	it("strips an unsupported API group and rewrites the manifest consistently", () => {
		const root = makeFixture([
			{
				id: "p",
				factory: MAP_FACTORY,
				groups: {
					"x-api": { "chat:a": CHAT_MODEL },
					"z-api": { "chat:b": { ...CHAT_MODEL, api: "z-api" } },
				},
			},
			{
				id: "other",
				factory: `export function otherProvider(): Provider<"x-api"> { return createProvider({ id: "other", api: xApi() }); }`,
				groups: { "x-api": { "chat:c": { ...CHAT_MODEL, provider: "other" } } },
			},
		]);
		const result = sanitizeModelData(root);
		assert.equal(result.removed.length, 1);
		assert.equal(result.removed[0].provider, "p");
		assert.equal(result.removed[0].api, "z-api");
		assert.deepEqual(result.removed[0].modelKeys, ["chat:b"]);
		assert.deepEqual(result.warnings, []);

		const stripped = readGroups(root, "p");
		assert.deepEqual(Object.keys(stripped), ["x-api"]);

		// The manifest must be self-consistent with the on-disk data, exactly
		// the way the upstream validator computes it.
		const manifest = readManifest(root);
		assert.equal(manifest.schemaVersion, 6);
		assert.equal(manifest.generatedAt, "2026-10-14T00:00:00.000Z");
		for (const provider of ["other", "p"]) {
			const content = readFileSync(join(dataDirOf(root), `${provider}.json`), "utf8");
			assert.equal(manifest.files[`${provider}.json`], sha256Hex(content));
		}
		const rebuilt: Record<string, Record<string, string>> = {
			other: modelApiMap(readGroups(root, "other")),
			p: modelApiMap(stripped),
		};
		assert.equal(manifest.structureHash, modelDataStructureHash(rebuilt));
	});

	it("keeps APIs referenced only in the Provider<> return type (single-API factories)", () => {
		const root = makeFixture([
			{
				id: "g",
				factory: `export function gProvider(): Provider<"google-generative-ai"> {
	return createProvider({ id: "g", api: googleGenerativeAIApi() });
}`,
				groups: { "google-generative-ai": { "chat:a": CHAT_MODEL } },
			},
		]);
		assert.equal(sanitizeModelData(root).removed.length, 0);
	});

	it("keeps classifier APIs named in the classifiers map", () => {
		const root = makeFixture([
			{
				id: "t",
				factory: `export function tProvider(): Provider {
	return createProvider({ id: "t", classifiers: { "typesafe-system-one": typesafeSystemOneApi() } });
}`,
				groups: { "typesafe-system-one": { "classifier:a": { ...CHAT_MODEL, type: "classifier" } } },
			},
		]);
		assert.equal(sanitizeModelData(root).removed.length, 0);
	});

	it("leaves data untouched and warns when the factory file is missing", () => {
		const root = makeFixture([{ id: "p", factory: MAP_FACTORY, groups: { "x-api": { "chat:a": CHAT_MODEL } } }]);
		const before = readFileSync(join(dataDirOf(root), "p.json"), "utf8");
		const manifestBefore = readFileSync(join(dataDirOf(root), MODEL_DATA_MANIFEST_FILE), "utf8");
		rmSync(join(root, "src", "providers", "p.ts"));
		const result = sanitizeModelData(root);
		assert.equal(result.removed.length, 0);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /provider factory not found/);
		assert.equal(readFileSync(join(dataDirOf(root), "p.json"), "utf8"), before);
		assert.equal(readFileSync(join(dataDirOf(root), MODEL_DATA_MANIFEST_FILE), "utf8"), manifestBefore);
	});

	it("throws instead of emptying a provider data file", () => {
		const root = makeFixture([
			{
				id: "p",
				factory: MAP_FACTORY,
				groups: { "z-api": { "chat:b": CHAT_MODEL } },
			},
		]);
		assert.throws(() => sanitizeModelData(root), /refusing to empty the data file/);
	});

	it("is a byte-for-byte no-op when everything is supported", () => {
		const root = makeFixture([
			{
				id: "p",
				factory: MAP_FACTORY,
				groups: { "x-api": { "chat:a": CHAT_MODEL }, "y-api": { "chat:b": CHAT_MODEL } },
			},
		]);
		const before = {
			data: readFileSync(join(dataDirOf(root), "p.json"), "utf8"),
			manifest: readFileSync(join(dataDirOf(root), MODEL_DATA_MANIFEST_FILE), "utf8"),
		};
		const result = sanitizeModelData(root);
		assert.equal(result.removed.length, 0);
		assert.deepEqual(result.warnings, []);
		assert.equal(readFileSync(join(dataDirOf(root), "p.json"), "utf8"), before.data);
		assert.equal(readFileSync(join(dataDirOf(root), MODEL_DATA_MANIFEST_FILE), "utf8"), before.manifest);
	});

	it("reports missing generated data without creating files", () => {
		const root = mkdtempSync(join(tmpdir(), "plus-sanitize-empty-"));
		const result = sanitizeModelData(root);
		assert.equal(result.removed.length, 0);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /no generated model data/);
	});
});
