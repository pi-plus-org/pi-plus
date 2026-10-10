/**
 * Tests for pi-plus-changes: the first-touch ledger snapshots taken in the
 * tool_call handler, the report builder's classification / totals / caps, and
 * the /changes command with its entry rendering (header, per-file fancy diff,
 * diff fills scoped to changed lines).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

// theme.bold goes through chalk, which strips styling when stdout is not a TTY.
// Force color so the rendering exercises the real emphasis path.
vi.hoisted(() => {
	process.env.FORCE_COLOR = "1";
});

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "../../../coding-agent/src/core/extensions/types.ts";
import { initTheme, theme } from "../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../coding-agent/src/utils/ansi.ts";
import { registerChanges } from "../../src/extensions/changes/index.ts";
import {
	clearLedger,
	getLedgerEntries,
	handleToolCallForLedger,
	type LedgerEntry,
} from "../../src/extensions/changes/ledger.ts";
import { buildChangesReport, type ChangesReport } from "../../src/extensions/changes/report.ts";

initTheme("dark");

// Background SGRs (40-47, 48;…, 100-107) — allowed only on changed diff lines.
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]m|48;|10[0-7]m|107;)/;

function toolCallEvent(toolName: string, input: Record<string, string>, id = "call-1"): ToolCallEvent {
	return { type: "tool_call", toolCallId: id, toolName, input } as unknown as ToolCallEvent;
}

function tuiCtx(cwd: string): ExtensionContext {
	return { mode: "tui", cwd } as unknown as ExtensionContext;
}

function ledgerEntry(rawPath: string, absolutePath: string, base: string | null, tooLarge = false): LedgerEntry {
	return { rawPath, absolutePath, base, tooLarge };
}

describe("ledger — first-touch snapshots", () => {
	let dir: string;

	beforeEach(async () => {
		clearLedger();
		dir = await mkdtemp(join(tmpdir(), "pi-changes-ledger-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("records null baseline when the file does not exist (new/unversioned file)", async () => {
		await handleToolCallForLedger(toolCallEvent("write", { path: join(dir, "fresh.ts") }), tuiCtx(dir));
		const entries = getLedgerEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0].base, null);
		assert.equal(entries[0].tooLarge, false);
	});

	it("captures the LF-normalized baseline of an existing file", async () => {
		const path = join(dir, "crlf.txt");
		await writeFile(path, "a\r\nb\r\n", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { path }), tuiCtx(dir));
		const entries = getLedgerEntries();
		assert.equal(entries[0].base, "a\nb\n");
	});

	it("keeps the first baseline when the file is touched again", async () => {
		const path = join(dir, "twice.txt");
		await writeFile(path, "v1", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { path }), tuiCtx(dir));
		await writeFile(path, "v2", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { path }), tuiCtx(dir));
		const entries = getLedgerEntries();
		assert.equal(entries.length, 1);
		assert.equal(entries[0].base, "v1");
	});

	it("accepts the file_path alias some providers emit", async () => {
		const path = join(dir, "alias.txt");
		await writeFile(path, "base", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { file_path: path }), tuiCtx(dir));
		assert.equal(getLedgerEntries()[0].base, "base");
	});

	it("ignores non-tui modes and other tools", async () => {
		const path = join(dir, "ignored.txt");
		await writeFile(path, "x", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { path }), {
			mode: "print",
			cwd: dir,
		} as unknown as ExtensionContext);
		await handleToolCallForLedger(toolCallEvent("read", { path }), tuiCtx(dir));
		assert.deepEqual(getLedgerEntries(), []);
	});

	it("leaves unreadable paths untracked without throwing (must never block the tool call)", async () => {
		// A directory read fails with EISDIR — a wrong baseline is worse than none.
		await handleToolCallForLedger(toolCallEvent("edit", { path: dir }), tuiCtx(dir));
		assert.deepEqual(getLedgerEntries(), []);
	});

	it("marks files over the snapshot cap as tooLarge instead of storing them", async () => {
		const path = join(dir, "huge.txt");
		await writeFile(path, "x".repeat(300 * 1024), "utf-8");
		await handleToolCallForLedger(toolCallEvent("write", { path }), tuiCtx(dir));
		const entries = getLedgerEntries();
		assert.equal(entries[0].tooLarge, true);
		assert.equal(entries[0].base, null);
	});
});

describe("report builder", () => {
	function reader(contents: Map<string, string | null>) {
		return async (absolutePath: string): Promise<string | null> => {
			if (!contents.has(absolutePath)) throw new Error(`unexpected read of ${absolutePath}`);
			// null value means the file is gone (ENOENT contract); throws are reserved
			// for unreadable failures.
			return contents.get(absolutePath) ?? null;
		};
	}

	it("classifies new files as all-added", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("new.ts", "/p/new.ts", null)],
			"/p",
			reader(new Map([["/p/new.ts", "x\ny\n"]])),
		);
		assert.equal(report.files.length, 1);
		assert.equal(report.files[0].action, "new");
		assert.deepEqual(report.files[0].stats, { added: 2, removed: 0 });
		assert.ok(report.files[0].diff.startsWith("+"));
		assert.deepEqual(report.totals, { files: 1, added: 2, removed: 0 });
	});

	it("classifies missing files with a baseline as all-removed deletions", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("gone.txt", "/p/gone.txt", "one\ntwo\n")],
			"/p",
			reader(new Map([["/p/gone.txt", null]])),
		);
		assert.equal(report.files[0].action, "deleted");
		assert.deepEqual(report.files[0].stats, { added: 0, removed: 2 });
	});

	it("skips files created and deleted within the session", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("blip.txt", "/p/blip.txt", null)],
			"/p",
			reader(new Map([["/p/blip.txt", null]])),
		);
		assert.equal(report.files.length, 0);
	});

	it("skips edits reverted to the baseline", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("same.txt", "/p/same.txt", "alpha\nbeta")],
			"/p",
			reader(new Map([["/p/same.txt", "alpha\nbeta"]])),
		);
		assert.equal(report.files.length, 0);
	});

	it("classifies differing content as modified and sums totals", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("a.ts", "/p/a.ts", "one\ntwo\n"), ledgerEntry("b.ts", "/p/b.ts", null)],
			"/p",
			reader(
				new Map([
					["/p/a.ts", "one\nTWO\n"],
					["/p/b.ts", "brand\nnew\n"],
				]),
			),
		);
		assert.equal(report.files[0].action, "modified");
		assert.equal(report.files[1].action, "new");
		assert.equal(report.totals.files, 2);
		assert.ok(report.totals.added >= 3);
		assert.ok(report.totals.removed >= 1);
	});

	it("caps the diff body per file while keeping full stats", async () => {
		const lines = Array.from({ length: 1000 }, (_, index) => `line${index}\n`).join("");
		const report = await buildChangesReport(
			[ledgerEntry("big.ts", "/p/big.ts", null)],
			"/p",
			reader(new Map([["/p/big.ts", lines]])),
		);
		const file = report.files[0];
		assert.ok(file.diff.split("\n").length <= 400);
		assert.ok(file.omittedLines > 0);
		// Stats are computed from the full diff, not the truncated body.
		assert.deepEqual(file.stats, { added: 1000, removed: 0 });
	});

	it("notes too-large baselines without a diff body", async () => {
		const report = await buildChangesReport(
			[ledgerEntry("huge.txt", "/p/huge.txt", null, true)],
			"/p",
			reader(new Map()),
		);
		assert.equal(report.files[0].note, "base too large to snapshot");
		assert.equal(report.files[0].diff, "");
	});

	it("notes unreadable current content instead of reporting a deletion", async () => {
		const throwingReader = async (): Promise<string | null> => {
			throw new Error("EACCES");
		};
		const report = await buildChangesReport(
			[ledgerEntry("locked.txt", "/p/locked.txt", "base")],
			"/p",
			throwingReader,
		);
		assert.equal(report.files[0].note, "current content unreadable");
	});
});

describe("registerChanges — command and entry rendering", () => {
	type RendererFn = (entry: { data?: unknown }, options: { expanded: boolean }, t: typeof theme) => Text;
	type CommandFn = { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };

	interface Capture {
		entryRenderers: Map<string, RendererFn>;
		commands: Map<string, CommandFn>;
		appended: Array<{ type: string; data: unknown }>;
	}

	function capture(): Capture {
		const captureState: Capture = { entryRenderers: new Map(), commands: new Map(), appended: [] };
		const pi = {
			on: () => () => {},
			registerEntryRenderer: (type: string, renderer: RendererFn) => captureState.entryRenderers.set(type, renderer),
			registerCommand: (name: string, command: CommandFn) => captureState.commands.set(name, command),
			appendEntry: (type: string, data: unknown) => captureState.appended.push({ type, data }),
		} as unknown as ExtensionAPI;
		registerChanges(pi);
		return captureState;
	}

	let dir: string;

	beforeEach(async () => {
		clearLedger();
		dir = await mkdtemp(join(tmpdir(), "pi-changes-cmd-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	function commandCtx(mode: "tui" | "print" = "tui"): {
		ctx: ExtensionCommandContext;
		notifications: Array<{ message: string; type?: string }>;
	} {
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx = {
			mode,
			cwd: dir,
			ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
		} as unknown as ExtensionCommandContext;
		return { ctx, notifications };
	}

	it("warns outside the TUI and reports an empty ledger", async () => {
		const captureState = capture();
		const command = captureState.commands.get("changes");
		assert.ok(command);

		const offscreen = commandCtx("print");
		await command.handler("", offscreen.ctx);
		assert.match(offscreen.notifications[0].message, /interactive mode/);

		const onscreen = commandCtx();
		await command.handler("", onscreen.ctx);
		assert.match(onscreen.notifications[0].message, /No file changes/);
	});

	it("appends a report entry for tracked changes and filters by argument", async () => {
		const captureState = capture();
		const command = captureState.commands.get("changes");
		assert.ok(command);

		const kept = join(dir, "kept.txt");
		const dropped = join(dir, "dropped.txt");
		await writeFile(kept, "before", "utf-8");
		await handleToolCallForLedger(toolCallEvent("edit", { path: kept }), tuiCtx(dir));
		await writeFile(kept, "after", "utf-8");
		await handleToolCallForLedger(toolCallEvent("write", { path: dropped }), tuiCtx(dir));
		await writeFile(dropped, "created", "utf-8");

		const first = commandCtx();
		await command.handler("", first.ctx);
		assert.equal(captureState.appended.length, 1);
		assert.equal(captureState.appended[0].type, "pi-plus-changes");
		const report = captureState.appended[0].data as ChangesReport;
		assert.equal(report.files.length, 2);

		const filtered = commandCtx();
		await command.handler("kept", filtered.ctx);
		assert.equal(captureState.appended.length, 2);
		const filteredReport = captureState.appended[1].data as ChangesReport;
		assert.equal(filteredReport.files.length, 1);
		// Absolute model paths are displayed relative to the report cwd.
		assert.equal(filteredReport.files[0].rawPath, "kept.txt");

		const none = commandCtx();
		await command.handler("nosuchfile", none.ctx);
		assert.equal(captureState.appended.length, 2);
		assert.match(none.notifications[0].message, /No tracked changes match/);
	});

	it("renders the entry with the report header and per-file fancy diffs", async () => {
		const captureState = capture();
		const renderer = captureState.entryRenderers.get("pi-plus-changes");
		assert.ok(renderer);

		const entry = {
			data: {
				cwd: "/home/user/proj",
				files: [
					{
						rawPath: "src/app.ts",
						action: "modified",
						stats: { added: 1, removed: 1 },
						diff: "- 1 old\n+ 1 new",
						omittedLines: 0,
					},
					{
						rawPath: "brand-new.ts",
						action: "new",
						stats: { added: 2, removed: 0 },
						diff: "+ 1 hello\n+ 2 world",
						omittedLines: 0,
						note: "untracked",
					},
				],
				totals: { files: 2, added: 3, removed: 1 },
			} satisfies ChangesReport,
		};
		const component = renderer(entry, { expanded: false }, theme);
		const styled = component.render(120).join("\n");
		const plain = stripAnsi(styled);

		assert.match(plain, /changes\s+2 files\s+\+3 −1/);
		assert.match(plain, /modified\s+src\/app\.ts\s+\+1 −1\s+typescript/);
		assert.match(plain, /new\s+brand-new\.ts\s+\+2\s+untracked/);
		// Diff bodies go through the fancy pipeline (markers separated from content).
		assert.ok(plain.includes("old"));
		assert.ok(plain.includes("hello"));
		// Diff fills are scoped to changed lines; report/file headers stay unfilled.
		const styledLines = styled.split("\n");
		const changedLines = styledLines.filter((line) => /^[+-]/.test(stripAnsi(line)));
		assert.ok(changedLines.length >= 3, "expected filled diff lines");
		assert.ok(
			changedLines.every((line) => BACKGROUND_SGR.test(line)),
			"changed diff lines must carry the fancy fill",
		);
		const headerLines = styledLines.filter(
			(line) => !/^[+-]/.test(stripAnsi(line)) && /changes|modified|brand-new/.test(stripAnsi(line)),
		);
		assert.ok(
			headerLines.every((line) => !BACKGROUND_SGR.test(line)),
			"entry rendering must not emit background SGR outside diff lines",
		);

		const missing = renderer({ data: undefined }, { expanded: false }, theme);
		assert.match(stripAnsi(missing.render(120).join("\n")), /missing report data/);
	});

	it("omits the stats segment for note-only files in the header", async () => {
		const captureState = capture();
		const renderer = captureState.entryRenderers.get("pi-plus-changes");
		assert.ok(renderer);
		const report: ChangesReport = {
			cwd: dir,
			files: [
				{
					rawPath: "huge.txt",
					action: "modified",
					stats: { added: 0, removed: 0 },
					diff: "",
					omittedLines: 0,
					note: "base too large to snapshot",
				},
			],
			totals: { files: 1, added: 0, removed: 0 },
		};
		const text = stripAnsi(renderer({ data: report }, { expanded: false }, theme).render(120).join("\n"));
		assert.match(text, /changes\s+1 file/);
		assert.match(text, /huge\.txt\s+base too large to snapshot/);
		assert.ok(!text.includes("+0"));
	});
});
