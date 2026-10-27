/**
 * Wrapper for packages/coding-agent/src/core/settings-manager.ts.
 *
 * Pass-through re-export plus a one-time patch of the static factory
 * SettingsManager.create, which activates hub-profile settings layering when
 * the agent dir is a hub profile dir — auto-detected, or via the
 * PI_PLUS_BASE_AGENT_DIR marker pipi records (see ./profile-settings.ts): the
 * "global" scope then reads as deepMerge(<base agent settings.json>, <profile
 * settings.json>) with the profile layer winning, and every write is routed
 * back per key — PROFILE_SETTINGS_KEYS go to the profile file, everything else
 * to the base agent file (clearing a stale shadow copy of that key in the
 * profile file so the edit takes effect). The project scope is untouched and
 * still wins over the merged global scope. Because the two files are read on
 * every load and reload, base-agent edits become visible under a profile at
 * runtime instead of being baked into the profile copy at materialization time.
 *
 * The patch mutates the upstream class object (it cannot be subclassed — its
 * constructor is private), so every consumer that resolves this module —
 * including the plus-api SDK, which imports the class through upstream's
 * index.ts — sees the layered factory. For an agent dir that is neither a hub
 * profile dir nor paired with the marker the factory delegates to the original
 * implementation unchanged, so plain pi keeps its exact single-file behavior.
 *
 * The patched factory also installs the process HTTP dispatcher from the
 * loaded profile's `httpIdleTimeoutMs` (see the dispatcher note at the create
 * patch): upstream only arms it from its own CLI entry points, so an embedded
 * host used to silently run on undici's defaults.
 *
 * The patch also adds a `setExternalEditorCommand(command)` /
 * `getExternalEditorSetting()` instance-method pair alongside the upstream
 * read-side `getExternalEditorCommand` (which honors VISUAL/EDITOR fallbacks):
 * the getter returns the raw persisted value (undefined when unset) so an
 * embedded host can tell "no editor chosen" from a fallback, and the setter
 * lets the plus desktop persist its editor choice so it shares pipi's Ctrl+G
 * editor setting instead of a private store. An embedded host writing through
 * the layered factory also gets the shadow strip for free (externalEditor is
 * a general key → base file wins).
 */
export * from "../../../../coding-agent/src/core/settings-manager.ts";

import { getAgentDir } from "../../../../coding-agent/src/config.ts";
import { configureHttpDispatcher } from "../../../../coding-agent/src/core/http-dispatcher.ts";
import {
	FileSettingsStorage,
	type SettingsManagerCreateOptions,
	type SettingsScope,
	type SettingsStorage,
	SettingsManager as UpstreamSettingsManager,
} from "../../../../coding-agent/src/core/settings-manager.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";
import { stripBom } from "../../../../coding-agent/src/utils/text.ts";
import { deepMergeSettingObjects, getBaseAgentDir, isProfileScopedSettingsKey } from "./profile-settings.ts";

