/**
 * Bing Web Search API adapter.
 * GET https://api.bing.microsoft.com/v7.0/search?q=...
 * Auth: Ocp-Apim-Subscription-Key: <key>
 */

import { fetchJsonWithWebSearchTimeout } from "../timeout.ts";
import type { ProviderOutput, SearchInput, SearchProvider } from "../types.ts";
import { applyDomainFilters } from "../types.ts";

export const bingProvider: SearchProvider = {
	name: "bing",

	isConfigured() {
		return Boolean(process.env.BING_API_KEY);
	},

	async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
		const start = performance.now();

		const url = new URL("https://api.bing.microsoft.com/v7.0/search");
		url.searchParams.set("q", input.query);
		url.searchParams.set("count", "15");

		const data = (await fetchJsonWithWebSearchTimeout(
			url.toString(),
			{
				headers: { "Ocp-Apim-Subscription-Key": process.env.BING_API_KEY! },
			},
			signal,
			{ providerName: "Bing" },
		)) as { webPages?: { value?: unknown } } | undefined;

		const rawResults = data?.webPages?.value;
		const results = Array.isArray(rawResults) ? rawResults : [];
		const hits = (results as unknown[]).map((r) => {
			const rec = (r ?? {}) as Record<string, unknown>;
			return {
				title: typeof rec.name === "string" ? rec.name : "",
				url: typeof rec.url === "string" ? rec.url : "",
				description: typeof rec.snippet === "string" ? rec.snippet : undefined,
				source: typeof rec.displayUrl === "string" ? rec.displayUrl : undefined,
			};
		});

		return {
			hits: applyDomainFilters(hits, input),
			providerName: "bing",
			durationSeconds: (performance.now() - start) / 1000,
		};
	},
};
