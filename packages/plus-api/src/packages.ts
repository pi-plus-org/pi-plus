/**
 * Package maintenance for SDK hosts: the programmatic form of the CLI's
 * `pi install/remove/list/update --extensions` package commands. A pi package
 * is an npm/git/local source that contributes extensions, skills, prompt
 * templates, and/or themes (see pi.dev/docs/latest/packages).
 *
 * These entries take explicit cwd/agentDir so hosts never touch the real
 * ~/.pi, and honor the same scope rules as the CLI: user-scope declarations
 * live in <agentDir>/settings.json, project-scope ones in <cwd>/.pi/settings.json.
 * Project-scope reads/writes require a project-trusted settings manager —
 * DefaultPackageManager refuses them otherwise (pi only loads project
 * declarations after project trust is granted).
 */

import {
	type ConfiguredPackage,
	DefaultPackageManager,
	getAgentDir,
	type ProgressCallback,
	SettingsManager,
} from "../../coding-agent/src/index.ts";

/** Options shared by the package-maintenance entries. */
export interface PlusPackageMaintenanceOptions {
	/** Project directory for project-scope declarations (default `process.cwd()`). */
	cwd?: string;
	/** Agent dir holding user-scope settings.json (default pi's agent dir). */
	agentDir?: string;
	/**
	 * Caller-owned settings manager. When given, `cwd`/`agentDir`/
	 * `projectTrusted` are not used for settings resolution (the manager's own
	 * storage decides); `agentDir` still defaults to pi's agent dir for
	 * install locations.
	 */
	settingsManager?: SettingsManager;
	/**
	 * Whether project-scope settings are honored (default true). Embedding
	 * hosts decide project trust themselves — mirroring
	 * `createPlusAgentSessionRuntime`'s `projectTrusted` — instead of pi's
	 * interactive trust prompt.
	 */
	projectTrusted?: boolean;
	/** Receives progress events from installs/updates (clone/npm stages). */
	onProgress?: ProgressCallback;
}

export interface PlusPackageInstallOptions extends PlusPackageMaintenanceOptions {
	/**
	 * Persist the source in the project's `.pi/settings.json` instead of the
	 * user settings. Throws when the settings manager is not project-trusted.
	 */
	local?: boolean;
}

function createMaintenanceManager(options: PlusPackageMaintenanceOptions): DefaultPackageManager {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager =
		options.settingsManager ??
		SettingsManager.create(cwd, agentDir, { projectTrusted: options.projectTrusted ?? true });
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	if (options.onProgress) manager.setProgressCallback(options.onProgress);
	return manager;
}

/** Configured packages from both scopes, in user-then-project order. Synchronous. */
export function listPackages(options: PlusPackageMaintenanceOptions = {}): ConfiguredPackage[] {
	return createMaintenanceManager(options).listConfiguredPackages();
}

/** Install a package source and persist it in settings (user scope unless `local`). */
export async function installPackage(source: string, options: PlusPackageInstallOptions = {}): Promise<void> {
	await createMaintenanceManager(options).installAndPersist(source, { local: options.local });
}

/** Remove a package source from settings; returns false when nothing matched. */
export async function removePackage(source: string, options: PlusPackageInstallOptions = {}): Promise<boolean> {
	return createMaintenanceManager(options).removeAndPersist(source, { local: options.local });
}

/**
 * Reconcile installed packages with their configured sources (clone/npm ref
 * refreshes — pinned refs do not move). Pass `source` to update one package;
 * omit it to update everything in both scopes.
 */
export async function updatePackages(
	source: string | undefined = undefined,
	options: PlusPackageMaintenanceOptions = {},
): Promise<void> {
	await createMaintenanceManager(options).update(source);
}
