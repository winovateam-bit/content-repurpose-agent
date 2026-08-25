# Content Repurposing Agent

A Cloudflare Worker that turns one piece of source content into platform-specific
variants — a LinkedIn post, an X thread, an Instagram caption, a TikTok/Reels
script, and an email newsletter — using Claude.

Give it raw text or a URL; it returns ready-to-post copy for whichever platforms
you ask for.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in both values
npm run dev                      # http://localhost:8787
```

`.dev.vars` needs two secrets:

| Name                | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Anthropic API key — https://console.anthropic.com/settings/keys                |
| `RUN_TOKEN`         | Shared secret callers send as `x-run-token`. Any long random string will do.   |

Generate a token with `node -e "console.log(crypto.randomUUID())"`.

## Deploying

Secrets are **not** read from `.dev.vars` in production — set them on the Worker
first, or every request will fail closed with a 500:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RUN_TOKEN
npx wrangler deploy
```

## API

### `POST /repurpose`

Send `x-run-token: <RUN_TOKEN>`. Any other request to this path is rejected
before the body is read.

**Request body**

```json
{
  "source": {
    "type": "text",
    "content": "AI is transforming how businesses operate..."
  },
  "platforms": ["linkedin", "x"],
  "tone": "professional",
  "target_audience": "B2B SaaS founders"
}
```

| Field             | Required | Notes                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------- |
| `source.type`     | yes      | `"text"`, `"url"`, or `"youtube"`                                            |
| `source.content`  | yes      | Raw text for `text`; an http(s) URL for `url` and `youtube`                  |
| `platforms`       | no       | Any of `linkedin`, `x`, `instagram`, `tiktok`, `email`. Defaults to all five. |
| `tone`            | no       | `professional` (default), `casual`, `witty`, `educational`                   |
| `target_audience` | no       | Free text, e.g. `"B2B SaaS founders"`                                        |

**Response**

```json
{
  "source_type": "text",
  "source_length": 284,
  "platforms_generated": ["linkedin", "x"],
  "content": {
    "linkedin": "Most companies adopting AI are asking the wrong question...",
    "x": ["Tweet 1...", "Tweet 2...", "..."]
  },
  "tokens_used": { "input": 512, "output": 1340 }
}
```

`content` contains a key for each requested platform and nothing else:

| Platform    | Shape                                             |
| ----------- | ------------------------------------------------- |
| `linkedin`  | `string` — 200–300 words                          |
| `x`         | `string[]` — 5–8 tweets, each 100–280 chars       |
| `instagram` | `string` — 150–250 words, ending in 8–15 hashtags |
| `tiktok`    | `string` — 30–60s script, HOOK/VALUE/CTA          |
| `email`     | `{ subject, preview, body }` — body 300–500 words |

Length and formatting rules are enforced through the prompt, not the schema, so
treat them as strong guidance rather than hard guarantees.

**Example**

```bash
curl -X POST http://localhost:8787/repurpose \
  -H "Content-Type: application/json" \
  -H "x-run-token: $RUN_TOKEN" \
  -d @test.json
```

### `GET /`

Unauthenticated health check for uptime monitoring. Always `200` with
`{"status":"ok",...}` as long as the Worker is running. It deliberately reports
nothing about whether secrets are configured — a monitor only needs 200 vs
not-200, and anonymous callers shouldn't learn your configuration state. `HEAD`
works too.

### Errors

Every error is JSON: `{ "error": "..." }`.

| Status | When                                                                        | Retry?                            |
| ------ | --------------------------------------------------------------------------- | --------------------------------- |
| `400`  | Malformed JSON, failed validation, content under 100 chars, URL fetch failed | No — fix the request              |
| `401`  | `x-run-token` missing or wrong                                              | No                                |
| `404`  | Unknown path                                                                 | No                                |
| `405`  | Non-POST request to `/repurpose`                                             | No                                |
| `413`  | Request body over 1 MB                                                       | No                                |
| `422`  | Claude declined to process this source content                               | No — the content is the problem   |
| `429`  | Upstream rate limit                                                          | Yes — after `Retry-After` seconds |
| `500`  | Server misconfigured (missing secret) or a bug on our side                    | No — needs an operator            |
| `502`  | Claude unreachable, errored, or returned unusable output                     | Yes                               |

Upstream errors return a generic message — the underlying detail goes to
`console.error` (visible via `wrangler tail`) and never reaches the caller.

**On 429:** the Worker does not retry Claude internally. Retrying inside the
request would hold your connection open for however long Anthropic asks and
swallow the `Retry-After` you need. You get the 429 and the header immediately;
back off and retry on your side.

## Source types

- **`text`** — used as-is, cut to 20,000 characters.
- **`url`** — fetched and stripped to plaintext. Only `http`/`https`; private,
  loopback, and link-local hosts are refused; redirects are followed at most 5
  hops with each hop re-validated; non-text content types (PDFs, images) are
  rejected; at most 2 MB is read.
- **`youtube`** — not implemented yet. Returns a 400 asking for the transcript
  as `type: "text"`.

## Notes for operators

- **Content from a URL is untrusted.** It is fenced in the prompt and Claude is
  told to treat it as material rather than instructions, but prompt injection is
  not a solved problem — do not wire this to anything that acts on the output
  automatically without review.
- **The URL fetcher makes outbound requests on your behalf.** Anyone with a
  valid `RUN_TOKEN` can point it at any public address. Host validation blocks
  the obvious internal targets, but a hostname that resolves to a private
  address at fetch time (DNS rebinding) is not something a Worker can defend
  against — block egress at the network layer if that matters for your
  deployment.
- **Model.** Claude Sonnet 5, with adaptive thinking left on (its default). That
  buys better planning across five platforms at the cost of some latency, and
  reasoning tokens are drawn from the same 16k budget as the output — which is
  why `max_tokens` is set well above what the copy alone needs. Both live in
  `src/repurpose.js`.
- **Latency.** Generation is synchronous and a five-platform request can take
  tens of seconds. The Claude call is capped at 120 s. If you need to fan this
  out over many pieces of content, queue the calls rather than holding HTTP
  connections open.
- **Cost.** Each call is one Claude request. A five-platform generation runs
  roughly 500 input / 1,500 output tokens, plus thinking tokens; `tokens_used`
  in the response reports the actual figures.

## Tests

```bash
npm test
```

Runs against the real Workers runtime via `@cloudflare/vitest-pool-workers`. The
Claude API and outbound URL fetches are stubbed — no network calls, no spend.

## Layout

| File               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `src/index.js`     | Routing, auth, request validation, response envelope            |
| `src/extract.js`   | Source → plaintext (URL fetching, HTML stripping, size caps)    |
| `src/repurpose.js` | Prompt construction, the Claude call, response validation       |
