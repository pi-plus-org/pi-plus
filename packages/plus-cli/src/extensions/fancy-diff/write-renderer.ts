/**
 * Fancy renderers for the write tool.
 *
 * While arguments stream, rendering is delegated to the base (upstream)
 * renderer, which shows the syntax-highlighted content preview. On result:
 *
 *   - error                     → delegate (upstream prints the error text)
 *   - new file (pre-image null) → delegate (keep the content view)
 *   - overwrite                 → swap the call component's text to a
 *     old-vs-new fancy diff computed from the pre-image stashed by the
 *     tool_call handler (preimage.ts), and cache that string on the component
 *     so later re-renders (theme switch, expand toggle) survive LRU eviction.
 *
 * Restored sessions have no stash, so their overwrites intentionally keep the
 * plain content view.
 */

import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderers } from "../../../../coding-agent/src/core/extensions/types.ts";
import { generateDiffString, normalizeToLF } from "../../../../coding-agent/src/core/tools/edit-diff.ts";
import { resolveToCwd } from "../../../../coding-agent/src/core/tools/path-utils.ts";
import { str } from "../../../../coding-agent/src/core/tools/render-utils.ts";
import { formatChangeHeader, parseDiffStats, renderFancyDiff } from "./fancy-diff.ts";
import { peekWritePreImage } from "./preimage.ts";

type WriteCallComponent = Text & { fancyPreImage?: string; fancyPreLines?: number };

type WriteArgsLike = { path?: string; file_path?: string; content?: string };

export function createWriteFancyRenderers(
	base: ToolRenderers | undefined,
): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, theme, context) {
			const component = base?.renderCall
				? base.renderCall(args, theme, context)
				: new Text("", context.outputPad, 0);
			context.state.callComponent = component;
			return component;
		},
		renderResult(result, options, theme, context) {
			const baseResult = () => base?.renderResult?.(result, options, theme, context) ?? new Container();
			if (context.isError) return baseResult();

			const component = context.state.callComponent as WriteCallComponent | undefined;
			if (!component || typeof component.setText !== "function") return baseResult();

			const args = context.args as WriteArgsLike | undefined;
			const rawPath = str(args?.file_path ?? args?.path);
			const fileContent = str(args?.content);
			if (rawPath === null || rawPath === "" || fileContent === null) return baseResult();

			// Prefer the fresh stash entry; fall back to the copy cached on the
			// component from an earlier render (the stash is LRU-bounded).
			let preImage = component.fancyPreImage;
			let preLines = component.fancyPreLines;
			const pre = peekWritePreImage(context.toolCallId);
			if (pre && pre.content !== null) {
				let absolutePath: string;
				try {
					absolutePath = resolveToCwd(rawPath, context.cwd);
				} catch {
					absolutePath = rawPath;
				}
				// The stashed entry was read for this exact resolved target; a
				// mutated path mid-flight means it does not apply.
				if (absolutePath === pre.absolutePath) {
					preImage = pre.content;
					preLines = pre.lines;
					component.fancyPreImage = pre.content;
					component.fancyPreLines = pre.lines;
				}
			}
			if (preImage === undefined) return baseResult();

			const newContent = normalizeToLF(fileContent);
			const { diff } = generateDiffString(preImage, newContent);
			const stats = parseDiffStats(diff);
			if (stats.added === 0 && stats.removed === 0) {
				// Rewrite with identical content — nothing to show as a diff.
				return baseResult();
			}

			const note = preLines === undefined ? undefined : `overwrite, was ${preLines} lines`;
			const header = formatChangeHeader("write", rawPath, theme, context.cwd, { stats, note });
			const body = renderFancyDiff({ diff, rawPath, theme });
			component.setText(`${header}\n\n${body}`);
			return baseResult();
		},
	};
}
