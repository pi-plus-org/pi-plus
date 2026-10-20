/**
 * Diagram spec types shared by the layout engine, the ASCII renderer, the
 * HTML/SVG renderer, and the `draw_diagram` tool.
 */

export type DiagramShape = "box" | "round" | "diamond";

export interface DiagramNode {
	/** Unique identifier referenced by edges. */
	id: string;
	/** Display text (wrapped automatically). */
	label: string;
	/** Visual shape (HTML/SVG only; ASCII falls back to a box). */
	shape?: DiagramShape;
}

export interface DiagramEdge {
	from: string;
	to: string;
	label?: string;
}

export interface DiagramSpec {
	title?: string;
	nodes: DiagramNode[];
	edges: DiagramEdge[];
}

/** Structured `details` carried on the draw_diagram tool result. */
export interface DiagramDetails {
	spec: DiagramSpec;
	/** Rendered ASCII diagram (also present in the text content). */
	ascii: string;
	/** Absolute path of the written HTML file, when `file` was requested. */
	htmlPath?: string;
}

export const DIAGRAM_TOOL_NAME = "draw_diagram";
export const MAX_DIAGRAM_NODES = 60;
export const MAX_DIAGRAM_EDGES = 120;

/** Validation failure surfaced as a tool error. */
export class DiagramError extends Error {}
