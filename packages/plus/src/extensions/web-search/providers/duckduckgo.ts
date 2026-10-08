/**
 * DuckDuckGo adapter — dependency-free HTML scraper.
 *
 * openclaude uses the `duck-duck-scrape` npm package; pi-plus adds no npm
 * deps, so this scrapes DDG's dedicated HTML endpoint
 * (https://html.duckduckgo.com/html/) with built-in fetch and regex parsing.
 * The endpoint is meant for no-JS clients, so the markup is stable enough for
 * pattern matching: each result is a `result__a` title anchor (wrapped in a
 * `/l/?uddg=<encoded>` redirect) plus a `result__snippet` anchor.
 *
 * DuckDuckGo's HTML endpoint aggressively blocks datacenter / repeat IPs with
 * an "anomaly in the request" response; we retry with backoff and surface an
 * actionable error when blocked.
 */

import { decodeEntities, stripTags } from "../html.ts";
import { isWebSearchTimeoutError, toAbortError, withWebSearchTimeout } from "../timeout.ts";
import type { ProviderOutput, SearchHit, SearchInput, SearchProvider } from "../types.ts";
import { applyDomainFilters } from "../types.ts";

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
// DDG serves different markup to unknown clients; a browser UA keeps us on
// the standard html-layout path.
const DDG_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DDG_ANOMALY_HINT =
	"DuckDuckGo scraping is rate-limited from this network. " +
	"Configure a search backend with one of: " +
	"OLLAMA_BASE_URL, OLLAMA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, YOU_API_KEY, " +
	"JINA_API_KEY, BING_API_KEY, MOJEEK_API_KEY, LINKUP_API_KEY, BRAVE_API_KEY.";

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function isAnomalyError(message: string): boolean {
	return /anomaly in the request|likely making requests too quickly/i.test(message);
}

function isRetryableDDGError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (isWebSearchTimeoutError(err)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("anomaly") ||
		msg.includes("too quickly") ||
		msg.includes("rate limit") ||
		msg.includes("timeout") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("econnaborted")
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(toAbortError(signal.reason));
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(toAbortError(signal?.reason));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Unwrap DDG's `/l/?uddg=<encoded>` redirect links to the real target URL. */
export function unwrapDuckDuckGoHref(href: string): string {
	const clean = decodeEntities(href.trim());
	const absolute = clean.startsWith("//") ? `https:${clean}` : clean;
	try {
		const parsed = new URL(absolute, DDG_ENDPOINT);
		// The wrapper appears both protocol-relative (duckduckgo.com) and
		// path-relative on the html.* host; unwrap either.
		const isDdgHost = parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com");
		if (isDdgHost && parsed.pathname.startsWith("/l/")) {
			const target = parsed.searchParams.get("uddg");
			if (target) return target;
		}
		// Return the resolved URL so path-relative hrefs don't leak through unresolved.
		return parsed.toString();
	} catch {
		return absolute;
	}
}

/** Parse the html.duckduckgo.com results page into search hits. */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
	const titleRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe =
		/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>|<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

	const titles: { url: string; title: string }[] = [];
	for (const match of html.matchAll(titleRe)) {
		const title = decodeEntities(
			stripTags(match[2] ?? "")
				.replace(/\s+/g, " ")
				.trim(),
		);
		const url = unwrapDuckDuckGoHref(match[1] ?? "");
		if (title && url) titles.push({ title, url });
	}

	const snippets: string[] = [];
	for (const match of html.matchAll(snippetRe)) {
		const inner = match[1] ?? match[2] ?? "";
		snippets.push(decodeEntities(stripTags(inner).replace(/\s+/g, " ").trim()));
	}

	return titles.map((t, i) => {
		const hit: SearchHit = { title: t.title, url: t.url };
		const snippet = snippets[i];
		if (snippet) hit.description = snippet;
		return hit;
	});
}

async function fetchDuckDuckGoPage(query: string, signal: AbortSignal): Promise<string> {
	// The html endpoint takes the query as a form field (POST keeps it out of
	// the URL and matches what the no-JS search form does).
	const res = await fetch(DDG_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": DDG_USER_AGENT,
			Accept: "text/html,application/xhtml+xml",
		},
		body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
		signal,
	});

	if (!res.ok) {
		throw new Error(`DuckDuckGo search error ${String(res.status)}: ${await res.text().catch(() => "")}`);
	}
	return await res.text();
}

export const duckduckgoProvider: SearchProvider = {
	name: "duckduckgo",

	isConfigured() {
		// DDG is the default fallback — always available (no deps, no key).
		return true;
	},

	async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
		const start = performance.now();
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

		let lastErr: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			try {
				const body = await withWebSearchTimeout(
					(combinedSignal) => fetchDuckDuckGoPage(input.query, combinedSignal),
					signal,
					{ providerName: "DuckDuckGo" },
				);

				if (isAnomalyError(body)) {
					throw new Error(DDG_ANOMALY_HINT);
				}

				const hits = applyDomainFilters(parseDuckDuckGoHtml(body), input);

				return {
					hits,
					providerName: "duckduckgo",
					durationSeconds: (performance.now() - start) / 1000,
				};
			} catch (err) {
				lastErr = err;
				// The anomaly hint thrown above is not retryable and propagates here.
				if (!isRetryableDDGError(err) || attempt === MAX_RETRIES - 1) {
					throw err;
				}
				// Exponential backoff with jitter: 1s, 2s, 4s +/- 20%
				const baseDelay = INITIAL_BACKOFF_MS * 2 ** attempt;
				const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
				await sleep(baseDelay + jitter, signal);
			}
		}

		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	},
};
