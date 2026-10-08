/**
 * pi-plus-web-search: WebSearch + WebFetch tools, ported from openclaude's
 * WebSearchTool / WebFetchTool (adapter backends only — no native
 * Anthropic/Codex server-side search).
 *
 * WebSearch runs the query through the configured provider chain
 * (WEB_SEARCH_PROVIDER=auto by default: ollama → firecrawl → tavily → exa →
 * you → jina → brave → bing → mojeek → linkup → DuckDuckGo, keyless fallback
 * last) and returns snippets + links with a mandatory-citation reminder.
 * WebFetch reads a single URL as plain text (or Firecrawl markdown when
 * configured), guarding against http/private-address targets.
 *
 * Backend env vars mirror openclaude: TAVILY_API_KEY, BRAVE_API_KEY,
 * EXA_API_KEY, YOU_API_KEY, JINA_API_KEY, BING_API_KEY, MOJEEK_API_KEY,
 * LINKUP_API_KEY, FIRECRAWL_API_KEY/FIRECRAWL_API_URL, OLLAMA_BASE_URL/
 * OLLAMA_API_KEY, WEB_SEARCH_API/WEB_PROVIDER (custom), WEB_SEARCH_PROVIDER
 * (mode), WEB_SEARCH_TIMEOUT_SEC.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { fetchUrlContent } from "./fetch-page.ts";
import { buildSearchDetails, formatSearchResultText } from "./format.ts";
import {
	buildWebSearchSection,
	WEB_FETCH_SNIPPET,
	WEB_FETCH_TOOL_NAME,
	WEB_SEARCH_SECTION_NAME,
	WEB_SEARCH_SNIPPET,
	WEB_SEARCH_TOOL_NAME,
} from "./prompt.ts";
import { runSearch } from "./providers/index.ts";
import { WebFetchParams, WebSearchParams } from "./tools.ts";

/** Human-readable byte count for the fetch result header. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${String(bytes)} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hostnameFor(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export function registerWebSearch(pi: ExtensionAPI): void {
	// Guidance the tool descriptions can't carry: mandatory Sources section +
	// current-year hint (refreshed on every agent start).
	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.sections[WEB_SEARCH_SECTION_NAME] = buildWebSearchSection();
	});

	pi.registerTool({
		name: WEB_SEARCH_TOOL_NAME,
		label: "Web Search",
		description:
			"Search the web and return titles, URLs, and snippets. Use for current events, recent releases, " +
			"and documentation beyond the knowledge cutoff. Always include the returned sources as markdown " +
			"links in the answer. Use the current year for recent information.",
		promptSnippet: WEB_SEARCH_SNIPPET,
		parameters: WebSearchParams,
		executionMode: "parallel",
		annotations: { readOnlyHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("Missing query");
			if (params.allowed_domains?.length && params.blocked_domains?.length) {
				throw new Error("Cannot specify both allowed_domains and blocked_domains in the same request");
			}

			const output = await runSearch(
				{ query, allowed_domains: params.allowed_domains, blocked_domains: params.blocked_domains },
				signal ?? undefined,
			);
			return {
				content: [{ type: "text" as const, text: formatSearchResultText(output, query) }],
				details: buildSearchDetails(output, query),
			};
		},

		renderCall(args, theme, _context) {
			const text =
				theme.fg("toolTitle", theme.bold(`${WEB_SEARCH_TOOL_NAME} `)) + theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as
				| { hits: unknown[]; durationSeconds: number; providerName: string }
				| undefined;
			const count = details ? details.hits.length : 0;
			const suffix = details ? ` in ${details.durationSeconds.toFixed(2)}s via ${details.providerName}` : "";
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", `${String(count)} results${suffix}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: WEB_FETCH_TOOL_NAME,
		label: "Web Fetch",
		description:
			"Fetch content from a URL and return it as readable text. " +
			"IMPORTANT: this tool will fail for authenticated or private URLs (Google Docs, Confluence, Jira, " +
			"private GitHub) — no credentials are sent; use a specialized MCP tool instead. " +
			"Follow cross-host redirects it reports by calling WebFetch again with the redirect URL.",
		promptSnippet: WEB_FETCH_SNIPPET,
		parameters: WebFetchParams,
		executionMode: "parallel",
		annotations: { readOnlyHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const url = params.url.trim();
			if (url.length === 0) throw new Error("Missing url");
			const start = performance.now();
			const result = await fetchUrlContent(url, signal ?? undefined);
			const durationMs = performance.now() - start;

			if (result.redirect) {
				const { originalUrl, redirectUrl, statusCode } = result.redirect;
				const statusText =
					statusCode === 301
						? "Moved Permanently"
						: statusCode === 308
							? "Permanent Redirect"
							: statusCode === 307
								? "Temporary Redirect"
								: "Found";
				const message =
					`REDIRECT DETECTED: The URL redirects to a different host.\n\n` +
					`Original URL: ${originalUrl}\n` +
					`Redirect URL: ${redirectUrl}\n` +
					`Status: ${String(statusCode)} ${statusText}\n\n` +
					`To complete your request, call WebFetch again with url: "${redirectUrl}" and the same prompt.`;
				return {
					content: [{ type: "text" as const, text: message }],
					details: { url: originalUrl, statusCode, redirect: redirectUrl, durationMs },
				};
			}

			const page = result.page;
			let header = `Fetched ${formatBytes(page.bytes)} from ${hostnameFor(page.url)} (HTTP ${String(page.statusCode)} ${page.statusText})`;
			if (page.truncated) header += " — content truncated";
			const focus = params.prompt ? `Looking for: ${params.prompt}\n` : "";
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${focus}${page.text}` }],
				details: {
					url: page.url,
					statusCode: page.statusCode,
					bytes: page.bytes,
					truncated: page.truncated,
					markdown: page.markdown,
					durationMs,
				},
			};
		},

		renderCall(args, theme, _context) {
			const text = `${theme.fg("toolTitle", theme.bold(`${WEB_FETCH_TOOL_NAME} `))}${theme.fg("accent", hostnameFor(args.url))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as { bytes: number; url: string; redirect?: string } | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.redirect) {
				return new Text(
					`${theme.fg("warning", "↪ ")}${theme.fg("muted", `redirects to ${hostnameFor(details.redirect)}`)}`,
					0,
					0,
				);
			}
			return new Text(
				`${theme.fg("success", "✓ ")}${theme.fg("muted", `${formatBytes(details.bytes)} from ${hostnameFor(details.url)}`)}`,
				0,
				0,
			);
		},
	});
}
