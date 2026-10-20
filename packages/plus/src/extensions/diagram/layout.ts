/**
 * Dependency-free layered layout for node-edge diagrams, computed on a
 * character grid so the ASCII and the HTML/SVG renderers draw identical
 * geometry (the HTML renderer just scales columns/rows to pixels).
 *
 * Pipeline: validate → DFS back-edge detection (cycles) → longest-path
 * ranking → barycenter ordering within ranks (two sweeps) → column packing
 * with per-rank centering → orthogonal edge routing.
 */

import { type DiagramEdge, DiagramError, type DiagramNode, type DiagramShape, type DiagramSpec } from "./types.ts";

export interface GridPoint {
	x: number;
	y: number;
}

export interface PlacedNode {
	id: string;
	shape: DiagramShape;
	/** Pre-wrapped label lines, each at most 28 cells. */
	lines: string[];
	/** Bounding box on the character grid (x = left column, y = top row). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Center column of the box. */
	cx: number;
	rank: number;
}

export interface PlacedEdge {
	from: string;
	to: string;
	/** True when the logical direction runs bottom-to-top (cycle back edge). */
	reversed: boolean;
	/** Polyline vertices (grid cells); consecutive pairs form segments. */
	points: GridPoint[];
	label?: string;
	/** Top-left cell to paint the label at (renderer erases behind it). */
	labelAt?: GridPoint;
	/** Cell that holds the arrowhead, adjacent to the logical target box. */
	arrowAt: GridPoint;
	arrowDir: "down" | "up";
}

export interface DiagramLayout {
	title?: string;
	width: number;
	height: number;
	nodes: PlacedNode[];
	edges: PlacedEdge[];
}

export const DIAGRAM_GAP_X = 4;
const GAP_X = DIAGRAM_GAP_X;
const GAP_Y = 4;
const MAX_LABEL_WIDTH = 28;

export class DiagramValidationError extends DiagramError {}

export function validateDiagramSpec(spec: DiagramSpec): void {
	if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) throw new DiagramValidationError("Diagram has no nodes");
	const edges = spec.edges ?? [];
	const ids = new Set<string>();
	for (const node of spec.nodes) {
		if (!node.id || node.id.trim() === "") throw new DiagramValidationError("Node with empty id");
		if (ids.has(node.id)) throw new DiagramValidationError(`Duplicate node id: ${node.id}`);
		ids.add(node.id);
	}
	for (const edge of edges) {
		if (!ids.has(edge.from)) throw new DiagramValidationError(`Edge references unknown node: ${edge.from}`);
		if (!ids.has(edge.to)) throw new DiagramValidationError(`Edge references unknown node: ${edge.to}`);
		if (edge.from === edge.to) throw new DiagramValidationError(`Self-loop on node: ${edge.from}`);
	}
}

/** Wrap a label into lines of at most MAX_LABEL_WIDTH cells (breaks long words). */
export function wrapLabel(label: string, width = MAX_LABEL_WIDTH): string[] {
	const words = label.split(/\s+/).filter((w) => w.length > 0);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	for (let word of words) {
		while (word.length > width) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			lines.push(word.slice(0, width));
			word = word.slice(width);
		}
		if (current.length === 0) current = word;
		else if (current.length + 1 + word.length <= width) current += ` ${word}`;
		else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

interface NodeBox {
	node: DiagramNode;
	shape: DiagramShape;
	lines: string[];
	w: number;
	h: number;
	rank: number;
	x: number;
}

/** DFS over the graph marking edges that close a cycle (back edges). */
function findBackEdges(nodes: DiagramNode[], edges: DiagramEdge[]): Set<DiagramEdge> {
	const out = new Map<string, DiagramEdge[]>();
	for (const n of nodes) out.set(n.id, []);
	for (const e of edges) out.get(e.from)?.push(e);
	const state = new Map<string, 0 | 1 | 2>();
	const back = new Set<DiagramEdge>();
	for (const start of nodes) {
		if ((state.get(start.id) ?? 0) !== 0) continue;
		const stack: { id: string; next: number }[] = [{ id: start.id, next: 0 }];
		state.set(start.id, 1);
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const list = out.get(frame.id) ?? [];
			if (frame.next < list.length) {
				const edge = list[frame.next]!;
				frame.next += 1;
				const s = state.get(edge.to) ?? 0;
				if (s === 1) back.add(edge);
				else if (s === 0) {
					state.set(edge.to, 1);
					stack.push({ id: edge.to, next: 0 });
				}
			} else {
				state.set(frame.id, 2);
				stack.pop();
			}
		}
	}
	return back;
}

