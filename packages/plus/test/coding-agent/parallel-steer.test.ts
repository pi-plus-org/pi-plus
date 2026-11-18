/**
 * Parallel steering: steer-mode input during a run spawns a forked background
 * agent (parallel-steer.ts) instead of joining the main run's steering queue.
 * The background runner is faked — no real subprocesses or provider calls.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionConfig } from "../../../coding-agent/src/core/agent-session.ts";
import { AuthStorage } from "../../../coding-agent/src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../../coding-agent/src/core/extensions/index.ts";
import { type CustomMessage, convertToLlm } from "../../../coding-agent/src/core/messages.ts";
import { SessionManager } from "../../../coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../../coding-agent/src/core/settings-manager.ts";
import type { ResourceLoader } from "../../../coding-agent/src/index.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../../coding-agent/test/model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../../coding-agent/test/utilities.ts";
import { AgentSession } from "../../src/coding-agent/core/agent-session.ts";
import {
	type BackgroundRunner,
	buildParallelSteerTask,
	setBackgroundRunnerForTests,
} from "../../src/coding-agent/core/parallel-steer.ts";
import { emptyUsage, type SubagentResult } from "../../src/extensions/subagent/format.ts";

interface FakeCall {
	defaultCwd: string;
	defaults: { model?: string; thinkingLevel?: string };
	agentName: string;
	task: string;
	cwd: string | undefined;
	signal: AbortSignal | undefined;
}

/** Runner that records calls and hands control of each result to the test. */
function createFakeRunner() {
	const calls: FakeCall[] = [];
	const resolvers: Array<(result: SubagentResult) => void> = [];
	const rejecters: Array<(error: unknown) => void> = [];
	const runner: BackgroundRunner = (defaultCwd, defaults, agent, task, cwd, signal) => {
		calls.push({
			defaultCwd,
			defaults: { model: defaults.model, thinkingLevel: String(defaults.thinkingLevel) },
			agentName: agent.name,
			task,
			cwd,
			signal,
		});
		return new Promise<SubagentResult>((resolve, reject) => {
			resolvers.push(resolve);
			rejecters.push(reject);
		});
	};
	return { calls, resolvers, rejecters, runner };
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		agent: "background",
		agentSource: "builtin",
		task: "task",
		exitCode: 0,
		messages: [{ ...fauxAssistantMessage("background answer"), timestamp: Date.now() }],
		stderr: "",
		usage: { ...emptyUsage(), input: 1200, output: 300, turns: 2 },
		model: "faux/echo",
		stopReason: "stop",
		...overrides,
	};
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	model: { provider: string; id: string };
	cleanup: () => void;
}

async function createHarness(fakeRunner: BackgroundRunner): Promise<Harness> {
	// The session captures the module-level runner at construction.
	setBackgroundRunnerForTests(fakeRunner);
	const fauxProvider = registerFauxProvider();
	const model = fauxProvider.getModel();

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: fauxProvider.api,
		models: fauxProvider.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			inputLimits: registeredModel.inputLimits,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});

	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const agent = new Agent({
		getApiKey: () => "faux-key",
		streamFn: streamSimple,
		initialState: { model, systemPrompt: "", tools: [] },
		convertToLlm,
		transformContext: async (messages: AgentMessage[]) => messages,
	});
	const extensionsResult = await createTestExtensionsResult([], process.cwd());
	const resourceLoader: ResourceLoader = createTestResourceLoader({ extensionsResult });

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		extensionRunnerRef,
	} as AgentSessionConfig);

	// Seed a short transcript so the context excerpt has content.
	const now = Date.now();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "original request" }],
		timestamp: now - 1000,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("original answer"),
		timestamp: now - 500,
	});
	session.agent.state.messages = sessionManager.buildSessionContext().messages;

	return { session, sessionManager, model, cleanup: () => fauxProvider.unregister() };
}

function setStreaming(session: AgentSession, streaming: boolean): void {
	Reflect.set(session, "_isAgentRunActive", streaming);
}

