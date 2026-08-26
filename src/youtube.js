/**
 * YouTube transcript extraction.
 *
 * Video URL in, plaintext transcript out. Three steps:
 *   1. pull the video ID out of the URL
 *   2. list the video's caption tracks via the YouTube Data API and pick one
 *   3. download that track's text and strip it down to prose
 *
 * Step 3 has a wrinkle worth knowing about: the Data API's caption *download*
 * endpoint requires OAuth for videos you do not own, so an API key alone gets
 * you the track list but not the words. When that download is refused we fall
 * back to youtube.com/api/timedtext, which serves WebVTT without auth. See
 * downloadCaptions().
 *
 * Nothing here may put a request URL in an error message — they carry the API
 * key in a query parameter.
 */

import { HttpError, FETCH_TIMEOUT_MS, readCapped } from './http.js';

const CAPTIONS_API = 'https://www.googleapis.com/youtube/v3/captions';
const TIMEDTEXT_API = 'https://www.youtube.com/api/timedtext';

/** Every YouTube video ID is 11 URL-safe characters. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Hosts whose video URLs we accept. */
const WATCH_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];

/** Path prefixes that carry the video ID as the following segment. */
const PATH_PREFIXES = ['shorts', 'embed'];

/** Caption languages in the order we want them, best first. */
const LANGUAGE_PREFERENCE = ['en', 'en-us', 'en-gb'];

const NO_CAPTIONS_MESSAGE = 'This video has no available captions';
const DOWNLOAD_FAILED_MESSAGE = 'Could not download captions for this video. Please try again.';

/**
 * Fetch a YouTube video's transcript as plaintext.
 *
 * @param {string} rawUrl a youtube.com/watch?v=… or youtu.be/… URL
 * @param {Env} env
 * @returns {Promise<string>} the transcript, uncapped (the caller applies the cap)
 * @throws {HttpError}
 */
export async function extractYouTubeTranscript(rawUrl, env) {
	const videoId = extractVideoId(rawUrl);

	if (!env.YOUTUBE_API_KEY) {
		throw new HttpError('YOUTUBE_API_KEY is not set — add it with: npx wrangler secret put YOUTUBE_API_KEY', {
			status: 500,
			clientMessage: 'YOUTUBE_API_KEY is not configured',
		});
	}

	const track = chooseTrack(await listCaptionTracks(videoId, env.YOUTUBE_API_KEY));
	const transcript = parseCaptions(await downloadCaptions(track, videoId, env.YOUTUBE_API_KEY));

	// A track can exist and still yield nothing usable — an empty timedtext
	// response, or a file that was all music cues.
	if (!transcript) {
		throw new HttpError(`Captions for ${videoId} parsed to an empty transcript.`, {
			status: 400,
			clientMessage: NO_CAPTIONS_MESSAGE,
		});
	}

	return transcript;
}

/**
 * Pull the 11-character video ID out of a YouTube URL.
 *
 * Accepts `youtube.com/watch?v=ID`, `/shorts/ID`, and `/embed/ID` (with or
 * without a `www.`/`m.` prefix), plus `youtu.be/ID`. Anything else — playlists,
 * channels, search results — is rejected rather than guessed at.
 *
 * @param {string} rawUrl
 * @returns {string}
 * @throws {HttpError} 400 if the URL is not a recognised YouTube video link
 */
export function extractVideoId(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw invalidUrl(rawUrl);
	}

	const host = url.hostname.toLowerCase();
	let id;

	if (host === 'youtu.be') {
		// The ID is the first path segment: youtu.be/ID?t=42
		id = url.pathname.split('/').filter(Boolean)[0];
	} else if (WATCH_HOSTS.includes(host)) {
		const [first, second] = url.pathname.split('/').filter(Boolean);
		// /watch keeps the ID in the query; /shorts and /embed keep it in the path.
		if (first === 'watch') id = url.searchParams.get('v');
		else if (PATH_PREFIXES.includes(first)) id = second;
	}

	if (!id || !VIDEO_ID_PATTERN.test(id)) {
		throw invalidUrl(rawUrl);
	}

	return id;
}

/**
 * @param {string} rawUrl
 * @returns {HttpError}
 */
