import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import worker from '../src/index.js';

const RUN_TOKEN = 'test-run-token';
const realFetch = globalThis.fetch;

/** A well-formed source, long enough to pass the minimum-length check. */
const LONG_TEXT =
	'Repurposing content across platforms takes real editorial judgement. '.repeat(5) +
	'This paragraph exists purely to clear the 100 character minimum required by the endpoint.';

/** Build a fake Claude Messages API response carrying `content` as its JSON text block. */
function claudeResponse(content, overrides = {}) {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-sonnet-4-6',
		content: [{ type: 'text', text: JSON.stringify(content) }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 500, output_tokens: 700 },
		...overrides,
	};
}

/** Stub global fetch so calls to the Claude API return `content`. */
function stubClaude(content, overrides = {}) {
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === 'https://api.anthropic.com/v1/messages') {
			return Response.json(claudeResponse(content, overrides));
		}
		throw new Error(`unexpected fetch to ${url}`);
	};
}

async function post(body, { auth = true, headers = {} } = {}) {
	const allHeaders = new Headers({ 'Content-Type': 'application/json', ...headers });
	if (auth) allHeaders.set('x-run-token', RUN_TOKEN);

	const request = new Request('http://localhost:8787/repurpose', {
		method: 'POST',
		headers: allHeaders,
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeEach(() => {
	env.RUN_TOKEN = RUN_TOKEN;
	env.ANTHROPIC_API_KEY = 'sk-ant-test';
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('auth', () => {
	it('401s a request with no token', async () => {
		const response = await post({ source: { type: 'text', content: LONG_TEXT } }, { auth: false });
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
	});

	it('401s a request with the wrong token', async () => {
		const response = await post(
			{ source: { type: 'text', content: LONG_TEXT } },
			{ auth: false, headers: { 'x-run-token': 'not-the-token' } },
		);
		expect(response.status).toBe(401);
	});

	it('passes auth with the correct token', async () => {
		stubClaude({ linkedin: 'A LinkedIn post.' });
		const response = await post({ source: { type: 'text', content: LONG_TEXT }, platforms: ['linkedin'] });
		expect(response.status).toBe(200);
	});

	it('fails closed with a 500 when RUN_TOKEN is not configured', async () => {
		delete env.RUN_TOKEN;
		const response = await post({ source: { type: 'text', content: LONG_TEXT } }, { auth: false });
		expect(response.status).toBe(500);
		expect((await response.json()).error).toContain('RUN_TOKEN is not configured');
	});

	it('still 500s when RUN_TOKEN is unset even if a token header is supplied', async () => {
		delete env.RUN_TOKEN;
		const response = await post({ source: { type: 'text', content: LONG_TEXT } });
		expect(response.status).toBe(500);
	});
});

describe('validation', () => {
	it('400s when source content is too short', async () => {
		const response = await post({ source: { type: 'text', content: 'too short' } });
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toMatch(/too short/);
	});

	it('400s an invalid source type', async () => {
		const response = await post({ source: { type: 'pdf', content: LONG_TEXT } });
		expect(response.status).toBe(400);
	});

	it('400s a missing source', async () => {
		const response = await post({});
		expect(response.status).toBe(400);
	});

	it('400s an invalid platform name', async () => {
		const response = await post({ source: { type: 'text', content: LONG_TEXT }, platforms: ['facebook'] });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toMatch(/Unsupported platform/);
	});

	it('400s a youtube source with the coming-soon message', async () => {
		const response = await post({ source: { type: 'youtube', content: 'https://youtu.be/abc' } });
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("YouTube support coming soon. Please paste the transcript as type='text' for now.");
	});

	it('400s when the request body is not valid JSON', async () => {
		const request = new Request('http://localhost:8787/repurpose', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-run-token': RUN_TOKEN },
			body: '{not json',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(400);
	});
});

describe('successful generation', () => {
	it('generates all five platforms when platforms is omitted', async () => {
		const fullContent = {
			linkedin: 'A LinkedIn post about the source.',
			x: ['Tweet 1', 'Tweet 2', 'Tweet 3', 'Tweet 4', 'Tweet 5'],
			instagram: 'An Instagram caption. #hashtag',
			tiktok: 'HOOK (0-3s): [zoom in] Grab attention.',
			email: { subject: 'Subject line', preview: 'Preview text', body: 'Email body.' },
		};
		stubClaude(fullContent);

		const response = await post({ source: { type: 'text', content: LONG_TEXT } });
		expect(response.status).toBe(200);

		const body = await response.json();
		expect(body.source_type).toBe('text');
		expect(body.source_length).toBe(LONG_TEXT.length);
		expect(body.platforms_generated).toEqual(['linkedin', 'x', 'instagram', 'tiktok', 'email']);
		expect(body.content).toEqual(fullContent);
		expect(body.tokens_used).toEqual({ input: 500, output: 700 });
	});

	it.each([
		['linkedin', { linkedin: 'A LinkedIn post.' }],
		['x', { x: ['t1', 't2', 't3', 't4', 't5'] }],
		['instagram', { instagram: 'A caption. #tag' }],
		['tiktok', { tiktok: 'HOOK (0-3s): [cut] Go.' }],
		['email', { email: { subject: 'Subj', preview: 'Prev', body: 'Body' } }],
	])('returns only the %s schema when only that platform is requested', async (platform, content) => {
		stubClaude(content);

		const response = await post({ source: { type: 'text', content: LONG_TEXT }, platforms: [platform] });
		expect(response.status).toBe(200);

		const body = await response.json();
		expect(body.platforms_generated).toEqual([platform]);
		expect(Object.keys(body.content)).toEqual([platform]);
		expect(body.content).toEqual(content);
	});

	it('extracts and strips HTML for a url source before calling Claude', async () => {
		const html = `<html><body><p>${LONG_TEXT}</p></body></html>`;
		globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://example.com/article') {
				return new Response(html, { status: 200 });
			}
			if (url === 'https://api.anthropic.com/v1/messages') {
				return Response.json(claudeResponse({ linkedin: 'Post.' }));
			}
			throw new Error(`unexpected fetch to ${url}`);
		};

		const response = await post({ source: { type: 'url', content: 'https://example.com/article' }, platforms: ['linkedin'] });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.source_type).toBe('url');
	});

	it('400s when a url fetch fails', async () => {
		globalThis.fetch = async () => new Response('nope', { status: 500 });
		const response = await post({ source: { type: 'url', content: 'https://example.com/down' } });
		expect(response.status).toBe(400);
	});

	it('500s with a generic message when the Claude call fails, without leaking details', async () => {
		globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://api.anthropic.com/v1/messages') {
				return Response.json({ type: 'error', error: { type: 'api_error', message: 'internal secret detail' } }, { status: 500 });
			}
			throw new Error(`unexpected fetch to ${url}`);
		};

		const response = await post({ source: { type: 'text', content: LONG_TEXT } });
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.error).toBe('Failed to generate content. Please try again.');
		expect(body.error).not.toContain('internal secret detail');
	});

	it('500s when Claude hits max_tokens before completing the JSON', async () => {
		stubClaude({ linkedin: 'truncated' }, { stop_reason: 'max_tokens' });
		const response = await post({ source: { type: 'text', content: LONG_TEXT }, platforms: ['linkedin'] });
		expect(response.status).toBe(500);
	});
});

describe('routing', () => {
	it('404s unknown paths', async () => {
		const request = new Request('http://localhost:8787/nope', { headers: { 'x-run-token': RUN_TOKEN } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});

	it('404s a GET to /repurpose', async () => {
		const request = new Request('http://localhost:8787/repurpose', { headers: { 'x-run-token': RUN_TOKEN } });
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
	});
});
