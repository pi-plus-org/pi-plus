/**
 * pi-plus-diagram: the `draw_diagram` tool. Renders node-edge diagrams as
 * box-drawing ASCII (shown inline in the TUI and in tool output) and, when a
 * `file` is given or via the pi-plus-sdk `renderDiagramHtml` export, as
 * standalone HTML/SVG. Layout is computed once on a character grid so the
 * ASCII and HTML outputs share identical geometry.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { renderAsciiLayout } from "./ascii.ts";
import { renderDiagramHtml } from "./html.ts";
import { layoutDiagram } from "./layout.ts";
import { DIAGRAM_DESCRIPTION, DIAGRAM_GUIDELINES, DIAGRAM_SNIPPET } from "./prompt.ts";
import { DrawDiagramParams } from "./tools.ts";
import { DIAGRAM_TOOL_NAME, type DiagramDetails, type DiagramSpec } from "./types.ts";

function toSpec(params: DrawDiagramParams): DiagramSpec {
	return {
		title: params.title,
		nodes: params.nodes.map((n) => ({ id: n.id, label: n.label, shape: n.shape })),
		edges: (params.edges ?? []).map((e) => ({ from: e.from, to: e.to, label: e.label })),
	};
}

export function registerDiagram(pi: ExtensionAPI): void {
	pi.registerTool({
		name: DIAGRAM_TOOL_NAME,
		label: "Draw Diagram",
		description: DIAGRAM_DESCRIPTION,
		promptSnippet: DIAGRAM_SNIPPET,
		promptGuidelines: DIAGRAM_GUIDELINES,
		parameters: DrawDiagramParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const spec = toSpec(params);
			const layout = layoutDiagram(spec);
			const ascii = renderAsciiLayout(layout);
			let htmlPath: string | undefined;
			if (params.file) {
				htmlPath = isAbsolute(params.file) ? params.file : resolve(ctx.cwd, params.file);
				await mkdir(dirname(htmlPath), { recursive: true });
				await writeFile(htmlPath, renderDiagramHtml(spec), "utf8");
			}
			const details: DiagramDetails = { spec, ascii, htmlPath };
			const header = spec.title ? `Diagram "${spec.title}"` : "Diagram";
			const counts = `${String(spec.nodes.length)} nodes, ${String(spec.edges.length)} edges`;
			let text = `${header} (${counts}):\n\n${ascii}\n`;
			if (htmlPath) text += `\nHTML written to ${htmlPath}`;
			return { content: [{ type: "text" as const, text: text as string }], details };
		},

		renderCall(params, theme) {
			const parts = [theme.fg("toolTitle", `draw_diagram ${params.title ?? ""}`.trim())];
			parts.push(theme.fg("muted", `(${String(params.nodes.length)} nodes)`));
			return new Text(parts.join(" "), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as DiagramDetails | undefined;
			if (!details) {
				const first = result.content[0];
				const fallback = first && first.type === "text" ? first.text : theme.fg("warning", "No diagram output");
				return new Text(fallback, 0, 0);
			}
			const { spec, ascii, htmlPath } = details;
			const counts = `${String(spec.nodes.length)} nodes, ${String(spec.edges.length)} edges`;
			if (!options.expanded) {
				const title = spec.title ? theme.fg("toolTitle", spec.title) : theme.fg("toolTitle", "Diagram");
				return new Text(`${title} ${theme.fg("muted", `(${counts})`)}`, 0, 0);
			}
			const lines: string[] = [];
			if (spec.title) lines.push(`${theme.fg("toolTitle", spec.title)} ${theme.fg("muted", counts)}`);
			lines.push(ascii);
			if (htmlPath) lines.push(theme.fg("dim", `HTML: ${htmlPath}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