/** Longest-path ranking over the forward DAG (back edges excluded). */
function rankNodes(nodes: DiagramNode[], edges: DiagramEdge[], back: Set<DiagramEdge>): Map<string, number> {
	const forward = new Map<string, DiagramEdge[]>();
	const indegree = new Map<string, number>();
	const rankOf = new Map<string, number>();
	for (const n of nodes) {
		forward.set(n.id, []);
		indegree.set(n.id, 0);
		rankOf.set(n.id, 0);
	}
	for (const e of edges) {
		if (back.has(e)) continue;
		forward.get(e.from)!.push(e);
		indegree.set(e.to, indegree.get(e.to)! + 1);
	}
	const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const e of forward.get(id)!) {
			rankOf.set(e.to, Math.max(rankOf.get(e.to)!, rankOf.get(id)! + 1));
			indegree.set(e.to, indegree.get(e.to)! - 1);
			if (indegree.get(e.to) === 0) queue.push(e.to);
		}
	}
	return rankOf;
}

function packRank(rank: NodeBox[]): number {
	let x = 0;
	for (const box of rank) {
		box.x = x;
		x += box.w + GAP_X;
	}
	return Math.max(0, x - GAP_X);
}

export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
	validateDiagramSpec(spec);
	const edges = spec.edges ?? [];
	const back = findBackEdges(spec.nodes, edges);
	const rankOf = rankNodes(spec.nodes, edges, back);

	const boxes: NodeBox[] = spec.nodes.map((node) => {
		const lines = wrapLabel(node.label ?? node.id);
		const w = Math.max(...lines.map((l) => l.length), 4) + 2;
		return { node, shape: node.shape ?? "box", lines, w, h: lines.length + 2, rank: rankOf.get(node.id)!, x: 0 };
	});
	const boxOf = new Map(boxes.map((b) => [b.node.id, b]));

	const ranks: NodeBox[][] = [];
	for (const box of boxes) {
		while (ranks.length <= box.rank) ranks.push([]);
		ranks[box.rank]!.push(box);
	}

	// Neighbor lists for barycenter ordering use forward edges only.
	const preds = new Map<string, NodeBox[]>();
	const succs = new Map<string, NodeBox[]>();
	for (const b of boxes) {
		preds.set(b.node.id, []);
		succs.set(b.node.id, []);
	}
	for (const e of edges) {
		if (back.has(e)) continue;
		succs.get(e.from)!.push(boxOf.get(e.to)!);
		preds.get(e.to)!.push(boxOf.get(e.from)!);
	}

	const packAll = (): number => {
		let width = 0;
		for (const rank of ranks) width = Math.max(width, packRank(rank));
		return width;
	};
	const center = (b: NodeBox): number => b.x + b.w / 2;
	const barycenter = (box: NodeBox, neighbors: Map<string, NodeBox[]>): number => {
		const list = neighbors.get(box.node.id)!;
		if (list.length === 0) return center(box);
		return list.reduce((sum, n) => sum + center(n), 0) / list.length;
	};
	const sweep = (order: number[], neighbors: Map<string, NodeBox[]>): void => {
		for (const r of order) {
			const rank = ranks[r]!;
			rank.sort((a, b) => barycenter(a, neighbors) - barycenter(b, neighbors) || a.rank - b.rank);
			packRank(rank);
		}
	};

	let globalWidth = packAll();
	const rankIndexes = ranks.map((_, i) => i);
	for (let pass = 0; pass < 2; pass++) {
		sweep(rankIndexes.slice(1), preds); // top-down by predecessors
		sweep([...rankIndexes].reverse().slice(0, -1), succs); // bottom-up by successors
		globalWidth = Math.max(globalWidth, ...ranks.map((rank) => rank.reduce((s, b) => s + b.w + GAP_X, 0) - GAP_X));
	}

	// Center each rank within the global width; assign rows.
	const rankY: number[] = [];
	let y = 0;
	for (const rank of ranks) {
		rankY.push(y);
		y += Math.max(...rank.map((b) => b.h)) + GAP_Y;
	}
	const height = Math.max(0, y - GAP_Y);
	for (let r = 0; r < ranks.length; r++) {
		const rank = ranks[r]!;
		const width = rank.reduce((s, b) => s + b.w + GAP_X, 0) - GAP_X;
		const offset = Math.floor((globalWidth - width) / 2);
		for (const box of rank) box.x += offset;
	}

	const nodes: PlacedNode[] = boxes.map((box) => ({
		id: box.node.id,
		shape: box.shape,
		lines: box.lines,
		x: box.x,
		y: rankY[box.rank]!,
		w: box.w,
		h: box.h,
		cx: box.x + Math.floor(box.w / 2),
		rank: box.rank,
	}));
	const placedOf = new Map(nodes.map((n) => [n.id, n]));

	const placedEdges: PlacedEdge[] = [];
	// Spread edges that need a horizontal lane across the free rows between
	// rank bands so lanes (and their labels) rarely share one row.
	const laneCounter = new Map<string, number>();
	const reserved = new Set<string>();
	for (const e of edges) {
		const reversed = back.has(e);
		const fromN = placedOf.get(e.from)!;
		const toN = placedOf.get(e.to)!;
		// Geometry flows top-to-bottom regardless of logical direction.
		const hi = fromN.rank <= toN.rank ? fromN : toN;
		const lo = hi === fromN ? toN : fromN;
		const startY = hi.y + hi.h; // first free row below the upper box
		const arrowY = lo.y - 1; // free row above the lower box
		let laneY = arrowY - 1;
		if (hi.cx !== lo.cx) {
			const bandLo = startY + 1;
			const bandHi = Math.max(bandLo, lo.y - 2);
			const bandKey = `${String(bandLo)}:${String(bandHi)}`;
			const n = laneCounter.get(bandKey) ?? 0;
			laneCounter.set(bandKey, n + 1);
			laneY = bandLo + (n % (bandHi - bandLo + 1));
		}
		let arrowAt: GridPoint;
		let arrowDir: "down" | "up";
		let route: GridPoint[];
		if (!reversed) {
			// Arrow enters the lower box from above.
			arrowAt = { x: lo.cx, y: arrowY };
			arrowDir = "down";
			route =
				hi.cx === lo.cx
					? [
							{ x: hi.cx, y: startY },
							{ x: lo.cx, y: arrowY },
						]
					: [
							{ x: hi.cx, y: startY },
							{ x: hi.cx, y: laneY },
							{ x: lo.cx, y: laneY },
							{ x: lo.cx, y: arrowY },
						];
		} else {
			// Logical target is the upper box: the arrow enters it from below
			// and the polyline starts under the lower box instead.
			arrowAt = { x: hi.cx, y: startY };
			arrowDir = "up";
			route =
				hi.cx === lo.cx
					? [
							{ x: lo.cx, y: lo.y + lo.h },
							{ x: hi.cx, y: startY },
						]
					: [
							{ x: lo.cx, y: lo.y + lo.h },
							{ x: lo.cx, y: laneY },
							{ x: hi.cx, y: laneY },
							{ x: hi.cx, y: startY },
						];
		}
		const labelAt = e.label ? chooseLabelPosition(route, e.label, reserved) : undefined;
		placedEdges.push({ from: e.from, to: e.to, reversed, points: route, label: e.label, labelAt, arrowAt, arrowDir });
	}

	return { title: spec.title, width: globalWidth, height, nodes, edges: placedEdges };
}

