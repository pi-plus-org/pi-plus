/**
 * Tests for the plan review dialog (PlanViewComponent): the plan is rendered
 * as markdown (headings/bold stripped of their source syntax), review mode
 * offers the canonical PLAN_REVIEW_CHOICES (approve-with-mode / edit / stay)
 * via arrows, digits, and enter, and both modes scroll long plans with
 * pageUp/pageDown.
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it } from "vitest";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { type PlanReviewDialogChoice, PlanViewComponent } from "../../src/extensions/plan/component.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function renderPlain(component: PlanViewComponent, width = 100): string[] {
	return component.render(width).map(stripAnsi);
}

function makeComponent(
	mode: "review" | "view",
	plan: string,
	onDone: (choice: PlanReviewDialogChoice | undefined) => void = () => {},
	bodyHeight = 50,
): PlanViewComponent {
	return new PlanViewComponent({ plan, theme, mode, bodyHeight, onDone });
}

beforeAll(() => {
	initTheme("dark");
});

describe("PlanViewComponent rendering", () => {
	it("renders the plan markdown without raw syntax and shows all four choices", () => {
		const component = makeComponent("review", "## Step one\n\nDo the **first** thing.");
		const lines = renderPlain(component);
		const text = lines.join("\n");

		assert.ok(text.includes("Plan ready for review"));
		assert.ok(!text.includes("## Step one"), "heading markers must not appear raw");
		assert.ok(text.includes("Step one"));
		assert.ok(!text.includes("**first**"), "bold markers must not appear raw");
		assert.ok(text.includes("first"));
		assert.ok(text.includes("Approve & auto-accept edits"));
		assert.ok(text.includes("Approve & bypass permissions"));
		assert.ok(text.includes("Edit plan"));
		assert.ok(text.includes("Stay in plan mode"));
	});

	it("view mode renders the plan without the choices and with a close hint", () => {
		const component = makeComponent("view", "Some plan");
		const text = renderPlain(component).join("\n");

		assert.ok(!text.includes("Approve & auto-accept edits"));
		assert.ok(text.includes("esc close"));
	});
});

describe("PlanViewComponent review choices", () => {
	it("enter confirms the default (Approve & auto-accept edits) choice", () => {
		const seen: Array<PlanReviewDialogChoice | undefined> = [];
		const component = makeComponent("review", "Plan body", (choice) => seen.push(choice));
		component.handleInput("\r");
		assert.deepEqual(seen, ["approveAcceptEdits"]);
	});

	it("arrow keys move the selection and enter confirms it", () => {
		const seen: Array<PlanReviewDialogChoice | undefined> = [];
		const component = makeComponent("review", "Plan body", (choice) => seen.push(choice));
		component.handleInput("\x1b[B"); // down → Approve & bypass permissions
		component.handleInput("\x1b[B"); // down → Edit plan
		component.handleInput("\r");
		assert.deepEqual(seen, ["edit"]);
	});

	it("digit keys pick a choice directly", () => {
		const seen: Array<PlanReviewDialogChoice | undefined> = [];
		const component = makeComponent("review", "Plan body", (choice) => seen.push(choice));
		component.handleInput("4");
		assert.deepEqual(seen, ["stay"]);
	});

	it("escape stays in plan mode (dialog cancelled)", () => {
		const seen: Array<PlanReviewDialogChoice | undefined> = [];
		const component = makeComponent("review", "Plan body", (choice) => seen.push(choice));
		component.handleInput("\x1b");
		assert.deepEqual(seen, ["stay"]);
	});
});

describe("PlanViewComponent scrolling", () => {
	const longPlan = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");

	it("clips the body to bodyHeight and scrolls with pageDown/pageUp", () => {
		const component = makeComponent("view", longPlan, () => {}, 10);
		let lines = renderPlain(component);
		const bodyIndex = 2; // after the header bar and the blank line
		assert.ok(lines[bodyIndex + 9].includes("line 10"), `expected line 10, got: ${lines[bodyIndex + 9]}`);
		assert.ok(!lines.slice(bodyIndex, bodyIndex + 10).some((l) => l.includes("line 11")));

		component.handleInput("\x1b[6~"); // pageDown
		lines = renderPlain(component);
		assert.ok(lines[bodyIndex].includes("line 10"), `expected scroll to line 10, got: ${lines[bodyIndex]}`);
		assert.ok(lines[bodyIndex + 9].includes("line 19"));

		component.handleInput("\x1b[5~"); // pageUp
		lines = renderPlain(component);
		assert.ok(lines[bodyIndex].includes("line 1"));
	});

	it("view mode scrolls line-by-line with up/down", () => {
		const component = makeComponent("view", longPlan, () => {}, 10);
		component.handleInput("\x1b[B"); // down
		const lines = renderPlain(component);
		assert.ok(lines[2].includes("line 2"));
	});

	it("clamps the scroll offset at the end of the plan", () => {
		const component = makeComponent("view", longPlan, () => {}, 10);
		for (let i = 0; i < 10; i++) component.handleInput("\x1b[6~"); // pageDown far past the end
		const lines = renderPlain(component);
		// 60 lines with a 10-line viewport: the max offset is 50 → "line 51".
		assert.ok(lines[2].includes("line 51"), `expected clamped scroll at line 51, got: ${lines[2]}`);
		assert.ok(lines[11].includes("line 60"), "last body line must be the final plan line");
	});
});
