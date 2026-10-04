/**
 * Layered storage for custom general settings.json keys (pi-plus).
 *
 * Features whose settings key is not part of upstream's Settings interface
 * (hooks, memory, vim) must not touch upstream's SettingsManager — the override
 * policy keeps upstream pristine — so they read and write settings.json
 * directly. This module owns the layer stack those readers share, matching the
 * runtime layering in ./settings-manager.ts (increasing precedence):
 *
 *   ~/.pi/settings.json < base agent settings.json < agent dir settings.json < project .pi/settings.json
 *
 * Under a hub profile the agent dir IS the profile copy, and the profile file is
 * rewritten on every materialization with non-profile-scoped keys pruned — so a
 * general key must live in the BASE agent layer to persist. Writes here follow
 * that rule (base layer when layering is active, agent dir otherwise) and drop
 * stale profile-file shadows; callers keep their own merge/validate semantics:
 * first-wins callers use readLayeredSetting, additive callers (hooks) walk
 * getSettingsLayerPaths themselves.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";
import { getBaseAgentDir, getBaseSettingsPath } from "./profile-settings.ts";

/** The settings.json files a layered key is read from, in increasing precedence order. */
export function getSettingsLayerPaths(cwd: string): string[] {
	const agentDirFile = join(getAgentDir(), "settings.json");
	const files = [join(homedir(), ".pi", "settings.json")];
	// Outside a hub profile there is no separate base layer.
	const baseFile = getBaseSettingsPath();
	if (baseFile && baseFile !== agentDirFile) files.push(baseFile);
	files.push(agentDirFile, join(cwd, ".pi", "settings.json"));
	return files;
}

function readSettingsObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
		return raw as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** The value of `key` in one settings.json file; undefined when the file or key is missing/unreadable. */
export function readSettingsKey(path: string, key: string): unknown {
	return readSettingsObject(path)?.[key];
}

/**
 * Read `key` from the layer stack, highest precedence first (project → agent
 * dir → base agent → ~/.pi), returning the first layer whose value passes
 * `validate`. An invalid or absent value falls through to the next layer, and
 * errors reading a file mean it is treated as absent.
 */
export function readLayeredSetting<T>(
	cwd: string,
	key: string,
	validate: (value: unknown) => T | undefined,
): T | undefined {
	const paths = getSettingsLayerPaths(cwd);
	for (let index = paths.length - 1; index >= 0; index -= 1) {
		const value = validate(readSettingsKey(paths[index], key));
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Persist a general key. With hub-profile layering active it goes to the base
 * agent settings.json (the profile file would have the key pruned at the next
 * materialization) and any shadow copy of it in the profile file is dropped so
 * the new value wins; otherwise the agent dir is the write target. Other keys in
 * the file are preserved. Returns false when the main write failed (caller
 * notifies).
 */
export function writeLayeredSetting(key: string, value: unknown): boolean {
	const baseDir = getBaseAgentDir();
	const path = join(baseDir ?? getAgentDir(), "settings.json");
	try {
		const raw = readSettingsObject(path) ?? {};
		raw[key] = value;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	} catch {
		return false;
	}
	if (baseDir) dropProfileShadow(key);
	return true;
}

/**
 * Remove `key` from the profile settings.json, which shadows the base layer we
 * just wrote (older versions and manual edits could have put it there).
 * Best-effort: an unreadable/unparseable profile file is ignored, matching how
 * reads treat it as absent.
 */
function dropProfileShadow(key: string): void {
	const path = join(getAgentDir(), "settings.json");
	try {
		const raw = readSettingsObject(path);
		if (!raw || !(key in raw)) return;
		delete raw[key];
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	} catch {
		// profile layer is unreadable; the read chain already skips it
	}
}
