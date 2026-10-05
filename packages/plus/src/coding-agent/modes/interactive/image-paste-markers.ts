/**
 * Image paste markers for the TUI editor.
 *
 * Upstream pi inserts raw image paths into the prompt input: a Ctrl+V clipboard
 * paste becomes a long `/tmp/pi-clipboard-<uuid>.png` temp path, and
 * drag-and-dropped image files arrive as pasted path text. This module makes
 * any pasted/dropped image path display as a compact `[image #N]` marker
 * instead, in the style of Claude Code's `[Image #N]` placeholder.
 *
 * Three prototype patches on the tui Editor, installed at module top level so
 * every `new Editor(...)` upstream picks them up once this module loads:
 *
 * 1. `handlePaste` rewrites image paths in bracketed paste text (drag-and-drop,
 *    right-click paste, large pastes) to markers before the editor stores it.
 * 2. `expandPasteMarkers` substitutes the real paths back at submit time
 *    (`submitValue`) and for external-editor export (`getExpandedText`), so
 *    bash-mode (`!`) submits and history entries stay lossless.
 * 3. `handleInput` treats an EMPTY bracketed paste (`\x1b[200~\x1b[201~`) on
 *    macOS as a paste request and reads the clipboard itself — file paths,
 *    image, then text. This mirrors Claude Code: terminals like Paw/xterm.js
 *    consume Cmd+V as a native menu paste (the key event never reaches the
 *    pty) but still deliver the empty bracketed-paste sequence, which is the
 *    only signal that an image paste happened.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "@earendil-works/pi-tui";
import { readClipboardFilePaths, readClipboardText } from "../../../../../coding-agent/src/utils/clipboard.ts";
import {
	extensionForImageMimeType,
	readClipboardImage,
} from "../../../../../coding-agent/src/utils/clipboard-image.ts";

/** Marker text shown in the input for a pasted/dropped image. */
export function imageMarkerText(id: number): string {
	return `[image #${id}]`;
}

interface ImagePasteState {
	counter: number;
	paths: Map<number, string>;
}

const imagePasteStates = new WeakMap<Editor, ImagePasteState>();

/** Register an image path and return its `[image #N]` marker text. */
export function registerImageMarker(editor: Editor, path: string): string {
	let state = imagePasteStates.get(editor);
	if (!state) {
		state = { counter: 0, paths: new Map() };
		imagePasteStates.set(editor, state);
	}
	state.counter += 1;
	state.paths.set(state.counter, path);
	return imageMarkerText(state.counter);
}

/** Image file extensions recognized as pasteable images (matches the read tool). */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|avif)/i;

/**
 * Token scanner for image paths in pasted text. Extends leftward over
 * non-whitespace (including backslash-escaped spaces, the way macOS terminals
 * escape dropped paths) up to an image extension. A trailing boundary keeps
 * punctuation such as `)` or backticks out of the match.
 */
