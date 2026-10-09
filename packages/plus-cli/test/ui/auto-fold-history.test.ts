/**
 * Tests for plus-cli/src/coding-agent/ui/auto-fold-history.ts — thinking
 * blocks and tool rows fold at prompt boundaries (addMessageToChat patch)
 * and roll forward mid-run (handleEvent patch: each new assistant message
 * folds the completed steps before it). Live components excluded, ctrl+o
 * field sync, env/verbose gating.
 */

import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { afterEach, describe, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../../coding-agent/src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../../coding-agent/src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../coding-agent/src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { foldChatHistory, isAutoFoldHistoryEnabled } from "../../src/coding-agent/ui/auto-fold-history.ts";

initTheme("dark");

function fakeUi(): TUI {
	return { requestRender() {} } as unknown as TUI;
}

function renderText(component: Component): string {
	return stripTerminalSequences(component.render(80).join("\n"));
}

function thinkingMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "SECRETREASONING that should fold away" },
			{ type: "text", text: "visible answer" },
		],
		stopReason: "stop",
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function toolRow(expanded: boolean): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		"tc1",
		{ command: "echo hi" },
		{ showImages: false, imageWidthCells: 1, outputPad: 1 },
		// Minimal definition with no result renderer: the fallback preview
		// (10 lines + "more lines" hint) is what the expanded flag controls.
		{ renderCall: () => new Text("TOOL-CALL", 0, 0) } as unknown as ConstructorParameters<
			typeof ToolExecutionComponent
		>[4],
		fakeUi(),
		"/tmp",
	);
	component.updateResult({
		content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `TOOL-LINE-${i}`).join("\n") }],
		isError: false,
	});
	component.setExpanded(expanded);
	return component;
}

describe("foldChatHistory", () => {
	it("folds thinking and tool rows, leaves live components and plain children alone", () => {
		const history = new AssistantMessageComponent(thinkingMessage());
		const historyTool = toolRow(true);
		const live = new AssistantMessageComponent(thinkingMessage());
		const liveTool = toolRow(true);
		const spacer = new Text("", 0, 0);

		const container = new Container();
		container.addChild(history);
		container.addChild(historyTool);
		container.addChild(live);
		container.addChild(liveTool);
		container.addChild(spacer);

		const folded = foldChatHistory(container.children, [live, liveTool]);
		assert.equal(folded, 2, "history assistant + history tool folded");

		const historyText = renderText(history);
		assert.ok(historyText.includes("Thinking..."), "folded thinking shows the hidden label");
		assert.ok(!historyText.includes("SECRETREASONING"), "folded thinking body is gone");
		assert.ok(historyText.includes("visible answer"), "assistant text stays visible");

		const historyToolText = renderText(historyTool);
		assert.ok(historyToolText.includes("TOOL-LINE-1"), "collapsed tool keeps its preview");
		assert.ok(!historyToolText.includes("TOOL-LINE-25"), "collapsed tool hides deep output");

		assert.ok(renderText(live).includes("SECRETREASONING"), "excluded live thinking stays open");
		assert.ok(renderText(liveTool).includes("TOOL-LINE-25"), "excluded live tool stays expanded");
	});

	it("folds everything when no exclusion set is passed", () => {
		const assistant = new AssistantMessageComponent(thinkingMessage());
		const tool = toolRow(true);
		const container = new Container();
		container.addChild(assistant);
		container.addChild(tool);

		assert.equal(foldChatHistory(container.children), 2);
		assert.ok(renderText(assistant).includes("Thinking..."));
		assert.ok(!renderText(tool).includes("TOOL-LINE-25"));
	});
});

describe("isAutoFoldHistoryEnabled", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("is enabled by default and for arbitrary values", () => {
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", undefined);
		assert.equal(isAutoFoldHistoryEnabled(), true);
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "");
		assert.equal(isAutoFoldHistoryEnabled(), true);
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "1");
		assert.equal(isAutoFoldHistoryEnabled(), true);
	});

	it("is disabled by 0/false", () => {
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "0");
		assert.equal(isAutoFoldHistoryEnabled(), false);
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "false");
		assert.equal(isAutoFoldHistoryEnabled(), false);
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "FALSE");
		assert.equal(isAutoFoldHistoryEnabled(), false);
	});
});

interface PatchedHost {
	chatContainer: Container;
	streamingComponent?: unknown;
	pendingTools: Map<string, unknown>;
	options: { verbose?: boolean };
	toolOutputExpanded: boolean;
	getUserMessageText(): string;
	getMarkdownThemeWithSettings(): ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers(): [];
	outputPad: number;
}

function patchedAddMessageToChat(): (host: PatchedHost, message: { role: string }) => void {
	const method = (InteractiveMode.prototype as unknown as Record<string, unknown>).addMessageToChat as (
		this: unknown,
		message: { role: string },
		options?: { populateHistory?: boolean },
	) => void;
	return (host, message) => method.call(host, message);
}

function createHost(overrides: Partial<PatchedHost> = {}): PatchedHost & {
	assistant: AssistantMessageComponent;
	tool: ToolExecutionComponent;
} {
	const assistant = new AssistantMessageComponent(thinkingMessage());
	const tool = toolRow(true);
	const chatContainer = new Container();
	chatContainer.addChild(assistant);
	chatContainer.addChild(tool);
	return {
		assistant,
		tool,
		chatContainer,
		streamingComponent: undefined,
		pendingTools: new Map(),
		options: {},
		toolOutputExpanded: true,
		getUserMessageText: () => "hello world",
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		outputPad: 1,
		...overrides,
	};
}

