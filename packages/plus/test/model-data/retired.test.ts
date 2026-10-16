/**
 * Tests for plus/src/model-data/retired.ts — the restorer that puts chat models
 * back into the generated data after models.dev marks them "deprecated" while
 * tracked packages/ai tests still resolve them by id (TS2345 otherwise).
 * Fixtures mimic the packages/ai layout the upstream validator reads:
 * src/models.generated.ts aggregator + src/providers/data/*.json + manifest.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { MODEL_DATA_MANIFEST_FILE, modelDataStructureHash, sha256Hex } from "../../src/model-data/data-dir.ts";
import { RETIRED_CHAT_MODELS, type RetiredChatModel, restoreRetiredModels } from "../../src/model-data/retired.ts";

const LIVE_MODEL = {
	type: "chat",
	id: "mimo-v2.6-pro",
	name: "MiMo-V2.6-Pro",
	provider: "xiaomi",
	api: "openai-completions",
	baseUrl: "https://api.xiaomimimo.com/v1",
	compat: {
		supportsStrictMode: true,
		supportsReasoningEffort: false,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	},
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" },
	reasoning: true,
	input: ["text", "image"],
	inputLimits: { image: { maxPx: 2000, maxActiveBytes: 4500000, minTokens: 300 } },
	cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 131072,
};

const RETIRED: RetiredChatModel = {
	provider: "xiaomi",
	api: "openai-completions",
	id: "mimo-v2.5-pro",
	templateId: "mimo-v2.6-pro",
	name: "MiMo-V2.5-Pro",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 131072,
	reason: "test fixture",
};

function aggregatorLine(providerId: string): string {
	const base = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return `import { ${base}_CLASSIFIER_MODELS, ${base}_IMAGE_MODELS, ${base}_MODELS } from "./providers/${providerId}.models.ts";\n`;
}

/** Builds a fake packages/ai root whose data lacks the retired model. */
function makeFixture(groups: Record<string, Record<string, unknown>>, provider = "xiaomi"): string {
	const root = mkdtempSync(join(tmpdir(), "plus-retired-"));
	const providersDir = join(root, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(root, "src", "models.generated.ts"), aggregatorLine(provider));

	const content = `${JSON.stringify(groups, null, "\t")}\n`;
	writeFileSync(join(dataDir, `${provider}.json`), content);
	const models: Record<string, string> = {};
	for (const [api, group] of Object.entries(groups)) {
		for (const modelKey of Object.keys(group)) models[modelKey] = api;
	}
	const structure: Record<string, Record<string, string>> = { [provider]: models };
	const manifest = {
		schemaVersion: 6,
		generatedAt: "2026-10-14T00:00:00.000Z",
		structureHash: modelDataStructureHash(structure),
		files: { [`${provider}.json`]: sha256Hex(content) },
	};
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
	return root;
}

function liveOnlyGroups(): Record<string, Record<string, unknown>> {
	return { "openai-completions": { "chat:mimo-v2.6-pro": LIVE_MODEL } };
}

function dataFile(root: string, provider = "xiaomi"): string {
	return join(root, "src", "providers", "data", `${provider}.json`);
}

function readGroups(root: string, provider = "xiaomi"): Record<string, Record<string, any>> {
	return JSON.parse(readFileSync(dataFile(root, provider), "utf8"));
}

function readManifest(root: string): { structureHash: string; files: Record<string, string> } {
	return JSON.parse(readFileSync(join(root, "src", "providers", "data", MODEL_DATA_MANIFEST_FILE), "utf8"));
}

