// p2 redirect table for the plus-tui extensions, applied when running the pi-plus p2 (see
// ./register.mjs). Redirects the pi-tui editor/autocomplete entry points and p2's TUI completion modules
// to the extended wrappers in packages/plus-tui/src. Keep in sync with packages/plus-cli/loader/redirects.mjs,
// which applies the same pi-tui redirects to the CLI.
export const redirects = [
	["packages/tui/src/components/editor.ts", "packages/plus-tui/src/components/editor.ts"],
	["packages/tui/src/autocomplete.ts", "packages/plus-tui/src/autocomplete.ts"],
	["apps/p2/src/runtime/tui-commands.ts", "packages/plus-tui/src/p2/tui-commands.ts"],
	["apps/p2/src/runtime/completion.ts", "packages/plus-tui/src/p2/runtime-completion.ts"],
	["apps/p2/src/tui/completion.ts", "packages/plus-tui/src/p2/tui-completion.ts"],
];
