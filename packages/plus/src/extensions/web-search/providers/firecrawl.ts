/**
 * Firecrawl Search adapter.
 */

import { firecrawlSearch } from "../firecrawl-client.ts";
import { withWebSearchTimeout } from "../timeout.ts";
import type { ProviderOutput, SearchInput, SearchProvider } from "../types.ts";
import { applyDomainFilters } from "../types.ts";

export const firecrawlProvider: SearchProvider = {
	name: "firecrawl",

	isConfigured() {
		return Boolean(process.env.FIRECRAWL_API_KEY) || Boolean(process.env.FIRECRAWL_API_URL);
	},

	async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
		const start = performance.now();
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let query = input.query;
		if (input.blocked_domains?.length) {
			const exclusions = input.blocked_domains.map((d) => `-site:${d}`).join(" ");
			query = `${query} ${exclusions}`;
		}

		const data = await withWebSearchTimeout(
			(combinedSignal) =>
				firecrawlSearch(query, {
					apiKey: process.env.FIRECRAWL_API_KEY,
					apiUrl: process.env.FIRECRAWL_API_URL,
					limit: 15,
					signal: combinedSignal,
				}),
			signal,
			{ providerName: "Firecrawl" },
		);

		const hits = applyDomainFilters(
			(data.web ?? []).map((r) => ({
				// Firecrawl search descriptions carry <em> highlight markup.
				title: decodeIfHighlighted(r.title ?? r.url),
				url: r.url,
				description: r.description ? decodeIfHighlighted(r.description) : undefined,
			})),
			input,
		);

		return {
			hits,
			providerName: "firecrawl",
			durationSeconds: (performance.now() - start) / 1000,
		};
	},
};

function decodeIfHighlighted(text: string): string {
	return text.replace(/<\/?em>/gi, "");
}
