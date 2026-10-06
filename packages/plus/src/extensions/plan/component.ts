/**
 * TUI surface for plan review (modeled on the TaskListComponent from the
 * tasks extension): ExitPlanMode renders the plan file as markdown with the
 * review choices, and /plan show reuses the same view read-only. The plan
 * body scrolls (pageUp/pageDown, and up/down in view mode) so long plans
 * stay reviewable in a small terminal.
 *
 * The choice set is canonical here and shared by every host: the TUI
 * component, hosts with a dedicated plan-review dialog (pi-plus-desktop —
 * the ids/labels are the contract), and the plain-text select fallback all
 * render PLAN_REVIEW_CHOICES and map picks through the same resolver in
 * plan/index.ts. Approval ALWAYS picks the post-approval permission mode
 * (auto-accept edits or bypass) — there is no mode-less "approve".
 */

import { type Component, type KeyId, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";

export type PlanReviewDialogChoice = "approveAcceptEdits" | "approveBypass" | "stay";

/** Canonical review choices, one row per picker (TUI list, select fallback, host dialogs). */
export const PLAN_REVIEW_CHOICES: ReadonlyArray<{ id: PlanReviewDialogChoice; label: string }> = [
	{ id: "approveAcceptEdits", label: "Approve & auto-accept edits" },
	{ id: "approveBypass", label: "Approve & bypass permissions" },
	{ id: "stay", label: "Stay in plan mode" },
];

export type PlanViewMode = "review" | "view";

export interface PlanViewComponentOptions {
	plan: string;
	theme: Theme;
	mode: PlanViewMode;
	/** Maximum number of body lines to render before scrolling kicks in. */
	bodyHeight: number;
	onDone: (choice: PlanReviewDialogChoice | undefined) => void;
}

export class PlanViewComponent implements Component {
	private plan: string;
	private theme: Theme;
	private mode: PlanViewMode;
	private onDone: (choice: PlanReviewDialogChoice | undefined) => void;
	private markdown: Markdown;
	private bodyHeight: number;
	private scrollOffset = 0;
	private selectedIndex = 0;
	private lastWidth = 80;
	private cachedWidth?: number;
	private cachedBody?: string[];

	constructor(options: PlanViewComponentOptions) {
		this.plan = options.plan;
		this.theme = options.theme;
		this.mode = options.mode;
		this.onDone = options.onDone;
		this.bodyHeight = Math.max(1, options.bodyHeight);
		this.markdown = new Markdown(this.plan.trim(), 1, 0, getMarkdownTheme());
	}

	handleInput(data: string): void {
		if (this.mode === "view") {
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
				this.onDone(undefined);
				return;
			}
			if (matchesKey(data, "up") || data === "k") {
				this.scrollBy(-1);
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				this.scrollBy(1);
				return;
			}
			if (matchesKey(data, "pageUp")) this.scrollBy(-this.pageSize());
			if (matchesKey(data, "pageDown")) this.scrollBy(this.pageSize());
			return;
		}

		// Review mode: escape cancels the approval (stay in plan mode, same as
		// dismissing the old select dialog).
		if (matchesKey(data, "escape")) {
			this.onDone("stay");
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = Math.min(PLAN_REVIEW_CHOICES.length - 1, this.selectedIndex + 1);
			return;
		}
		if (matchesKey(data, "enter")) {
			const choice = PLAN_REVIEW_CHOICES[this.selectedIndex];
			if (choice) this.onDone(choice.id);
			return;
		}
		const direct = PLAN_REVIEW_CHOICES.find((_, index) => matchesKey(data, String(index + 1) as KeyId));
		if (direct) {
			this.onDone(direct.id);
			return;
		}
		if (matchesKey(data, "pageUp")) this.scrollBy(-this.pageSize());
		if (matchesKey(data, "pageDown")) this.scrollBy(this.pageSize());
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const th = this.theme;
		const lines: string[] = [];

		const titlePlain = this.mode === "review" ? " Plan ready for review " : " Plan ";
		const headerLine =
			th.fg("accent", titlePlain) + th.fg("borderMuted", "─".repeat(Math.max(0, width - titlePlain.length)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const body = this.bodyLines(width);
		const window = body.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight);
		for (const line of window) lines.push(truncateToWidth(line, width));
		const overflowAbove = this.scrollOffset > 0;
		const overflowBelow = this.scrollOffset + this.bodyHeight < body.length;
		if (overflowAbove || overflowBelow) {
			lines.push(
				truncateToWidth(
					th.fg(
						"dim",
						`  ${overflowAbove ? "↑ more above · " : ""}${overflowBelow ? "↓ more below · " : ""}pgup/pgdn scroll`,
					),
					width,
				),
			);
		}

		lines.push("");
		if (this.mode === "review") {
			for (let index = 0; index < PLAN_REVIEW_CHOICES.length; index++) {
				const choice = PLAN_REVIEW_CHOICES[index];
				const selected = index === this.selectedIndex;
				const marker = selected ? th.fg("accent", "→") : " ";
				const label = selected ? th.fg("accent", choice.label) : th.fg("text", choice.label);
				lines.push(truncateToWidth(` ${marker} ${th.fg("dim", `${index + 1}.`)} ${label}`, width));
			}
			lines.push("");
			lines.push(
				truncateToWidth(
					th.fg("dim", "↑↓ navigate · enter select · 1-3 choose · pgup/pgdn scroll plan · esc stay in plan mode"),
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(th.fg("dim", "↑↓/pgup/pgdn scroll · esc close"), width));
		}
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedBody = undefined;
		this.markdown.invalidate();
	}

	private bodyLines(width: number): string[] {
		if (this.cachedWidth === width && this.cachedBody) return this.cachedBody;
		this.cachedWidth = width;
		this.cachedBody = this.markdown.render(width);
		return this.cachedBody;
	}

	private pageSize(): number {
		return Math.max(1, this.bodyHeight - 1);
	}

	private scrollBy(delta: number): void {
		const maxOffset = Math.max(0, this.bodyLines(this.lastWidth).length - this.bodyHeight);
		this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
	}
}
