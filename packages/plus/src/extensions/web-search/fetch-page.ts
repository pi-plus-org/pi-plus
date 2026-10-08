/**
 * URL → readable text for the WebFetch tool (port of openclaude's
 * WebFetchTool utils, simplified).
 *
 * openclaude runs a Haiku pass over the fetched markdown and guards SSRF via
 * a DNS-lookup hook; pi-plus hands the processed text straight to the main
 * model and blocks only literal private/loopback addresses (Node's fetch
 * does not expose DNS lookup interception). When Firecrawl is configured the
 * scrape goes through it and yields markdown directly.
 */

import { firecrawlScrape } from "./firecrawl-client.ts";
import { htmlToText } from "./html.ts";
import { isPrivateHostname } from "./providers/custom.ts";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 100_000;
const MAX_REDIRECTS = 5;

// Sites that sniff the UA often block the default undici one; present as a
// plain browser fetch.
const FETCH_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface FetchedPage {
	/** Final URL the content was fetched from */
	url: string;
	statusCode: number;
	statusText: string;
	contentType: string;
	/** Raw body size in bytes */
	bytes: number;
	/** Processed (HTML → text) and possibly truncated content */
	text: string;
	truncated: boolean;
	/** True when the text came from Firecrawl as markdown */
	markdown: boolean;
}

export interface FetchRedirect {
	originalUrl: string;
	redirectUrl: string;
	statusCode: number;
}

export type FetchPageResult =
	| { page: FetchedPage; redirect?: undefined }
	| { redirect: FetchRedirect; page?: undefined };

export function isFirecrawlEnabled(): boolean {
	return Boolean(process.env.FIRECRAWL_API_KEY) || Boolean(process.env.FIRECRAWL_API_URL);
}

/** Validate the target against the WebFetch guardrails. Throws on violation. */
export function validateFetchUrl(urlString: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		throw new Error(`Invalid URL: ${urlString.slice(0, 200)}`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Unsupported protocol ${parsed.protocol} — WebFetch only fetches http(s) URLs.`);
	}
	const allowHttp = process.env.WEB_FETCH_ALLOW_HTTP === "true";
	if (!allowHttp && parsed.protocol === "http:") {
		throw new Error(
			`WebFetch requires https:// URLs (got ${parsed.protocol}//${parsed.host}). ` +
				`Set WEB_FETCH_ALLOW_HTTP=true to override.`,
		);
	}
	const allowPrivate = process.env.WEB_FETCH_ALLOW_PRIVATE === "true";
	if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
		throw new Error(
			`WebFetch refuses to fetch from private/reserved address ${parsed.hostname} by default (SSRF guard). ` +
				`Set WEB_FETCH_ALLOW_PRIVATE=true to override.`,
		);
	}
	return parsed;
}

function contentTypeLooksHtml(contentType: string): boolean {
	return /text\/html|application\/xhtml/i.test(contentType);
}

function contentTypeIsText(contentType: string): boolean {
	return /^text\//i.test(contentType) || /json|xml|javascript|typescript|csv/i.test(contentType);
}

/**
 * Fetch a URL with manual redirect handling: same-host redirects are followed
 * (up to MAX_REDIRECTS), cross-host redirects are reported back so the model
 * can re-issue WebFetch against the new host deliberately.
 */
async function fetchWithRedirects(url: string, signal: AbortSignal): Promise<FetchPageResult> {
	let current = url;
	const originalUrl = url;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		validateFetchUrl(current);
		const res = await fetch(current, {
			redirect: "manual",
			headers: {
				"User-Agent": FETCH_USER_AGENT,
				Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal,
		});

		if ([301, 302, 303, 307, 308].includes(res.status)) {
			const location = res.headers.get("location");
			// Drain the small redirect body so the connection can be reused.
			await res.body?.cancel().catch(() => {});
			if (!location) {
				throw new Error(`Redirect (${String(res.status)}) without a Location header: ${current}`);
			}
			const redirectUrl = new URL(location, current).toString();
			const fromHost = new URL(current).hostname;
			const toHost = new URL(redirectUrl).hostname;
			if (fromHost !== toHost) {
				return { redirect: { originalUrl, redirectUrl, statusCode: res.status } };
			}
			current = redirectUrl;
			continue;
		}

		const contentType = res.headers.get("content-type") ?? "";
		const declaredLength = Number(res.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_RAW_BYTES) {
			await res.body?.cancel().catch(() => {});
			throw new Error(`Response too large: ${String(declaredLength)} bytes (limit 10 MB).`);
		}

		const raw = await res.text();
		const bytes = Buffer.byteLength(raw);
		if (bytes > MAX_RAW_BYTES) {
			throw new Error(`Response too large: ${String(bytes)} bytes (limit 10 MB).`);
		}
		if (!res.ok) {
			throw new Error(`HTTP ${String(res.status)} ${res.statusText}${raw ? `: ${raw.slice(0, 500)}` : ""}`);
		}

		let text: string;
		if (
			contentTypeLooksHtml(contentType) ||
			(!contentType && /<!doctype html|<html[\s>]/i.test(raw.slice(0, 2048)))
		) {
			text = htmlToText(raw, current);
		} else if (contentTypeIsText(contentType)) {
			text = raw;
		} else {
			throw new Error(`Unsupported content type "${contentType || "unknown"}" — WebFetch reads HTML and text only.`);
		}

		const truncated = text.length > MAX_TEXT_LENGTH;
		if (truncated) text = `${text.slice(0, MAX_TEXT_LENGTH)}\n[... truncated]`;

		return {
			page: {
				url: current,
				statusCode: res.status,
				statusText: res.statusText,
				contentType,
				bytes,
				text,
				truncated,
				markdown: false,
			},
		};
	}

	throw new Error(`Too many redirects starting from ${originalUrl}`);
}

async function fetchViaFirecrawl(url: string, signal: AbortSignal): Promise<FetchedPage> {
	const result = await firecrawlScrape(url, {
		apiKey: process.env.FIRECRAWL_API_KEY,
		apiUrl: process.env.FIRECRAWL_API_URL,
		formats: ["markdown"],
		signal,
		timeoutMs: FETCH_TIMEOUT_MS,
	});
	const markdown = result.markdown ?? "";
	const truncated = markdown.length > MAX_TEXT_LENGTH;
	return {
		url,
		statusCode: 200,
		statusText: "OK",
		contentType: "text/markdown",
		bytes: Buffer.byteLength(markdown),
		text: truncated ? `${markdown.slice(0, MAX_TEXT_LENGTH)}\n[... truncated]` : markdown,
		truncated,
		markdown: true,
	};
}

/**
 * Fetch a URL and return readable text. Uses Firecrawl when configured,
 * otherwise a direct fetch with HTML → plain-text conversion.
 */
export async function fetchUrlContent(urlString: string, signal?: AbortSignal): Promise<FetchPageResult> {
	const parsed = validateFetchUrl(urlString);
	const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

	try {
		if (isFirecrawlEnabled()) {
			return { page: await fetchViaFirecrawl(parsed.toString(), combined) };
		}
		return await fetchWithRedirects(parsed.toString(), combined);
	} catch (err) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
		if ((err as Error)?.name === "TimeoutError" || timeoutSignal.aborted) {
			throw new Error(`Fetch timed out after ${String(FETCH_TIMEOUT_MS / 1000)}s: ${urlString}`);
		}
		throw err;
	}
}
