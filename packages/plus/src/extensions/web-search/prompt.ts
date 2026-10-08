/**
 * Prompt text for the WebSearch / WebFetch tools (adapted from openclaude's
 * WebSearchTool/prompt.ts). openclaude's native-backend "US only" caveat is
 * dropped — pi-plus always runs adapter backends.
 */

export const WEB_SEARCH_TOOL_NAME = "WebSearch";
export const WEB_FETCH_TOOL_NAME = "WebFetch";
export const WEB_SEARCH_SECTION_NAME = "web-search";

/** "October 2026" style stamp — refreshes every agent start, keeps queries current. */
export function getCurrentMonthYear(now: Date = new Date()): string {
	return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export const WEB_SEARCH_SNIPPET =
	"- WebSearch({ query, allowed_domains?, blocked_domains? }) — search the web for current information; cite the returned sources";

export const WEB_FETCH_SNIPPET = "- WebFetch({ url, prompt? }) — fetch a URL and read its content as text";

export function buildWebSearchSection(now: Date = new Date()): string {
	const currentMonthYear = getCurrentMonthYear(now);
	return (
		"Web search: use WebSearch for information beyond your knowledge cutoff (current events, recent releases, " +
		"documentation). Searches run through a local search backend (DuckDuckGo by default; an API-key provider " +
		"like TAVILY_API_KEY / BRAVE_API_KEY improves reliability).\n" +
		'After answering with WebSearch results, you MUST include a "Sources:" section at the end of your response ' +
		"listing the relevant URLs as markdown hyperlinks: [Title](URL). Never skip it.\n" +
		`IMPORTANT - Use the correct year in search queries: the current month is ${currentMonthYear}. ` +
		"When searching for recent information, documentation, or current events, use this year, NOT last year " +
		'(e.g. search "React documentation 2026" style queries, not older years).\n' +
		"WebFetch({ url, prompt? }) reads a single page as text; use it to follow up on search hits. " +
		"It fails for authenticated or private URLs (Google Docs, Confluence, Jira) — no credentials are sent."
	);
}
