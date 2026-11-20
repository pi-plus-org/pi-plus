/**
 * Tests for the pi-plus steer() override and its steering machinery
 * (plus/src/coding-agent/core/steer-interrupt.ts and the AgentSession override
 * in plus/src/coding-agent/core/agent-session.ts):
 * - InFlightToolTracker: which in-flight tools block a steer interrupt.
 * - steer() defers slash commands naming a registered extension command to
 *   the settle boundary instead of throwing mid-run.
 * - maybeInterruptRunForSteer aborts the run only when every in-flight tool
 *   is cancel-safe (vacuously true when none are in flight).
 *
 * Upstream stays pristine, so the steer tests exercise the override against
 * structural fakes of the state it reads — the same access pattern the
 * getSlashCommands tests use.
 */

import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/coding-agent/core/agent-session.ts";
import {
	InFlightToolTracker,
	isToolCancelSafe,
	markToolCancelSafe,
} from "../../src/coding-agent/core/steer-interrupt.ts";

describe("InFlightToolTracker", () => {
	it("is vacuously cancel-safe with no in-flight tools", () => {
		expect(new InFlightToolTracker().allCancelSafe()).toBe(true);
	});

	it("blocks the interrupt while an unmarked tool is in flight", () => {
		const tracker = new InFlightToolTracker();
		tracker.toolStarted("call-1", "bash");
		expect(tracker.allCancelSafe()).toBe(false);
	});

	it("allows the interrupt when every in-flight tool is marked cancel-safe", () => {
		markToolCancelSafe("probe");
		const tracker = new InFlightToolTracker();
		tracker.toolStarted("call-1", "probe");
		tracker.toolStarted("call-2", "probe");
		expect(isToolCancelSafe("probe")).toBe(true);
		expect(tracker.allCancelSafe()).toBe(true);
		tracker.toolEnded("call-1");
		expect(tracker.allCancelSafe()).toBe(true);
	});

	it("blocks again when an unflagged tool joins the flight set", () => {
		markToolCancelSafe("probe");
		const tracker = new InFlightToolTracker();
		tracker.toolStarted("call-1", "probe");
		tracker.toolStarted("call-2", "bash");
		expect(tracker.allCancelSafe()).toBe(false);
		tracker.toolEnded("call-2");
		expect(tracker.allCancelSafe()).toBe(true);
	});

	it("clears the flight set at agent_end", () => {
		const tracker = new InFlightToolTracker();
		tracker.toolStarted("call-1", "bash");
		tracker.clear();
		expect(tracker.allCancelSafe()).toBe(true);
	});
});

interface SteerInterruptHost {
	isStreaming: boolean;
	steerInFlightTools: InFlightToolTracker;
	agent: { abort: () => void };
	deferredSteerCommands: string[];
	findExtensionCommand: (text: string) => unknown;
	_tryExecuteExtensionCommand: (text: string) => Promise<void>;
}

function makeHost(overrides: Partial<SteerInterruptHost> = {}): SteerInterruptHost {
	return {
		isStreaming: true,
		steerInFlightTools: new InFlightToolTracker(),
		agent: { abort: vi.fn() },
		deferredSteerCommands: [],
		findExtensionCommand: () => undefined,
		_tryExecuteExtensionCommand: vi.fn(async () => {}),
		...overrides,
	};
}

const steerMethod = AgentSession.prototype.steer as unknown as (
	this: SteerInterruptHost,
	text: string,
) => Promise<string>;

const maybeInterruptMethod = (
	AgentSession.prototype as unknown as { maybeInterruptRunForSteer(this: SteerInterruptHost): void }
).maybeInterruptRunForSteer;

const runDeferredMethod = (
	AgentSession.prototype as unknown as { runDeferredSteerCommands(this: SteerInterruptHost): Promise<void> }
).runDeferredSteerCommands;

describe("AgentSession.steer override", () => {
	it("defers a slash command naming a registered extension command while streaming", async () => {
		const host = makeHost({ findExtensionCommand: () => ({ name: "testcmd" }) });
		await expect(steerMethod.call(host, "/testcmd hello")).resolves.toBe("queued");
		expect(host.deferredSteerCommands).toEqual(["/testcmd hello"]);
	});

	it("executes deferred slash commands at the settle boundary in order", async () => {
		const executed: string[] = [];
		const host = makeHost({
			_tryExecuteExtensionCommand: async (text: string) => {
				executed.push(text);
			},
		});
		host.deferredSteerCommands.push("/one", "/two");
		await runDeferredMethod.call(host);
		expect(executed).toEqual(["/one", "/two"]);
		expect(host.deferredSteerCommands).toEqual([]);
	});

	it("aborts the run when every in-flight tool is cancel-safe", () => {
		markToolCancelSafe("probe");
		const host = makeHost();
		host.steerInFlightTools.toolStarted("call-1", "probe");
		maybeInterruptMethod.call(host);
		expect(host.agent.abort).toHaveBeenCalledTimes(1);
	});

	it("aborts the run while only the model is streaming (no tools in flight)", () => {
		const host = makeHost();
		maybeInterruptMethod.call(host);
		expect(host.agent.abort).toHaveBeenCalledTimes(1);
	});

	it("does not abort the run when an in-flight tool is not cancel-safe", () => {
		const host = makeHost();
		host.steerInFlightTools.toolStarted("call-1", "bash");
		maybeInterruptMethod.call(host);
		expect(host.agent.abort).not.toHaveBeenCalled();
	});

	it("does not abort the run when not streaming", () => {
		const host = makeHost({ isStreaming: false });
		maybeInterruptMethod.call(host);
		expect(host.agent.abort).not.toHaveBeenCalled();
	});
});
