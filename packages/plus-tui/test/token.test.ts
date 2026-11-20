// Tests for extractSlashCommandToken: the `/name` token ending at the cursor, anywhere in the line.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractSlashCommandToken } from "../src/token.ts";

describe("extractSlashCommandToken", () => {
	test("matches a token at the start of the line", () => {
		assert.equal(extractSlashCommandToken("/rev"), "/rev");
		assert.equal(extractSlashCommandToken("/"), "/");
	});

	test("matches a token mid-text after a space", () => {
		assert.equal(extractSlashCommandToken("please run /rev"), "/rev");
		assert.equal(extractSlashCommandToken("please run /"), "/");
	});

	test("matches after punctuation and quotes", () => {
		assert.equal(extractSlashCommandToken("run (/rev"), "/rev");
		assert.equal(extractSlashCommandToken('say "/rev'), "/rev");
		assert.equal(extractSlashCommandToken("查看，/rev"), "/rev");
	});

	test("does not match word continuations", () => {
		assert.equal(extractSlashCommandToken("src/"), null);
		assert.equal(extractSlashCommandToken("http://"), null);
		assert.equal(extractSlashCommandToken("a/b/c"), null);
	});

	test("does not match paths with a second slash", () => {
		assert.equal(extractSlashCommandToken("/usr/lo"), null);
		assert.equal(extractSlashCommandToken("open /usr/lo"), null);
	});

	test("only the last token counts", () => {
		assert.equal(extractSlashCommandToken("/rev then /add"), "/add");
		assert.equal(extractSlashCommandToken("/rev then text"), null);
	});
});
