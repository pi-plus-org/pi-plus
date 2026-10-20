/**
 * Tests for plus/src/extensions/diagram/layout.ts — validation, ranking
 * (chain / diamond / cycle reversal), and label wrapping.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { layoutDiagram, wrapLabel } from "../../src/extensions/diagram/layout.ts";
import { DiagramError, type DiagramSpec } from "../../src/extensions/diagram/types.ts";

function ranks(spec: DiagramSpec): Map<string, number> {
	const layout = layoutDiagram(spec);
	return new Map(layout.nodes.map((n) => [n.id, n.rank]));
}

describe("layoutDiagram validation", () => {
	it("rejects empty nodes", () => {
		assert.throws(() => layoutDiagram({ nodes: [], edges: [] }), DiagramError);
	});

	it("rejects duplicate ids", () => {
		assert.throws(
			() =>
				layoutDiagram({
					nodes: [
						{ id: "a", label: "A" },
						{ id: "a", label: "B" },
					],
					edges: [],
				}),
			/Duplicate node id: a/,
		);
	});

	it("rejects edges referencing unknown nodes", () => {
		assert.throws(
			() => layoutDiagram({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] }),
			/unknown node: ghost/,
		);
	});

	it("rejects self loops", () => {
		assert.throws(
			() => layoutDiagram({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "a" }] }),
			/Self-loop on node: a/,
		);
	});
});

describe("layoutDiagram ranking", () => {
	it("ranks a chain top-to-bottom", () => {
		const r = ranks({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
		});
		assert.deepEqual([r.get("a"), r.get("b"), r.get("c")], [0, 1, 2]);
	});

	it("ranks a diamond so the sink is two below the forks", () => {
		const r = ranks({
			nodes: [
				{ id: "src", label: "S" },
				{ id: "l", label: "L" },
				{ id: "t", label: "T" },
				{ id: "dec", label: "D" },
			],
			edges: [
				{ from: "src", to: "l" },
				{ from: "src", to: "t" },
				{ from: "l", to: "dec" },
				{ from: "t", to: "dec" },
			],
		});
		assert.deepEqual([r.get("src"), r.get("l"), r.get("t"), r.get("dec")], [0, 1, 1, 2]);
	});

	it("uses longest path when a shortcut skips a level", () => {
		const r = ranks({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
				{ from: "a", to: "c" },
			],
		});
		assert.equal(r.get("c"), 2);
	});

	it("places disconnected nodes in rank 0", () => {
		const r = ranks({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "iso", label: "Lonely" },
			],
			edges: [],
		});
		assert.equal(r.get("iso"), 0);
	});

	it("reverses one cycle edge for layout with the arrow on the logical target", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
				{ id: "c", label: "C" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
				{ from: "c", to: "a", label: "loop" },
			],
		});
		const loop = layout.edges.find((e) => e.from === "c" && e.to === "a");
		assert.ok(loop, "loop edge present");
		assert.equal(loop.reversed, true);
		assert.equal(loop.arrowDir, "up");
		// Arrow cell sits directly below the logical target box (A, rank 0).
		const a = layout.nodes.find((n) => n.id === "a")!;
		assert.equal(loop.arrowAt.x, a.cx);
		assert.equal(loop.arrowAt.y, a.y + a.h);
	});

	it("routes edges below their source box and ends the arrow above the target", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "wide", label: "Wide box here" },
				{ id: "narrow", label: "N" },
			],
			edges: [{ from: "wide", to: "narrow", label: "go" }],
		});
		const wide = layout.nodes.find((n) => n.id === "wide")!;
		const narrow = layout.nodes.find((n) => n.id === "narrow")!;
		const edge = layout.edges[0]!;
		assert.equal(edge.arrowDir, "down");
		assert.equal(edge.arrowAt.y, narrow.y - 1);
		assert.equal(edge.points[0]!.y, wide.y + wide.h);
		assert.ok(edge.labelAt, "label placed");
	});

	it("stays deterministic for the same spec", () => {
		const spec: DiagramSpec = {
			nodes: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Bravo" },
				{ id: "c", label: "Charlie" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
				{ from: "b", to: "c", label: "late" },
			],
		};
		const one = JSON.stringify(layoutDiagram(spec));
		const two = JSON.stringify(layoutDiagram(spec));
		assert.equal(one, two);
	});
});

describe("wrapLabel", () => {
	it("wraps words onto lines of at most the given width", () => {
		const lines = wrapLabel("the quick brown fox jumps", 10);
		assert.ok(lines.length > 1);
		for (const line of lines) assert.ok(line.length <= 10, `line too long: ${line}`);
		assert.equal(lines.join(" "), "the quick brown fox jumps");
	});

	it("breaks words longer than the width", () => {
		const lines = wrapLabel("abcdefghijklmnop", 8);
		assert.deepEqual(lines, ["abcdefgh", "ijklmnop"]);
	});
});
