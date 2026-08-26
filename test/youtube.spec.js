import { describe, it, expect, afterEach } from 'vitest';
import { extractYouTubeTranscript, extractVideoId, parseCaptions } from '../src/youtube.js';

const realFetch = globalThis.fetch;
const ENV = { YOUTUBE_API_KEY: 'test-yt-key' };
const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

afterEach(() => {
	globalThis.fetch = realFetch;
});

const SRT = `1
00:00:01,000 --> 00:00:04,000
[Music]

2
00:00:04,500 --> 00:00:07,000
Most teams adopt AI the wrong way.

3
00:00:07,500 --> 00:00:10,000
They start with the tool, not the task.
`;

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
[Applause]

00:00:04.500 --> 00:00:07.000
<c.colorE5E5E5>Most teams adopt AI the wrong way.</c>

00:00:07.500 --> 00:00:10.000
They start with the tool, not the task.
`;

const EXPECTED = 'Most teams adopt AI the wrong way. They start with the tool, not the task.';

/**
 * Route the three upstream calls this module makes.
 *
 * @param {{ list?: Response | (() => Response), srt?: Response | (() => Response), vtt?: Response | (() => Response) }} routes
 * @returns {string[]} URLs requested, in order
 */
function stubYouTube(routes) {
	const calls = [];
	globalThis.fetch = async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push(url);

		const pick = (route) => (typeof route === 'function' ? route() : route);

		if (url.startsWith('https://www.googleapis.com/youtube/v3/captions?')) {
			return pick(routes.list) ?? Response.json({ items: [] });
		}
		if (url.startsWith('https://www.googleapis.com/youtube/v3/captions/')) {
			return pick(routes.srt) ?? new Response(SRT, { status: 200 });
		}
		if (url.startsWith('https://www.youtube.com/api/timedtext')) {
			return pick(routes.vtt) ?? new Response(VTT, { status: 200 });
		}
		throw new Error(`unexpected fetch to ${url}`);
	};
	return calls;
}

/** A caption-list response with one English track. */
function englishTrack(overrides = {}) {
	return Response.json({ items: [{ id: 'track-1', snippet: { language: 'en', trackKind: 'standard', ...overrides } }] });
}

describe('extractVideoId', () => {
	it.each([
		['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
		['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
		['https://www.youtube.com/embed/dQw4w9WgXcQ?start=10', 'dQw4w9WgXcQ'],
	])('extracts the id from %s', (url, expected) => {
		expect(extractVideoId(url)).toBe(expected);
	});

	it.each([
		['not a url at all'],
		['https://example.com/watch?v=dQw4w9WgXcQ'], // right shape, wrong host
		['https://www.youtube.com/watch'], // no v parameter
		['https://www.youtube.com/watch?v=short'], // not 11 characters
		['https://youtu.be/'], // no id
		['https://www.youtube.com/shorts/'], // prefix with no id
		['https://www.youtube.com/shorts/short'], // not 11 characters
		['https://www.youtube.com/playlist?list=PLdQw4w9WgXcQ'], // not a single video
		['https://www.youtube.com/@somechannel'],
		['https://www.youtube.com/watch?v=has spaces'],
	])('rejects %s with a 400', (url) => {
		try {
			extractVideoId(url);
			throw new Error('expected extractVideoId to throw');
		} catch (error) {
			expect(error.status).toBe(400);
			expect(error.clientMessage).toMatch(/not a recognised YouTube video URL/i);
		}
	});
});

describe('parseCaptions', () => {
	it('strips sequence numbers, timestamps, and blank lines from SRT', () => {
		expect(parseCaptions(SRT)).toBe(EXPECTED);
	});

	it('strips the WEBVTT header, cue tags, and timestamps from VTT', () => {
		expect(parseCaptions(VTT)).toBe(EXPECTED);
	});

	it('removes bracketed annotations', () => {
		const raw = '1\n00:00:01,000 --> 00:00:02,000\n[Music] Hello [Applause] there [Laughter]\n';
		expect(parseCaptions(raw)).toBe('Hello there');
	});

	it('collapses rolling-caption duplicates', () => {
		// Auto-generated captions repeat the previous line as the window scrolls.
		const raw = [
			'1\n00:00:01,000 --> 00:00:02,000\nfirst line',
			'2\n00:00:02,000 --> 00:00:03,000\nfirst line',
			'3\n00:00:03,000 --> 00:00:04,000\nsecond line',
		].join('\n\n');
		expect(parseCaptions(raw)).toBe('first line second line');
	});

	it('returns an empty string when there is nothing but annotations', () => {
		expect(parseCaptions('1\n00:00:01,000 --> 00:00:02,000\n[Music]\n')).toBe('');
	});

	it('keeps a line that merely looks like a header once text has started', () => {
		const raw = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWe begin.\n\n00:00:02.000 --> 00:00:03.000\nLanguage: hard to learn.\n';
		expect(parseCaptions(raw)).toBe('We begin. Language: hard to learn.');
	});
});

describe('extractYouTubeTranscript', () => {
	it('returns a transcript for a watch?v= URL', async () => {
		stubYouTube({ list: englishTrack() });
		expect(await extractYouTubeTranscript(VIDEO_URL, ENV)).toBe(EXPECTED);
	});

	it('returns a transcript for a youtu.be URL', async () => {
		stubYouTube({ list: englishTrack() });
		expect(await extractYouTubeTranscript('https://youtu.be/dQw4w9WgXcQ', ENV)).toBe(EXPECTED);
	});

	it('400s an invalid YouTube URL before calling the API', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return Response.json({ items: [] });
		};

		await expect(extractYouTubeTranscript('https://example.com/video', ENV)).rejects.toMatchObject({ status: 400 });
		expect(called).toBe(false);
	});

	it('500s when YOUTUBE_API_KEY is not configured, without calling out', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return Response.json({ items: [] });
		};

		await expect(extractYouTubeTranscript(VIDEO_URL, {})).rejects.toMatchObject({
			status: 500,
			clientMessage: 'YOUTUBE_API_KEY is not configured',
		});
		expect(called).toBe(false);
	});

	it('400s when the video has no caption tracks', async () => {
		stubYouTube({ list: Response.json({ items: [] }) });
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 400,
			clientMessage: 'This video has no available captions',
		});
	});

	it('400s when captions exist but parse to nothing', async () => {
		stubYouTube({
			list: englishTrack(),
			srt: () => new Response('1\n00:00:01,000 --> 00:00:02,000\n[Music]\n', { status: 200 }),
		});
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 400,
			clientMessage: 'This video has no available captions',
		});
	});

	it('502s when the API reports quota exceeded', async () => {
		stubYouTube({ list: () => new Response('quota', { status: 403 }) });
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 502,
			clientMessage: expect.stringMatching(/quota exceeded or API key invalid/),
		});
	});

	it('400s when the video is not found or private', async () => {
		stubYouTube({ list: () => new Response('nope', { status: 404 }) });
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 400,
			clientMessage: 'Video not found or is private',
		});
	});

	it('502s on any other API failure', async () => {
		stubYouTube({ list: () => new Response('boom', { status: 500 }) });
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({ status: 502 });
	});

	it('502s when the API returns unreadable JSON', async () => {
		stubYouTube({ list: () => new Response('<html>not json</html>', { status: 200 }) });
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({ status: 502 });
	});

	it('502s when YouTube is unreachable', async () => {
		globalThis.fetch = async () => {
			throw new Error('connection reset');
		};
		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 502,
			clientMessage: 'Could not reach YouTube. Please try again.',
		});
	});
});

describe('timedtext fallback', () => {
	it('falls back to timedtext when the SRT download needs OAuth (401)', async () => {
		const calls = stubYouTube({ list: englishTrack(), srt: () => new Response('needs oauth', { status: 401 }) });

		expect(await extractYouTubeTranscript(VIDEO_URL, ENV)).toBe(EXPECTED);
		expect(calls.some((url) => url.startsWith('https://www.youtube.com/api/timedtext'))).toBe(true);
	});

	it('falls back to timedtext on 403 as well', async () => {
		const calls = stubYouTube({ list: englishTrack(), srt: () => new Response('forbidden', { status: 403 }) });

		expect(await extractYouTubeTranscript(VIDEO_URL, ENV)).toBe(EXPECTED);
		expect(calls.some((url) => url.startsWith('https://www.youtube.com/api/timedtext'))).toBe(true);
	});

	it('falls back when the SRT download returns an empty 200', async () => {
		// A key-only request can succeed and still carry no caption content.
		const calls = stubYouTube({ list: englishTrack(), srt: () => new Response('', { status: 200 }) });

		expect(await extractYouTubeTranscript(VIDEO_URL, ENV)).toBe(EXPECTED);
		expect(calls.some((url) => url.startsWith('https://www.youtube.com/api/timedtext'))).toBe(true);
	});

	it('502s when the fallback answers 200 with a zero-length body', async () => {
		// YouTube serves an empty text/html 200 when it will not release a track.
		// That is a failed download, not a track that parsed to nothing.
		stubYouTube({
			list: englishTrack(),
			srt: () => new Response('needs oauth', { status: 401 }),
			vtt: () => new Response('', { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }),
		});

		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 502,
			clientMessage: 'Could not download captions for this video. Please try again.',
		});
	});

	it('does not fall back on a genuine download failure', async () => {
		const calls = stubYouTube({ list: englishTrack(), srt: () => new Response('boom', { status: 500 }) });

		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({ status: 502 });
		expect(calls.some((url) => url.startsWith('https://www.youtube.com/api/timedtext'))).toBe(false);
	});

	it('502s when the fallback itself fails', async () => {
		stubYouTube({
			list: englishTrack(),
			srt: () => new Response('needs oauth', { status: 401 }),
			vtt: () => new Response('gone', { status: 404 }),
		});

		await expect(extractYouTubeTranscript(VIDEO_URL, ENV)).rejects.toMatchObject({
			status: 502,
			clientMessage: 'Could not download captions for this video. Please try again.',
		});
	});

	it('requests the fallback in the chosen track language', async () => {
		const calls = stubYouTube({
			list: Response.json({ items: [{ id: 't-es', snippet: { language: 'es-419', trackKind: 'standard' } }] }),
			srt: () => new Response('needs oauth', { status: 401 }),
		});

		await extractYouTubeTranscript(VIDEO_URL, ENV);
		const timedtext = calls.find((url) => url.startsWith('https://www.youtube.com/api/timedtext'));
		// Base language only — timedtext does not take a region subtag.
		expect(new URL(timedtext).searchParams.get('lang')).toBe('es');
	});
});

describe('caption track selection', () => {
	/** Run a request against `items` and report which track id was downloaded. */
	async function chosenTrackId(items) {
		const calls = stubYouTube({ list: Response.json({ items }) });
		await extractYouTubeTranscript(VIDEO_URL, ENV);
		const download = calls.find((url) => url.startsWith('https://www.googleapis.com/youtube/v3/captions/'));
		return new URL(download).pathname.split('/').pop();
	}

	it('prefers en over en-US and en-GB', async () => {
		const id = await chosenTrackId([
			{ id: 'gb', snippet: { language: 'en-GB' } },
			{ id: 'us', snippet: { language: 'en-US' } },
			{ id: 'en', snippet: { language: 'en' } },
		]);
		expect(id).toBe('en');
	});

	it('prefers en-US over en-GB when there is no plain en', async () => {
		const id = await chosenTrackId([
			{ id: 'gb', snippet: { language: 'en-GB' } },
			{ id: 'us', snippet: { language: 'en-US' } },
		]);
		expect(id).toBe('us');
	});

	it('falls back to another English variant before a different language', async () => {
		const id = await chosenTrackId([
			{ id: 'fr', snippet: { language: 'fr' } },
			{ id: 'au', snippet: { language: 'en-AU' } },
		]);
		expect(id).toBe('au');
	});

	it('falls back to any language when no English track exists', async () => {
		const id = await chosenTrackId([{ id: 'ja', snippet: { language: 'ja' } }]);
		expect(id).toBe('ja');
	});

	it('prefers a human-written track over auto-generated captions', async () => {
		const id = await chosenTrackId([
			{ id: 'asr', snippet: { language: 'en', trackKind: 'ASR' } },
			{ id: 'manual', snippet: { language: 'en', trackKind: 'standard' } },
		]);
		expect(id).toBe('manual');
	});

	it('still uses an ASR track when it is the only one', async () => {
		const id = await chosenTrackId([{ id: 'asr', snippet: { language: 'en', trackKind: 'ASR' } }]);
		expect(id).toBe('asr');
	});
});

describe('secret handling', () => {
	it('never puts the API key in an error message', async () => {
		// Every upstream URL carries ?key=… — an error that echoed one would leak it.
		for (const routes of [
			{ list: () => new Response('quota', { status: 403 }) },
			{ list: () => new Response('nope', { status: 404 }) },
			{ list: () => new Response('boom', { status: 500 }) },
			{ list: englishTrack(), srt: () => new Response('boom', { status: 500 }) },
			{ list: englishTrack(), srt: () => new Response('x', { status: 401 }), vtt: () => new Response('x', { status: 404 }) },
		]) {
			stubYouTube(routes);
			const error = await extractYouTubeTranscript(VIDEO_URL, ENV).catch((caught) => caught);

			expect(`${error.message} ${error.clientMessage}`).not.toContain(ENV.YOUTUBE_API_KEY);
		}
	});
});
