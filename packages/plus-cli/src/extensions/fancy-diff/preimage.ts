/**
 * Write-tool pre-image stash.
 *
 * The upstream write tool carries no pre-image (its result is just
 * "Successfully wrote to <path>"), so an overwrite diff needs the old file
 * content captured before execution. The extension registers a `tool_call`
 * handler (awaited before the tool runs) that reads the target file into a
 * bounded LRU keyed by tool call id; the write renderer consumes it on result
 * and caches the string on the call component for later re-renders.
 *
 * A throwing `tool_call` handler blocks execution (agent-session awaits it and
 * surfaces errors as blocks), so every failure path here is swallowed.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionContext, ToolCallEvent } from "../../../../coding-agent/src/core/extensions/types.ts";
import { normalizeToLF } from "../../../../coding-agent/src/core/tools/edit-diff.ts";
import { resolveToCwd } from "../../../../coding-agent/src/core/tools/path-utils.ts";
import { str } from "../../../../coding-agent/src/core/tools/render-utils.ts";
import { splitBom } from "../../../../coding-agent/src/utils/text.ts";

export interface WritePreImage {
	/** Path as the model wrote it (may be relative). */
	path: string;
	/** Resolved absolute path — renderers re-resolve the args to detect mid-flight argument mutation. */
	absolutePath: string;
	/** Previous file content, LF-normalized; null when the file did not exist (new file). */
	content: string | null;
	/** Line count of the previous content (0 for new files; a trailing newline does not count as an empty line). */
	lines: number;
}

const MAX_STASH_ENTRIES = 32;
/** Larger files fall back to the plain content view — such diffs would be unreadable anyway. */
const MAX_PREIMAGE_BYTES = 256 * 1024;

const stash = new Map<string, WritePreImage>();

/** Display line count of LF-normalized content: an empty final segment (trailing newline) is not a line. */
function countLines(content: string): number {
	if (content === "") return 0;
	return content.replace(/\n+$/, "").split("\n").length;
}

function putPreImage(toolCallId: string, preImage: WritePreImage): void {
	stash.set(toolCallId, preImage);
	while (stash.size > MAX_STASH_ENTRIES) {
		const oldest = stash.keys().next();
		if (oldest.done) break;
		stash.delete(oldest.value);
	}
}

export function peekWritePreImage(toolCallId: string): WritePreImage | undefined {
	return stash.get(toolCallId);
}

/** Test seam: clears the stash. */
export function clearWritePreImages(): void {
	stash.clear();
}

/** `tool_call` handler: stash the pre-image of every TUI write call. Never throws. */
export async function handleToolCallForPreImage(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
	try {
		if (ctx.mode !== "tui") return;
		if (event.toolName !== "write") return;
		// file_path is the tolerated alias some providers emit (upstream renderers accept both).
		const input = event.input as { file_path?: string; path?: string };
		const rawPath = str(input.file_path ?? input.path);
		if (rawPath === null || rawPath === "") return;
		const absolutePath = resolveToCwd(rawPath, ctx.cwd);
		let content: string | null;
		try {
			const raw = await readFile(absolutePath, "utf-8");
			content = normalizeToLF(splitBom(raw).text);
		} catch (error: unknown) {
			// ENOENT means the write creates a new file; any other failure (permissions,
			// directory, unreadable device) leaves the plain content view in place.
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") content = null;
			else return;
		}
		if (content !== null && content.length > MAX_PREIMAGE_BYTES) return;
		putPreImage(event.toolCallId, {
			path: rawPath,
			absolutePath,
			content,
			lines: content === null ? 0 : countLines(content),
		});
	} catch {
		// Never block the tool call.
	}
}
