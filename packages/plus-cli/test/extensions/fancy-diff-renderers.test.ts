/**
 * Tests for pi-plus-fancy-diff's renderer wiring: the tool-render resolver
 * (passthrough / takeover), the write pre-image tool_call handler, the edit
 * preview + result flow with its replay guard, and the write overwrite swap.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderContext,
	ToolRendererResolver,
	ToolRenderers,
	ToolRenderResultOptions,
} from "../../../coding-agent/src/core/extensions/types.ts";
import type { EditDiffResult } from "../../../coding-agent/src/core/tools/edit-diff.ts";
import { initTheme, type Theme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../coding-agent/src/utils/ansi.ts";
import { registerFancyDiff } from "../../src/extensions/fancy-diff/index.ts";
import { clearWritePreImages, peekWritePreImage } from "../../src/extensions/fancy-diff/preimage.ts";

initTheme("dark");

interface Capture {
	handlers: Map<string, (event: never, ctx: ExtensionContext) => unknown>;
	resolver: ToolRendererResolver;
}

function captureFancyDiff(): Capture {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const resolvers: ToolRendererResolver[] = [];
	const pi = {
		on: (event: string, handler: never) => handlers.set(event, handler),
		registerToolRenderer: (resolver: ToolRendererResolver) => resolvers.push(resolver),
	} as unknown as ExtensionAPI;
	registerFancyDiff(pi);
	assert.equal(resolvers.length, 1);
	return { handlers, resolver: resolvers[0] };
}

function fakeContext(overrides: Partial<Record<string, unknown>> = {}): ToolRenderContext {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/home/user/proj",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...overrides,
	} as unknown as ToolRenderContext;
}

const RESULT_OPTIONS: ToolRenderResultOptions = { expanded: false, isPartial: false };

function baseRenderers(): Required<ToolRenderers> & { calls: { call: number; result: number } } {
	const calls = { call: 0, result: 0 };
	return {
		renderShell: "default",
		calls,
		renderCall(_args: unknown, _theme: Theme, context: ToolRenderContext) {
			calls.call++;
			const component = (context.state.callComponent as Text | undefined) ?? new Text("", 0, 0);
			component.setText("base content view");
			return component;
		},
		renderResult() {
			calls.result++;
			return new Container();
		},
	};
}

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-plus-fancy-diff-"));
}

beforeEach(() => {
	clearWritePreImages();
});

describe("tool-render resolver", () => {
	it("passes non-target tools through untouched", () => {
		const { resolver } = captureFancyDiff();
		const base = baseRenderers();
		assert.equal(
			resolver("read", () => base),
			base,
		);
		assert.equal(
			resolver("bash", () => base),
			base,
		);
	});

	it("takes over edit and write while keeping renderShell from the base", () => {
		const { resolver } = captureFancyDiff();
		const base = baseRenderers();
		const edit = resolver("edit", () => base)!;
		const write = resolver("write", () => base)!;
		assert.equal(edit.renderShell, "default");
		assert.equal(write.renderShell, "default");
		assert.notEqual(edit.renderCall, base.renderCall);
		assert.notEqual(edit.renderResult, base.renderResult);
		assert.notEqual(write.renderResult, base.renderResult);
	});

	it("delegates write renderCall to the base (streaming content view)", () => {
		const { resolver } = captureFancyDiff();
		const base = baseRenderers();
		const write = resolver("write", () => base)!;
		const context = fakeContext();
		const component = write.renderCall!({ path: "a.txt", content: "x" } as never, theme, context) as Text;
		assert.equal(base.calls.call, 1);
		assert.equal(stripAnsi(component.render(80).join("\n")).trim(), "base content view");
		assert.equal(context.state.callComponent, component);
	});
});

describe("write pre-image handler", () => {
	it("stashes the previous content of an existing file", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "a.txt"), "one\ntwo\nthree");
			const { handlers } = captureFancyDiff();
			const ctx = { mode: "tui", cwd: dir } as unknown as ExtensionContext;
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w1",
					input: { path: "a.txt", content: "new" },
				} as never,
				ctx,
			);
			const pre = peekWritePreImage("w1");
			assert.ok(pre);
			assert.equal(pre.content, "one\ntwo\nthree");
			assert.equal(pre.lines, 3);
			assert.equal(pre.absolutePath, join(dir, "a.txt"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not count a trailing newline as an extra line", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
			const { handlers } = captureFancyDiff();
			const ctx = { mode: "tui", cwd: dir } as unknown as ExtensionContext;
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w13",
					input: { path: "a.txt", content: "new" },
				} as never,
				ctx,
			);
			const pre = peekWritePreImage("w13");
			assert.ok(pre);
			assert.equal(pre.lines, 3);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("records a missing file as a new file (null content)", async () => {
		const dir = await tempDir();
		try {
			const { handlers } = captureFancyDiff();
			const ctx = { mode: "tui", cwd: dir } as unknown as ExtensionContext;
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w2",
					input: { path: "b.txt", content: "new" },
				} as never,
				ctx,
			);
			const pre = peekWritePreImage("w2");
			assert.ok(pre);
			assert.equal(pre.content, null);
			assert.equal(pre.lines, 0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores non-TUI modes and other tools", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "a.txt"), "x");
			const { handlers } = captureFancyDiff();
			const fire = handlers.get("tool_call")!;
			await fire(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w3",
					input: { path: "a.txt", content: "new" },
				} as never,
				{ mode: "print", cwd: dir } as unknown as ExtensionContext,
			);
			await fire(
				{ type: "tool_call", toolName: "read", toolCallId: "w4", input: { path: "a.txt" } } as never,
				{ mode: "tui", cwd: dir } as unknown as ExtensionContext,
			);
			assert.equal(peekWritePreImage("w3"), undefined);
			assert.equal(peekWritePreImage("w4"), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("swallows read failures without blocking", async () => {
		const dir = await tempDir();
		try {
			const { handlers } = captureFancyDiff();
			const ctx = { mode: "tui", cwd: dir } as unknown as ExtensionContext;
			await handlers.get("tool_call")?.(
				// Path is a directory: readFile fails with EISDIR, the handler must not throw.
				{ type: "tool_call", toolName: "write", toolCallId: "w5", input: { path: ".", content: "new" } } as never,
				ctx,
			);
			assert.equal(peekWritePreImage("w5"), undefined);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("edit renderers", () => {
	type CallComponent = BoxLike & {
		preview?: EditDiffResult | { error: string };
		previewPending?: boolean;
		resultApplied?: boolean;
	};
	type BoxLike = Container;

	it("renders the async preview into the call component with stats header", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "x.ts"), "const a = 1\nconst b = 2\n");
			const { resolver } = captureFancyDiff();
			const edit = resolver("edit", () => baseRenderers())!;
			const args = { path: "x.ts", edits: [{ oldText: "const b = 2", newText: "const b = 3" }] };
			const context = fakeContext({ cwd: dir, toolCallId: "e1", args });
			const component = edit.renderCall!(args as never, theme, context) as CallComponent;
			assert.ok(component);
			await vi.waitFor(() => {
				assert.ok(component.preview);
			});
			const text = stripAnsi(component.render(120).join("\n"));
			assert.ok(text.includes("edit"));
			assert.ok(text.includes("x.ts"));
			assert.ok(text.includes("+1"));
			assert.ok(text.includes("−1"));
			assert.ok(text.includes("typescript"));
			assert.ok(text.includes("const b = 3"));
			assert.equal(component.resultApplied, false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("applies the result diff and leaves the result slot empty when it matches the preview", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "x.txt"), "alpha\nbeta\ngamma\n");
			const { resolver } = captureFancyDiff();
			const edit = resolver("edit", () => baseRenderers())!;
			const args = { path: "x.txt", edits: [{ oldText: "beta", newText: "BETA" }] };
			const state: Record<string, unknown> = {};
			const context = fakeContext({ cwd: dir, toolCallId: "e2", args, state });
			const component = edit.renderCall!(args as never, theme, context) as CallComponent;
			await vi.waitFor(() => assert.ok(component.preview));
			const preview = component.preview as EditDiffResult;

			const result = {
				content: [{ type: "text", text: "Successfully edited x.txt" }],
				details: { diff: preview.diff, patch: "", firstChangedLine: 2 },
			};
			const slot = edit.renderResult!(result as never, RESULT_OPTIONS, theme, context);
			assert.equal(component.resultApplied, true);
			const slotText = stripAnsi(slot.render(120).join("\n")).trim();
			assert.equal(slotText, "");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("replay guard: a late preview error never overwrites the settled result diff", async () => {
		const dir = await tempDir();
		try {
			// The edit has already been applied on disk; a fresh preview would fail.
			await writeFile(join(dir, "x.txt"), "alpha\nBETA\ngamma\n");
			const { resolver } = captureFancyDiff();
			const edit = resolver("edit", () => baseRenderers())!;
			const args = { path: "x.txt", edits: [{ oldText: "beta", newText: "BETA" }] };
			const state: Record<string, unknown> = {};
			const context = fakeContext({ cwd: dir, toolCallId: "e3", args, state });

			// renderCall kicks off the (failing) computeEditsDiff in the background.
			const component = edit.renderCall!(args as never, theme, context) as CallComponent;
			// The settled transcript's result lands first (transcript replay).
			const settledDiff = " 1 alpha\n-2 beta\n+2 BETA\n 3 gamma";
			const result = {
				content: [{ type: "text", text: "Successfully edited x.txt" }],
				details: { diff: settledDiff, patch: "", firstChangedLine: 2 },
			};
			edit.renderResult!(result as never, RESULT_OPTIONS, theme, context);

			// When the background preview resolves, the guard must drop it.
			await vi.waitFor(() => {
				assert.equal(component.previewPending, false);
			});
			const preview = component.preview as EditDiffResult;
			assert.ok(preview);
			assert.ok(!("error" in preview));
			assert.equal(preview.diff, settledDiff);
			assert.ok(stripAnsi(component.render(120).join("\n")).includes("BETA"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("write renderers", () => {
	it("swaps an overwrite result to the old-vs-new diff, surviving stash eviction", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "a.txt"), "one\ntwo\nthree");
			const { handlers, resolver } = captureFancyDiff();
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w10",
					input: { path: "a.txt", content: "one\nTWO\nthree" },
				} as never,
				{ mode: "tui", cwd: dir } as unknown as ExtensionContext,
			);

			const base = baseRenderers();
			const write = resolver("write", () => base)!;
			const state: Record<string, unknown> = {};
			const context = fakeContext({
				cwd: dir,
				toolCallId: "w10",
				state,
				args: { path: "a.txt", content: "one\nTWO\nthree" },
			});
			write.renderCall!(context.args as never, theme, context);
			const component = state.callComponent as Text;
			write.renderResult!(
				{ content: [{ type: "text", text: "Successfully wrote to a.txt" }], details: undefined } as never,
				RESULT_OPTIONS,
				theme,
				context,
			);

			let text = stripAnsi(component.render(200).join("\n"));
			assert.ok(text.includes("write"));
			assert.ok(text.includes("a.txt"));
			assert.ok(text.includes("+1"));
			assert.ok(text.includes("−1"));
			assert.ok(text.includes("TWO"));
			assert.ok(text.includes("overwrite, was 3 lines"));

			// A later re-render (theme switch) runs renderCall (which repaints the
			// content view) then renderResult — after the stash was cleared, the
			// component-cached pre-image must rebuild the diff.
			clearWritePreImages();
			write.renderCall!(context.args as never, theme, context);
			assert.equal(stripAnsi(component.render(200).join("\n")).trim(), "base content view");
			write.renderResult!(
				{ content: [{ type: "text", text: "Successfully wrote to a.txt" }], details: undefined } as never,
				RESULT_OPTIONS,
				theme,
				context,
			);
			text = stripAnsi(component.render(200).join("\n"));
			assert.ok(text.includes("TWO"));
			assert.ok(text.includes("one"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps the base content view for new files", async () => {
		const dir = await tempDir();
		try {
			const { handlers, resolver } = captureFancyDiff();
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w11",
					input: { path: "b.txt", content: "brand new" },
				} as never,
				{ mode: "tui", cwd: dir } as unknown as ExtensionContext,
			);
			const base = baseRenderers();
			const write = resolver("write", () => base)!;
			const context = fakeContext({ cwd: dir, toolCallId: "w11", args: { path: "b.txt", content: "brand new" } });
			const component = write.renderCall!(context.args as never, theme, context) as Text;
			write.renderResult!(
				{ content: [{ type: "text", text: "Successfully wrote to b.txt" }], details: undefined } as never,
				RESULT_OPTIONS,
				theme,
				context,
			);
			const text = stripAnsi(component.render(200).join("\n"));
			assert.equal(text.trim(), "base content view");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("delegates error results to the base", async () => {
		const dir = await tempDir();
		try {
			await writeFile(join(dir, "a.txt"), "old");
			const { handlers, resolver } = captureFancyDiff();
			await handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "write",
					toolCallId: "w12",
					input: { path: "a.txt", content: "new" },
				} as never,
				{ mode: "tui", cwd: dir } as unknown as ExtensionContext,
			);
			const base = baseRenderers();
			const write = resolver("write", () => base)!;
			const context = fakeContext({
				cwd: dir,
				toolCallId: "w12",
				isError: true,
				args: { path: "a.txt", content: "new" },
			});
			const component = write.renderCall!(context.args as never, theme, context) as Text;
			write.renderResult!(
				{ content: [{ type: "text", text: "Error writing" }], details: undefined } as never,
				RESULT_OPTIONS,
				theme,
				context,
			);
			assert.equal(stripAnsi(component.render(200).join("\n")).trim(), "base content view");
			assert.equal(base.calls.result, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
