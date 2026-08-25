import { describe, it, expect } from 'vitest';
import { extractContent, stripHtml, MAX_CONTENT_CHARS } from '../src/extract.js';

describe('stripHtml', () => {
	it('removes tags and decodes common entities', () => {
		const html = '<html><body><p>Hello &amp; welcome</p><script>evil()</script><style>.x{}</style></body></html>';
		expect(stripHtml(html)).toBe('Hello & welcome');
	});

	it('collapses whitespace produced by stripped markup', () => {
		const html = '<div>  <p>One</p>\n<p>Two</p>  </div>';
		expect(stripHtml(html)).toBe('One Two');
	});
});

describe('extractContent', () => {
	it('returns text content as-is, capped at MAX_CONTENT_CHARS', async () => {
		const short = 'A'.repeat(50);
		expect(await extractContent({ type: 'text', content: short })).toBe(short);

		const long = 'B'.repeat(MAX_CONTENT_CHARS + 500);
		const result = await extractContent({ type: 'text', content: long });
		expect(result.length).toBe(MAX_CONTENT_CHARS);
	});

	it('rejects a youtube source with the coming-soon message', async () => {
		await expect(extractContent({ type: 'youtube', content: 'https://youtu.be/abc' })).rejects.toThrow(
			"YouTube support coming soon. Please paste the transcript as type='text' for now.",
		);
	});

	it('rejects an unsupported source type', async () => {
		await expect(extractContent({ type: 'pdf', content: 'x' })).rejects.toThrow(/Unsupported source type/);
	});

	it('fetches a URL and strips its HTML', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response('<html><body><h1>Title</h1><p>Body text.</p></body></html>', { status: 200 });

		try {
			const result = await extractContent({ type: 'url', content: 'https://example.com/post' });
			expect(result).toBe('Title Body text.');
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('reports a clear error when the URL fetch fails', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response('not found', { status: 404 });

		try {
			await expect(extractContent({ type: 'url', content: 'https://example.com/missing' })).rejects.toThrow(/HTTP 404/);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('reports a clear error when the URL fetch throws', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error('network down');
		};

		try {
			await expect(extractContent({ type: 'url', content: 'https://example.com/timeout' })).rejects.toThrow(
				/Could not fetch URL/,
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
