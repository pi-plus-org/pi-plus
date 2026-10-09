/**
 * pi-plus-fancy-diff: upgrade the TUI rendering of code/content changes.
 *
 * Upstream paints the edit tool's diff as flat green/red/dim lines with an
 * occasional inverse word-diff, and the write tool never shows a diff at all —
 * overwriting a file just prints the new content. This extension registers a
 * tool-render resolver (pi.registerToolRenderer) that takes over `edit` and
 * `write`:
 *
 *   - both render a header with the path, +N −M change stats, and a language
 *     badge, and a body with colored +/- markers, a dim line-number gutter,
 *     syntax-highlighted line content (reusing upstream's cli-highlight
 *     pipeline), bold word-level emphasis on 1:1 line changes, and a ⋮
 *     omission separator for elided context;
 *   - `write` on an existing file becomes an old-vs-new diff (the pre-image is
 *     captured by a tool_call handler before execution, see preimage.ts); new
 *     files keep the streaming content preview;
 *   - the edit result swap keeps the upstream async-preview plumbing, plus a
 *     replay guard so settled transcripts restored from disk never degrade
 *     into "oldText not found" errors.
 *
 * No background fills anywhere — status lives in markers and colors, per the
 * plain-tools house style. All other tools pass through untouched.
 */

import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { editFancyRenderers } from "./edit-renderer.ts";
import { handleToolCallForPreImage } from "./preimage.ts";
import { createWriteFancyRenderers } from "./write-renderer.ts";

const FANCY_DIFF_TOOLS = new Set(["edit", "write"]);

export function registerFancyDiff(pi: ExtensionAPI): void {
	pi.on("tool_call", handleToolCallForPreImage);
	pi.registerToolRenderer((toolName, next) => {
		if (!FANCY_DIFF_TOOLS.has(toolName)) return next();
		// Spread the base so renderShell and any fields from later resolvers survive.
		const base = next();
		if (toolName === "edit") return { ...base, ...editFancyRenderers };
		return { ...base, ...createWriteFancyRenderers(base) };
	});
}