function parseSettingsJson(content: string | undefined): Record<string, unknown> | undefined {
	if (content === undefined) return undefined;
	const parsed: unknown = JSON.parse(stripBom(content));
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

function sameJsonValue(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Settings storage over two layer files: the profile's settings.json (the
 * agent dir pipi points PI_CODING_AGENT_DIR at) layered on top of the base
 * agent settings.json. Upstream treats the pair as one "global" document; this
 * class splits writes back per top-level key. Both layer files are locked
 * (base first, then profile) while the caller's function runs.
 */
export class ProfileLayeredSettingsStorage implements SettingsStorage {
	private readonly profileStorage: FileSettingsStorage;
	private readonly baseStorage: FileSettingsStorage;

	constructor(profileCwd: string, profileAgentDir: string, baseAgentDir: string) {
		this.profileStorage = new FileSettingsStorage(profileCwd, profileAgentDir);
		this.baseStorage = new FileSettingsStorage(profileCwd, baseAgentDir);
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		if (scope !== "global") {
			this.profileStorage.withLock(scope, fn);
			return;
		}
		// Nested: the outer function returns the base layer's new content (or
		// undefined when routing decided nothing changed there), the inner one
		// the profile layer's.
		this.baseStorage.withLock("global", (baseCurrent) => {
			let baseNext: string | undefined;
			this.profileStorage.withLock("global", (profileCurrent) => {
				const baseObj = parseSettingsJson(baseCurrent) ?? {};
				const profileObj = parseSettingsJson(profileCurrent) ?? {};
				const merged = deepMergeSettingObjects(baseObj, profileObj);
				const hasLayer = baseCurrent !== undefined || profileCurrent !== undefined;
				const next = fn(hasLayer ? JSON.stringify(merged, null, 2) : undefined);
				if (next === undefined) return undefined;
				const routed = routeMergedSettings(baseObj, profileObj, merged, parseSettingsJson(next) ?? {});
				baseNext = routed.baseChanged ? JSON.stringify(routed.base, null, 2) : undefined;
				return routed.profileChanged ? JSON.stringify(routed.profile, null, 2) : undefined;
			});
			return baseNext;
		});
	}
}

interface RoutedLayers {
	base: Record<string, unknown>;
	profile: Record<string, unknown>;
	baseChanged: boolean;
	profileChanged: boolean;
}

/** Split a new merged document back into the two layer files, key by key. */
function routeMergedSettings(
	baseObj: Record<string, unknown>,
	profileObj: Record<string, unknown>,
	previousMerged: Record<string, unknown>,
	nextMerged: Record<string, unknown>,
): RoutedLayers {
	const base = { ...baseObj };
	const profile = { ...profileObj };
	let baseChanged = false;
	let profileChanged = false;

	// Keys upstream dropped (rare; e.g. migrations) disappear from whichever layer holds them.
	for (const key of Object.keys(previousMerged)) {
		if (key in nextMerged) continue;
		if (key in base) {
			delete base[key];
			baseChanged = true;
		}
		if (key in profile) {
			delete profile[key];
			profileChanged = true;
		}
	}

	for (const [key, value] of Object.entries(nextMerged)) {
		if (key in previousMerged && sameJsonValue(previousMerged[key], value)) continue;
		if (isProfileScopedSettingsKey(key)) {
			profile[key] = value;
			profileChanged = true;
		} else {
			base[key] = value;
			baseChanged = true;
			// A general key must not keep shadowing the base layer from the profile file.
			if (key in profile) {
				delete profile[key];
				profileChanged = true;
			}
		}
	}

	return { base, profile, baseChanged, profileChanged };
}

/** Structural view of the private write internals, for the patched setter below. */
interface SettingsManagerWriteInternals {
	globalSettings: { externalEditor?: string };
	markModified(field: string): void;
	save(): void;
}

// Upstream reads externalEditor (getExternalEditorCommand) but only ever sets it
// by hand-editing settings.json; embedded hosts need a setter. Same private
// mutation idiom as the create patch — the write queues through the instance's
// own save(), so the layered storage routing (general key -> base file, with
// stale profile shadows stripped) applies. Callers awaiting persistence must
// flush() the manager.
/** Structural view of the read internals, for the patched retry getter below. */
interface SettingsManagerReadInternals {
	getHttpIdleTimeoutMs(): number;
}

const prototypePatch = UpstreamSettingsManager.prototype as unknown as {
	setExternalEditorCommand(this: SettingsManagerWriteInternals, command: string | undefined): void;
	getExternalEditorSetting(this: SettingsManagerWriteInternals): string | undefined;
	getProviderRetrySettings(this: SettingsManagerReadInternals): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
	};
};
prototypePatch.setExternalEditorCommand = function (command: string | undefined): void {
	if (command === undefined) {
		delete this.globalSettings.externalEditor;
	} else {
		this.globalSettings.externalEditor = command;
	}
	this.markModified("externalEditor");
	this.save();
};
// Raw read counterpart of the setter: upstream's getExternalEditorCommand folds
// in $VISUAL/$EDITOR (and a nano/notepad default), so a host managing the
// persisted value needs the un-fallbacked one.
prototypePatch.getExternalEditorSetting = function (): string | undefined {
	const configured = this.globalSettings.externalEditor;
	return typeof configured === "string" && configured.trim() !== "" ? configured : undefined;
};