const IMAGE_PATH_TOKEN = /(?:\\ |[^\s])*?\.(?:png|jpe?g|gif|webp|bmp|avif)(?=$|[\s'"`),;\]}])/gi;

/** Leading/trailing punctuation that may wrap a path in prose or shell text. */
const LEADING_PUNCT = /^['"`([{<]+/;
const TRAILING_PUNCT = /['"`)\]}>,.;]+$/;

/**
 * Unescape a shell-style path for the filesystem check only (`My\ Photo.png`
 * -> `My Photo.png`). The marker expansion always restores the verbatim
 * original token, so this never changes what gets submitted.
 */
function unescapePath(path: string): string {
	return path.replace(/\\(.)/g, "$1");
}

/**
 * Replace image file paths in pasted text with `[image #N]` markers.
 * A token qualifies only if it looks like a path (contains a separator or
 * starts with `~`) and resolves to an existing file — anything else passes
 * through untouched.
 */
export function transformImagePaths(editor: Editor, text: string): string {
	if (!IMAGE_EXTENSION.test(text)) return text;
	IMAGE_PATH_TOKEN.lastIndex = 0;

	let result = "";
	let cursor = 0;
	let matched = false;
	for (let match = IMAGE_PATH_TOKEN.exec(text); match !== null; match = IMAGE_PATH_TOKEN.exec(text)) {
		const token = match[0];
		const core = token.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");
		let replacement: string | null = null;
		if (core.length > 0 && (core.includes("/") || core.includes("\\") || core.startsWith("~"))) {
			try {
				const fsPath = unescapePath(core);
				if (existsSync(fsPath) && statSync(fsPath).isFile()) {
					replacement = registerImageMarker(editor, core);
				}
			} catch {
				// Unreadable path — leave the token as-is.
			}
		}
		if (replacement === null) continue;

		const coreStart = match.index + token.indexOf(core);
		result += text.slice(cursor, coreStart) + replacement;
		cursor = coreStart + core.length;
		matched = true;
	}
	if (!matched) return text;
	return result + text.slice(cursor);
}

// Structural view of the private members patched here; the originals are
// TS-private, so there is no public type to reference (same precedent as the
// interactive-mode wrapper's prototype patches).
interface EditorPrototype {
	handlePaste(this: Editor, pastedText: string): void;
	expandPasteMarkers(this: Editor, text: string): string;
	handleInput(this: Editor, data: string): void;
}

const editorPrototype = Editor.prototype as unknown as EditorPrototype;

// Bracketed paste (drag-and-drop path text, right-click paste, large pastes):
// rewrite image paths before the editor stores the paste.
const originalHandlePaste = editorPrototype.handlePaste;
editorPrototype.handlePaste = function handlePaste(this: Editor, pastedText: string): void {
	originalHandlePaste.call(this, transformImagePaths(this, pastedText));
};

// Submit and external-editor export expand markers back to the real paths.
const originalExpandPasteMarkers = editorPrototype.expandPasteMarkers;
editorPrototype.expandPasteMarkers = function expandPasteMarkers(this: Editor, text: string): string {
	let result = originalExpandPasteMarkers.call(this, text);
	const state = imagePasteStates.get(this);
	if (state) {
		for (const [id, path] of state.paths) {
			result = result.replaceAll(imageMarkerText(id), path);
		}
	}
	return result;
};

/** Structural view of the Editor members the clipboard paste helper touches. */
interface EditorInserting {
	insertTextAtCursor(text: string): void;
	tui: { requestRender(): void };
}

/**
 * Read the macOS clipboard into the editor: copied file paths first, then a
 * clipboard image (saved to a temp file and registered as a marker), then
 * plain text. Mirrors upstream handleClipboardPaste's cascade; used when the
 * terminal signals a paste that carried no text (Cmd+V consumed as a native
 * menu paste in xterm.js-style terminals).
 */
async function pasteClipboardIntoEditor(editor: Editor): Promise<void> {
	try {
		const target = editor as unknown as EditorInserting;

		const filePaths = await readClipboardFilePaths();
		if (filePaths) {
			target.insertTextAtCursor(transformImagePaths(editor, filePaths.join("\n")));
			target.tui.requestRender();
			return;
		}

		const image = await readClipboardImage();
		if (image) {
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
			writeFileSync(filePath, Buffer.from(image.bytes));
			target.insertTextAtCursor(registerImageMarker(editor, filePath));
			target.tui.requestRender();
			return;
		}

		const text = await readClipboardText();
		if (text) {
			target.insertTextAtCursor(transformImagePaths(editor, text));
			target.tui.requestRender();
		}
	} catch {
		// Nothing arrived in the editor and there is no status surface here —
		// stay silent, matching the terminal's own empty-paste behavior.
	}
}

// Empty bracketed paste: terminals that consume Cmd+V as a native menu paste
// (Paw/xterm.js, iTerm2, Terminal.app) deliver only the empty sequence.
// pi's stdin buffer reassembles pastes, so this arrives as one exact string
// (terminal.ts re-wraps paste content before it reaches the editor).
const EMPTY_BRACKETED_PASTE = "\x1b[200~\x1b[201~";
const originalHandleInput = editorPrototype.handleInput;
editorPrototype.handleInput = function handleInput(this: Editor, data: string): void {
	if (process.platform === "darwin" && data === EMPTY_BRACKETED_PASTE) {
		void pasteClipboardIntoEditor(this);
		return;
	}
	originalHandleInput.call(this, data);
};
