/**
 * Self-contained HTML/SVG renderer for diagram specs. Scales the same
 * character-grid layout used by the ASCII renderer to pixels, so both
 * outputs show identical geometry. Exported to pi-plus-sdk hosts as
 * `renderDiagramHtml`.
 */

import { type DiagramLayout, layoutDiagram } from "./layout.ts";
import type { DiagramSpec } from "./types.ts";

const CELL_W = 9;
const CELL_H = 20;
const PAD = 20;
const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function esc(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function px(col: number): number {
	return PAD + col * CELL_W;
}

function py(row: number): number {
	return PAD + row * CELL_H;
}

function cellCenter(p: { x: number; y: number }): { cx: number; cy: number } {
	return { cx: px(p.x) + CELL_W / 2, cy: py(p.y) + CELL_H / 2 };
}

function renderSvg(layout: DiagramLayout): string {
	const width = layout.width * CELL_W + PAD * 2;
	const height = layout.height * CELL_H + PAD * 2;
	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">`,
		`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#444"/></marker></defs>`,
		`<rect width="100%" height="100%" fill="#ffffff"/>`,
	);

	// Edges first so nodes paint over any line passing beneath a box.
	for (const edge of layout.edges) {
		const pts = edge.points.map((p, i) => {
			const c = cellCenter(p);
			// Pull the arrow endpoint back so the marker tip touches the cell.
			return `${i === 0 ? "M" : "L"}${c.cx.toFixed(1)},${c.cy.toFixed(1)}`;
		});
		parts.push(`<path d="${pts.join(" ")}" fill="none" stroke="#444" stroke-width="1.5" marker-end="url(#arrow)"/>`);
		if (edge.label && edge.labelAt) {
			const c = cellCenter(edge.labelAt);
			const tw = edge.label.length * CELL_W;
			const th = CELL_H - 6;
			parts.push(
				`<rect x="${String(c.cx - tw / 2)}" y="${String(c.cy - th / 2)}" width="${String(tw)}" height="${String(th)}" fill="#ffffff"/>`,
				`<text x="${String(c.cx)}" y="${String(c.cy)}" font-family="${FONT}" font-size="13" fill="#666" text-anchor="middle" dominant-baseline="middle">${esc(edge.label)}</text>`,
			);
		}
	}

	for (const node of layout.nodes) {
		const x = px(node.x);
		const y = py(node.y);
		const w = node.w * CELL_W;
		const h = node.h * CELL_H;
		if (node.shape === "diamond") {
			const cx = x + w / 2;
			const cy = y + h / 2;
			parts.push(
				`<polygon points="${String(cx)},${String(y)} ${String(x + w)},${String(cy)} ${String(cx)},${String(y + h)} ${String(x)},${String(cy)}" fill="#eef4ff" stroke="#4a6fa5" stroke-width="1.5"/>`,
			);
		} else {
			const rx = node.shape === "round" ? String(Math.min(h / 2, 14)) : "3";
			parts.push(
				`<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="${rx}" fill="#f7f9fc" stroke="#4a6fa5" stroke-width="1.5"/>`,
			);
		}
		const cx = x + w / 2;
		for (let i = 0; i < node.lines.length; i++) {
			const ty = y + CELL_H * (i + 0.5) + CELL_H / 2 - 4;
			parts.push(
				`<text x="${String(cx)}" y="${String(ty)}" font-family="${FONT}" font-size="13" fill="#222" text-anchor="middle" dominant-baseline="middle">${esc(node.lines[i]!)}</text>`,
			);
		}
	}

	parts.push("</svg>");
	return parts.join("\n");
}

export interface RenderDiagramHtmlOptions {
	/** Page <title> and heading (defaults to the diagram title, if any). */
	title?: string;
}

/** Render a diagram spec to a standalone HTML document with inline SVG. */
export function renderDiagramHtml(spec: DiagramSpec, options: RenderDiagramHtmlOptions = {}): string {
	const layout = layoutDiagram(spec);
	const title = options.title ?? spec.title ?? "Diagram";
	const svg = renderSvg(layout);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body { margin: 0; padding: 24px; background: #fafafa; color: #222; font-family: ${FONT}; }
h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
.diagram { display: inline-block; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
svg { display: block; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="diagram">
${svg}
</div>
</body>
</html>
`;
}
