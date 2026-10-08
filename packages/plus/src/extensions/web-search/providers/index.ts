/**
 * Provider registry and selection logic (ported from openclaude's
 * src/tools/WebSearchTool/providers/index.ts, minus the native
 * Anthropic/Codex server-side search path — pi-plus only runs adapters).
 *
 * WEB_SEARCH_PROVIDER controls which backend to use:
 *
 *   "auto"      (default) — try providers in priority order, fall through on failure
 *   "custom"    — use WEB_SEARCH_API / WEB_PROVIDER preset only (fail loudly)
 *   "ollama"    — use Ollama local/hosted Web Search API only (fail loudly)
 *   "firecrawl" — use Firecrawl only (fail loudly)
 *   "tavily"    — use Tavily only (fail loudly)
 *   "exa"       — use Exa only (fail loudly)
 *   "you"       — use You.com only (fail loudly)
 *   "jina"      — use Jina only (fail loudly)
 *   "brave"     — use Brave only (fail loudly)
 *   "bing"      — use Bing only (fail loudly)
 *   "mojeek"    — use Mojeek only (fail loudly)
 *   "linkup"    — use Linkup only (fail loudly)
 *   "ddg"       — use DuckDuckGo only (fail loudly)
 *
 * "auto" mode is the only mode that silently falls through to the next
 * provider. All other modes throw on failure — no silent backend switching.
 *
 * NOTE: "custom" is NOT included in the "auto" fallback chain. It is only used
 *       when WEB_SEARCH_PROVIDER=custom is explicitly selected. This prevents
 *       the generic outbound provider from silently becoming the default backend.
 */

import type { ProviderOutput, SearchInput, SearchProvider } from "../types.ts";
import { bingProvider } from "./bing.ts";
import { braveProvider } from "./brave.ts";
import { customProvider } from "./custom.ts";
import { duckduckgoProvider } from "./duckduckgo.ts";
import { exaProvider } from "./exa.ts";
import { firecrawlProvider } from "./firecrawl.ts";
import { jinaProvider } from "./jina.ts";
import { linkupProvider } from "./linkup.ts";
import { mojeekProvider } from "./mojeek.ts";
import { ollamaProvider } from "./ollama.ts";
import { tavilyProvider } from "./tavily.ts";
import { youProvider } from "./you.ts";

export {
	applyDomainFilters,
	hostMatchesDomain,
	normalizeHit,
	type ProviderOutput,
	type SearchHit,
	type SearchInput,
	type SearchProvider,
	safeHostname,
} from "../types.ts";
export { extractHits } from "./custom.ts";

// ---------------------------------------------------------------------------
// All registered providers — order matters for auto mode
// ---------------------------------------------------------------------------
// Priority: ollama → firecrawl → tavily → exa → you → jina → brave → bing → mojeek → linkup → ddg
// DDG is last because it's free but rate-limited.
// Brave sits ahead of Bing because it runs an independent index (not Google/Bing
// dependent) and has a usable free tier; Bing's hosted API was sunsetted in 2025
// for new users, so it's a worse fallback in practice.

const ALL_PROVIDERS: SearchProvider[] = [
	ollamaProvider,
	firecrawlProvider,
	tavilyProvider,
	exaProvider,
	youProvider,
	jinaProvider,
	braveProvider,
	bingProvider,
	mojeekProvider,
	linkupProvider,
	duckduckgoProvider,
];

export function getAvailableProviders(): SearchProvider[] {
	return ALL_PROVIDERS.filter((p) => p.isConfigured());
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type ProviderMode =
	| "auto"
	| "custom"
	| "ollama"
	| "firecrawl"
	| "ddg"
	| "tavily"
	| "exa"
	| "you"
	| "jina"
	| "brave"
	| "bing"
	| "mojeek"
	| "linkup";

const PROVIDER_BY_NAME: Record<string, SearchProvider> = {
	custom: customProvider,
	ollama: ollamaProvider,
	firecrawl: firecrawlProvider,
	ddg: duckduckgoProvider,
	tavily: tavilyProvider,
	exa: exaProvider,
	you: youProvider,
	jina: jinaProvider,
	brave: braveProvider,
	bing: bingProvider,
	mojeek: mojeekProvider,
	linkup: linkupProvider,
};

const VALID_MODES = new Set<string>(Object.keys(PROVIDER_BY_NAME).concat(["auto"]));

export function getProviderMode(env: NodeJS.ProcessEnv = process.env): ProviderMode {
	const raw = env.WEB_SEARCH_PROVIDER ?? "auto";
	if (VALID_MODES.has(raw)) return raw as ProviderMode;
	return "auto";
}

/**
 * Returns the list of providers to try, in order.
 * - Specific mode → single provider
 * - Auto → priority order (ALL_PROVIDERS, filtered by isConfigured)
 */
export function getProviderChain(mode: ProviderMode): SearchProvider[] {
	if (mode === "auto") {
		return ALL_PROVIDERS.filter((p) => p.isConfigured());
	}
	const provider = PROVIDER_BY_NAME[mode];
	if (!provider) return [];
	return [provider];
}

/**
 * Run a search using the configured provider chain.
 *
 * - Auto mode: tries each provider in order, falls through on failure.
 *   If ALL providers fail, throws the last error.
 * - Specific mode: runs the single provider, throws immediately on failure.
 */
export async function runSearch(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
	return runSearchChain(getProviderChain(getProviderMode()), getProviderMode(), input, signal);
}

/** Exposed for tests: runSearch over an explicit chain/mode. */
export async function runSearchChain(
	chain: SearchProvider[],
	mode: ProviderMode,
	input: SearchInput,
	signal?: AbortSignal,
): Promise<ProviderOutput> {
	if (chain.length === 0) {
		throw new Error(`No search providers available for mode "${mode}". Check your env vars.`);
	}

	const errors: Error[] = [];

	// Explicit provider mode: fail fast if the provider isn't configured
	if (mode !== "auto") {
		const provider = chain[0];
		if (provider && !provider.isConfigured()) {
			throw new Error(
				`Search provider "${mode}" is not configured. ` +
					`Set the required environment variable (e.g. ${mode.toUpperCase()}_API_KEY) ` +
					`or switch to WEB_SEARCH_PROVIDER=auto.`,
			);
		}
	}

	for (const provider of chain) {
		try {
			return await provider.search(input, signal);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));

			// Cancellation must stop immediately — don't fall through to other providers
			if (error.name === "AbortError" || signal?.aborted) {
				throw error;
			}

			errors.push(error);

			// Specific mode: fail loudly, no fallback
			if (mode !== "auto") {
				throw error;
			}

			// Auto mode: log and try next
			console.error(`[web-search] ${provider.name} failed: ${error.message}`);
		}
	}

	// All providers failed in auto mode
	const lastErr = errors[errors.length - 1];
	if (!lastErr) throw new Error("All search providers failed with no error details.");
	if (errors.length === 1) throw lastErr;
	throw new Error(
		`All ${errors.length} search providers failed:\n` +
			errors.map((e, i) => `  ${String(i + 1)}. ${e.message}`).join("\n"),
	);
}
