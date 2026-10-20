/**
 * Tests for plus/src/extensions/diagram/index.ts — the draw_diagram tool
 * registration and execute behaviour (ASCII result, optional HTML file).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerDiagram } from "../../src/extensions/diagram/index.ts";
import type { DiagramDetails } from "../../src/extensions/diagram/types.ts";

interface FakeTool {
	name: string;
	promptSnippet?: string;
	execute: (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
	renderCall?: (args: any, theme: any, context: any, lastToolCall?: string) => unknown;
	renderResult?: (result: any, options: any, theme: any, context: any, lastToolCall?: string) => unknown;
}

function captureTool(): FakeTool {
	const tools = new Map<string, FakeTool>();
	const pi = {
		registerTool: (tool: FakeTool) => tools.set(tool.name, tool),
		on: () => {},
	};
	registerDiagram(pi as unknown as ExtensionAPI);
	const tool = tools.get("draw_diagram");
	if (!tool) throw new Error("draw_diagram was not registered");
	return tool;
}

const specParams = {
	title: "Pipeline",
	nodes: [
		{ id: "a", label: "Build" },
		{ id: "b", label: "Test" },
	],
	edges: [{ from: "a", to: "b", label: "ok" }],
};

describe("draw_diagram tool", () => {
	it("registers the draw_diagram tool", () => {
		const tool = captureTool();
		expect(tool.name).toBe("draw_diagram");
		expect(tool.promptSnippet).toContain("draw_diagram");
	});

	it("execute returns ASCII content and structured details", async () => {
		const tool = captureTool();
		const ctx = { cwd: tmpdir() };
		const result = await tool.execute("id", specParams, undefined, undefined, ctx);
		const details = result.details as DiagramDetails;
		assert.ok(result.content[0]!.text.includes("Pipeline"));
		assert.ok(details.ascii.includes("Build"));
		assert.ok(details.ascii.includes("Test"));
		assert.ok(details.ascii.includes("▼"));
		assert.equal(details.spec.title, "Pipeline");
		assert.equal(details.htmlPath, undefined);
	});

	it("execute writes the HTML file when requested", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-diagram-"));
		try {
			const tool = captureTool();
			const ctx = { cwd: dir };
			const result = await tool.execute("id", { ...specParams, file: "out/build.html" }, undefined, undefined, ctx);
			const details = result.details as DiagramDetails;
			assert.ok(details.htmlPath);
			assert.ok(details.htmlPath!.endsWith("out/build.html"));
			const html = await readFile(details.htmlPath!, "utf8");
			assert.ok(html.includes("<svg"));
			assert.ok(result.content[0]!.text.includes("HTML written to"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects specs with unknown edge endpoints", async () => {
		const tool = captureTool();
		const ctx = { cwd: tmpdir() };
		await expect(
			tool.execute(
				"id",
				{ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/unknown node: ghost/);
	});

	it("renders a collapsed summary and an expanded diagram", () => {
		const tool = captureTool();
		const theme = { fg: (_c: string, s: string) => s } as any;
		const details: DiagramDetails = {
			spec: { title: "X", nodes: [{ id: "a", label: "A" }], edges: [] },
			ascii: "┌───┐\n│ A │\n└───┘",
		};
		const result = { content: [{ type: "text", text: details.ascii }], details } as any;
		assert.ok(tool.renderResult!(result, { expanded: false }, theme, {}, "draw_diagram"));
		assert.ok(tool.renderResult!(result, { expanded: true }, theme, {}, "draw_diagram"));
		assert.ok(tool.renderCall!(specParams, theme, {}, "draw_diagram"));
	});
});
