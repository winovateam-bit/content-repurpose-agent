/**
 * Content Repurposing Agent — Cloudflare Worker.
 *
 * POST /repurpose  { source, platforms?, tone?, target_audience? }
 *   -> { source_type, source_length, platforms_generated, content, tokens_used }
 *
 * Auth: shared-secret header `x-run-token`, checked against env.RUN_TOKEN via
 * timing-safe digest comparison. See checkAuthorization().
 */

import { extractContent, MIN_CONTENT_CHARS } from './extract.js';
import { HttpError } from './http.js';
import { repurposeContent, ALL_PLATFORMS, DEFAULT_TONE } from './repurpose.js';

const VALID_SOURCE_TYPES = ['url', 'text', 'youtube'];
const VALID_TONES = ['professional', 'casual', 'witty', 'educational'];

/**
 * Largest request body accepted.
 *
 * Source text is cut to 20k characters anyway, so a body beyond this is either
 * a mistake or an attempt to make the isolate parse megabytes of JSON. Only
 * enforceable when the client sends Content-Length — a chunked upload falls
 * back to Cloudflare's own platform limit.
 */
const MAX_REQUEST_BYTES = 1_000_000;

/**
 * @param {object} body
 * @param {number} [status]
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function jsonResponse(body, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			...extraHeaders,
		},
	});
}

/**
 * @param {string} message
 * @param {number} status
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
function jsonError(message, status, extraHeaders) {
	return jsonResponse({ error: message }, status, extraHeaders);
}

/**
 * Turn an HttpError into its response, honouring the status and Retry-After it
 * carries. Only `clientMessage` is ever surfaced — `message` is for logs.
 *
 * @param {HttpError} error
 * @returns {Response}
 */
function httpErrorResponse(error) {
	return jsonError(error.clientMessage, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : undefined);
}

/**
 * @param {string} value
 * @returns {Promise<string>} lowercase hex SHA-256 digest
 */
async function sha256Hex(value) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Shared-secret auth. Fails closed if RUN_TOKEN isn't configured, and compares
 * hashed digests (not the raw strings) so the check is timing-safe.
 *
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response | null>} an error Response to return, or null if authorized
 */
async function checkAuthorization(request, env) {
	if (!env.RUN_TOKEN) {
		console.error('[worker] RUN_TOKEN is not configured — refusing to serve a protected endpoint');
		return jsonError('RUN_TOKEN is not configured on this Worker. Set it with: npx wrangler secret put RUN_TOKEN', 500);
	}

	const token = request.headers.get('x-run-token');
	if (!token) return jsonError('Unauthorized', 401);

	const [supplied, expected] = await Promise.all([sha256Hex(token), sha256Hex(env.RUN_TOKEN)]);
	return supplied === expected ? null : jsonError('Unauthorized', 401);
}

/**
 * Validate and normalise the request body.
 *
 * @param {unknown} body
 * @returns {{ source: { type: string, content: string }, platforms: string[], tone: string, targetAudience?: string }}
 * @throws {Error} with a message describing the first validation failure
 */
