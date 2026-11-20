// p2 wrapper for apps/p2/src/runtime/tui-commands.ts: re-exports everything upstream, overriding only
// SlashCompletion so a `/name` token anywhere in the line completes p2 slash commands (upstream only
// completes at the start of the line). The token check comes from ../token.ts; token completions carry the
// token as prefix so applyCompletion inserts the command inline. The upstream import below is exempt from
// plus redirects (loader exemptPrefixes), so it resolves the original module, not this wrapper.
export * from "../../../../apps/p2/src/runtime/tui-commands.ts";

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../../../tui/src/index.ts";
import { fuzzyFilter } from "../../../tui/src/index.ts";
import { extractSlashCommandToken } from "../token.ts";

// Structural view of TuiCommandDispatcher (declared in the upstream module): avoids importing apps/p2
// sources for types while staying assignment-compatible at construction sites.
type SlashCommandDispatcher = {
	contexts(): unknown;
	list(contexts: unknown): {
		slash: string | null;
		command: { title: string; slash?: { argumentHint?: string; argument?: string } };
	}[];
	getArgumentCompletions?(name: string, query: string): Promise<AutocompleteItem[] | null> | AutocompleteItem[] | null;
};

export class SlashCompletion implements AutocompleteProvider {
	private dispatcher: SlashCommandDispatcher;
	// Set when the last getSuggestions answered a mid-text `/name` token, so applyCompletion knows the
	// completion is a command name even though text before the token makes beforePrefix non-empty.
	private lastTokenCompletion = false;

	constructor(dispatcher: SlashCommandDispatcher) {
		this.dispatcher = dispatcher;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		this.lastTokenCompletion = false;

		// A `/name` token anywhere in the line ("please run /files") completes command names. Skipped for
		// forced (Tab) completion, which upstream reserves for command arguments.
		if (!options.force) {
			const token = extractSlashCommandToken(before);
			if (token !== null) {
				const namePrefix = token.slice(1);
				const items = this.dispatcher
					.list(this.dispatcher.contexts())
					.filter((item) => item.slash)
					.map((item) => {
						const hint = item.command.slash?.argumentHint;
						return {
							value: item.slash!,
							label: item.slash!,
							description: hint ? `${hint} — ${item.command.title}` : item.command.title,
						};
					});
				const filtered = fuzzyFilter(items, namePrefix, (item) => item.label).filter(
					(item) => item.label.startsWith(namePrefix) || item.value.startsWith(namePrefix),
				);
				if (filtered.length === 0) return null;
				this.lastTokenCompletion = true;
				return { items: filtered, prefix: token };
			}
		}

		if (cursorLine !== 0 || !before.startsWith("/")) return null;
		const space = before.indexOf(" ");
		// Tab (forced) completes arguments only; command names complete while typing.
		if (options.force && space === -1) return null;
		const active = this.dispatcher.contexts();
		if (space === -1) {
			const items = this.dispatcher
				.list(active)
				.filter((item) => item.slash)
				.map((item) => {
					const hint = item.command.slash?.argumentHint;
					return {
						value: item.slash!,
						label: item.slash!,
						description: hint ? `${hint} — ${item.command.title}` : item.command.title,
					};
				});
			const filtered = fuzzyFilter(items, before.slice(1), (item) => item.label).filter(
				(item) => item.label.startsWith(before.slice(1)) || item.value.startsWith(before.slice(1)),
			);
			if (filtered.length === 0) return null;
			return { items: filtered, prefix: before };
		}
		const name = before.slice(1, space);
		const query = before.slice(space + 1);
		const completes = this.dispatcher.getArgumentCompletions?.(name, query);
		const argumentItems = await completes;
		if (!Array.isArray(argumentItems) || argumentItems.length === 0) return null;
		return { items: argumentItems, prefix: query };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const line = lines[cursorLine] ?? "";
		const beforePrefix = line.slice(0, cursorCol - prefix.length);
		const afterCursor = line.slice(cursorCol);
		const adjustedAfterCursor = afterCursor.startsWith(" ") ? afterCursor.slice(1) : afterCursor;
		// Command names insert with a leading slash and a trailing space; inline completions (paths,
		// argument values) replace the matched prefix as-is. lastTokenCompletion covers the mid-text token
		// case, where text before the token makes beforePrefix non-empty.
		if (prefix.startsWith("/") && (beforePrefix.trim() === "" || this.lastTokenCompletion)) {
			const before = line.slice(0, cursorCol - prefix.length);
			const newLine = `${before}/${item.value} ${adjustedAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			const newCursorCol = before.length + item.value.length + 2;
			return { lines: newLines, cursorLine, cursorCol: newCursorCol };
		}
		const newLine = `${beforePrefix}${item.value}${afterCursor}`;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;
		const newCursorCol = beforePrefix.length + item.value.length;
		return { lines: newLines, cursorLine, cursorCol: newCursorCol };
	}
}
