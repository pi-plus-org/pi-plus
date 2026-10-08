/**
 * Web search request timeouts (ported from openclaude's
 * src/tools/WebSearchTool/providers/timeout.ts).
 *
 * openclaude composes signals through its createCombinedAbortSignal helper;
 * pi-plus targets Node >= 22 only, so AbortSignal.any + AbortSignal.timeout
 * cover the same semantics without the listener bookkeeping.
 */

export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 15;
const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;
const WEB_SEARCH_TIMEOUT_CODE = "WEB_SEARCH_TIMEOUT";

export interface WebSearchTimeoutOptions {
	providerName?: string;
	timeoutMs?: number;
}

export function getWebSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.WEB_SEARCH_TIMEOUT_SEC;
	const trimmed = raw?.trim();
	if (trimmed === undefined || trimmed === "") {
		return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000;
	}

	if (!/^\d+$/.test(trimmed)) {
		return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000;
	}

	const seconds = Number(trimmed);
	if (
		!Number.isFinite(seconds) ||
		!Number.isSafeInteger(seconds) ||
		seconds <= 0 ||
		seconds > MAX_WEB_SEARCH_TIMEOUT_SECONDS
	) {
		return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000;
	}

	return seconds * 1000;
}

export class WebSearchTimeoutError extends Error {
	readonly code: string = WEB_SEARCH_TIMEOUT_CODE;
	readonly timeoutMs: number;

	constructor(providerName: string, timeoutMs: number) {
		super(`${providerName} search timed out after ${String(timeoutMs / 1000)}s`);
		this.name = "WebSearchTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export function isWebSearchTimeoutError(err: unknown): boolean {
	return (
		err instanceof WebSearchTimeoutError ||
		(err instanceof Error && (err as { code?: unknown }).code === WEB_SEARCH_TIMEOUT_CODE)
	);
}

export function toAbortError(reason?: unknown): Error {
	if (reason instanceof Error) return reason;
	return new DOMException("Aborted", "AbortError");
}

/**
 * Run an operation under a per-request timeout combined with the caller's
 * abort signal. A timeout surfaces as WebSearchTimeoutError (so providers can
 * distinguish it from caller cancellation); a caller abort propagates as-is.
 */
export async function withWebSearchTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal | undefined,
	options: WebSearchTimeoutOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? getWebSearchTimeoutMs();
	const providerName = options.providerName ?? "Web search provider";

	if (signal?.aborted) throw toAbortError(signal.reason);

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	if (combined.aborted) throw toAbortError(combined.reason);

	try {
		return await operation(combined);
	} catch (err) {
		if (signal?.aborted) throw toAbortError(signal.reason ?? err);
		if (timeoutSignal.aborted) throw new WebSearchTimeoutError(providerName, timeoutMs);
		throw err;
	}
}

export async function fetchJsonWithWebSearchTimeout(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	signal: AbortSignal | undefined,
	options: WebSearchTimeoutOptions = {},
): Promise<unknown> {
	const providerName = options.providerName ?? "Web search provider";

	return withWebSearchTimeout(
		async (combinedSignal) => {
			const res = await fetch(input, {
				...(init ?? {}),
				signal: combinedSignal,
			});

			if (!res.ok) {
				throw new Error(`${providerName} search error ${String(res.status)}: ${await res.text().catch(() => "")}`);
			}

			return await res.json();
		},
		signal,
		options,
	);
}
