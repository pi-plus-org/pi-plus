/**
 * Tests for the auto-mode action classifier: the response parser (the model
 * must be understood even when it drifts from the requested XML format), the
 * prompt builder (policy bullets must land in the system prompt), and
 * `classifyAction`'s failure paths, which must come back as "no verdict"
 * instead of throwing. All provider access goes through an injected streamFn.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
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

/** StreamFn answering with `text` (or a raw assistant-message fragment). */
function fakeStream(message: Partial<AssistantMessage>): StreamFn {
	return (() => ({
		result: () =>
			Promise.resolve({ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop", ...message }),
	})) as unknown as StreamFn;
}

const answer = (text: string) => fakeStream({ content: [{ type: "text", text }] });

function classify(textResponse: string | Partial<AssistantMessage>) {
	return (action: Parameters<typeof classifyAction>[0], extra: Record<string, unknown> = {}) =>
		classifyAction(action, {
			model: MODEL,
			auth: {},
			transcript: "",
			systemPrompt: buildClassifierSystemPrompt(),
			streamFn: typeof textResponse === "string" ? answer(textResponse) : fakeStream(textResponse),
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
			auth: {},
			transcript: "",
			systemPrompt: "x",
			streamFn: (() => {
				throw new Error("socket closed");
			}) as unknown as StreamFn,
		});
		assert.equal(thrown.status, "unavailable");
		assert.ok(thrown.reason?.includes("socket closed"));
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
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "no api key" }) },
		} as unknown as ExtensionContext;
		const decision = await createModelClassifier()({ toolName: "bash", description: "ls" }, ctx);
		assert.equal(decision.status, "unavailable");
		assert.ok(decision.reason?.includes("no api key"));
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
