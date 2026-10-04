// Vim mode setting reader/writer for pi-plus. The "vim" key is not part of
// upstream's Settings interface (override policy: upstream stays pristine), so
// it goes through the shared layered settings.json storage
// (packages/plus/src/coding-agent/core/settings-layers.ts): reads walk project >
// agent dir > base agent dir > ~/.pi, writes persist to the base agent layer
// under a hub profile so the flag survives profile re-materialization. Any
// error or a non-boolean value means "disabled".

import { readLayeredSetting, writeLayeredSetting } from "../../../../../plus/src/coding-agent/core/settings-layers.ts";

/** Whether vim modal editing is enabled for `cwd` (project > profile dir > base agent dir > ~/.pi). */
export function readVimEnabled(cwd: string): boolean {
	return readLayeredSetting(cwd, "vim", (value) => (typeof value === "boolean" ? value : undefined)) ?? false;
}

/**
 * Persist the flag across launches (base agent settings under a hub profile,
 * else the agent dir; other keys preserved, profile-layer shadow dropped).
 * Returns false when the write failed (caller notifies).
 */
export function writeVimEnabled(enabled: boolean): boolean {
	return writeLayeredSetting("vim", enabled);
}
