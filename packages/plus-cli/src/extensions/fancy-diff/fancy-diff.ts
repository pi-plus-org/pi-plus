/**
 * Fancy diff rendering for content-change tools (edit/write).
 *
 * Upstream renderDiff (coding-agent src/modes/interactive/components/diff.ts)
 * paints diff bodies as flat green/red/dim text with an occasional inverse
 * word-diff. This module keeps the same display-diff string format (the
 * `+ 12 text` / `- 12 text` / `  12 text` / `     ...` lines produced by
 * generateDiffString) but renders it as:
 *
 *   edit  src/foo.ts  +2 −1  typescript        ← header with change stats + language badge
 *      10 import { Bar } from "./bar.ts"       ← context: dim gutter, syntax-highlighted body
 *    − 12   const x = old_value                ← removed: soft row fill, bold + stronger fill on changed words
 *    + 12   const x = new_value                ← added: same
 *      ⋮                                       ← omission separator
 *
 * House style (pi-plus-plain-tools): tool *status* never uses background fills.
 * Diff lines are the deliberate exception — a changed line carries a soft
 * full-row fill of its diff color and changed words a stronger one, both mixed
 * from the theme's toolDiffAdded/toolDiffRemoved tokens (never the tool-status
 * bg tokens). Context lines and headers stay unfilled.
 *
 * The line-grouping loop is a port of upstream renderDiff; the parse regex is
 * re-implemented here because upstream's is module-private.
 */

import { type Color, mixColors, rgbColor } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { renderToolPath, replaceTabs } from "../../../../coding-agent/src/core/tools/render-utils.ts";
import {
	getLanguageFromPath,
	highlightCode,
	type Theme,
	type ThemeColor,
} from "../../../../coding-agent/src/modes/interactive/theme/theme.ts";

/** Display-diff line kinds as emitted by generateDiffString. */
type DiffLineKind = "added" | "removed" | "context";

interface ParsedDiffLine {
	kind: DiffLineKind;
	/** Line-number column, verbatim (space-padded) to keep alignment. */
	lineNum: string;
	content: string;
}

export interface DiffStats {
	added: number;
	removed: number;
}

/**
 * Parse one display-diff line. Mirrors the upstream private regex:
 * a leading `+`, `-`, or space marker, then a space-padded line number,
 * then the content.
 */
function parseDiffLine(line: string): ParsedDiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	const prefix = match[1];
	const kind: DiffLineKind = prefix === "+" ? "added" : prefix === "-" ? "removed" : "context";
	return { kind, lineNum: match[2], content: match[3] };
}

/** Omission separators are context lines with no digits and literal "...". */
function isOmissionLine(parsed: ParsedDiffLine): boolean {
	return parsed.kind === "context" && parsed.lineNum.trim() === "" && parsed.content.trim() === "...";
}

export function parseDiffStats(diff: string): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		const parsed = parseDiffLine(line);
		if (!parsed || isOmissionLine(parsed)) continue;
		if (parsed.kind === "added") added++;
		else if (parsed.kind === "removed") removed++;
	}
	return { added, removed };
}

/** `+N −M` in the diff colors; empty when there is nothing to report. */
export function formatDiffStats(stats: DiffStats, theme: Theme): string {
	const parts: string[] = [];
	if (stats.added > 0) parts.push(theme.fg("toolDiffAdded", `+${stats.added}`));
	if (stats.removed > 0) parts.push(theme.fg("toolDiffRemoved", `−${stats.removed}`));
	return parts.join(" ");
}

/**
 * Tool header shared by edit/write: bold title, linked path, change stats,
 * and a muted language badge when the extension resolves one.
 */
export function formatChangeHeader(
	action: string,
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { stats?: DiffStats; note?: string },
): string {
	let text = `${theme.fg("toolTitle", theme.bold(action))} ${renderToolPath(rawPath, theme, cwd)}`;
	if (options?.stats) {
		const stats = formatDiffStats(options.stats, theme);
		if (stats) text += `  ${stats}`;
	}
	if (options?.note) text += `  ${theme.fg("muted", options.note)}`;
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (lang) text += `  ${theme.fg("muted", lang)}`;
	return text;
}

/** Highlight one plain body fragment; falls back to the raw text. */
function highlightFragment(text: string, lang: string): string {
	return highlightCode(text, lang)[0] ?? text;
}

/** The color a diff fill is mixed toward: black on dark themes, white on light ones. */
function fillBase(theme: Theme): Color {
	return theme.appearance === "light" ? rgbColor(255, 255, 255) : rgbColor(0, 0, 0);
}

/**
 * Background fill for a changed line: `line` is a soft full-row tint, `word` a
 * stronger fill on the actually-changed chunks. Both derive from the theme's
 * diff token so they follow the active theme; context lines stay unfilled.
 */
function diffFill(kind: DiffLineKind, theme: Theme, strength: "line" | "word"): Color | undefined {
	if (kind === "context") return undefined;
	const token = kind === "added" ? "toolDiffAdded" : "toolDiffRemoved";
	return mixColors(theme.colors[token], fillBase(theme), strength === "line" ? 0.85 : 0.55);
}

/**
 * Word-level emphasis for a 1:1 replacement pair. With a language each chunk is
 * highlighted on its own and changed chunks are bolded and carry the word fill
 * (inverse would fight the inner color codes); without one this is exactly
 * upstream's inverse style, with the line fill alone carrying the change.
 * Leading whitespace of the first changed chunk stays unstyled so indentation
 * is never highlighted.
 */
