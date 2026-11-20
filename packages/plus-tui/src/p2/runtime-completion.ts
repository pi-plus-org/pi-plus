// p2 wrapper for apps/p2/src/runtime/completion.ts: re-exports everything upstream, overriding only
// shouldTriggerFileCompletion so a `/name` token at the cursor declines forced (Tab) file completion and
// routes to slash-command completion instead. The upstream import is exempt from plus redirects.
export * from "../../../../apps/p2/src/runtime/completion.ts";

import { extractSlashCommandToken } from "../token.ts";

export function shouldTriggerFileCompletion(textBeforeCursor: string): boolean {
	if (textBeforeCursor.trim().length === 0) return false;
	// A `/name` token completes a slash command, not files (paths like "/usr/lo" still do).
	if (extractSlashCommandToken(textBeforeCursor) !== null) return false;
	return true;
}
