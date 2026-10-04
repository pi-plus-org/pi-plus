// Memory feature settings reader for pi-plus. The "memory" key is not part of
// upstream's Settings interface (override policy: upstream stays pristine), so
// it goes through the shared layered settings.json storage
// (packages/plus/src/coding-agent/core/settings-layers.ts): project settings win
// over the agent dir, which wins over the base agent dir (the ~/.pi/agent
// settings a hub profile layers under), which wins over ~/.pi; any error or a
// non-object value means "fall through to the next source / defaults".

import { readLayeredSetting } from "../../coding-agent/core/settings-layers.ts";

export interface MemorySettings {
	/** Master switch for tools, injection, and auto-extract. Default true. */
	enabled: boolean;
	/** Background extraction of noteworthy memories at end of turn. Default true. */
	autoExtract: boolean;
	/** Minimum new messages since the last extraction attempt before another runs. Default 8. */
	extractMinMessages: number;
	/** Minimum milliseconds between extraction attempts. Default 180_000 (3 min). */
	extractCooldownMs: number;
}

const DEFAULTS: MemorySettings = {
	enabled: true,
	autoExtract: true,
	extractMinMessages: 8,
	extractCooldownMs: 180_000,
};

/** Validate one layer's "memory" value; a valid object yields the recognized fields. */
function parseMemorySettings(value: unknown): Partial<MemorySettings> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const memory = value as Record<string, unknown>;
	const settings: Partial<MemorySettings> = {};
	if (typeof memory.enabled === "boolean") settings.enabled = memory.enabled;
	if (typeof memory.autoExtract === "boolean") settings.autoExtract = memory.autoExtract;
	if (typeof memory.extractMinMessages === "number" && Number.isFinite(memory.extractMinMessages)) {
		settings.extractMinMessages = memory.extractMinMessages;
	}
	if (typeof memory.extractCooldownMs === "number" && Number.isFinite(memory.extractCooldownMs)) {
		settings.extractCooldownMs = memory.extractCooldownMs;
	}
	return settings;
}

/** Effective memory settings for `cwd` (project > agent dir > base agent dir > ~/.pi, then defaults). */
export function readMemorySettings(cwd: string): MemorySettings {
	const layer = readLayeredSetting(cwd, "memory", parseMemorySettings);
	return { ...DEFAULTS, ...(layer ?? {}) };
}
