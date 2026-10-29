/**
 * Wrapper for packages/coding-agent/src/core/http-dispatcher.ts.
 *
 * Pass-through except `configureHttpDispatcher`, which upstream arms with a
 * single knob: `httpIdleTimeoutMs` goes into BOTH undici timeouts —
 * `headersTimeout` (how long to wait for the *first byte* of the response) and
 * `bodyTimeout` (the between-bytes idle guard the setting is named after). Only
 * the second one matches. A provider that takes longer than the idle timeout to
 * start answering — a large prefill, or a proxy that buffers until the first
 * token — dies on the headers timeout, and the OpenAI client reports it as
 * "Request timed out. Node.js fetch timed out waiting for response headers;
 * configure a matching undici fetch and fetchOptions.dispatcher with an Agent
 * whose headersTimeout is at least the SDK timeout." (2026-10-28 cit-llm
 * sessions: durationMs 302430 and 304897 with zero usage tokens, i.e. the
 * response never began).
 *
 * pi-plus arms the dispatcher with a budget that covers the slowest legitimate
 * case instead: at least the provider request ceiling plus a grace, so the SDK's
 * own deadline (a classified, retryable error, and the tighter bound) is the
 * thing that fires first. The body idle guard is raised to the same value rather
 * than kept at the configured number, because upstream builds one agent from one
 * value — a wedged stream is still cut by the request deadline; see
 * `getProviderRetrySettings` in the settings-manager wrapper. "disabled" still
 * means no timeout anywhere, and everything else about the dispatcher
 * (`allowH2: false`, proxy tunneling, the error listener, the fetch install)
 * stays upstream's, since only the value handed to it changes.
 */
export * from "../../../../coding-agent/src/core/http-dispatcher.ts";

import {
	DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	parseHttpIdleTimeoutMs,
	configureHttpDispatcher as upstreamConfigureHttpDispatcher,
} from "../../../../coding-agent/src/core/http-dispatcher.ts";

/**
 * Floor for a provider request's total deadline (`retry.provider.timeoutMs`, see
 * the settings-manager wrapper) and, with `PI_PLUS_HEADERS_TIMEOUT_GRACE_MS`,
 * for the response-headers budget. Upstream derives the OpenAI/Anthropic client
 * deadline from `httpIdleTimeoutMs` (300s by default), which turns a socket guard
 * into a hard cap on the whole request; this is the 10 minutes upstream documents
 * as those SDKs' own default.
 */
export const PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS = 600_000;

/** Let the SDK deadline fire before the socket headers timeout. */
export const PI_PLUS_HEADERS_TIMEOUT_GRACE_MS = 15_000;

/** Upstream's "no timeout" value, reached through `httpIdleTimeoutMs: "disabled"`. */
export const PI_PLUS_NO_TIMEOUT_MS = 2_147_483_647;

/**
 * The timeout value to arm the dispatcher with, for a configured idle timeout.
 * Pure so the raise is testable without rewriting the process dispatcher.
 * Accepts the same shapes as `parseHttpIdleTimeoutMs` (number or "disabled");
 * undefined/unparseable falls back to the default, and 0 stays 0.
 */
export function plusDispatcherTimeoutMs(timeoutMs?: number | string): number {
	const idle = parseHttpIdleTimeoutMs(timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS);
	if (idle === undefined) return DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	if (idle === 0) return 0;
	return Math.max(idle, PI_PLUS_MIN_PROVIDER_REQUEST_TIMEOUT_MS + PI_PLUS_HEADERS_TIMEOUT_GRACE_MS);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	// Pass a configured-but-invalid value through unchanged so upstream raises its
	// own "Invalid HTTP idle timeout" instead of silently using the default.
	upstreamConfigureHttpDispatcher(
		parseHttpIdleTimeoutMs(timeoutMs) === undefined ? timeoutMs : plusDispatcherTimeoutMs(timeoutMs),
	);
}
