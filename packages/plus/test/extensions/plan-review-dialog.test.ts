/**
 * Tests for the ExitPlanMode review flow: hosts with a dedicated plan-review
 * dialog (pi-plus-desktop) get Claude Code style approve-and-run choices —
 * approve & auto-accept edits, approve & bypass permissions — each leaving
 * plan mode in that permission mode, plus stay. Hosts without the
 * handler keep the plain-text select fallback (same canonical choices).
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	InputEvent,
	RegisteredCommand,
	ToolDefinition,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { sharedPermissionState } from "../../src/extensions/permissions/index.ts";
import { type PlanReviewDialogChoice, registerPlan } from "../../src/extensions/plan/index.ts";
import { sharedPlanGateState } from "../../src/extensions/plan/state.ts";

interface Harness {
	input: (text: string) => unknown;
	exitPlanMode: (ctx?: { ui?: unknown } & Record<string, unknown>) => Promise<{ text: string }>;
	notifications: string[];
	selectCalls: string[];
	planReviewCalls: string[];
	/** Resolved value for the next planReview dialog. */
	nextPlanReview: PlanReviewDialogChoice | undefined;
}

function harness(): Harness {
	sharedPermissionState.mode = "bypass";
	sharedPlanGateState.enabled = false;
	sharedPlanGateState.planFilePath = undefined;
	const notifications: string[] = [];
	const selectCalls: string[] = [];
	const planReviewCalls: string[] = [];
	let nextPlanReview: PlanReviewDialogChoice | undefined;
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();

	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
			select: async (title: string) => {
				selectCalls.push(title);
				return undefined;
			},
			planReview: async (plan: string) => {
				planReviewCalls.push(plan);
				return nextPlanReview;
			},
		},
		hasUI: true,
		mode: "rpc",
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;

	registerPlan({
		registerFlag: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options as RegisteredCommand);
		},
		registerShortcut: () => {},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		sendUserMessage: () => {},
		getFlag: () => false,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);

	const inputHandler = handlers.get("input");
	assert.ok(inputHandler, "input handler must be registered");
	const exit = tools.get("ExitPlanMode");
	assert.ok(exit, "ExitPlanMode tool must be registered");

	return {
		notifications,
		selectCalls,
		planReviewCalls,
		get nextPlanReview() {
			return nextPlanReview;
		},
		set nextPlanReview(choice: PlanReviewDialogChoice | undefined) {
			nextPlanReview = choice;
		},
		input: (text: string) => inputHandler({ type: "input", text, source: "interactive" } as InputEvent, ctx),
		exitPlanMode: async (overrides: { ui?: unknown } & Record<string, unknown> = {}) => {
			const result = await exit.execute("call-1", {}, undefined as never, () => {}, {
				...ctx,
				...overrides,
			} as unknown as ExtensionToolContext);
			const block = result.content[0];
			assert.equal(block.type, "text");
			return { text: block.text };
		},
	};
}

/** Enter plan mode and write a real plan file so ExitPlanMode passes its preconditions. */
async function enterPlanModeWithPlan(h: Harness, plan = "# Plan\n\nDo the thing."): Promise<void> {
	assert.deepEqual(await h.input("enter plan mode"), { action: "handled" });
	assert.equal(sharedPlanGateState.enabled, true);
	const planFilePath = sharedPlanGateState.planFilePath;
	assert.ok(planFilePath);
	writeFileSync(planFilePath, plan, "utf-8");
}

describe("ExitPlanMode with a host plan-review dialog", () => {
	it("approve & auto-accept edits leaves plan mode in acceptEdits", async () => {
		const h = harness();
		await enterPlanModeWithPlan(h);
		h.nextPlanReview = "approveAcceptEdits";
		const result = await h.exitPlanMode();
		assert.equal(sharedPlanGateState.enabled, false);
		assert.equal(sharedPermissionState.mode, "acceptEdits");
		assert.ok(result.text.includes("acceptEdits"));
	});

	it("approve & bypass permissions leaves plan mode in bypass and says so", async () => {
		const h = harness();
		sharedPermissionState.mode = "acceptEdits";
		await enterPlanModeWithPlan(h);
		h.nextPlanReview = "approveBypass";
		const result = await h.exitPlanMode();
		assert.equal(sharedPlanGateState.enabled, false);
		assert.equal(sharedPermissionState.mode, "bypass");
		assert.ok(result.text.includes("bypass permissions"));
	});

	it("stay (and dismiss) keep plan mode active", async () => {
		const h = harness();
		await enterPlanModeWithPlan(h);
		h.nextPlanReview = "stay";
		const stay = await h.exitPlanMode();
		assert.equal(sharedPlanGateState.enabled, true);
		assert.ok(stay.text.includes("not ready to approve"));

		h.nextPlanReview = undefined;
		const dismissed = await h.exitPlanMode();
		assert.equal(sharedPlanGateState.enabled, true);
		assert.ok(dismissed.text.includes("not ready to approve"));
	});

	it("passes the plan markdown to the host dialog", async () => {
		const h = harness();
		await enterPlanModeWithPlan(h, "# Plan\n\nDo the thing.");
		h.nextPlanReview = "stay";
		await h.exitPlanMode();
		assert.deepEqual(h.planReviewCalls, ["# Plan\n\nDo the thing."]);
	});
});

describe("ExitPlanMode without a host plan-review dialog", () => {
	it("falls back to the plain-text select", async () => {
		const h = harness();
		await enterPlanModeWithPlan(h);
		h.nextPlanReview = undefined;
		// Strip the planReview handler to emulate a host without the dialog.
		const result = await h.exitPlanMode({
			ui: {
				select: async (title: string) => {
					h.selectCalls.push(title);
					return undefined;
				},
				notify: () => {},
			},
		});
		assert.deepEqual(h.planReviewCalls, []);
		assert.equal(h.selectCalls.length, 1);
		assert.ok(h.selectCalls[0].includes("Plan ready for review"));
		assert.equal(sharedPlanGateState.enabled, true);
		assert.ok(result.text.includes("not ready to approve"));
	});
});
