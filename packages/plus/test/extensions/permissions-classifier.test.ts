/**
 * Tests for the auto-mode action classifier: the response parser (the model
 * must be understood even when it drifts from the requested XML format), the
 * prompt builder (policy bullets must land in the system prompt), and
 * `classifyAction`'s failure paths, which must come back as "no verdict"
 * instead of throwing. All provider access goes through the injected completion
 * call, and model/credential resolution goes through a fake session registry.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { describe, it } from "vitest";
import type { ExtensionContext } from "../../../coding-agent/src/core/extensions/types.ts";
import { autoModeWriteDenial, toolInputPaths } from "../../src/extensions/permissions/auto-mode.ts";
import { formatAutoModeRules, readAutoModeRules } from "../../src/extensions/permissions/auto-rules.ts";
import {
	buildClassifierSystemPrompt,
	buildClassifierUserPrompt,
	classifyAction,
	createModelClassifier,
	parseClassifierResponse,
	truncateTranscript,
} from "../../src/extensions/permissions/classifier.ts";

const MODEL = { provider: "faux", id: "faux-1", api: "faux" } as unknown as Model<any>;

/** Completion call answering with `message` (a raw assistant-message fragment). */
function fakeCall(message: Partial<AssistantMessage> = {}) {
	return async () =>
		({
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "stop",
			...message,
		}) as AssistantMessage;
}

const answer = (text: string) => fakeCall({ content: [{ type: "text", text }] });

function classify(textResponse: string | Partial<AssistantMessage>) {
	return (action: Parameters<typeof classifyAction>[0], extra: Record<string, unknown> = {}) =>
		classifyAction(action, {
			model: MODEL,
			call: typeof textResponse === "string" ? answer(textResponse) : fakeCall(textResponse),
			transcript: "",
			systemPrompt: buildClassifierSystemPrompt(),
			...extra,
		});
}

describe("parseClassifierResponse", () => {
	it("parses the requested XML format in both directions", () => {
		assert.deepEqual(parseClassifierResponse("<block>yes</block>\n<reason> wipes history </reason>"), {
			block: true,
			reason: "wipes history",
		});
		assert.deepEqual(parseClassifierResponse("<block>no</block>\n<reason>read only</reason>"), {
			block: false,
			reason: "read only",
		});
	});

	it("accepts a JSON object and the shouldBlock spelling", () => {
		assert.deepEqual(parseClassifierResponse('{"block": true, "reason": "risky"}'), { block: true, reason: "risky" });
		assert.deepEqual(parseClassifierResponse('verdict: {"shouldBlock": false}'), { block: false });
	});

	it("accepts a bare yes/no", () => {
		assert.deepEqual(parseClassifierResponse("yes"), { block: true });
		assert.deepEqual(parseClassifierResponse("No, that is fine."), { block: false });
	});

	it("returns undefined when there is no decision to read", () => {
		assert.equal(parseClassifierResponse("I cannot tell without more context."), undefined);
		assert.equal(parseClassifierResponse(""), undefined);
	});
});

describe("classifier prompts", () => {
	it("appends the policy addendum after the built-in policy", () => {
		const prompt = buildClassifierSystemPrompt("## User preferences\n- allow `npm audit`\n");
		assert.ok(prompt.includes("allowed by default") || prompt.includes("ALLOWED BY DEFAULT"));
		assert.ok(prompt.includes("allow `npm audit`"));
		assert.ok(prompt.indexOf("ALLOWED BY DEFAULT") < prompt.indexOf("User preferences"));
	});

	it("names the tool, description, input and transcript in the user prompt", () => {
		const prompt = buildClassifierUserPrompt(
			{ toolName: "bash", description: "run: ls", input: '{"command":"ls"}' },
			"user: list files",
		);
		assert.ok(prompt.includes("bash"));
		assert.ok(prompt.includes('{"command":"ls"}'));
		assert.ok(prompt.includes("user: list files"));
	});

	it("truncateTranscript keeps the tail and marks the cut", () => {
		const clipped = truncateTranscript(`${"head ".repeat(50)}TAILMARK`, 60);
		assert.ok(clipped.endsWith("TAILMARK"));
		assert.ok(clipped.startsWith("[... ") && clipped.includes("elided"));
		assert.ok(clipped.length < 60);
	});
});

