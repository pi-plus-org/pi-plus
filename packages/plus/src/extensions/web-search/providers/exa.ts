/**
 * Exa Search API adapter.
 * POST https://api.exa.ai/search
 * Auth: x-api-key: <key>
 *
 * Canonical reference:
 *   https://docs.exa.ai/reference/search-api-guide-for-coding-agents
 *
 * We request `contents.highlights: true` because the Exa docs explicitly
 * recommend highlights for agent workflows (10x fewer tokens than full text,
 * with the most query-relevant excerpts). Without `contents`, Exa returns
 * results with no excerpts at all — descriptions would be empty for every hit.
 */

import { fetchJsonWithWebSearchTimeout } from "../timeout.ts";
import type { ProviderOutput, SearchInput, SearchProvider } from "../types.ts";
import { safeHostname } from "../types.ts";

/** Join up to 3 highlight excerpts with an ellipsis separator. */
function describeFromHighlights(r: unknown): string | undefined {
	if (!r || typeof r !== "object") return undefined;
	const rec = r as Record<string, unknown>;
	const highlights = Array.isArray(rec.highlights) ? rec.highlights : null;
	if (highlights && highlights.length > 0) {
		return (highlights as unknown[])
			.slice(0, 3)
			.filter((s): s is string => typeof s === "string")
			.join(" … ");
	}
	if (typeof rec.text === "string" && rec.text) return rec.text;
	return undefined;
}

export const exaProvider: SearchProvider = {
	name: "exa",

	isConfigured() {
		return Boolean(process.env.EXA_API_KEY);
	},

	async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
		const start = performance.now();

		const body: Record<string, unknown> = {
			query: input.query,
			numResults: 15,
			type: "auto",
			contents: { highlights: true },
		};

		if (input.allowed_domains?.length) body.includeDomains = input.allowed_domains;
		if (input.blocked_domains?.length) body.excludeDomains = input.blocked_domains;

		const data = (await fetchJsonWithWebSearchTimeout(
			"https://api.exa.ai/search",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": process.env.EXA_API_KEY!,
				},
				body: JSON.stringify(body),
			},
			signal,
			{ providerName: "Exa" },
		)) as { results?: unknown };

		const results = Array.isArray(data.results) ? data.results : [];
		const hits = (results as unknown[]).map((r) => {
			const rec = (r ?? {}) as Record<string, unknown>;
			const hitUrl = typeof rec.url === "string" ? rec.url : "";
			return {
				title: typeof rec.title === "string" ? rec.title : "",
				url: hitUrl,
				description: describeFromHighlights(r),
				source: hitUrl ? safeHostname(hitUrl) : undefined,
			};
		});

		return {
			// Exa handles domain filtering server-side via includeDomains/excludeDomains
			hits,
			providerName: "exa",
			durationSeconds: (performance.now() - start) / 1000,
		};
	},
};
