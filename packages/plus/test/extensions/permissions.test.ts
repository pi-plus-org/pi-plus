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
	autoModeWriteDenial,
	type ClassifierAction,
	type ClassifierDecision,
	createPermissionsExtension,
	DenialTracker,
	gatePermissionToolCall,
	nextPermissionMode,
	PERMISSION_MODE_ENTRY_TYPE,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionModeState,
	type PermissionsExtensionOptions,
	permissionStatusText,
	sharedPermissionState,
	toolInputPaths,
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
		assert.equal(nextPermissionMode("acceptEdits"), "auto");
		assert.equal(nextPermissionMode("auto"), "plan");
		assert.equal(nextPermissionMode("plan"), "bypass");
		assert.deepEqual(
			PERMISSION_MODES.map((mode) => nextPermissionMode(mode)),
			["acceptEdits", "auto", "plan", "bypass"],
		);
	});
});

describe("permissionStatusText", () => {
	it("uses a Claude Code-style icon and short label per mode", () => {
		assert.equal(stripAnsi(permissionStatusText("bypass", theme)), "✈️ bypass");
		assert.equal(stripAnsi(permissionStatusText("acceptEdits", theme)), "✏️ accept-edits");
		assert.equal(stripAnsi(permissionStatusText("auto", theme)), "🤖 auto");
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
		assert.equal(h.state.mode, "auto");

		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(h.state.mode, "plan");

		assert.deepEqual(h.terminalInput("\x1b[Z"), { consume: true });
		assert.equal(h.state.mode, "bypass");
		assert.deepEqual(h.modeChanges, ["acceptEdits", "auto", "plan", "bypass"]);
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
		assert.equal(h.state.mode, "auto");
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
			["acceptEdits", "auto"],
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

/**
 * Auto mode: the classifier replaces the prompt. These tests inject a fake
 * classifier (via `deps.classifier`) so the gate's ordering, the deny-list
 * that runs before any model call, and the block/override semantics are all
 * checked without a provider.
 */
describe("auto permission mode gate", () => {
	interface FakeUi {
		confirm: boolean;
		asks: number;
		notifications: string[];
	}

	function autoCtx(ui?: FakeUi): ExtensionContext {
		return {
			cwd: "/tmp",
			hasUI: !!ui,
			ui: ui
				? {
						confirm: async () => {
							ui.asks += 1;
							return ui.confirm;
						},
						notify: (message: string) => ui.notifications.push(message),
					}
				: undefined,
			sessionManager: { getSessionId: () => "session-1" },
			model: { id: "test-model", provider: "test" },
			modelRegistry: {},
			signal: undefined,
		} as unknown as ExtensionContext;
	}

	function call(toolName: string, input: Record<string, unknown>, id = "call-1"): ToolCallEvent {
		return { type: "tool_call", toolCallId: id, toolName, input } as ToolCallEvent;
	}

	async function gate(
		event: ToolCallEvent,
		decision: ClassifierDecision,
		ctx: ExtensionContext = autoCtx(),
		state: PermissionModeState = { mode: "auto" },
	) {
		const seen: ClassifierAction[] = [];
		const result = await gatePermissionToolCall(event, "auto", ctx, {
			state,
			classifier: async (action) => {
				seen.push(action);
				return decision;
			},
		});
		return { result, seen, state };
	}

	it("runs reads without asking the classifier", async () => {
		const { result, seen } = await gate(call("read", { path: "/tmp/x.ts" }), { status: "block", reason: "no" });
		assert.equal(result, undefined);
		assert.equal(seen.length, 0);
	});

	it("runs in-project edits without asking the classifier", async () => {
		const { result, seen } = await gate(call("write", { path: "/tmp/out.md", content: "x" }), {
			status: "block",
			reason: "no",
		});
		assert.equal(result, undefined);
		assert.equal(seen.length, 0);
	});

	it("denies protected paths before the classifier, even when it would allow", async () => {
		for (const path of ["/tmp/.pi/settings.json", "/tmp/.git/config", "/tmp/AGENTS.md", "/tmp/.zshrc"]) {
			const { result, seen } = await gate(call("write", { path, content: "x" }), { status: "allow" });
			assert.ok(result?.block, `${path} must stay denied in auto mode`);
			assert.equal(seen.length, 0, `${path} must never reach the classifier`);
		}
	});

	it("lets a root-lookalike nested file through to the fast path", async () => {
		const { result } = await gate(call("write", { path: "/tmp/vendor/pkg/AGENTS.md", content: "x" }), {
			status: "allow",
		});
		assert.equal(result, undefined);
	});

	it("sends everything else to the classifier and follows its allow", async () => {
		const { result, seen } = await gate(call("bash", { command: "npm run build" }), { status: "allow" });
		assert.equal(result, undefined);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.toolName, "bash");
		assert.ok(seen[0]?.description.includes("npm run build"));
	});

	it("blocks on a classifier block with no UI to override", async () => {
		const { result } = await gate(call("bash", { command: "rm -rf out" }), {
			status: "block",
			reason: "destroys build output",
		});
		assert.ok(result?.block);
		assert.ok(result?.reason?.includes("destroys build output"));
	});

	it("offers the user an override when a UI is present", async () => {
		const ui: FakeUi = { confirm: true, asks: 0, notifications: [] };
		const { result } = await gate(
			call("bash", { command: "docker ps" }),
			{ status: "block", reason: "hmm" },
			autoCtx(ui),
		);
		assert.equal(ui.asks, 1);
		assert.equal(result, undefined, "an override lets the call run");

		const refused: FakeUi = { confirm: false, asks: 0, notifications: [] };
		const denied = await gate(
			call("bash", { command: "docker ps" }),
			{ status: "block", reason: "hmm" },
			autoCtx(refused),
		);
		assert.equal(refused.asks, 1);
		assert.ok(denied.result?.block);
	});

	it("treats a missing verdict as no verdict: asks when possible, denies when not", async () => {
		const { result } = await gate(call("bash", { command: "ls" }), { status: "unavailable", reason: "timeout" });
		assert.ok(result?.block, "with no user to ask, auto mode fails closed");

		const ui: FakeUi = { confirm: true, asks: 0, notifications: [] };
		const asked = await gate(call("bash", { command: "ls" }), { status: "unavailable" }, autoCtx(ui));
		assert.equal(ui.asks, 1);
		assert.equal(asked.result, undefined);
	});

	it("keeps the extension's own prompting tools out of the classifier", async () => {
		const { result, seen } = await gate(call("ExitPlanMode", {}), { status: "block", reason: "no" });
		assert.equal(result, undefined);
		assert.equal(seen.length, 0);
	});

	it("judges out-of-project writes instead of fast-pathing them", async () => {
		const { result, seen } = await gate(call("write", { path: "/etc/hosts", content: "x" }), {
			status: "block",
			reason: "outside the project",
		});
		assert.equal(seen.length, 1);
		assert.ok(result?.block);
	});

	it("warns once after a streak of blocks, and resets on an allow", async () => {
		const ui: FakeUi = { confirm: false, asks: 0, notifications: [] };
		const state: PermissionModeState = { mode: "auto" };
		for (let i = 0; i < 4; i++) {
			await gate(call("bash", { command: `echo ${i}` }), { status: "block", reason: "risky" }, autoCtx(ui), state);
		}
		assert.deepEqual(
			ui.notifications.filter((n) => n.includes("blocked")),
			[ui.notifications.find((n) => n.includes("blocked"))],
			"the streak warning fires exactly once",
		);
		await gate(call("bash", { command: "echo ok" }), { status: "allow" }, autoCtx(ui), state);
		assert.equal(state.denials?.recordBlock(), 1, "an allow resets the streak");
	});
});

describe("auto-mode policy helpers", () => {
	it("DenialTracker notifies once per streak and re-arms on an allow", () => {
		const tracker = new DenialTracker(2);
		tracker.recordBlock();
		assert.equal(tracker.shouldNotify(), false);
		tracker.recordBlock();
		assert.equal(tracker.shouldNotify(), true);
		assert.equal(tracker.shouldNotify(), false);
		tracker.recordAllow();
		tracker.recordBlock();
		tracker.recordBlock();
		assert.equal(tracker.shouldNotify(), true);
	});

	it("autoModeWriteDenial covers config-bearing paths only", () => {
		assert.ok(autoModeWriteDenial("/repo/.git/hooks/pre-commit", "/repo"));
		assert.ok(autoModeWriteDenial("/repo/settings.json", "/repo"));
		assert.ok(autoModeWriteDenial("/home/u/.zshrc", "/repo"));
		assert.equal(autoModeWriteDenial("/repo/src/app.ts", "/repo"), undefined);
		assert.equal(autoModeWriteDenial("/repo/docs/AGENTS.md", "/repo"), undefined, "only root AGENTS.md");
	});

	it("toolInputPaths ignores shells and picks up tool path keys", () => {
		assert.deepEqual(toolInputPaths("bash", { command: "rm -rf /tmp/x" }, "/repo"), []);
		assert.deepEqual(toolInputPaths("edit", { path: "a.ts", edits: [] }, "/repo"), ["/repo/a.ts"]);
		assert.deepEqual(toolInputPaths("write", { file_path: "/tmp/b.md" }, "/repo"), ["/tmp/b.md"]);
	});
});
