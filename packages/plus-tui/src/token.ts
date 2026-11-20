// The `/name` token extractor shared by the pi CLI and p2 desktop extensions. Mirrors the delimiter and wrapper
// helpers of packages/tui/src/autocomplete.ts (and apps/p2/src/runtime/completion.ts, which copied them): a slash
// command may start at any token position in the message, so the token scan splits on the same separators and
// opening wrappers as path completion.

// Opening wrappers that may precede a path in prose, mapped to their closing counterpart.
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

// Mirrors packages/tui/src/utils.ts: CJK codepoints and CJK punctuation are token separators, so "查看，/mod"
// treats "/mod" as its own token.
const cjkBreak =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
const cjkPunctuation = new RegExp(`(?:(?=\\p{Punctuation})${cjkBreak.source}|[，．：；！？（）［］｛｝“”‘’…—])`, "u");
const separator = new RegExp(`(?:\\s|${cjkPunctuation.source})`, "u");

// The last index of a path delimiter or token separator before the cursor (-1 when none), by Unicode code point.
function findLastDelimiter(text: string): number {
	let last = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || separator.test(character)) last = index - 1;
	}
	return last;
}

// "`src/ma" -> "src/ma"; a wrapper whose closer is in the token stays ("app/[slug]/pa").
function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]!];
		if (!closer || result.includes(closer, 1)) break;
		result = result.slice(1);
	}
	return result;
}

/**
 * A `/name` token ending at the cursor, at any position in the line (e.g. "please run /rev"), or null when the
 * token before the cursor is not a slash command: it does not start with "/" or is a path like `/usr/bin`.
 */
export function extractSlashCommandToken(text: string): string | null {
	const lastDelimiterIndex = findLastDelimiter(text);
	const token = stripLeadingWrappers(lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1));
	if (!token.startsWith("/")) return null;
	if (token.slice(1).includes("/")) return null;
	return token;
}
