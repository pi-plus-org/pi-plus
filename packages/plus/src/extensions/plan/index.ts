/**
 * Plan mode (openclaude/Claude Code style): a read-only research phase where
 * the model investigates the codebase, writes an implementation plan to the
 * session plan file (<agentDir>/plans/<sessionId>.md — the only file it may
 * edit), and ends by calling ExitPlanMode to present the plan for approval.
 *
 * Entry points: the model calls EnterPlanMode (asks the user to confirm), or
 * the user runs /plan, presses ctrl+alt+p, prompts "enter plan mode" /
 * "exit plan mode", or launches with --plan. While active, a <plan_mode>
 * system-prompt section drives the workflow and the
 * tool_call gate (gate.ts) enforces read-only: edit/write are restricted to
 * the plan file, bash to a read-only allowlist, powershell and non-allowlisted
 * custom tools (subagent unless the read-only "explore" type) are blocked.
 *
 * ExitPlanMode shows the plan as rendered markdown with Approve / Stay
 * choices (Claude Code style; a plain-text select on non-TUI hosts);
 * approval turns plan mode off and returns the approved plan to the model
 * with full tool access. State is per-session in memory (reset on
 * new/resume/fork).
 *
 * Plan mode is coupled to the permissions extension: activating it switches
 * the shared permission mode to "plan" (so the footer indicator and the
 * permission gate follow), and deactivating restores the mode that was set
 * before plan mode engaged. The footer indicator is rendered solely by the
 * permissions layer (plus footer wrapper / host UI) — this extension does
 * not set its own status slot. The plan gate state itself lives in the
 * module-level {@link sharedPlanGateState} holder so the permission mode
 * "plan" gate applies the same plan-file carve-out instead of a second,
 * carve-out-less gate that would block writes to the plan file itself.
 */

import * as fs from "node:fs";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "../../../../coding-agent/src/core/extensions/types.ts";
import {
	getActivePermissionState,
	notifyActivePermissionModeChange,
	type PermissionMode,
} from "../permissions/index.ts";
import { PLAN_REVIEW_CHOICES, type PlanReviewDialogChoice, PlanViewComponent } from "./component.ts";

export type { PlanReviewDialogChoice };

import { gateToolCall } from "./gate.ts";
import { planFilePathFor, readPlan, writePlan } from "./plan-file.ts";
import { buildPlanModeSection, PLAN_MODE_SECTION_NAME } from "./prompt.ts";
import { type PlanModeState, sharedPlanGateState } from "./state.ts";
import { EnterPlanModeParams, ExitPlanModeParams } from "./tools.ts";

function sessionIdFor(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId() || "default";
	} catch {
		return "default";
	}
}

/**
 * Optional {@link ExtensionUIContext} extension SDK hosts provide via
 * createPlusUIContext to take over the plan-review presentation. Must honor
 * the canonical {@link PlanReviewDialogChoice} set (component.ts) — the ids
 * and labels are the contract shared with the TUI component and the
 * plain-text select fallback. undefined = dismissed.
 */
export interface PlanReviewDialogUI {
	planReview(plan: string): Promise<PlanReviewDialogChoice | undefined>;
}

/** Review outcome: approve (always with a permission mode) / stay. */
interface PlanReviewResult {
	choice: "approve" | "stay";
	/** Engage this permission mode on approval (approve-and-run choices). */
	permissionMode?: PermissionMode;
}

/**
 * Map a canonical review pick to the review outcome — the single mapping
 * every presentation path (host dialog, TUI component, select fallback)
 * funnels through, so the CLI and embedding hosts can't drift apart.
 */
function resolveReviewPick(pick: PlanReviewDialogChoice | undefined): PlanReviewResult {
	if (pick === "approveAcceptEdits") return { choice: "approve", permissionMode: "acceptEdits" };
	if (pick === "approveBypass") return { choice: "approve", permissionMode: "bypass" };
	return { choice: "stay" };
}

