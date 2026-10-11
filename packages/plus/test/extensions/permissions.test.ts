/**
 * Tests for the permissions extension's TUI surface: the footer indicator
 * (rendered on the cwd line by the plus footer wrapper from
 * sharedPermissionState) and the Shift+Tab cycle wired as a terminal-input
 * listener (extension shortcuts can't bind shift+tab — it is reserved for
 * app.thinking.cycle upstream), plus session-file persistence: mode changes
 * append `pi-plus-permissions` custom entries and a resumed legacy session
 * (session_start "startup" with pre-existing entries, or "resume") restores
 * the latest one.
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	TerminalInputHandler,
	ToolCallEvent,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import {
	createPermissionsExtension,
	gatePermissionToolCall,
	nextPermissionMode,
	PERMISSION_MODE_ENTRY_TYPE,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionsExtensionOptions,
	permissionStatusText,
	sharedPermissionState,
} from "../../src/extensions/permissions/index.ts";
import { sharedPlanGateState } from "../../src/extensions/plan/state.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const baseCtx = {
	cwd: "/tmp",
	hasUI: false,
	sessionManager: { getSessionId: () => "session-1" },
} as unknown as ExtensionContext;

interface AppendedEntry {
	customType: string;
	data: unknown;
}

interface HarnessExtras {
	/** Entries the fake sessionManager.getEntries() returns (resume scan input). */
	entries?: unknown[];
	/** Value pi.getFlag("plan") returns. */
	planFlag?: boolean;
}

interface Harness {
	state: { mode: PermissionMode };
	notifications: string[];
	modeChanges: PermissionMode[];
	appended: AppendedEntry[];
	terminalInput: (data: string) => { consume?: boolean; data?: string } | undefined;
	runCommand: (name: string, args: string) => Promise<void>;
	restartSession: (reason?: string) => Promise<void>;
	terminalUnsubscribed: () => boolean;
}

function harness(options: PermissionsExtensionOptions = {}, extras: HarnessExtras = {}): Harness {
	const notifications: string[] = [];
	const modeChanges: PermissionMode[] = [];
	const appended: AppendedEntry[] = [];
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
		sessionManager: { getSessionId: () => "session-1", getEntries: () => extras.entries ?? [] },
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
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
		getFlag: (name: string) => (name === "plan" && extras.planFlag === true ? true : undefined),
	} as unknown as ExtensionAPI);

	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart, "session_start handler must be registered");

	return {
		state,
		notifications,
		modeChanges,
		appended,
		terminalInput: (data: string) => terminalHandler?.(data),
		runCommand: async (name: string, args: string) => {
			const command = commands.get(name);
			assert.ok(command, `command ${name} must be registered`);
			await command.handler(args, ctx);
		},
		restartSession: async (reason?: string) => {
			await sessionStart(reason === undefined ? {} : { reason }, ctx);
		},
		terminalUnsubscribed: () => terminalUnsubscribed,
	};
}

