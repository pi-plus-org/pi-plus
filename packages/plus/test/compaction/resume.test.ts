/**
 * Tests for the mid-run compaction resume:
 * plus/src/compaction/resume.ts + the AgentSession.compact() override in
 * plus/src/coding-agent/core/agent-session.ts.
 *
 * Upstream's manual compact() aborts an in-flight run and never continues it.
 * The plus wrapper captures isStreaming before compacting and, when a run was
 * interrupted, re-engages the model via a silent custom message with
 * triggerTurn — whether the compaction lands or fails. Before aborting it also
 * pre-flights upstream's "nothing to compact" failures so a doomed compaction
 * cannot kill a running task. These tests drive the override with a minimal
 * fake `this` and a mocked upstream compact() — no live agent run is needed to
 * verify the glue.
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
	/** The override's pre-abort "nothing to compact" check; stubbed per test. */
	findCompactionBlocker: () => string | undefined;
}

function makeFakeSession(isStreaming: boolean): FakeSession {
	return {
		serializeCompaction: (fn) => fn(),
		isStreaming,
		sendCustomMessage: vi.fn().mockResolvedValue(undefined),
		findCompactionBlocker: () => undefined,
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

	it("resumes the interrupted run even when the compaction fails", async () => {
		// Upstream compact() aborts the run before it can fail, so a failed
		// compaction must still re-engage the task it killed.
		vi.spyOn(UpstreamAgentSession.prototype, "compact").mockRejectedValue(new Error("boom"));
		const fake = makeFakeSession(true);

		await assert.rejects(callCompact(fake), /boom/);
		await vi.waitFor(() => expect(fake.sendCustomMessage).toHaveBeenCalledTimes(1));
	});

	it("short-circuits a run-interrupting compact() that has nothing to compact", async () => {
		// The pre-flight: when a run is active and upstream compact() would
		// abort it only to throw "Nothing to compact", the override rejects
		// without touching upstream — the run must survive.
		const compactSpy = vi.spyOn(UpstreamAgentSession.prototype, "compact").mockResolvedValue(COMPACTION_RESULT);
		const fake = makeFakeSession(true);
		fake.findCompactionBlocker = () => "Nothing to compact (session too small)";

		await assert.rejects(callCompact(fake), /Nothing to compact \(session too small\)/);
		expect(compactSpy).not.toHaveBeenCalled();
		await Promise.resolve();
		await Promise.resolve();
		expect(fake.sendCustomMessage).not.toHaveBeenCalled();
	});

	it("lets an idle compact() through to upstream even when it would find nothing", async () => {
		// No run at risk -> upstream's exact behavior and events, unchanged.
		const compactSpy = vi
			.spyOn(UpstreamAgentSession.prototype, "compact")
			.mockRejectedValue(new Error("Nothing to compact (session too small)"));
		const fake = makeFakeSession(false);
		fake.findCompactionBlocker = () => "Nothing to compact (session too small)";

		await assert.rejects(callCompact(fake), /Nothing to compact/);
		expect(compactSpy).toHaveBeenCalledTimes(1);
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