// Surface the patched method on the declared class for in-repo type consumers
// (the runtime bundle bakes the wrapper over the upstream module).
declare module "../../../../coding-agent/src/core/settings-manager.ts" {
	interface SettingsManager {
		/**
		 * Persist the external editor command (pi-plus addition; undefined removes
		 * the key and restores the $VISUAL/$EDITOR fallback). Queued write — flush().
		 */
		setExternalEditorCommand(command: string | undefined): void;
		/**
		 * Raw persisted external editor command (pi-plus addition; undefined when
		 * unset — unlike getExternalEditorCommand, no $VISUAL/$EDITOR fallback).
		 */
		getExternalEditorSetting(): string | undefined;
	}
}

// ---------------------------------------------------------------------------
// pi-plus: the LLM *request* ceiling is not the socket idle timeout
// ---------------------------------------------------------------------------

/**
 * Floor for a provider request's total deadline. Upstream's `buildRequestOptions`
 * resolves it as `retry.provider.timeoutMs ?? httpIdleTimeoutMs`, so on a default
 * profile the OpenAI-compatible client arms a 300s deadline for the whole request
 * — while `httpIdleTimeoutMs` is documented (and enforced by undici) as a
 * between-bytes guard on the socket. A closing-summary request carrying a large
 * aggregated transcript therefore dies at ~300s of perfectly healthy streaming
 * with "Request timed out." (2026-10-27 cit-llm session, qwen-token-plan-cn:
 * durationMs 300008, stopReason "error"). The socket keeps its own timeout; the
 * request gets a ceiling of its own — at least this, which is the 10 minutes
 * upstream documents as the OpenAI/Anthropic SDK default.
 */
const PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS = 600_000;
/** Upstream's own "no deadline" sentinel, used when httpIdleTimeoutMs is 0/disabled. */
const PI_PLUS_NO_REQUEST_CEILING_MS = 2_147_483_647;

const upstreamGetProviderRetrySettings = prototypePatch.getProviderRetrySettings;
// Same private-mutation idiom as the other patches: only the *default* is raised,
// so an explicit `retry.provider.timeoutMs` in settings.json still wins, and the
// value is never below the configured socket idle timeout.
prototypePatch.getProviderRetrySettings = function (this: SettingsManagerReadInternals) {
	const settings = upstreamGetProviderRetrySettings.call(this);
	if (settings.timeoutMs !== undefined) return settings;
	const httpIdleTimeoutMs = this.getHttpIdleTimeoutMs();
	return {
		...settings,
		timeoutMs:
			httpIdleTimeoutMs === 0
				? PI_PLUS_NO_REQUEST_CEILING_MS
				: Math.max(httpIdleTimeoutMs, PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS),
	};
};

const upstreamCreate = UpstreamSettingsManager.create.bind(UpstreamSettingsManager);

UpstreamSettingsManager.create = (
	cwd: string,
	agentDir: string = getAgentDir(),
	options: SettingsManagerCreateOptions = {},
): UpstreamSettingsManager => {
	const resolvedAgentDir = resolvePath(agentDir);
	const baseDir = getBaseAgentDir(resolvedAgentDir);
	const manager = baseDir
		? UpstreamSettingsManager.fromStorage(new ProfileLayeredSettingsStorage(cwd, resolvedAgentDir, baseDir), options)
		: upstreamCreate(cwd, resolvedAgentDir, options);
	// Upstream arms the undici dispatcher from its CLI entry points only
	// (main.ts / cli/setup.ts / rpc-entry.ts), so an embedder that never runs them
	// — the desktop, an SDK script — silently ignored the profile's
	// httpIdleTimeoutMs and ran on undici's defaults. Every host that loads a
	// profile comes through this factory, so the loaded profile now owns the
	// process timeouts everywhere; the call is idempotent per value, which also
	// keeps a hub profile switch consistent. `inMemory()`/`fromStorage()` are
	// deliberately not patched: a unit test must never rewrite global fetch.
	// Best-effort: an unparseable httpIdleTimeoutMs keeps failing where upstream
	// fails (the first request build reads it), instead of breaking every host
	// that merely opens a settings manager for an unrelated read.
	try {
		configureHttpDispatcher(manager.getHttpIdleTimeoutMs());
	} catch {
		/* reported by the normal settings read paths */
	}
	return manager;
};
