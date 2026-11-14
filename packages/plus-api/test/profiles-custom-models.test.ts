import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// materializeProfile must treat plain profile model ids that pi's catalog
// does not know as custom models: the definitions land in the materialized
// models.json so sessions resolve and pick them like catalogue models,
// while profiles.json-style inputs keep the plain ids.

describe("materializeProfile auto custom-model classification", () => {
	let tmp: string;
	let agentDir: string;
	let hubDir: string;
	let materializeProfile: typeof import("../src/profiles.ts").materializeProfile;

	function readModelsJson(profileName: string): Record<string, any> {
		const file = path.join(hubDir, "profiles", profileName, "models.json");
		if (!fs.existsSync(file)) return {};
		return JSON.parse(fs.readFileSync(file, "utf8"));
	}

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plus-api-custom-models-"));
		agentDir = path.join(tmp, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Shared catalogue: the provider is known, but only lists glm-5.2.
		fs.writeFileSync(
			path.join(agentDir, "models-store.json"),
			JSON.stringify({
				"qwen-token-plan-cn": { models: [{ id: "glm-5.2", api: "openai-completions" }], checkedAt: 0 },
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HUB_PI_DIR = path.join(tmp, "pi");
		const mod = await import("../src/profiles.ts");
		materializeProfile = mod.materializeProfile;
		// config.ts: PI_HUB_DIR = join(PI_HUB_PI_DIR, "pi-hub")
		hubDir = path.join(tmp, "pi", "pi-hub");
	});

	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_HUB_PI_DIR;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("writes custom definitions for ids missing from the catalogue and keeps known ids plain", () => {
		materializeProfile("cit-llm", {
			provider: "qwen-token-plan-cn",
			url: "https://proxy.example/v1",
			token: "sk-test",
			model: "citauto-deepseek-v4.1-flash",
			models: ["citauto-deepseek-v4.1-flash", "citauto-qwen3.8-flash", "glm-5.2"],
		});
		const models = readModelsJson("cit-llm").providers["qwen-token-plan-cn"].models;
		expect(models).toEqual([
			{ id: "citauto-deepseek-v4.1-flash", name: "citauto-deepseek-v4.1-flash" },
			{ id: "citauto-qwen3.8-flash", name: "citauto-qwen3.8-flash" },
		]);
		// The catalogue-known id must not be duplicated as a custom model.
		expect(models.some((m: any) => m.id === "glm-5.2")).toBe(false);
		// The provider catalogue exists, so no api dialect is forced.
		expect(models.every((m: any) => !("api" in m))).toBe(true);
	});

	it("defaults the api dialect for a provider with no catalogue at all", () => {
		materializeProfile("cold", {
			provider: "my-custom",
			url: "https://custom.example/v1",
			token: "sk-test",
			model: "my-model",
			models: ["my-model"],
		});
		const models = readModelsJson("cold").providers["my-custom"].models;
		expect(models).toEqual([{ id: "my-model", name: "my-model", api: "openai-completions" }]);
	});

	it("keeps builtin provider ids plain and only classifies unknown ones", () => {
		materializeProfile("builtin", {
			provider: "anthropic",
			url: "https://unused.example/v1",
			token: "sk-test",
			model: "claude-future-9",
			models: ["claude-haiku-4-5", "claude-future-9"],
		});
		const models = readModelsJson("builtin").providers.anthropic.models;
		// Only the unknown id gets a definition; the builtin one stays out of
		// models.json so pi's built-in entry (with full metadata) wins.
		expect(models).toEqual([{ id: "claude-future-9", name: "claude-future-9" }]);
	});

	it("passes custom model entries through unchanged", () => {
		const custom = {
			id: "my-weird-model",
			name: "My Weird Model",
			api: "anthropic-messages" as const,
			contextWindow: 12345,
		};
		materializeProfile("passthrough", {
			provider: "qwen-token-plan-cn",
			url: "https://proxy.example/v1",
			token: "sk-test",
			model: "my-weird-model",
			models: ["glm-5.2", custom],
		});
		const models = readModelsJson("passthrough").providers["qwen-token-plan-cn"].models;
		// Custom model entries are written verbatim.
		expect(models).toEqual([
			{ id: "my-weird-model", name: "My Weird Model", api: "anthropic-messages", contextWindow: 12345 },
		]);
	});

	it("leaves provider-less profiles untouched", () => {
		materializeProfile("noprovider", {
			provider: "",
			token: "sk-test",
			model: "some-model",
			models: ["some-model"],
		});
		const config = readModelsJson("noprovider");
		expect(config.providers ?? {}).toEqual({});
	});
});