function customResults(sessionManager: SessionManager): CustomMessage[] {
	return sessionManager
		.buildSessionProjection()
		.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === "plus.background_result",
		);
}

let harn: Harness | undefined;
let fake: ReturnType<typeof createFakeRunner>;

beforeEach(() => {
	fake = createFakeRunner();
});

afterEach(() => {
	harn?.cleanup();
	harn = undefined;
	setBackgroundRunnerForTests(undefined);
	vi.unstubAllEnvs();
});

describe("parallel steer routing", () => {
	it("steer during a run spawns a background run instead of queueing steering", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		const disposition = await session.steer("check the failing test");

		expect(disposition).toBe("queued");
		expect(session.getSteeringMessages()).toHaveLength(0);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.backgroundRunCount).toBe(1);
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.agentName).toBe("background");
		// Same provider/id shape the memory extractor and subagent tool use.
		const sessionModel = session.model;
		expect(call.defaults.model).toBe(
			sessionModel
				? sessionModel.provider
					? `${sessionModel.provider}/${sessionModel.id}`
					: sessionModel.id
				: undefined,
		);
		expect(call.task).toContain("check the failing test");
		expect(call.task).toContain("<session-context>");
		expect(call.task).toContain("original request");
	});

	it("prompt with streamingBehavior steer during a run goes parallel", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		await session.prompt("summarize the diff", { streamingBehavior: "steer" });

		expect(session.getSteeringMessages()).toHaveLength(0);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0].task).toContain("summarize the diff");
	});

	it("followUp during a run stays on the upstream queue", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		const disposition = await session.followUp("then run the build");

		expect(disposition).toBe("queued");
		expect(session.getFollowUpMessages()).toEqual(["then run the build"]);
		expect(fake.calls).toHaveLength(0);
	});

	it("steer while idle uses the upstream steering queue", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;

		const disposition = await session.steer("idle steer");

		expect(disposition).toBe("queued");
		expect(session.getSteeringMessages()).toEqual(["idle steer"]);
		expect(fake.calls).toHaveLength(0);
	});

	it("PI_PLUS_PARALLEL_STEER=0 restores upstream steering", async () => {
		vi.stubEnv("PI_PLUS_PARALLEL_STEER", "0");
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		const disposition = await session.steer("plain steer");

		expect(disposition).toBe("queued");
		expect(session.getSteeringMessages()).toEqual(["plain steer"]);
		expect(fake.calls).toHaveLength(0);
	});

	it("steer with images uses the upstream steering queue", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);
		const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

		const disposition = await session.steer("what is this", [image]);

		expect(disposition).toBe("queued");
		expect(session.getSteeringMessages()).toEqual(["what is this"]);
		expect(fake.calls).toHaveLength(0);
	});

	it("slash-prefixed prompt during a run stays on the upstream path", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		const disposition = await session.prompt("/not-a-command", { streamingBehavior: "steer" });

		// Upstream prompt() resolves undefined when it queues via streamingBehavior.
		expect(disposition).toBeUndefined();
		expect(session.getSteeringMessages()).toEqual(["/not-a-command"]);
		expect(fake.calls).toHaveLength(0);
	});

	it("multiple concurrent steers spawn multiple background runs", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);

		await session.steer("first");
		await session.steer("second");

		expect(session.backgroundRunCount).toBe(2);
		expect(fake.calls).toHaveLength(2);
		fake.resolvers[0](makeResult());
		fake.resolvers[1](makeResult());
		await waitFor(() => session.backgroundRunCount === 0, "both background runs to finish");
	});
});

