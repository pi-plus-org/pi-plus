// Tests for the extended CombinedAutocompleteProvider: `/name` tokens anywhere in the line complete slash
// commands; forced (Tab) completion still completes single-segment paths; applyCompletion distinguishes the two.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

function makeProvider(commands: { name: string; description?: string }[]): CombinedAutocompleteProvider {
	const dir = mkdtempSync(join(tmpdir(), "plus-tui-ac-"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "usr-file.txt"), "");
	return new CombinedAutocompleteProvider(commands as never, dir);
}

// Command names are bare (no leading "/"), matching how coding-agent builds them.
const SIGNAL = new AbortController().signal;

const COMMANDS = [
	{ name: "review", description: "review changes" },
	{ name: "add-dir", description: "add a directory" },
];

describe("mid-text slash completion", () => {
	test("completes a `/name` token after other text", async () => {
		const provider = makeProvider(COMMANDS);
		const result = await provider.getSuggestions(["please run /rev"], 0, 15, { signal: SIGNAL });
		assert.ok(result);
		assert.equal(result.prefix, "/rev");
		assert.deepEqual(
			result.items.map((i) => i.value),
			["review"],
		);
	});

	test("a path-like token still completes as files, not commands", async () => {
		const provider = makeProvider(COMMANDS);
		const result = await provider.getSuggestions(["open /usr/lo"], 0, 12, { signal: SIGNAL });
		assert.ok(result);
		assert.equal(result.prefix, "/usr/lo");
		assert.ok(!result.items.some((i) => i.value === "review" || i.value === "add-dir"));
	});

	test("forced completion of a real path still returns files, not commands", async () => {
		const provider = makeProvider(COMMANDS);
		const result = await provider.getSuggestions(["/usr/lo"], 0, 7, { signal: SIGNAL, force: true });
		assert.ok(result);
		assert.ok(!result.items.some((i) => i.value === "review" || i.value === "add-dir"));
	});

	test("applyCompletion replaces the token inline for both lone and mid-text commands", async () => {
		const provider = makeProvider(COMMANDS);
		const mid = await provider.getSuggestions(["please run /rev"], 0, 15, { signal: SIGNAL });
		assert.ok(mid);
		const midApplied = provider.applyCompletion(["please run /rev"], 0, 15, mid.items[0], mid.prefix);
		assert.equal(midApplied.lines[0], "please run /review ");

		const lone = await provider.getSuggestions(["/rev"], 0, 4, { signal: SIGNAL });
		assert.ok(lone);
		const loneApplied = provider.applyCompletion(["/rev"], 0, 4, lone.items[0], lone.prefix);
		assert.equal(loneApplied.lines[0], "/review ");
	});

	test("shouldTriggerFileCompletion declines a slash token but allows paths", () => {
		const provider = makeProvider(COMMANDS);
		assert.equal(provider.shouldTriggerFileCompletion?.(["please run /rev"], 0, 15), false);
		assert.equal(provider.shouldTriggerFileCompletion?.(["please run /usr/lo"], 0, 16), true);
	});
});