/**
 * Pick a label cell: centered on the longest horizontal segment, sliding
 * sideways (or onto a free row beside a vertical segment) when the ideal
 * span collides with an already-placed label.
 */
function chooseLabelPosition(points: GridPoint[], label: string, reserved: Set<string>): GridPoint {
	const free = (x: number, y: number): boolean => {
		if (x < 0) return false;
		for (let i = -1; i <= label.length; i++) {
			if (reserved.has(`${y}:${x + i}`)) return false;
		}
		return true;
	};
	const claim = (p: GridPoint): GridPoint => {
		for (let i = -1; i <= label.length; i++) reserved.add(`${p.y}:${p.x + i}`);
		return p;
	};
	let best: { lo: number; hi: number; y: number } | undefined;
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i]!;
		const b = points[i + 1]!;
		if (a.x === b.x) continue;
		const lo = Math.min(a.x, b.x);
		const hiB = Math.max(a.x, b.x);
		if (!best || hiB - lo > best.hi - best.lo) best = { lo, hi: hiB, y: a.y };
	}
	if (best) {
		const maxStart = Math.max(best.lo, best.hi - label.length);
		const ideal = Math.max(0, Math.floor((best.lo + best.hi) / 2) - Math.floor(label.length / 2));
		for (let d = 0; ideal - d <= maxStart || ideal + d >= best.lo; d++) {
			for (const cand of d === 0 ? [ideal] : [ideal - d, ideal + d]) {
				if (cand >= best.lo && cand <= maxStart && free(cand, best.y)) return claim({ x: cand, y: best.y });
			}
			if (ideal - d < best.lo && ideal + d > maxStart) break;
		}
	}
	// Vertical routes (or no room on any horizontal): place beside the first
	// segment midpoint and slide downward until free.
	const a = points[0]!;
	const b = points[1]!;
	const x = Math.min(a.x, b.x) + 2;
	let y = Math.floor((a.y + b.y) / 2);
	while (!free(x, y) && y < 4096) y += 1;
	return claim({ x, y });
}
