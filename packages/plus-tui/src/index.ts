// Entry point for the plus-tui extensions: token helpers, the extended editor and autocomplete provider,
// and the p2-side providers under ./p2/.

export type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, SlashCommand } from "./autocomplete.ts";
export { CombinedAutocompleteProvider } from "./autocomplete.ts";
export type { EditorOptions, EditorTheme, TextChunk } from "./components/editor.ts";
export { Editor, wordWrapLine } from "./components/editor.ts";
export { extractSlashCommandToken } from "./token.ts";