/** Build a persisted `pi-plus-permissions` custom entry as stored in the session file. */
function modeEntry(mode: PermissionMode): unknown {
	return { type: "custom", customType: PERMISSION_MODE_ENTRY_TYPE, data: { mode } };
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

describe("plan permission mode gate", () => {
	it("shares the plan extension's gate state so the plan file stays writable", async () => {
		// Regression: the permission "plan" gate used to run with no plan-file
		// path, so with plan mode active both gates fired and this one blocked
		// writes to the plan file itself.
		sharedPlanGateState.enabled = true;
		sharedPlanGateState.planFilePath = "/tmp/plans/session-1.md";
		try {
			const write = {
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "write",
				input: { path: "/tmp/plans/session-1.md", content: "x" },
			} as ToolCallEvent;
			assert.equal(await gatePermissionToolCall(write, "plan", baseCtx), undefined);
			const other = {
				type: "tool_call",
				toolCallId: "call-2",
				toolName: "write",
				input: { path: "/tmp/other.md", content: "x" },
			} as ToolCallEvent;
			const blocked = await gatePermissionToolCall(other, "plan", baseCtx);
			assert.ok(blocked?.block, "non-plan-file writes stay blocked");
		} finally {
			sharedPlanGateState.enabled = false;
			sharedPlanGateState.planFilePath = undefined;
		}
	});

	it("engages full plan mode on the permissions side: the gate syncs with the mode, so the session plan file is writable", async () => {
		// Regression: cycling to "plan" via Shift+Tab or /permissions used to
		// engage a carve-out-less gate with no plan file, so the model could
		// not write the plan file at all and every block reason lacked the
		// plan-file path.
		sharedPlanGateState.enabled = false;
		sharedPlanGateState.planFilePath = undefined;
		try {
			const probe = {
				type: "tool_call",
				toolCallId: "call-3",
				toolName: "bash",
				input: { command: "ls" },
			} as ToolCallEvent;
			assert.equal(await gatePermissionToolCall(probe, "plan", baseCtx), undefined);
			assert.equal(sharedPlanGateState.enabled, true);
			assert.ok(sharedPlanGateState.planFilePath, "plan mode must set a plan file path");

			const write = {
				type: "tool_call",
				toolCallId: "call-4",
				toolName: "write",
				input: { path: sharedPlanGateState.planFilePath, content: "x" },
			} as ToolCallEvent;
			assert.equal(await gatePermissionToolCall(write, "plan", baseCtx), undefined);
		} finally {
			sharedPlanGateState.enabled = false;
			sharedPlanGateState.planFilePath = undefined;
		}
	});

	it("disengages the plan gate when the mode leaves plan", async () => {
		sharedPlanGateState.enabled = true;
		sharedPlanGateState.planFilePath = "/tmp/plans/session-1.md";
		const probe = {
			type: "tool_call",
			toolCallId: "call-5",
			toolName: "bash",
			input: { command: "rm -rf /" },
		} as ToolCallEvent;
		assert.equal(await gatePermissionToolCall(probe, "bypass", baseCtx), undefined);
		assert.equal(sharedPlanGateState.enabled, false);
		assert.equal(sharedPlanGateState.planFilePath, undefined);
	});
});

describe("session-file persistence", () => {
	it("appends a pi-plus-permissions entry for /permissions and Shift+Tab changes", async () => {
		const h = harness();
		await h.restartSession();
		await h.runCommand("permissions", "accept-edits");
		h.terminalInput("\x1b[Z");
		assert.deepEqual(
			h.appended.map((entry) => entry.customType),
			[PERMISSION_MODE_ENTRY_TYPE, PERMISSION_MODE_ENTRY_TYPE],
		);
		assert.deepEqual(
			h.appended.map((entry) => (entry.data as { mode: PermissionMode }).mode),
			["acceptEdits", "plan"],
		);
	});

	it("does not append an entry when the mode is already set", async () => {
		const h = harness();
		await h.restartSession();
		await h.runCommand("permissions", "bypass");
		assert.deepEqual(h.appended, []);
		assert.ok(h.notifications.some((n) => n.includes("already bypass")));
	});

	it("restores the latest persisted mode on resume", async () => {
		const h = harness({}, { entries: [modeEntry("bypass"), modeEntry("acceptEdits")] });
		await h.restartSession("resume");
		assert.equal(h.state.mode, "acceptEdits");
		assert.deepEqual(h.modeChanges, ["acceptEdits"]);
		assert.ok(h.notifications.some((n) => n.includes("Permission mode restored")));
	});

	it("restores the persisted mode at startup (pipi -r launch)", async () => {
		const h = harness({}, { entries: [modeEntry("acceptEdits")] });
		await h.restartSession("startup");
		assert.equal(h.state.mode, "acceptEdits");
	});

	it("restoring plan mode re-engages the shared plan gate with a plan file path", async () => {
		sharedPlanGateState.enabled = false;
		sharedPlanGateState.planFilePath = undefined;
		try {
			const h = harness({}, { entries: [modeEntry("plan")] });
			await h.restartSession("resume");
			assert.equal(h.state.mode, "plan");
			assert.equal(sharedPlanGateState.enabled, true);
			assert.ok(sharedPlanGateState.planFilePath, "restored plan mode must set a plan file path");
		} finally {
			sharedPlanGateState.enabled = false;
			sharedPlanGateState.planFilePath = undefined;
		}
	});

	it("ignores malformed persisted entries", async () => {
		const h = harness(
			{},
			{ entries: [{ type: "custom", customType: PERMISSION_MODE_ENTRY_TYPE, data: { mode: 42 } }] },
		);
		await h.restartSession("resume");
		assert.equal(h.state.mode, "bypass");
	});

	it("does not restore on new or fork (fresh sessions start at the default)", async () => {
		for (const reason of ["new", "fork"]) {
			const h = harness({}, { entries: [modeEntry("acceptEdits")] });
			await h.restartSession(reason);
			assert.equal(h.state.mode, "bypass", `reason ${reason} must not restore`);
			assert.deepEqual(h.modeChanges, []);
		}
	});

	it("a plain startup with no entries is a no-op", async () => {
		const h = harness();
		await h.restartSession("startup");
		assert.equal(h.state.mode, "bypass");
	});

	it("an explicit --plan launch wins over the persisted mode at startup", async () => {
		const h = harness({}, { entries: [modeEntry("acceptEdits")], planFlag: true });
		await h.restartSession("startup");
		assert.equal(h.state.mode, "bypass");
	});
});
