/**
 * Ollama Web Search API adapter (ported from openclaude, simplified).
 *
 * A local/hosted Ollama server configured via OLLAMA_BASE_URL proxies search
 * through its experimental local endpoint; OLLAMA_API_KEY enables the hosted
 * ollama.com endpoint as a second target. openclaude's extra detection of
 * Claude-Code-specific OpenAI routing env vars is dropped — pi-plus keys only
 * off the OLLAMA_* vars.
 */

import { fetchJsonWithWebSearchTimeout } from "../timeout.ts";
import type { ProviderOutput, SearchInput, SearchProvider } from "../types.ts";
import { applyDomainFilters, safeHostname } from "../types.ts";

const OLLAMA_HOSTED_WEB_SEARCH_URL = "https://ollama.com/api/web_search";

type OllamaSearchTarget = {
	label: string;
	url: string;
	authorization?: string;
};

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function getUsableOllamaBaseUrlEnvValue(value: string | undefined): string | undefined {
	const trimmed = nonEmpty(value);
	if (!trimmed) return undefined;
	const normalized = trimmed.toLowerCase();
	return normalized === "undefined" || normalized === "null" ? undefined : trimmed;
}

/** Trim a secret and reject placeholder-ish values (openclaude's sanitizeApiKey). */
export function sanitizeApiKey(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "null" || lower === "undefined" || lower === "sua_chave") return undefined;
	return trimmed;
}

export function getUsableOllamaApiKey(value: string | undefined): string | undefined {
	return sanitizeApiKey(value)?.trim();
}

function normalizeOllamaApiBaseUrl(value: string): string {
	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("configured endpoint is not a valid HTTP(S) URL");
	}
	const pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.pathname = pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname || "/";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function getSearchTargets(): {
	targets: OllamaSearchTarget[];
	errors: string[];
} {
	const targets: OllamaSearchTarget[] = [];
	const errors: string[] = [];
	const localBaseUrl = getUsableOllamaBaseUrlEnvValue(process.env.OLLAMA_BASE_URL);
	const apiKey = getUsableOllamaApiKey(process.env.OLLAMA_API_KEY);

	if (localBaseUrl) {
		try {
			targets.push({
				label: "local",
				url: `${normalizeOllamaApiBaseUrl(localBaseUrl)}/api/experimental/web_search`,
			});
		} catch {
			errors.push("local: configured endpoint is not a valid HTTP(S) URL");
		}
	}

	if (apiKey) {
		targets.push({
			label: "hosted",
			url: OLLAMA_HOSTED_WEB_SEARCH_URL,
			authorization: `Bearer ${apiKey}`,
		});
	}

	return { targets, errors };
}

export const ollamaProvider: SearchProvider = {
	name: "ollama",

	isConfigured() {
		return getSearchTargets().targets.length > 0;
	},

	async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
		const start = performance.now();
		const { targets, errors } = getSearchTargets();

		if (targets.length === 0) {
			if (errors.length > 0) {
				throw new Error(`Ollama web search failed (${errors.join("; ")})`);
			}
			throw new Error("Ollama search requires OLLAMA_BASE_URL or OLLAMA_API_KEY.");
		}

		for (const [targetIndex, target] of targets.entries()) {
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (target.authorization) {
					headers.Authorization = target.authorization;
				}

				const data = await fetchJsonWithWebSearchTimeout(
					target.url,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							query: input.query,
							max_results: 10,
						}),
					},
					signal,
					{ providerName: `Ollama ${target.label}` },
				);

				const rawResults = data && typeof data === "object" && "results" in data ? data.results : undefined;
				if (!Array.isArray(rawResults)) {
					throw new Error("response did not contain a results array");
				}

				const hits = rawResults
					.filter(
						(result: unknown): result is Record<string, unknown> => Boolean(result) && typeof result === "object",
					)
					.map((result) => {
						const title = typeof result.title === "string" ? result.title : "";
						const url = typeof result.url === "string" ? result.url : "";
						const content = typeof result.content === "string" ? result.content : undefined;
						return {
							title: title || url,
							url,
							description: content,
							source: safeHostname(url),
						};
					})
					.filter((hit) => Boolean(hit.title && hit.url));

				if (hits.length === 0 && targetIndex < targets.length - 1) {
					throw new Error("response contained no usable results");
				}

				return {
					hits: applyDomainFilters(hits, input),
					providerName: "ollama",
					durationSeconds: (performance.now() - start) / 1000,
				};
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				errors.push(`${target.label}: ${message}`);
			}
		}

		throw new Error(`Ollama web search failed (${errors.join("; ")})`);
	},
};