function renderWordDiffPair(
	oldContent: string,
	newContent: string,
	lang: string | undefined,
	theme: Theme,
): { removedBody: string; addedBody: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	const removedFill = diffFill("removed", theme, "word");
	const addedFill = diffFill("added", theme, "word");
	let removedBody = "";
	let addedBody = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	const style = (chunk: string, fill: Color | undefined): string => {
		if (!lang) return theme.inverse(chunk);
		const emphasized = theme.bold(highlightFragment(chunk, lang));
		return fill ? theme.style(emphasized, { bg: fill }) : emphasized;
	};
	const plain = (chunk: string): string => (lang ? highlightFragment(chunk, lang) : chunk);

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				removedBody += lang ? highlightFragment(leadingWs, lang) : leadingWs;
				isFirstRemoved = false;
			}
			if (value) removedBody += style(value, removedFill);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWs.length);
				addedBody += lang ? highlightFragment(leadingWs, lang) : leadingWs;
				isFirstAdded = false;
			}
			if (value) addedBody += style(value, addedFill);
		} else {
			removedBody += plain(part.value);
			addedBody += plain(part.value);
		}
	}
	return { removedBody, addedBody };
}

function lineKindColor(kind: DiffLineKind): ThemeColor {
	if (kind === "added") return "toolDiffAdded";
	if (kind === "removed") return "toolDiffRemoved";
	return "toolDiffContext";
}

const RESET_BG = "\x1b[49m";

/** Opening background SGR for a fill color (taken from theme.style by stripping its closer). */
function fillOpenAnsi(theme: Theme, fill: Color): string {
	return theme.style("", { bg: fill }).slice(0, -RESET_BG.length);
}

/**
 * Assemble one styled diff line: marker + gutter + body over a soft row fill, preserving alignment.
 * Word fills close with a background reset, which would also end the row fill (ANSI backgrounds do
 * not stack), so every inner reset is replaced by a re-open of the row fill.
 */
function styledDiffLine(kind: DiffLineKind, lineNum: string, body: string, theme: Theme): string {
	const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
	const line = `${theme.fg(lineKindColor(kind), marker)}${theme.fg("dim", lineNum)} ${body}`;
	const fill = diffFill(kind, theme, "line");
	if (!fill) return line;
	const open = fillOpenAnsi(theme, fill);
	return `${open}${line.split(RESET_BG).join(open)}${RESET_BG}`;
}

/**
 * Default body styling when the file's language is unknown: color the whole
 * body per line kind (upstream behavior). When a language is known, `body` is
 * already syntax-highlighted by the caller.
 */
function plainBody(kind: DiffLineKind, content: string, theme: Theme): string {
	return theme.fg(lineKindColor(kind), content);
}

export interface FancyDiffOptions {
	/** Display diff from generateDiffString (or the edit tool's details.diff). */
	diff: string;
	/** Raw file path, for language detection. */
	rawPath: string | null;
	theme: Theme;
}

/** Render a display diff with markers, dim gutter, syntax-highlighted bodies, and word emphasis. */
export function renderFancyDiff({ diff, rawPath, theme }: FancyDiffOptions): string {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const lines = diff.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", lines[i]));
			i++;
			continue;
		}

		if (isOmissionLine(parsed)) {
			// Context elision (" ..."): a quiet vertical-ellipsis in the gutter column.
			result.push(theme.fg("muted", theme.italic(`${parsed.lineNum}  ⋮`)));
			i++;
			continue;
		}

		if (parsed.kind === "removed") {
			// Collect consecutive removed lines, then consecutive added lines.
			const removedLines: ParsedDiffLine[] = [parsed];
			i++;
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.kind !== "removed") break;
				removedLines.push(p);
				i++;
			}
			const addedLines: ParsedDiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.kind !== "added") break;
				addedLines.push(p);
				i++;
			}

			// Intra-line word diff only for a single removed + single added pair
			// (a modified line); larger blocks show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];
				const { removedBody, addedBody } = renderWordDiffPair(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					lang,
					theme,
				);
				// Without a language the whole body keeps the line-kind tint (upstream
				// behavior); with one, the syntax colors carry the line instead.
				const removedShown = lang ? removedBody : theme.fg("toolDiffRemoved", removedBody);
				const addedShown = lang ? addedBody : theme.fg("toolDiffAdded", addedBody);
				result.push(styledDiffLine("removed", removed.lineNum, removedShown, theme));
				result.push(styledDiffLine("added", added.lineNum, addedShown, theme));
				continue;
			}

			for (const removed of removedLines) {
				const body = replaceTabs(removed.content);
				result.push(
					styledDiffLine(
						"removed",
						removed.lineNum,
						lang ? highlightFragment(body, lang) : plainBody("removed", body, theme),
						theme,
					),
				);
			}
			for (const added of addedLines) {
				const body = replaceTabs(added.content);
				result.push(
					styledDiffLine(
						"added",
						added.lineNum,
						lang ? highlightFragment(body, lang) : plainBody("added", body, theme),
						theme,
					),
				);
			}
			continue;
		}

		if (parsed.kind === "added") {
			const body = replaceTabs(parsed.content);
			result.push(
				styledDiffLine(
					"added",
					parsed.lineNum,
					lang ? highlightFragment(body, lang) : plainBody("added", body, theme),
					theme,
				),
			);
			i++;
			continue;
		}

		// Context line.
		const body = replaceTabs(parsed.content);
		result.push(
			styledDiffLine(
				"context",
				parsed.lineNum,
				lang ? highlightFragment(body, lang) : plainBody("context", body, theme),
				theme,
			),
		);
		i++;
	}

	return result.join("\n");
}
