/**
 * Permission modes (Claude Code style): a per-session gate on every tool
 * call, with three settings:
 *
 * - bypass: every tool runs without asking (pi's historic default).
 * - acceptEdits: read-only and edit/write tools run freely; bash,
 *   powershell and custom tools ask the user first via ctx.ui.confirm
 *   (in UI-less modes nothing can ask, so they run — the bypass default).
 * - plan: full plan mode (Claude Code style) — read-only with a writable
 *   session plan file; delegates to the pi-plus-plan gate (safe bash
 *   allowlist, edit/write restricted to the plan file, custom tools blocked
 *   with a reason). Engaged from either side (/permissions, Shift+Tab, the
 *   plan extension's entry points, or a host writing the shared mode holder),
 *   the shared plan gate state is kept in sync with the mode
 *   (syncPlanGateState) so every entry point behaves identically.
 *
 * The mode lives in a host-owned `PermissionModeState` holder so embedding
 * hosts (pi-plus-desktop) can read and switch it natively (dropdown /
 * shortcut) while the extension keeps the live truth for the gate. The
 * `/permissions` command works in both directions: no args opens a picker,
 * `/permissions <mode>` sets it; `onModeChange` lets the host mirror the
 * switch into its own UI.
 *
 * The interactive TUI also surfaces the mode next to the cwd in the footer
 * (bypass / accept-edits / plan, with Claude Code-style icons), rendered by
 * the plus footer wrapper (packages/plus/src/coding-agent/modes/interactive/
 * components/footer.ts) reading {@link sharedPermissionState}, and Shift+Tab
 * cycles forward through PERMISSION_MODES. The cycle is wired as a
 * terminal-input listener rather than an extension shortcut because
 * app.thinking.cycle reserves shift+tab; input listeners run before the
 * editor's action dispatch, so the keystroke reaches us first (this shadows
 * the thinking-cycle default binding, which users can rebind via
 * keybindings.json).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../../../coding-agent/src/core/extensions/types.ts";
import { isToolCallEventType } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { gateToolCall } from "../plan/gate.ts";
import { planFilePathFor } from "../plan/plan-file.ts";
import { sharedPlanGateState } from "../plan/state.ts";

export type PermissionMode = "bypass" | "acceptEdits" | "plan";

/** Canonical order: Shift+Tab cycles forward through this list. */
export const PERMISSION_MODES: PermissionMode[] = ["bypass", "acceptEdits", "plan"];

/** Mutable holder shared between the host and the extension. */
export interface PermissionModeState {
	mode: PermissionMode;
}

export interface PermissionsExtensionOptions {
	/** Host-owned state; a fresh bypass-on holder is created when omitted. */
	state?: PermissionModeState;
	/** Called after every mode change, including host-side writes. */
	onModeChange?: (mode: PermissionMode) => void;
}

/** Picker / notify labels, one per mode (order matches PERMISSION_MODES). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
	bypass: "bypass — every tool runs without asking",
	acceptEdits: "accept edits — file edits run freely; shell and other tools ask first",
	plan: "plan mode — read-only; the model writes an implementation plan for your approval",
};

/** Next mode in the canonical cycle (Shift+Tab), wrapping at the end. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
	return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
}

/**
 * Footer status text for a mode, styled by severity with Claude Code-style
 * icons: the bypass default is dim, accept-edits stands out, and plan matches
 * the plan extension's warning-colored "⏸ plan" indicator.
 */
export function permissionStatusText(mode: PermissionMode, theme: Theme): string {
	switch (mode) {
		case "bypass":
			return theme.fg("dim", "✈️ bypass");
		case "acceptEdits":
			return theme.fg("accent", "✏️ accept-edits");
		case "plan":
			return theme.fg("warning", "⏸ plan");
	}
}

/**
 * Process-wide mode holder, used when the host doesn't pass its own. The
 * footer wrapper reads this to render the cwd-line indicator, so it must be
 * shared rather than per-extension-instance.
 */
export const sharedPermissionState: PermissionModeState = { mode: "bypass" };

