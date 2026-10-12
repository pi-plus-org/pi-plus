/**
 * Extension-cache lifecycle helpers for pi-plus hosts (pipi CLI wrapper,
 * pi-plus-sdk, desktop).
 *
 * The coding-agent loader memoizes extension factories per resolved path for
 * the life of the process. That's fine for a short-lived CLI run, but a
 * long-lived host (the pi-plus desktop app) would keep serving stale code
 * after a package update until the cache is dropped — hence this escape
 * hatch, kept on the pi-plus side so coding-agent's public surface stays
 * unchanged.
 */

import { clearExtensionCache as clearCodingAgentExtensionCache } from "../../../coding-agent/src/core/extensions/loader.ts";

/**
 * Drop every cached extension factory so the next session rebuilds them from
 * disk. Call after installing, updating, or removing a package in a
 * long-lived process; cheap no-op-ish work for one-shot CLI runs.
 */
export function clearExtensionCache(): void {
	clearCodingAgentExtensionCache();
}
