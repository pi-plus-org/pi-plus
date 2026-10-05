/**
 * Tests for the image paste marker wrapper: pasted/dropped image paths and
 * Ctrl+V clipboard images display as `[image #N]` in the editor, and the real
 * path is restored verbatim at submit time.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditorTheme, Editor as EditorType, TUI } from "@earendil-works/pi-tui";
import { Editor, KeybindingsManager } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { imageMarkerText, transformImagePaths } from "../../src/coding-agent/modes/interactive/image-paste-markers.ts";

// Importing the wrapper installs the prototype patches (side effect) and
// re-exports the patched InteractiveMode class.
import { InteractiveMode } from "../../src/coding-agent/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ mimeType: string; bytes: Uint8Array } | null>>(),
}));

vi.mock("../../../coding-agent/src/utils/clipboard.ts", () => ({
	readClipboardFilePaths: clipboardMocks.readClipboardFilePaths,
	readClipboardText: clipboardMocks.readClipboardText,
}));

vi.mock("../../../coding-agent/src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: (mimeType: string) => (mimeType === "image/png" ? "png" : null),
	readClipboardImage: clipboardMocks.readClipboardImage,
}));

function createTestTUI(): TUI {
	return { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
}

const theme: EditorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
};

function paste(editor: EditorType, text: string): void {
	editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function submit(editor: EditorType): string {
	let submitted: string | null = null;
	editor.onSubmit = (text: string) => {
		submitted = text;
	};
	editor.handleInput("\r");
	assert.notEqual(submitted, null, "expected the editor to submit");
	return submitted as unknown as string;
}

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-plus-image-paste-"));
	clipboardMocks.readClipboardFilePaths.mockReset().mockResolvedValue(null);
	clipboardMocks.readClipboardText.mockReset().mockResolvedValue(null);
	clipboardMocks.readClipboardImage.mockReset().mockResolvedValue(null);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeImage(name: string): string {
	const filePath = join(tempDir, name);
	writeFileSync(filePath, "fake-png-bytes");
	return filePath;
}

describe("editor paste marker transformation", () => {
	it("shows a marker for a pasted image path and expands it on submit", () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("screenshot.png");

		paste(editor, `look at ${imagePath} please`);

		assert.equal(editor.getText(), `look at ${imageMarkerText(1)} please`);
		assert.equal(editor.getExpandedText(), `look at ${imagePath} please`);
		assert.equal(submit(editor), `look at ${imagePath} please`);
	});

	it("assigns distinct ids to multiple images in one paste", () => {
		const editor = new Editor(createTestTUI(), theme);
		const first = writeImage("a.png");
		const second = writeImage("b.jpg");

		paste(editor, `${first} and ${second}`);

		assert.equal(editor.getText(), `${imageMarkerText(1)} and ${imageMarkerText(2)}`);
		assert.equal(editor.getExpandedText(), `${first} and ${second}`);
	});

	it("keeps incrementing ids across pastes on the same editor", () => {
		const editor = new Editor(createTestTUI(), theme);
		const first = writeImage("a.png");
		const second = writeImage("b.png");

		paste(editor, first);
		paste(editor, second);

		assert.equal(editor.getText(), `${imageMarkerText(1)}${imageMarkerText(2)}`);
		assert.equal(editor.getExpandedText(), `${first}${second}`);
	});

	it("matches paths with backslash-escaped spaces and restores them verbatim", () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("My Photo.png");
		const escaped = imagePath.replaceAll(" ", "\\ ");

		paste(editor, escaped);

		assert.equal(editor.getText(), imageMarkerText(1));
		assert.equal(editor.getExpandedText(), escaped);
		assert.equal(submit(editor), escaped);
	});

	it("keeps surrounding quotes and expands only the quoted path", () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("quoted.png");

		paste(editor, `'${imagePath}'`);

		assert.equal(editor.getText(), `'${imageMarkerText(1)}'`);
		assert.equal(editor.getExpandedText(), `'${imagePath}'`);
	});

	it("keeps parentheses around a path in prose", () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("paren.png");

		paste(editor, `(see ${imagePath})`);

		assert.equal(editor.getText(), `(see ${imageMarkerText(1)})`);
		assert.equal(editor.getExpandedText(), `(see ${imagePath})`);
	});

	it("leaves nonexistent image paths untouched", () => {
		const editor = new Editor(createTestTUI(), theme);
		const missing = join(tempDir, "does-not-exist.png");

		paste(editor, `check ${missing} now`);

		assert.equal(editor.getText(), `check ${missing} now`);
	});

	it("leaves existing non-image files untouched", () => {
		const editor = new Editor(createTestTUI(), theme);
		const textPath = join(tempDir, "notes.txt");
		writeFileSync(textPath, "text");

		paste(editor, `read ${textPath}`);

		assert.equal(editor.getText(), `read ${textPath}`);
	});

	it("leaves bare image filenames without a path separator untouched", () => {
		const editor = new Editor(createTestTUI(), theme);
		writeImage("logo.png");

		paste(editor, "the logo.png file");

		assert.equal(editor.getText(), "the logo.png file");
	});

	it("expands image markers inside large pastes wrapped in upstream paste markers", () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("big.png");
		// Large pastes become upstream [paste #N ...] markers; an image path
		// inside one must still be rewritten and expanded.
		const large = `${imagePath}\n${"x".repeat(2000)}`;

		paste(editor, large);

		assert.match(editor.getText(), /^\[paste #\d+ \d+ chars\]$/);
		assert.ok(editor.getExpandedText().startsWith(imagePath));
	});

	it("returns text unchanged when no image extension appears", () => {
		const editor = new Editor(createTestTUI(), theme);
		assert.equal(transformImagePaths(editor, "plain text, no paths"), "plain text, no paths");
	});
});

describe("handleClipboardPaste prototype patch", () => {
	function clipboardTarget(editor: EditorType) {
		const errors: string[] = [];
		const target = {
			editor,
			isBashMode: false,
			ui: { requestRender: () => {} },
			showError: (message: string) => errors.push(message),
		};
		const pasteFromClipboard = (
			InteractiveMode.prototype as unknown as { handleClipboardPaste(): Promise<void> }
		).handleClipboardPaste.bind(target);
		return { pasteFromClipboard, errors };
	}

	it("pastes a clipboard image as a marker and writes the temp file", async () => {
		const editor = new Editor(createTestTUI(), theme);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		clipboardMocks.readClipboardImage.mockResolvedValue({ mimeType: "image/png", bytes });
		const { pasteFromClipboard } = clipboardTarget(editor);

		await pasteFromClipboard();

		const marker = imageMarkerText(1);
		assert.equal(editor.getText(), marker);
		const expanded = editor.getExpandedText();
		assert.match(expanded, /^\/.*pi-clipboard-.*\.png$/);
		assert.ok(existsSync(expanded));
	});

	it("marker-izes image file paths from the file pasteboard, keeping other files as paths", async () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("clip.png");
		const textPath = join(tempDir, "clip.txt");
		writeFileSync(textPath, "text");
		clipboardMocks.readClipboardFilePaths.mockResolvedValue([imagePath, textPath]);
		const { pasteFromClipboard } = clipboardTarget(editor);

		await pasteFromClipboard();

		assert.equal(editor.getText(), `${imageMarkerText(1)}\n${textPath}`);
		assert.equal(editor.getExpandedText(), `${imagePath}\n${textPath}`);
	});

	it("marker-izes image paths in pasted plain text", async () => {
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("text.png");
		clipboardMocks.readClipboardText.mockResolvedValue(`compare ${imagePath} with the mock`);
		const { pasteFromClipboard } = clipboardTarget(editor);

		await pasteFromClipboard();

		assert.equal(editor.getText(), `compare ${imageMarkerText(1)} with the mock`);
		assert.equal(editor.getExpandedText(), `compare ${imagePath} with the mock`);
	});

	it("surfaces clipboard errors via showError", async () => {
		const editor = new Editor(createTestTUI(), theme);
		clipboardMocks.readClipboardFilePaths.mockRejectedValue(new Error("clipboard denied"));
		const { pasteFromClipboard, errors } = clipboardTarget(editor);

		await pasteFromClipboard();

		assert.deepEqual(errors, ["Failed to paste from clipboard: clipboard denied"]);
	});
});

describe("empty bracketed paste (Cmd+V in menu-paste terminals)", () => {
	const darwin = process.platform === "darwin";
	const emptyPaste = "\x1b[200~\x1b[201~";

	it("pastes a clipboard image as a marker when the terminal sends an empty paste", async () => {
		if (!darwin) return;
		const editor = new Editor(createTestTUI(), theme);
		const bytes = new Uint8Array([1, 2, 3, 4]);
		clipboardMocks.readClipboardImage.mockResolvedValue({ mimeType: "image/png", bytes });

		editor.handleInput(emptyPaste);

		await vi.waitFor(() => {
			assert.equal(editor.getText(), imageMarkerText(1));
		});
		const expanded = editor.getExpandedText();
		assert.match(expanded, /^\/.*pi-clipboard-.*\.png$/);
		assert.ok(existsSync(expanded));
	});

	it("pastes copied file paths, marker-izing images only", async () => {
		if (!darwin) return;
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("clip.png");
		const textPath = join(tempDir, "clip.txt");
		writeFileSync(textPath, "text");
		clipboardMocks.readClipboardFilePaths.mockResolvedValue([imagePath, textPath]);

		editor.handleInput(emptyPaste);

		await vi.waitFor(() => {
			assert.equal(editor.getText(), `${imageMarkerText(1)}\n${textPath}`);
		});
		assert.equal(editor.getExpandedText(), `${imagePath}\n${textPath}`);
	});

	it("pastes clipboard text, transforming image paths in it", async () => {
		if (!darwin) return;
		const editor = new Editor(createTestTUI(), theme);
		const imagePath = writeImage("text.png");
		clipboardMocks.readClipboardText.mockResolvedValue(`compare ${imagePath} with the mock`);

		editor.handleInput(emptyPaste);

		await vi.waitFor(() => {
			assert.equal(editor.getText(), `compare ${imageMarkerText(1)} with the mock`);
		});
	});

	it("leaves the editor unchanged when the clipboard is empty", async () => {
		if (!darwin) return;
		const editor = new Editor(createTestTUI(), theme);

		editor.handleInput(emptyPaste);

		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(editor.getText(), "");
	});

	it("a non-empty bracketed paste does not read the clipboard", () => {
		if (!darwin) return;
		const editor = new Editor(createTestTUI(), theme);

		paste(editor, "plain text");

		assert.equal(editor.getText(), "plain text");
		assert.equal(clipboardMocks.readClipboardFilePaths.mock.calls.length, 0);
		assert.equal(clipboardMocks.readClipboardImage.mock.calls.length, 0);
		assert.equal(clipboardMocks.readClipboardText.mock.calls.length, 0);
	});
});

describe("cmd+v binding for clipboard paste", () => {
	const darwin = process.platform === "darwin";

	function createManager(): KeybindingsManager {
		return new KeybindingsManager({
			"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste" },
			"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
		} as never);
	}

	it("matches Cmd+V (super+v) for the paste action", () => {
		if (!darwin) return;
		const manager = createManager();
		assert.ok(manager.matches("\x1b[118;9u", "app.clipboard.pasteImage"));
	});

	it("still matches the default Ctrl+V", () => {
		const manager = createManager();
		assert.ok(manager.matches("\x1b[118;5u", "app.clipboard.pasteImage"));
	});

	it("does not match Cmd+V for other actions", () => {
		if (!darwin) return;
		const manager = createManager();
		assert.ok(!manager.matches("\x1b[118;9u", "app.exit"));
	});

	it("exposes cmd+v in the resolved keys for hints", () => {
		if (!darwin) return;
		const manager = createManager();
		assert.deepEqual(manager.getKeys("app.clipboard.pasteImage"), ["ctrl+v", "super+v"]);
	});
});