/**
 * Holder the plan extension couples to. Embedding hosts (pi-plus-desktop)
 * inject a per-tab state via createPermissionsExtension; plan-mode engage/exit
 * must read/write THAT holder, because the permissions gate re-syncs the
 * shared plan gate state from its own holder's mode on every tool call — if
 * the plan extension coupled to the module default while the gate held a
 * custom "bypass" holder, the first tool call would silently tear plan mode
 * down (ExitPlanMode then fails with "Plan mode is not active"). Registered
 * by the factory, last-write-wins: the CLI runs one interactive session per
 * process, and embedders register with each runtime so the newest wins.
 */
let activePermissionState: PermissionModeState | undefined;
let activeModeChangeNotifier: ((mode: PermissionMode) => void) | undefined;

/** Register the holder (and optional change notifier) plan-mode coupling uses. Factory-time. */
export function setActivePermissionState(
	state: PermissionModeState,
	onModeChange?: (mode: PermissionMode) => void,
): void {
	activePermissionState = state;
	activeModeChangeNotifier = onModeChange;
}

/** Holder plan-mode coupling reads/writes; the module default until a factory registers one. */
export function getActivePermissionState(): PermissionModeState {
	return activePermissionState ?? sharedPermissionState;
}

/** Mirror a plan-side mode switch into the host UI (the registered onModeChange, if any). */
export function notifyActivePermissionModeChange(mode: PermissionMode): void {
	activeModeChangeNotifier?.(mode);
}

// Raw escape sequences that terminals emit for Shift+Tab (see
// packages/tui/src/keys.ts): CSI Z, and the CSI-u style variant.
const SHIFT_TAB_SEQUENCES = new Set(["\x1b[Z", "\x1b[27;2;9~"]);

// Extension-owned tools that manage their own user prompts (plan entry/exit
// confirmations, task-list edits, ask_user) and are safe to keep available
// while accept-edits gates everything else.
const SELF_PROMPTING_TOOLS = new Set([
	"EnterPlanMode",
	"ExitPlanMode",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
	"TaskGet",
	"ask_user",
]);

/** "bypass" | "accept-edits" | "acceptEdits" | "edits" | "plan" | "plan-mode". */
export function parsePermissionMode(arg: string): PermissionMode | undefined {
	const normalized = arg.trim().toLowerCase().replace(/[_-]+/g, "");
	if (normalized === "bypass") return "bypass";
	if (normalized === "accept" || normalized === "acceptedits" || normalized === "edits") return "acceptEdits";
	if (normalized === "plan" || normalized === "planmode") return "plan";
	return undefined;
}

function summarize(event: ToolCallEvent): string {
	let raw = event.toolName;
	if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
		raw = `${event.toolName}: ${String(event.input.command ?? "")}`;
	} else if (event.toolName !== "bash" && event.toolName !== "powershell") {
		try {
			raw = `${event.toolName} ${JSON.stringify(event.input)}`;
		} catch {
			// unserializable input; keep the bare tool name
		}
	}
	return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

/**
 * Keep the shared plan gate state in sync with the permission mode, so mode
 * "plan" always means full plan mode (read-only with a writable plan file),
 * however the mode was switched — /permissions, Shift+Tab, the plan
 * extension's own activate/deactivate, or a host writing the shared holder
 * directly (embedding hosts switch the mode natively). Engaging sets the
 * session plan file path (created lazily); disengaging clears both. Idempotent.
 */
function syncPlanGateState(mode: PermissionMode, ctx: ExtensionContext): void {
	if (mode === "plan") {
		sharedPlanGateState.enabled = true;
		if (!sharedPlanGateState.planFilePath) {
			let sessionId = "default";
			try {
				sessionId = ctx.sessionManager.getSessionId() || "default";
			} catch {
				// no session context; fall back to the default plan file
			}
			sharedPlanGateState.planFilePath = planFilePathFor(sessionId);
		}
		return;
	}
	if (sharedPlanGateState.enabled) {
		sharedPlanGateState.enabled = false;
		sharedPlanGateState.planFilePath = undefined;
	}
}

/**
 * Gate one tool call under `mode`. Returns undefined to let it execute, a
 * block result to deny it, or (accept-edits) awaits ctx.ui.confirm. Exported
 * for tests; the extension wires it to the tool_call event.
 */
