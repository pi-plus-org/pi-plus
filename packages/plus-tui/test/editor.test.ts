// Tests for the extended Editor: typing "/" anywhere in the line opens slash completion, Tab routes mid-text
// `/name` tokens to slash completion, and confirming a mid-text completion keeps editing while a lone slash
// command still submits.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AutocompleteProvider } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

const COMMANDS = [{ value: "review", label: "review" }];

function slashProvider(): AutocompleteProvider {
	return {
		getSuggestions: async (lines, cursorLine, cursorCol) => {
			const line = lines[cursorLine] || "";
			const text = line.slice(0, cursorCol);
			const match = text.match(/(^|[\s"'(])\/(\w*)$/);
			if (!match) return null;
			const name = match[2] ?? "";
			if (name === "" || name === "rev") {
				return { items: COMMANDS, prefix: `/${name}` };
			}
			return { items: [], prefix: `/${name}` };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
			const line = lines[cursorLine] || "";
			const before = line.slice(0, cursorCol - prefix.length);
			const after = line.slice(cursorCol);
			const newLines = [...lines];
			newLines[cursorLine] = `${before}/${item.value}${after}`;
			return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length + 1 };
		},
	};
}

async function flushAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise((resolve) => setImmediate(resolve));
}

function type(editor: Editor, text: string): void {
	for (const char of text) {
		editor.handleInput(char);
	}
}

describe("Editor mid-text slash completion", () => {
	it("typing '/' after other text opens the slash menu", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(slashProvider());

		type(editor, "run /");
		await flushAutocomplete();

		assert.strictEqual(editor.isShowingAutocomplete(), true);
	});

	it("typing '/' inside a word does not open the menu", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider(slashProvider());

		type(editor, "src/");
		await flushAutocomplete();

		assert.strictEqual(editor.isShowingAutocomplete(), false);
	});

	it("Tab mid-text completes the command and keeps editing", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		let submitted: string | null = null;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setAutocompleteProvider(slashProvider());

		type(editor, "please run /rev");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		// Confirm the selection: mid-text, so it must NOT submit.
		editor.handleInput("\r");
		await flushAutocomplete();
		assert.strictEqual(submitted, null);
		assert.strictEqual(editor.getText(), "please run /review");
	});

	it("a lone slash command still submits on confirm", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		let submitted: string | null = null;
		editor.onSubmit = (text) => {
			submitted = text;
		};
		editor.setAutocompleteProvider(slashProvider());

		type(editor, "/rev");
		await flushAutocomplete();
		assert.strictEqual(editor.isShowingAutocomplete(), true);

		editor.handleInput("\r");
		await flushAutocomplete();
		assert.strictEqual(submitted, "/review");
	});
});