describe("restoreRetiredModels", () => {
	it("restores a retired model from its live sibling and refreshes the manifest", () => {
		const root = makeFixture(liveOnlyGroups());
		const result = restoreRetiredModels(root, [RETIRED]);
		assert.deepEqual(result.restored, [
			{ provider: "xiaomi", api: "openai-completions", modelKey: "chat:mimo-v2.5-pro" },
		]);
		assert.deepEqual(result.warnings, []);

		const entry = readGroups(root)["openai-completions"]["chat:mimo-v2.5-pro"];
		assert.equal(entry.id, "mimo-v2.5-pro");
		assert.equal(entry.name, "MiMo-V2.5-Pro");
		assert.equal(entry.provider, "xiaomi");
		assert.equal(entry.api, "openai-completions");
		// Provider-level fields come from the sibling the generator just emitted.
		assert.equal(entry.baseUrl, LIVE_MODEL.baseUrl);
		assert.deepEqual(entry.compat, LIVE_MODEL.compat);
		assert.deepEqual(entry.thinkingLevelMap, LIVE_MODEL.thinkingLevelMap);
		// Catalog facts come from the retired model itself.
		assert.deepEqual(entry.input, ["text"]);
		assert.deepEqual(entry.cost, RETIRED.cost);
		assert.equal(entry.contextWindow, 1048576);
		assert.equal(entry.maxTokens, 131072);

		// The manifest must stay self-consistent with the on-disk data.
		const manifest = readManifest(root);
		assert.equal(manifest.files["xiaomi.json"], sha256Hex(readFileSync(dataFile(root), "utf8")));
		assert.equal(
			manifest.structureHash,
			modelDataStructureHash({
				xiaomi: { "chat:mimo-v2.5-pro": "openai-completions", "chat:mimo-v2.6-pro": "openai-completions" },
			}),
		);
	});

	it("drops image-only fields when the retired model is text-only", () => {
		const root = makeFixture(liveOnlyGroups());
		restoreRetiredModels(root, [RETIRED]);
		assert.equal(readGroups(root)["openai-completions"]["chat:mimo-v2.5-pro"].inputLimits, undefined);
	});

	it("is a byte-for-byte no-op when the catalog still lists the model", () => {
		const root = makeFixture({
			"openai-completions": { "chat:mimo-v2.6-pro": LIVE_MODEL, "chat:mimo-v2.5-pro": LIVE_MODEL },
		});
		const before = readFileSync(dataFile(root), "utf8");
		const manifestBefore = readFileSync(join(root, "src", "providers", "data", MODEL_DATA_MANIFEST_FILE), "utf8");
		const result = restoreRetiredModels(root, [RETIRED]);
		assert.deepEqual(result.restored, []);
		assert.deepEqual(result.warnings, []);
		assert.equal(readFileSync(dataFile(root), "utf8"), before);
		assert.equal(
			readFileSync(join(root, "src", "providers", "data", MODEL_DATA_MANIFEST_FILE), "utf8"),
			manifestBefore,
		);
	});

	it("skips when the API group is gone from the data", () => {
		const root = makeFixture({ "anthropic-messages": { "chat:mimo-v2.6-pro": LIVE_MODEL } }, "xiaomi");
		const result = restoreRetiredModels(root, [RETIRED]);
		assert.deepEqual(result.restored, []);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /API group "openai-completions" is not in the generated data/);
	});

	it("skips when the sibling template is missing", () => {
		const root = makeFixture({ "openai-completions": { "chat:mimo-v2.6-flash": LIVE_MODEL } });
		const result = restoreRetiredModels(root, [RETIRED]);
		assert.deepEqual(result.restored, []);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /template chat:mimo-v2.6-pro is missing/);
	});

	it("warns without creating files when the provider data is missing", () => {
		const root = mkdtempSync(join(tmpdir(), "plus-retired-empty-"));
		const result = restoreRetiredModels(root, [RETIRED]);
		assert.deepEqual(result.restored, []);
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /no generated data file/);
		assert.equal(existsSync(join(root, "src", "providers", "data", "xiaomi.json")), false);
		assert.equal(existsSync(join(root, "src", "providers", "data", MODEL_DATA_MANIFEST_FILE)), false);
	});

	it("restores every curated retired model given matching provider data", () => {
		for (const model of RETIRED_CHAT_MODELS) {
			const root = makeFixture({ "openai-completions": { "chat:mimo-v2.6-pro": LIVE_MODEL } }, model.provider);
			const result = restoreRetiredModels(root, [model]);
			assert.deepEqual(result.restored, [
				{ provider: model.provider, api: model.api, modelKey: `chat:${model.id}` },
			]);
			assert.deepEqual(result.warnings, []);
			const entry = readGroups(root, model.provider)["openai-completions"][`chat:${model.id}`];
			assert.deepEqual(entry.cost, model.cost);
			assert.deepEqual(entry.input, [...model.input]);
			const manifest = readManifest(root);
			assert.equal(
				manifest.files[`${model.provider}.json`],
				sha256Hex(readFileSync(dataFile(root, model.provider), "utf8")),
			);
			assert.equal(
				manifest.structureHash,
				modelDataStructureHash({
					[model.provider]: {
						"chat:mimo-v2.5-pro": "openai-completions",
						"chat:mimo-v2.6-pro": "openai-completions",
					},
				}),
			);
		}
	});
});

describe("RETIRED_CHAT_MODELS", () => {
	it("only references xiaomi providers that ship mimo v2.6 siblings", () => {
		for (const model of RETIRED_CHAT_MODELS) {
			assert.match(model.provider, /^xiaomi/);
			assert.equal(model.api, "openai-completions");
			assert.equal(model.templateId, "mimo-v2.6-pro");
			assert.equal(model.id, "mimo-v2.5-pro");
		}
		assert.equal(new Set(RETIRED_CHAT_MODELS.map((model) => model.provider)).size, 4);
	});
});
