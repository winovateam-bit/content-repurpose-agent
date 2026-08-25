import { describe, it, expect, afterEach } from 'vitest';
import { extractContent, stripHtml, validateUrl, MAX_CONTENT_CHARS } from '../src/extract.js';

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Serve `body` for any request, with the given status/headers. */
function stubFetch(body, { status = 200, headers = { 'content-type': 'text/html' } } = {}) {
	globalThis.fetch = async () => new Response(body, { status, headers });
}

describe('stripHtml', () => {
	it('removes tags and decodes common entities', () => {
		const html = '<html><body><p>Hello &amp; welcome</p><script>evil()</script><style>.x{}</style></body></html>';
		expect(stripHtml(html)).toBe('Hello & welcome');
	});

	it('collapses whitespace produced by stripped markup', () => {
		expect(stripHtml('<div>  <p>One</p>\n<p>Two</p>  </div>')).toBe('One Two');
	});

	it('strips comments containing angle brackets', () => {
		// A naive tag regex leaves "b -->" behind here.
		expect(stripHtml('<p>Before</p><!-- if a > b then hide --><p>After</p>')).toBe('Before After');
	});

	it('strips noscript, template, and svg content', () => {
		const html = '<p>Keep</p><noscript>Drop</noscript><template>Drop</template><svg><path d="M0 0"/></svg>';
		expect(stripHtml(html)).toBe('Keep');
	});

	it('decodes numeric and hex character references', () => {
		expect(stripHtml('<p>It&#39;s a &#8220;quote&#8221; &#x2014; really</p>')).toBe('It\'s a “quote” — really');
	});

	it('leaves an out-of-range numeric reference untouched', () => {
		expect(stripHtml('<p>&#99999999999;</p>')).toBe('&#99999999999;');
	});

	it('does not double-decode &amp;lt;', () => {
		// Decoding &amp; first would turn this into "<", losing the author's intent.
		expect(stripHtml('<p>&amp;lt;</p>')).toBe('&lt;');
	});
});

describe('validateUrl', () => {
	it('accepts http and https', () => {
		expect(validateUrl('https://example.com/a').hostname).toBe('example.com');
		expect(validateUrl('http://example.com/a').hostname).toBe('example.com');
	});

	it('rejects a malformed URL', () => {
		expect(() => validateUrl('not a url')).toThrow(/not a valid URL/);
	});

	it.each(['file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,<p>hi</p>', 'javascript:alert(1)'])(
		'rejects the non-HTTP scheme in %s',
		(url) => {
			expect(() => validateUrl(url)).toThrow(/Unsupported URL scheme/);
		},
	);

	it.each([
		'http://localhost:8787/admin',
		'http://127.0.0.1/',
		'http://10.0.0.5/',
		'http://192.168.1.1/',
		'http://169.254.169.254/latest/meta-data/',
		'http://172.16.0.1/',
		'http://db.internal/',
		'http://printer.local/',
		'http://[::1]/',
	])('refuses the private or loopback host in %s', (url) => {
		expect(() => validateUrl(url)).toThrow(/private and loopback addresses/);
	});
});

