/**
 * Tests for the stale-task cleanup in plus/src/extensions/tasks/index.ts —
 * the before_agent_start handler wipes leftover tasks when a user-started run
 * begins (session idle, so leftovers belong to finished or abandoned work),
 * unless a task is still in_progress. Custom triggerTurn runs never clear.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../coding-agent/src/config.ts";
import type { ExtensionAPI } from "../../../coding-agent/src/core/extensions/types.ts";
import { registerTasks, TASKS_SECTION_NAME } from "../../src/extensions/tasks/index.ts";
import type { Task } from "../../src/extensions/tasks/store.ts";
import * as tasks from "../../src/extensions/tasks/store.ts";

type BeforeAgentStartHandler = (
	event: {
		type: "before_agent_start";
		messageType: string;
		prompt?: string;
		systemPromptOptions: { sections: Record<string, string> };
	},
	ctx: unknown,
) => Promise<void>;

function captureHandler(): BeforeAgentStartHandler {
	let handler: BeforeAgentStartHandler | undefined;
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, fn: BeforeAgentStartHandler) => {
			if (event === "before_agent_start") handler = fn;
		},
	};
	registerTasks(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("before_agent_start handler was not registered");
	return handler;
}

let savedAgentDir: string | undefined;
let dir: string;
let sessionSeq = 0;

/** The handler reaches the store through listIdFor(ctx): the session id is the list id. */
function makeCtx(listId: string): unknown {
	return { sessionManager: { getSessionId: () => listId } };
}

function makeEvent(messageType: string): {
	event: Parameters<BeforeAgentStartHandler>[0];
	sections: Record<string, string>;
} {
	const sections: Record<string, string> = {};
	return {
		event: { type: "before_agent_start", messageType, prompt: "do the next job", systemPromptOptions: { sections } },
		sections,
	};
}

beforeAll(async () => {
	savedAgentDir = process.env[ENV_AGENT_DIR];
	dir = await mkdtemp(path.join(tmpdir(), "pi-tasks-cleanup-"));
	process.env[ENV_AGENT_DIR] = dir;
});

afterAll(async () => {
	if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDir;
	await rm(dir, { recursive: true, force: true });
});

describe("stale task cleanup on before_agent_start", () => {
	it("wipes leftover tasks when a user run starts and none is in_progress", async () => {
		const listId = `cleanup-${++sessionSeq}`;
		const store = tasks.TaskStore.forList(listId);
		await store.create({ subject: "Old A", description: "a" });
		await store.create({ subject: "Old B", description: "b" });

		const { event, sections } = makeEvent("user");
		await captureHandler()(event, makeCtx(listId));

		assert.deepEqual(await store.list(), []);
		expect(sections[TASKS_SECTION_NAME]).not.toContain("Current tasks");
	});

	it("keeps the list when a task is in_progress", async () => {
		const listId = `cleanup-${++sessionSeq}`;
		const store = tasks.TaskStore.forList(listId);
		const active = await store.create({ subject: "Running", description: "r" });
		await store.update(active.id, { status: "in_progress" });
		await store.create({ subject: "Pending", description: "p" });

		const { event, sections } = makeEvent("user");
		await captureHandler()(event, makeCtx(listId));

		assert.equal((await store.list()).length, 2);
		expect(sections[TASKS_SECTION_NAME]).toContain("Current tasks");
		expect(sections[TASKS_SECTION_NAME]).toContain("Running");
	});

	it("never clears on custom triggerTurn runs", async () => {
		const listId = `cleanup-${++sessionSeq}`;
		const store = tasks.TaskStore.forList(listId);
		await store.create({ subject: "Old", description: "o" });

		const { event } = makeEvent("custom");
		await captureHandler()(event, makeCtx(listId));

		assert.equal((await store.list()).length, 1);
	});

	it("assigns monotonic ids after a wipe", async () => {
		const listId = `cleanup-${++sessionSeq}`;
		const store = tasks.TaskStore.forList(listId);
		await store.create({ subject: "Old 1", description: "1" });
		await store.create({ subject: "Old 2", description: "2" });

		const { event } = makeEvent("user");
		await captureHandler()(event, makeCtx(listId));

		const fresh: Task = await store.create({ subject: "New", description: "n" });
		assert.equal(fresh.id, "3");
	});
});
