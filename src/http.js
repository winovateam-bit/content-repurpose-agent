/**
 * Shared HTTP plumbing.
 *
 * The error type the router turns into a response, plus the guards every
 * outbound fetch in this Worker relies on.
 */

/** Outbound fetches time out after this long. */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Most bytes read from any outbound response before the body is truncated.
 *
 * A Worker has a 128 MB memory ceiling shared with everything else in the
 * isolate, and reading an unbounded body will happily blow through it.
 */
export const MAX_FETCH_BYTES = 2_000_000;

/**
 * A failure with a caller-facing status and message.
 *
 * `message` is what gets logged; `clientMessage` is the only part that reaches
 * the caller, so upstream detail — API keys, request URLs, a provider's
 * internal errors — can never leak through it.
 */
export class HttpError extends Error {
	/**
	 * @param {string} message internal message, for logs
	 * @param {{ status?: number, clientMessage?: string, retryAfter?: number }} [options]
	 */
	constructor(message, { status = 500, clientMessage = 'Something went wrong. Please try again.', retryAfter } = {}) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.clientMessage = clientMessage;
		this.retryAfter = retryAfter;
	}
}

/**
 * Read a response body as text, stopping after `maxBytes`.
 *
 * @param {Response} response
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export async function readCapped(response, maxBytes = MAX_FETCH_BYTES) {
	if (!response.body) return '';

	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8');
	let text = '';
	let bytesRead = 0;

	try {
		while (bytesRead < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;

			const remaining = maxBytes - bytesRead;
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
