# Simpsons Chatbot Backend (Cloudflare Worker + RAG)

A Cloudflare Worker that powers a fan-made Simpsons trivia chatbot: it embeds
the incoming question, searches a Vectorize index for the most relevant
facts, and asks Claude to answer using only that retrieved context —
falling back to that only after checking a handful of deterministic,
hand-coded answer paths first.

**Live site:** https://www.simpsons.chat
**Worker URL:** https://simpsons-chatbot.erccrr.workers.dev
**Status:** deployed and live. Everything below reflects the current running
setup, not a from-scratch walkthrough — use it as a reference if you're
redeploying, extending, or forking this.

## Architecture

- **Frontend** (`index.html`, deployed separately to static hosting — see
  [Frontend](#frontend) below): single self-contained HTML file with inline
  CSS/JS. No build step.
- **Workers AI** (`@cf/baai/bge-base-en-v1.5`): generates 768-dimensional
  embeddings for both stored entries and incoming questions.
- **Vectorize** (`simpsons-index`): semantic search over the embedded
  entries.
- **D1** (`simpsons-db`, id `edbee54f-55c3-4afa-9720-bf8704c34e0e`): durable
  source-of-truth copy of every entry (title/text/source/url), plus two
  structured tables — `episode_producers` and `episode_characters` — that
  drive the deterministic lookups described below. The `entries` table can
  be inspected, edited, or re-embedded without touching Vectorize directly.
- **KV** (`simpsons-chatbot-rate-limit`, id `b571b449d38b4ef386ab5246e3374e15`):
  per-IP rate limiting on `/api/chat`.
- **Claude** (`claude-haiku-4-5`): answers strictly from the retrieved
  context — the system prompt explicitly forbids using outside knowledge, to
  keep answers grounded and reduce hallucination.

## Deterministic lookups (`src/index.js`)

Before any question reaches embedding + Vectorize + Claude, `handleChat`
checks three fast, DB-free or DB-backed paths in order. These exist because
"complete list" and well-known-fact questions are exactly where semantic
search + an LLM is prone to give an incomplete or hallucinated answer:

1. **Memorable quotes** (`tryMemorableQuoteLookup`) — a small curated array
   (`MEMORABLE_QUOTES`) of well-known lines fans are likely to type
   verbatim or paraphrase ("Why was I programmed to feel pain?", "I need
   tungsten to live", "Save me, Jebus", the cursed Frogurt exchange, "Well,
   my work here is done." / "Didn't I?"). Matching is done on a normalized
   (lowercased, punctuation-stripped) version of the message; most entries
   match on substring containment, but short/generic trigger phrases are
   flagged `exact: true` to require the whole normalized message to match,
   avoiding false positives inside unrelated sentences. Add new quotes by
   appending to `MEMORABLE_QUOTES`.
2. **Producer/writer credits** (`tryProducerLookup`) — answers "who wrote/
   produced/directed X" and "what did \<person\> work on" style questions
   from the `episode_producers` table, so the answer is a complete,
   grounded list rather than a top-K approximation.
3. **Character episode lookups** (`tryCharacterEpisodesLookup`) — answers
   "which episodes feature X" and "how many episodes has X been in" from
   the `episode_characters` table. Character name resolution
   (`findCharacterName`) does word-boundary-aware fuzzy matching so bare
   first names ("Homer", "Marge") resolve to the right full name rather
   than a same-named minor character, with `MAIN_CHARACTER_FIRST_NAMES`
   short-circuiting the five core family members directly.

   For those same five main characters, the dynamic count/exception logic
   is overridden by a curated, editorially-approved answer
   (`MAIN_CHARACTER_EPISODE_ANSWERS`, one constant per character) rather
   than the raw database count — the raw data has a handful of technical
   edge cases (in-story alias renamings, anthology segments with no
   named credit) that the site intentionally treats as non-exceptions for
   trivia purposes. Update these constants directly in `src/index.js` if
   the desired wording changes.

## Dataset

D1's `entries` table holds **~3,833** semantic-search entries — 3,777
sourced from Wikisimpsons (episodes across all seasons, including Treehouse
of Horror segments as their own entries, plus several hundred characters)
and 56 hand-curated entries for the core cast and frequently-asked facts
(including a detailed Conan O'Brien writer/producer bio). The episode and
character data was built via wikitext scraping + parsing scripts
(`scripts/scrape-characters.js` and the wikitext/infobox extraction
pipeline, not included in this folder) followed by an Anthropic Message
Batches API enrichment pass that generated quotes and longer summaries for
each entry.

Separately, `episode_producers` and `episode_characters` hold structured,
per-episode producer credits and character appearances for all **809**
broadcast episodes (reconciled against the current real episode count as of
August 2026). These are what the deterministic lookups above query — not
the `entries` table, and not Vectorize.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Liveness check — returns `{ ok: true }` |
| POST | `/api/chat` | none (IP rate-limited) | `{ message }` → `{ answer, sources, noMatch? }` |
| POST | `/api/feedback` | none (IP rate-limited) | `{ message, answer, rating: "up"\|"down" }` → logs to `chat_feedback`, returns `{ ok, id }` |
| POST | `/api/feedback/undo` | none (IP rate-limited) | `{ id }` → deletes that `chat_feedback` row, only if inserted in the last 10 minutes |
| POST | `/api/contact` | none (IP rate-limited) | `{ reason, message, email? }` → logs to `contact_messages` |
| POST | `/api/ingest` | `x-ingest-secret` header | `{ entries: [...] }` → upserts into D1 + Vectorize |
| POST | `/api/admin/delete` | `x-ingest-secret` header | `{ ids: [...] }` → removes entries from both D1 and Vectorize by id |

Note: `/api/ingest` and `/api/admin/delete` only touch the `entries` table
and Vectorize. `episode_producers`, `episode_characters`, `chat_feedback`,
and `contact_messages` are all edited/read directly via D1 (`wrangler d1
execute` or the Cloudflare dashboard) — there's no dedicated endpoint for
managing them yet.

Rate limits are now bucketed per endpoint (`RATE_LIMITS` in `src/index.js`)
rather than one shared counter — `/api/chat` keeps the original 30/hour/IP,
`/api/feedback` allows 60/hour/IP, and `/api/contact` is capped at
10/hour/IP to deter spam.

### Feedback and contact data (Beta 1.2)

The frontend's thumbs up/down controls on each chat answer call
`/api/feedback`, and the "Contact / Feedback" button opens a modal (reason
dropdown + message textarea + optional email) that calls `/api/contact`.
Both just log to D1 — review them directly:

```bash
wrangler d1 execute simpsons-db --command "SELECT * FROM chat_feedback ORDER BY created_at DESC LIMIT 50"
wrangler d1 execute simpsons-db --command "SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 50"
```

`chat_feedback.rating` is either `"up"` or `"down"`; use downvoted rows
(with their `message`/`answer` pairs) as a worklist for dataset gaps or
wrong answers. `contact_messages.reason` is one of `incorrect-info`,
`feature-request`, `bug-report`, `business-press`, or `other` — edit the
`CONTACT_REASONS` set and the `<select>` options in `index.html` together if
you want to change this list. Neither table has an email/notification
integration yet — you have to check D1 to see new submissions.

## Prerequisites (for redeploying or forking)

- A Cloudflare account
- [Node.js](https://nodejs.org/) 18+
- The [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- An Anthropic API key

## Redeploying from scratch

If you're forking this into your own Cloudflare account, you'll need to
recreate the bindings referenced in `wrangler.toml`:

```bash
wrangler login

# D1
wrangler d1 create simpsons-db
wrangler d1 execute simpsons-db --file=./schema.sql

# Vectorize (must match the embedding model's 768 dimensions)
wrangler vectorize create simpsons-index --dimensions=768 --metric=cosine

# KV
wrangler kv:namespace create simpsons-chatbot-rate-limit
```

Update the `id`/`database_id` fields in `wrangler.toml` to match what those
commands print out, then:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put INGEST_SECRET
# make up a password — this protects /api/ingest and /api/admin/delete

wrangler deploy
```

This prints your Worker's URL — update `BACKEND_URL` near the top of the
`<script>` block in `index.html` to point at it.

## Making a code change (deterministic lookups, quotes, etc.)

Most day-to-day edits — adding a memorable quote, adjusting a curated
character answer, tweaking a regex pattern — happen directly in
`src/index.js`. The workflow:

```bash
node --check src/index.js   # quick syntax sanity check
cd simpsons-backend         # must run from here, not a parent/other directory
npx wrangler deploy
```

Look for `Success` in the output. If `wrangler` reports a filesystem
permission error referencing an unrelated path (e.g. `~/.Trash`), it almost
always means the command wasn't run from inside `simpsons-backend` — `cd`
into it and retry rather than treating it as a Cloudflare quota issue.

## Loading the dataset

From the `simpsons-backend` folder:

```bash
WORKER_URL=https://simpsons-chatbot.erccrr.workers.dev \
INGEST_SECRET=<your ingest secret> \
node scripts/ingest.js
```

This embeds and stores all entries from `data/simpsons-data.json`. It's an
upsert — safe to re-run any time after adding more entries.

## Removing stale or duplicate entries

```bash
curl -X POST https://simpsons-chatbot.erccrr.workers.dev/api/admin/delete \
  -H "Content-Type: application/json" \
  -H "x-ingest-secret: <your ingest secret>" \
  -d '{"ids": ["entry-id-1", "entry-id-2"]}'
```

Deletes by real entry id from D1; internally translates to the hashed
Vectorize id the same way ingestion does, so you only ever need to pass the
real ids.

## Bulk-crawling the full Wikisimpsons character cast

`scripts/scrape-characters.js` crawls every page in Wikisimpsons'
`Category:Characters` (~9,700 pages) and keeps the ones with a real intro
paragraph (filters out one-scene stub characters via a minimum word count).
It only talks to the public simpsonswiki.com API — no Cloudflare or
Anthropic credentials involved.

```bash
node scripts/scrape-characters.js
```

Long-running (roughly 35–65 minutes at the default request pace) and
resumable — if interrupted, running it again skips pages already written to
`data/simpsons-characters-full.jsonl`. Tune it with env vars if needed:

```bash
MIN_WORDS=40 DELAY_MS=300 node scripts/scrape-characters.js
```

Ingest the results the same way as the starter dataset:

```bash
WORKER_URL=https://simpsons-chatbot.erccrr.workers.dev \
INGEST_SECRET=<your ingest secret> \
node scripts/ingest.js data/simpsons-characters-full.jsonl
```

**Before running the full ingest, know the scale involved:** a few thousand
entries at that `MIN_WORDS` threshold means a few thousand Workers AI
embedding calls and a few thousand Vectorize upserts. Check your Cloudflare
Workers AI plan's daily neuron allowance first — if you hit a limit partway
through, just re-run later; already-ingested ids get safely overwritten, not
duplicated.

**Known scraper limitation:** the wikitext parser that extracts a page's
"Characters" section is not anchored to heading boundaries, so on episodes
with multiple `=== Characters ===` sub-sections nested under segment
headings (anthology episodes like Treehouse of Horror), it can capture only
the first segment's cast and silently drop the rest. This has been found and
manually corrected for several Treehouse of Horror installments; if you
re-run the scraper against new anthology-style episodes, spot-check their
character counts against the wiki page directly.

## Frontend

`index.html` is a single self-contained file (inline CSS/JS, no build step)
that talks to the Worker via the hardcoded `BACKEND_URL` constant. It
depends on an `images/` folder alongside it containing `bg-left.jpg`,
`bg-right.jpg`, `logo.svg`, `promo.jpg`, `speech1.svg`, and
`comicbookguy.svg` — none of which live in this repo folder. Deploy it to
any static host; the live copy is served from HostGator as an addon domain
pointed at `public_html/simpsons-chat/`.

The frontend has been audited and patched for WCAG 2.1 AA compliance
(live-region announcements for new chat messages, labeled form controls,
visible focus states, compliant color contrast throughout) plus one AAA-level
enhancement (44px minimum touch targets on the suggestion buttons).

## Costs to be aware of

- **Workers AI** (embeddings): Cloudflare's free tier includes a daily
  allotment; check current limits in your dashboard.
- **Anthropic API**: billed per token on your Anthropic account. The rate
  limit in the Worker (30 requests/IP/hour on `/api/chat`) is a basic
  guardrail against runaway cost from bots or abuse — tighten
  `RATE_LIMIT_PER_HOUR` in `src/index.js` if you want it stricter.
- **D1 / Vectorize / KV**: all have generous free tiers for a project this
  size.

## Security notes

- `CORS_HEADERS` in `src/index.js` still allows any origin (`*`). Since
  `/api/chat`'s URL is visible in the frontend's page source regardless of
  CORS policy, the only real protection against a third party calling it
  directly (and running up Anthropic API usage) is the per-IP rate limit —
  worth revisiting if abuse becomes a concern (e.g. a shared-secret header,
  Cloudflare Turnstile, or a stricter limit).
- Never commit your Anthropic API key or `INGEST_SECRET` to version
  control — they're set as Worker secrets, not in `wrangler.toml`, on
  purpose. `anthropic-api-key.txt` in this folder is a local scratch file
  and should never be committed or shared either.