export async function gatePermissionToolCall(
	event: ToolCallEvent,
	mode: PermissionMode,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	syncPlanGateState(mode, ctx);
	if (mode === "bypass") return undefined;

	if (mode === "plan") {
		// Plan mode reuses the pi-plus-plan read-only gate wholesale (its reason
		// texts point at the plan file and ExitPlanMode, which the plan extension
		// registers in every SDK/CLI host). The shared gate state was just synced,
		// so the plan-file carve-out always applies — even when the mode was
		// switched from the permissions side (Shift+Tab / /permissions / host UI)
		// without the plan extension's own activation path.
		return gateToolCall(event, sharedPlanGateState, ctx.cwd);
	}

	// acceptEdits: reads and edits run unattended; everything that shells out
	// or is an unknown custom tool asks first.
	if (
		isToolCallEventType("read", event) ||
		isToolCallEventType("grep", event) ||
		isToolCallEventType("find", event) ||
		isToolCallEventType("ls", event) ||
		isToolCallEventType("edit", event) ||
		isToolCallEventType("write", event) ||
		SELF_PROMPTING_TOOLS.has(event.toolName)
	) {
		return undefined;
	}
	// Nothing can ask in print/pipe mode: run it, matching pi's default.
	if (!ctx.hasUI) return undefined;
	const yes = await ctx.ui.confirm(`Allow ${event.toolName}?`, summarize(event));
	if (yes) return undefined;
	return {
		block: true,
		reason:
			`The user denied this ${event.toolName} call (accept-edits permission mode). ` +
			"Ask them what to do instead, or retry once they switch the permission mode.",
	};
}

/** Build the pi-plus-permissions inline extension for a host. */
export function createPermissionsExtension(options: PermissionsExtensionOptions = {}): InlineExtension {
	const state: PermissionModeState = options.state ?? sharedPermissionState;
	setActivePermissionState(state, options.onModeChange);
	// Shift+Tab listener for the current session; replaced on every
	// session_start (session replacement clears extension UI subscriptions,
	// /reload included). Outside the TUI onTerminalInput is a no-op.
	let shiftTabUnsubscribe: (() => void) | undefined;
	return {
		name: "pi-plus-permissions",
		hidden: true,
		factory: (pi: ExtensionAPI) => {
			const setMode = (mode: PermissionMode, ctx: ExtensionContext): void => {
				if (state.mode === mode) {
					ctx.ui.notify(`Permission mode is already ${mode}.`, "info");
					return;
				}
				state.mode = mode;
				options.onModeChange?.(mode);
				ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_LABELS[mode]}`, "info");
			};

			pi.on("tool_call", async (event, ctx) => gatePermissionToolCall(event, state.mode, ctx));

			// The Shift+Tab cycle is TUI-only; onTerminalInput is a no-op
			// elsewhere, so this is safe to run from every host.
			pi.on("session_start", async (_event, ctx) => {
				shiftTabUnsubscribe?.();
				shiftTabUnsubscribe = ctx.ui.onTerminalInput((data) => {
					if (!SHIFT_TAB_SEQUENCES.has(data)) return undefined;
					setMode(nextPermissionMode(state.mode), ctx);
					return { consume: true };
				});
			});

			pi.registerCommand("permissions", {
				description: "Show or switch the permission mode: /permissions [bypass | accept-edits | plan]",
				handler: async (args, ctx) => {
					const arg = args.trim();
					if (arg) {
						const parsed = parsePermissionMode(arg);
						if (!parsed) {
							ctx.ui.notify(`Unknown permission mode "${arg}". Use bypass, accept-edits or plan.`, "warning");
							return;
						}
						setMode(parsed, ctx);
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_LABELS[state.mode]}`, "info");
						return;
					}
					const choice = await ctx.ui.select(
						`Permission mode (current: ${state.mode})`,
						PERMISSION_MODES.map((mode) => PERMISSION_MODE_LABELS[mode]),
					);
					if (choice === undefined) return; // cancelled
					const index = PERMISSION_MODES.map((mode) => PERMISSION_MODE_LABELS[mode]).indexOf(choice);
					if (index >= 0) setMode(PERMISSION_MODES[index], ctx);
				},
			});
		},
	};
}
