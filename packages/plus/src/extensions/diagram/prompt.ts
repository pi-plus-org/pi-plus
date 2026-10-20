/**
 * Prompt text for the draw_diagram tool.
 */

import { DIAGRAM_TOOL_NAME } from "./types.ts";

export const DIAGRAM_DESCRIPTION = `Draw a node-and-edge diagram (flowchart, dependency graph, architecture sketch) from a structured spec: nodes with labels plus edges referencing node ids. The tool renders a box-drawing diagram inline and can write a standalone HTML/SVG file when "file" is given.`;

export const DIAGRAM_SNIPPET = `- ${DIAGRAM_TOOL_NAME}({ title?, nodes: [{id, label, shape?}], edges: [{from, to, label?}], file? }) — draw a node-edge diagram (ASCII inline, optional HTML/SVG file)`;

export const DIAGRAM_GUIDELINES = [
	`Use ${DIAGRAM_TOOL_NAME} when the user asks to draw/diagram/visualize components, flows, or dependencies as a graph; keep specs small (under 20 nodes) and readable.`,
	`Give every node a short label and unique id; edge from/to must reference existing node ids; use shape "diamond" for decisions and "round" for start/end in flowcharts.`,
	`Pass "file" (a .html path) only when the user wants a saved/renderable diagram; the inline ASCII diagram is enough for conversation.`,
];
