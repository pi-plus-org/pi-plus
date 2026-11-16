/**
 * Classification of profile model ids pi's catalog does not know into custom
 * model definitions, shared by the pi-plus CLI launch path and the pi-plus-sdk
 * materialization path (packages/plus-api/src/profiles.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { AGENT_DIR, type CustomModel, type ModelEntry, type Profile } from "@earendil-works/pi-hub";

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

export function withAutoCustomModels(profile: Profile): Profile {
	const provider = profile.provider;
	if (!provider) return profile;
	const profileModels = profile.models ?? [];
	const plainIds = profileModels.filter((m): m is string => typeof m === "string");
	if (plainIds.length === 0) return profile;

	const builtinProvider = getBuiltinProviders().find((p) => p === provider);
	const builtinIds = new Set(builtinProvider ? getBuiltinModels(builtinProvider).map((m) => m.id) : []);
	const storeIds = new Set(storeCatalogModelIds(provider));

	let changed = false;
	const models: ModelEntry[] = profileModels.map((entry) => {
		if (typeof entry !== "string") return entry;
		// Qualified "provider/model" ids are resolved by the runtime itself.
		if (entry.includes("/")) return entry;
		if (builtinIds.has(entry) || storeIds.has(entry)) return entry;
		changed = true;
		const definition: CustomModel = { id: entry, name: entry };
		// pi's custom-model loader throws when it cannot derive an api dialect
		// for the provider; that only happens for a provider with no catalogue
		// at all (neither builtin nor fetched), where a custom baseUrl speaks
		// OpenAI-style by convention.
		if (!builtinProvider && storeIds.size === 0) definition.api = "openai-completions";
		return definition;
	});
	return changed ? { ...profile, models } : profile;
}
