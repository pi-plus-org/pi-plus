/**
 * Tests for pi-plus-fancy-diff's pure renderer: +N −M stats counting, marker /
 * gutter / body styling, syntax-highlighted bodies, word-level emphasis, the ⋮
 * omission separator, the change header, and the diff-fill scoping (changed
 * lines filled; context lines, separators, and headers unfilled).
 */

import assert from "node:assert/strict";
import { beforeAll, describe, it, vi } from "vitest";

// theme.bold/italic/inverse go through chalk, which strips styling when stdout is
// not a TTY. Force color so the emphasis assertions observe the real sequences.
vi.hoisted(() => {
	process.env.FORCE_COLOR = "1";
});

import { generateDiffString } from "../../../coding-agent/src/core/tools/edit-diff.ts";
import {
	getLanguageFromPath,
	highlightCode,
	initTheme,
	theme,
} from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../coding-agent/src/utils/ansi.ts";
import { formatChangeHeader, parseDiffStats, renderFancyDiff } from "../../src/extensions/fancy-diff/fancy-diff.ts";

beforeAll(() => {
	initTheme("dark");
});

// Background SGRs (40-47, 48;…, 100-107) — allowed only on changed diff lines.
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]m|48;|10[0-7]m|107;)/;

function renderDiff(diff: string, rawPath: string | null): string {
	return renderFancyDiff({ diff, rawPath, theme });
}

describe("parseDiffStats", () => {
	it("counts added and removed lines", () => {
		const { diff } = generateDiffString("one\ntwo\nthree", "one\nTWO\nthree\nfour");
		// jsdiff's line alignment re-groups three/four, so the display diff carries
		// two removed and three added lines.
		assert.deepEqual(parseDiffStats(diff), { added: 3, removed: 2 });
	});

	it("ignores omission separators", () => {
		const oldContent = Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n");
		const newContent = oldContent.replace("line0", "LINE0").replace("line29", "LINE29");
		const { diff } = generateDiffString(oldContent, newContent);
		assert.deepEqual(parseDiffStats(diff), { added: 2, removed: 2 });
	});
});

describe("renderFancyDiff — plain (no language)", () => {
	const plain = () => renderDiff(generateDiffString("alpha\nbeta", "alpha\ngamma").diff, "notes.txt");

	it("keeps one rendered line per diff line", () => {
		const { diff } = generateDiffString("alpha\nbeta", "alpha\ngamma");
		assert.equal(plain().split("\n").length, diff.split("\n").length);
	});

	it("renders context, removed, and added content in order", () => {
		const text = stripAnsi(plain());
		assert.ok(text.includes("alpha"));
		assert.ok(text.includes("-"));
		assert.ok(text.includes("beta"));
		assert.ok(text.includes("+"));
		assert.ok(text.includes("gamma"));
	});

	it("colors markers with the diff tokens and tints plain bodies per line kind", () => {
		assert.ok(plain().includes(theme.fg("toolDiffRemoved", "-")));
		assert.ok(plain().includes(theme.fg("toolDiffAdded", "+")));
		// Whole removed body keeps the red tint like upstream.
		assert.ok(plain().includes(theme.fg("toolDiffRemoved", theme.inverse("beta"))));
	});

	it("uses inverse for word emphasis when the language is unknown", () => {
		assert.ok(plain().includes("\x1b[7m"));
	});
});

describe("renderFancyDiff — syntax-highlighted body", () => {
	const { diff } = generateDiffString("const x = 1", "const x = 2");
	const ts = () => renderDiff(diff, "app.ts");

	it("resolves the language from the path", () => {
		assert.equal(getLanguageFromPath("app.ts"), "typescript");
	});

	it("carries keyword syntax colors in the body", () => {
		// Chunked word-diff keeps "const x = " as an unchanged fragment; highlighting it
		// colors the keyword through the same theme tokens the body uses.
		const highlighted = highlightCode("const x = ", "typescript")[0] ?? "";
		assert.ok(ts().includes(highlighted));
	});

	it("bolds changed chunks instead of inverse when a language is active", () => {
		assert.ok(ts().includes("\x1b[1m"));
		assert.ok(!ts().includes("\x1b[7m"));
	});

	it("keeps the plain text intact", () => {
		const text = stripAnsi(ts());
		assert.ok(text.includes("const x = 1"));
		assert.ok(text.includes("const x = 2"));
	});
});

describe("renderFancyDiff — omission separator", () => {
	it("renders the elided-context marker as a quiet ⋮", () => {
		const oldContent = Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n");
		const newContent = oldContent.replace("line0", "LINE0");
		const { diff } = generateDiffString(oldContent, newContent);
		assert.ok(diff.includes("..."));
		const rendered = renderDiff(diff, "plain.txt");
		assert.ok(stripAnsi(rendered).includes("⋮"));
	});
});

describe("formatChangeHeader", () => {
	it("shows action, path, stats, and language badge", () => {
		const header = formatChangeHeader("edit", "src/foo.ts", theme, "/tmp", { stats: { added: 2, removed: 1 } });
		const text = stripAnsi(header).replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
		assert.ok(text.includes("edit"));
		assert.ok(text.includes("src/foo.ts"));
		assert.ok(text.includes("+2"));
		assert.ok(text.includes("−1"));
		assert.ok(text.includes("typescript"));
	});

	it("omits an empty stats section", () => {
		const header = formatChangeHeader("edit", "src/foo.ts", theme, "/tmp", { stats: { added: 0, removed: 0 } });
		assert.ok(!stripAnsi(header).includes("+0"));
	});

	it("renders a note", () => {
		const header = formatChangeHeader("write", "a.txt", theme, "/tmp", { note: "overwrite, was 3 lines" });
		assert.ok(stripAnsi(header).includes("overwrite, was 3 lines"));
	});
});

describe("diff fills", () => {
	// A modified line (1:1 pair) and a pure replacement, with and without syntax
	// highlighting: every changed row gets a background fill in both styles.
	it("fills added and removed lines, leaves context lines unfilled", () => {
		for (const path of ["app.ts", "notes.txt"]) {
			const { diff } = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
			const lines = renderDiff(diff, path).split("\n");
			const changed = lines.filter((line) => /^[+-]/.test(stripAnsi(line)));
			const context = lines.filter((line) => !/^[+-]/.test(stripAnsi(line)));
			assert.ok(changed.length >= 2, `expected changed lines for ${path}`);
			assert.ok(
				changed.every((line) => BACKGROUND_SGR.test(line)),
				`changed line without fill for ${path}`,
			);
			assert.ok(
				context.every((line) => !BACKGROUND_SGR.test(line)),
				`unfilled line got a background for ${path}`,
			);
		}
	});

	it("does not fill the omission separator", () => {
		const oldContent = Array.from({ length: 30 }, (_, index) => `line${index}`).join("\n");
		const newContent = oldContent.replace("line0", "LINE0");
		const { diff } = generateDiffString(oldContent, newContent);
		const separator = renderDiff(diff, "app.ts")
			.split("\n")
			.find((line) => stripAnsi(line).includes("⋮"));
		assert.ok(separator);
		assert.ok(!BACKGROUND_SGR.test(separator));
	});

	it("keeps the change header unfilled", () => {
		const header = formatChangeHeader("edit", "src/foo.ts", theme, "/tmp", { stats: { added: 2, removed: 1 } });
		assert.ok(!BACKGROUND_SGR.test(header));
	});
});
