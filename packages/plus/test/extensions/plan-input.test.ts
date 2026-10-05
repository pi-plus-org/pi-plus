/**
 * Tests for the plan extension's natural-language toggle: a bare
 * "enter plan mode" / "exit plan mode" prompt must be consumed
 * ({ action: "handled" }) and toggle plan mode instead of reaching the model.
 *
 * Also covers the coupling to the permissions extension: plan mode
 * auto-switches the shared permission mode to "plan" and restores the
 * previous mode on exit.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "../../../coding-agent/src/core/extensions/types.ts";
import { sharedPermissionState } from "../../src/extensions/permissions/index.ts";
import { registerPlan } from "../../src/extensions/plan/index.ts";

interface Harness {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	notifications: string[];
	input: (text: string) => unknown;
	sessionStart: (reason: string) => unknown;
}

function harness(): Harness {
	sharedPermissionState.mode = "bypass";
	const notifications: string[] = [];
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
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
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
		input: (text: string) => inputHandler({ type: "input", text, source: "interactive" } as InputEvent, ctx),
		sessionStart: (reason: string) => sessionStartHandler({ type: "session_start", reason }, ctx),
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

	it("keeps a manually selected plan permission mode on exit", async () => {
		const h = harness();
		sharedPermissionState.mode = "plan";
		await h.input("enter plan mode");
		await h.input("exit plan mode");
		assert.equal(sharedPermissionState.mode, "plan");
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
