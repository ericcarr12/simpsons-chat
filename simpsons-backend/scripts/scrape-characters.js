/**
 * Crawls every page in Wikisimpsons' Category:Characters (~9,724 pages as of
 * writing) and pulls a clean intro-paragraph summary for each one that clears
 * a minimum word count (filters out one-scene stub characters).
 *
 * This does NOT touch your Worker or Anthropic key — it just talks to the
 * public simpsonswiki.com API and writes results to a local .jsonl file.
 * Feed that file into scripts/ingest.js afterwards to load it into D1/Vectorize.
 *
 * Usage:
 *   node scripts/scrape-characters.js
 *
 * Config (env vars, all optional):
 *   MIN_WORDS   minimum word count to keep an entry (default 25)
 *   DELAY_MS    delay between requests, be polite to the wiki (default 200)
 *   OUT_FILE    output path (default data/simpsons-characters-full.jsonl)
 *   CATEGORY    category to crawl (default "Category:Characters")
 *
 * This is a LONG-RUNNING script — ~9,700 pages at ~200-400ms each is roughly
 * 35-65 minutes. It's resumable: if interrupted, just run it again and it
 * will skip titles already written to OUT_FILE.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = "https://simpsonswiki.com/w/api.php";
const MIN_WORDS = parseInt(process.env.MIN_WORDS || "25", 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || "200", 10);
const CATEGORY = process.env.CATEGORY || "Category:Characters";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = process.env.OUT_FILE || path.join(__dirname, "../data/simpsons-characters-full.jsonl");

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
};

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (_, name) => (NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : `&${name};`));
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * attempt);
    }
  }
}

async function fetchAllCharacterTitles() {
  const titles = [];
  let cmcontinue = null;
  do {
    let url = `${API}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(CATEGORY)}&cmlimit=500&cmnamespace=0&format=json&origin=*`;
    if (cmcontinue) url += `&cmcontinue=${encodeURIComponent(cmcontinue)}`;
    const json = await fetchJson(url);
    const members = json?.query?.categorymembers || [];
    for (const m of members) titles.push(m.title);
    cmcontinue = json?.continue?.cmcontinue || null;
    process.stdout.write(`\rFetching character list... ${titles.length} so far`);
  } while (cmcontinue);
  process.stdout.write("\n");
  return titles;
}

function extractIntro(html) {
  const redirectMatch = html.match(/<div class="redirectMsg">[\s\S]*?<a href="\/wiki\/[^"]*" title="([^"]+)"/);
  if (redirectMatch) return { redirect: decodeEntities(redirectMatch[1]) };

  let text = html;
  const lastTableIdx = text.lastIndexOf("</table>");
  if (lastTableIdx !== -1) text = text.slice(lastTableIdx + "</table>".length);

  const cutMarkers = ['<div class="mw-references-wrap', "<!-- \nNewPP", "<!--\nTransclusion", '<div class="thumb'];
  let cutIdx = text.length;
  for (const m of cutMarkers) {
    const idx = text.indexOf(m);
    if (idx !== -1 && idx < cutIdx) cutIdx = idx;
  }
  text = text.slice(0, cutIdx);

  text = text.replace(/<sup[^>]*class="reference"[^>]*>[\s\S]*?<\/sup>/g, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  text = text.replace(/\s+/g, " ").trim();
  return { text };
}

async function fetchIntroHtml(title) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}&prop=text&section=0&format=json&origin=*`;
  const json = await fetchJson(url);
  return json?.parse?.text?.["*"] || "";
}

async function main() {
  console.log(`Crawling ${CATEGORY} on simpsonswiki.com`);
  console.log(`Min words: ${MIN_WORDS}, delay: ${DELAY_MS}ms, output: ${OUT_FILE}\n`);

  const titles = await fetchAllCharacterTitles();
  console.log(`Found ${titles.length} pages.\n`);

  const seen = new Set();
  if (fs.existsSync(OUT_FILE)) {
    const lines = fs.readFileSync(OUT_FILE, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        seen.add(JSON.parse(line).sourceTitle);
      } catch {
        // ignore malformed lines
      }
    }
    console.log(`Resuming: ${seen.size} pages already scraped, skipping those.\n`);
  }

  let kept = 0;
  let skippedShort = 0;
  let skippedEmpty = 0;
  let errors = 0;

  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    if (seen.has(title)) continue;

    try {
      let html = await fetchIntroHtml(title);
      let result = extractIntro(html);

      if (result.redirect) {
        await sleep(DELAY_MS);
        html = await fetchIntroHtml(result.redirect);
        result = extractIntro(html);
      }

      if (!result.text) {
        skippedEmpty++;
      } else {
        const wordCount = result.text.split(/\s+/).filter(Boolean).length;
        if (wordCount < MIN_WORDS) {
          skippedShort++;
        } else {
          const entry = {
            id: slugify(title),
            sourceTitle: title, // used for resume tracking; not sent to the Worker
            title,
            keys: [title.toLowerCase()],
            text: result.text,
            source: "Simpsons Wiki (Wikisimpsons)",
            url: "https://simpsonswiki.com/wiki/" + encodeURIComponent(title.replace(/ /g, "_")),
          };
          fs.appendFileSync(OUT_FILE, JSON.stringify(entry) + "\n");
          kept++;
        }
      }
    } catch (e) {
      errors++;
      console.error(`\nError on "${title}": ${e.message}`);
    }

    if (i % 50 === 0 || i === titles.length - 1) {
      process.stdout.write(
        `\r${i + 1}/${titles.length} | kept ${kept} | short ${skippedShort} | empty ${skippedEmpty} | errors ${errors}   `
      );
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n\nDone. Kept ${kept} entries in ${OUT_FILE}`);
  console.log(`Skipped: ${skippedShort} too short, ${skippedEmpty} empty/unresolved redirects, ${errors} errors.`);
  console.log(`\nNext: node scripts/ingest.js ${OUT_FILE}`);
}

main().catch((err) => {
  console.error("Scrape failed:", err);
  process.exit(1);
});
