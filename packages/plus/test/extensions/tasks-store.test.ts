/**
 * Tests for plus/src/extensions/tasks/store.ts — file-backed task store:
 * create/update/delete transitions, dependency edges, id high-water mark,
 * list filtering, and mutation subscriptions. Uses tmpdir stores; no real
 * agent dir is touched (subscribeToTasks tests redirect it via env).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ENV_AGENT_DIR } from "../../../coding-agent/src/config.ts";
import { formatTaskLine, subscribeToTasks, TaskStore } from "../../src/extensions/tasks/store.ts";

let dir: string;
let store: TaskStore;

/** Let fire-and-forget notification microtasks run before asserting. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-tasks-test-"));
	store = TaskStore.forDir(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("create", () => {
	it("creates tasks with monotonically increasing ids", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B", activeForm: "doing B", owner: "scout" });
		assert.equal(a.id, "1");
		assert.equal(b.id, "2");
		assert.equal(a.status, "pending");
		assert.deepEqual(a.blocks, []);
		assert.equal(b.activeForm, "doing B");
		assert.equal(b.owner, "scout");
	});

	it("persists tasks to disk", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const raw = JSON.parse(fs.readFileSync(path.join(dir, `${task.id}.json`), "utf-8"));
		assert.equal(raw.subject, "A");
	});
});

describe("update", () => {
	it("updates status and tracks updated fields", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const result = await store.update(task.id, { status: "in_progress" });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, ["status"]);
		assert.equal(result.task.status, "in_progress");
	});

	it("returns an error for unknown ids", async () => {
		const result = await store.update("99", { status: "completed" });
		assert.ok("error" in result);
		assert.match(result.error, /not found/);
	});

	it("edits subject/description and adds dependency edges", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B" });
		const result = await store.update(a.id, { addBlocks: [b.id] });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, ["blocks"]);
		assert.deepEqual(result.task.blocks, [b.id]);

		const other = await store.update(b.id, { addBlockedBy: [a.id] });
		assert.ok(!("error" in other));
		assert.deepEqual(other.task.blockedBy, [a.id]);
	});

	it("does not duplicate dependency edges", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		const b = await store.create({ subject: "B", description: "do B" });
		await store.update(a.id, { addBlocks: [b.id] });
		const result = await store.update(a.id, { addBlocks: [b.id] });
		assert.ok(!("error" in result));
		assert.deepEqual(result.updatedFields, []);
	});

	it("status deleted removes the task file", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const result = await store.update(task.id, { status: "deleted" });
		assert.ok(!("error" in result));
		assert.equal(result.task.status, "deleted");
		assert.equal(fs.existsSync(path.join(dir, `${task.id}.json`)), false);
	});
});

describe("high-water mark", () => {
	it("never reuses ids after delete", async () => {
		const a = await store.create({ subject: "A", description: "do A" });
		await store.update(a.id, { status: "deleted" });
		const b = await store.create({ subject: "B", description: "do B" });
		assert.equal(b.id, "2");
	});
});

describe("get / list", () => {
	it("gets a task by id and returns null for unknown ids", async () => {
		const task = await store.create({ subject: "A", description: "do A" });
		const fetched = await store.get(task.id);
		assert.equal(fetched?.subject, "A");
		assert.equal(await store.get("99"), null);
	});

	it("lists tasks sorted by id", async () => {
		await store.create({ subject: "C", description: "c" });
		await store.create({ subject: "A", description: "a" });
		await store.create({ subject: "B", description: "b" });
		const tasks = await store.list();
		assert.deepEqual(
			tasks.map((t) => t.subject),
			["C", "A", "B"],
		);
	});

	it("strips blockedBy entries pointing at completed tasks", async () => {
		const a = await store.create({ subject: "A", description: "a" });
		const b = await store.create({ subject: "B", description: "b" });
		await store.update(b.id, { addBlockedBy: [a.id] });
		await store.update(a.id, { status: "completed" });
		const tasks = await store.list();
		assert.deepEqual(tasks.find((t) => t.id === b.id)?.blockedBy, []);
	});

	it("hides tasks with metadata._internal", async () => {
		const task = await store.create({ subject: "A", description: "a" });
		// Simulate an internal task written behind the store's back.
		const raw = JSON.parse(fs.readFileSync(path.join(dir, `${task.id}.json`), "utf-8"));
		raw.metadata = { _internal: true };
		fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(raw));
		assert.deepEqual(await store.list(), []);
	});

	it("lists nothing for a missing directory", async () => {
		const empty = TaskStore.forDir(path.join(dir, "nope"));
		assert.deepEqual(await empty.list(), []);
	});
});

describe("formatTaskLine", () => {
	it("formats status, owner, and blockers", async () => {
		const a = await store.create({ subject: "Fix auth", description: "d" });
		const b = await store.create({ subject: "Write tests", description: "d" });
		await store.update(b.id, { status: "in_progress", owner: "worker", addBlockedBy: [a.id] });
		const tasks = await store.list();
		assert.equal(
			formatTaskLine(tasks.find((t) => t.id === b.id)!),
			`#${b.id} [in_progress] Write tests (worker) [blocked by #${a.id}]`,
		);
	});
});

describe("subscribe", () => {
	it("notifies with the post-mutation list on create, update, and delete", async () => {
		const notifications: string[][] = [];
		const unsubscribe = store.subscribe((tasks) => notifications.push(tasks.map((t) => `${t.id}:${t.status}`)));

		const a = await store.create({ subject: "A", description: "a" });
		await store.update(a.id, { status: "in_progress" });
		await store.update(a.id, { status: "deleted" });
		await flush();

		unsubscribe();
		assert.deepEqual(notifications, [["1:pending"], ["1:in_progress"], []]);
	});

	it("stops notifying after unsubscribe", async () => {
		const notifications: number[] = [];
		const unsubscribe = store.subscribe((tasks) => notifications.push(tasks.length));
		await store.create({ subject: "A", description: "a" });
		await flush();
		unsubscribe();
		await store.create({ subject: "B", description: "b" });
		await flush();
		assert.deepEqual(notifications, [1]);
	});

	it("a throwing listener does not break task operations or other listeners", async () => {
		const seen: number[] = [];
		store.subscribe(() => {
			throw new Error("boom");
		});
		store.subscribe((tasks) => seen.push(tasks.length));
		const task = await store.create({ subject: "A", description: "a" });
		await flush();
		assert.equal(task.id, "1");
		assert.deepEqual(seen, [1]);
	});
});

describe("subscribeToTasks", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		// Redirect the agent dir so forList writes into a tmpdir. List ids are
		// unique per test because TaskStore.forList caches one instance per
		// list id per process, keyed before this env is restored.
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-tasks-agentdir-"));
		previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("fires immediately with the current list, then on every mutation", async () => {
		const notifications: string[][] = [];
		const listId = "subscribe-immediate";
		const unsubscribe = subscribeToTasks(listId, (tasks) => notifications.push(tasks.map((t) => t.subject)));
		await flush();

		const store = TaskStore.forList(listId);
		await store.create({ subject: "A", description: "a" });
		await store.create({ subject: "B", description: "b" });
		await flush();

		unsubscribe();
		assert.deepEqual(notifications, [[], ["A"], ["A", "B"]]);
	});

	it("returns the same store instance for the same list id", () => {
		assert.equal(TaskStore.forList("singleton-a"), TaskStore.forList("singleton-a"));
	});
});