describe("background result delivery", () => {
	it("appends the result to the transcript when the session is idle", async () => {
		harn = await createHarness(fake.runner);
		const { session, sessionManager } = harn;
		setStreaming(session, true);
		await session.steer("background task");
		setStreaming(session, false);

		fake.resolvers[0](makeResult());
		await waitFor(() => customResults(sessionManager).length === 1, "the result entry");

		const entry = customResults(sessionManager)[0];
		expect(entry.content).toContain("Background run completed: background task");
		expect(entry.content).toContain("2 turns");
		expect(entry.content).toContain("background answer");
	});

	it("defers the transcript entry to turn end while a run is active", async () => {
		harn = await createHarness(fake.runner);
		const { session, sessionManager } = harn;
		setStreaming(session, true);
		await session.steer("background task");

		fake.resolvers[0](makeResult());
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(customResults(sessionManager)).toHaveLength(0);

		// Turn end: the run flushes pending custom messages.
		setStreaming(session, false);
		const flush = Reflect.get(session, "_flushPendingCustomMessages") as () => void;
		flush.call(session);
		expect(customResults(sessionManager)).toHaveLength(1);
	});

	it("records a failed run with its stderr, without throwing", async () => {
		harn = await createHarness(fake.runner);
		const { session, sessionManager } = harn;
		setStreaming(session, true);
		await session.steer("background task");
		setStreaming(session, false);

		fake.resolvers[0](makeResult({ exitCode: 1, stderr: "boom", messages: [] }));
		await waitFor(() => customResults(sessionManager).length === 1, "the failure entry");

		const entry = customResults(sessionManager)[0];
		expect(entry.content).toContain("Background run FAILED: background task");
		expect(entry.content).toContain("boom");
	});

	it("records a spawn error, without an unhandled rejection", async () => {
		harn = await createHarness(fake.runner);
		const { session, sessionManager } = harn;
		setStreaming(session, true);
		await session.steer("background task");
		setStreaming(session, false);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			fake.rejecters[0](new Error("spawn failed"));
			await waitFor(() => customResults(sessionManager).length === 1, "the failure entry");
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toHaveLength(0);
		const entry = customResults(sessionManager)[0];
		expect(entry.content).toContain("spawn failed");
	});

	it("dispose aborts in-flight background runs", async () => {
		harn = await createHarness(fake.runner);
		const { session } = harn;
		setStreaming(session, true);
		await session.steer("background task");
		const signal = fake.calls[0].signal;
		expect(signal).toBeDefined();

		session.dispose();

		expect(signal?.aborted).toBe(true);
	});
});

describe("buildParallelSteerTask", () => {
	it("embeds the task and a transcript excerpt", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello there" }], timestamp: 1 },
			{ ...fauxAssistantMessage("general answer"), timestamp: 2 },
		];

		const task = buildParallelSteerTask("do the thing", messages);

		expect(task).toContain("do the thing");
		expect(task).toContain("hello there");
		expect(task).toContain("general answer");
		expect(task).toContain("<session-context>");
	});

	it("caps the context excerpt at the char budget", () => {
		const huge = "x".repeat(10_000);
		const messages: AgentMessage[] = Array.from({ length: 10 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `${huge} ${i}` }],
			timestamp: i,
		}));

		const task = buildParallelSteerTask("small task", messages);
		const context = task.slice(task.indexOf("<session-context>"), task.indexOf("</session-context>"));

		expect(context.length).toBeLessThan(25_000);
		expect(task).toContain("small task");
	});

	it("marks tool calls and truncates long parts", () => {
		const messages: AgentMessage[] = [
			{
				...fauxAssistantMessage(""),
				content: [
					{ type: "toolCall", id: "1", name: "bash", arguments: {} },
					{ type: "text", text: "y".repeat(2_000) },
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolName: "bash",
				toolCallId: "1",
				content: [{ type: "text", text: "z".repeat(2_000) }],
				isError: false,
				timestamp: 2,
			},
		];

		const task = buildParallelSteerTask("task", messages);

		expect(task).toContain("(tool call: bash)");
		expect(task).toContain("(tool result for bash)");
		expect(task).not.toContain("y".repeat(600));
		expect(task).not.toContain("z".repeat(600));
	});
});
