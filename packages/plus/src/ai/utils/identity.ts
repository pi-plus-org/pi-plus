/**
 * Wrapper for packages/ai/src/utils/identity.ts.
 *
 * Pass-through except the `User-Agent`: pi-plus reports its own product token
 * instead of `pi`, so provider-side usage logs (e.g. the Anthropic console
 * "Source" column) attribute calls to this fork. The version and the
 * platform/runtime/arch suffix stay identical, and a caller-supplied
 * `{ custom }` user agent is left alone.
 *
 * Upstream produced the header in `formatUserAgent`, which `getIdentityHeaders`
 * calls in its own module scope; both are therefore re-implemented here so
 * every import boundary (provider APIs, coding-agent's own requests) sees the
 * pi-plus form.
 */
export * from "../../../../ai/src/utils/identity.ts";

import {
	type ClientIdentity,
	type ClientIdentityTarget,
	formatUserAgent as upstreamFormatUserAgent,
	getIdentityHeaders as upstreamGetIdentityHeaders,
} from "../../../../ai/src/utils/identity.ts";

/** Swap pi's product token for pi-plus; custom user agents pass through untouched. */
function toPlusUserAgent(userAgent: string, identity?: ClientIdentity): string {
	if (typeof identity?.userAgent === "object") return userAgent;
	if (userAgent === "pi") return "pi-plus";
	return userAgent.replace(/^pi\//, "pi-plus/");
}

export function formatUserAgent(identity?: ClientIdentity): string {
	return toPlusUserAgent(upstreamFormatUserAgent(identity), identity);
}

export function getIdentityHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	const headers = upstreamGetIdentityHeaders(target, identity);
	const userAgent = headers["User-Agent"];
	if (userAgent === undefined) return headers;
	return { ...headers, "User-Agent": toPlusUserAgent(userAgent, identity) };
}
