import { type Static, Type } from "typebox";

export const DrawDiagramParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional diagram title" })),
	nodes: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique id referenced by edges" }),
			label: Type.String({ description: "Display text (wrapped automatically)" }),
			shape: Type.Optional(
				Type.Union([Type.Literal("box"), Type.Literal("round"), Type.Literal("diamond")], {
					description: "Visual shape (HTML/SVG output; ASCII always draws boxes)",
				}),
			),
		}),
		{ minItems: 1, maxItems: 60 },
	),
	edges: Type.Optional(
		Type.Array(
			Type.Object({
				from: Type.String({ description: "Source node id" }),
				to: Type.String({ description: "Target node id" }),
				label: Type.Optional(Type.String({ description: "Label drawn on the edge" })),
			}),
			{ maxItems: 120 },
		),
	),
	file: Type.Optional(
		Type.String({ description: "Optional path: write the standalone HTML/SVG diagram to this file" }),
	),
});

export type DrawDiagramParams = Static<typeof DrawDiagramParams>;
