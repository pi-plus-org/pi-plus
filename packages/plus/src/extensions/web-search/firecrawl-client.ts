/**
 * Firecrawl client (ported from openclaude's src/tools/firecrawl/client.ts).
 *
 * Shared by the firecrawl search provider and the WebFetch tool's markdown
 * path. Supports the cloud API (FIRECRAWL_API_KEY) and self-hosted instances
 * (FIRECRAWL_API_URL, no key required).
 */

const DEFAULT_FIRECRAWL_API_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_FACTOR_SECONDS = 0.5;

interface FirecrawlEnvelope<T> {
	success?: boolean;
	data?: T;
	error?: string;
}

interface FirecrawlWebResult {
	url: string;
	title?: string;
	description?: string;
}

interface FirecrawlSearchData {
	web?: FirecrawlWebResult[];
}

interface FirecrawlScrapeData {
	markdown?: string;
}

export interface FirecrawlRequestOptions {
	apiKey?: string | null;
	apiUrl?: string | null;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
	backoffFactorSeconds?: number;
}

interface FirecrawlSearchOptions extends FirecrawlRequestOptions {
	limit?: number;
}

interface FirecrawlScrapeOptions extends FirecrawlRequestOptions {
	formats?: string[];
}

export function isFirecrawlCloudApiUrl(apiUrl: string | undefined): boolean {
	const normalized = (apiUrl ?? DEFAULT_FIRECRAWL_API_URL).trim();
	try {
		return new URL(normalized).hostname === "api.firecrawl.dev";
	} catch {
		const withoutTrailingSlash = normalized.replace(/\/+$/, "");
		return withoutTrailingSlash.toLowerCase() === "api.firecrawl.dev";
	}
}

function getFirecrawlConfig(options: FirecrawlRequestOptions): { apiKey: string; apiUrl: string } {
	const apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY ?? "";
	const apiUrl = (options.apiUrl ?? process.env.FIRECRAWL_API_URL ?? DEFAULT_FIRECRAWL_API_URL).replace(/\/$/, "");

	if (isFirecrawlCloudApiUrl(apiUrl) && !apiKey) {
		throw new Error(
			"Firecrawl API key is required for the cloud API. Set FIRECRAWL_API_KEY or use FIRECRAWL_API_URL for a self-hosted instance.",
		);
	}

	return { apiKey, apiUrl };
}

function sleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function parseFirecrawlResponse<T>(response: Response, action: string): Promise<FirecrawlEnvelope<T>> {
	const text = await response.text();
	let payload: FirecrawlEnvelope<T> | undefined;

	if (text) {
		try {
			payload = JSON.parse(text) as FirecrawlEnvelope<T>;
		} catch {
			if (!response.ok) {
				throw new Error(`Firecrawl ${action} error ${String(response.status)}: ${text}`);
			}
			throw new Error(`Firecrawl ${action} returned invalid JSON`);
		}
	}

	if (!response.ok || !payload?.success) {
		const detail = payload?.error ?? text;
		const suffix = detail ? `: ${String(detail)}` : "";
		throw new Error(`Firecrawl ${action} error ${String(response.status)}${suffix}`);
	}

	return payload;
}

async function postToFirecrawl<T>(
	path: string,
	body: Record<string, unknown>,
	action: string,
	options: FirecrawlRequestOptions,
): Promise<T> {
	const { apiKey, apiUrl } = getFirecrawlConfig(options);
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const backoffFactorSeconds = options.backoffFactorSeconds ?? DEFAULT_BACKOFF_FACTOR_SECONDS;

	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		// Per-attempt timeout composed with the caller signal; AbortSignal.timeout's
		// timer is unref'd on Node, so no cleanup bookkeeping is needed.
		const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

		try {
			const response = await fetch(`${apiUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					...body,
					origin: "pi-plus",
				}),
				signal,
			});

			if (response.status !== 502 || attempt === maxRetries - 1) {
				const payload = await parseFirecrawlResponse<T>(response, action);
				return (payload.data ?? {}) as T;
			}
		} catch (err) {
			// Caller cancellation must not be retried.
			if (options.signal?.aborted) throw err;
			if (attempt === maxRetries - 1) throw err;
		}

		await sleep(backoffFactorSeconds * 2 ** attempt);
	}

	throw new Error(`Firecrawl ${action} failed before receiving a response`);
}

export async function firecrawlSearch(
	query: string,
	options: FirecrawlSearchOptions = {},
): Promise<FirecrawlSearchData> {
	if (!query.trim()) {
		throw new Error("Firecrawl query cannot be empty");
	}

	return postToFirecrawl<FirecrawlSearchData>(
		"/v2/search",
		{
			query,
			limit: options.limit ?? 15,
		},
		"search",
		options,
	);
}

export async function firecrawlScrape(url: string, options: FirecrawlScrapeOptions = {}): Promise<FirecrawlScrapeData> {
	if (!url.trim()) {
		throw new Error("Firecrawl URL cannot be empty");
	}

	return postToFirecrawl<FirecrawlScrapeData>(
		"/v2/scrape",
		{
			url,
			formats: options.formats ?? ["markdown"],
		},
		"scrape",
		options,
	);
}