function invalidUrl(rawUrl) {
	return new HttpError(`Not a recognised YouTube video URL: ${rawUrl}`, {
		status: 400,
		clientMessage:
			`"${rawUrl}" is not a recognised YouTube video URL. ` +
			'Use https://www.youtube.com/watch?v=VIDEO_ID or https://youtu.be/VIDEO_ID.',
	});
}

/**
 * List a video's caption tracks.
 *
 * @param {string} videoId
 * @param {string} apiKey
 * @returns {Promise<object[]>} non-empty list of caption resources
 * @throws {HttpError}
 */
async function listCaptionTracks(videoId, apiKey) {
	const url = new URL(CAPTIONS_API);
	url.search = new URLSearchParams({ part: 'snippet', videoId, key: apiKey }).toString();

	const response = await guardedFetch(url, `caption list for ${videoId}`);

	// 403 is quota exhaustion or a bad key — our problem to fix upstream, and
	// retryable once quota resets.
	if (response.status === 403) {
		throw new HttpError(`YouTube caption list for ${videoId} returned 403 (quota exceeded or key invalid).`, {
			status: 502,
			clientMessage: 'The YouTube API rejected this request (quota exceeded or API key invalid).',
		});
	}
	if (response.status === 404) {
		throw new HttpError(`YouTube caption list for ${videoId} returned 404.`, {
			status: 400,
			clientMessage: 'Video not found or is private',
		});
	}
	if (!response.ok) {
		throw new HttpError(`YouTube caption list for ${videoId} returned HTTP ${response.status}.`, {
			status: 502,
			clientMessage: 'The YouTube API returned an error. Please try again.',
		});
	}

	let payload;
	try {
		payload = JSON.parse(await readCapped(response));
	} catch (error) {
		throw new HttpError(`YouTube caption list for ${videoId} was not valid JSON: ${error.message}`, {
			status: 502,
			clientMessage: 'The YouTube API returned an unreadable response. Please try again.',
		});
	}

	const items = Array.isArray(payload?.items) ? payload.items : [];
	if (items.length === 0) {
		throw new HttpError(`Video ${videoId} has no caption tracks.`, {
			status: 400,
			clientMessage: NO_CAPTIONS_MESSAGE,
		});
	}

	return items;
}

/**
 * Pick the best caption track: English first in the order en, en-US, en-GB,
 * then any other English variant, then whatever else exists.
 *
 * @param {object[]} tracks
 * @returns {{ id: string, language: string }}
 */
function chooseTrack(tracks) {
	const languageOf = (track) => (track?.snippet?.language ?? '').toLowerCase();

	for (const language of LANGUAGE_PREFERENCE) {
		const match = pickBest(tracks.filter((track) => languageOf(track) === language));
		if (match) return match;
	}

	// Any other English variant (en-AU, en-CA, …) beats a different language.
	return pickBest(tracks.filter((track) => languageOf(track).startsWith('en'))) ?? pickBest(tracks);
}

/**
 * Choose among same-language tracks, preferring human-written captions over
 * YouTube's automatic speech recognition — ASR tracks have no punctuation and
 * far more errors, which shows up directly in the generated copy.
 *
 * @param {object[]} candidates
 * @returns {{ id: string, language: string } | null}
 */
function pickBest(candidates) {
	if (candidates.length === 0) return null;

	const chosen = candidates.find((track) => track?.snippet?.trackKind !== 'ASR') ?? candidates[0];
	return { id: chosen.id, language: chosen?.snippet?.language ?? 'en' };
}

/**
 * Download a caption track's text.
 *
 * The Data API path only works for videos the API key's owner controls; for
 * anything else it answers 401/403, and we fall through to timedtext.
 *
 * @param {{ id: string, language: string }} track
 * @param {string} videoId
 * @param {string} apiKey
 * @returns {Promise<string>} raw SRT or WebVTT
 * @throws {HttpError}
 */
async function downloadCaptions(track, videoId, apiKey) {
	const url = new URL(`${CAPTIONS_API}/${encodeURIComponent(track.id)}`);
	url.search = new URLSearchParams({ tfmt: 'srt', key: apiKey }).toString();

	const response = await guardedFetch(url, `caption download for ${videoId}`);

	if (response.ok) {
		const body = await readCapped(response);
		if (body.trim()) return body;
		// An empty 200 means we got metadata rather than caption content.
	} else if (response.status !== 401 && response.status !== 403) {
		// 401/403 is the expected "needs OAuth" answer; anything else is a real fault.
		throw new HttpError(`Caption download for ${videoId} returned HTTP ${response.status}.`, {
			status: 502,
			clientMessage: DOWNLOAD_FAILED_MESSAGE,
		});
	}

	return await downloadTimedText(videoId, track.language);
}