describe("addMessageToChat auto-fold patch", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("folds previous turns on a user message, appends the prompt, syncs the expand flag", () => {
		const host = createHost();
		patchedAddMessageToChat()(host, { role: "user" });

		assert.equal(host.chatContainer.children.length, 4, "spacer + user message component were appended");
		assert.ok(renderText(host.assistant).includes("Thinking..."), "history thinking folded");
		assert.ok(!renderText(host.tool).includes("TOOL-LINE-25"), "history tool folded");
		assert.equal(host.toolOutputExpanded, false, "global expand flag synced to visible state");
	});

	it("excludes the streaming component and in-flight tools from the fold", () => {
		const streaming = new AssistantMessageComponent(thinkingMessage());
		const liveTool = toolRow(true);
		const host = createHost({ streamingComponent: streaming, pendingTools: new Map([["t", liveTool]]) });
		host.chatContainer.addChild(streaming);
		host.chatContainer.addChild(liveTool);
		patchedAddMessageToChat()(host, { role: "user" });

		assert.ok(renderText(host.assistant).includes("Thinking..."), "completed turn folded");
		assert.ok(renderText(streaming).includes("SECRETREASONING"), "streaming assistant untouched");
		assert.ok(renderText(liveTool).includes("TOOL-LINE-25"), "in-flight tool stays expanded");
	});

	it("does not fold for non-user messages", () => {
		const host = createHost();
		patchedAddMessageToChat()(host, { role: "system" });

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "assistant thinking stays as-is");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "expanded tool stays expanded");
		assert.equal(host.toolOutputExpanded, true, "expand flag untouched");
	});

	it("does not fold on verbose startup", () => {
		const host = createHost({ options: { verbose: true } });
		patchedAddMessageToChat()(host, { role: "user" });

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "verbose keeps thinking visible");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "verbose keeps tool expanded");
	});

	it("does not fold when PI_AUTO_FOLD_HISTORY=0", () => {
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "0");
		const host = createHost();
		patchedAddMessageToChat()(host, { role: "user" });

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "env-disabled keeps thinking visible");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "env-disabled keeps tool expanded");
	});
});

interface EventHost extends PatchedHost {
	isInitialized: boolean;
	footer: { invalidate(): void };
	programStatus: { handleEvent(event: unknown): void };
	ui: TUI;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	updatePendingMessagesDisplay(): void;
	streamingMessage?: unknown;
}

interface AgentEventForTest {
	type: string;
	message?: { role?: string; content?: unknown[]; timestamp?: number };
}

function assistantStart(): AgentEventForTest {
	return { type: "message_start", message: { role: "assistant", content: [], timestamp: 0 } };
}

function patchedHandleEvent(): (host: EventHost, event: AgentEventForTest) => Promise<void> {
	const method = (InteractiveMode.prototype as unknown as Record<string, unknown>).handleEvent as (
		this: unknown,
		event: AgentEventForTest,
	) => Promise<void>;
	return (host, event) => method.call(host, event);
}

function createEventHost(overrides: Partial<EventHost> = {}): EventHost & {
	assistant: AssistantMessageComponent;
	tool: ToolExecutionComponent;
} {
	const base = createHost(overrides);
	return {
		...base,
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: { handleEvent() {} },
		ui: fakeUi(),
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		updatePendingMessagesDisplay() {},
		...overrides,
	};
}

describe("handleEvent rolling auto-fold patch", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("folds completed steps when the agent starts the next assistant message", async () => {
		const host = createEventHost();
		await patchedHandleEvent()(host, assistantStart());

		assert.ok(renderText(host.assistant).includes("Thinking..."), "previous step's thinking folded");
		assert.ok(!renderText(host.tool).includes("TOOL-LINE-25"), "previous step's tool folded");
		assert.equal(host.toolOutputExpanded, false, "global expand flag synced to visible state");
		const streaming = host.streamingComponent as AssistantMessageComponent | undefined;
		assert.ok(streaming, "original created the new streaming component");
		assert.equal(host.chatContainer.children.length, 3, "history assistant + history tool + new streaming row");
	});

	it("keeps in-flight tools out of the mid-run fold", async () => {
		const liveTool = toolRow(true);
		const host = createEventHost({ pendingTools: new Map([["t", liveTool]]) });
		host.chatContainer.addChild(liveTool);
		await patchedHandleEvent()(host, assistantStart());

		assert.ok(!renderText(host.tool).includes("TOOL-LINE-25"), "completed tool folded");
		assert.ok(renderText(liveTool).includes("TOOL-LINE-25"), "in-flight tool stays expanded");
	});

	it("does not fold for other events", async () => {
		const host = createEventHost();
		await patchedHandleEvent()(host, { type: "queue_update" });

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "thinking stays open");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "tool stays expanded");
		assert.equal(host.toolOutputExpanded, true, "expand flag untouched");
	});

	it("does not fold on verbose startup", async () => {
		const host = createEventHost({ options: { verbose: true } });
		await patchedHandleEvent()(host, assistantStart());

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "verbose keeps thinking visible");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "verbose keeps tool expanded");
	});

	it("does not fold when PI_AUTO_FOLD_HISTORY=0", async () => {
		vi.stubEnv("PI_AUTO_FOLD_HISTORY", "0");
		const host = createEventHost();
		await patchedHandleEvent()(host, assistantStart());

		assert.ok(renderText(host.assistant).includes("SECRETREASONING"), "env-disabled keeps thinking visible");
		assert.ok(renderText(host.tool).includes("TOOL-LINE-25"), "env-disabled keeps tool expanded");
	});
});
