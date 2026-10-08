/**
 * Minimal dependency-free HTML text extraction for the web search / fetch
 * tools (pi-plus adds no npm deps; openclaude uses turndown for this).
 *
 * The goal is a readable plain-text rendering of a page well enough for the
 * model to extract facts from — not a faithful markdown conversion.
 */

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	laquo: "«",
	raquo: "»",
	hellip: "…",
	bull: "•",
	middot: "·",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	plusmn: "±",
	times: "×",
};

/** Decode numeric and common named HTML entities. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (match, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		const named = NAMED_ENTITIES[body.toLowerCase()];
		// Unknown entities (e.g. custom template placeholders) stay as-is.
		return named ?? match;
	});
}

/** Strip all tags from an HTML fragment (no block-level newlines). */
export function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

/** Drop comments and non-content element bodies from an HTML document. */
function stripNonContent(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(script|style|noscript|template|svg)\b[^>]*\/?>/gi, " ");
}

/**
 * Convert an HTML document to readable plain text: anchors keep their href as
 * `text (url)`, block boundaries become newlines, everything else is stripped.
 * `baseUrl` (when given) resolves relative hrefs before they are kept.
 */
export function htmlToText(html: string, baseUrl?: string): string {
	let text = stripNonContent(html);

	// Links: keep the target when absolute so the model can cite/visit it.
	text = text.replace(
		/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_match, href: string, label: string) => {
			const linkLabel = decodeEntities(stripTags(label)).trim();
			const cleanHref = decodeEntities(href).trim();
			if (!linkLabel) return "";
			if (/^(https?:|mailto:)/i.test(cleanHref)) return `${linkLabel} (${cleanHref})`;
			if (baseUrl) {
				try {
					const resolved = new URL(cleanHref, baseUrl);
					if (resolved.protocol === "http:" || resolved.protocol === "https:") {
						return `${linkLabel} (${resolved.toString()})`;
					}
				} catch {
					// Unresolvable relative href — fall through to label only.
				}
			}
			return linkLabel;
		},
	);

	text = text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/(p|div|h[1-6]|li|ul|ol|blockquote|pre|tr|table|section|article|header|footer|nav|aside|form|dt|dd|figure)>/gi,
			"\n",
		)
		.replace(/<(h[1-6]|li|blockquote|pre|tr|figcaption)\b[^>]*>/gi, "\n")
		.replace(/<[^>]*>/g, " ");

	text = decodeEntities(text);

	// Normalize whitespace: collapse runs of spaces/tabs, then blank lines.
	text = text
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n");
	text = text.replace(/\n{3,}/g, "\n\n");

	return text.trim();
}
