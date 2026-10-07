/**
 * Public type contract for the "pi-plus" npm package's programmatic entry
 * (api.js). Hand-authored mirror of src/api.ts: the runtime is fully
 * self-contained in api.js (built from this repo with the pi-plus override
 * layer baked in), so this file only needs to re-export the upstream SDK
 * types and declare the pi-plus additions. A vitest drift guard
 * (test/api.test.ts) asserts every runtime export of src/api.ts appears here.
 */

export * from "@earendil-works/pi-coding-agent";

import type {
	AgentSession,
	AgentSessionRuntime,
	CreateAgentSessionOptions,
	CreateAgentSessionResult,
	DefaultResourceLoaderOptions,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionError,
	ExtensionUIContext,
	InlineExtension,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

// pi-plus runtime addition: the SettingsManager wrapper patches a setter +
// raw getter pair onto the upstream class next to its existing read-side
// getExternalEditorCommand (see packages/plus/src/coding-agent/core/settings-manager.ts).
// The write is queued like every other save — await manager.flush() to persist.
declare module "@earendil-works/pi-coding-agent" {
	interface SettingsManager {
		/** Persist the external editor command; undefined removes the key and
		 *  restores the $VISUAL/$EDITOR fallback (pi-plus patch, runtime only). */
		setExternalEditorCommand(command: string | undefined): void;
		/** Raw persisted external editor command, undefined when unset — unlike
		 *  getExternalEditorCommand, no $VISUAL/$EDITOR fallback (pi-plus patch). */
		getExternalEditorSetting(): string | undefined;
	}
}

export declare const plusSdkExtensionFactories: InlineExtension[];

// --- pi-plus-permissions (bypass | acceptEdits | plan tool-call gate) ------

export type PermissionMode = "bypass" | "acceptEdits" | "plan";

/** Canonical order; hosts cycle forward through this list on their shortcut. */
export declare const PERMISSION_MODES: PermissionMode[];

export declare const PERMISSION_MODE_LABELS: Record<PermissionMode, string>;

/** Mutable holder shared between the host and the extension. */
export interface PermissionModeState {
	mode: PermissionMode;
}

export interface PermissionsExtensionOptions {
	/** Host-owned state; a fresh bypass-on holder is created when omitted. */
	state?: PermissionModeState;
	/** Called after every mode change, including host-side writes. */
	onModeChange?: (mode: PermissionMode) => void;
}

export declare function parsePermissionMode(arg: string): PermissionMode | undefined;

export declare function gatePermissionToolCall(
	event: ToolCallEvent,
	mode: PermissionMode,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined>;

/** Build the pi-plus-permissions inline extension for a host. */
export declare function createPermissionsExtension(options?: PermissionsExtensionOptions): InlineExtension;

/**
 * Holder the plan extension couples to (see plan/index.ts): embedding hosts
 * (pi-plus-desktop) inject a per-tab state via createPermissionsExtension,
 * and plan-mode engage/exit must read/write THAT holder, because the
 * permissions gate re-syncs the shared plan gate state from its own holder's
 * mode on every tool call — coupling to the module default would let the
 * first tool call silently tear plan mode down. Registered by the factory,
 * last-write-wins; falls back to the module default until one registers.
 */
export declare function setActivePermissionState(
	state: PermissionModeState,
	onModeChange?: (mode: PermissionMode) => void,
): void;
export declare function getActivePermissionState(): PermissionModeState;
/** Mirror a plan-side mode switch into the host UI (the registered onModeChange, if any). */
export declare function notifyActivePermissionModeChange(mode: PermissionMode): void;

/**
 * Pick from a host's dedicated plan-review dialog (pi-plus-desktop renders
 * the plan as markdown with Claude Code style choices). "approveAcceptEdits" /
 * "approveBypass" approve AND select the post-approval permission mode, so
 * the plan runs with the chosen level of automation. undefined = dismissed.
 */
export type PlanReviewDialogChoice = "approveAcceptEdits" | "approveBypass" | "edit" | "stay";

/**
 * Optional ExtensionUIContext extension SDK hosts provide via
 * createPlusUIContext to take over the plan-review presentation.
 */
export interface PlanReviewDialogUI {
	planReview(plan: string): Promise<PlanReviewDialogChoice | undefined>;
}

export interface PlusUIDialogHandlers {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor?(title: string, prefill?: string): Promise<string | undefined>;
	/**
	 * Dedicated plan-review dialog (ExitPlanMode). The host renders the plan
	 * markdown and offers Claude Code style choices; "approveAcceptEdits" /
	 * "approveBypass" approve the plan AND set the post-approval permission
	 * mode. Return undefined when dismissed (stays in plan mode). Omit to fall
	 * back to the plain-text select.
	 */
	planReview?(plan: string): Promise<PlanReviewDialogChoice | undefined>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export declare function createPlusUIContext(handlers: PlusUIDialogHandlers): ExtensionUIContext;

export interface CreatePlusAgentSessionOptions extends CreateAgentSessionOptions {
	extensionFactories?: InlineExtension[];
	ui?: PlusUIDialogHandlers;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
}

export declare function createPlusAgentSession(
	options?: CreatePlusAgentSessionOptions,
): Promise<CreateAgentSessionResult>;

export interface CreatePlusAgentSessionRuntimeOptions extends CreateAgentSessionOptions {
	extensionFactories?: InlineExtension[];
	ui?: PlusUIDialogHandlers;
	/** Overrides the runtime-routed actions (switchSession/fork/newSession/...)
	 *  the factory wires by default, same shape as bindExtensions' binding. */
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: () => void;
	onError?: (error: ExtensionError) => void;
	/** Called after every extension bind: the initial session and each session
	 *  replacement. Re-subscribe to the new session here; the previous
	 *  AgentSession object is disposed after a replacement. */
	onRebind?: (session: AgentSession) => void | Promise<void>;
	/** Project-trust flag for per-cwd SettingsManagers (default true). */
	projectTrusted?: boolean;
	/** Loader passthroughs (additionalSkillPaths, noSkills, systemPrompt, ...)
	 *  applied on every recreation; cwd/agentDir/settingsManager/extensionFactories are owned by the factory. */
	resourceLoaderOptions?: Omit<
		DefaultResourceLoaderOptions,
		"cwd" | "agentDir" | "settingsManager" | "extensionFactories"
	>;
}

/** Runtime-backed createPlusAgentSession: same pi-plus layer and binding rules,
 *  but returns an AgentSessionRuntime with CLI-level session replacement
 *  (/cd, newSession, fork/clone, switchSession). The live session is
 *  `runtime.session` — it changes on every replacement; hosts must NOT call
 *  bindExtensions themselves. */
export declare function createPlusAgentSessionRuntime(
	options?: CreatePlusAgentSessionRuntimeOptions,
): Promise<AgentSessionRuntime>;

/**
 * Profile management: the curated @earendil-works/pi-hub surface bundled into
 * api.js (profiles.json CRUD + per-profile materialized agent dirs). Types are
 * declared inline because pi-hub is not a dependency of this package — keep
 * them in sync with packages/hub/src/types.ts.
 */
export interface Profile {
	provider?: string;
	model?: string;
	models?: string[];
	thinking?: string;
	token?: string;
	url?: string;
	/** Arbitrary settings.json overrides, merged over the source agent settings.
	 *  A null value deletes the key from the materialized settings.json. */
	settings?: Record<string, unknown>;
}

export interface ProfilesData {
	profiles: Record<string, Profile>;
	default?: string;
}

export interface AgentSettingsData {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	skills?: unknown;
	[key: string]: unknown;
}

export declare const THINKING_LEVELS: string[];

/** Source agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent): profiles without an applied profile. */
export declare const AGENT_DIR: string;

export declare function loadProfiles(): ProfilesData;
export declare function findProfile(name: string): Profile | undefined;
export declare function getDefaultProfileName(): string | undefined;
export declare function setDefaultProfile(name: string): void;
export declare function clearDefaultProfile(): void;
/** Select a profile's default model (list position 1, materialized as
 *  settings.defaultModel); adds it when absent. Throws for an unknown profile,
 *  an empty model, or a new model beyond the 3-per-profile bound. */
export declare function setProfileDefaultModel(name: string, model: string): string;
export declare function addProfile(name: string, profile: Profile): void;
/** Append a model to a profile without selecting it; becomes the default when
 *  the profile had no model. Throws for an unknown profile, a duplicate or
 *  empty model, or a fourth model. */
export declare function addProfileModel(name: string, model: string): string;
export declare function updateProfile(name: string, profile: Profile): void;
export declare function removeProfile(name: string): void;
/** Remove a model from a profile; the default promotes to the next remaining
 *  model, and removing the last clears both `models` and `model`. A model not
 *  in the list is a no-op with a message; throws for an unknown profile. */
export declare function removeProfileModel(name: string, model: string): string;
export declare function renameProfile(oldName: string, newName: string): void;
export declare function profileDirFor(name: string): string;
export declare function materializeProfile(name: string, profile: Profile): string;
/** Re-create the shared source→profile links (sessions, extensions, …) for an
 *  already-materialized profile dir. Link-only repair: unlike materializeProfile
 *  it never writes auth.json/settings.json, so it is safe to run at startup for
 *  every stored profile (adopts profile-only content into the source when the
 *  shared dir was never linked). No-op when the dir does not exist. */
export declare function refreshSharedLinks(dir: string): void;
export declare function removeProfileDir(name: string): void;
export declare function syncProfilePackagesToSource(profileDir: string): boolean;

/**
 * Provider login: pi-plus's programmatic provider login bundled into api.js
 * (packages/plus/src/auth/login.ts) — pi's interactive /login equivalent,
 * which pi-plus disables in the TUI. The credential is persisted to
 * <agentDir>/auth.json, the same store pi reads at launch. The auth
 * vocabulary is declared inline because pi-ai is not a dependency of this
 * package — keep it in sync with packages/ai/src/auth/types.ts.
 */
export type AuthType = "api_key" | "oauth";

export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: Record<string, string>;
}

export interface OAuthCredential {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

export type Credential = ApiKeyCredential | OAuthCredential;

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
}

export interface LoginProviderOptions {
	/** Agent dir whose auth.json stores the credential. Defaults to the active agent dir. */
	agentDir?: string;
	/** Flow UI callbacks. Defaults to a terminal interaction (stdin prompts + browser). */
	interaction?: AuthInteraction;
	/** Cancels the flow. */
	signal?: AbortSignal;
	/** Force a login method; defaults to oauth when the provider offers it, then api_key. */
	method?: AuthType;
}

export declare function loginProvider(providerId: string, options?: LoginProviderOptions): Promise<Credential>;

/** Readline-based AuthInteraction for terminal use (prompts on stdin, auth URLs opened in the browser). */
export declare function createTerminalAuthInteraction(): AuthInteraction;

// ---------------------------------------------------------------------------
// pi-plus settings store — the `piPlus` block of the base agent
// ~/.pi/agent/settings.json (resolved through the hub-profile layering, so CLI
// and embedded hosts share exactly one store). Auto-compaction threshold
// percent, context floor buffer and context window cap are the typed keys;
// readPiPlusSettings/updatePiPlusSettings expose the block generically for
// host-owned keys (e.g. a desktop app's defaultPermissionMode, theme, sidebar
// width). Re-exported from packages/plus/src/context/plus-settings.ts; the
// runtime bundle inlines the module.
// ---------------------------------------------------------------------------

export interface PlusSettings {
	/** Percent (1-100) of the effective context window at which auto-compaction triggers. */
	autoCompactThresholdPercent?: number;
	/** Minimum floor buffer (tokens) for the effective context window (>= 13000). */
	contextFloorTokens?: number;
	/** Cap (tokens >= 32768) on the context window used for auto-compact math. */
	contextWindowCapTokens?: number;
}

/** Raw piPlus block including host-owned keys; {} when absent or malformed. */
export declare function readPiPlusSettings(): Record<string, unknown>;
/** Merge keys into the piPlus block under the settings-file lock; a key set to
 *  undefined is deleted; all other settings.json content is preserved. */
export declare function updatePiPlusSettings(patch: Record<string, unknown | undefined>): void;

/** Default threshold: 80% of the effective context window. */
export declare const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT: number;
export declare function getAutoCompactThresholdPercent(): number;
/** Persist a choice; undefined resets to the default (deletes the key). */
export declare function setAutoCompactThresholdPercent(percent: number | undefined): void;
export declare function formatAutoCompactThresholdPercent(percent: number): string;
export declare function parseAutoCompactThresholdChoice(choice: string): number;

/** Default/built-in minimum context floor buffer. */
export declare const DEFAULT_CONTEXT_FLOOR_TOKENS: number;
export declare const MIN_CONTEXT_FLOOR_TOKENS: number;
export declare function getContextFloorTokens(): number;
export declare function setContextFloorTokens(tokens: number | undefined): void;
export declare function formatContextFloorTokens(tokens: number): string;
export declare function parseContextFloorChoice(choice: string): number;

/** Lowest accepted context window cap; undefined means no cap. */
export declare const MIN_CONTEXT_WINDOW_CAP_TOKENS: number;
export declare function getContextWindowCapTokens(): number | undefined;
export declare function setContextWindowCapTokens(tokens: number | undefined): void;
export declare function formatContextWindowCapTokens(tokens: number | undefined): string;
export declare function parseContextWindowCapChoice(choice: string): number | undefined;
