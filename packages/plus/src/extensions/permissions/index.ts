/**
 * Permission modes (Claude Code style): a per-session gate on every tool
 * call, with three settings:
 *
 * - bypass: every tool runs without asking (pi's historic default).
 * - acceptEdits: read-only and edit/write tools run freely; bash,
 *   powershell and custom tools ask the user first via ctx.ui.confirm
 *   (in UI-less modes nothing can ask, so they run — the bypass default).
 * - plan: fully read-only — delegates to the pi-plus-plan gate (safe bash
 *   allowlist, edit/write and custom tools blocked with a reason).
 *
 * The mode lives in a host-owned `PermissionModeState` holder so embedding
 * hosts (pi-plus-desktop) can read and switch it natively (dropdown /
 * shortcut) while the extension keeps the live truth for the gate. The
 * `/permissions` command works in both directions: no args opens a picker,
 * `/permissions <mode>` sets it; `onModeChange` lets the host mirror the
 * switch into its own UI.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../../../coding-agent/src/core/extensions/types.ts";
import { isToolCallEventType } from "../../../../coding-agent/src/core/extensions/types.ts";
import { gateToolCall } from "../plan/gate.ts";

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
	plan: "plan mode — read-only research; changes are blocked",
};

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
 * Gate one tool call under `mode`. Returns undefined to let it execute, a
 * block result to deny it, or (accept-edits) awaits ctx.ui.confirm. Exported
 * for tests; the extension wires it to the tool_call event.
 */
export async function gatePermissionToolCall(
	event: ToolCallEvent,
	mode: PermissionMode,
	ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
	if (mode === "bypass") return undefined;

	// Plan mode reuses the pi-plus-plan read-only gate wholesale (its reason
	// texts point at the plan file and ExitPlanMode, which the plan extension
	// registers in every SDK/CLI host).
	if (mode === "plan") {
		return gateToolCall(event, { enabled: true, planFilePath: undefined }, ctx.cwd);
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
	const state: PermissionModeState = options.state ?? { mode: "bypass" };
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
