// Tests for the p2-side wrappers (src/p2/): the extended SlashCompletion completes `/name` tokens anywhere
// in the line, FileCompletionProvider routes those tokens to the slash provider, and the extended
// shouldTriggerFileCompletion distinguishes tokens from paths. Run with p2's source loader registered
// (see the test script) so the wrappers' upstream imports resolve.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AutocompleteItem } from "../../tui/src/index.ts";
import { shouldTriggerFileCompletion } from "../src/p2/runtime-completion.ts";
import { SlashCompletion } from "../src/p2/tui-commands.ts";
import { FileCompletionProvider } from "../src/p2/tui-completion.ts";

const DISPATCHER = {
	contexts: () => ({}),
	list: () => [
		{ slash: "files", command: { title: "Browse files" } },
		{ slash: "exit", command: { title: "Exit" } },
	],
	getArgumentCompletions: async (): Promise<AutocompleteItem[] | null> => null,
};

const SIGNAL = new AbortController().signal;

describe("p2 SlashCompletion", () => {
	test("completes a `/name` token after other text", async () => {
		const slash = new SlashCompletion(DISPATCHER);
		const result = await slash.getSuggestions(["please run /fi"], 0, 14, { signal: SIGNAL });
		assert.ok(result);
		assert.equal(result.prefix, "/fi");
		assert.deepEqual(
			result.items.map((i) => i.value),
			["files"],
		);
	});

	test("applyCompletion inserts the command inline with a trailing space", async () => {
		const slash = new SlashCompletion(DISPATCHER);
		const result = await slash.getSuggestions(["please run /fi"], 0, 14, { signal: SIGNAL });
		assert.ok(result);
		const applied = slash.applyCompletion(["please run /fi"], 0, 14, result.items[0], result.prefix);
		assert.equal(applied.lines[0], "please run /files ");
	});

	test("returns null for a path-like token", async () => {
		const slash = new SlashCompletion(DISPATCHER);
		const result = await slash.getSuggestions(["please run /usr/lo"], 0, 19, { signal: SIGNAL });
		assert.equal(result, null);
	});

	test("lone line-start command keeps upstream behavior", async () => {
		const slash = new SlashCompletion(DISPATCHER);
		const result = await slash.getSuggestions(["/fi"], 0, 3, { signal: SIGNAL });
		assert.ok(result);
		assert.equal(result.prefix, "/fi");
		assert.equal(result.items[0]?.value, "files");
	});
});

describe("p2 FileCompletionProvider", () => {
	test("routes a mid-text token to the slash provider", async () => {
		const slash = new SlashCompletion(DISPATCHER);
		const files = new FileCompletionProvider(
			slash,
			() => undefined,
			() => {},
		);
		const result = await files.getSuggestions(["please run /fi"], 0, 14, { signal: SIGNAL });
		assert.ok(result);
		assert.deepEqual(
			result.items.map((i) => i.value),
			["files"],
		);
		const applied = files.applyCompletion(["please run /fi"], 0, 14, result.items[0], result.prefix);
		assert.equal(applied.lines[0], "please run /files ");
	});

	test("token declines forced file completion, path allows it", () => {
		const slash = new SlashCompletion(DISPATCHER);
		const files = new FileCompletionProvider(
			slash,
			() => undefined,
			() => {},
		);
		assert.equal(files.shouldTriggerFileCompletion(["please run /fi"], 0, 14), false);
		assert.equal(files.shouldTriggerFileCompletion(["please run /usr/lo"], 0, 19), true);
	});
});

describe("p2 shouldTriggerFileCompletion", () => {
	test("declines slash tokens, allows paths and empty text", () => {
		assert.equal(shouldTriggerFileCompletion("please run /fi"), false);
		assert.equal(shouldTriggerFileCompletion("/fi"), false);
		assert.equal(shouldTriggerFileCompletion("please run /usr/lo"), true);
		assert.equal(shouldTriggerFileCompletion(""), false);
	});
});
