# Ask Springfield — A Simpsons Trivia Chatbot

**Live:** https://www.simpsons.chat

A fan-made chatbot that answers questions about The Simpsons — characters,
episodes, and Springfield trivia — grounded in a purpose-built knowledge base
rather than general model knowledge, with live wiki fallbacks for anything
outside that dataset.

## How it works

1. Before anything else, the question is checked against a set of
   deterministic, hand-coded answer paths: producer/writer credits, "which
   episodes feature X" / "how many episodes has X been in" character
   lookups, and a small library of memorable-quote triggers. These exist
   because for complete-list and well-known-fact questions, an exact,
   grounded answer beats an approximate one pulled from semantic search.
2. If none of those match, the question is embedded and matched against a
   Vectorize index of curated and Wikisimpsons-sourced entries.
3. The retrieved context is passed to Claude, which is instructed to answer
   using *only* that context — reducing hallucination on a subject where
   getting details wrong is easy to spot.
4. If nothing relevant is found, the frontend falls back to a small built-in
   dataset for the core cast, then live lookups against the Simpsons Wiki
   (Fandom) and Wikipedia APIs.

The whole pipeline — embeddings, vector search, deterministic lookups, rate
limiting, and generation — runs serverless on Cloudflare (Workers, Workers
AI, Vectorize, D1, KV) plus the Anthropic API.

## Repo structure

```
index.html            Frontend — single self-contained static HTML file
                       (depends on an images/ folder not included here; see
                       simpsons-backend/README.md for the asset list)
simpsons-backend/      Cloudflare Worker backend (RAG + deterministic
                       lookups), dataset, ingestion scripts, and deployment
                       instructions — see simpsons-backend/README.md
```

## Dataset

~3,833 semantic-search entries covering every season's episodes (including
Treehouse of Horror segments as individual entries) and several hundred
characters, built from Wikisimpsons via a scrape-and-enrich pipeline, plus a
small hand-curated set for the core cast and frequently-asked facts.

Alongside that, D1 tracks structured producer credits and character
appearances for all **809** broadcast episodes, which power the exact-answer
lookups described above (complete producer/writer lists, full "which
episodes feature X" results, and curated episode-count write-ups for Homer,
Marge, Bart, Lisa, and Maggie). See `simpsons-backend/README.md` for how the
dataset is loaded, structured, and extended.

## Accessibility

The frontend has been audited and patched against WCAG 2.1 AA (labeled
controls, live-region announcements for new chat messages, visible focus
states, compliant color contrast) plus one AAA-level enhancement (44px
minimum touch targets).

## License and attribution

Fan-made project — not affiliated with, endorsed by, or sponsored by Fox,
Disney, or Matt Groening. The Simpsons, its characters, and all related
indicia are trademarks and/or copyrights of Fox and its related entities.

Character and episode data is adapted from the Simpsons Wiki (Fandom),
licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),
and from Wikipedia, licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Both
sources' text remains © their respective contributors.

Site design, code, and original write-ups © 2026 Oxygen For Aliens LLC.

## Deploying your own copy

See [`simpsons-backend/README.md`](simpsons-backend/README.md) for the full
backend setup (Cloudflare bindings, secrets, deploy, dataset ingestion) and
frontend deployment notes.
