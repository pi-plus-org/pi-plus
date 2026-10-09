/**
 * Session change ledger for the /changes command.
 *
 * The ledger records the state of every file the agent first touches through the
 * `edit`/`write` tools: the original content as it was immediately before the
 * first modification (null when the file did not exist yet — a new,
 * "unversioned" file). `/changes` diffs these first-touch baselines against the
 * current files on disk, so the report is session-scoped and works without git.
 *
 * A throwing `tool_call` handler blocks execution (agent-session awaits it and
 * surfaces errors as blocks), so every failure path here is swallowed — same
 * discipline as the fancy-diff pre-image stash. This ledger is intentionally a
 * separate store: fancy-diff keeps a per-call LRU of previous content for the
 * tool-row rendering, while this holds one permanent baseline per path for the
 * session. One extra read per first-touch call is acceptable; the two never
 * need to agree.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionContext, ToolCallEvent } from "../../../../coding-agent/src/core/extensions/types.ts";
import { normalizeToLF } from "../../../../coding-agent/src/core/tools/edit-diff.ts";
import { resolveToCwd } from "../../../../coding-agent/src/core/tools/path-utils.ts";
import { str } from "../../../../coding-agent/src/core/tools/render-utils.ts";
import { splitBom } from "../../../../coding-agent/src/utils/text.ts";

export interface LedgerEntry {
	/** Path as the model wrote it (may be relative), kept for display. */
	rawPath: string;
	/** Resolved absolute path — the ledger key. */
	absolutePath: string;
	/** First-touch baseline, LF-normalized; null when the file did not exist yet. */
	base: string | null;
	/** Baseline skipped because the file exceeded the snapshot cap; /changes notes it. */
	tooLarge: boolean;
}

/** Bounded so a pathological session cannot grow the ledger without limit. */
const MAX_LEDGER_ENTRIES = 200;
/** Larger files get a note instead of a baseline — such diffs would be unreadable anyway. */
const MAX_SNAPSHOT_BYTES = 256 * 1024;

const LEDGER_TOOLS = new Set(["edit", "write"]);

const ledger = new Map<string, LedgerEntry>();

/** Ledger entries in first-touch order. */
export function getLedgerEntries(): LedgerEntry[] {
	return [...ledger.values()];
}

/** Test seam: clears the ledger. */
export function clearLedger(): void {
	ledger.clear();
}

/** `tool_call` handler: snapshot the first-touch baseline of every TUI edit/write. Never throws. */
export async function handleToolCallForLedger(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
	try {
		if (ctx.mode !== "tui") return;
		if (!LEDGER_TOOLS.has(event.toolName)) return;
		// file_path is the tolerated alias some providers emit (upstream renderers accept both).
		const input = event.input as { file_path?: string; path?: string };
		const rawPath = str(input.file_path ?? input.path);
		if (rawPath === null || rawPath === "") return;
		const absolutePath = resolveToCwd(rawPath, ctx.cwd);
		// The first touch owns the baseline; later touches never overwrite it.
		if (ledger.has(absolutePath)) return;
		if (ledger.size >= MAX_LEDGER_ENTRIES) return;
		let base: string | null = null;
		let tooLarge = false;
		try {
			const raw = await readFile(absolutePath, "utf-8");
			const content = normalizeToLF(splitBom(raw).text);
			if (content.length > MAX_SNAPSHOT_BYTES) tooLarge = true;
			else base = content;
		} catch (error: unknown) {
			// ENOENT means the agent is about to create the file; any other failure
			// (permissions, directory, unreadable device) leaves the file untracked —
			// a wrong baseline is worse than no report entry.
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return;
		}
		ledger.set(absolutePath, { rawPath, absolutePath, base, tooLarge });
	} catch {
		// Never block the tool call.
	}
}
