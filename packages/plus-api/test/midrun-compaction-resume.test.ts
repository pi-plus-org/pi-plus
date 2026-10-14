/**
 * Regression: mid-run auto-compaction (context-guard pattern) must not leave
 * an abort error stub behind.
 *
 * Production symptom (pi-plus-desktop transcripts 01a12e7e / 01a1330c): after
 * every mid-run compaction fired by pi-plus-context-guard, the transcript
 * gained an assistant stub
 *   { stopReason: "error", errorMessage: "This operation was aborted", durationMs: ~1 }
 * and the user had to type "continue" manually (a follow-up /compact then
 * failed with "Nothing to compact").
 *
 * Root cause: the context-guard extension fires `ctx.compact()` from a
 * `message_end` listener, which aborts the active run's controller; the agent
 * loop still calls the stream function for the next request of the turn on
 * that already-aborted signal, and the request dies inside lazyStream's async
 * setup (auth resolution honors the caller's signal and throws before fetch).
 * The setup-error path classifies that death as `stopReason: "error"` — hence
 * the persisted stub.
 *
 * The fix lives entirely in pi-plus: the plus Agent wrapper
 * (plus/src/agent/agent.ts via the loader redirect for
 * packages/agent/src/agent.ts, mirrored for these tests by the pi-agent-core
 * alias in vitest.config.ts) installs an aborted-run guard
 * (plus/src/agent/aborted-run.ts) that short-circuits the stream function
 * when the run signal is already aborted at call time and reclassifies
 * setup-phase abort stubs (the shape attachment-heavy sessions hit, where the
 * compaction serializer queues the abort to land inside lazyStream's async
 * setup) into clean `stopReason: "aborted"` messages with no errorMessage.
 * Upstream packages stay pristine.
 *
 * The interrupted task's automatic resume (plus AgentSession.compact override)
 * is covered at the plus level by packages/plus/test/compaction/midrun-resume.test.ts
 * — source-mode SDK sessions here construct the upstream AgentSession, so the
 * resume custom message is not asserted in this suite.
 *
 * Server script: all requests answered immediately; the first request after
 * the compaction_end event is additionally delayed so a foreign abort would
 * show up as an early socket close.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { createPlusAgentSessionRuntime } from "../src/api.ts";

interface RequestRecord {
	index: number;
	delayed: boolean;
	abortedEarly: boolean;
	finished: boolean;
}

function startServer(
	records: RequestRecord[],
	state: { delayNextRequest: boolean },
): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			void body;
			const record: RequestRecord = {
				index: records.length,
				delayed: false,
				abortedEarly: false,
				finished: false,
			};
			records.push(record);
			const respond = () => {
				if (record.finished) return;
				record.finished = true;
				const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) =>
					`data: ${JSON.stringify({
						id: "chatcmpl-repro",
						object: "chat.completion.chunk",
						created: 0,
						model: "repro-model",
						choices: [{ index: 0, delta, finish_reason: finishReason }],
						...(usage ? { usage } : {}),
					})}\n\n`;
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(chunk({ role: "assistant", content: "ok" }, null));
				res.write(chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
				res.write("data: [DONE]\n\n");
				res.end();
			};
			// The first request after the compaction_end event is delayed so a
			// foreign abort shows up as an early socket close instead of racing
			// a fast response.
			if (state.delayNextRequest && !records.some((r) => r.delayed)) {
				state.delayNextRequest = false;
				record.delayed = true;
				req.on("aborted", () => {
					record.abortedEarly = true;
				});
				res.on("close", () => {
					if (!record.finished) record.abortedEarly = true;
				});
				setTimeout(respond, 1500);
				return;
			}
			respond();
		});
	});
	return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			assert(address && typeof address === "object");
			resolve({
				port: address.port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 15000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("mid-run auto-compaction (full runtime)", () => {
	it("compacts without an abort error stub", async () => {
		const records: RequestRecord[] = [];
		const state = { delayNextRequest: false };
		const server = await startServer(records, state);
		const dir = mkdtempSync(join(tmpdir(), "pi-plus-repro-"));
		try {
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify("repro-provider", async () => ({ type: "api_key", key: "repro-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(dir, "models.json"),
				allowModelNetwork: false,
			});
			modelRuntime.registerProvider("repro-provider", {
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				api: "openai-completions",
				models: [
					{
						id: "repro-model",
						name: "repro",
						api: "openai-completions",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 2048,
					},
				],
			});

			// The runtime factory is what embedding hosts (pi-plus-desktop's
			// SessionHost) actually use. In this suite it constructs the upstream
			// AgentSession — the plus Agent it streams through comes from the
			// pi-agent-core test alias (see vitest.config.ts).
			const runtime = await createPlusAgentSessionRuntime({
				cwd: dir,
				agentDir: dir,
				modelRuntime,
				// Small keep-recent window so the seeded history is actually
				// compactable (the built-in default of 20k tokens exceeds this
				// harness's entire 8k context window).
				settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1000 } }),
			});
			const { session } = runtime;
			const model = modelRuntime.getModel("repro-provider", "repro-model");
			assert(model, "model registered");
			await session.setModel(model);

			// Seed enough compactable history (real user/assistant pairs) that
			// the prompt turn crosses the context-guard threshold (80% of the
			// 8192-token window) — the production trigger shape.
			const now = Date.now();
			for (let i = 0; i < 8; i++) {
				session.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: `earlier request ${i} ${"x".repeat(1500)}` }],
					timestamp: now - 2000 + i * 10,
				});
				session.sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `earlier answer ${i} ${"y".repeat(3000)}` }],
					api: "openai-completions",
					provider: "repro-provider",
					model: "repro-model",
					usage: {
						input: 10,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 30,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now - 1990 + i * 10,
				});
			}

			const events: unknown[] = [];
			session.subscribe((event) => {
				events.push(event);
				if ((event as { type?: string }).type === "compaction_end") state.delayNextRequest = true;
			});

			const promptPromise = session.prompt("do the task");
			promptPromise.catch(() => {});
			await waitFor(() => events.some((e) => (e as { type?: string }).type === "compaction_end"), "compaction_end");
			await new Promise((resolve) => setTimeout(resolve, 4000));
			await session.waitForIdle().catch(() => {});

			// 1. The mid-run compaction fired through the manual path and succeeded.
			const compactionEnd = events.find((e) => (e as { type?: string }).type === "compaction_end") as
				| { type: "compaction_end"; errorMessage?: string; result?: unknown }
				| undefined;
			assert(compactionEnd, "compaction_end event exists");
			expect(compactionEnd.errorMessage ?? "").toBe("");
			expect(compactionEnd.result).toBeDefined();

			// 2. No abort error stub: neither the event stream nor the transcript
			// may contain the misclassified "This operation was aborted" assistant
			// message that used to be persisted after every mid-run compaction.
			// (A clean stopReason "aborted" message from the guard is fine.)
			for (const event of events) {
				const typed = event as {
					type?: string;
					message?: { role?: string; stopReason?: string; errorMessage?: string };
				};
				if (typed.type !== "message_end" || typed.message?.role !== "assistant") continue;
				expect(
					typed.message.errorMessage ?? "",
					`assistant message_end stopReason=${typed.message.stopReason}`,
				).not.toContain("This operation was aborted");
			}
			const entries = session.sessionManager.getEntries();
			const stubEntry = entries.find(
				(entry) =>
					entry.type === "message" &&
					(entry.message as { role?: string; errorMessage?: string }).errorMessage ===
						"This operation was aborted",
			);
			expect(stubEntry, "no abort stub persisted").toBeUndefined();

			// 3. The request following the compaction was not killed by a foreign
			// abort: if it was delayed by the server, it still completed without
			// an early socket close.
			const delayed = records.find((record) => record.delayed);
			if (delayed) expect(delayed.abortedEarly).toBe(false);

			await runtime.dispose().catch(() => {});
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await server.close();
		}
	}, 60_000);
});
