/**
 * Tests for plus/src/extensions/tasks/widget.ts — pinned widget lines and
 * footer status text for the task strip above the editor.
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { Task } from "../../src/extensions/tasks/store.ts";
import { renderTasksWidgetLines, tasksStatusText } from "../../src/extensions/tasks/widget.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeTask(overrides: Partial<Task> & { id: string; subject: string }): Task {
	return {
		description: "d",
		status: "pending",
		blocks: [],
		blockedBy: [],
		...overrides,
	};
}

beforeAll(() => {
	initTheme("dark");
});

describe("tasksStatusText", () => {
	it("returns undefined with no open tasks", () => {
		assert.equal(tasksStatusText([], theme), undefined);
		assert.equal(tasksStatusText([makeTask({ id: "1", subject: "A", status: "completed" })], theme), undefined);
	});

	it("formats per-status counts", () => {
		const tasks = [
			makeTask({ id: "1", subject: "A", status: "completed" }),
			makeTask({ id: "2", subject: "B", status: "completed" }),
			makeTask({ id: "3", subject: "C", status: "in_progress" }),
			makeTask({ id: "4", subject: "D" }),
		];
		assert.equal(stripAnsi(tasksStatusText(tasks, theme)!), "✓2 ◐1 ○1");
	});
});

describe("renderTasksWidgetLines", () => {
	it("returns undefined when there is nothing left to do", () => {
		assert.equal(renderTasksWidgetLines([], theme), undefined);
		assert.equal(
			renderTasksWidgetLines([makeTask({ id: "1", subject: "A", status: "completed" })], theme),
			undefined,
		);
	});

	it("still shows completed tasks while any task is open", () => {
		const tasks = [
			makeTask({ id: "1", subject: "A", status: "completed" }),
			makeTask({ id: "2", subject: "B", status: "in_progress" }),
		];
		const lines = renderTasksWidgetLines(tasks, theme)!.map(stripAnsi);
		assert.equal(lines.length, 3);
		assert.match(lines[0], /^Tasks\s+✓1 ◐1 ○0$/);
	});

	it("renders a header with counts and one line per task", () => {
		const tasks = [
			makeTask({ id: "1", subject: "Fix auth", status: "completed" }),
			makeTask({ id: "2", subject: "Add tests", status: "in_progress", activeForm: "Adding tests" }),
			makeTask({ id: "3", subject: "Ship it", blockedBy: ["1"], owner: "worker" }),
		];
		const lines = renderTasksWidgetLines(tasks, theme)!.map(stripAnsi);
		assert.equal(lines.length, 4);
		assert.match(lines[0], /^Tasks\s+✓1 ◐1 ○1$/);
		assert.match(lines[1], /✓ #1 .*Fix auth/);
		assert.match(lines[2], /◐ #2 .*Adding tests/);
		assert.match(lines[3], /○ #3 .*Ship it \(worker\) \[blocked by #1\]/);
	});

	it("truncates to 10 lines with an … N more line", () => {
		const tasks = Array.from({ length: 15 }, (_, i) => makeTask({ id: String(i + 1), subject: `Task ${i + 1}` }));
		const lines = renderTasksWidgetLines(tasks, theme)!.map(stripAnsi);
		assert.equal(lines.length, 10);
		assert.match(lines[9], /… 7 more/);
	});
});
