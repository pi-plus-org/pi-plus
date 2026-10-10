/**
 * Wrapper for packages/ai/src/utils/pi-user-agent.ts.
 *
 * Pass-through except getPiUserAgent: the client identity sent in the
 * User-Agent header reports "pi-plus" instead of "pi" so provider-side usage
 * logs (e.g. the Anthropic console "Source" column) attribute calls to this
 * fork. The platform/arch suffix stays identical.
 */
export * from "../../../../ai/src/utils/pi-user-agent.ts";

import { getPiUserAgent as getUpstreamPiUserAgent } from "../../../../ai/src/utils/pi-user-agent.ts";

export function getPiUserAgent(): string {
	return getUpstreamPiUserAgent().replace(/^pi /, "pi-plus ");
}
