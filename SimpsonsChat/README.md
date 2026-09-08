# Ask Springfield — Episode & Character Knowledge Chatbot

A conversational AI that accurately answers questions across an 801-episode,
2,820-character knowledge base — built as a full retrieval-augmented
generation (RAG) pipeline, using *The Simpsons* as the test case for
retrieval accuracy at scale.

**[Live demo](#)** — swap in your deployed frontend URL

## What it does

Ask it about any character, episode, or moment from the show's run — down to
individual *Treehouse of Horror* segments, searchable by roman numeral or
plain number — and it answers conversationally, citing its sources, without
inventing plot details it can't back up.

## Why it's more than a chatbot wrapper

Most "AI chatbot" side projects are a thin UI over a general-purpose model.
This one is grounded: the model is only allowed to answer from facts it
actually retrieved for that specific question, and it says so when it can't
find anything rather than guessing.

## Architecture

```
Browser (index.html)
   │  POST /api/chat { message }
   ▼
Cloudflare Worker (simpsons-backend/src/index.js)
   │
   ├─ 1. Embed the question — Workers AI (bge-base-en-v1.5, 768-dim)
   ├─ 2. Vector search — Vectorize, top-3 most relevant entries
   ├─ 3. Generate — Claude answers using ONLY the retrieved context
   ├─ 4. D1 — durable source-of-truth store for every entry
   └─ 5. KV — per-IP rate limiting (30 req/hour)
```

If the backend can't find a confident match, the frontend falls through to a
live Simpsons Wiki (Fandom) lookup, then Wikipedia — so a question never just
dead-ends.

## The dataset

The knowledge base was built with a custom enrichment pipeline
(`simpsons-backend/simpsons_enrichment_pipeline.py`) that pulls raw wikitext
for every episode and character page and processes it at scale using
**Anthropic's Message Batches API**, plus a dedicated crawler
(`scripts/scrape-characters.js`) that walks Wikisimpsons' full character
category (~9,700 pages).

Final scale:
- 801 episodes
- 2,820 characters
- 3,754 total indexed entries (including per-segment anthology entries)

## Stack

Cloudflare Workers · Workers AI · Vectorize · D1 · KV · Anthropic Claude API
· vanilla HTML/CSS/JS frontend

## Setup

See [`simpsons-backend/README.md`](./simpsons-backend/README.md) for full
deployment steps (Wrangler config, secrets, ingesting the dataset).

---
*Fan-made — not affiliated with or endorsed by Disney/Fox. Built as a
technical exploration of retrieval-grounded chat at scale.*
