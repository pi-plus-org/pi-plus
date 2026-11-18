/**
 * Profile management for SDK hosts: a curated re-export of
 * @earendil-works/pi-hub (named pi profiles in ~/.pi/profiles.json plus the
 * per-profile materialized agent dirs — see that package for the file
 * contract). The `pipi` CLI dispatches the same hub module at runtime;
 * bundling it here means an embedding host (e.g. a desktop app) delegates
 * profile management to pi-plus-sdk instead of reimplementing the contract.
 *
 * Deliberately narrow: profiles.json CRUD, materialization, and the shared
 * constants. The materializer's write*File helpers stay internal
 * (materializeProfile is the unit), and hub's CLI command layer
 * (commands.ts/launch.ts) is not part of this surface.
 */

export type { AgentSettingsData, CustomModel, ModelEntry, Profile, ProfilesData } from "@earendil-works/pi-hub";
export {
	AGENT_DIR,
	addProfile,
	addProfileModel,
	clearDefaultProfile,
	findProfile,
	getDefaultProfileName,
	loadProfiles,
	materializeProfile as hubMaterializeProfile,
	modelId,
	profileDirFor,
	refreshSharedLinks,
	removeProfile,
	removeProfileDir,
	removeProfileModel,
	renameProfile,
	setDefaultProfile,
	setProfileDefaultModel,
	syncProfilePackagesToSource,
	THINKING_LEVELS,
	updateProfile,
} from "@earendil-works/pi-hub";

import { materializeProfile as hubMaterializeProfile, type Profile } from "@earendil-works/pi-hub";
import { withAutoCustomModels } from "../../plus/src/hub/custom-models.ts";

// Unknown plain model ids are classified into custom model definitions at
// materialization time (shared with the pi-plus CLI launch path) — see
// packages/plus/src/hub/custom-models.ts for why.
export function materializeProfile(name: string, profile: Profile): string {
	return hubMaterializeProfile(name, withAutoCustomModels(profile, name));
}
