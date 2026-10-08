/**
 * Tests for plus/src/extensions/web-search/types.ts — the shared adapter
 * helpers: flexible hit normalization (field aliases) and domain filtering
 * semantics (blocked keeps unparseable URLs, allowed drops them).
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SearchHit } from "../../src/extensions/web-search/types.ts";
import {
	applyDomainFilters,
	hostMatchesDomain,
	normalizeHit,
	safeHostname,
} from "../../src/extensions/web-search/types.ts";

describe("safeHostname", () => {
	it("extracts the hostname from a valid URL", () => {
		assert.equal(safeHostname("https://sub.example.com/a?b=1"), "sub.example.com");
	});

	it("returns undefined for unparseable or missing URLs", () => {
		assert.equal(safeHostname("not a url"), undefined);
		assert.equal(safeHostname(""), undefined);
		assert.equal(safeHostname(undefined), undefined);
	});
});

describe("hostMatchesDomain", () => {
	it("matches exact hosts and subdomains", () => {
		assert.ok(hostMatchesDomain("example.com", "example.com"));
		assert.ok(hostMatchesDomain("sub.example.com", "example.com"));
		assert.ok(hostMatchesDomain("a.b.example.com", "example.com"));
	});

	it("does not match suffix look-alikes", () => {
		assert.ok(!hostMatchesDomain("badexample.com", "example.com"));
		assert.ok(!hostMatchesDomain("example.com.evil.net", "example.com"));
	});

	it("is case-insensitive on both sides (caller-supplied domains)", () => {
		assert.ok(hostMatchesDomain("Reddit.com".toLowerCase(), "Reddit.com"));
		assert.ok(hostMatchesDomain("www.GITHUB.com", "GitHub.com"));
	});
});

describe("applyDomainFilters", () => {
	const hits: SearchHit[] = [
		{ title: "A", url: "https://keep.example.com/a" },
		{ title: "B", url: "https://drop.example.org/b" },
		{ title: "C", url: "relative/not/a/url" },
	];

	it("blocked domains keep unparseable URLs (can't confirm blocked → keep)", () => {
		const out = applyDomainFilters(hits, { query: "q", blocked_domains: ["keep.example.com"] });
		assert.deepEqual(
			out.map((h) => h.title),
			["B", "C"],
		);
	});

	it("allowed domains drop unparseable URLs (can't confirm allowed → drop)", () => {
		const out = applyDomainFilters(hits, { query: "q", allowed_domains: ["example.com"] });
		assert.deepEqual(
			out.map((h) => h.title),
			["A"],
		);
	});

	it("blocked-domain entries are case-insensitive", () => {
		const out = applyDomainFilters(hits, { query: "q", blocked_domains: ["KEEP.Example.com"] });
		assert.ok(!out.some((h) => h.title === "A"));
	});

	it("no filters leaves the list untouched", () => {
		assert.equal(applyDomainFilters(hits, { query: "q" }), hits);
	});
});

describe("normalizeHit", () => {
	it("reads title/url/description/source aliases", () => {
		const hit = normalizeHit({ headline: "H", link: "https://x.io/", summary: "S", domain: "x.io" });
		assert.deepEqual(hit, { title: "H", url: "https://x.io/", description: "S", source: "x.io" });
	});

	it("fills a missing title from the url and vice versa", () => {
		assert.deepEqual(normalizeHit({ url: "https://x.io/" }), { title: "https://x.io/", url: "https://x.io/" });
		assert.deepEqual(normalizeHit({ title: "Only Title" }), { title: "Only Title", url: "Only Title" });
	});

	it("returns null for non-objects and objects without title/url", () => {
		assert.equal(normalizeHit(null), null);
		assert.equal(normalizeHit("string"), null);
		assert.equal(normalizeHit({ snippet: "orphan" }), null);
	});

	it("skips empty-string values when picking an alias", () => {
		const hit = normalizeHit({ title: "", name: "N", url: "https://x.io/" });
		assert.equal(hit?.title, "N");
	});
});
