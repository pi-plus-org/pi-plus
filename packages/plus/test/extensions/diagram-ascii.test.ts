/**
 * Tests for plus/src/extensions/diagram/ascii.ts — box-drawing output and
 * label handling.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { renderAsciiLayout } from "../../src/extensions/diagram/ascii.ts";
import { layoutDiagram } from "../../src/extensions/diagram/layout.ts";

describe("renderAsciiLayout", () => {
	it("renders a vertical two-node chain exactly", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "a", label: "A" },
				{ id: "b", label: "B" },
			],
			edges: [{ from: "a", to: "b" }],
		});
		assert.equal(
			renderAsciiLayout(layout),
			["┌────┐", "│ A  │", "└────┘", "   │", "   │", "   │", "   ▼", "┌────┐", "│ B  │", "└────┘"].join("\n"),
		);
	});

	it("renders a fork with both branches and arrows", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "src", label: "Go" },
				{ id: "x", label: "Xray" },
				{ id: "y", label: "Yankee" },
			],
			edges: [
				{ from: "src", to: "x" },
				{ from: "src", to: "y" },
			],
		});
		const ascii = renderAsciiLayout(layout);
		const arrowCount = ascii.split("▼").length - 1;
		assert.equal(arrowCount, 2, "both branches end in a ▼");
		assert.ok(ascii.includes("Xray"));
		assert.ok(ascii.includes("Yankee"));
	});

	it("keeps edge labels readable", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "a", label: "Start" },
				{ id: "b", label: "Middle" },
				{ id: "c", label: "End" },
			],
			edges: [
				{ from: "a", to: "b", label: "yes" },
				{ from: "a", to: "c", label: "no" },
			],
		});
		const ascii = renderAsciiLayout(layout);
		assert.ok(ascii.includes("yes"));
		assert.ok(ascii.includes("no"));
	});

	it("renders a cycle back-edge arrow pointing up", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Bravo" },
			],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "a", label: "again" },
			],
		});
		const ascii = renderAsciiLayout(layout);
		assert.ok(ascii.includes("▲"));
		assert.ok(ascii.includes("again"));
	});

	it("prepends the title centered when requested", () => {
		const layout = layoutDiagram({ title: "T", nodes: [{ id: "a", label: "A" }], edges: [] });
		const ascii = renderAsciiLayout(layout, { includeTitle: true });
		assert.equal(ascii.split("\n")[0]!.trim(), "T");
	});

	it("wraps long labels inside the box", () => {
		const layout = layoutDiagram({
			nodes: [
				{ id: "a", label: "alpha bravo charlie delta echo foxtrot golf hotel india" },
				{ id: "b", label: "B" },
			],
			edges: [{ from: "a", to: "b" }],
		});
		const ascii = renderAsciiLayout(layout);
		const boxLines = ascii.split("\n").filter((l) => l.startsWith("│"));
		for (const line of boxLines) {
			if (line.includes("alpha")) assert.ok(line.length <= 32, `label line too long: ${line.length}`);
		}
		assert.ok(ascii.includes("alpha"));
		assert.ok(ascii.includes("india"));
	});
});