/**
 * Fetch captions from the public timedtext endpoint. Undocumented but stable,
 * and needs no authentication.
 *
 * @param {string} videoId
 * @param {string} language BCP-47 tag; only the base language is sent
 * @returns {Promise<string>} raw WebVTT
 * @throws {HttpError}
 */
async function downloadTimedText(videoId, language) {
	const url = new URL(TIMEDTEXT_API);
	url.search = new URLSearchParams({
		v: videoId,
		lang: (language || 'en').split('-')[0],
		fmt: 'vtt',
	}).toString();

	const response = await guardedFetch(url, `timedtext fallback for ${videoId}`);
	if (!response.ok) {
		throw new HttpError(`Timedtext fallback for ${videoId} returned HTTP ${response.status}.`, {
			status: 502,
			clientMessage: DOWNLOAD_FAILED_MESSAGE,
		});
	}

	const body = await readCapped(response);

	// timedtext answers 200 with a zero-length body when it will not serve the
	// track. That is a download failure, not a track that parsed to nothing, and
	// saying so keeps the log honest about which half actually broke.
	if (!body.trim()) {
		throw new HttpError(
			`Timedtext fallback for ${videoId} returned HTTP 200 with an empty body ` +
				`(content-type ${response.headers.get('content-type') ?? 'none'}).`,
			{ status: 502, clientMessage: DOWNLOAD_FAILED_MESSAGE },
		);
	}

	return body;
}

/**
 * Fetch with a timeout, turning transport failures into a 502.
 *
 * `label` is written into the log message, so it must never contain the request
 * URL — that carries the API key.
 *
 * @param {URL} url
 * @param {string} label
 * @returns {Promise<Response>}
 */
async function guardedFetch(url, label) {
	try {
		return await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		const reason = error?.name === 'TimeoutError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : error.message;
		throw new HttpError(`YouTube ${label} failed: ${reason}`, {
			status: 502,
			clientMessage: 'Could not reach YouTube. Please try again.',
		});
	}
}

/**
 * Reduce SRT or WebVTT to prose.
 *
 * Both formats are cue blocks: an optional sequence number, a timestamp line
 * containing `-->`, then one or more text lines. Everything except the text
 * lines is dropped.
 *
 * @param {string} raw
 * @returns {string} single-line transcript, or '' if there was nothing to keep
 */
export function parseCaptions(raw) {
	const kept = [];
	let previous = null;
	// WEBVTT / Kind: / Language: only count as headers before any real text.
	let inHeader = true;

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();

		if (!trimmed) continue;
		if (trimmed.includes('-->')) continue;
		if (/^\d+$/.test(trimmed)) continue; // SRT sequence number
		if (inHeader && /^(WEBVTT|Kind:|Language:)/i.test(trimmed)) continue;
		if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;

		const cleaned = cleanCaptionText(trimmed);
		if (!cleaned) continue;

		// Rolling captions repeat the previous line as the window scrolls, which
		// would otherwise trip the transcript into saying everything twice.
		if (cleaned === previous) continue;

		kept.push(cleaned);
		previous = cleaned;
		inHeader = false;
	}

	return kept.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Strip caption markup and non-speech annotations from one line.
 *
 * @param {string} line
 * @returns {string}
 */
function cleanCaptionText(line) {
	return (
		line
			// WebVTT inline tags and karaoke timings: <c.colorE5E5E5>, <00:00:01.000>
			.replace(/<[^>]*>/g, ' ')
			// Non-speech annotations: [Music], [Applause], [Laughter], [inaudible]
			.replace(/\[[^\]]*\]/g, ' ')
			.replace(/&nbsp;/gi, ' ')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&(#39|apos);/gi, "'")
			// `&amp;` last, so "&amp;lt;" does not double-decode into "<".
			.replace(/&amp;/gi, '&')
			.replace(/\s+/g, ' ')
			.trim()
	);
}
