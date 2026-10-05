/**
 * Tests for the plus footer wrapper: the current permission mode is rendered
 * right-aligned on the cwd line (next to the pwd/branch text), reading the
 * shared holder from the permissions extension.
 */

import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, it } from "vitest";
import type { AgentSession } from "../../../coding-agent/src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../coding-agent/src/core/footer-data-provider.ts";
import { initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { FooterComponent } from "../../src/coding-agent/modes/interactive/components/footer.ts";
import type { PermissionMode } from "../../src/extensions/permissions/index.ts";
import { sharedPermissionState } from "../../src/extensions/permissions/index.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function createSession(): AgentSession {
	return {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: false },
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [],
			getEntryCount: () => 0,
			getSessionId: () => "test-session",
			getLeafId: () => null,
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	} as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	} as unknown as ReadonlyFooterDataProvider;
}

function renderCwdLine(mode: PermissionMode, width = 80): string {
	sharedPermissionState.mode = mode;
	const footer = new FooterComponent(createSession(), createFooterData());
	return footer.render(width)[0];
}

beforeEach(() => {
	initTheme("dark");
});

describe("footer permission indicator", () => {
	it("right-aligns the mode with its icon on the cwd line", () => {
		const expected: Record<PermissionMode, string> = {
			bypass: "✈️ bypass",
			acceptEdits: "✏️ accept-edits",
			plan: "⏸ plan",
		};
		for (const [mode, label] of Object.entries(expected) as [PermissionMode, string][]) {
			const line = renderCwdLine(mode);
			assert.equal(visibleWidth(line), 80, `${mode} line must fill the width`);
			assert.ok(
				stripAnsi(line).endsWith(` ${label}`) || stripAnsi(line).endsWith(label),
				`${mode} line must end with "${label}", got: ${stripAnsi(line)}`,
			);
			assert.ok(stripAnsi(line).startsWith("/tmp/project"), "cwd text stays on the left");
		}
	});

	it("tracks sharedPermissionState changes without rebuilding the footer", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		sharedPermissionState.mode = "bypass";
		assert.ok(stripAnsi(footer.render(80)[0]).includes("✈️ bypass"));
		sharedPermissionState.mode = "plan";
		assert.ok(stripAnsi(footer.render(80)[0]).includes("⏸ plan"));
	});

	it("omits the indicator when the cwd line already fills the width", () => {
		const line = renderCwdLine("bypass", 10);
		assert.equal(visibleWidth(line), 10);
		assert.ok(!stripAnsi(line).includes("bypass"));
	});
});