describe('extractContent', () => {
	it('returns text content as-is, capped at MAX_CONTENT_CHARS', async () => {
		const short = 'A'.repeat(50);
		expect(await extractContent({ type: 'text', content: short })).toBe(short);

		const long = 'B'.repeat(MAX_CONTENT_CHARS + 500);
		expect((await extractContent({ type: 'text', content: long })).length).toBe(MAX_CONTENT_CHARS);
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
		stubFetch('<html><body><h1>Title</h1><p>Body text.</p></body></html>');
		expect(await extractContent({ type: 'url', content: 'https://example.com/post' })).toBe('Title Body text.');
	});

	it('caps fetched content at MAX_CONTENT_CHARS', async () => {
		stubFetch(`<p>${'x'.repeat(MAX_CONTENT_CHARS + 5_000)}</p>`);
		const result = await extractContent({ type: 'url', content: 'https://example.com/long' });
		expect(result.length).toBe(MAX_CONTENT_CHARS);
	});

	it('reports a clear error on a non-200 response', async () => {
		stubFetch('not found', { status: 404 });
		await expect(extractContent({ type: 'url', content: 'https://example.com/missing' })).rejects.toThrow(/HTTP 404/);
	});

	it('reports a clear error when the fetch throws', async () => {
		globalThis.fetch = async () => {
			throw new Error('network down');
		};
		await expect(extractContent({ type: 'url', content: 'https://example.com/x' })).rejects.toThrow(
			/Could not fetch URL.*network down/,
		);
	});

	it('names a timeout as the cause rather than "aborted"', async () => {
		globalThis.fetch = async () => {
			const error = new Error('The operation was aborted');
			error.name = 'TimeoutError';
			throw error;
		};
		await expect(extractContent({ type: 'url', content: 'https://example.com/slow' })).rejects.toThrow(/timed out after/);
	});

	it('rejects a non-text content type instead of feeding bytes to Claude', async () => {
		stubFetch('%PDF-1.4 binary junk', { headers: { 'content-type': 'application/pdf' } });
		await expect(extractContent({ type: 'url', content: 'https://example.com/doc.pdf' })).rejects.toThrow(
			/unsupported content type "application\/pdf"/,
		);
	});

	it('accepts a response with no content type at all', async () => {
		globalThis.fetch = async () => new Response('<p>Plain enough</p>', { status: 200, headers: {} });
		expect(await extractContent({ type: 'url', content: 'https://example.com/x' })).toBe('Plain enough');
	});

	it('follows a redirect to an allowed host', async () => {
		const seen = [];
		globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			seen.push(url);
			if (url === 'https://example.com/old') {
				return new Response(null, { status: 301, headers: { location: 'https://example.com/new' } });
			}
			return new Response('<p>Moved here</p>', { status: 200, headers: { 'content-type': 'text/html' } });
		};

		expect(await extractContent({ type: 'url', content: 'https://example.com/old' })).toBe('Moved here');
		expect(seen).toEqual(['https://example.com/old', 'https://example.com/new']);
	});

	it('resolves a relative redirect target against the current hop', async () => {
		globalThis.fetch = async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://example.com/a/old') {
				return new Response(null, { status: 302, headers: { location: '/b/new' } });
			}
			expect(url).toBe('https://example.com/b/new');
			return new Response('<p>Relative</p>', { status: 200, headers: { 'content-type': 'text/html' } });
		};

		expect(await extractContent({ type: 'url', content: 'https://example.com/a/old' })).toBe('Relative');
	});

	it('refuses a redirect that points at a private address', async () => {
		// The whole point of following redirects by hand: an allowed host must not
		// be able to bounce the request into the internal network.
		globalThis.fetch = async () =>
			new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });

		await expect(extractContent({ type: 'url', content: 'https://example.com/evil' })).rejects.toThrow(
			/private and loopback addresses/,
		);
	});

	it('gives up after too many redirects', async () => {
		let hop = 0;
		globalThis.fetch = async () =>
			new Response(null, { status: 302, headers: { location: `https://example.com/hop${hop++}` } });

		await expect(extractContent({ type: 'url', content: 'https://example.com/loop' })).rejects.toThrow(/more than 5 redirects/);
	});

	it('errors on a redirect with no Location header', async () => {
		stubFetch(null, { status: 302, headers: {} });
		await expect(extractContent({ type: 'url', content: 'https://example.com/x' })).rejects.toThrow(/no redirect target/);
	});

	it('refuses a private-address URL before making any request', async () => {
		let called = false;
		globalThis.fetch = async () => {
			called = true;
			return new Response('secret', { status: 200 });
		};

		await expect(extractContent({ type: 'url', content: 'http://169.254.169.254/' })).rejects.toThrow(
			/private and loopback addresses/,
		);
		expect(called).toBe(false);
	});
});
