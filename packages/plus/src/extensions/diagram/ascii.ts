/**
 * ASCII/box-drawing renderer for a DiagramLayout. Paints edge polylines onto
 * a character grid (links tracked per cell so crossings render as proper
 * box-drawing glyphs), then edge labels, then node boxes on top so lines
 * passing under boxes are hidden.
 */

import type { DiagramLayout, GridPoint, PlacedEdge, PlacedNode } from "./layout.ts";

const N = 1;
const E = 2;
const S = 4;
const W = 8;

interface Cell {
	ch: string;
	links: number;
}

function linksToChar(links: number): string {
	switch (links) {
		case N:
		case S:
		case N | S:
			return "│";
		case E:
		case W:
		case E | W:
			return "─";
		case S | E:
			return "┌";
		case S | W:
			return "┐";
		case N | E:
			return "└";
		case N | W:
			return "┘";
		case N | E | S:
			return "├";
		case N | S | W:
			return "┤";
		case E | S | W:
			return "┬";
		case N | E | W:
			return "┴";
		default:
			return "┼";
	}
}

class Canvas {
	private cells: Map<number, Cell>[] = [];
	private width = 0;
	private height = 0;

	ensure(x: number, y: number): void {
		this.width = Math.max(this.width, x + 1);
		this.height = Math.max(this.height, y + 1);
		while (this.cells.length < this.height) this.cells.push(new Map());
	}

	private cell(x: number, y: number): Cell {
		this.ensure(x, y);
		let row = this.cells[y];
		if (!row) {
			row = new Map();
			this.cells[y] = row;
		}
		let c = row.get(x);
		if (!c) {
			c = { ch: " ", links: 0 };
			row.set(x, c);
		}
		return c;
	}

	link(x: number, y: number, bits: number): void {
		this.cell(x, y).links |= bits;
	}

	write(x: number, y: number, ch: string): void {
		const c = this.cell(x, y);
		c.links = 0;
		c.ch = ch;
	}

	render(): string {
		const lines: string[] = [];
		for (let y = 0; y < this.height; y++) {
			const row = this.cells[y];
			let line = "";
			for (let x = 0; x < this.width; x++) {
				const c = row?.get(x);
				line += c ? (c.links !== 0 ? linksToChar(c.links) : c.ch) : " ";
			}
			lines.push(line.trimEnd());
		}
		while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.join("\n");
	}
}

function drawEdgeLine(canvas: Canvas, points: GridPoint[]): void {
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i]!;
		const b = points[i + 1]!;
		if (a.x === b.x) {
			const [y1, y2] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
			for (let y = y1; y <= y2; y++) {
				if (y === y1) canvas.link(a.x, y, S);
				else if (y === y2) canvas.link(a.x, y, N);
				else canvas.link(a.x, y, N | S);
			}
		} else {
			const [x1, x2] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
			for (let x = x1; x <= x2; x++) {
				if (x === x1) canvas.link(x, a.y, E);
				else if (x === x2) canvas.link(x, a.y, W);
				else canvas.link(x, a.y, E | W);
			}
		}
	}
}

function drawNode(canvas: Canvas, node: PlacedNode): void {
	const { x, y, w, h, lines } = node;
	// Clear any edge links inside the box footprint first.
	for (let yy = y; yy < y + h; yy++) {
		for (let xx = x; xx < x + w; xx++) canvas.write(xx, yy, " ");
	}
	for (let xx = x + 1; xx < x + w - 1; xx++) {
		canvas.write(xx, y, "─");
		canvas.write(xx, y + h - 1, "─");
	}
	canvas.write(x, y, "┌");
	canvas.write(x + w - 1, y, "┐");
	canvas.write(x, y + h - 1, "└");
	canvas.write(x + w - 1, y + h - 1, "┘");
	for (let yy = y + 1; yy < y + h - 1; yy++) {
		canvas.write(x, yy, "│");
		canvas.write(x + w - 1, yy, "│");
		const line = lines[yy - y - 1] ?? "";
		const start = x + 1 + Math.floor((w - 2 - line.length) / 2);
		for (let i = 0; i < line.length; i++) canvas.write(start + i, yy, line[i]!);
	}
}

function drawEdgeLabel(canvas: Canvas, edge: PlacedEdge): void {
	if (!edge.label || !edge.labelAt) return;
	const { x, y } = edge.labelAt;
	for (let i = -1; i <= edge.label.length; i++) canvas.write(x + i, y, " ");
	for (let i = 0; i < edge.label.length; i++) canvas.write(x + i, y, edge.label[i]!);
}

export interface AsciiRenderOptions {
	/** Draw the title as the first line (centered over the diagram). */
	includeTitle?: boolean;
}

export function renderAsciiLayout(layout: DiagramLayout, options: AsciiRenderOptions = {}): string {
	const canvas = new Canvas();
	for (const edge of layout.edges) drawEdgeLine(canvas, edge.points);
	for (const edge of layout.edges) {
		canvas.write(edge.arrowAt.x, edge.arrowAt.y, edge.arrowDir === "down" ? "▼" : "▲");
		drawEdgeLabel(canvas, edge);
	}
	for (const node of layout.nodes) drawNode(canvas, node);
	const body = canvas.render();
	if (options.includeTitle && layout.title) {
		const width = Math.max(layout.width, ...body.split("\n").map((l) => l.length));
		const pad = Math.max(0, Math.floor((width - layout.title.length) / 2));
		return `${" ".repeat(pad)}${layout.title}\n\n${body}`;
	}
	return body;
}
