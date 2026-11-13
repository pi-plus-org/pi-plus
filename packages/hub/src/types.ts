/**
 * settings.json keys that are profile-scoped: only these persist in a profile's
 * settings.json (besides the profile's own `settings` overrides and the
 * dedicated provider/model/thinking declarations). Everything else is general
 * and lives in the agent settings.json, which pi now reads live at runtime
 * under a profile (layering implemented in
 * packages/plus/src/coding-agent/core/settings-manager.ts — keep the two lists
 * in sync; hub stays dependency-free so this cannot be shared).
 * `enabledModels` belongs here because the model scope is derived from the
 * profile's declared models: a profile that does not own the key would let a
 * stale agent-layer scope (left behind by an earlier profile) outrank its
 * `defaultModel` at startup — pi's initial model selection prefers the first
 * scoped model over the saved default.
 */
export const PROFILE_SETTINGS_KEYS: string[] = [
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"enabledModels",
];

/** True when a settings key is profile-scoped (stays in the profile layer, never migrates to the agent settings). */
export function isProfileScopedSettingsKey(key: string): boolean {
	return PROFILE_SETTINGS_KEYS.includes(key);
}

/**
 * A custom model definition, written verbatim into the profile's models.json as a
 * `providers.<provider>.models` entry (pi's ModelDefinition). Unknown keys are passed
 * through, so any field pi accepts (api, baseUrl, headers, compat, cost, …) can be used.
 * Models not in pi's built-in catalog are still acceptable: pi applies defaults
 * (contextWindow 128000, maxTokens 16384, reasoning false) and the provider supplies
 * the API dialect.
 */
export interface CustomModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
}

/** Model list entry: a catalog model id, or a custom model definition. */
export type ModelEntry = string | CustomModel;

/** The model id of a model list entry. */
export function modelId(entry: ModelEntry): string {
	return typeof entry === "string" ? entry : entry.id;
}

/**
 * Dependency a host injects so hub can classify plain model ids: returns the
 * subset of the given ids that the host's pi catalog does not know.
 */
export type UnknownModelChecker = (modelIds: string[]) => Promise<string[]>;

export interface Profile {
	provider?: string;
	model?: string;
	models?: ModelEntry[];
	thinking?: string;
	token?: string;
	url?: string;
	/** Arbitrary settings.json overrides, written into the profile settings.json
	 *  where they win over the agent settings at runtime. A null value deletes
	 *  the key from the materialized settings.json. */
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

export interface AuthEntry {
	type: string;
	key?: string;
	[key: string]: unknown;
}

export interface AuthData {
	[provider: string]: AuthEntry | undefined;
}

export interface ModelsFileData {
	providers: Record<string, { baseUrl?: string; [key: string]: unknown }>;
}

// Known pi provider ids (from pi-coding-agent docs/providers.md). Warn-only:
// unknown ids are allowed because pi supports custom providers via models.json.
export const PI_PROVIDERS: string[] = [
	"anthropic",
	"ant-ling",
	"azure-openai-responses",
	"openai",
	"deepseek",
	"nvidia",
	"google",
	"amazon-bedrock",
	"mistral",
	"groq",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"xai",
	"openrouter",
	"vercel-ai-gateway",
	"zai",
	"zai-coding-cn",
	"opencode",
	"opencode-go",
	"radius",
	"huggingface",
	"fireworks",
	"together",
	"baseten",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"qwen-token-plan",
	"qwen-token-plan-intl",
	"qwen-token-plan-individual",
	"qwen-token-plan-cn",
	"xiaomi",
	"xiaomi-cn",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
	"moonshotai",
	"moonshotai-cn",
];

export const THINKING_LEVELS: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
