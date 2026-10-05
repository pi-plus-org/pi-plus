/**
 * Pinned task widget: renders the session's task list as lines for
 * `ctx.ui.setWidget(..., { placement: "aboveEditor" })` — the todo strip
 * pinned between the chat transcript and the editor — plus the compact
 * footer status text. Pure functions over the task list so they can be
 * re-invoked on every store notification; nothing here is terminal-stateful.
 *
 * Desktop hosts do NOT use these: they subscribe to the store via
 * `subscribeToTasks` and render natively. These helpers are TUI-only
 * formatting layered on top of the shared data model.
 */

import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { STATUS_ICONS } from "./component.ts";
import type { Task } from "./store.ts";

/** Mirrors InteractiveMode.MAX_WIDGET_LINES — the widget slot's height cap. */
const MAX_WIDGET_LINES = 10;

function countByStatus(tasks: Task[]): Record<Task["status"], number> {
	return {
		pending: tasks.filter((t) => t.status === "pending").length,
		in_progress: tasks.filter((t) => t.status === "in_progress").length,
		completed: tasks.filter((t) => t.status === "completed").length,
	};
}

/** Compact "✓2 ◐1 ○3" counter for the footer status row; undefined with no open tasks. */
export function tasksStatusText(tasks: Task[], theme: Theme): string | undefined {
	if (!tasks.some((t) => t.status !== "completed")) return undefined;
	const counts = countByStatus(tasks);
	return [
		theme.fg("success", `✓${counts.completed}`),
		theme.fg("warning", `◐${counts.in_progress}`),
		theme.fg("dim", `○${counts.pending}`),
	].join(" ");
}

/**
 * Widget lines for the pinned task strip: a header with the status counter,
 * then one line per task (icon + id + subject, activeForm while in progress,
 * completed dimmed). Returns undefined when there is nothing left to do — an
 * empty list or one where every task is completed — so the caller disposes
 * the widget entirely. Truncates to MAX_WIDGET_LINES with an "… N more"
 * line; the /tasks overlay remains the full interactive view.
 */
export function renderTasksWidgetLines(tasks: Task[], theme: Theme): string[] | undefined {
	if (!tasks.some((t) => t.status !== "completed")) return undefined;

	const header = `${theme.fg("accent", theme.bold("Tasks"))}  ${tasksStatusText(tasks, theme)}`;
	const lines = [header];

	for (const task of tasks) {
		const status = STATUS_ICONS[task.status];
		const icon = theme.fg(status.color, status.icon);
		const id = theme.fg("accent", `#${task.id}`);
		const label = task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
		const text = task.status === "completed" ? theme.fg("dim", label) : theme.fg("text", label);
		let line = `${icon} ${id} ${text}`;
		if (task.owner) line += theme.fg("muted", ` (${task.owner})`);
		if (task.blockedBy.length > 0) {
			line += theme.fg("warning", ` [blocked by ${task.blockedBy.map((b) => `#${b}`).join(", ")}]`);
		}
		lines.push(line);
	}

	if (lines.length > MAX_WIDGET_LINES) {
		const hidden = lines.length - (MAX_WIDGET_LINES - 1);
		return [...lines.slice(0, MAX_WIDGET_LINES - 1), theme.fg("dim", `… ${hidden} more — /tasks for the full list`)];
	}
	return lines;
}
