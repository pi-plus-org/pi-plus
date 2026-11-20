import { describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { createShellRenderers } from "../../src/coding-agent/core/tools/renderers/bash.ts";

initTheme();

function stripAnsi(text: string): string {
	return text.replace(/\[[0-9;]*m/g, "");
}

function renderResultText(options: { expanded: boolean; isError: boolean; content: string }): string {
	const renderers = createShellRenderers("$");
	const context = {
		cwd: process.cwd(),
		showImages: false,
		isError: options.isError,
		lastComponent: undefined,
		state: { startedAt: undefined, interval: undefined },
	} as unknown as ToolRenderContext<any, any>;
	const component = renderers.renderResult!(
		{ content: [{ type: "text", text: options.content }] } as any,
		{ expanded: options.expanded, isPartial: false } as any,
		undefined as any,
		context,
	);
	return stripAnsi(component.render(120).join("\n"));
}

describe("folded shell card renderer", () => {
	test("collapsed success shows only a hidden-line hint, no output", () => {
		const rendered = renderResultText({ expanded: false, isError: false, content: "line1\nline2\nline3" });
		expect(rendered).toContain("(3 lines hidden,");
		expect(rendered).toContain("to expand");
		expect(rendered).not.toContain("line1");
		expect(rendered).not.toContain("line3");
	});

	test("collapsed error keeps the tail preview so the exit status stays visible", () => {
		const rendered = renderResultText({
			expanded: false,
			isError: true,
			content: "some error\nCommand exited with code 1",
		});
		expect(rendered).toContain("some error");
		expect(rendered).toContain("Command exited with code 1");
	});

	test("expanded card shows full output", () => {
		const rendered = renderResultText({ expanded: true, isError: false, content: "line1\nline2\nline3" });
		expect(rendered).toContain("line1");
		expect(rendered).toContain("line3");
		expect(rendered).not.toContain("lines hidden");
	});

	test("empty output renders nothing", () => {
		const rendered = renderResultText({ expanded: false, isError: false, content: "" });
		expect(rendered.trim()).toBe("");
	});
});
