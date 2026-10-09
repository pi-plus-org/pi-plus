/**
 * Fancy renderers for the edit tool.
 *
 * Port of upstream coding-agent `src/core/tools/renderers/edit.ts` (its
 * internals are module-private, so the preview plumbing is duplicated here —
 * re-sync mechanically if upstream changes). Intentional deltas from upstream:
 *
 *   1. No background fills — plain-tools house style; the header keeps no
 *      setBgFn state and status lives in the diff colors/words.
 *   2. Header carries +N −M stats and a language badge; the body renders
 *      through renderFancyDiff (syntax-highlighted bodies, word emphasis).
 *   3. Replay guard: once the result diff has been applied to the call
 *      component, a late computeEditsDiff preview is dropped. Without it,
 *      re-rendering a settled transcript (argsComplete is true again, no
 *      preview in memory) re-reads the already-edited file, fails to match
 *      oldText, and overwrites the restored diff with an error.
 */

import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { EditToolDetails } from "../../../../coding-agent/src/core/tools/edit.ts";
import {
	computeEditsDiff,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
} from "../../../../coding-agent/src/core/tools/edit-diff.ts";
import { str } from "../../../../coding-agent/src/core/tools/render-utils.ts";
import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { formatChangeHeader, parseDiffStats, renderFancyDiff } from "./fancy-diff.ts";

type EditPreview = EditDiffResult | EditDiffError;
type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};
type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};
type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
	resultApplied?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
		resultApplied: false,
	});
}

function getEditCallRenderComponent(state: { callComponent?: EditCallRenderComponent }, lastComponent: unknown) {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) return null;

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) return null;

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function getRawPath(args: RenderableEditArgs | undefined): string | null {
	return str(args?.file_path ?? args?.path);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
	outputPad: number,
): EditCallRenderComponent {
	component.setPaddingX(outputPad);
	component.clear();

	const rawPath = getRawPath(args);
	const preview = component.preview;
	const stats = preview && !("error" in preview) ? parseDiffStats(preview.diff) : undefined;
	component.addChild(new Text(formatChangeHeader("edit", rawPath, theme, cwd, { stats }), 0, 0));

	if (!preview) {
		return component;
	}

	const body =
		"error" in preview ? theme.fg("error", preview.error) : renderFancyDiff({ diff: preview.diff, rawPath, theme });
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = getRawPath(args);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderFancyDiff({ diff: resultDiff, rawPath, theme });
	}

	return undefined;
}

export const editFancyRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const component = getEditCallRenderComponent(context.state, context.lastComponent);
		const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;

		if (component.previewArgsKey !== argsKey) {
			component.preview = undefined;
			component.previewArgsKey = argsKey;
			component.previewPending = false;
			component.settledError = false;
			component.resultApplied = false;
		}

		if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
			component.previewPending = true;
			const requestKey = argsKey;
			void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
				if (component.previewArgsKey !== requestKey) return;
				// Replay guard: the settled result diff already owns the component.
				if (component.resultApplied) {
					component.previewPending = false;
					return;
				}
				if (setEditPreview(component, preview, requestKey)) {
					buildEditCallComponent(
						component,
						args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
						context.outputPad,
					);
				}
				context.invalidate();
			});
		}

		return buildEditCallComponent(
			component,
			args as RenderableEditArgs | undefined,
			theme,
			context.cwd,
			context.outputPad,
		);
	},
	renderResult(result, _options, theme, context) {
		const callComponent = context.state.callComponent as EditCallRenderComponent | undefined;
		const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
		const argsKey = previewInput ? JSON.stringify({ path: previewInput.path, edits: previewInput.edits }) : undefined;
		const typedResult = result as EditToolResultLike;
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		let changed = false;
		if (callComponent) {
			if (typeof resultDiff === "string") {
				callComponent.resultApplied = true;
				changed =
					setEditPreview(
						callComponent,
						{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
						argsKey,
					) || changed;
			}
			if (callComponent.settledError !== context.isError) {
				callComponent.settledError = context.isError;
				changed = true;
			}
			if (changed) {
				buildEditCallComponent(
					callComponent,
					context.args as RenderableEditArgs | undefined,
					theme,
					context.cwd,
					context.outputPad,
				);
			}
		}

		const output = formatEditResult(
			context.args as RenderableEditArgs | undefined,
			callComponent?.preview,
			typedResult,
			theme,
			context.isError,
		);
		const component = (context.lastComponent as Container | undefined) ?? new Container();
		component.clear();
		if (!output) {
			return component;
		}
		component.addChild(new Spacer(1));
		component.addChild(new Text(output, context.outputPad, 0));
		return component;
	},
};
