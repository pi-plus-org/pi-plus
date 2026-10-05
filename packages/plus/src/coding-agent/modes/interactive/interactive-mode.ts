/**
 * Wrapper for packages/coding-agent/src/modes/interactive/interactive-mode.ts.
 *
 * Pass-through except:
 *
 * 1. The built-in /login flow is disabled. Both entry points — handleInput's
 *    typed-"/login" interception and the slash-command path — delegate to the
 *    (TS-private, prototype-visible) handleLoginCommand method, so replacing
 *    it on the prototype kills every route into the login UI without touching
 *    upstream. Provider login lives in
 *    `pipi profile add <name> -p <provider>` (packages/plus/src/auth/login.ts),
 *    which logs a profile into a provider and writes the credential to that
 *    profile's agent dir; /logout stays available (it only removes
 *    credentials, which is still meaningful for env- and login-stored
 *    entries).
 *
 * 2. Clipboard image pastes display as `[image #N]` markers instead of the raw
 *    temp path. The prototype replacement below mirrors upstream
 *    handleClipboardPaste (copied file paths, clipboard images, plain text)
 *    except that image file paths and clipboard images are registered as
 *    markers via ./image-paste-markers.ts; the editor expands them back to the
 *    real paths at submit time, so what reaches the session is unchanged.
 *
 * 3. Cmd+V (super+v) is bound to the clipboard paste action on macOS. A
 *    terminal-native Cmd+V paste only delivers clipboard *text* (image data
 *    has no text representation, so the app never sees it), which is why
 *    image pasting needs the app to receive the key event itself — the same
 *    reason Ctrl+V is the upstream default. Terminals that forward Cmd+V
 *    (Kitty keyboard protocol) report it with the super modifier, which pi's
 *    key decoder already understands; only the binding was missing.
 *
 * 4. Terminals that consume Cmd+V as a native menu paste (Paw/xterm.js,
 *    iTerm2, Terminal.app) never deliver the key event but do deliver an
 *    EMPTY bracketed paste. On macOS that empty paste makes the editor read
 *    the clipboard itself (paths, image, text) — Claude Code's mechanism —
 *    via the image-paste-markers module's handleInput patch.
 */
export * from "../../../../../coding-agent/src/modes/interactive/interactive-mode.ts";

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Editor } from "@earendil-works/pi-tui";
import { KeybindingsManager, matchesKey } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../../../../../coding-agent/src/modes/interactive/interactive-mode.ts";
import { readClipboardFilePaths, readClipboardText } from "../../../../../coding-agent/src/utils/clipboard.ts";
import {
	extensionForImageMimeType,
	readClipboardImage,
} from "../../../../../coding-agent/src/utils/clipboard-image.ts";
import { registerImageMarker, transformImagePaths } from "./image-paste-markers.ts";

// Structural view of the private members the patch calls; the original method
// is TS-private, so there is no public type to reference here.
interface StatusDisplaying {
	showStatus(message: string): void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleLoginCommand(this: StatusDisplaying, providerRef?: string): Promise<void>;
};

interactiveModePrototype.handleLoginCommand = async function handleLoginCommand(
	this: StatusDisplaying,
	_providerRef?: string,
): Promise<void> {
	this.showStatus(
		"Provider login moved: use 'pipi profile add <name> -p <provider>' (or 'pipi profile update <name> -t <key>').",
	);
};

// Structural view of what the handleClipboardPaste replacement reads from the
// InteractiveMode instance; all members exist upstream but are TS-private.
interface ClipboardPasting {
	editor: {
		getText(): string;
		getCursor?(): { line: number; col: number };
		insertTextAtCursor?(text: string): void;
	};
	isBashMode: boolean;
	ui: { requestRender(): void };
	showError(message: string): void;
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asEditor(editor: ClipboardPasting["editor"]): Editor {
	return editor as unknown as Editor;
}

/**
 * Clipboard paste (Ctrl+V): copied file paths insert as paths, clipboard
 * images attach via a temp file marker, plain text is the final fallback.
 * Same behavior as upstream except image paths display as `[image #N]`.
 */
async function handleClipboardPaste(this: ClipboardPasting): Promise<void> {
	try {
		const filePaths = await readClipboardFilePaths();
		if (filePaths) {
			if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
				throw new Error("Clipboard file path contains control characters");
			}
			const paths = this.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
			const cursor = this.editor.getCursor?.();
			const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
			const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
			const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
			const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
			const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
			this.editor.insertTextAtCursor?.(
				`${leadingSpace}${transformImagePaths(asEditor(this.editor), paths)}${trailingSpace}`,
			);
			this.ui.requestRender();
			return;
		}

		const image = await readClipboardImage();
		if (image) {
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
			writeFileSync(filePath, Buffer.from(image.bytes));

			this.editor.insertTextAtCursor?.(registerImageMarker(asEditor(this.editor), filePath));
			this.ui.requestRender();
			return;
		}

		const text = await readClipboardText();
		if (text) {
			this.editor.insertTextAtCursor?.(transformImagePaths(asEditor(this.editor), text));
			this.ui.requestRender();
		}
	} catch (error) {
		this.showError(`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`);
	}
}

(
	interactiveModePrototype as unknown as { handleClipboardPaste(this: ClipboardPasting): Promise<void> }
).handleClipboardPaste = handleClipboardPaste;

const PASTE_IMAGE_ACTION = "app.clipboard.pasteImage";
const PASTE_IMAGE_CMD_V = "super+v";

// Structural view of the tui KeybindingsManager members patched below.
interface KeybindingsMatching {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): string[];
}

const keybindingsPrototype = KeybindingsManager.prototype as unknown as KeybindingsMatching;

const originalMatches = keybindingsPrototype.matches;
keybindingsPrototype.matches = function matches(data: string, keybinding: string): boolean {
	if (originalMatches.call(this, data, keybinding)) return true;
	if (process.platform === "darwin" && keybinding === PASTE_IMAGE_ACTION) {
		return matchesKey(data, PASTE_IMAGE_CMD_V);
	}
	return false;
};

const originalGetKeys = keybindingsPrototype.getKeys;
keybindingsPrototype.getKeys = function getKeys(keybinding: string): string[] {
	const keys = originalGetKeys.call(this, keybinding);
	if (process.platform === "darwin" && keybinding === PASTE_IMAGE_ACTION && !keys.includes(PASTE_IMAGE_CMD_V)) {
		keys.push(PASTE_IMAGE_CMD_V);
	}
	return keys;
};