describe("classifyAction", () => {
	const action = { toolName: "bash", description: "run ls" };

	it("maps a block verdict to status block with the reason", async () => {
		const decision = await classify("<block>yes</block>\n<reason>destructive</reason>")(action);
		assert.deepEqual(decision, { status: "block", reason: "destructive" });
	});

	it("maps a no verdict to allow", async () => {
		assert.equal((await classify("<block>no</block>")(action)).status, "allow");
	});

	it("reports an unreadable answer as unavailable", async () => {
		assert.equal((await classify("looks okay to me")(action)).status, "unavailable");
	});

	it("reports provider errors and aborts as unavailable instead of throwing", async () => {
		assert.equal((await classify({ stopReason: "error", errorMessage: "boom" })(action)).status, "unavailable");
		assert.equal((await classify({ stopReason: "aborted" })(action)).status, "unavailable");
		const thrown = await classifyAction(action, {
			model: MODEL,
			call: () => {
				throw new Error("socket closed");
			},
			transcript: "",
			systemPrompt: "x",
		});
		assert.equal(thrown.status, "unavailable");
		assert.ok(thrown.reason?.includes("socket closed"));
	});

	it("builds the request itself: no caller credentials, no cache writes", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const decision = await classifyAction(
			{ toolName: "bash", description: "rm -rf build" },
			{
				model: MODEL,
				call: async (_model, _context, options) => {
					requests.push(options as unknown as Record<string, unknown>);
					return { role: "assistant", content: [{ type: "text", text: "<block>no</block>" }] } as AssistantMessage;
				},
				transcript: "user: clean the build",
				systemPrompt: "answer <block> yes/no",
			},
		);
		assert.equal(decision.status, "allow");
		assert.equal(requests[0]?.cacheRetention, "none");
		assert.equal(requests[0]?.maxTokens, 256);
		assert.ok(!("apiKey" in (requests[0] ?? {})) && !("headers" in (requests[0] ?? {})));
	});

	it("truncates a huge input before sending it", async () => {
		const decision = await classify("<block>no</block>")(
			{ toolName: "write", description: "write big", input: "x".repeat(10_000) },
			{ maxInputChars: 10 },
		);
		assert.equal(decision.status, "allow");
	});
});

describe("createModelClassifier", () => {
	it("is unavailable when the session has no model", async () => {
		const ctx = { model: undefined } as unknown as ExtensionContext;
		const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "unavailable");
		assert.ok(decision.reason?.includes("no model"));
	});

	it("is unavailable when the registry has no credentials", async () => {
		const ctx = {
			model: MODEL,
			modelRegistry: { find: () => MODEL, hasConfiguredAuth: () => false },
		} as unknown as ExtensionContext;
		const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "unavailable");
		assert.ok(decision.reason?.includes("no credentials for faux/faux-1"));
	});

	/** Session registry answering only for the models the profile declares. */
	function registryContext(models: Model<any>[], authed = true, scoped = true) {
		const calls: Array<{ model: Model<any>; options: Record<string, unknown> }> = [];
		const ctx = {
			sessionManager: { getSessionId: () => "session-1" },
			model: models[0],
			// The session's model scope: the profile's declared models, in profile order.
			scopedModels: scoped ? models.map((model) => ({ model })) : [],
			modelRegistry: {
				find: (provider: string, id: string) =>
					models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: () => authed,
				streamSimple: (model: Model<any>, _context: unknown, options: Record<string, unknown>) => {
					calls.push({ model, options });
					return {
						result: () => Promise.resolve({ content: [{ type: "text", text: "<block>no</block>" }] }),
					} as never;
				},
			},
		} as unknown as ExtensionContext;
		return { ctx, calls };
	}

	function profileModel(overrides: Partial<Model<any>> = {}): Model<any> {
		return { provider: "faux", id: "faux-1", baseUrl: "https://profile.example/v1", ...overrides } as Model<any>;
	}

	it("asks a model the profile declares, through the registry", async () => {
		const composed = profileModel();
		const { ctx, calls } = registryContext([composed]);
		const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "allow");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.model, composed);
		assert.equal(calls[0]?.options.sessionId, "session-1");
	});

	it("refuses a classifier model outside the profile without calling it", async () => {
		const { ctx, calls } = registryContext([profileModel()]);
		const intruder = profileModel({ provider: "anthropic", id: "claude-x", baseUrl: "https://elsewhere.example" });
		const decision = await createModelClassifier({ model: intruder })({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "unavailable");
		assert.ok(decision.reason?.includes("not a model of this profile"));
		assert.equal(calls.length, 0);
	});

	it("trusts only the model identity: transport fields come from the profile's copy", async () => {
		const composed = profileModel();
		const { ctx, calls } = registryContext([composed]);
		const callerCopy = profileModel({ baseUrl: "https://attacker.example", headers: { authorization: "Bearer x" } });
		const decision = await createModelClassifier({ model: callerCopy })({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "allow");
		assert.equal(calls[0]?.model, composed);
		assert.equal(calls[0]?.model.baseUrl, "https://profile.example/v1");
	});

	describe("classifier model selection", () => {
		it("asks the profile's second model when it declares two", async () => {
			const main = profileModel({ id: "main" });
			const side = profileModel({ id: "side" });
			const { ctx, calls } = registryContext([main, side]);
			const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
			assert.equal(decision.status, "allow");
			assert.equal(calls.length, 1);
			assert.equal(calls[0]?.model, side);
		});

		it("asks the profile's only model when it declares one", async () => {
			const only = profileModel({ id: "only" });
			const { ctx, calls } = registryContext([only]);
			const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
			assert.equal(decision.status, "allow");
			assert.equal(calls[0]?.model, only);
		});

		it("asks the session model when the profile declares no model scope", async () => {
			const session = profileModel({ id: "session" });
			const { ctx, calls } = registryContext([session], true, false);
			const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
			assert.equal(decision.status, "allow");
			assert.equal(calls[0]?.model, session);
		});

		it("never substitutes the session model for an unusable profile pick", async () => {
			const main = profileModel({ id: "main" });
			// The profile's second declared model is in the scope but not in the
			// registry (deleted from models.json, renamed, unavailable): no verdict.
			const ghost = profileModel({ id: "ghost" });
			const calls: unknown[] = [];
			const ctx = {
				sessionManager: { getSessionId: () => "session-1" },
				model: main,
				scopedModels: [{ model: main }, { model: ghost }],
				modelRegistry: {
					find: (_provider: string, id: string) => (id === "ghost" ? undefined : main),
					hasConfiguredAuth: () => true,
					streamSimple: () => {
						calls.push(1);
						return { result: () => Promise.resolve({ content: [] }) } as never;
					},
				},
			} as unknown as ExtensionContext;
			const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
			assert.equal(decision.status, "unavailable");
			assert.ok(decision.reason?.includes("the profile's second model"));
			assert.equal(calls.length, 0);
		});

		it("is unavailable when the picked model has no credentials", async () => {
			const main = profileModel({ id: "main" });
			const side = profileModel({ id: "side" });
			const { ctx, calls } = registryContext([main, side], false);
			const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
			assert.equal(decision.status, "unavailable");
			assert.ok(decision.reason?.includes("no credentials for faux/side"));
			assert.equal(calls.length, 0);
		});
	});
});

