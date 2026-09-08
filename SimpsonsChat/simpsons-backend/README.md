# Simpsons Chatbot Backend (Cloudflare Worker + RAG)

A Cloudflare Worker that gives the fan site a real, free-form chatbot: it embeds
your question, searches a Vectorize index for the most relevant facts, and asks
Claude to answer using only that retrieved context.

## Prerequisites

- A Cloudflare account (you've already got one)
- [Node.js](https://nodejs.org/) 18+
- The [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- An Anthropic API key

## Status: partially set up already

D1 database and KV namespace were already created and wired into
`wrangler.toml` (via the Cloudflare MCP connector in Cowork) — you can skip
steps 1, 2, and 4 below. Only Vectorize (step 3) and the actual Worker
deployment (step 6) still need to happen, since that connector doesn't cover
Vectorize or Worker script deployment.

## 1. Log in to Cloudflare

```bash
wrangler login
```

## 2. ~~Create the D1 database~~ (already done)

`simpsons-db` exists (id `edbee54f-55c3-4afa-9720-bf8704c34e0e`) and the
schema from `schema.sql` has already been applied — the `entries` table and
its index are live. Nothing to do here.

## 3. Create the Vectorize index

The embedding model (`@cf/baai/bge-base-en-v1.5`) outputs 768-dimensional
vectors, so the index needs to match:

```bash
wrangler vectorize create simpsons-index --dimensions=768 --metric=cosine
```

## 4. ~~Create the KV namespace~~ (already done)

`simpsons-chatbot-rate-limit` exists (id `b571b449d38b4ef386ab5246e3374e15`)
and is already referenced in `wrangler.toml`. Nothing to do here.

## 5. Set your secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
# paste your Anthropic API key when prompted

wrangler secret put INGEST_SECRET
# make up a password — this protects the /api/ingest endpoint
```

## 6. Deploy

```bash
wrangler deploy
```

This prints your Worker's URL, something like:
`https://simpsons-chatbot.<your-subdomain>.workers.dev`

## 7. Load the dataset

From the `simpsons-backend` folder:

```bash
WORKER_URL=https://simpsons-chatbot.<your-subdomain>.workers.dev \
INGEST_SECRET=<the same password you set above> \
node scripts/ingest.js
```

This embeds and stores all 17 starter entries from `data/simpsons-data.json`.
Run it again any time after you add more entries to that file (it's an
upsert — safe to re-run).

## 8. Point the frontend at your Worker

In `simpsons-chat.html`, set the `BACKEND_URL` constant near the top of the
`<script>` block to your Worker URL from step 6. The site will call your
backend first for real LLM-powered answers, and fall back to the old
client-side Wikipedia/Fandom lookups only if the backend is unreachable.

## Adding more data later

Add entries to `data/simpsons-data.json` (same shape: `id`, `title`, `keys`,
`text`, `source`, `url`) and re-run the ingest script. No redeploy needed —
ingestion just writes into D1 + Vectorize.

## Bulk-crawling the full Wikisimpsons character cast

`scripts/scrape-characters.js` crawls every page in Wikisimpsons'
`Category:Characters` (~9,700 pages) and keeps the ones with a real intro
paragraph (filters out one-scene stub characters via a minimum word count).
It only talks to the public simpsonswiki.com API — no Cloudflare or Anthropic
credentials involved.

```bash
node scripts/scrape-characters.js
```

This is a long-running job (roughly 35–65 minutes at the default request
pace) and is resumable — if it's interrupted, just run it again and it skips
pages already written to `data/simpsons-characters-full.jsonl`.

Tune it with env vars if you want:

```bash
MIN_WORDS=40 DELAY_MS=300 node scripts/scrape-characters.js
```

Once it's done, ingest the results the same way as the starter dataset:

```bash
WORKER_URL=https://simpsons-chatbot.<your-subdomain>.workers.dev \
INGEST_SECRET=<your ingest secret> \
node scripts/ingest.js data/simpsons-characters-full.jsonl
```

**Before running the full ingest, know the scale involved:** a few thousand
entries at that MIN_WORDS threshold means a few thousand Workers AI embedding
calls and a few thousand Anthropic-adjacent Vectorize upserts. Check your
Cloudflare Workers AI plan's daily neuron allowance before ingesting the
whole thing — if you hit the free tier limit partway through, the ingest
script's batching means you can just re-run it later; already-ingested IDs
get safely overwritten (upserted), not duplicated.

## Costs to be aware of

- **Workers AI** (embeddings): Cloudflare's free tier includes a daily
  allotment; check current limits in your dashboard.
- **Anthropic API**: billed per token on your Anthropic account. The rate
  limit in the Worker (30 requests/IP/hour) is a basic guardrail against
  runaway costs from bots or abuse — tighten `RATE_LIMIT_PER_HOUR` in
  `src/index.js` if you want it stricter.
- **D1 / Vectorize / KV**: all have generous free tiers for a project this size.

## Security notes

- `CORS_HEADERS` in `src/index.js` currently allows any origin (`*`). Once
  your site has a real domain, change `Access-Control-Allow-Origin` to that
  domain specifically.
- Never commit your Anthropic API key or `INGEST_SECRET` to version control —
  they're set as Worker secrets, not in `wrangler.toml`, on purpose.
