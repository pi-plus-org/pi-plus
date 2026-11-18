/**
 * Parallel steering: steer-mode input received while a run is active is
 * processed by a forked background agent instead of joining the main run's
 * steering queue.
 *
 * Upstream delivers steering only after the current turn's tool calls finish
 * (the low-level loop drains the steering queue before the next model
 * request), so a message typed during a long tool call still waits for that
 * turn and shares the single main context. Here each steer message spawns an
 * isolated pi subprocess (the same machinery as the subagent extension,
 * seeded with a serialized excerpt of the current transcript) that processes
 * the message concurrently with the main run. The outcome is appended to the
 * session transcript as a `plus.background_result` custom message when the
 * child finishes.
 *
 * Delivery goes through AgentSession.sendCustomMessage({ triggerTurn: false }):
 * idle sessions append immediately; streaming sessions defer to the run's
 * pending-custom-message flush at turn end (appending after an assistant
 * message mid-stream is the case providers reject).
 *
 * Opt out with PI_PLUS_PARALLEL_STEER=0.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentSession, QueuedInputDisposition } from "../../../../coding-agent/src/core/agent-session.ts";
import type { AgentConfig } from "../../extensions/subagent/agents.ts";
import { formatUsageStats, getFinalOutput, type SubagentResult } from "../../extensions/subagent/format.ts";
import { type DispatchDefaults, runSingleAgent } from "../../extensions/subagent/run.ts";

/**
 * Child agent descriptor: no agent-type system prompt, model/thinking inherited
 * from the parent session, so the child behaves like a peer of the main agent.
 */
const BACKGROUND_AGENT: AgentConfig = {
	name: "background",
	description: "Processes steer-mode input in parallel with the main session",
	systemPrompt: "",
	source: "builtin",
	filePath: "",
};

export type BackgroundRunner = typeof runSingleAgent;

/**
 * Test hook: the session constructs its manager with the module-level runner,
 * so tests swap it to avoid spawning real subprocesses.
 */
let defaultRunner: BackgroundRunner = runSingleAgent;

export function setBackgroundRunnerForTests(runner: BackgroundRunner | undefined): void {
	defaultRunner = runner ?? runSingleAgent;
}

export function parallelSteerEnabled(): boolean {
	return process.env.PI_PLUS_PARALLEL_STEER !== "0";
}

/** Spawns and tracks background runs for parallel-steered messages. */
export class BackgroundRunManager {
	private readonly runner: BackgroundRunner;
	private readonly runs = new Set<AbortController>();

	constructor(runner?: BackgroundRunner) {
		this.runner = runner ?? defaultRunner;
	}

	/** Number of background runs currently in flight. */
	get count(): number {
		return this.runs.size;
	}

	/**
	 * Starts a background run for a steer-mode message. Resolves once the child
	 * is spawned; the result is delivered to the transcript asynchronously.
	 */
	start(session: AgentSession, text: string): QueuedInputDisposition {
		const controller = new AbortController();
		this.runs.add(controller);
		const cwd = session.sessionManager.getCwd();
		const projection = session.sessionManager.buildSessionProjection();
		const task = buildParallelSteerTask(text, projection.messages);
		const model = session.model;
		const defaults: DispatchDefaults = {
			// Same `provider/id` shape the memory extractor and subagent tool use;
			// some providers (faux in tests) carry an empty provider name.
			model: model ? (model.provider ? `${model.provider}/${model.id}` : model.id) : undefined,
			thinkingLevel: session.thinkingLevel,
			// agentDir stays undefined: the runner resolves the hub profile the
			// same way the subagent tool does (PI_CODING_AGENT_DIR env).
		};
		this.runner(cwd, defaults, BACKGROUND_AGENT, task, cwd, controller.signal, undefined)
			.then((result) => this.deliver(session, text, result))
			.catch((error: unknown) => this.deliverFailure(session, text, error))
			.finally(() => {
				this.runs.delete(controller);
			});
		return "queued";
	}

	/** Aborts all tracked children. Parent abort does NOT do this: they are parallel work. */
	dispose(): void {
		for (const controller of this.runs) {
			controller.abort();
		}
		this.runs.clear();
	}

	private async deliver(session: AgentSession, task: string, result: SubagentResult): Promise<void> {
		const failed = result.exitCode !== 0;
		const output = failed
			? [result.stderr.trim(), getFinalOutput(result.messages)].filter((part) => part !== "").join("\n") ||
				"(no output)"
			: getFinalOutput(result.messages) || "(no output)";
		const lines = [`Background run ${failed ? "FAILED" : "completed"}: ${task}`];
		const usageLine = formatUsageStats(result.usage, result.model);
		if (usageLine) {
			lines.push(usageLine);
		}
		lines.push("", output);
		await this.appendResult(session, task, lines.join("\n"), failed);
	}

	private async deliverFailure(session: AgentSession, task: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		await this.appendResult(session, task, [`Background run FAILED: ${task}`, "", message].join("\n"), true);
	}

	private async appendResult(session: AgentSession, task: string, text: string, failed: boolean): Promise<void> {
		try {
			await session.sendCustomMessage(
				{
					customType: "plus.background_result",
					content: text,
					display: true,
					details: { task, failed },
				},
				{ triggerTurn: false },
			);
		} catch {
			// Session disposed mid-delivery: there is no transcript left to append to.
		}
	}
}

const CONTEXT_CHAR_BUDGET = 24_000;
const MESSAGE_PREVIEW_CHARS = 500;

/**
 * Builds the child task: a transcript excerpt followed by the steer message as
 * the task. Serialization is best-effort text — enough for the child to fork
 * the conversation's recent state without copying the full context.
 */
export function buildParallelSteerTask(text: string, messages: readonly AgentMessage[]): string {
	const context = serializeTranscriptTail(messages);
	return [
		"You are a background worker in a coding agent session. The excerpt below is the recent state of the main session you are running in parallel with. Handle the task, then print your final answer as your last message.",
		"",
		"<session-context>",
		context || "(empty session)",
		"</session-context>",
		"",
		`<task>\n${text}\n</task>`,
	].join("\n");
}

/** Serializes the tail of the transcript, newest first, until the char budget is exhausted. */
function serializeTranscriptTail(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	let used = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const line = serializeMessage(messages[i]);
		if (!line) {
			continue;
		}
		if (used + line.length > CONTEXT_CHAR_BUDGET) {
			break;
		}
		lines.unshift(line);
		used += line.length;
	}
	return lines.join("\n\n");
}

function serializeMessage(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return truncate(contentText(message.content, " "));
		case "assistant": {
			const parts: string[] = [];
			for (const part of message.content) {
				if (part.type === "text") {
					parts.push(part.text);
				} else if (part.type === "toolCall") {
					parts.push(`(tool call: ${part.name})`);
				}
			}
			return truncate(parts.join("\n").trim());
		}
		case "toolResult": {
			const label = `(tool result for ${message.toolName}${message.isError ? ", error" : ""})`;
			return truncate(`${label}\n${contentText(message.content, " ")}`);
		}
		case "custom":
			return truncate(`(session note: ${message.customType})\n${contentText(message.content, " ")}`);
		default:
			// system messages: the child has its own system prompt.
			return "";
	}
}

function truncate(text: string, max = MESSAGE_PREVIEW_CHARS): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
