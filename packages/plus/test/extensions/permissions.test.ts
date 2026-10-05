/**
 * Tests for the permissions extension's TUI surface: the footer indicator
 * (rendered on the cwd line by the plus footer wrapper from
 * sharedPermissionState) and the Shift+Tab cycle wired as a terminal-input
 * listener (extension shortcuts can't bind shift+tab — it is reserved for
 * app.thinking.cycle upstream).
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	TerminalInputHandler,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import {
	createPermissionsExtension,
	nextPermissionMode,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionsExtensionOptions,
	permissionStatusText,
	sharedPermissionState,
} from "../../src/extensions/permissions/index.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Harness {
	state: { mode: PermissionMode };
	notifications: string[];
	modeChanges: PermissionMode[];
	terminalInput: (data: string) => { consume?: boolean; data?: string } | undefined;
	runCommand: (name: string, args: string) => Promise<void>;
	restartSession: () => Promise<void>;
	terminalUnsubscribed: () => boolean;
}

function harness(options: PermissionsExtensionOptions = {}): Harness {
	const notifications: string[] = [];
	const modeChanges: PermissionMode[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => unknown }>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let terminalHandler: TerminalInputHandler | undefined;
	let terminalUnsubscribed = false;

	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			theme,
			onTerminalInput: (handler: TerminalInputHandler) => {
				terminalHandler = handler;
				return () => {
					terminalUnsubscribed = true;
				};
			},
			select: async () => undefined,
			confirm: async () => true,
		},
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;

	// Without an explicit state the extension must use the shared holder —
	// that is what the footer wrapper renders — so reset it per harness.
	sharedPermissionState.mode = "bypass";
	const state = options.state ?? sharedPermissionState;
	const extension = createPermissionsExtension({
		...options,
		state,
		onModeChange: (mode) => modeChanges.push(mode),
	});
	if (typeof extension === "function") throw new Error("expected the named-extension object form");
	extension.factory({
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI);

	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart, "session_start handler must be registered");

	return {
		state,
		notifications,
		modeChanges,
		terminalInput: (data: string) => terminalHandler?.(data),
		runCommand: async (name: string, args: string) => {
			const command = commands.get(name);
			assert.ok(command, `command ${name} must be registered`);
			await command.handler(args, ctx);
		},
		restartSession: async () => {
			await sessionStart({}, ctx);
		},
		terminalUnsubscribed: () => terminalUnsubscribed,
	};
}

beforeAll(() => {
	initTheme("dark");
});

describe("nextPermissionMode", () => {
	it("cycles forward through the canonical order, wrapping at the end", () => {
		assert.equal(nextPermissionMode("bypass"), "acceptEdits");
		assert.equal(nextPermissionMode("acceptEdits"), "plan");
		assert.equal(nextPermissionMode("plan"), "bypass");
		assert.deepEqual(
			PERMISSION_MODES.map((mode) => nextPermissionMode(mode)),
			["acceptEdits", "plan", "bypass"],
		);
	});
});

describe("permissionStatusText", () => {
	it("uses a Claude Code-style icon and short label per mode", () => {
		assert.equal(stripAnsi(permissionStatusText("bypass", theme)), "✈️ bypass");
		assert.equal(stripAnsi(permissionStatusText("acceptEdits", theme)), "✏️ accept-edits");
		assert.equal(stripAnsi(permissionStatusText("plan", theme)), "⏸ plan");
	});

	it("styles the text with theme colors", () => {
		assert.notEqual(permissionStatusText("bypass", theme), stripAnsi(permissionStatusText("bypass", theme)));
	});
});

describe("mode changes", () => {
	it("switches the mode via /permissions and fires onModeChange", async () => {
		const h = harness();
		await h.restartSession();
		await h.runCommand("permissions", "accept-edits");
		assert.equal(h.state.mode, "acceptEdits");
		assert.deepEqual(h.modeChanges, ["acceptEdits"]);
		assert.ok(h.notifications.some((n) => n.includes("accept edits")));
	});

	it("rejects unknown mode arguments", async () => {
		const h = harness();
		await h.restartSession();
		await h.runCommand("permissions", "yolo");
		assert.equal(h.state.mode, "bypass");
		assert.deepEqual(h.modeChanges, []);
		assert.ok(h.notifications.some((n) => n.includes("Unknown permission mode")));
	});

	it("reflects host-provided initial state", async () => {
		const h = harness({ state: { mode: "plan" } });
		await h.restartSession();
		assert.equal(h.state.mode, "plan");
	});

	it("uses the shared holder by default so the footer sees cycle changes", async () => {
		const h = harness();
		await h.restartSession();
		assert.equal(h.state, sharedPermissionState);
		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(sharedPermissionState.mode, "acceptEdits");
	});
});

describe("shift+tab cycle", () => {
	it("consumes both terminal encodings and cycles forward", async () => {
		const h = harness();
		await h.restartSession();

		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(h.state.mode, "acceptEdits");

		assert.deepEqual(h.terminalInput("\x1b[27;2;9~"), { consume: true });
		assert.equal(h.state.mode, "plan");

		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(h.state.mode, "bypass");
		assert.deepEqual(h.modeChanges, ["acceptEdits", "plan", "bypass"]);
	});

	it("passes unrelated input through untouched", async () => {
		const h = harness();
		await h.restartSession();
		assert.equal(h.terminalInput("a"), undefined);
		assert.equal(h.terminalInput("\x1b[A"), undefined); // up arrow
		assert.equal(h.state.mode, "bypass");
		assert.deepEqual(h.notifications, []);
	});

	it("replaces the listener on a new session (old one unsubscribed)", async () => {
		const h = harness();
		await h.restartSession();
		const firstInput = h.terminalInput;
		assert.equal(firstInput("\x1b[Z")?.consume, true);
		assert.equal(h.state.mode, "acceptEdits");
		await h.restartSession();
		assert.ok(h.terminalUnsubscribed(), "previous session's listener must be unsubscribed");
		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(h.state.mode, "plan");
	});
});
