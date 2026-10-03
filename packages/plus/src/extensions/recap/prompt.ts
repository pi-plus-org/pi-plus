/**
 * Session-recap prompt and title sanitizer for the pi-plus-session-recap
 * extension (see index.ts). The recap is a short, title-style summary of the
 * session, applied as the session name so it lands in the tab title and the
 * legacy resume list (session-selector `name ?? firstMessage`).
 */

/** Hard cap on the applied title; the model is asked for fewer words than this. */
export const RECAP_MAX_TITLE_CHARS = 60;

/** Build the one-off title-generation prompt over a serialized conversation. */
export function getRecapPrompt(conversationText: string): string {
	return `Summarize what this coding session is about, as a short title of at most 8 words.

Rules:
- Output ONLY the title text: no quotes, no trailing punctuation, no explanation, no line breaks.
- Describe the task or topic (what is being worked on), not the participants.
- Prefer concrete nouns from the session (files, features, bugs) over generic phrasing.

<session>
${conversationText}
</session>`;
}

/**
 * Normalize a model-produced title: first line only, surrounding quotes and
 * common decorations stripped, whitespace collapsed, then truncated to
 * RECAP_MAX_TITLE_CHARS at a word boundary. Returns "" when nothing survives.
 */
export function sanitizeRecapTitle(raw: string): string {
	let title = raw
		.split("\n")[0]
		.trim()
		// Strip code fences / markdown emphasis the model may wrap the title in.
		.replace(/^[`*_]+|[`*_]+$/g, "")
		// Strip one layer of matching quotes.
		.replace(/^["'“”‘’](.*)["'“”‘’]$/, "$1")
		// Strip common prefixes like "Title: " the model may add despite the prompt.
		.replace(/^(?:title|summary|recap)\s*[:—-]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();

	// Drop a trailing sentence period; keep other punctuation (e.g. "?").
	title = title.replace(/\.+$/, "");

	if (title.length > RECAP_MAX_TITLE_CHARS) {
		const cut = title.slice(0, RECAP_MAX_TITLE_CHARS);
		const boundary = cut.lastIndexOf(" ");
		title = (boundary > 0 ? cut.slice(0, boundary) : cut).trim();
	}
	return title;
}
