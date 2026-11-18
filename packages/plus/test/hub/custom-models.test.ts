import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// withAutoCustomModels must turn plain profile model ids that pi's catalog
// does not know into custom model definitions, so the materialized models.json
// registers them and sessions resolve them instead of silently falling back.
// Known ids, qualified "provider/model" ids, and existing definitions stay as
// they are.

describe("withAutoCustomModels", () => {
	let tmp: string;
	let agentDir: string;
	let profilesDir: string;
	let withAutoCustomModels: typeof import("../../src/hub/custom-models.ts").withAutoCustomModels;
	let builtinModelId: string;

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plus-custom-models-"));
		agentDir = path.join(tmp, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Must be set before pi-hub's config.ts evaluates AGENT_DIR / PROFILE_DIRS_DIR.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HUB_DIR = path.join(tmp, "pi-hub");
		profilesDir = path.join(process.env.PI_HUB_DIR, "profiles");
		const mod = await import("../../src/hub/custom-models.ts");
		withAutoCustomModels = mod.withAutoCustomModels;
		const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
		builtinModelId = getBuiltinModels("anthropic")[0].id;
	});

	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_HUB_DIR;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function writeModelInput(profileName: string, content: unknown): void {
		const dir = path.join(profilesDir, profileName);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "model-input.json"), JSON.stringify(content));
	}

	it("converts an unknown plain id on a builtin provider into a custom model definition that accepts text and images", () => {
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text", "image"] },
		]);
	});

	it("keeps ids known to the builtin catalog as plain ids", () => {
		const profile = { name: "p", provider: "anthropic", models: [builtinModelId] };
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("keeps qualified provider/model ids as plain ids", () => {
		const profile = { name: "p", provider: "anthropic", models: ["acme-gw/anything"] };
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("pins input modalities from the profile's model-input.json, overriding the default", () => {
		writeModelInput("p", { "acme-unknown-model": ["text"] });
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text"] }]);
	});

	it("lets model-input.json override an explicit definition input", () => {
		writeModelInput("p", { "acme-defined": ["text"] });
		const profile = {
			name: "p",
			provider: "anthropic",
			models: [{ id: "acme-defined", name: "Acme", input: ["text", "image"] }],
		};
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([{ id: "acme-defined", name: "Acme", input: ["text"] }]);
	});

	it("ignores a malformed model-input.json", () => {
		writeModelInput("p", { "acme-unknown-model": ["audio"], other: "nope" });
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text", "image"] },
		]);
	});

	it("introduces a model declared only in model-input.json", () => {
		writeModelInput("p", { "acme-extra": ["text"] });
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text", "image"] },
			{ id: "acme-extra", name: "acme-extra", input: ["text"] },
		]);
	});

	it("introduces models into a profile that declares none", () => {
		writeModelInput("p", { "acme-extra": ["text", "image"] });
		const profile = { name: "p", provider: "anthropic" };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([{ id: "acme-extra", name: "acme-extra", input: ["text", "image"] }]);
	});

	it("skips model-input.json entries that name a builtin catalog model not in the profile", () => {
		writeModelInput("p", { [builtinModelId]: ["text"] });
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).not.toContain(builtinModelId);
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text", "image"] },
		]);
	});

	it("skips qualified ids in model-input.json", () => {
		writeModelInput("p", { "other/model": ["text"] });
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile, "p");
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "acme-unknown-model", input: ["text", "image"] },
		]);
	});

	it("defaults an explicit custom model definition without input to text and images", () => {
		const profile = {
			name: "p",
			provider: "anthropic",
			models: [{ id: "acme-unknown-model", name: "Acme", reasoning: true }],
		};
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([
			{ id: "acme-unknown-model", name: "Acme", reasoning: true, input: ["text", "image"] },
		]);
	});

	it("keeps an explicit custom model definition with declared input untouched", () => {
		const profile = {
			name: "p",
			provider: "anthropic",
			models: [{ id: "acme-unknown-model", name: "Acme", input: ["text"] }],
		};
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("adds an openai-completions api for a provider with no catalogue at all", () => {
		const profile = { name: "p", provider: "acme-gw", models: ["acme-custom"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([
			{ id: "acme-custom", name: "acme-custom", input: ["text", "image"], api: "openai-completions" },
		]);
	});

	it("treats ids served by the fetched catalogue as known", () => {
		fs.writeFileSync(
			path.join(agentDir, "models-store.json"),
			JSON.stringify({ "acme-gw": { models: [{ id: "acme-fetched" }] } }),
		);
		const profile = { name: "p", provider: "acme-gw", models: ["acme-fetched", "acme-custom"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([
			"acme-fetched",
			{ id: "acme-custom", name: "acme-custom", input: ["text", "image"] },
		]);
	});

	it("returns the profile unchanged when there is no provider or no plain ids", () => {
		const noProvider = { name: "p", models: ["acme-unknown-model"] };
		expect(withAutoCustomModels(noProvider)).toBe(noProvider);
		const noModels = { name: "p", provider: "anthropic" };
		expect(withAutoCustomModels(noModels)).toBe(noModels);
	});
});
