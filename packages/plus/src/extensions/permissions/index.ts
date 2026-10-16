/**
 * Permission modes (Claude Code style): a per-session gate on every tool
 * call, with three settings:
 *
 * - bypass: every tool runs without asking (pi's historic default).
 * - acceptEdits: read-only and edit/write tools run freely; bash,
 *   powershell and custom tools ask the user first via ctx.ui.confirm
 *   (in UI-less modes nothing can ask, so they run — the bypass default).
 * - auto: the human is replaced by a model. Reads and in-project edits run
 *   unattended (the accept-edits fast path), everything else is judged by an
 *   action classifier that sees the recent conversation plus the pending call
 *   (./classifier.ts); a block is then offered to the user for override. The
 *   path deny-list in ./auto-mode.ts is applied before the classifier and is
 *   never classifier-approvable.
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
 * cycles forward through PERMISSION_MODES (bypass → accept-edits → auto →
 * plan). The cycle is wired as a
 * terminal-input listener rather than an extension shortcut because
 * app.thinking.cycle reserves shift+tab; input listeners run before the
 * editor's action dispatch, so the keystroke reaches us first (this shadows
 * the thinking-cycle default binding, which users can rebind via
 * keybindings.json).
 *
 * The mode is also persisted into the session file as `pi-plus-permissions`
 * custom entries (one per change, latest wins), so resuming a legacy session
 * — `pipi -r` at launch (session_start "startup" with pre-existing entries)
 * or an in-TUI session switch ("resume") — restores the mode it was left in
 * instead of silently resetting to bypass. SDK/desktop hosts keep per-tab
 * mode state in their own UI and don't register this extension.
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
import { autoModeWriteDenial, DenialTracker, isWithin, toolInputPaths } from "./auto-mode.ts";
import { formatAutoModeRules, readAutoModeRules } from "./auto-rules.ts";
import { type ActionClassifier, type ClassifierDecision, createModelClassifier } from "./classifier.ts";

export type PermissionMode = "bypass" | "acceptEdits" | "auto" | "plan";

export { autoModeWriteDenial, DenialTracker, toolInputPaths } from "./auto-mode.ts";
export { type AutoModeRules, formatAutoModeRules, readAutoModeRules } from "./auto-rules.ts";
export type { ActionClassifier, ClassifierAction, ClassifierDecision } from "./classifier.ts";
export {
	buildClassifierSystemPrompt,
	buildClassifierUserPrompt,
	buildTranscript,
	classifyAction,
	createModelClassifier,
	parseClassifierResponse,
} from "./classifier.ts";

/** Canonical order: Shift+Tab cycles forward through this list. */
export const PERMISSION_MODES: PermissionMode[] = ["bypass", "acceptEdits", "auto", "plan"];

/** Mutable holder shared between the host and the extension. */
export interface PermissionModeState {
	mode: PermissionMode;
	/**
	 * Auto-mode consecutive-deny tracking (Claude Code's denial tracking): a
	 * classifier that blocks call after call is a sign the session and the
	 * mode disagree, so the user is told once per streak. Created lazily.
	 */
	denials?: DenialTracker;
}

export interface PermissionsExtensionOptions {
	/** Host-owned state; a fresh bypass-on holder is created when omitted. */
	state?: PermissionModeState;
	/** Called after every mode change, including host-side writes. */
	onModeChange?: (mode: PermissionMode) => void;
	/**
	 * Override the auto-mode action classifier (tests, or a host that wants a
	 * different model or transport than the session default).
	 */
	classifier?: ActionClassifier;
}

/** Picker / notify labels, one per mode (order matches PERMISSION_MODES). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
	bypass: "bypass — every tool runs without asking",
	acceptEdits: "accept edits — file edits run freely; shell and other tools ask first",
	auto: "auto — a model judges shell and other tools instead of asking; unsafe calls are blocked, doubtful ones offered to you",
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
		case "auto":
			return theme.fg("accent", "🤖 auto");
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
/** Recorder the factory registers to persist mode changes into the session file. */
let activeModeRecorder: ((mode: PermissionMode) => void) | undefined;

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

/**
 * Write the active permission mode from any plus component (plan engage/exit,
 * approve-and-run choices): updates the holder when the mode actually
 * changes, mirrors the switch into the host UI, and records it for
 * persistence into the session file. Plan-mode session-lifecycle resets
 * (new/resume/fork) intentionally do NOT go through here — they are not user
 * mode choices and must not append entries that would clobber a resume
 * restore.
 */
export function setActivePermissionMode(mode: PermissionMode): void {
	const holder = getActivePermissionState();
	if (holder.mode === mode) return;
	holder.mode = mode;
	notifyActivePermissionModeChange(mode);
	activeModeRecorder?.(mode);
}

/** Custom entry recording one permission-mode change; the latest entry wins on resume. */
export const PERMISSION_MODE_ENTRY_TYPE = "pi-plus-permissions";

interface PermissionModeEntryData {
	mode?: unknown;
}

/**
 * Latest mode recorded in the session's `pi-plus-permissions` custom entries,
 * or undefined when the session has none (never switched, or pre-dates the
 * feature — those keep the bypass default).
 */