/**
 * Present the plan for approval. Hosts with a dedicated plan-review dialog
 * (pi-plus-desktop) render the markdown themselves; the interactive TUI gets
 * the rendered-markdown review component; other RPC / headless hosts fall
 * back to the plain-text select. All three present the same canonical
 * choices (PLAN_REVIEW_CHOICES) and map picks through resolveReviewPick; a
 * dismissed dialog behaves like "stay".
 */
async function reviewPlan(ctx: ExtensionContext, plan: string): Promise<PlanReviewResult> {
	const planReview = (ctx.ui as Partial<PlanReviewDialogUI>).planReview;
	if (planReview) {
		return resolveReviewPick(await planReview(plan));
	}
	if (ctx.mode !== "tui") {
		const picked = await ctx.ui.select(
			`Plan ready for review:\n\n${plan}\n\nWhat next?`,
			PLAN_REVIEW_CHOICES.map((choice) => choice.label),
		);
		return resolveReviewPick(PLAN_REVIEW_CHOICES.find((choice) => choice.label === picked)?.id);
	}
	const pick = await ctx.ui.custom<PlanReviewDialogChoice | undefined>(
		(tui, theme, _kb, done) => {
			const bodyHeight = Math.max(8, tui.terminal.rows - 14);
			return new PlanViewComponent({ plan, theme, mode: "review", bodyHeight, onDone: done });
		},
		// Overlay: the alt-screen viewport would otherwise swallow pageUp/pageDown
		// for transcript scrolling before they reach the focused component.
		{ overlay: true, overlayOptions: { width: "100%" } },
	);
	return resolveReviewPick(pick);
}

/** Show the plan read-only (/plan show) — the same markdown view, no choices. */
async function showPlanView(ctx: ExtensionContext, plan: string): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(plan, "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			const bodyHeight = Math.max(8, tui.terminal.rows - 10);
			return new PlanViewComponent({ plan, theme, mode: "view", bodyHeight, onDone: () => done() });
		},
		{ overlay: true, overlayOptions: { width: "100%" } },
	);
}

