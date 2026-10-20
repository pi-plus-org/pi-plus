/**
 * Tests for plus/src/extensions/diagram/html.ts — the pi-plus-sdk host-facing
 * `renderDiagramHtml` capability.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderDiagramHtml } from "../../src/extensions/diagram/html.ts";
import { DiagramError } from "../../src/extensions/diagram/types.ts";

const spec = {
	title: "Escaping <&test>",
	nodes: [
		{ id: "a", label: "Alpha & Co", shape: "round" as const },
		{ id: "b", label: "Bets<Y>", shape: "diamond" as const },
		{ id: "c", label: "Gamma" },
	],
	edges: [
		{ from: "a", to: "b", label: "x<y" },
		{ from: "b", to: "c" },
	],
};

describe("renderDiagramHtml", () => {
	it("produces a standalone HTML document with inline SVG", () => {
		const html = renderDiagramHtml(spec);
		assert.ok(html.startsWith("<!doctype html>"));
		assert.ok(html.includes("<svg"));
		assert.ok(html.includes("</svg>"));
		assert.ok(html.includes("<polygon")); // diamond node
		assert.ok(html.includes("url(#arrow)"));
	});

	it("escapes labels and titles", () => {
		const html = renderDiagramHtml(spec);
		assert.ok(html.includes("Escaping &lt;&amp;test&gt;"));
		assert.ok(html.includes("Alpha &amp; Co"));
		assert.ok(html.includes("Bets&lt;Y&gt;"));
		assert.ok(html.includes("x&lt;y"));
		assert.ok(!html.includes("Bets<Y>"));
	});

	it("is deterministic", () => {
		assert.equal(renderDiagramHtml(spec), renderDiagramHtml(spec));
	});

	it("honors the title option", () => {
		const html = renderDiagramHtml({ nodes: [{ id: "a", label: "A" }], edges: [] }, { title: "Custom" });
		assert.ok(html.includes("<title>Custom</title>"));
	});

	it("throws DiagramError on invalid specs", () => {
		assert.throws(() => renderDiagramHtml({ nodes: [], edges: [] }), DiagramError);
		assert.throws(
			() => renderDiagramHtml({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "zz", to: "a" }] }),
			DiagramError,
		);
	});
});