function validateBody(body) {
	if (!body || typeof body !== 'object') {
		throw new Error('Request body must be a JSON object.');
	}

	const { source, platforms, tone, target_audience: targetAudience } = body;

	if (!source || typeof source !== 'object') {
		throw new Error('"source" is required and must be an object.');
	}
	if (!VALID_SOURCE_TYPES.includes(source.type)) {
		throw new Error(`"source.type" must be one of: ${VALID_SOURCE_TYPES.join(', ')}.`);
	}
	if (typeof source.content !== 'string' || source.content.trim() === '') {
		throw new Error('"source.content" is required and must be a non-empty string.');
	}

	let resolvedPlatforms = ALL_PLATFORMS;
	if (platforms !== undefined) {
		if (!Array.isArray(platforms) || platforms.length === 0) {
			throw new Error('"platforms" must be a non-empty array when provided.');
		}
		const invalid = platforms.filter((platform) => !ALL_PLATFORMS.includes(platform));
		if (invalid.length > 0) {
			throw new Error(`Unsupported platform(s): ${invalid.join(', ')}. Valid platforms: ${ALL_PLATFORMS.join(', ')}.`);
		}
		// De-duplicate: a repeated platform would otherwise appear twice in
		// platforms_generated and repeat its instructions in the prompt.
		resolvedPlatforms = [...new Set(platforms)];
	}

	let resolvedTone = DEFAULT_TONE;
	if (tone !== undefined) {
		if (!VALID_TONES.includes(tone)) {
			throw new Error(`"tone" must be one of: ${VALID_TONES.join(', ')}.`);
		}
		resolvedTone = tone;
	}

	if (targetAudience !== undefined && typeof targetAudience !== 'string') {
		throw new Error('"target_audience" must be a string when provided.');
	}

	return {
		source: { type: source.type, content: source.content },
		platforms: resolvedPlatforms,
		tone: resolvedTone,
		targetAudience: targetAudience || undefined,
	};
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleRepurpose(request, env) {
	const authError = await checkAuthorization(request, env);
	if (authError) return authError;

	const declaredLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
		return jsonError(`Request body is too large (limit ${MAX_REQUEST_BYTES} bytes).`, 413);
	}

	let rawBody;
	try {
		rawBody = await request.json();
	} catch {
		return jsonError('Request body must be valid JSON.', 400);
	}

	let params;
	try {
		params = validateBody(rawBody);
	} catch (error) {
		return jsonError(error.message, 400);
	}

	let sourceText;
	try {
		sourceText = await extractContent(params.source, env);
	} catch (error) {
		// Most extraction failures are the caller's bad input (400), but a YouTube
		// source can also hit a missing key (500) or an upstream fault (502).
		if (error instanceof HttpError) {
			console.error('[worker] extraction failed:', error?.stack ?? error);
			return httpErrorResponse(error);
		}
		return jsonError(error.message, 400);
	}

	// Measured on the trimmed text: 200 spaces around one word is not 200
	// characters of content to repurpose.
	const meaningfulLength = sourceText.trim().length;
	if (meaningfulLength < MIN_CONTENT_CHARS) {
		return jsonError(
			`Extracted content is too short (${meaningfulLength} characters, minimum ${MIN_CONTENT_CHARS}). Provide more substantial source content.`,
			400,
		);
	}

	let result;
	try {
		result = await repurposeContent(env, {
			sourceText,
			platforms: params.platforms,
			tone: params.tone,
			targetAudience: params.targetAudience,
		});
	} catch (error) {
		console.error('[worker] repurposeContent failed:', error?.stack ?? error);

		// HttpError carries a status and a message vetted for the caller;
		// anything else is unexpected and gets the generic 500.
		if (error instanceof HttpError) return httpErrorResponse(error);
		return jsonError('Failed to generate content. Please try again.', 500);
	}

	return jsonResponse({
		source_type: params.source.type,
		source_length: sourceText.length,
		platforms_generated: params.platforms,
		content: result.content,
		tokens_used: result.usage,
	});
}

/**
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function route(request, env) {
	const url = new URL(request.url);

	// Unauthenticated health check for uptime monitoring. Deliberately reports
	// nothing about configuration: a monitor only needs 200 vs not-200, and
	// telling anonymous callers whether secrets are set would be a free hint.
	if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
		return jsonResponse({ status: 'ok', service: 'content-repurpose-agent', endpoint: 'POST /repurpose' });
	}

	if (url.pathname === '/repurpose') {
		if (request.method !== 'POST') {
			return new Response(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }, null, 2), {
				status: 405,
				headers: {
					'Content-Type': 'application/json; charset=utf-8',
					'Cache-Control': 'no-store',
					Allow: 'POST',
				},
			});
		}
		return await handleRepurpose(request, env);
	}

	return jsonError('Not Found', 404);
}

export default {
	async fetch(request, env, ctx) {
		try {
			// `await` rather than returning the promise directly: a rejection has to
			// settle inside this try block for the catch to see it.
			return await route(request, env);
		} catch (error) {
			console.error('[worker] unhandled error:', error?.stack ?? error);
			return jsonError('Internal Server Error', 500);
		}
	},
};
