// Classifier injected into the hub's `profile add`/`update` commands: tells
// hub which plain model ids pi's built-in catalog knows, so the unknown ones
// are stored as custom model definitions and materialized into the profile's
// models.json (pi would otherwise fail to resolve them at run time).

import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { UnknownModelChecker } from "@earendil-works/pi-hub";

/**
 * A model id is known when it equals a catalog model id, or when it is a
 * "provider/model" id whose provider and model are both in the catalog.
 * Everything else is a custom model. The catalog snapshot is built once —
 * the returned checker only filters, so repeated calls stay cheap.
 */
export function createHubUnknownModelChecker(): UnknownModelChecker {
	const known = new Set<string>();
	for (const provider of getBuiltinProviders()) {
		for (const model of getBuiltinModels(provider)) {
			known.add(model.id);
			known.add(`${provider}/${model.id}`);
		}
	}
	return async (modelIds) => modelIds.filter((id) => !known.has(id));
}
