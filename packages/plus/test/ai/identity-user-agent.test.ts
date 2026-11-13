/**
 * Regression tests for the pi-plus client-identity wrapper
 * (`src/ai/utils/identity.ts`, wired through `loader/redirects.mjs`): the
 * `User-Agent` sent to providers must report `pi-plus` while keeping pi's
 * version/runtime/arch suffix, and a caller-supplied custom user agent must
 * survive untouched.
 */
import { describe, expect, it } from "vitest";
import { formatUserAgent, getIdentityHeaders, PI_ATTRIBUTION } from "../../src/ai/utils/identity.ts";

const openRouter = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };

describe("pi-plus User-Agent", () => {
	it("replaces the product token in the detailed form", () => {
		const userAgent = formatUserAgent({ userAgent: "detailed", version: "9.9.9" });
		expect(userAgent).toMatch(/^pi-plus\/9\.9\.9 \(/);
		expect(userAgent).toContain(`${process.platform};`);
		expect(userAgent).toContain(process.arch);
	});

	it("replaces the product token in the short form", () => {
		expect(formatUserAgent({ userAgent: "short" })).toBe("pi-plus");
	});

	it("leaves a custom user agent untouched", () => {
		expect(formatUserAgent({ userAgent: { custom: "my-app/1.0" } })).toBe("my-app/1.0");
	});

	it("rewrites the header applied to provider requests", () => {
		const headers = getIdentityHeaders(openRouter, {
			userAgent: "detailed",
			version: "9.9.9",
			attribution: PI_ATTRIBUTION,
		});
		expect(headers["User-Agent"]).toMatch(/^pi-plus\/9\.9\.9 \(/);
		// attribution headers are unchanged
		expect(headers["X-OpenRouter-Title"]).toBe("pi");
	});

	it("leaves a custom provider header untouched", () => {
		const headers = getIdentityHeaders(openRouter, { userAgent: { custom: "my-app/1.0" } });
		expect(headers["User-Agent"]).toBe("my-app/1.0");
	});
});
