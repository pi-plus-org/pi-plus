/**
 * pi-plus-changes: the `/changes` command — a session content diff that
 * includes unversioned files.
 *
 * `git diff` cannot show brand-new files or changes made outside a repository,
 * and the transcript's per-tool diffs cannot be reviewed as one cumulative
 * report. This extension keeps a first-touch baseline of every file the agent
 * edits or overwrites (ledger.ts, fed by a `tool_call` handler), and on
 * `/changes` diffs those baselines against the current files on disk
 * (report.ts). The report is appended as a custom transcript entry — it never
 * enters LLM context, scrolls with the terminal like any other output, and
 * persists in the session file so restored sessions re-render past reports.
 *
 * Rendering reuses the fancy-diff pipeline (header with `+N −M` stats and a
 * language badge, syntax-highlighted bodies, ⋮ elisions, no background fills).
 * New files render as all-added, deletions as all-removed, and reverted edits
 * drop out. Changes made through the `bash` tool are not tracked — the ledger
 * only observes the edit/write tools.
 *
 * Optional argument filters tracked paths by case-insensitive substring:
 * `/changes src/foo`.
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import type { Theme } from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";
import { formatChangeHeader, formatDiffStats, renderFancyDiff } from "../fancy-diff/fancy-diff.ts";
import { getLedgerEntries, handleToolCallForLedger } from "./ledger.ts";
import { buildChangesReport, type ChangesReport } from "./report.ts";

const CHANGES_ENTRY_TYPE = "pi-plus-changes";

function formatReportHeader(report: ChangesReport, theme: Theme): string {
	const fileWord = report.totals.files === 1 ? "file" : "files";
	const stats = formatDiffStats(report.totals, theme);
	let text = `${theme.fg("toolTitle", theme.bold("changes"))} ${theme.fg("muted", `${report.totals.files} ${fileWord}`)}`;
	if (stats) text += `  ${stats}`;
	return text;
}

export function registerChanges(pi: ExtensionAPI): void {
	pi.on("tool_call", handleToolCallForLedger);

	pi.registerEntryRenderer<ChangesReport>(CHANGES_ENTRY_TYPE, (entry, _options, theme) => {
		const report = entry.data;
		if (!report) return new Text(theme.fg("warning", "[changes] missing report data"), 0, 0);

		const lines: string[] = [formatReportHeader(report, theme)];
		for (const file of report.files) {
			lines.push("");
			lines.push(
				formatChangeHeader(file.action, file.rawPath, theme, report.cwd, {
					stats: file.stats,
					note: file.note,
				}),
			);
			if (file.diff) {
				lines.push("");
				lines.push(renderFancyDiff({ diff: file.diff, rawPath: file.rawPath, theme }));
			}
			if (file.omittedLines > 0) {
				lines.push(theme.fg("muted", `... (${file.omittedLines} more diff lines)`));
			}
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("changes", {
		description: "Show the content diff of every file changed this session (including new files)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The /changes report requires interactive mode", "warning");
				return;
			}
			const entries = getLedgerEntries();
			if (entries.length === 0) {
				ctx.ui.notify("No file changes tracked this session yet", "info");
				return;
			}
			const filter = args.trim().toLowerCase();
			const scoped = filter
				? entries.filter(
						(entry) =>
							entry.absolutePath.toLowerCase().includes(filter) || entry.rawPath.toLowerCase().includes(filter),
					)
				: entries;
			if (scoped.length === 0) {
				ctx.ui.notify(`No tracked changes match "${args.trim()}"`, "info");
				return;
			}
			const report = await buildChangesReport(scoped, ctx.cwd);
			if (report.files.length === 0) {
				ctx.ui.notify("Tracked files match their session baselines", "info");
				return;
			}
			pi.appendEntry(CHANGES_ENTRY_TYPE, report);
		},
	});
}
