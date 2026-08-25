/**
 * Content extraction for the /repurpose endpoint.
 *
 * Turns a `source` (raw text, a URL, or — not yet supported — a YouTube link)
 * into a single plaintext string capped at MAX_CONTENT_CHARS, ready to hand to
 * Claude.
 */

/** Longest source text handed to Claude. Repurposing needs the core ideas, not the whole document. */
export const MAX_CONTENT_CHARS = 20_000;

/** Below this, there isn't enough substance to repurpose into five platforms. */
export const MIN_CONTENT_CHARS = 100;

/** Outbound fetches (URL extraction) time out after this long. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Extract plaintext content from a `{ type, content }` source.
 *
 * @param {{ type: 'url' | 'text' | 'youtube', content: string }} source
 * @returns {Promise<string>} plaintext, capped at MAX_CONTENT_CHARS
 * @throws {Error} on unsupported/invalid source, fetch failure, or empty content
 */
export async function extractContent(source) {
	if (source.type === 'text') {
		return source.content.slice(0, MAX_CONTENT_CHARS);
	}

	if (source.type === 'url') {
		return await extractFromUrl(source.content);
	}

	if (source.type === 'youtube') {
		throw new Error("YouTube support coming soon. Please paste the transcript as type='text' for now.");
	}

	throw new Error(`Unsupported source type: "${source.type}". Use "url", "text", or "youtube".`);
}

/**
 * Fetch a URL and reduce it to plaintext.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
async function extractFromUrl(url) {
	let response;
	try {
		response = await fetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentRepurposeAgent/1.0)' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Could not fetch URL "${url}": ${error.message}`);
	}

	if (!response.ok) {
		throw new Error(`Could not fetch URL "${url}": HTTP ${response.status}`);
	}

	const html = await response.text();
	return stripHtml(html).slice(0, MAX_CONTENT_CHARS);
}

/**
 * Crude HTML-to-text: drop scripts/styles/tags, decode common entities,
 * collapse whitespace. Same pattern as gmail-sheets-agent's HTML fallback —
 * this only needs to strip markup, not render it.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}
