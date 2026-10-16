/**
 * Fork-side restorer for chat models that upstream code still references but
 * the live catalog has stopped listing.
 *
 * `npm run generate:model-data` builds `packages/ai/src/providers/data/*.json`
 * from the live models.dev catalog and skips every model whose status is
 * `deprecated`. The upstream `packages/ai` test files are tracked, so when
 * models.dev retires a model they keep calling `getModel("<provider>",
 * "<retired id>")` and `tsc --noEmit` fails with TS2345 inside a core package
 * this fork may not edit. The type-level model ids of a provider come straight
 * from the keys of its generated data file, so the fix is to put those entries
 * back on the data side.
 *
 * Entries are rebuilt from a live sibling model in the same provider/API
 * group: the sibling carries the fields the generator derives from provider
 * configuration (`baseUrl`, `compat`, `thinkingLevelMap`), and the retired
 * model below only carries the catalog facts models.dev still reports for it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDataGroups, refreshModelDataManifest, serializeLike } from "./data-dir.ts";

export interface RetiredChatModel {
	/** Provider id, i.e. the `<provider>.json` data file. */
	provider: string;
	/** API group the entry belongs to. */
	api: string;
	/** Retired model id to restore. */
	id: string;
	/**
	 * Live model in the same provider/API group whose generator-emitted
	 * provider-level fields are copied onto the restored entry.
	 */
	templateId: string;
	name: string;
	reasoning: boolean;
	/** Input modalities reported by the catalog for the retired model. */
	input: readonly ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Why core still references this model. */
	reason: string;
}

/**
 * Models.dev `status: "deprecated"` chat models that tracked core sources and
 * tests still resolve with `getModel(provider, id)`.
 */
export const RETIRED_CHAT_MODELS: readonly RetiredChatModel[] = [
	{
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
		reason: "referenced by packages/ai tests (abort, stream, empty, tokens, ...)",
	},
	{
		provider: "xiaomi-token-plan-cn",
		api: "openai-completions",
		id: "mimo-v2.5-pro",
		templateId: "mimo-v2.6-pro",
		name: "MiMo-V2.5-Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		reason: "referenced by packages/ai tests (abort, stream, empty, tokens, ...)",
	},
	{
		provider: "xiaomi-token-plan-ams",
		api: "openai-completions",
		id: "mimo-v2.5-pro",
		templateId: "mimo-v2.6-pro",
		name: "MiMo-V2.5-Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		reason: "referenced by packages/ai tests (abort, stream, empty, tokens, ...)",
	},
	{
		provider: "xiaomi-token-plan-sgp",
		api: "openai-completions",
		id: "mimo-v2.5-pro",
		templateId: "mimo-v2.6-pro",
		name: "MiMo-V2.5-Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		reason: "referenced by packages/ai tests (abort, stream, empty, tokens, ...)",
	},
];

export interface RetiredRestoreResult {
	/** Restored `provider/api/modelKey` tuples. */
	restored: { provider: string; api: string; modelKey: string }[];
	warnings: string[];
}

/** Builds the restored entry on top of the live sibling's provider-level fields. */
function buildEntry(template: Record<string, unknown>, model: RetiredChatModel): Record<string, unknown> {
	const entry: Record<string, unknown> = {
		...template,
		// The upstream validator requires `type` to match the data key prefix.
		type: "chat",
		id: model.id,
		api: model.api,
		provider: model.provider,
		name: model.name,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: { ...model.cost },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	// Image input limits come from the template and do not apply to a text-only model.
	if (!model.input.includes("image")) delete entry.inputLimits;
	if (!model.reasoning) delete entry.thinkingLevelMap;
	return entry;
}

/**
 * Adds the retired chat models core still references back into the generated
 * data files. Models whose entry the catalog still publishes, whose provider
 * file or API group is gone, or whose template is missing are left alone (the
 * last two are reported as warnings instead of guessing a shape).
 */
export function restoreRetiredModels(
	packageRoot: string,
	models: readonly RetiredChatModel[] = RETIRED_CHAT_MODELS,
): RetiredRestoreResult {
	const result: RetiredRestoreResult = { restored: [], warnings: [] };
	const dataDir = join(packageRoot, "src", "providers", "data");
	const touched = new Set<string>();

	for (const model of models) {
		const file = join(dataDir, `${model.provider}.json`);
		if (!existsSync(file)) {
			result.warnings.push(`${model.provider}/${model.id}: no generated data file, skipped`);
			continue;
		}

		const groups = readDataGroups(file);
		const group = groups[model.api];
		if (!group) {
			result.warnings.push(
				`${model.provider}/${model.id}: API group "${model.api}" is not in the generated data, skipped`,
			);
			continue;
		}

		const modelKey = `chat:${model.id}`;
		if (group[modelKey]) continue; // still listed by the catalog, nothing to restore

		const template = group[`chat:${model.templateId}`];
		if (typeof template !== "object" || template === null || Array.isArray(template)) {
			result.warnings.push(`${model.provider}/${model.id}: template chat:${model.templateId} is missing, skipped`);
			continue;
		}

		group[modelKey] = buildEntry(template as Record<string, unknown>, model);
		const content = readFileSync(file, "utf8");
		writeFileSync(file, serializeLike({ ...groups }, content));
		touched.add(model.provider);
		result.restored.push({ provider: model.provider, api: model.api, modelKey });
	}

	if (touched.size > 0) refreshModelDataManifest(packageRoot, Array.from(touched));
	return result;
}
