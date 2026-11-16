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
	let withAutoCustomModels: typeof import("../../src/hub/custom-models.ts").withAutoCustomModels;
	let builtinModelId: string;

	beforeAll(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plus-custom-models-"));
		agentDir = path.join(tmp, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Must be set before pi-hub's config.ts evaluates AGENT_DIR.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const mod = await import("../../src/hub/custom-models.ts");
		withAutoCustomModels = mod.withAutoCustomModels;
		const { getBuiltinModels } = await import("@earendil-works/pi-ai/providers/all");
		builtinModelId = getBuiltinModels("anthropic")[0].id;
	});

	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("converts an unknown plain id on a builtin provider into a custom model definition", () => {
		const profile = { name: "p", provider: "anthropic", models: ["acme-unknown-model"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([{ id: "acme-unknown-model", name: "acme-unknown-model" }]);
	});

	it("keeps ids known to the builtin catalog as plain ids", () => {
		const profile = { name: "p", provider: "anthropic", models: [builtinModelId] };
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("keeps qualified provider/model ids as plain ids", () => {
		const profile = { name: "p", provider: "anthropic", models: ["acme-gw/anything"] };
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("keeps existing custom model definitions untouched", () => {
		const profile = {
			name: "p",
			provider: "anthropic",
			models: [{ id: "acme-unknown-model", name: "Acme", reasoning: true }],
		};
		expect(withAutoCustomModels(profile)).toBe(profile);
	});

	it("adds an openai-completions api for a provider with no catalogue at all", () => {
		const profile = { name: "p", provider: "acme-gw", models: ["acme-custom"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual([{ id: "acme-custom", name: "acme-custom", api: "openai-completions" }]);
	});

	it("treats ids served by the fetched catalogue as known", () => {
		fs.writeFileSync(
			path.join(agentDir, "models-store.json"),
			JSON.stringify({ "acme-gw": { models: [{ id: "acme-fetched" }] } }),
		);
		const profile = { name: "p", provider: "acme-gw", models: ["acme-fetched", "acme-custom"] };
		const result = withAutoCustomModels(profile);
		expect(result.models).toEqual(["acme-fetched", { id: "acme-custom", name: "acme-custom" }]);
	});

	it("returns the profile unchanged when there is no provider or no plain ids", () => {
		const noProvider = { name: "p", models: ["acme-unknown-model"] };
		expect(withAutoCustomModels(noProvider)).toBe(noProvider);
		const noModels = { name: "p", provider: "anthropic" };
		expect(withAutoCustomModels(noModels)).toBe(noModels);
	});
});
