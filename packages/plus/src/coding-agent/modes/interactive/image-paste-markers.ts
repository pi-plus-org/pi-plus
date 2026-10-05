/**
 * Image paste markers for the TUI editor.
 *
 * Upstream pi inserts raw image paths into the prompt input: a Ctrl+V clipboard
 * paste becomes a long `/tmp/pi-clipboard-<uuid>.png` temp path, and
 * drag-and-dropped image files arrive as pasted path text. This module makes
 * any pasted/dropped image path display as a compact `[image #N]` marker
 * instead, in the style of Claude Code's `[Image #N]` placeholder.
 *
 * The real path is never lost: a per-editor registry (parallel to the editor's
 * own paste registry) maps marker ids to the verbatim path text, and the
 * `expandPasteMarkers` prototype patch substitutes the path back before submit
 * (`submitValue`) and before external-editor export (`getExpandedText`). The
 * substitution is lossless, so bash-mode (`!`) submits and history entries
 * carry the original path exactly as pasted.
 *
 * Patched at module top level, like the other plus wrappers — every
 * `new Editor(...)` upstream picks this up once the interactive-mode wrapper
 * module (which imports this) is loaded through the redirect.
 */

import { existsSync, statSync } from "node:fs";
import { Editor } from "@earendil-works/pi-tui";

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
