/**
 * Tests for plus/src/extensions/context-guard/index.ts — message-count force
 * trigger, relevance pruning at turn_end, and the resume compact suggestion.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";
import type { ProjectedSessionEntry, SessionEntry } from "../../../coding-agent/src/core/session-manager.ts";
import { resetAutoCompactBreaker, setCurrentModel } from "../../src/context/detection.ts";
import { TIME_BASED_MC_CLEARED_MESSAGE } from "../../src/context/microcompact.ts";
import { registerContextGuard } from "../../src/extensions/context-guard/index.ts";

const NOW = 1_700_000_000_000;

// Isolate the piPlus store on an empty temp agent dir: getAutoCompactThreshold
// reads the persisted cap/percent from settings.json there, so a real
// ~/.pi/agent (e.g. contextWindowCapTokens) can never skew the expected math —
// same setup as test/context/detection.test.ts.
let settingsDir: string;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const savedBaseAgentDir = process.env.PI_PLUS_BASE_AGENT_DIR;

// Large window so the CC floor does not dominate; PI_AUTOCOMPACT_PCT_OVERRIDE=1
// pins the threshold at 1% of the effective window (1918 tokens):
// reserve = min(8192, 20k) = 8192; effective = 191808; threshold = 1918.
const MODEL = { contextWindow: 200_000, maxTokens: 8_192 } as Model<never>;

function userMessage(text: string, timestamp = NOW): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function assistantMessage(text: string, timestamp = NOW): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "planning" },
			{ type: "text", text },
		],
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

function toolResultMessage(text: string, timestamp = NOW): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	} as AgentMessage;
}

function entry(id: string, messages: AgentMessage[]): ProjectedSessionEntry {
	const sourceEntry = {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(timestampOf(messages)).toISOString(),
	} as SessionEntry;
	(sourceEntry as { message?: AgentMessage }).message = messages[0];
	return { sourceEntry, messages };
}

function timestampOf(messages: AgentMessage[]): number {
	return messages.reduce((max, m) => Math.max(max, m.timestamp), NOW);
}

interface FakeCtx {
	mode: string;
	hasUI: boolean;
	projection: ProjectedSessionEntry[];
	usage: ContextUsage | undefined;
	compactCalls: number;
	confirmCalls: { title: string; message: string }[];
	confirmAnswer: boolean;
}

function fakeCtx(overrides: Partial<FakeCtx> = {}): { ctx: ExtensionContext; fake: FakeCtx } {
	const fake: FakeCtx = {
		mode: "tui",
		hasUI: true,
		projection: [],
		usage: undefined,
		compactCalls: 0,
		confirmCalls: [],
		confirmAnswer: true,
		...overrides,
	};
	const ctx = {
		mode: fake.mode,
		hasUI: fake.hasUI,
		model: MODEL,
		sessionManager: {
			buildSessionProjection: () => ({
				entries: fake.projection,
				messages: fake.projection.flatMap((e) => e.messages),
			}),
			getBranch: () => fake.projection.map((p) => p.sourceEntry),
		},
		getContextUsage: () => fake.usage,
		compact: () => {
			fake.compactCalls++;
		},
		ui: {
			confirm: async (title: string, message: string) => {
				fake.confirmCalls.push({ title, message });
				return fake.confirmAnswer;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, fake };
}

type TurnEndResult = { entries?: { type: string; targetId: string; replacement: unknown }[] } | undefined;

function captureGuard() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const pi = { on: (event: string, handler: never) => handlers.set(event, handler) } as unknown as ExtensionAPI;
	registerContextGuard(pi);
	const turnEnd = (event: never, ctx: ExtensionContext): TurnEndResult =>
		handlers.get("turn_end")?.(event, ctx) as TurnEndResult;
	const messageEnd = (event: never, ctx: ExtensionContext): TurnEndResult =>
		handlers.get("message_end")?.(event, ctx) as TurnEndResult;
	const dispatch = (event: string): void => {
		handlers.get(event)?.({ type: event } as never, {} as ExtensionContext);
	};
	const sessionStart = (event: never, ctx: ExtensionContext): Promise<unknown> =>
		Promise.resolve(handlers.get("session_start")?.(event, ctx));
	return {
		turnEnd,
		messageEnd,
		agentStart: () => dispatch("agent_start"),
		agentSettled: () => dispatch("agent_settled"),
		sessionStart,
	};
}

beforeEach(() => {
	resetAutoCompactBreaker();
	setCurrentModel(MODEL);
	process.env.PI_AUTOCOMPACT_PCT_OVERRIDE = "1"; // threshold = 1% of 191808 = 1918
	settingsDir = mkdtempSync(join(tmpdir(), "plus-context-guard-"));
	process.env.PI_CODING_AGENT_DIR = settingsDir;
	delete process.env.PI_PLUS_BASE_AGENT_DIR;
});

afterEach(() => {
	resetAutoCompactBreaker();
	setCurrentModel(undefined);
	delete process.env.PI_AUTOCOMPACT_PCT_OVERRIDE;
	delete process.env.PI_MAX_ACTIVE_MESSAGES;
	delete process.env.PI_DISABLE_AUTO_COMPACT;
	delete process.env.PI_DISABLE_COMPACT;
	delete process.env.PI_PRUNE_TAIL_TURNS;
	delete process.env.PI_MICROCOMPACT_PRESSURE_PCT;
	delete process.env.PI_MICROCOMPACT_KEEP_RECENT;
	rmSync(settingsDir, { recursive: true, force: true });
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	if (savedBaseAgentDir === undefined) delete process.env.PI_PLUS_BASE_AGENT_DIR;
	else process.env.PI_PLUS_BASE_AGENT_DIR = savedBaseAgentDir;
});

describe("turn_end: message-count force trigger", () => {
	it("forces compaction when the active message count exceeds the cap", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
			entry("e4", [userMessage("four")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 1);
	});

	it("does not force compaction at or under the cap and skips pruning below threshold", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "10";
		const projection = [entry("e1", [userMessage("tiny")])];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);
		assert.equal(result, undefined);
	});

	it("is disabled by PI_MAX_ACTIVE_MESSAGES=0 and honors PI_DISABLE_COMPACT", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "0";
		const projection = [entry("e1", [userMessage("one")]), entry("e2", [userMessage("two")])];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);

		process.env.PI_MAX_ACTIVE_MESSAGES = "1";
		process.env.PI_DISABLE_COMPACT = "1";
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 0);
	});
});

describe("turn_end: relevance pruning", () => {
	function bigProjection(): ProjectedSessionEntry[] {
		const big = "x".repeat(8000); // ~2000 tokens, over the 1918 threshold
		return [
			entry("old", [userMessage(big, NOW - 60_000), userMessage("old follow-up", NOW - 59_000)]),
			entry("recent", [userMessage("latest question"), userMessage("latest follow-up")]),
		];
	}

	it("returns context_edit omission drafts when over the threshold", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		const { ctx } = fakeCtx({ projection: bigProjection() });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "old", replacement: null }]);
	});

	it("does not prune when auto-compact is disabled", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		const { ctx } = fakeCtx({ projection: bigProjection() });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});

	it("does not prune when the projection is under the threshold", () => {
		const { ctx } = fakeCtx({ projection: [entry("e1", [userMessage("tiny")])] });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});
});

describe("turn_end: pressure micro-compact", () => {
	// Threshold is 1918 tokens (PI_AUTOCOMPACT_PCT_OVERRIDE=1); pressure default
	// 60% fires at 1150. ~2000 chars per cleared-marker-free bash result.
	function bigToolResult(id: string, toolName = "bash", chars = 2000): ProjectedSessionEntry {
		const text = "z".repeat(chars);
		return entry(id, [
			{
				role: "toolResult",
				toolCallId: `call-${id}`,
				toolName,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: NOW,
			} as unknown as AgentMessage,
		]);
	}

	it("clears stale tool results between the pressure percent and the full threshold", () => {
		process.env.PI_MICROCOMPACT_KEEP_RECENT = "1";
		// 3 x 2000 chars ≈ 1500 tokens: above 60% pressure, below the 1918 threshold.
		const projection = [bigToolResult("t1"), bigToolResult("t2"), bigToolResult("t3")];
		const { ctx, fake } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [
			{
				type: "context_edit",
				targetId: "t1",
				replacement: { content: [{ type: "text", text: TIME_BASED_MC_CLEARED_MESSAGE }] },
			},
			{
				type: "context_edit",
				targetId: "t2",
				replacement: { content: [{ type: "text", text: TIME_BASED_MC_CLEARED_MESSAGE }] },
			},
		]);
		assert.equal(fake.compactCalls, 0);
	});

	it("runs before pruning when both would fire on the same turn", () => {
		process.env.PI_MICROCOMPACT_KEEP_RECENT = "1";
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		// 3 x 2000 chars over one ~2000-token text entry: projection passes the
		// full threshold, but pressure claims the turn (clear drafts, no prune null-drafts).
		const projection = [
			entry("oldtext", [userMessage("x".repeat(8000), NOW - 60_000)]),
			bigToolResult("t1"),
			bigToolResult("t2"),
			bigToolResult("t3"),
		];
		const { ctx } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(result?.entries?.length, 2);
		for (const draft of result?.entries ?? []) {
			assert.equal(draft.type, "context_edit");
			assert.notEqual(draft.replacement, null);
		}
		assert.deepEqual(
			result?.entries?.map((e) => e.targetId),
			["t1", "t2"],
		);
	});

	it("does not re-clear marker-carrying results and leaves protected results alone", () => {
		// The projection sits over the full threshold so pressure definitely
		// evaluates, but every candidate is already cleared (marker content) or
		// protected (ask_user is not compactable), so it emits nothing — and
		// pruning protects tool entries too, so the turn is a no-op.
		const cleared = entry("t1", [
			toolResultMessage(TIME_BASED_MC_CLEARED_MESSAGE, NOW - 3 * 60 * 60 * 1000) as AgentMessage,
		]);
		const projection = [cleared, bigToolResult("ask", "ask_user", 8000)];
		const { ctx } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});

	it("PI_MICROCOMPACT_PRESSURE_PCT=0 disables the stage so pruning still fires", () => {
		process.env.PI_MICROCOMPACT_PRESSURE_PCT = "0";
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		const projection = [
			entry("oldtext", [userMessage("x".repeat(8000), NOW - 60_000)]),
			bigToolResult("t1"),
			bigToolResult("t2"),
			entry("recent", [userMessage("latest question")]),
		];
		const { ctx } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "oldtext", replacement: null }]);
	});

	it("does nothing below the pressure percent", () => {
		const projection = [entry("e1", [toolResultMessage("small output")])];
		const { ctx } = fakeCtx({ projection });
		const { turnEnd } = captureGuard();
		assert.equal(turnEnd({ type: "turn_end" } as never, ctx), undefined);
	});
});

describe("message_end: per-message detection (thinking, tool use, response)", () => {
	it("forces compaction at the tool result, before turn_end, and fires only once per run", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd, turnEnd } = captureGuard();

		// Still under the cap: the projection has 3 active messages and this is the 4th…
		// limit=3, active becomes 4 > 3 -> force trigger fires mid-run.
		messageEnd({ type: "message_end", message: toolResultMessage("fourth result") } as never, ctx);
		assert.equal(fake.compactCalls, 1);

		// Run-scoped guard: later tool results of the still-draining batch do not re-fire.
		messageEnd({ type: "message_end", message: toolResultMessage("fifth result") } as never, ctx);
		assert.equal(fake.compactCalls, 1);

		// The interrupted run's turn_end does not request compaction again either.
		turnEnd({ type: "turn_end" } as never, ctx);
		assert.equal(fake.compactCalls, 1);
	});

	it("resets the run guard on agent_start and agent_settled", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd, agentStart, agentSettled } = captureGuard();

		messageEnd({ type: "message_end", message: toolResultMessage("fourth") } as never, ctx);
		assert.equal(fake.compactCalls, 1);

		messageEnd({ type: "message_end", message: toolResultMessage("fifth") } as never, ctx);
		assert.equal(fake.compactCalls, 1);

		agentStart();
		messageEnd({ type: "message_end", message: toolResultMessage("sixth") } as never, ctx);
		assert.equal(fake.compactCalls, 2);

		agentSettled();
		messageEnd({ type: "message_end", message: toolResultMessage("seventh") } as never, ctx);
		assert.equal(fake.compactCalls, 3);
	});

	it("detects assistant (thinking/response) and user messages too", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd } = captureGuard();

		// An assistant message ending over the cap forces compaction immediately.
		messageEnd({ type: "message_end", message: assistantMessage("reply") } as never, ctx);
		assert.equal(fake.compactCalls, 1);

		// Run-scoped guard: later messages of the same run — user prompts and
		// assistant replies alike — are still detected but do not re-fire.
		messageEnd({ type: "message_end", message: userMessage("four") } as never, ctx);
		messageEnd({ type: "message_end", message: assistantMessage("reply two") } as never, ctx);
		assert.equal(fake.compactCalls, 1);
	});

	it("respects PI_DISABLE_COMPACT", () => {
		process.env.PI_MAX_ACTIVE_MESSAGES = "3";
		process.env.PI_DISABLE_COMPACT = "1";
		const projection = [
			entry("e1", [userMessage("one")]),
			entry("e2", [userMessage("two")]),
			entry("e3", [userMessage("three")]),
			entry("e4", [userMessage("four")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd } = captureGuard();

		messageEnd({ type: "message_end", message: userMessage("five") } as never, ctx);
		messageEnd({ type: "message_end", message: toolResultMessage("five") } as never, ctx);
		assert.equal(fake.compactCalls, 0);
	});

	it("detects the threshold at a tool result and emits prune drafts at turn_end", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		const big = "x".repeat(8000); // ~2000 tokens, over the 1918 threshold
		const projection = [
			entry("old", [userMessage(big, NOW - 60_000), userMessage("old follow-up", NOW - 59_000)]),
			entry("recent", [userMessage("latest question")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd, turnEnd } = captureGuard();

		// Per-message detection cannot return boundary drafts: it compacts nothing.
		const midRun = messageEnd({ type: "message_end", message: toolResultMessage("tool output") } as never, ctx);
		assert.equal(midRun, undefined);
		assert.equal(fake.compactCalls, 0);

		// The turn boundary then emits the prune drafts as before.
		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "old", replacement: null }]);
	});

	it("detects the threshold at an assistant message (thinking/response) and marks the turn", () => {
		process.env.PI_PRUNE_TAIL_TURNS = "1";
		const big = "x".repeat(8000); // ~2000 tokens, over the 1918 threshold
		const projection = [
			entry("old", [userMessage(big, NOW - 60_000), userMessage("old follow-up", NOW - 59_000)]),
			entry("recent", [userMessage("latest question")]),
		];
		const { ctx, fake } = fakeCtx({ projection });
		const { messageEnd, turnEnd } = captureGuard();

		const midRun = messageEnd({ type: "message_end", message: assistantMessage("reply") } as never, ctx);
		assert.equal(midRun, undefined);
		assert.equal(fake.compactCalls, 0);

		const result = turnEnd({ type: "turn_end" } as never, ctx);
		assert.deepEqual(result?.entries, [{ type: "context_edit", targetId: "old", replacement: null }]);
	});
});

describe("session_start: resume compact suggestion", () => {
	function resumedUsage(tokens: number, percent = Math.round((tokens / 200_000) * 100)): ContextUsage {
		return { tokens, contextWindow: 200_000, percent };
	}

	it("prompts and compacts when a resumed session is at/above 70% of the threshold", async () => {
		// threshold=1918, 70% = 1343; 1500 tokens prompts.
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500, 75) });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "resume" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 1);
		assert.match(fake.confirmCalls[0].title, /75% full/);
		// The compaction is deferred one macrotask so the TUI's compaction_start
		// subscription is in place: not fired when the handler returns, fired
		// after a timer tick.
		assert.equal(fake.compactCalls, 0);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fake.compactCalls, 1);
	});

	it("declines to compact when the user answers no", async () => {
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500), confirmAnswer: false });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "fork" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 1);
		assert.equal(fake.compactCalls, 0);
	});

	it("does not prompt below 70% of the threshold, for fresh sessions, or outside the TUI", async () => {
		const projection = [entry("e1", [userMessage("prior content")])];
		const { sessionStart } = captureGuard();

		// 1000 < 1343: under the resume floor.
		const below = fakeCtx({ projection, usage: resumedUsage(1000) });
		await sessionStart({ type: "session_start", reason: "resume" } as never, below.ctx);
		assert.equal(below.fake.confirmCalls.length, 0);

		// Fresh session with the same usage.
		const fresh = fakeCtx({ projection: [], usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "new" } as never, fresh.ctx);
		assert.equal(fresh.fake.confirmCalls.length, 0);

		// CLI -r reports "startup"; only an empty branch means fresh.
		const startupEmpty = fakeCtx({ projection: [], usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "startup" } as never, startupEmpty.ctx);
		assert.equal(startupEmpty.fake.confirmCalls.length, 0);

		// Startup with prior content (CLI -r) prompts…
		const startupResumed = fakeCtx({ projection, usage: resumedUsage(1500) });
		await sessionStart({ type: "session_start", reason: "startup" } as never, startupResumed.ctx);
		assert.equal(startupResumed.fake.confirmCalls.length, 1);

		// …but not in print mode.
		const printMode = fakeCtx({ projection, usage: resumedUsage(1500) });
		printMode.ctx.mode = "print";
		await sessionStart({ type: "session_start", reason: "resume" } as never, printMode.ctx);
		assert.equal(printMode.fake.confirmCalls.length, 0);
	});

	it("does not prompt when auto-compact is disabled", async () => {
		process.env.PI_DISABLE_AUTO_COMPACT = "1";
		const projection = [entry("e1", [userMessage("prior content")])];
		const { ctx, fake } = fakeCtx({ projection, usage: resumedUsage(1500) });
		const { sessionStart } = captureGuard();
		await sessionStart({ type: "session_start", reason: "resume" } as never, ctx);
		assert.equal(fake.confirmCalls.length, 0);
		assert.equal(fake.compactCalls, 0);
	});
});
