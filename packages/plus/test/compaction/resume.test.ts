/**
 * Tests for the mid-run compaction resume:
 * plus/src/compaction/resume.ts + the AgentSession.compact() override in
 * plus/src/coding-agent/core/agent-session.ts.
 *
 * Upstream's manual compact() aborts an in-flight run and never continues it.
 * The plus wrapper captures isStreaming before compacting and, when a run was
 * interrupted, re-engages the model via a silent custom message with
 * triggerTurn. These tests drive the override with a minimal fake `this` and
 * a mocked upstream compact() — no live agent run is needed to verify the
 * glue.
 */
import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession as UpstreamAgentSession } from "../../../coding-agent/src/core/agent-session.ts";
import type { CompactionResult } from "../../../coding-agent/src/core/compaction/compaction.ts";
import { AgentSession } from "../../src/coding-agent/core/agent-session.ts";
import {
	COMPACTION_RESUME_CUSTOM_TYPE,
	COMPACTION_RESUME_MESSAGE,
	resumeAfterMidRunCompact,
} from "../../src/compaction/resume.ts";

const COMPACTION_RESULT: CompactionResult = {
	summary: "summary",
	firstKeptEntryId: "entry-1",
	tokensBefore: 1000,
};

interface FakeSession {
	serializeCompaction: <T>(fn: () => Promise<T>) => Promise<T>;
	isStreaming: boolean;
	sendCustomMessage: ReturnType<typeof vi.fn>;
}

function makeFakeSession(isStreaming: boolean): FakeSession {
	return {
		serializeCompaction: (fn) => fn(),
		isStreaming,
		sendCustomMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function callCompact(fake: FakeSession, instructions?: string): Promise<CompactionResult> {
	const compact = AgentSession.prototype.compact as (
		this: unknown,
		customInstructions?: string,
	) => Promise<CompactionResult>;
	return compact.call(fake, instructions);
}

const consoleError = console.error;

afterEach(() => {
	vi.restoreAllMocks();
	console.error = consoleError;
});

describe("AgentSession.compact() mid-run resume", () => {
	it("resumes the interrupted run after a successful compaction", async () => {
		const compactSpy = vi.spyOn(UpstreamAgentSession.prototype, "compact").mockResolvedValue(COMPACTION_RESULT);
		const fake = makeFakeSession(true);

		const result = await callCompact(fake, "focus on the API");

		assert.equal(result, COMPACTION_RESULT);
		expect(compactSpy).toHaveBeenCalledWith("focus on the API");
		await vi.waitFor(() => expect(fake.sendCustomMessage).toHaveBeenCalledTimes(1));
		expect(fake.sendCustomMessage).toHaveBeenCalledWith(
			{
				customType: COMPACTION_RESUME_CUSTOM_TYPE,
				content: COMPACTION_RESUME_MESSAGE,
				display: false,
			},
			{ triggerTurn: true },
		);
	});

	it("does not resume when compact() is called while idle", async () => {
		const compactSpy = vi.spyOn(UpstreamAgentSession.prototype, "compact").mockResolvedValue(COMPACTION_RESULT);
		const fake = makeFakeSession(false);

		await callCompact(fake);

		expect(compactSpy).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("propagates compaction failures without resuming", async () => {
		vi.spyOn(UpstreamAgentSession.prototype, "compact").mockRejectedValue(new Error("boom"));
		const fake = makeFakeSession(true);

		await assert.rejects(callCompact(fake), /boom/);
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("runs the whole operation inside the serialization queue", async () => {
		vi.spyOn(UpstreamAgentSession.prototype, "compact").mockResolvedValue(COMPACTION_RESULT);
		const order: string[] = [];
		const fake = makeFakeSession(true);
		fake.serializeCompaction = async (fn) => {
			order.push("serialize:start");
			const result = await fn();
			order.push("serialize:end");
			return result;
		};

		await callCompact(fake);

		assert.deepEqual(order, ["serialize:start", "serialize:end"]);
	});
});

describe("resumeAfterMidRunCompact", () => {
	it("logs instead of throwing when the resume message fails", async () => {
		const errors: unknown[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		const sendCustomMessage = vi.fn().mockRejectedValue(new Error("queue full"));
		const fake = { sendCustomMessage };

		resumeAfterMidRunCompact(fake as never);

		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(String(errors[0])).toContain("queue full");
	});
});
