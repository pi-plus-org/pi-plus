/**
 * Classification of profile model ids pi's catalog does not know into custom
 * model definitions, shared by the pi-plus CLI launch path and the pi-plus-sdk
 * materialization path (packages/plus-api/src/profiles.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { AGENT_DIR, type CustomModel, type ModelEntry, type Profile, profileDirFor } from "@earendil-works/pi-hub";

// --- Automatic custom-model classification --------------------------------
//
// A profile model id that pi's catalog does not know stays unresolvable at
// runtime: session creation silently falls back to another model and the
// model picker shows the specified model as "(unavailable)". Plain ids can
// reach materialization two ways — desktop saves store plain ids, and the CLI
// launch path re-materializes whatever profiles.json holds — so classify here
// at materialization time instead of only when the CLI saves a profile.
// profiles.json keeps the plain ids — only the materialized models.json
// carries the definitions, where pi registers them as regular models of the
// provider (available in the picker and picked as the session model like any
// catalogue model).
//
// pi's own default for a custom model is input: ["text"] (provider-composer
// modelFromJson), which silently drops images the gateway model would accept.
// A model pi's catalog does not know is much more often a full multimodal
// chat model behind a gateway than a text-only one, so unknown models default
// to input: ["text", "image"] here. The per-profile model-input.json file
// (MODEL_INPUT_FILE) overrides that per model id; an explicit `input` on a
// profiles.json definition sits between the two in precedence:
// model-input.json > definition.input > ["text", "image"].
// The override file only covers models pi does not know: for a catalog model,
// a models.json `models` entry would REPLACE the catalog entry (provider-
// composer modelFromJson starts from hard defaults, not the catalog facts),
// so restricting a catalog model's modalities needs pi's modelOverrides
// mechanism, which materialization does not write.

/** Profile-dir file letting the user pin input modalities per unknown model id: { "<model-id>": ["text", "image"] }. */
export const MODEL_INPUT_FILE = "model-input.json";

const DEFAULT_INPUT: ("text" | "image")[] = ["text", "image"];
const INPUT_MODALITIES = new Set<string>(["text", "image"]);

type ModelInput = ("text" | "image")[];

function storeCatalogModelIds(provider: string): string[] {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "models-store.json"), "utf8"));
		if (!raw || typeof raw !== "object") return [];
		const entry = (raw as Record<string, unknown>)[provider];
		if (!entry || typeof entry !== "object") return [];
		const models = (entry as { models?: unknown }).models;
		if (!Array.isArray(models)) return [];
		return models
			.filter(
				(m): m is { id: string } => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
			)
			.map((m) => m.id);
	} catch {
		return [];
	}
}

// User override for the default input modalities, read from the profile's
// model-input.json. Tolerates a missing or malformed file (the profile dir is
// materialized on every launch and the file is optional hand-maintained
// content): entries whose value is not a non-empty array of "text"/"image"
// are ignored. Keyed by the model id as declared in the profile's models.
function readModelInputOverrides(profileName: string | undefined): Record<string, ModelInput> {
	if (!profileName) return {};
	const file = path.join(profileDirFor(profileName), MODEL_INPUT_FILE);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const overrides: Record<string, ModelInput> = {};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (Array.isArray(value) && value.length > 0 && value.every((m) => INPUT_MODALITIES.has(m))) {
			overrides[id] = value as ModelInput;
		}
	}
	return overrides;
}

export function withAutoCustomModels(profile: Profile, profileName?: string): Profile {
	const provider = profile.provider;
	if (!provider) return profile;
	const profileModels = profile.models ?? [];
	if (profileModels.length === 0) return profile;

	const inputOverrides = readModelInputOverrides(profileName);
	const builtinProvider = getBuiltinProviders().find((p) => p === provider);
	const builtinIds = new Set(builtinProvider ? getBuiltinModels(builtinProvider).map((m) => m.id) : []);
	const storeIds = new Set(storeCatalogModelIds(provider));

	let changed = false;
	const models: ModelEntry[] = profileModels.map((entry) => {
		if (typeof entry !== "string") {
			// Explicit definition of a model pi does not know: pin its input
			// modalities unless it already declares them or the override file
			// names it (the file is the deliberate local edit, so it wins).
			const override = inputOverrides[entry.id];
			if (override) {
				if (entry.input !== undefined && JSON.stringify(entry.input) === JSON.stringify(override)) return entry;
				changed = true;
				return { ...entry, input: override };
			}
			if (entry.input !== undefined) return entry;
			changed = true;
			return { ...entry, input: DEFAULT_INPUT };
		}
		// Qualified "provider/model" ids are resolved by the runtime itself.
		if (entry.includes("/")) return entry;
		if (builtinIds.has(entry) || storeIds.has(entry)) return entry;
		changed = true;
		const definition: CustomModel = {
			id: entry,
			name: entry,
			input: inputOverrides[entry] ?? DEFAULT_INPUT,
		};
		// pi's custom-model loader throws when it cannot derive an api dialect
		// for the provider; that only happens for a provider with no catalogue
		// at all (neither builtin nor fetched), where a custom baseUrl speaks
		// OpenAI-style by convention.
		if (!builtinProvider && storeIds.size === 0) definition.api = "openai-completions";
		return definition;
	});
	return changed ? { ...profile, models } : profile;
}