function readPersistedPermissionMode(ctx: ExtensionContext): PermissionMode | undefined {
	let persisted: PermissionMode | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== PERMISSION_MODE_ENTRY_TYPE) continue;
		const mode = parsePermissionMode(String((entry.data as PermissionModeEntryData | undefined)?.mode ?? ""));
		if (mode) persisted = mode;
	}
	return persisted;
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
	if (normalized === "auto" || normalized === "automode") return "auto";
	if (normalized === "accept" || normalized === "acceptedits" || normalized === "edits") return "acceptEdits";
	if (normalized === "plan" || normalized === "planmode") return "plan";
	return undefined;
}

/** Tool input rendered for the classifier's `<action>` block. */
function classifierActionInput(event: ToolCallEvent): string {
	try {
		return JSON.stringify(event.input);
	} catch {
		return "";
	}
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

/** Extra wiring for the gate: the auto-mode classifier and mode holder. */
export interface PermissionGateDeps {
	/**
	 * Action classifier used by auto mode. Defaults to a model classifier over
	 * the session model and the user's autoMode rules (cached per cwd).
	 */
	classifier?: ActionClassifier;
	/** Mode holder owning the deny tracking; created lazily when omitted. */
	state?: PermissionModeState;
}

/** Default classifier, cached per cwd so settings are read once per directory. */
const defaultClassifiers = new Map<string, ActionClassifier>();

function defaultClassifier(cwd: string): ActionClassifier {
	const cached = defaultClassifiers.get(cwd);
	if (cached) return cached;
	const rules = formatAutoModeRules(readAutoModeRules(cwd));
	const classifier = createModelClassifier({ policyAddendum: rules });
	defaultClassifiers.set(cwd, classifier);
	return classifier;
}

/** Tools whose whole job is reading; never judged in auto mode. */
function isReadOnlyTool(event: ToolCallEvent): boolean {
	return (
		isToolCallEventType("read", event) ||
		isToolCallEventType("grep", event) ||
		isToolCallEventType("find", event) ||
		isToolCallEventType("ls", event)
	);
}

/** Tools that mutate files; in-project ones take the accept-edits fast path. */
function isEditTool(event: ToolCallEvent): boolean {
	return isToolCallEventType("edit", event) || isToolCallEventType("write", event);
}

/**
 * Auto mode: the classifier replaces the prompt. Ordering matters — the
 * deny-list runs before the allow-fast-path, because a write into `.pi/` is
 * denied whether or not it looks in-project.
 */
async function gateAutoModeToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	deps: PermissionGateDeps,
): Promise<ToolCallEventResult | undefined> {
	const state = deps.state ?? getActivePermissionState();

	// 1. Reads always run.
	if (isReadOnlyTool(event)) return undefined;

	// 2. Protected paths: never judged, never overridden.
	if (isEditTool(event)) {
		for (const path of toolInputPaths(event.toolName, event.input, ctx.cwd)) {
			const denial = autoModeWriteDenial(path, ctx.cwd);
			if (denial) {
				return { block: true, reason: `${denial}. Ask the user to switch modes if it really must change.` };
			}
		}
		// 3. In-project edits take the accept-edits fast path (already checked safe).
		if (targetsInsideProject(event, ctx.cwd)) return undefined;
	}

	if (SELF_PROMPTING_TOOLS.has(event.toolName)) return undefined;

	// 4. Everything else is judged by the model.
	const classifier = deps.classifier ?? defaultClassifier(ctx.cwd);
	const decision: ClassifierDecision = await classifier(
		{ toolName: event.toolName, description: summarize(event), input: classifierActionInput(event) },
		ctx,
		ctx.signal ?? undefined,
	);
	return resolveAutoModeDecision(decision, event, ctx, state);
}

/** True when every path argument of the call lives under the session cwd. */
function targetsInsideProject(event: ToolCallEvent, cwd: string): boolean {
	const paths = toolInputPaths(event.toolName, event.input, cwd);
	if (paths.length === 0) return false;
	return paths.every((path) => isWithin(cwd, path));
}

/**
 * Turn a classifier decision into a gate result.
 *
 * - allow: run it, ending any deny streak.
 * - block: the deny stands, but a human in the loop can override it (Claude
 *   Code has no override because its blocks are terminal; here a wrong
 *   classifier should cost one click, not one wasted turn). With no UI to ask,
 *   the block is final.
 * - unavailable: no verdict is not a verdict — fall back to asking the user,
 *   which is exactly what accept-edits mode does.
 */
