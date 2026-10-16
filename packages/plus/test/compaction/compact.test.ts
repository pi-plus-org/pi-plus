/**
 * Tests for plus/src/compaction/compact.ts — Claude Code-style full-conversation
 * compaction. Uses a fake streamFn (faux provider, no real APIs) injected through
 * pi's existing streamFn seam; upstream completeSummarization calls it directly.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model, TranscriptContext, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { CompactionPreparation } from "../../../coding-agent/src/core/compaction/compaction.ts";
import { compact, generateSummaryWithUsage } from "../../src/compaction/compact.ts";
import { isAutoCompactBreakerTripped, resetAutoCompactBreaker } from "../../src/context/detection.ts";
import { hasNoReasoning } from "../../src/reasoning/effort.ts";

const MODEL = {
	id: "faux-1",
	name: "Faux One",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "http://localhost:1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
} as unknown as Model<any>;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 } as AgentMessage;
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 10, output: 20, total: 30 } as unknown as Usage,
		stopReason,
		timestamp: 1_700_000_000_001,
	};
}

/** Assistant message with a read tool call at the given timestamp (recency source for re-injection). */
function assistantReadCall(path: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${path}`, name: "read", arguments: { path } }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: { input: 10, output: 20, total: 30 } as unknown as Usage,
		stopReason: "toolCall",
		timestamp,
	} as unknown as AssistantMessage;
}

const SUMMARY_TEXT =
	"<analysis>scratchpad</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Do the work.\n</summary>";

interface RecordedCall {
	context: TranscriptContext;
	options: Record<string, unknown>;
}

/** Fake streamFn: replays queued outcomes (message or thrown error) and records calls. */
function fakeStreamFn(outcomes: Array<AssistantMessage | Error>, calls: RecordedCall[]) {
	return (async (_model: Model<any>, context: TranscriptContext, options?: Record<string, unknown>) => {
		calls.push({ context, options: options ?? {} });
		const outcome = outcomes.shift();
		if (!outcome) throw new Error("fake streamFn ran out of queued outcomes");
		if (outcome instanceof Error) throw outcome;
		return { result: async () => outcome } as unknown as ReturnType<StreamFn> extends Promise<infer R> ? R : never;
	}) as unknown as StreamFn;
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "entry-keep-me",
		messagesToSummarize: [
			userMessage("first request"),
			assistantMessage("first reply"),
			userMessage("second request"),
			assistantMessage("second reply"),
		],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 42,
		previousSummary: undefined,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		...overrides,
	};
}

/** Extract the full text of the recorded request for substring assertions. */
function requestText(call: RecordedCall): string {
	return call.context.messages.map((m) => ("content" in m ? contentText(m.content as never, "") : "")).join("\n");
}

beforeEach(() => {
	resetAutoCompactBreaker();
	delete process.env.PI_DISABLE_COMPACT;
});

afterEach(() => {
	delete process.env.PI_DISABLE_COMPACT;
});

describe("compact", () => {
	it("returns the formatted summary, keeps the cut point, and reports usage", async () => {
		const calls: RecordedCall[] = [];
		const result = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(!result.summary.includes("<analysis>"));
		assert.ok(!result.summary.includes("scratchpad"));
		assert.ok(result.summary.startsWith("Summary:"));
		assert.equal(result.firstKeptEntryId, "entry-keep-me");
		assert.equal(result.tokensBefore, 42);
		assert.deepEqual(result.usage, { input: 10, output: 20, total: 30 });
		assert.equal(calls.length, 1);
	});

	it("sends the whole conversation plus the CC compact prompt to the model", async () => {
		const calls: RecordedCall[] = [];
		await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		const prompt = requestText(calls[0]);
		assert.ok(prompt.includes("<conversation>"));
		assert.ok(prompt.includes("first request"));
		assert.ok(prompt.includes("Primary Request and Intent"));
		assert.ok(prompt.includes("Do NOT call any tools"));
	});

	it("appends file-ops trailer and re-injects recently read files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-compact-"));
		const readFile = join(dir, "read.ts");
		writeFileSync(readFile, "export const x = 1;\n");

		const prep = preparation({
			messagesToSummarize: [
				userMessage("first request"),
				assistantReadCall(readFile, 1_700_000_000_002),
				userMessage("second request"),
				assistantMessage("first reply"),
			],
			fileOps: { read: new Set([readFile]), written: new Set([join(dir, "out.ts")]), edited: new Set() },
		});
		const calls: RecordedCall[] = [];
		const result = await compact(
			prep,
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(result.summary.includes("<read-files>"));
		assert.ok(result.summary.includes("<modified-files>"));
		assert.ok(result.summary.includes("Recently Read Files (post-compact context)"));
		assert.ok(result.summary.includes("export const x = 1;"));
		assert.deepEqual(result.details, {
			readFiles: [readFile],
			modifiedFiles: [join(dir, "out.ts")],
			recompaction: {
				isRecompactionInChain: false,
				turnsSincePreviousCompact: 2,
				previousTokensBefore: undefined,
				willRetriggerNextTurn: false,
			},
		});
	});

	it("re-injects the 5 most recently read text files, newest first (CC cap)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-compact-"));
		// 8 text files + a Dockerfile read in ascending timestamp order: only the
		// 5 newest candidates (CC's POST_COMPACT_MAX_FILES_TO_RESTORE) get excerpts.
		const textFiles = Array.from({ length: 8 }, (_, i) => {
			const file = join(dir, `note${i}.ts`);
			writeFileSync(file, `export const note${i} = ${i};\n`);
			return file;
		});
		// Extensionless text re-enters via the NUL-byte sniff; read last (newest).
		const dockerfile = join(dir, "Dockerfile");
		writeFileSync(dockerfile, "FROM node:22\n");
		// Non-whitelisted extension with no NUL bytes: only the extension gate rejects it.
		const blobFile = join(dir, "blob.data");
		writeFileSync(blobFile, Buffer.from([0x01, 0x02, 0x03, 0xff]));
		const imageFile = join(dir, "shot.png");
		writeFileSync(imageFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

		// Read order: note0 .. note7, blob, image, Dockerfile (newest last).
		let ts = 1_700_000_000_000;
		const readMessages = [...textFiles, blobFile, imageFile, dockerfile].map((file) => assistantReadCall(file, ts++));
		const readFiles = [...textFiles, dockerfile, imageFile, blobFile];
		const prep = preparation({
			messagesToSummarize: [userMessage("first request"), ...readMessages, assistantMessage("done")],
			fileOps: { read: new Set(readFiles), written: new Set(), edited: new Set() },
		});
		const calls: RecordedCall[] = [];
		const result = await compact(
			prep,
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		// Slots (newest first, skipped binaries don't consume one):
		// Dockerfile, note7, note6, note5, note4.
		assert.ok(result.summary.includes(`### \`${dockerfile}\``));
		for (const i of [7, 6, 5, 4]) {
			assert.ok(result.summary.includes(`### \`${textFiles[i]}\``), `note${i} should be injected`);
			assert.ok(result.summary.includes(`export const note${i} = ${i};`));
		}
		for (const i of [3, 2, 1, 0]) {
			assert.ok(!result.summary.includes(`### \`${textFiles[i]}\``), `note${i} is past the 5-file cap`);
		}
		// No excerpt appendix for binaries (the <read-files> path list still names them).
		assert.ok(!result.summary.includes(`### \`${imageFile}\``));
		assert.ok(!result.summary.includes(`### \`${blobFile}\``));
		assert.ok(result.summary.includes("<read-files>"));
		assert.deepEqual((result.details as { readFiles: string[] }).readFiles, [...readFiles].sort());
	});

	it("counts nested (codemode) read calls toward re-injection and skips files later modified", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-compact-"));
		const nestedFile = join(dir, "nested.ts");
		writeFileSync(nestedFile, "export const nested = true;\n");
		const directFile = join(dir, "direct.ts");
		writeFileSync(directFile, "export const direct = true;\n");
		const modifiedFile = join(dir, "changed.ts");
		writeFileSync(modifiedFile, "export const changed = 1;\n");

		// A script result records its inner read calls on nestedCalls, like
		// extractFileOpsFromMessage does for fileOps.
		const scriptResult = {
			role: "toolResult",
			toolCallId: "call-script",
			toolName: "bash",
			content: [{ type: "text", text: "ran script" }],
			isError: false,
			timestamp: 1_700_000_000_002,
			nestedCalls: { calls: [{ name: "read", arguments: { path: nestedFile } }] },
		} as unknown as AgentMessage;

		const prep = preparation({
			messagesToSummarize: [
				userMessage("first request"),
				assistantReadCall(directFile, 1_700_000_000_003),
				userMessage("second request"),
				scriptResult,
				assistantReadCall(modifiedFile, 1_700_000_000_004),
				assistantMessage("done"),
			],
			fileOps: {
				read: new Set([nestedFile, directFile, modifiedFile]),
				written: new Set(),
				edited: new Set([modifiedFile]),
			},
		});
		const calls: RecordedCall[] = [];
		const result = await compact(
			prep,
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(result.summary.includes(`### \`${nestedFile}\``));
		assert.ok(result.summary.includes("export const nested = true;"));
		assert.ok(result.summary.includes(`### \`${directFile}\``));
		// Modified files land in the trailer list but never get re-injected.
		assert.ok(!result.summary.includes(`### \`${modifiedFile}\``));
		assert.ok(result.summary.includes("<modified-files>"));
	});

	it("re-injects invoked skills from transcript invocations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plus-compact-"));
		const skillFile = join(dir, "SKILL.md");
		writeFileSync(skillFile, "# Skill body\n\nDo the skill thing.\n");
		const prep = preparation({
			messagesToSummarize: [
				userMessage(`<skill name="test-skill" location="${skillFile}">\nold transcript copy\n</skill>`),
				assistantMessage("used the skill"),
			],
		});
		const calls: RecordedCall[] = [];
		const result = await compact(
			prep,
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);

		assert.ok(result.summary.includes("Active Skills (post-compact context)"));
		assert.ok(result.summary.includes("test-skill"));
		assert.ok(
			result.summary.includes("Do the skill thing."),
			"content is re-read from disk, not the transcript copy",
		);
		assert.ok(!result.summary.includes("old transcript copy"));
	});

	it("re-injects the active plan file when one exists for the session", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "plus-agent-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { planFilePathFor } = await import("../../src/extensions/plan/plan-file.ts");
			const sessionId = "compact-test-session";
			writeFileSync(planFilePathFor(sessionId), "# Plan\n\n1. Ship it.\n");

			const calls: RecordedCall[] = [];
			const result = await compact(
				preparation(),
				MODEL,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
				undefined,
				undefined,
				undefined,
				sessionId,
			);

			assert.ok(result.summary.includes("Current Plan (post-compact context)"));
			assert.ok(result.summary.includes("1. Ship it."));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("omits the plan section when no plan file exists", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "plus-agent-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const calls: RecordedCall[] = [];
			const result = await compact(
				preparation(),
				MODEL,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
				undefined,
				undefined,
				undefined,
				"session-without-plan",
			);
			assert.ok(!result.summary.includes("Current Plan (post-compact context)"));
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	});

	it("records recompaction analytics across compactions of one session", async () => {
		const calls: RecordedCall[] = [];
		const sessionId = "recompact-analytics-session";
		const first = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
			undefined,
			undefined,
			undefined,
			sessionId,
		);
		const second = await compact(
			preparation({ previousSummary: "OLD SUMMARY", tokensBefore: 900 }),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
			undefined,
			undefined,
			undefined,
			sessionId,
		);

		const firstDetails = first.details as { recompaction: Record<string, unknown> };
		const secondDetails = second.details as { recompaction: Record<string, unknown> };
		assert.equal(firstDetails.recompaction.isRecompactionInChain, false);
		assert.equal(firstDetails.recompaction.previousTokensBefore, undefined);
		assert.equal(secondDetails.recompaction.isRecompactionInChain, true);
		assert.equal(secondDetails.recompaction.previousTokensBefore, 42);
		assert.equal(typeof second.estimatedTokensAfter, "number");
	});

	it("emits a stderr analytics line when PI_COMPACT_ANALYTICS is set", async () => {
		process.env.PI_COMPACT_ANALYTICS = "1";
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			const calls: RecordedCall[] = [];
			await compact(
				preparation(),
				MODEL,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
				undefined,
				undefined,
				undefined,
				"analytics-stderr-session",
			);
		} finally {
			console.error = original;
			delete process.env.PI_COMPACT_ANALYTICS;
		}
		const line = errors.find((e) => e.includes("[pi-plus/recompact]"));
		assert.ok(line, "expected a [pi-plus/recompact] stderr line");
		assert.ok(line.includes('"isRecompactionInChain":false'));
		assert.ok(line.includes('"turnsSincePreviousCompact":2'));
	});

	it("retries prompt-too-long by dropping the oldest turn, up to 3 retries", async () => {
		const calls: RecordedCall[] = [];
		const ptl = new Error("prompt is too long for this model");
		const outcomes: Array<AssistantMessage | Error> = [ptl, ptl, assistantMessage(SUMMARY_TEXT)];
		const result = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn(outcomes, calls),
		);

		assert.equal(calls.length, 3);
		assert.ok(requestText(calls[0]).includes("first request"));
		assert.ok(requestText(calls[1]).includes("second request"));
		assert.ok(!requestText(calls[1]).includes("first request"), "oldest turn should have been dropped");
		assert.ok(!requestText(calls[2]).includes("second request"), "second retry drops the remaining turn");
		assert.ok(result.summary.startsWith("Summary:"));
		assert.equal(isAutoCompactBreakerTripped(), false);
	});

	it("exhausts the PTL retry budget and records one failure for the cycle", async () => {
		const calls: RecordedCall[] = [];
		const ptl = new Error("prompt is too long for this model");
		// 4 messages -> a turn pair is dropped after each retry; the third failure exhausts the budget.
		const outcomes: Array<AssistantMessage | Error> = [ptl, ptl, ptl];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn(outcomes, calls),
				),
			/prompt is too long/,
		);
		assert.equal(calls.length, 3); // initial + 2 retries (conversation is empty after that)
		assert.equal(isAutoCompactBreakerTripped(), false); // one failed cycle = one failure (CC semantics)
	});

	it("trips the circuit breaker after 3 failed compaction cycles", async () => {
		for (let cycle = 0; cycle < 2; cycle++) {
			await assert.rejects(
				() =>
					compact(
						preparation(),
						MODEL,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						fakeStreamFn([new Error("provider exploded")], []),
					),
				/provider exploded/,
			);
			assert.equal(isAutoCompactBreakerTripped(), false);
		}
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([new Error("provider exploded")], []),
				),
			/provider exploded/,
		);
		assert.equal(isAutoCompactBreakerTripped(), true);
	});

	it("does not retry non-PTL errors; records the failure", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([new Error("provider exploded")], calls),
				),
			/provider exploded/,
		);
		assert.equal(calls.length, 1);
		// One failed cycle records one failure; the breaker needs three consecutive.
		assert.equal(isAutoCompactBreakerTripped(), false);
	});

	it("throws when PI_DISABLE_COMPACT is set", async () => {
		process.env.PI_DISABLE_COMPACT = "1";
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([], calls),
				),
			/PI_DISABLE_COMPACT/,
		);
		assert.equal(calls.length, 0);
	});

	it("throws when there is nothing to compact", async () => {
		const prep = preparation({ messagesToSummarize: [], turnPrefixMessages: [] });
		await assert.rejects(() => compact(prep, MODEL, undefined), /Nothing to compact/);
	});

	it("recovers a summary cut off at the cap by continuing generation", async () => {
		const calls: RecordedCall[] = [];
		const result = await compact(
			preparation(),
			MODEL,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn(
				[
					assistantMessage("<analysis>scratchpad cuts", "length"),
					assistantMessage(
						" off</analysis>\n\n<summary>\n1. Primary Request and Intent:\n   Do the work.\n</summary>",
					),
				],
				calls,
			),
		);
		assert.equal(calls.length, 2);
		assert.ok(result.summary.startsWith("Summary:"));
		assert.ok(result.summary.includes("Do the work."));
		// The continuation replays the accumulated text as an assistant turn and
		// asks the model to pick up mid-sentence.
		const continuation = requestText(calls[1]);
		assert.ok(continuation.includes("<analysis>scratchpad cuts"));
		assert.ok(continuation.includes("Continue it exactly where it stopped"));
		// Usage accumulates across rounds (fake: input 10, output 20, total 30 each).
		assert.deepEqual(result.usage, { input: 20, output: 40, total: 60 });
	});

	it("fails only after the continuation budget is exhausted at the cap", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn(
						[
							assistantMessage("cut one", "length"),
							assistantMessage("cut two", "length"),
							assistantMessage("cut three", "length"),
						],
						calls,
					),
				),
			/incomplete/,
		);
		assert.equal(calls.length, 3); // initial + 2 continuation rounds
	});

	it("does not continue an empty length-limited reply", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([assistantMessage("", "length")], calls),
				),
			/incomplete/,
		);
		assert.equal(calls.length, 1);
	});

	it("throws when the model reply was aborted mid-generation", async () => {
		const calls: RecordedCall[] = [];
		await assert.rejects(
			() =>
				compact(
					preparation(),
					MODEL,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					fakeStreamFn([assistantMessage("partial", "aborted")], calls),
				),
			/aborted/,
		);
	});

	it("does not count aborted compactions against the circuit breaker", async () => {
		// Cancelling a compaction is user intent, not a compaction defect; three
		// aborted cycles must not trip the breaker and suppress auto-compaction.
		for (let cycle = 0; cycle < 3; cycle++) {
			await assert.rejects(
				() =>
					compact(
						preparation(),
						MODEL,
						undefined,
						undefined,
						undefined,
						undefined,
						undefined,
						fakeStreamFn([assistantMessage("partial", "aborted")], []),
					),
				/aborted/,
			);
		}
		assert.equal(isAutoCompactBreakerTripped(), false);
	});
});

