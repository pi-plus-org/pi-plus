/**
 * Search result formatting for the WebSearch tool (adapts openclaude's
 * formatProviderOutput + mapToolResultToToolResultBlockParam into a single
 * text block for pi's AgentToolResult).
 */

import type { ProviderOutput, SearchHit } from "./types.ts";

export interface WebSearchDetails {
	query: string;
	providerName: string;
	durationSeconds: number;
	hits: SearchHit[];
}

/**
 * Actionable note appended when a backend returned 0 hits — most often
 * DuckDuckGo blocking the network rather than genuinely finding nothing.
 */
export function buildEmptyResultHint(providerName: string): string {
	return (
		`No results from "${providerName}" search backend. ` +
		`The default DuckDuckGo backend is rate-limited from many networks (datacenter IPs, VPNs, repeated requests) and returns 0 results when blocked. ` +
		`For reliable web search, set one of: ` +
		`OLLAMA_BASE_URL, OLLAMA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, JINA_API_KEY, BING_API_KEY, MOJEEK_API_KEY, LINKUP_API_KEY, YOU_API_KEY, BRAVE_API_KEY.`
	);
}

/** Render the tool result text the model sees for a search. */
export function formatSearchResultText(po: ProviderOutput, query: string): string {
	const duration = po.durationSeconds.toFixed(2);

	if (po.hits.length === 0) {
		return `Web search results for query: "${query}" (0 hits in ${duration}s via ${po.providerName})\n\n${buildEmptyResultHint(po.providerName)}`;
	}

	let text = `Web search results for query: "${query}" (${String(po.hits.length)} hits in ${duration}s via ${po.providerName})\n\n`;

	const snippets = po.hits
		.filter((h) => h.description)
		.map((h) => `**${h.title}** — ${h.description} (${h.url})`)
		.join("\n\n");
	if (snippets) text += `${snippets}\n\n`;

	const links = po.hits.map((h) => ({ title: h.title, url: h.url }));
	text += `Links: ${JSON.stringify(links)}\n\n`;

	text += "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";
	return text;
}

export function buildSearchDetails(po: ProviderOutput, query: string): WebSearchDetails {
	return {
		query,
		providerName: po.providerName,
		durationSeconds: po.durationSeconds,
		hits: po.hits,
	};
}