async function resolveAutoModeDecision(
	decision: ClassifierDecision,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	state: PermissionModeState,
): Promise<ToolCallEventResult | undefined> {
	if (!state.denials) state.denials = new DenialTracker();
	const denials = state.denials;

	if (decision.status === "allow") {
		denials.recordAllow();
		return undefined;
	}

	if (decision.status === "unavailable") {
		// No verdict is not a verdict: fall back to asking the human, which is
		// what accept-edits mode does. With no human to ask, fail closed.
		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					`Auto mode could not judge this ${event.toolName} call (${decision.reason ?? "no classifier verdict"}) ` +
					"and there is no user to ask, so it is denied. Ask the user, or work around it.",
			};
		}
		ctx.ui.notify(`Auto mode: ${decision.reason ?? "no classifier verdict"}. Asking instead.`, "warning");
		const yes = await ctx.ui.confirm(`Allow ${event.toolName}?`, summarize(event));
		if (yes) return undefined;
		return {
			block: true,
			reason:
				`The user denied this ${event.toolName} call (auto permission mode, no classifier verdict). ` +
				"Ask them what to do instead.",
		};
	}

	// Blocked by the classifier.
	const streak = denials.recordBlock();
	if (denials.shouldNotify() && ctx.hasUI) {
		ctx.ui.notify(
			`Auto mode has blocked ${streak} calls in a row. Switch with /permissions (bypass | accept-edits | auto | plan).`,
			"warning",
		);
	}
	const why = decision.reason ? `Auto mode blocked this call: ${decision.reason}` : "Auto mode blocked this call.";
	if (!ctx.hasUI) {
		return { block: true, reason: `${why} The agent must work around it or ask the user.` };
	}
	const override = await ctx.ui.confirm(
		`Override auto mode for ${event.toolName}?`,
		`${why}\n\n${summarize(event)}\n\nAllow anyway?`,
	);
	if (override) {
		denials.recordAllow();
		return undefined;
	}
	return {
		block: true,
		reason: `${why} The user also denied it. Do not retry this call; ask them what to do instead.`,
	};
}

/**
 * Gate one tool call under `mode`. Returns undefined to let it execute, a
 * block result to deny it, or (accept-edits / auto) awaits ctx.ui.confirm.
 * Exported for tests; the extension wires it to the tool_call event.
 */
export async function gatePermissionToolCall(
	event: ToolCallEvent,
	mode: PermissionMode,
	ctx: ExtensionContext,
	deps: PermissionGateDeps = {},
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

	if (mode === "auto") {
		return gateAutoModeToolCall(event, ctx, deps);
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
			// Persist every mode change into the session file so a resumed legacy
			// session can restore it (see the session_start handler below).
			// Last-write-wins across runtimes, like setActivePermissionState; a
			// stale ctx (session replaced between the change and the write) drops
			// the entry — the replacement session restores from its own entries.
			activeModeRecorder = (mode: PermissionMode) => {
				try {
					pi.appendEntry(PERMISSION_MODE_ENTRY_TYPE, { mode } satisfies PermissionModeEntryData);
				} catch {
					// extension ctx is stale after a session replacement
				}
			};

			const gateDeps: PermissionGateDeps = { classifier: options.classifier, state };

			const setMode = (mode: PermissionMode, ctx: ExtensionContext): void => {
				if (state.mode === mode) {
					ctx.ui.notify(`Permission mode is already ${mode}.`, "info");
					return;
				}
				state.mode = mode;
				options.onModeChange?.(mode);
				activeModeRecorder?.(mode);
				ctx.ui.notify(`Permission mode: ${PERMISSION_MODE_LABELS[mode]}`, "info");
			};

			pi.on("tool_call", async (event, ctx) => gatePermissionToolCall(event, state.mode, ctx, gateDeps));

			// The Shift+Tab cycle is TUI-only; onTerminalInput is a no-op
			// elsewhere, so this is safe to run from every host.
			pi.on("session_start", async (event, ctx) => {
				shiftTabUnsubscribe?.();
				shiftTabUnsubscribe = ctx.ui.onTerminalInput((data) => {
					if (!SHIFT_TAB_SEQUENCES.has(data)) return undefined;
					setMode(nextPermissionMode(state.mode), ctx);
					return { consume: true };
				});

				// Restore the mode a resumed legacy session was left in.
				// "startup" covers `pipi -r` at launch (a fresh session has no
				// entries, so the scan is a no-op there); "resume" covers an
				// in-TUI session switch. new/fork start at the default and
				// reload keeps the holder (it survives across /reload). An
				// explicit --plan launch wins over the persisted mode.
				if (event.reason !== "startup" && event.reason !== "resume") return;
				if (event.reason === "startup" && pi.getFlag("plan") === true) return;
				const restored = readPersistedPermissionMode(ctx);
				if (!restored || restored === state.mode) return;
				state.mode = restored;
				options.onModeChange?.(restored);
				// Re-engage the shared plan gate (and plan-file path) when the
				// restored mode is "plan", before the first agent run.
				syncPlanGateState(restored, ctx);
				ctx.ui.notify(`Permission mode restored: ${PERMISSION_MODE_LABELS[restored]}`, "info");
			});

			pi.registerCommand("permissions", {
				description: "Show or switch the permission mode: /permissions [bypass | accept-edits | auto | plan]",
				handler: async (args, ctx) => {
					const arg = args.trim();
					if (arg) {
						const parsed = parsePermissionMode(arg);
						if (!parsed) {
							ctx.ui.notify(
								`Unknown permission mode "${arg}". Use bypass, accept-edits, auto or plan.`,
								"warning",
							);
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
