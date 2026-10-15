/**
 * Tests for packages/plus-cli/src/coding-agent/ui/session-selector.ts: the resume
 * list (`pipi --resume` / `pipi -r` and the TUI `/resume`) hides transcripts the
 * plus session-manager overlay marked `interactive: false`, keeps unmarked ones,
 * and applies the same filter to the partial lists the picker renders while a scan
 * is still running. Selection therefore lands on the newest *visible* session.
 */

import assert from "node:assert/strict";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import type { SessionInfo, SessionListProgress } from "../../../plus/src/coding-agent/core/session-manager.ts";
import { SessionSelectorComponent } from "../../src/coding-agent/ui/session-selector.ts";

initTheme("dark");

function makeInfo(id: string, ageMs: number, interactive?: boolean): SessionInfo {
	const stamp = new Date(1700000000000 - ageMs);
	return {
		path: `/tmp/projects/p/${id}.jsonl`,
		id,
		cwd: "/tmp/projects/p",
		name: `NAME-${id}`,
		messageCount: 1,
		created: stamp,
		modified: stamp,
		firstMessage: `FIRST-${id}`,
		allMessagesText: `FIRST-${id}`,
		...(interactive === undefined ? {} : { interactive }),
	};
}

function renderList(selector: SessionSelectorComponent): string {
	return stripTerminalSequences(selector.getSessionList().render(120).join("\n"));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${message}`);
}

const HEADLESS = makeInfo("headless", 0, false);
const INTERACTIVE = makeInfo("interactive", 1000, true);
const UNMARKED = makeInfo("unmarked", 2000);

describe("session-selector wrapper", () => {
	it("hides headless sessions in the loaded list", async () => {
		const selector = new SessionSelectorComponent(
			async () => [HEADLESS, INTERACTIVE, UNMARKED],
			async () => [HEADLESS, INTERACTIVE, UNMARKED],
			() => {},
			() => {},
			() => {},
			() => {},
		);

		await waitFor(() => renderList(selector).includes("NAME-interactive"), "the list to populate");

		const rendered = renderList(selector);
		assert.ok(!rendered.includes("NAME-headless"), "headless session must not be listed");
		assert.ok(rendered.includes("NAME-unmarked"), "unmarked sessions stay visible");
		// Newest visible transcript wins the initial selection, not the headless one.
		assert.equal(selector.getSessionList().getSelectedSessionPath(), INTERACTIVE.path);
	});

	it("hides headless sessions in partial progress lists", async () => {
		let publish: SessionListProgress | undefined;
		let finish: (sessions: SessionInfo[]) => void = () => {};
		const pending = new Promise<SessionInfo[]>((resolve) => {
			finish = resolve;
		});

		const selector = new SessionSelectorComponent(
			(onProgress?: SessionListProgress) => {
				publish = onProgress;
				return pending;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);

		await waitFor(() => publish !== undefined, "the loader to receive a progress callback");
		publish!(1, 3, [HEADLESS]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(!renderList(selector).includes("NAME-headless"), "partial lists are filtered too");
		assert.equal(selector.getSessionList().getSelectedSessionPath(), undefined);

		finish([HEADLESS, INTERACTIVE, UNMARKED]);
		await waitFor(() => renderList(selector).includes("NAME-interactive"), "the final list");
		assert.ok(!renderList(selector).includes("NAME-headless"));
	});

	it("keeps filtering when the list reloads after a scope toggle", async () => {
		const allScope = async () => [HEADLESS, INTERACTIVE];
		const selector = new SessionSelectorComponent(
			async () => [INTERACTIVE],
			allScope,
			() => {},
			() => {},
			() => {},
			() => {},
		);

		await waitFor(() => renderList(selector).includes("NAME-interactive"), "current scope");
		// Tab toggles the scope (SessionList.handleInput), forcing an "all" reload.
		selector.handleInput("\t");
		await waitFor(() => selector.getSessionList().getSelectedSessionPath() === INTERACTIVE.path, "all scope");
		assert.ok(!renderList(selector).includes("NAME-headless"), "headless session stays hidden");
	});
});
