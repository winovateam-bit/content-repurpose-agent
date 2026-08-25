/**
 * Content extraction for the /repurpose endpoint.
 *
 * Turns a `source` (raw text, a URL, or — not yet supported — a YouTube link)
 * into a single plaintext string capped at MAX_CONTENT_CHARS, ready to hand to
 * Claude.
 *
 * The URL path is the untrusted one: it makes an outbound request on behalf of
 * the caller, so it validates the target, refuses non-text responses, follows
 * redirects manually (re-validating every hop), and caps how many bytes it will
 * read. See extractFromUrl().
 */

/** Longest source text handed to Claude. Repurposing needs the core ideas, not the whole document. */
export const MAX_CONTENT_CHARS = 20_000;

/** Below this, there isn't enough substance to repurpose into five platforms. */
export const MIN_CONTENT_CHARS = 100;

/** Outbound fetches (URL extraction) time out after this long. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Most bytes read from a fetched URL before the body is truncated.
 *
 * A Worker has a 128 MB memory ceiling shared with everything else in the
 * isolate, and `response.text()` on an unbounded body will happily blow through
 * it. 2 MB is far more HTML than any article needs — the text is cut to
 * MAX_CONTENT_CHARS immediately afterwards anyway.
 */
const MAX_FETCH_BYTES = 2_000_000;

/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Content types we are willing to run through the HTML stripper.
 *
 * A PDF, image, or video would decode into meaningless bytes and waste a Claude
 * call, so those are rejected up front. An absent Content-Type is allowed —
 * plenty of servers omit it — and the stripper handles whatever comes back.
 */
const ALLOWED_MIME_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml', 'application/xml', 'text/xml'];

/**
 * Hostnames that must never be fetched.
 *
 * The endpoint is authenticated, so this is not the only thing standing between
 * a stranger and the internal network — but an SSRF that a valid token turns
 * into "fetch anything, from Cloudflare's egress" is still worth closing. Note
 * the limit: a hostname that passes this check can still resolve to a private
 * address (DNS rebinding), and Workers gives no hook to pin the resolved IP.
 * Blocking egress at the network layer is the complete fix if that matters.
 */
const BLOCKED_HOSTNAME_PATTERNS = [
	/^localhost$/i,
	/\.localhost$/i,
	/\.local$/i,
	/\.internal$/i,
	/^127\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./, // link-local, incl. cloud metadata endpoints
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^0\./,
	/^\[?::1\]?$/,
	/^\[?f[cd][0-9a-f]{2}:/i, // unique local addresses
	/^\[?fe80:/i, // link-local
];

/**
 * Extract plaintext content from a `{ type, content }` source.
 *
 * @param {{ type: 'url' | 'text' | 'youtube', content: string }} source
 * @returns {Promise<string>} plaintext, capped at MAX_CONTENT_CHARS
 * @throws {Error} on unsupported/invalid source or fetch failure
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
 * Parse and vet a URL before it is fetched.
 *
 * @param {string} candidate
 * @returns {URL}
 * @throws {Error} if the URL is malformed, uses a non-HTTP scheme, or targets a blocked host
 */
export function validateUrl(candidate) {
	let url;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error(`"${candidate}" is not a valid URL.`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Unsupported URL scheme "${url.protocol}". Only http and https are allowed.`);
	}

	if (BLOCKED_HOSTNAME_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
		throw new Error(`Refusing to fetch "${url.hostname}": private and loopback addresses are not allowed.`);
	}

	return url;
}

/**
 * Fetch a URL and reduce it to plaintext.
 *
 * @param {string} rawUrl
 * @returns {Promise<string>}
 */
async function extractFromUrl(rawUrl) {
	const response = await fetchFollowingRedirects(rawUrl);

	// Only the type before the parameters matters ("text/html; charset=utf-8").
	const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType)) {
		throw new Error(`Cannot extract text from "${rawUrl}": unsupported content type "${mimeType}".`);
	}

	const html = await readCapped(response);
	return stripHtml(html).slice(0, MAX_CONTENT_CHARS);
}

/**
 * Fetch `rawUrl`, following redirects by hand so every hop is re-validated.
 *
 * `redirect: 'follow'` would let a permitted host bounce the request to
 * localhost or a metadata endpoint, quietly undoing validateUrl().
 *
 * @param {string} rawUrl
 * @returns {Promise<Response>} the first non-redirect response
 */
async function fetchFollowingRedirects(rawUrl) {
	let url = validateUrl(rawUrl);

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		let response;
		try {
			response = await fetch(url, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentRepurposeAgent/1.0)', Accept: 'text/html,text/plain' },
				redirect: 'manual',
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			// TimeoutError surfaces here too — its message alone ("The operation was
			// aborted") tells the caller nothing, so name the cause.
			const reason = error?.name === 'TimeoutError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : error.message;
			throw new Error(`Could not fetch URL "${rawUrl}": ${reason}`);
		}

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			if (!location) {
				throw new Error(`Could not fetch URL "${rawUrl}": HTTP ${response.status} with no redirect target.`);
			}
			// A Location header may be relative; resolve it against the current hop.
			url = validateUrl(new URL(location, url).toString());
			continue;
		}

		if (!response.ok) {
			throw new Error(`Could not fetch URL "${rawUrl}": HTTP ${response.status}`);
		}

		return response;
	}

	throw new Error(`Could not fetch URL "${rawUrl}": more than ${MAX_REDIRECTS} redirects.`);
}

/**
 * Read a response body as text, stopping after MAX_FETCH_BYTES.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readCapped(response) {
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let text = '';
	let bytesRead = 0;

	try {
		while (bytesRead < MAX_FETCH_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;

			const remaining = MAX_FETCH_BYTES - bytesRead;
			// `stream: true` keeps a multi-byte character split across chunks intact.
			text += decoder.decode(value.byteLength > remaining ? value.subarray(0, remaining) : value, { stream: true });
			bytesRead += value.byteLength;
		}
		text += decoder.decode();
	} finally {
		// Releases the connection when we stopped early at the byte cap.
		await reader.cancel().catch(() => {});
	}

	return text;
}

/**
 * Crude HTML-to-text: drop comments, scripts, styles, and tags, decode common
 * entities, collapse whitespace. Same pattern as gmail-sheets-agent's HTML
 * fallback — this only needs to strip markup, not render it.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
	return (
		html
			// Comments first: their contents can hold unbalanced `<` and `>` that
			// would otherwise confuse the tag pass below.
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&(#39|apos);/gi, "'")
			// Numeric entities cover the curly quotes and dashes real articles are
			// full of; without this they reach Claude as literal "&#8217;".
			.replace(/&#(\d+);/g, (match, code) => safeFromCodePoint(Number(code), match))
			.replace(/&#x([0-9a-f]+);/gi, (match, code) => safeFromCodePoint(parseInt(code, 16), match))
			// `&amp;` decodes LAST so that "&amp;lt;" ends up as the literal text
			// "&lt;" rather than being double-decoded into "<".
			.replace(/&amp;/gi, '&')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/**
 * Turn a numeric character reference into text, leaving it alone if it is out
 * of range (String.fromCodePoint throws on those).
 *
 * @param {number} codePoint
 * @param {string} original the entity as written, returned unchanged on failure
 * @returns {string}
 */
function safeFromCodePoint(codePoint, original) {
	try {
		return String.fromCodePoint(codePoint);
	} catch {
		return original;
	}
}
