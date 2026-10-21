#!/usr/bin/env node
/**
 * Scrapes Wikisimpsons' /Credits and /Appearances subpages for every episode
 * in data/episode-titles.json, using the MediaWiki action=raw wikitext API
 * (not scraped HTML) — this is the same source Wikisimpsons itself renders
 * from, so parsing it directly is far more reliable than scraping markup.
 *
 * Output: two JSONL files in data/ —
 *   episode-producers.jsonl   { episode_id, role, person }
 *   episode-characters.jsonl  { episode_id, character, appearance_type }
 *
 * "role" for producers is the full credit-block label as it appears on the
 * page (e.g. "Produced by", "Co-Executive Producer", "Supervising Producer")
 * lowercased and normalized for tense/case (see PRODUCER_ROLE_ALIASES).
 * "appearance_type" for characters is one of: voiced, cameo, mentioned,
 * picture, or "" (unmarked — had a role but wasn't background/cameo, per
 * Wikisimpsons' own legend).
 *
 * Resumable: re-running skips episodes already present in both output files,
 * so an interrupted run just picks back up.
 *
 * --- Rate limiting / 429 handling ---
 * Wikisimpsons (or its CDN) appears to apply a block that outlasts a short
 * in-run backoff — hammering through hundreds of episodes at ~300ms/request
 * can trigger it, and once triggered, every subsequent request in the same
 * run will also fail instantly, burning through the whole remaining list for
 * nothing and possibly extending the block. This version:
 *   1. Retries individual requests on 429/403/503 with exponential backoff,
 *      honoring a `Retry-After` header when the server sends one.
 *   2. Trips a circuit breaker and stops the ENTIRE run (rather than plowing
 *      through remaining episodes) after several consecutive blocked
 *      responses, logging a snippet of the response body for diagnosis.
 *   3. Defaults to a slower base delay between requests, and supports an
 *      optional per-run cap (MAX_EPISODES_PER_RUN) so you can deliberately
 *      scrape in small batches spread across sessions instead of one long
 *      run that's more likely to trip rate limiting again.
 * Already-scraped episodes are skipped automatically on the next run either
 * way, so stopping early (via the circuit breaker or the per-run cap) never
 * loses progress.
 *
 * Usage:
 *   node scripts/scrape-episode-credits-appearances.js
 *   DELAY_MS=3000 node scripts/scrape-episode-credits-appearances.js        # slower/faster base pacing
 *   MAX_EPISODES_PER_RUN=50 node scripts/scrape-episode-credits-appearances.js  # small batch, then stop
 *   CIRCUIT_BREAKER_THRESHOLD=4 node scripts/scrape-episode-credits-appearances.js
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TITLES_FILE = path.join(DATA_DIR, "episode-titles.json");
const PRODUCERS_OUT = path.join(DATA_DIR, "episode-producers.jsonl");
const CHARACTERS_OUT = path.join(DATA_DIR, "episode-characters.jsonl");
const FAILURES_OUT = path.join(DATA_DIR, "scrape-failures.jsonl");

// Base delay between successful requests. Wikisimpsons has proven sensitive
// to fast, sustained request bursts, so this defaults much slower than
// before (was 300ms).
const DELAY_MS = parseInt(process.env.DELAY_MS || "2000", 10);

// Per-request retry/backoff on blocked responses (429/403/503).
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "5", 10);
const BASE_BACKOFF_MS = parseInt(process.env.BASE_BACKOFF_MS || "30000", 10); // 30s
const MAX_BACKOFF_MS = parseInt(process.env.MAX_BACKOFF_MS || "900000", 10); // 15 min cap per retry

// Circuit breaker: stop the whole run (don't burn through remaining
// episodes) after this many CONSECUTIVE episodes fail due to blocking,
// even after each one exhausted its own retries above.
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD || "4", 10);

// Optional cap on how many NEW episodes to attempt this run, so you can
// deliberately scrape in small batches across sessions/days.
const MAX_EPISODES_PER_RUN = process.env.MAX_EPISODES_PER_RUN
  ? parseInt(process.env.MAX_EPISODES_PER_RUN, 10)
  : Infinity;

const BASE = "https://simpsonswiki.com/w/index.php";
const USER_AGENT = process.env.SCRAPER_USER_AGENT || "simpsons-chat-dataset-enrichment/1.0 (+https://simpsons.chat)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 2000);
}

class BlockedError extends Error {
  constructor(message, status, bodySnippet) {
    super(message);
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

async function safeBodySnippet(res) {
  try {
    const t = await res.text();
    return t.slice(0, 300).replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

// Wikisimpsons page titles use underscores for spaces; most punctuation is
// left as-is (MediaWiki accepts literal UTF-8 in the query string).
function toWikiTitle(datasetTitle) {
  return datasetTitle.replace(/\s*\(S\d+E\d+\)\s*$/, "").trim();
}

async function fetchRawWikitext(pageTitle) {
  const url = `${BASE}?title=${encodeURIComponent(pageTitle.replace(/ /g, "_"))}&action=raw`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

    if (res.ok) {
      const text = await res.text();
      // MediaWiki serves a plain "#REDIRECT [[Target]]" for redirected pages.
      if (/^\s*#REDIRECT/i.test(text)) return { redirect: text.match(/\[\[([^\]|]+)/)?.[1] || null };
      return text;
    }

    if (res.status === 404) return null; // page doesn't exist (e.g. ToH segments)

    const isBlocked = res.status === 429 || res.status === 403 || res.status === 503;
    if (!isBlocked || attempt >= MAX_RETRIES) {
      const bodySnippet = await safeBodySnippet(res);
      throw new BlockedError(`HTTP ${res.status} for ${url}`, res.status, bodySnippet);
    }

    const retryAfterHeader = res.headers.get("retry-after");
    let waitMs;
    if (retryAfterHeader && !isNaN(parseInt(retryAfterHeader, 10))) {
      waitMs = parseInt(retryAfterHeader, 10) * 1000;
    } else {
      waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
    }
    waitMs = jitter(waitMs);

    console.warn(
      `  [HTTP ${res.status}] ${pageTitle} — retry ${attempt + 1}/${MAX_RETRIES} in ${(waitMs / 1000).toFixed(0)}s` +
        (retryAfterHeader ? ` (server sent Retry-After: ${retryAfterHeader})` : "")
    );
    await sleep(waitMs);
  }
}

// ---------- Credits parsing ----------
// Wikitext format:
//   '''Label'''
//
//   [[Person Name]]
//
//   [[Person Name 2]]
//
//   '''Next Label'''
//   ...
// A piped link [[Target|Display]] uses Display as the credited name.
function parseCredits(wikitext, episodeId, producersOut) {
  // Split on bold labels, keeping the label text.
  const blocks = wikitext.split(/'''([^']+)'''/);
  // blocks alternates: [preamble, label1, body1, label2, body2, ...]
  for (let i = 1; i < blocks.length; i += 2) {
    const label = blocks[i].trim();
    const body = blocks[i + 1] || "";
    if (!/producer|produced by/i.test(label)) continue;

    const role = normalizeProducerRole(label);
    const linkPattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let m;
    while ((m = linkPattern.exec(body))) {
      const target = m[1].trim();
      const display = (m[2] || target).trim();
      // Skip obvious non-person wikilinks that occasionally show up in
      // these blocks (company/studio names in animation-producer credits
      // are legitimate to keep — we don't filter by heuristics here,
      // matching what the page actually credits).
      producersOut.push({ episode_id: episodeId, role, person: display });
    }
  }
}

// Normalize case/tense so "Produced By", "Produced by", "produced by" and
// "Co-Producers"/"Co-Producer" collapse to one consistent role string.
function normalizeProducerRole(label) {
  let r = label.trim().replace(/\s+/g, " ");
  r = r.replace(/\bBy\b/gi, "by"); // "Produced By" -> "Produced by"
  r = r.replace(/s$/i, (s) => s); // leave plurals as-is; handled below
  // Singularize common plural role labels so "Producers"/"Producer" merge.
  r = r.replace(/^(Co-Executive Producer|Executive Producer|Co-Producer|Supervising Producer|Consulting Producer|Associate Producer|Animation Producer|Animation Co-Producer|Animation Associate Producer|Producer)s$/i, "$1");
  // Title-case the first letter only; keep rest as given.
  return r.charAt(0).toUpperCase() + r.slice(1);
}

// ---------- Appearances parsing ----------
// Wikitext format (Characters section only — stop at the next =='...'==):
//   == Characters ==
//   <gallery>
//   File:X.png|[[Character Name]]{{Voiced}}
//   File:Y.png|{{ap|Display|Context}}{{Cameo}}
//   File:Z.png|{{Ch|Name}}{{Mentioned}}
//   File:W.png|[[Character Name]]
//   </gallery>
function parseAppearances(wikitext, episodeId, charactersOut) {
  const sectionMatch = wikitext.match(/==\s*Characters\s*==([\s\S]*?)(?:\n==\s*\w|\{\{Legend)/i);
  if (!sectionMatch) return;
  const section = sectionMatch[1];

  const linePattern = /^File:[^|]+\|(.+)$/gm;
  let m;
  while ((m = linePattern.exec(section))) {
    const rest = m[1];
    let character = null;

    let am;
    if ((am = rest.match(/\{\{ap\|([^|}]+)\|([^}]+)\}\}/i))) {
      character = `${am[1].trim()} (${am[2].trim()})`;
    } else if ((am = rest.match(/\{\{Ch\|([^}]+)\}\}/i))) {
      character = `${am[1].trim()} (character)`;
    } else if ((am = rest.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/))) {
      character = (am[2] || am[1]).trim();
    }
    if (!character) continue;

    let appearanceType = "";
    if (/\{\{Voiced\}\}/i.test(rest)) appearanceType = "voiced";
    else if (/\{\{Cameo\}\}/i.test(rest)) appearanceType = "cameo";
    else if (/\{\{Mentioned\}\}/i.test(rest)) appearanceType = "mentioned";
    else if (/\{\{Picture\}\}/i.test(rest)) appearanceType = "picture";

    charactersOut.push({ episode_id: episodeId, character, appearance_type: appearanceType });
  }
}

// ---------- Resume support ----------
function loadDoneIds(file) {
  const done = new Set();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      done.add(JSON.parse(line).episode_id);
    } catch {}
  }
  return done;
}

async function main() {
  const episodes = JSON.parse(fs.readFileSync(TITLES_FILE, "utf8"));
  const doneProducers = loadDoneIds(PRODUCERS_OUT);
  const doneCharacters = loadDoneIds(CHARACTERS_OUT);

  const producersStream = fs.createWriteStream(PRODUCERS_OUT, { flags: "a" });
  const charactersStream = fs.createWriteStream(CHARACTERS_OUT, { flags: "a" });
  const failuresStream = fs.createWriteStream(FAILURES_OUT, { flags: "a" });

  let processed = 0;
  let consecutiveBlocked = 0;
  let stoppedEarly = false;

  for (const ep of episodes) {
    const alreadyDone = doneProducers.has(ep.id) && doneCharacters.has(ep.id);
    if (alreadyDone) continue;

    if (processed >= MAX_EPISODES_PER_RUN) {
      console.log(`\nReached MAX_EPISODES_PER_RUN (${MAX_EPISODES_PER_RUN}). Stopping for this run.`);
      stoppedEarly = true;
      break;
    }

    const wikiTitle = toWikiTitle(ep.title);
    try {
      const creditsRaw = await fetchRawWikitext(`${wikiTitle}/Credits`);
      await sleep(DELAY_MS);
      const appearancesRaw = await fetchRawWikitext(`${wikiTitle}/Appearances`);
      await sleep(DELAY_MS);

      if (creditsRaw && typeof creditsRaw === "string") {
        const producers = [];
        parseCredits(creditsRaw, ep.id, producers);
        for (const row of producers) producersStream.write(JSON.stringify(row) + "\n");
      } else if (creditsRaw === null) {
        failuresStream.write(JSON.stringify({ episode_id: ep.id, page: "Credits", reason: "404" }) + "\n");
      }

      if (appearancesRaw && typeof appearancesRaw === "string") {
        const characters = [];
        parseAppearances(appearancesRaw, ep.id, characters);
        for (const row of characters) charactersStream.write(JSON.stringify(row) + "\n");
      } else if (appearancesRaw === null) {
        failuresStream.write(JSON.stringify({ episode_id: ep.id, page: "Appearances", reason: "404" }) + "\n");
      }

      consecutiveBlocked = 0; // any successful episode resets the breaker
      processed++;
      if (processed % 25 === 0) console.log(`Processed ${processed}/${episodes.length}...`);
    } catch (err) {
      const isBlocked = err instanceof BlockedError && (err.status === 429 || err.status === 403 || err.status === 503);

      console.error(`Failed on ${ep.id} (${wikiTitle}):`, err.message);
      failuresStream.write(
        JSON.stringify({
          episode_id: ep.id,
          page: "both",
          reason: err.message,
          status: err.status || null,
          body_snippet: err.bodySnippet || null,
        }) + "\n"
      );

      if (isBlocked) {
        consecutiveBlocked++;
        console.error(`  Consecutive blocked episodes: ${consecutiveBlocked}/${CIRCUIT_BREAKER_THRESHOLD}`);
        if (consecutiveBlocked >= CIRCUIT_BREAKER_THRESHOLD) {
          console.error(
            `\nStopping run: hit ${CIRCUIT_BREAKER_THRESHOLD} consecutive blocked responses after retries.`
          );
          console.error(`Wikisimpsons (or its CDN) appears to still be rate-limiting or blocking this connection.`);
          if (err.bodySnippet) console.error(`Last response body snippet: ${err.bodySnippet}`);
          console.error(
            `Processed ${processed} new episode(s) before stopping. This is not a failure of the whole run — ` +
              `already-scraped episodes (including this run's) are skipped automatically next time. ` +
              `Wait longer before re-running (try overnight, or a full 24h, rather than a few hours) — ` +
              `a short cooldown clearly hasn't been enough so far.`
          );
          stoppedEarly = true;
          break;
        }
      } else {
        consecutiveBlocked = 0; // non-blocking error (timeout, DNS, parse issue) shouldn't trip the breaker
      }
      await sleep(DELAY_MS);
    }
  }

  producersStream.end();
  charactersStream.end();
  failuresStream.end();
  console.log(`\nDone${stoppedEarly ? " (stopped early)" : ""}. Processed ${processed} new episodes this run.`);
  console.log(`Output: ${PRODUCERS_OUT}, ${CHARACTERS_OUT}`);
  console.log(`Check ${FAILURES_OUT} for any pages that 404'd or errored.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
