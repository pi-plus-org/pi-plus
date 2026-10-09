/**
 * Session change report builder for /changes.
 *
 * Diffs every ledger baseline against the file's current content and produces a
 * plain data structure (display-diff strings, stats, per-file classification)
 * that the entry renderer styles at display time. Keeping the builder fs-only
 * and the styling separate means restored sessions re-render past reports with
 * the current theme, and the diff math is testable without a TUI.
 *
 * Classification:
 *   - baseline null, file present      → "new"      (all lines added — the unversioned case)
 *   - baseline present, file missing   → "deleted"  (all lines removed)
 *   - both present, differing          → "modified"
 *   - both present and equal, or an all-context diff → skipped (reverted edit)
 *
 * Bodies are capped per file (the way Claude Code's diff view caps hunks per
 * file); stats are always computed from the full diff, and the omitted line
 * count rides along for a muted tail note.
 */

import { readFile } from "node:fs/promises";
import { sep } from "node:path";
import { generateDiffString, normalizeToLF } from "../../../../coding-agent/src/core/tools/edit-diff.ts";
import { splitBom } from "../../../../coding-agent/src/utils/text.ts";
import type { DiffStats } from "../fancy-diff/fancy-diff.ts";
import { parseDiffStats } from "../fancy-diff/fancy-diff.ts";
import type { LedgerEntry } from "./ledger.ts";

export type ChangeAction = "modified" | "new" | "deleted";

export interface ChangedFileReport {
	/** Path as the model wrote it (may be relative), kept for display. */
	rawPath: string;
	action: ChangeAction;
	stats: DiffStats;
	/** Display diff (generateDiffString format, possibly truncated for display). */
	diff: string;
	/** Diff lines dropped beyond the display cap. */
	omittedLines: number;
	/** Muted note appended to the header (baseline too large, current file unreadable...). */
	note?: string;
}

export interface ChangesReport {
	/** cwd captured at report time — formatChangeHeader renders paths against it. */
	cwd: string;
	files: ChangedFileReport[];
	totals: { files: number; added: number; removed: number };
}

/** Diff lines shown per file before a muted tail note (Claude Code uses 400). */
const MAX_DIFF_BODY_LINES = 400;

/** Current file content, LF-normalized; null when missing; throws on other read failures. */
export async function defaultReadCurrent(absolutePath: string): Promise<string | null> {
	try {
		const raw = await readFile(absolutePath, "utf-8");
		return normalizeToLF(splitBom(raw).text);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
}

export type ReadCurrent = (absolutePath: string) => Promise<string | null>;

function truncateDiff(diff: string): { body: string; omittedLines: number } {
	const lines = diff.split("\n");
	if (lines.length <= MAX_DIFF_BODY_LINES) return { body: diff, omittedLines: 0 };
	return { body: lines.slice(0, MAX_DIFF_BODY_LINES).join("\n"), omittedLines: lines.length - MAX_DIFF_BODY_LINES };
}

export async function buildChangesReport(
	entries: LedgerEntry[],
	cwd: string,
	readCurrent: ReadCurrent = defaultReadCurrent,
): Promise<ChangesReport> {
	const files: ChangedFileReport[] = [];
	let added = 0;
	let removed = 0;

	for (const entry of entries) {
		// Show paths relative to the report cwd when the model passed absolute ones.
		const displayPath = entry.absolutePath.startsWith(cwd + sep)
			? entry.absolutePath.slice(cwd.length + 1)
			: entry.rawPath;

		if (entry.tooLarge) {
			// The file existed at first touch but was over the snapshot cap — no baseline,
			// so list it with a note and no body rather than silently dropping it.
			files.push({
				rawPath: displayPath,
				action: "modified",
				stats: { added: 0, removed: 0 },
				diff: "",
				omittedLines: 0,
				note: "base too large to snapshot",
			});
			continue;
		}

		let current: string | null;
		try {
			current = await readCurrent(entry.absolutePath);
		} catch {
			files.push({
				rawPath: displayPath,
				action: "modified",
				stats: { added: 0, removed: 0 },
				diff: "",
				omittedLines: 0,
				note: "current content unreadable",
			});
			continue;
		}

		if (entry.base === null) {
			// New file: if it is gone again the agent created and deleted it — nothing to show.
			if (current === null) continue;
			const { diff } = generateDiffString("", current);
			const stats = parseDiffStats(diff);
			if (stats.added === 0 && stats.removed === 0) continue;
			const { body, omittedLines } = truncateDiff(diff);
			files.push({ rawPath: displayPath, action: "new", stats, diff: body, omittedLines });
			added += stats.added;
			removed += stats.removed;
			continue;
		}

		let action: ChangeAction;
		let diff: string;
		if (current === null) {
			action = "deleted";
			diff = generateDiffString(entry.base, "").diff;
		} else {
			if (current === entry.base) continue; // reverted to baseline
			action = "modified";
			diff = generateDiffString(entry.base, current).diff;
		}
		const stats = parseDiffStats(diff);
		if (stats.added === 0 && stats.removed === 0) continue;
		const { body, omittedLines } = truncateDiff(diff);
		files.push({ rawPath: displayPath, action, stats, diff: body, omittedLines });
		added += stats.added;
		removed += stats.removed;
	}

	return { cwd, files, totals: { files: files.length, added, removed } };
}