describe("generateSummaryWithUsage", () => {
	it("merges a previous summary via the <previous-summary> instruction", async () => {
		const calls: RecordedCall[] = [];
		await generateSummaryWithUsage(
			[userMessage("hi")],
			MODEL,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			"OLD SUMMARY",
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);
		const prompt = requestText(calls[0]);
		assert.ok(prompt.includes("<previous-summary>\nOLD SUMMARY\n</previous-summary>"));
		assert.ok(prompt.includes("Merge it into your new summary"));
	});

	it("never applies the session thinking level: no reasoning, flagged no-reasoning", async () => {
		const calls: RecordedCall[] = [];
		await generateSummaryWithUsage(
			[userMessage("hi")],
			MODEL,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"high",
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);
		assert.equal("reasoning" in calls[0].options, false);
		assert.equal(hasNoReasoning(calls[0].options), true);
	});

	it("floors the output cap at the 20k summary reservation, clamped by the model", async () => {
		const calls: RecordedCall[] = [];
		// MODEL.maxTokens is 8k: the model's own limit wins.
		await generateSummaryWithUsage(
			[userMessage("hi")],
			MODEL,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);
		assert.equal(calls[0].options.maxTokens, 8_192);
		// A 384k-output model gets the 20k floor instead of 0.8 × 16384 = 13107.
		const bigModel = { ...MODEL, maxTokens: 384_000 } as Model<any>;
		await generateSummaryWithUsage(
			[userMessage("hi")],
			bigModel,
			16_384,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn([assistantMessage(SUMMARY_TEXT)], calls),
		);
		assert.equal(calls[1].options.maxTokens, 20_000);
	});
});
