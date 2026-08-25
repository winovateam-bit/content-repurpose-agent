/**
 * Platform-specific content generation via the Claude API.
 *
 * One extracted source in, one object of platform variants out. The response
 * shape is pinned with structured outputs (`output_config.format`), so the
 * model cannot wrap the JSON in a markdown fence or add commentary — the text
 * block is always parseable, and it only contains the platforms requested.
 */

import Anthropic from '@anthropic-ai/sdk';

/** Quality matters more than cost for this endpoint. */
const MODEL = 'claude-sonnet-4-6';

/** Five long-form platform outputs (LinkedIn, an X thread, Instagram, a TikTok script, an email) need real headroom. */
const MAX_TOKENS = 8000;

export const ALL_PLATFORMS = ['linkedin', 'x', 'instagram', 'tiktok', 'email'];

export const DEFAULT_TONE = 'professional';

const SYSTEM_PROMPT =
	'You are a content repurposing expert. Given a source content, generate platform-specific variants ' +
	"that preserve the core insight while adapting tone, length, format, and hooks to each platform's " +
	'best practices. Return JSON only, no markdown.';

/** Per-platform format requirements, spelled out for the prompt. */
const PLATFORM_INSTRUCTIONS = {
	linkedin:
		'LINKEDIN (200-300 words): Professional but conversational hook (a question or a bold statement) as the ' +
		'opening line. Short paragraphs of 2-3 lines each. Insight-driven, not promotional. End with a soft ' +
		'CTA or question that invites comments.',
	x: 'X THREAD (5-8 tweets): First tweet is the hook, under 280 characters, standalone-compelling. Every tweet ' +
		'is 100-280 characters. Each tweet advances one idea. The last tweet has a CTA or a summary that ties the ' +
		'thread together.',
	instagram:
		'INSTAGRAM CAPTION (150-250 words): First line is the hook — it must work even when the caption is ' +
		'truncated. Use line breaks between ideas for readability. End with 8-15 relevant hashtags.',
	tiktok:
		'TIKTOK/REELS SCRIPT (30-60 seconds): Structured as HOOK (0-3s), VALUE (4-45s), CTA (46-60s), each ' +
		'labelled. Include visual cue suggestions in [brackets] throughout, e.g. [cut to text overlay], ' +
		'[point at camera].',
	email: 'EMAIL NEWSLETTER: A subject line, a preview/preheader line, and a 300-500 word body with subheadings ' +
		'and a clear call to action.',
};

/**
 * Generate platform variants for a source.
 *
 * @param {Env} env
 * @param {{ sourceText: string, platforms: string[], tone: string, targetAudience?: string }} params
 * @returns {Promise<{ content: object, usage: { input: number, output: number } }>}
 * @throws {Error} if the API call fails or returns unparseable/refused content
 */
export async function repurposeContent(env, { sourceText, platforms, tone, targetAudience }) {
	if (!env.ANTHROPIC_API_KEY) {
		throw new Error('ANTHROPIC_API_KEY is not set — add it with: npx wrangler secret put ANTHROPIC_API_KEY');
	}

	// Construct per request: Workers only expose bindings inside the handler.
	const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

	const userPrompt = buildUserPrompt({ sourceText, platforms, tone, targetAudience });
	const schema = buildResponseSchema(platforms);

	let response;
	try {
		response = await client.messages.create({
			model: MODEL,
			max_tokens: MAX_TOKENS,
			system: SYSTEM_PROMPT,
			output_config: { format: { type: 'json_schema', schema } },
			messages: [{ role: 'user', content: userPrompt }],
		});
	} catch (error) {
		// Typed SDK errors: distinguish retryable from permanent for the caller's logs.
		if (error instanceof Anthropic.AuthenticationError) {
			throw new Error('Claude API rejected ANTHROPIC_API_KEY.');
		}
		if (error instanceof Anthropic.RateLimitError) {
			throw new Error('Claude API rate limited this request.');
		}
		if (error instanceof Anthropic.APIConnectionError) {
			throw new Error(`Could not reach the Claude API: ${error.message}`);
		}
		if (error instanceof Anthropic.APIError) {
			throw new Error(`Claude API error ${error.status}: ${error.message}`);
		}
		throw error;
	}

	// A refusal or a token cutoff means the schema was not honoured.
	if (response.stop_reason === 'refusal') {
		throw new Error('Claude declined to repurpose this content.');
	}
	if (response.stop_reason === 'max_tokens') {
		throw new Error('Claude response hit max_tokens before completing the JSON.');
	}

	const text = response.content.find((block) => block.type === 'text')?.text;
	if (!text) {
		throw new Error('Claude returned no text content.');
	}

	return {
		content: JSON.parse(text),
		usage: {
			input: response.usage.input_tokens,
			output: response.usage.output_tokens,
		},
	};
}

/**
 * @param {{ sourceText: string, platforms: string[], tone: string, targetAudience?: string }} params
 * @returns {string}
 */
function buildUserPrompt({ sourceText, platforms, tone, targetAudience }) {
	return [
		'Repurpose the source content below into the requested platform formats.',
		'',
		`Tone: ${tone}`,
		targetAudience ? `Target audience: ${targetAudience}` : null,
		`Platforms requested: ${platforms.join(', ')}`,
		'',
		'Source content:',
		sourceText,
		'',
		'Format requirements per platform:',
		...platforms.map((platform) => `- ${PLATFORM_INSTRUCTIONS[platform]}`),
		'',
		'Preserve the core insight of the source in every variant. Do not invent facts not present in the source.',
	]
		.filter((line) => line !== null)
		.join('\n');
}

/**
 * Build the structured-output schema for exactly the requested platforms.
 *
 * Structured outputs require `additionalProperties: false` and every key
 * listed in `required`, so the schema is built dynamically rather than kept
 * static with optional fields — an unrequested platform must be absent from
 * the object entirely, not merely nullable. Length/word-count rules aren't
 * expressible here (no `minLength`/`maxLength` in the schema subset), so
 * they live in the prompt instead.
 *
 * @param {string[]} platforms
 * @returns {object}
 */
function buildResponseSchema(platforms) {
	const properties = {};

	if (platforms.includes('linkedin')) {
		properties.linkedin = { type: 'string', description: 'LinkedIn post, 200-300 words.' };
	}
	if (platforms.includes('x')) {
		properties.x = {
			type: 'array',
			items: { type: 'string' },
			description: 'X thread, 5-8 tweets, each 100-280 characters.',
		};
	}
	if (platforms.includes('instagram')) {
		properties.instagram = { type: 'string', description: 'Instagram caption, 150-250 words, ending in hashtags.' };
	}
	if (platforms.includes('tiktok')) {
		properties.tiktok = { type: 'string', description: 'TikTok/Reels script with HOOK/VALUE/CTA sections and [visual cues].' };
	}
	if (platforms.includes('email')) {
		properties.email = {
			type: 'object',
			properties: {
				subject: { type: 'string', description: 'Email subject line.' },
				preview: { type: 'string', description: 'Email preview/preheader text.' },
				body: { type: 'string', description: 'Email body, 300-500 words, with subheadings and a CTA.' },
			},
			required: ['subject', 'preview', 'body'],
			additionalProperties: false,
		};
	}

	return {
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	};
}