describe("auto-mode path policy", () => {
	it("denies config-bearing paths and nothing else", () => {
		assert.ok(autoModeWriteDenial("/repo/.git/hooks/pre-commit", "/repo"));
		assert.ok(autoModeWriteDenial("/repo/settings.json", "/repo"));
		assert.ok(autoModeWriteDenial("/home/u/.zshrc", "/repo"));
		assert.ok(autoModeWriteDenial("/repo/.env", "/repo"));
		assert.equal(autoModeWriteDenial("/repo/src/app.ts", "/repo"), undefined);
		assert.equal(autoModeWriteDenial("/repo/docs/AGENTS.md", "/repo"), undefined, "only root AGENTS.md");
	});

	it("toolInputPaths ignores shells and resolves relative paths", () => {
		assert.deepEqual(toolInputPaths("bash", { command: "rm -rf /tmp/x" }, "/repo"), []);
		assert.deepEqual(toolInputPaths("edit", { path: "a.ts", edits: [] }, "/repo"), ["/repo/a.ts"]);
		assert.deepEqual(toolInputPaths("write", { file_path: "/tmp/b.md" }, "/repo"), ["/tmp/b.md"]);
		assert.deepEqual(toolInputPaths("edit", { files: ["c.ts", { path: "d.ts" }] }, "/repo"), [
			"/repo/c.ts",
			"/repo/d.ts",
		]);
	});
});

describe("readAutoModeRules", () => {
	it("returns empty rules when no settings file declares them", () => {
		const dir = join("/tmp", `pi-auto-rules-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			const rules = readAutoModeRules(dir);
			assert.deepEqual(rules, { allow: [], deny: [], environment: [] });
			assert.equal(formatAutoModeRules(rules), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the project layer and formats only the populated sections", () => {
		const dir = join("/tmp", `pi-auto-rules-${process.pid}-${Date.now()}`);
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "settings.json"),
			JSON.stringify({ autoMode: { allow: ["run `npm audit`"], soft_deny: ["never push"], environment: [] } }),
		);
		try {
			const rules = readAutoModeRules(dir);
			assert.deepEqual(rules.allow, ["run `npm audit`"]);
			assert.deepEqual(rules.deny, ["never push"]);
			const text = formatAutoModeRules(rules);
			assert.ok(text?.includes("- run `npm audit`"));
			assert.ok(text?.includes("- never push"));
			assert.ok(!text?.includes("Environment"), "empty sections are omitted");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
