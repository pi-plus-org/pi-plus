/**
 * Tests for the plan extension's natural-language toggle: a bare
 * "enter plan mode" / "exit plan mode" prompt must be consumed
 * ({ action: "handled" }) and toggle plan mode instead of reaching the model.
 *
 * Also covers the coupling to the permissions extension: plan mode
 * auto-switches the shared permission mode to "plan" and restores the
 * previous mode on exit, and the `/plan <prompt>` command form forwards the
 * text to the model (turning plan mode on first).
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	RegisteredCommand,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { sharedPermissionState } from "../../src/extensions/permissions/index.ts";
import { registerPlan } from "../../src/extensions/plan/index.ts";
import { sharedPlanGateState } from "../../src/extensions/plan/state.ts";

interface Harness {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	notifications: string[];
	sentUserMessages: string[];
	command: (name: string) => RegisteredCommand | undefined;
	input: (text: string) => unknown;
	sessionStart: (reason: string) => unknown;
	runCommand: (args: string) => Promise<void>;
}

function harness(): Harness {
	sharedPermissionState.mode = "bypass";
	sharedPlanGateState.enabled = false;
	sharedPlanGateState.planFilePath = undefined;
	const notifications: string[] = [];
	const sentUserMessages: string[] = [];
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const ctx = {
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionContext;
	registerPlan({
		registerFlag: () => {},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options as RegisteredCommand);
		},
		registerShortcut: () => {},
		registerTool: () => {},
		sendUserMessage: (content: string) => {
			sentUserMessages.push(content);
		},
		getFlag: () => false,
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	const inputHandler = handlers.get("input");
	assert.ok(inputHandler, "input handler must be registered");
	const sessionStartHandler = handlers.get("session_start");
	assert.ok(sessionStartHandler, "session_start handler must be registered");
	return {
		handlers,
		notifications,
		sentUserMessages,
		command: (name: string) => commands.get(name),
		input: (text: string) => inputHandler({ type: "input", text, source: "interactive" } as InputEvent, ctx),
		sessionStart: (reason: string) => sessionStartHandler({ type: "session_start", reason }, ctx),
		runCommand: async (args: string) => {
			const plan = commands.get("plan");
			assert.ok(plan, "plan command must be registered");
			await plan.handler(args, ctx as unknown as ExtensionCommandContext);
		},
	};
}

describe("plan mode natural-language toggle", () => {
	it("consumes 'exit plan mode' even when plan mode is off (notifies instead)", async () => {
		const h = harness();
		const result = await h.input("exit plan mode");
		assert.deepEqual(result, { action: "handled" });
		assert.ok(h.notifications.some((n) => n.includes("already off")));
	});

	it("toggles plan mode on and off via prompts", async () => {
		const h = harness();
		assert.deepEqual(await h.input("enter plan mode"), { action: "handled" });
		assert.ok(h.notifications.some((n) => n.includes("Plan mode on")));
		assert.deepEqual(await h.input("exit plan mode"), { action: "handled" });
		assert.ok(h.notifications.some((n) => n.includes("Plan mode off")));
	});

	it("is case-insensitive and trims whitespace", async () => {
		const h = harness();
		assert.deepEqual(await h.input("  Enter Plan Mode  "), { action: "handled" });
		assert.ok(h.notifications.some((n) => n.includes("Plan mode on")));
	});

	it("reports when already in the requested state", async () => {
		const h = harness();
		await h.input("enter plan mode");
		assert.deepEqual(await h.input("enter plan mode"), { action: "handled" });
		assert.ok(h.notifications.some((n) => n.includes("already on")));
	});

	it("passes unrelated prompts through to the model", async () => {
		const h = harness();
		assert.deepEqual(await h.input("how do I exit plan mode in claude code?"), { action: "continue" });
		assert.deepEqual(await h.input("exit plan mode please"), { action: "continue" });
		assert.deepEqual(h.notifications, []);
	});
});

describe("plan mode ↔ permission mode coupling", () => {
	it("switches the shared permission mode to plan on enter", async () => {
		const h = harness();
		assert.equal(sharedPermissionState.mode, "bypass");
		await h.input("enter plan mode");
		assert.equal(sharedPermissionState.mode, "plan");
	});

	it("restores the previous permission mode on exit", async () => {
		const h = harness();
		sharedPermissionState.mode = "acceptEdits";
		await h.input("enter plan mode");
		assert.equal(sharedPermissionState.mode, "plan");
		await h.input("exit plan mode");
		assert.equal(sharedPermissionState.mode, "acceptEdits");
	});

	it("drops to bypass on exit when the plan permission mode was pre-selected", async () => {
		// Unified semantics: permission mode "plan" IS plan mode, so exiting
		// plan mode must not land back in it — that would keep the read-only
		// gate latched after an approved plan.
		const h = harness();
		sharedPermissionState.mode = "plan";
		await h.input("enter plan mode");
		await h.input("exit plan mode");
		assert.equal(sharedPermissionState.mode, "bypass");
	});

	it("restores the permission mode when the session resets", async () => {
		const h = harness();
		sharedPermissionState.mode = "acceptEdits";
		await h.input("enter plan mode");
		assert.equal(sharedPermissionState.mode, "plan");
		await h.sessionStart("new");
		assert.equal(sharedPermissionState.mode, "acceptEdits");
	});
});

describe("/plan command", () => {
	it("toggles plan mode with no args", async () => {
		const h = harness();
		await h.runCommand("");
		assert.ok(h.notifications.some((n) => n.includes("Plan mode on")));
		assert.equal(sharedPermissionState.mode, "plan");
		await h.runCommand("");
		assert.ok(h.notifications.some((n) => n.includes("Plan mode off")));
		assert.equal(sharedPermissionState.mode, "bypass");
	});

	it("forwards a prompt argument to the model, turning plan mode on first", async () => {
		const h = harness();
		await h.runCommand("refactor the footer component");
		assert.equal(sharedPermissionState.mode, "plan");
		assert.deepEqual(h.sentUserMessages, ["refactor the footer component"]);
		assert.ok(h.notifications.some((n) => n.includes("Plan mode on")));
	});

	it("forwards the prompt without re-toggling when plan mode is already on", async () => {
		const h = harness();
		await h.runCommand("");
		h.notifications.length = 0;
		await h.runCommand("also cover the empty state");
		assert.equal(sharedPermissionState.mode, "plan");
		assert.deepEqual(h.sentUserMessages, ["also cover the empty state"]);
		assert.ok(!h.notifications.some((n) => n.includes("Plan mode on")));
	});
});