export function registerPlan(pi: ExtensionAPI): void {
	// The shared holder: the permissions extension's "plan" gate reads this
	// same state so both gates agree on the plan-file carve-out.
	const state: PlanModeState = sharedPlanGateState;
	// Permission mode in effect before plan mode auto-switched it to "plan";
	// restored on exit so the user lands back where they were.
	let prePlanPermissionMode: PermissionMode | undefined;

	function activate(ctx: ExtensionContext): void {
		state.planFilePath = planFilePathFor(sessionIdFor(ctx));
		state.enabled = true;
		// Couple through the holder the permissions gate actually reads (a
		// host-injected per-tab state in embedders), not the module default —
		// otherwise the gate's per-tool-call sync tears plan mode straight back
		// down on the first tool call.
		const permissionState = getActivePermissionState();
		if (permissionState.mode !== "plan") {
			prePlanPermissionMode = permissionState.mode;
			permissionState.mode = "plan";
			notifyActivePermissionModeChange("plan");
		}
	}

	function deactivate(restoreOverride?: PermissionMode): void {
		state.enabled = false;
		state.planFilePath = undefined;
		// Land back on the pre-plan mode. When plan mode was engaged from the
		// permissions side (Shift+Tab / /permissions / host UI) there is no
		// recorded pre-plan mode — drop to "bypass" rather than staying in
		// "plan", which would keep the read-only gate latched after approval.
		// An explicit override (approve-and-run review choices) wins over both.
		const restore = restoreOverride ?? prePlanPermissionMode ?? "bypass";
		prePlanPermissionMode = undefined;
		const permissionState = getActivePermissionState();
		if (restoreOverride !== undefined) {
			permissionState.mode = restoreOverride;
			notifyActivePermissionModeChange(restoreOverride);
		} else if (permissionState.mode === "plan") {
			permissionState.mode = restore;
			notifyActivePermissionModeChange(restore);
		}
	}

	function toggle(ctx: ExtensionContext): void {
		if (state.enabled) {
			deactivate();
			ctx.ui.notify("Plan mode off — full tool access restored.", "info");
		} else {
			activate(ctx);
			ctx.ui.notify(`Plan mode on — read-only. Plan file: ${state.planFilePath}`, "info");
		}
	}

	async function editPlan(ctx: ExtensionContext): Promise<void> {
		if (!state.planFilePath) {
			ctx.ui.notify("Plan mode is not active.", "warning");
			return;
		}
		const current = await readPlan(state.planFilePath);
		const edited = await ctx.ui.editor("Edit the plan", current);
		if (edited === undefined) {
			ctx.ui.notify("Plan edit cancelled.", "info");
			return;
		}
		await writePlan(state.planFilePath, edited);
		ctx.ui.notify(`Plan saved to ${state.planFilePath}`, "info");
	}

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only; the model writes a plan for approval before changing anything)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("plan", {
		description:
			"Toggle plan mode (no args), /plan <prompt> to plan a task, or /plan show | /plan edit the current plan",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "") {
				toggle(ctx);
				return;
			}
			if (arg === "show") {
				if (!state.planFilePath) {
					ctx.ui.notify("Plan mode is not active.", "warning");
					return;
				}
				const plan = await readPlan(state.planFilePath);
				if (plan.trim().length === 0) {
					ctx.ui.notify(`Plan file is empty: ${state.planFilePath}`, "info");
					return;
				}
				await showPlanView(ctx, plan);
				return;
			}
			if (arg === "edit") {
				await editPlan(ctx);
				return;
			}
			// Anything else is a task to plan: make sure plan mode is on, then
			// forward the text to the model as a user message (queued as
			// steering while the agent is streaming).
			if (!state.enabled) toggle(ctx);
			pi.sendUserMessage(arg, { deliverAs: "steer" });
		},
	});

	// ctrl+p / shift+ctrl+p cycle models; ctrl+alt+p is free (same chord the
	// coding-agent plan-mode example uses) and works under the vim editor.
	pi.registerShortcut("ctrl+alt+p", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			toggle(ctx);
		},
	});

	// Natural-language toggle: a bare "enter plan mode" / "exit plan mode"
	// prompt is consumed here (like /plan) instead of being sent to the model.
	pi.on("input", async (event, ctx) => {
		if (event.images && event.images.length > 0) return { action: "continue" };
		const text = event.text.trim().toLowerCase();
		if (text === "enter plan mode" || text === "exit plan mode") {
			const enabling = text === "enter plan mode";
			if (enabling === state.enabled) {
				ctx.ui.notify(`Plan mode is already ${state.enabled ? "on" : "off"}.`, "info");
				return { action: "handled" };
			}
			toggle(ctx);
			return { action: "handled" };
		}
		return { action: "continue" };
	});

	pi.registerTool({
		name: "EnterPlanMode",
		label: "Enter Plan Mode",
		description:
			"Enter plan mode: a read-only research phase. You investigate the codebase, write an " +
			"implementation plan to the session plan file (the only file you may edit), and end by " +
			"calling ExitPlanMode to present the plan for approval. Use when the user asks you to plan " +
			"first, investigate before implementing, or design an approach before making changes.",
		parameters: EnterPlanModeParams,
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (state.enabled) {
				return {
					content: [
						{ type: "text", text: `Plan mode is already active. The plan file is ${state.planFilePath}.` },
					],
					details: undefined,
				};
			}
			if (!ctx.hasUI) {
				throw new Error(
					"EnterPlanMode requires the interactive TUI (the user must confirm); continuing without plan mode.",
				);
			}
			const yes = await ctx.ui.confirm(
				"Enter plan mode?",
				"The agent becomes read-only and writes an implementation plan for your approval before making any changes.",
			);
			if (!yes) {
				return {
					content: [
						{ type: "text", text: "The user declined to enter plan mode. Proceed with normal execution." },
					],
					details: undefined,
				};
			}
			activate(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Plan mode activated. Plan file: ${state.planFilePath}\n` +
							"Research the codebase read-only and write the plan to that file (it is the only file you may edit), " +
							"then call ExitPlanMode when the plan is ready for approval.",
					},
				],
				details: undefined,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("EnterPlanMode")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "ExitPlanMode",
		label: "Exit Plan Mode",
		description:
			"Present the finished plan to the user for approval and exit plan mode. Call only when the " +
			"plan file is complete. On approval plan mode ends, full tool access is restored, and you " +
			"begin implementing the approved plan; on rejection you remain in plan mode with the user's " +
			"feedback. Never ask about plan approval in text — this tool is the approval flow.",
		parameters: ExitPlanModeParams,
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!state.enabled || !state.planFilePath) {
				throw new Error(
					"Plan mode is not active. This tool is only for exiting plan mode after writing a plan. " +
						"If your plan was already approved, continue with implementation.",
				);
			}
			if (!ctx.hasUI) {
				throw new Error(
					"Plan approval requires the interactive TUI. Ask the user to run /plan to toggle plan mode off, then continue.",
				);
			}
			const plan = await readPlan(state.planFilePath);
			if (plan.trim().length === 0) {
				throw new Error(
					`The plan file is empty. Write the plan to ${state.planFilePath} first, then call ExitPlanMode again.`,
				);
			}

			const { choice, permissionMode } = await reviewPlan(ctx, plan);

			if (choice === "approve") {
				deactivate(permissionMode);
				const modeNote =
					permissionMode === "acceptEdits"
						? ' The user chose "approve & auto-accept edits": permission mode is now acceptEdits — file edits run without asking; shell and other tools still ask first.'
						: permissionMode === "bypass"
							? ' The user chose "approve & bypass permissions": permission mode is now bypass — execute the plan fully automatically.'
							: "";
				return {
					content: [
						{
							type: "text",
							text:
								"User has approved your plan. Plan mode is now OFF and you have full tool access." +
								modeNote +
								" Implement the approved plan exactly as written:\n\n" +
								plan +
								"\n\nBegin implementation now.",
						},
					],
					details: undefined,
				};
			}

			// "Stay in plan mode" (or the dialog was dismissed).
			return {
				content: [
					{
						type: "text",
						text: "The user is not ready to approve. Remain in plan mode; continue researching or refining the plan file, then call ExitPlanMode again.",
					},
				],
				details: undefined,
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ExitPlanMode")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	// Read-only gate: blocks mutating tool calls while plan mode is active.
	pi.on("tool_call", async (event, ctx) => {
		return gateToolCall(event, state, ctx.cwd);
	});

	// Drive the workflow via a system-prompt section while plan mode is active.
	pi.on("before_agent_start", async (event) => {
		if (!state.enabled || !state.planFilePath) return;
		event.systemPromptOptions.sections[PLAN_MODE_SECTION_NAME] = buildPlanModeSection({
			planFilePath: state.planFilePath,
			planExists: fs.existsSync(state.planFilePath),
		});
	});

	// Per-session state lifecycle.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			state.enabled = false;
			state.planFilePath = undefined;
			// Plan mode is off in the fresh session; undo the auto-switch so the
			// permission footer/gate return to the pre-plan mode as well. With no
			// recorded pre-plan mode (plan was engaged from the permissions
			// side), drop a lingering "plan" mode to bypass — otherwise the
			// permissions gate would lazily re-engage plan mode without the
			// plan workflow section for the new session.
			if (prePlanPermissionMode !== undefined) {
				const permissionState = getActivePermissionState();
				permissionState.mode = prePlanPermissionMode;
				notifyActivePermissionModeChange(permissionState.mode);
				prePlanPermissionMode = undefined;
			} else if (getActivePermissionState().mode === "plan") {
				getActivePermissionState().mode = "bypass";
				notifyActivePermissionModeChange("bypass");
			}
		}
		if (pi.getFlag("plan") === true && (event.reason === "startup" || event.reason === "new")) {
			state.enabled = true;
			const permissionState = getActivePermissionState();
			if (permissionState.mode !== "plan") {
				prePlanPermissionMode = permissionState.mode;
				permissionState.mode = "plan";
				notifyActivePermissionModeChange("plan");
			}
		}
		// Recompute the plan file path (also covers /reload, where the flag and
		// enabled state survive but the session id context is fresh).
		if (state.enabled && !state.planFilePath) {
			state.planFilePath = planFilePathFor(sessionIdFor(ctx));
		}
	});
}

// Re-exported for tests and the plus extensions index.
export type { PlanModeState } from "./state.ts";
