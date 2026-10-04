/**
 * pi-plus settings store: the `piPlus` block of pi's own settings.json.
 *
 * Knobs that upstream pi's SettingsManager has no schema for live in one
 * top-level `piPlus` object inside the agent settings.json — starting with
 * the auto-compaction threshold/floor/cap chosen in the /settings UI (see
 * coding-agent/ui/settings-selector.ts), plus free-form host-owned keys
 * (readPiPlusSettings/updatePiPlusSettings) for embedding hosts such as the
 * pi-plus desktop (defaultPermissionMode, desktopTheme, sidebarWidth).
 *
 * The file is resolved at the **base agent layer** (getBaseAgentDir under a
 * hub profile, the plain agent dir otherwise) so the pipi CLI and embedded
 * hosts share exactly one store regardless of the active profile — stale
 * `piPlus` copies inside materialized profile dirs are ignored by design.
 *
 * Safe to co-own settings.json with upstream: SettingsManager loads the raw
 * JSON and persistScopedSettings only rewrites *modified* fields into the
 * current file, so the `piPlus` block survives upstream writes untouched —
 * and our writes preserve everything else. We take the same proper-lockfile
 * lock upstream uses on the file, re-read the document inside the lock, and
 * replace only the keys named in the patch (undefined deletes the key),
 * writing atomically (tmp + rename) so unlocked readers never see a partial
 * document. Precedence in detection.ts is unchanged: the PI_* env overrides
 * still win over the persisted values.
 *
 * The legacy standalone `~/.pi/agent/pi-plus-settings.json` file is gone; the
 * values start fresh at the defaults below.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../coding-agent/src/config.ts";
import { getBaseAgentDir, readSettingsFileObject } from "../coding-agent/core/profile-settings.ts";

/** Typed pi-plus keys of the piPlus block (host-owned keys are free-form). */
export interface PlusSettings {
	/** Percent (1-100) of the effective context window at which auto-compaction triggers. */
	autoCompactThresholdPercent?: number;
	/**
	 * Minimum floor buffer (tokens) for the effective context window: the window
	 * used for auto-compact math never drops below the summary reservation plus
	 * this many tokens. Must be >= DEFAULT_CONTEXT_FLOOR_TOKENS — the setting can
	 * only raise the floor, never below the small-context guarantee.
	 */
	contextFloorTokens?: number;
	/**
	 * Cap (tokens) on the context window used for auto-compact threshold math
	 * and the footer fullness meter: the window is min(model.contextWindow, cap).
	 * Must be >= MIN_CONTEXT_WINDOW_CAP_TOKENS. Undefined (the default) means no
	 * cap: the model's advertised context window is used as-is.
	 */
	contextWindowCapTokens?: number;
}

const PI_PLUS_BLOCK = "piPlus";

/** The settings.json hosting the piPlus block: base agent layer under a hub profile. */
function getPiPlusSettingsPath(): string {
	const agentDir = getAgentDir();
	return join(getBaseAgentDir(agentDir) ?? agentDir, "settings.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractPiPlusBlock(document: Record<string, unknown>): Record<string, unknown> {
	return isPlainObject(document[PI_PLUS_BLOCK]) ? (document[PI_PLUS_BLOCK] as Record<string, unknown>) : {};
}

/** Raw piPlus block including host-owned keys; {} when absent or malformed. */
export function readPiPlusSettings(): Record<string, unknown> {
	return structuredClone(extractPiPlusBlock(readSettingsFileObject(getPiPlusSettingsPath())));
}

/**
 * Merge keys into the piPlus block; a key set to undefined is deleted. All
 * other settings.json content (upstream keys, unknown keys, untouched piPlus
 * keys) is preserved verbatim.
 */
export function updatePiPlusSettings(patch: Record<string, unknown | undefined>): void {
	const path = getPiPlusSettingsPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	// proper-lockfile locks via a sibling <file>.lock dir, so the file itself
	// only needs to exist to be lockable; seed it once if missing.
	if (!existsSync(path)) writeSettingsDocument(path, {});
	const release = acquireLockSyncWithRetry(path);
	try {
		// Re-read under the lock: another process may have written between checks.
		const document = readSettingsFileObject(path);
		const block = extractPiPlusBlock(document);
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete block[key];
			else block[key] = value;
		}
		if (Object.keys(block).length > 0) document[PI_PLUS_BLOCK] = block;
		else delete document[PI_PLUS_BLOCK];
		writeSettingsDocument(path, document);
	} finally {
		release();
	}
}

/** Acquire the settings-file lock with the same retry budget as upstream's FileSettingsStorage. */
function acquireLockSyncWithRetry(path: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to keep the store API synchronous like upstream.
			}
		}
	}
	throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
}

