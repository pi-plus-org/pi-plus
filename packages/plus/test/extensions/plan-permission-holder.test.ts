/**
 * Regression test for the embedding-host plan mode failure (pi-plus-desktop):
 * the host injects a per-tab permission holder via createPermissionsExtension,
 * and plan-mode engage/exit must couple to THAT holder. Before the fix, plan
 * activate() wrote the module-level sharedPermissionState while the
 * permissions gate synced the shared plan gate state from the injected holder
 * ("bypass") on the first tool call — silently tearing plan mode down, so the
 * model's ExitPlanMode call failed with "Plan mode is not active" even though
 * the <plan_mode> section had been injected at turn start.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	RegisteredCommand,
	ToolCallEvent,
} from "../../../coding-agent/src/core/extensions/types.ts";
import {
	createPermissionsExtension,
	type PermissionMode,
	sharedPermissionState,
} from "../../src/extensions/permissions/index.ts";
import { registerPlan } from "../../src/extensions/plan/index.ts";
import { sharedPlanGateState } from "../../src/extensions/plan/state.ts";

interface HostHarness {
	holder: { mode: PermissionMode };
	modeChanges: PermissionMode[];
	notifications: string[];
	input: (text: string) => unknown;
	gateToolCall: (event: ToolCallEvent) => unknown;
}

function hostHarness(): HostHarness {
	sharedPermissionState.mode = "bypass";
	sharedPlanGateState.enabled = false;
	sharedPlanGateState.planFilePath = undefined;
	const holder: { mode: PermissionMode } = { mode: "bypass" };
	const modeChanges: PermissionMode[] = [];
	const notifications: string[] = [];
	const planHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const permissionsHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, RegisteredCommand>();

	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		hasUI: true,
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;

	// The host wires the permissions extension with its per-tab holder
	// (desktop: one runtime per tab, factory runs at runtime creation).
	const permissions = createPermissionsExtension({ state: holder, onModeChange: (mode) => modeChanges.push(mode) });
	if (typeof permissions === "function") throw new Error("expected the named-extension object form");
	permissions.factory({
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			permissionsHandlers.set(event, handler);
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI);

	// The SDK loads the plan extension alongside it.
	registerPlan({
		registerFlag: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options as RegisteredCommand);
		},
		registerShortcut: () => {},
		registerTool: () => {},
		sendUserMessage: () => {},
		getFlag: () => false,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			planHandlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);

	const inputHandler = planHandlers.get("input");
	assert.ok(inputHandler, "input handler must be registered");
	const gateHandler = permissionsHandlers.get("tool_call");
	assert.ok(gateHandler, "permissions tool_call handler must be registered");

	return {
		holder,
		modeChanges,
		notifications,
		input: (text: string) => inputHandler({ type: "input", text, source: "interactive" } as InputEvent, ctx),
		gateToolCall: (event: ToolCallEvent) => gateHandler(event, ctx),
	};
}

describe("plan mode with a host-injected permission holder", () => {
	it("couples plan engage/exit to the injected holder, not the module default", async () => {
		const h = hostHarness();
		await h.input("enter plan mode");
		assert.equal(h.holder.mode, "plan");
		assert.equal(sharedPermissionState.mode, "bypass");
		assert.deepEqual(h.modeChanges, ["plan"]);

		await h.input("exit plan mode");
		assert.equal(h.holder.mode, "bypass");
		assert.deepEqual(h.modeChanges, ["plan", "bypass"]);
	});

	it("keeps plan mode alive across the gate's per-tool-call sync (ExitPlanMode precondition)", async () => {
		const h = hostHarness();
		await h.input("enter plan mode");
		assert.equal(sharedPlanGateState.enabled, true);
		const planFilePath = sharedPlanGateState.planFilePath;
		assert.ok(planFilePath);

		// The first gated tool call used to sync the plan gate state from the
		// module default ("bypass") and tear plan mode down right here.
		const allow = await h.gateToolCall({
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "write",
			input: { path: planFilePath },
		} as ToolCallEvent);
		assert.equal(allow, undefined);
		assert.equal(sharedPlanGateState.enabled, true);

		// Non-plan writes stay blocked while plan mode is active.
		const block = await h.gateToolCall({
			type: "tool_call",
			toolCallId: "call-2",
			toolName: "write",
			input: { path: "/tmp/other.md" },
		} as ToolCallEvent);
		assert.deepEqual((block as { block: boolean }).block, true);
	});
});