function writeSettingsDocument(path: string, document: Record<string, unknown>): void {
	const tmp = `${path}.${process.pid}.plus-settings.tmp`;
	writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function sanitizePlusSettings(raw: Record<string, unknown>): PlusSettings {
	const result: PlusSettings = {};
	const percent = raw.autoCompactThresholdPercent;
	if (typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100) {
		result.autoCompactThresholdPercent = percent;
	}
	const floor = raw.contextFloorTokens;
	if (typeof floor === "number" && Number.isSafeInteger(floor) && floor >= MIN_CONTEXT_FLOOR_TOKENS) {
		result.contextFloorTokens = floor;
	}
	const cap = raw.contextWindowCapTokens;
	if (typeof cap === "number" && Number.isSafeInteger(cap) && cap >= MIN_CONTEXT_WINDOW_CAP_TOKENS) {
		result.contextWindowCapTokens = cap;
	}
	return result;
}

/** Default threshold: 80% of the effective context window. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80;

/** Effective threshold percent: persisted choice, else the default. */
export function getAutoCompactThresholdPercent(): number {
	return (
		sanitizePlusSettings(readPiPlusSettings()).autoCompactThresholdPercent ?? DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT
	);
}

/** Persist a choice; undefined resets to the default (deletes the key). */
export function setAutoCompactThresholdPercent(percent: number | undefined): void {
	if (percent !== undefined && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
		throw new Error(`Invalid auto-compact threshold percent: ${percent}`);
	}
	updatePiPlusSettings({ autoCompactThresholdPercent: percent });
}

/** UI label for a percent value. */
export function formatAutoCompactThresholdPercent(percent: number): string {
	return `${percent}%`;
}

/** Parse a UI choice ("95%") back to a percent; unparseable input yields the default. */
export function parseAutoCompactThresholdChoice(choice: string): number {
	const parsed = Number.parseFloat(choice.replace(/%$/, ""));
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
}

/**
 * Default context floor buffer: matches detection.ts's
 * AUTOCOMPACT_FLOOR_BUFFER_TOKENS, the pre-#1949 floor that guarantees a
 * usable (non-negative-threshold) effective window for small-context models.
 */
export const DEFAULT_CONTEXT_FLOOR_TOKENS = 13_000;

/**
 * Lowest context floor the block accepts. The built-in 13k floor stays the
 * guaranteed minimum, so the setting can only raise the floor — lowering it
 * would re-open the negative-threshold failure on tiny models (issue #635).
 */
export const MIN_CONTEXT_FLOOR_TOKENS = DEFAULT_CONTEXT_FLOOR_TOKENS;

/** Effective context floor tokens: persisted choice, else the 13k default. */
export function getContextFloorTokens(): number {
	return sanitizePlusSettings(readPiPlusSettings()).contextFloorTokens ?? DEFAULT_CONTEXT_FLOOR_TOKENS;
}

/** Persist a choice; undefined resets to the default (deletes the key). */
export function setContextFloorTokens(tokens: number | undefined): void {
	if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_FLOOR_TOKENS)) {
		throw new Error(`Invalid context floor tokens: ${tokens}`);
	}
	updatePiPlusSettings({ contextFloorTokens: tokens });
}

/** UI label for a token count ("32768"). */
export function formatContextFloorTokens(tokens: number): string {
	return `${tokens}`;
}

/**
 * Parse a UI choice back to tokens: plain integers, or a "k"/"K" suffix as
 * Ki tokens ("32k" → 32768). Unparseable or below-minimum input yields the default.
 */
export function parseContextFloorChoice(choice: string): number {
	const trimmed = choice.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)k?$/.exec(trimmed);
	if (!match) return DEFAULT_CONTEXT_FLOOR_TOKENS;
	const parsed = Number.parseFloat(match[1]) * (trimmed.endsWith("k") ? 1024 : 1);
	const rounded = Math.round(parsed);
	return Number.isSafeInteger(rounded) && rounded >= MIN_CONTEXT_FLOOR_TOKENS ? rounded : DEFAULT_CONTEXT_FLOOR_TOKENS;
}

/**
 * Lowest context window cap the block accepts. Small enough to keep
 * small-context models useful, large enough that a cap below it would be a
 * misconfiguration rather than a real choice.
 */
export const MIN_CONTEXT_WINDOW_CAP_TOKENS = 32_768;

/**
 * Effective context window cap: the persisted choice, or undefined when no cap
 * is set (the default) — detection.ts then uses the model's advertised window.
 */
export function getContextWindowCapTokens(): number | undefined {
	return sanitizePlusSettings(readPiPlusSettings()).contextWindowCapTokens;
}

/** Persist a choice; undefined resets to no cap (deletes the key). */
export function setContextWindowCapTokens(tokens: number | undefined): void {
	if (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT_WINDOW_CAP_TOKENS)) {
		throw new Error(`Invalid context window cap tokens: ${tokens}`);
	}
	updatePiPlusSettings({ contextWindowCapTokens: tokens });
}

/** UI label for a cap value ("262144"), or "No cap" when unset. */
export function formatContextWindowCapTokens(tokens: number | undefined): string {
	return tokens === undefined ? "No cap" : `${tokens}`;
}

/**
 * Parse a UI choice back to tokens: "no cap"/empty restores the default
 * (undefined); otherwise plain integers with an optional "k"/"K" Ki suffix
 * ("256k" → 262144). Unparseable or below-minimum input yields undefined.
 */
export function parseContextWindowCapChoice(choice: string): number | undefined {
	const trimmed = choice.trim().toLowerCase();
	if (trimmed === "" || trimmed === "no cap") return undefined;
	const match = /^(\d+(?:\.\d+)?)k?$/.exec(trimmed);
	if (!match) return undefined;
	const parsed = Number.parseFloat(match[1]) * (trimmed.endsWith("k") ? 1024 : 1);
	const rounded = Math.round(parsed);
	return Number.isSafeInteger(rounded) && rounded >= MIN_CONTEXT_WINDOW_CAP_TOKENS ? rounded : undefined;
}
