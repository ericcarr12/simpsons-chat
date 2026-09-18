#!/usr/bin/env python3
"""
Simpsons dataset enrichment pipeline — full-series build via Anthropic's Message Batches API.

WHY THIS RUNS LOCALLY, NOT IN COWORK:
The Cowork sandbox blocks any outbound request to api.anthropic.com that carries an
x-api-key header (confirmed: a garbage key and a real key both get the same generic
block, while a keyless request gets Anthropic's real JSON error). So this script is
meant to run on your own machine, in your own terminal, with your own key.

SETUP:
    pip install requests
    export ANTHROPIC_API_KEY=sk-ant-...     (the dedicated ingestion key, not the chatbot's)

USAGE (run in this order — every step is safe to re-run / resume):
    python simpsons_enrichment_pipeline.py list-episodes
    python simpsons_enrichment_pipeline.py list-characters
    # -> spot check pipeline_state/episodes.json and pipeline_state/characters.json,
    #    hand-edit characters.json freely (it's just a flat JSON list of page titles)
    python simpsons_enrichment_pipeline.py fetch-wikitext
    python simpsons_enrichment_pipeline.py build-batches
    python simpsons_enrichment_pipeline.py submit
    python simpsons_enrichment_pipeline.py status        # re-run this every so often
    python simpsons_enrichment_pipeline.py collect        # once status shows "ended"
    python simpsons_enrichment_pipeline.py merge --into /path/to/simpsons-data.json

TREEHOUSE OF HORROR SEGMENT ENRICHMENT (adds per-segment/skit entries so users can
search any individual Halloween skit by name, and find each installment by either
its roman numeral or its plain number):
    python simpsons_enrichment_pipeline.py list-toh
    python simpsons_enrichment_pipeline.py fetch-toh
    python simpsons_enrichment_pipeline.py build-toh-batches
    python simpsons_enrichment_pipeline.py submit
    python simpsons_enrichment_pipeline.py status
    python simpsons_enrichment_pipeline.py collect
    python simpsons_enrichment_pipeline.py merge --into /path/to/simpsons-data.json
    python simpsons_enrichment_pipeline.py patch-toh-parents --into /path/to/simpsons-data.json
    # then: node scripts/ingest.js /path/to/simpsons-data.json

All state lives in ./pipeline_state/ next to this script. Nothing here talks to the
Cowork sandbox at all — it's a standalone script.

COPYRIGHT NOTE: plot summaries must be an ORIGINAL paraphrase (not lifted wikitext).
Quotes are the exception — they're pulled verbatim on purpose, so a user searching
for a remembered line/gag actually finds it — but are capped at a handful of short,
single lines per episode/character (never whole scenes or exchanges), matching how
Wikisimpsons' own /Quotes pages and most fan quote sites handle brief quotation.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime

import requests

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline_state")
WIKI_API = "https://simpsonswiki.com/w/api.php"
ANTHROPIC_API = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"

MODEL = "claude-sonnet-5"     # swap to a cheaper/faster model if you want to trade quality for cost
MAX_SEASON = 37               # bump this if new seasons have aired since this was written
BATCH_CHUNK = 400             # requests per batch file — well under the API's 100k/256MB batch limit
REQUEST_DELAY = 0.5           # politeness delay between Wikisimpsons API calls

HEADERS_WIKI = {"User-Agent": "SimpsonsDatasetBot/1.0 (personal fan project; contact via GitHub)"}

CORE_CHARACTERS = [
    "Homer Simpson", "Marge Simpson", "Bart Simpson", "Lisa Simpson", "Maggie Simpson",
    "Abraham Simpson", "Moe Szyslak", "Ned Flanders", "Charles Montgomery Burns",
    "Waylon Smithers", "Seymour Skinner", "Krusty the Clown", "Milhouse Van Houten",
    "Nelson Muntz", "Clancy Wiggum", "Apu Nahasapeemapetilon", "Patty Bouvier",
    "Selma Bouvier", "Comic Book Guy", "Barney Gumble", "Lenny Leonard", "Carl Carlson",
    "Timothy Lovejoy", "Julius Hibbert", "Kent Brockman", "Sideshow Bob",
    "Groundskeeper Willie", "Otto Mann", "Edna Krabappel", "Gary Chalmers",
    "Fat Tony", "Duffman", "Disco Stu", "Cletus Spuckler", "Ralph Wiggum",
    "Martin Prince", "Rod Flanders", "Todd Flanders", "Maude Flanders",
    "Agnes Skinner", "Snake Jailbird", "John Frink", "Lionel Hutz",
    "Troy McClure", "Sideshow Mel", "Jimbo Jones", "Dolph Starbeam", "Kearney Zzyzwicz",
]

# Every Treehouse of Horror anthology episode, hand-verified against the live D1 dataset
# (ids match exactly what's already in production, so the merge step replaces the parent
# episode entry in place rather than duplicating it). roman/arabic are None for the one
# self-contained spin-off that isn't part of the numbered series.
# Fields: (existing_id, bare_title, season, episode_in_season, roman_numeral, arabic_number)
TOH_EPISODES = [
    ("s2e03-treehouse-of-horror", "Treehouse of Horror", 2, 3, "I", 1),
    ("s3e07-treehouse-of-horror-ii", "Treehouse of Horror II", 3, 7, "II", 2),
    ("s4e05-treehouse-of-horror-iii", "Treehouse of Horror III", 4, 5, "III", 3),
    ("s5e05-treehouse-of-horror-iv", "Treehouse of Horror IV", 5, 5, "IV", 4),
    ("s6e06-treehouse-of-horror-v", "Treehouse of Horror V", 6, 6, "V", 5),
    ("s7e06-treehouse-of-horror-vi", "Treehouse of Horror VI", 7, 6, "VI", 6),
    ("s8e01-treehouse-of-horror-vii", "Treehouse of Horror VII", 8, 1, "VII", 7),
    ("s9e04-treehouse-of-horror-viii", "Treehouse of Horror VIII", 9, 4, "VIII", 8),
    ("s10e04-treehouse-of-horror-ix", "Treehouse of Horror IX", 10, 4, "IX", 9),
    ("s11e04-treehouse-of-horror-x", "Treehouse of Horror X", 11, 4, "X", 10),
    ("s12e01-treehouse-of-horror-xi", "Treehouse of Horror XI", 12, 1, "XI", 11),
    ("s13e01-treehouse-of-horror-xii", "Treehouse of Horror XII", 13, 1, "XII", 12),
    ("s14e01-treehouse-of-horror-xiii", "Treehouse of Horror XIII", 14, 1, "XIII", 13),
    ("s15e01-treehouse-of-horror-xiv", "Treehouse of Horror XIV", 15, 1, "XIV", 14),
    ("s16e01-treehouse-of-horror-xv", "Treehouse of Horror XV", 16, 1, "XV", 15),
    ("s17e04-treehouse-of-horror-xvi", "Treehouse of Horror XVI", 17, 4, "XVI", 16),
    ("s18e04-treehouse-of-horror-xvii", "Treehouse of Horror XVII", 18, 4, "XVII", 17),
    ("s19e05-treehouse-of-horror-xviii", "Treehouse of Horror XVIII", 19, 5, "XVIII", 18),
    ("s20e04-treehouse-of-horror-xix", "Treehouse of Horror XIX", 20, 4, "XIX", 19),
    ("s21e04-treehouse-of-horror-xx", "Treehouse of Horror XX", 21, 4, "XX", 20),
    ("s22e04-treehouse-of-horror-xxi", "Treehouse of Horror XXI", 22, 4, "XXI", 21),
    ("s23e03-treehouse-of-horror-xxii", "Treehouse of Horror XXII", 23, 3, "XXII", 22),
    ("s24e02-treehouse-of-horror-xxiii", "Treehouse of Horror XXIII", 24, 2, "XXIII", 23),
    ("s25e02-treehouse-of-horror-xxiv", "Treehouse of Horror XXIV", 25, 2, "XXIV", 24),
    ("s26e04-treehouse-of-horror-xxv", "Treehouse of Horror XXV", 26, 4, "XXV", 25),
    ("s27e05-treehouse-of-horror-xxvi", "Treehouse of Horror XXVI", 27, 5, "XXVI", 26),
    ("s28e04-treehouse-of-horror-xxvii", "Treehouse of Horror XXVII", 28, 4, "XXVII", 27),
    ("s29e04-treehouse-of-horror-xxviii", "Treehouse of Horror XXVIII", 29, 4, "XXVIII", 28),
    ("s30e04-treehouse-of-horror-xxix", "Treehouse of Horror XXIX", 30, 4, "XXIX", 29),
    ("s31e04-treehouse-of-horror-xxx", "Treehouse of Horror XXX", 31, 4, "XXX", 30),
    ("s32e04-treehouse-of-horror-xxxi", "Treehouse of Horror XXXI", 32, 4, "XXXI", 31),
    ("s33e03-treehouse-of-horror-xxxii", "Treehouse of Horror XXXII", 33, 3, "XXXII", 32),
    ("s34e06-treehouse-of-horror-xxxiii", "Treehouse of Horror XXXIII", 34, 6, "XXXIII", 33),
    ("s35e05-treehouse-of-horror-xxxiv", "Treehouse of Horror XXXIV", 35, 5, "XXXIV", 34),
    ("s36e05-treehouse-of-horror-xxxv", "Treehouse of Horror XXXV", 36, 5, "XXXV", 35),
    ("s36e07-treehouse-of-horror-presents-simpsons-wicked-this-way-comes",
     "Treehouse of Horror Presents: Simpsons Wicked This Way Comes", 36, 7, None, None),
    ("s37e03-treehouse-of-horror-xxxvi", "Treehouse of Horror XXXVI", 37, 3, "XXXVI", 36),
]

EPISODE_PROMPT = """You are helping build a fan-reference dataset about The Simpsons.
Below is the raw wikitext for one episode's main article, plus (if present) its
separate Quotes subpage.

Using ONLY the facts present in this wikitext, return a single JSON object shaped
exactly like this (no markdown fences, no commentary, just the JSON).

CRITICAL — your output must be STRICTLY VALID JSON:
- Any double-quote character (") that appears inside a string value (e.g. inside
  a quoted line of dialogue, or a nickname) MUST be escaped as \\" .
  Example: "Homer: I hate my \\"friend\\" Ned" — never a bare unescaped ".
- Never put a literal line break inside a string value. If a quote spans
  multiple lines in the source, join it onto one line in your output.
- Prefer rewording a quote very slightly (e.g. dropping a redundant inner
  quotation) over producing invalid JSON — getting valid JSON out is more
  important than 100% character-for-character fidelity on rare edge cases.

{{
  "director": "string or empty",
  "writer": "string or empty",
  "prodcode": "string or empty",
  "airdate": "string or empty, as written in the infobox",
  "episode_number_in_season": integer or null (the episode's number WITHIN its season,
      read from the infobox if the template states it; null if you cannot find it),
  "summary": "A DETAILED, ORIGINAL plot summary in your own words, 6-10 sentences,
      covering setup, main conflict/subplots, and resolution. Rewrite from scratch —
      do not copy or lightly edit phrasing from the wikitext.",
  "guests": "comma-separated guest stars if any, else empty string",
  "quotes": ["up to 5 lines, EXACT WORDING copied verbatim from the wikitext
      (do not paraphrase or rewrite — searchability depends on matching the
      real line), each formatted as 'Character: line'. Keep to single lines
      only, not whole exchanges — pick the most iconic/funny individual
      lines, each under ~25 words. Empty list if nothing stands out."]
}}

Episode: {title}

--- Main article wikitext ---
{main}

--- Quotes page wikitext (may be empty) ---
{quotes}
"""

CHARACTER_PROMPT = """You are helping build a fan-reference dataset about The Simpsons.
Below is the raw wikitext for one character's article.

Using ONLY the facts present in this wikitext, return a single JSON object shaped
exactly like this (no markdown fences, no commentary, just the JSON).

CRITICAL — your output must be STRICTLY VALID JSON:
- Any double-quote character (") that appears inside a string value MUST be
  escaped as \\" — never a bare unescaped ".
- Never put a literal line break inside a string value.
- Prefer rewording a quote very slightly over producing invalid JSON — valid
  JSON matters more than 100% character-for-character fidelity on edge cases.

{{
  "role": "one-line description of who they are / their relation to the main cast",
  "voice_actor": "credited voice actor if stated, else empty string",
  "summary": "An ORIGINAL description in your own words, 4-8 sentences, covering
      personality, running gags/traits, and their notable role in the show.
      Rewrite from scratch — do not copy or lightly edit wikitext phrasing.",
  "quotes": ["up to 3 iconic lines, EXACT WORDING copied verbatim from the
      wikitext (do not paraphrase or rewrite), each under ~25 words with
      attribution, only if the wikitext actually contains specific lines;
      else empty list"]
}}

Character: {title}

--- Article wikitext ---
{main}
"""

TOH_SEGMENT_PROMPT = """You are helping build a fan-reference dataset about The Simpsons'
"Treehouse of Horror" Halloween anthology episodes. Below is the raw wikitext for ONE
segment/skit within a larger anthology episode, plus (if present) the full episode's
Quotes subpage (which covers ALL segments, not just this one).

Using ONLY the facts present in this wikitext, return a single JSON object shaped
exactly like this (no markdown fences, no commentary, just the JSON).

CRITICAL — your output must be STRICTLY VALID JSON:
- Any double-quote character (") inside a string value MUST be escaped as \\" .
- Never put a literal line break inside a string value.
- Prefer rewording a quote very slightly over producing invalid JSON.

{{
  "summary": "A DETAILED, ORIGINAL plot summary of THIS SEGMENT ONLY, in your own words,
      5-9 sentences, covering the setup, the parody/premise being spoofed (if any), the
      main events, and how it ends. Rewrite from scratch — do not copy or lightly edit
      phrasing from the wikitext.",
  "quotes": ["up to 4 lines, EXACT WORDING copied verbatim, ONLY if you can tell from
      the segment wikitext or the character names/context that the line clearly belongs
      to THIS segment (not a different segment in the same episode). Each formatted as
      'Character: line', under ~25 words. Empty list if you're not confident a quote
      belongs to this specific segment."]
}}

Segment title: {segment_title}
Parent episode: {episode_title}

--- Segment wikitext (from the episode's Plot section) ---
{segment_text}

--- Full episode Quotes subpage (covers all segments — use with caution) ---
{quotes}
"""


# ---------------------------------------------------------------- utilities

def api_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("Set ANTHROPIC_API_KEY in your environment first.")
    return key


def anthropic_headers():
    return {
        "x-api-key": api_key(),
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }


def state_path(*parts):
    p = os.path.join(STATE_DIR, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def slugify(text):
    # Match the id scheme already used in simpsons-data.json for Seasons 1-15:
    # apostrophes are dropped outright (Weren't -> Werent), everything else
    # non-alphanumeric collapses to a single hyphen. Getting this wrong means
    # the merge step creates duplicates instead of replacing existing entries.
    text = text.replace("'", "").replace("’", "")
    s = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return re.sub(r"-{2,}", "-", s)


def wiki_url(title):
    return "https://simpsonswiki.com/wiki/" + urllib.parse.quote(title.replace(" ", "_"))


# ---------------------------------------------------------------- wiki fetch

def wiki_get(params):
    params = {**params, "format": "json"}
    max_attempts = 6
    for attempt in range(max_attempts):
        try:
            r = requests.get(WIKI_API, params=params, headers=HEADERS_WIKI, timeout=30)
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 0)) or (10 * (attempt + 1))
                print(f"  Rate limited (429) — waiting {wait}s before retrying...")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        except requests.exceptions.RequestException:
            if attempt == max_attempts - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Gave up after {max_attempts} attempts (repeated rate limiting): {params}")


def category_members(title):
    members = []
    cmcontinue = None
    while True:
        params = {"action": "query", "list": "categorymembers", "cmtitle": title, "cmlimit": "500"}
        if cmcontinue:
            params["cmcontinue"] = cmcontinue
        data = wiki_get(params)
        members.extend(data.get("query", {}).get("categorymembers", []))
        cont = data.get("continue", {}).get("cmcontinue")
        if not cont:
            break
        cmcontinue = cont
        time.sleep(REQUEST_DELAY)
    return members


def page_lengths(titles):
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        data = wiki_get({"action": "query", "prop": "info", "titles": "|".join(chunk)})
        for page in data.get("query", {}).get("pages", {}).values():
            if "title" in page:
                out[page["title"]] = page.get("length", 0)
        time.sleep(REQUEST_DELAY)
    return out


def fetch_wikitext(title):
    data = wiki_get({"action": "parse", "page": title, "prop": "wikitext"})
    if "error" in data:
        return None
    return data.get("parse", {}).get("wikitext", {}).get("*", "")


# ---------------------------------------------------------------- ToH segment parsing

def extract_segments(wikitext):
    """Pull (segment_title, segment_wikitext) pairs out of a ToH episode's ==Plot==
    section, split on its ===Level-3=== subheadings (Wikisimpsons' consistent
    convention: Opening sequence / each segment / Closing sequence). Returns []
    if no ==Plot== section or no level-3 subheadings are found."""
    if not wikitext:
        return []
    plot_match = re.search(r"==\s*Plot\s*==(.*?)(?=\n==[^=]|\Z)", wikitext, re.S)
    if not plot_match:
        return []
    plot_block = plot_match.group(1)
    headers = list(re.finditer(r"===\s*([^=\n]+?)\s*===", plot_block))
    if not headers:
        return []
    segments = []
    for i, h in enumerate(headers):
        start = h.end()
        end = headers[i + 1].start() if i + 1 < len(headers) else len(plot_block)
        raw_title = h.group(1).strip()
        body = plot_block[start:end].strip()

        # Clean up two known Wikisimpsons header quirks:
        # 1. The earliest ToH episodes number segments as acts with a quoted
        #    title, e.g. `Act I: "Bad Dream House"` -> "Bad Dream House".
        # 2. A few episodes give their opening/closing sequence its own
        #    parody name, e.g. `Opening Sequence: The Sweets Hereafter` ->
        #    "The Sweets Hereafter" (still a real segment, just drop the label).
        title = re.sub(r'^Act\s+[IVXLCDM]+:\s*', '', raw_title, flags=re.I)
        title = re.sub(r'^(?:Opening|Closing)\s+Sequence:\s*', '', title, flags=re.I)
        title = title.strip('"“”').strip()

        # A BARE "Opening sequence" / "Closing sequence" (no specific name after
        # a colon) is wraparound narration, not an actual skit -- exclude it so
        # it doesn't get counted or searchable as if it were a real segment.
        if title.lower() in ("opening sequence", "closing sequence"):
            continue
        if len(body) < 80:
            continue
        segments.append((title, body))
    return segments


# ---------------------------------------------------------------- list-toh / fetch-toh

def cmd_list_toh(args):
    listing = [
        {"id": eid, "title": title, "season": season, "episode_in_season": ep_num,
         "roman": roman, "arabic": arabic}
        for eid, title, season, ep_num, roman, arabic in TOH_EPISODES
    ]
    save_json(state_path("toh_episodes.json"), listing)
    print(f"{len(listing)} Treehouse of Horror episodes listed (hand-verified against "
          f"the live dataset). Saved to pipeline_state/toh_episodes.json.")


def cmd_fetch_toh(args):
    cache = load_json(state_path("toh_wikitext_cache.json"), {})
    for i, (eid, title, season, ep_num, roman, arabic) in enumerate(TOH_EPISODES, 1):
        if title in cache and cache[title].get("main"):
            continue
        try:
            main = fetch_wikitext(title)
            time.sleep(REQUEST_DELAY)
            quotes = fetch_wikitext(f"{title}/Quotes")
            time.sleep(REQUEST_DELAY)
            cache[title] = {"main": main, "quotes": quotes}
        except Exception as e:
            print(f"  Skipping '{title}' after repeated failures ({e}). Re-run to retry.")
            cache.setdefault(title, {"main": None})
        print(f"  {i}/{len(TOH_EPISODES)}: {title}")
        save_json(state_path("toh_wikitext_cache.json"), cache)

    total_segments = 0
    for eid, title, season, ep_num, roman, arabic in TOH_EPISODES:
        segs = extract_segments(cache.get(title, {}).get("main"))
        total_segments += len(segs)
        print(f"  {title}: {len(segs)} segment(s) — {', '.join(s[0] for s in segs) or '(none found)'}")
    print(f"\nDone. {total_segments} total segments detected across {len(TOH_EPISODES)} episodes.")


# ---------------------------------------------------------------- list-episodes

def cmd_list_episodes(args):
    episodes = []
    for season in range(1, args.max_season + 1):
        cat = f"Category:Season {season}"
        members = category_members(cat)
        titles = [
            m["title"] for m in members
            if m["ns"] == 0 and "/" not in m["title"] and m["title"] != f"Season {season}"
        ]
        for t in titles:
            episodes.append({"season": season, "title": t})
        print(f"Season {season}: {len(titles)} episodes")
        time.sleep(REQUEST_DELAY)
    save_json(state_path("episodes.json"), episodes)
    print(f"\nTotal episodes found: {len(episodes)}")
    print("Saved to pipeline_state/episodes.json — spot check before continuing.")


# ---------------------------------------------------------------- list-characters

def cmd_list_characters(args):
    members = category_members("Category:Recurring characters")
    titles = [m["title"] for m in members if m["ns"] == 0 and "/" not in m["title"]]
    print(f"'Recurring characters' category has {len(titles)} pages.")

    if args.all:
        # Full sweep: every page in Category:Recurring characters, no cap. This is
        # the "~2,800 recurring characters" scope, as opposed to the old top-N by
        # article-depth mode (kept below for anyone re-running with --target).
        chosen = list(CORE_CHARACTERS)
        for t in titles:
            if t not in chosen:
                chosen.append(t)
        print(f"--all set: taking every recurring character (plus guaranteed core cast).")
    else:
        print(f"Ranking by article depth to find the ~{args.target} that matter most...")
        lengths = page_lengths(titles)
        ranked = sorted(titles, key=lambda t: lengths.get(t, 0), reverse=True)

        chosen = list(CORE_CHARACTERS)
        for t in ranked:
            if len(chosen) >= args.target:
                break
            if t not in chosen:
                chosen.append(t)

    save_json(state_path("characters.json"), chosen)
    print(f"Selected {len(chosen)} characters.")
    print("Saved to pipeline_state/characters.json — this is a plain JSON list of page "
          "titles, edit it directly to add/remove names before continuing.")


# ---------------------------------------------------------------- fetch-wikitext

def cmd_fetch_wikitext(args):
    episodes = load_json(state_path("episodes.json"), [])
    characters = load_json(state_path("characters.json"), [])
    if not episodes and not characters:
        sys.exit("Run list-episodes and/or list-characters first.")

    cache = load_json(state_path("wikitext_cache.json"), {})

    def fetch_and_cache(title, extra_pages=None):
        if title in cache and cache[title].get("main"):
            return
        entry = {"main": fetch_wikitext(title)}
        for label, page_title in (extra_pages or {}).items():
            time.sleep(REQUEST_DELAY)
            entry[label] = fetch_wikitext(page_title)
        cache[title] = entry
        time.sleep(REQUEST_DELAY)

    todo = [(e["title"], {"quotes": f'{e["title"]}/Quotes'}) for e in episodes]
    todo += [(name, None) for name in characters]

    for i, (title, extra) in enumerate(todo, 1):
        try:
            fetch_and_cache(title, extra)
        except Exception as e:
            print(f"  Skipping '{title}' after repeated failures ({e}). Re-run this "
                  f"command later to retry just this one.")
            cache.setdefault(title, {"main": None})
        if i % 25 == 0 or i == len(todo):
            save_json(state_path("wikitext_cache.json"), cache)
            print(f"  {i}/{len(todo)} pages fetched...")

    missing = [t for t, v in cache.items() if not v.get("main")]
    print(f"\nDone. {len(cache)} pages cached, {len(missing)} failed to fetch.")
    if missing:
        print("Failed (re-run this command to retry just these):")
        for t in missing[:30]:
            print(" -", t)


# ---------------------------------------------------------------- build-batches

def truncate(text, limit=12000):
    return (text or "")[:limit]


def cmd_build_batches(args):
    cache = load_json(state_path("wikitext_cache.json"), {})
    episodes = load_json(state_path("episodes.json"), [])
    ep_by_title = {e["title"]: e for e in episodes}
    collected = set(load_json(state_path("collected_ids.json"), []))

    requests_list = []
    id_to_title = load_json(state_path("id_map.json"), {})
    seen_ids = set(id_to_title.keys())

    for title, pages in cache.items():
        if not pages.get("main"):
            continue
        is_ep = title in ep_by_title

        prefix = "ep" if is_ep else "char"
        base_id = f"{prefix}-{slugify(title)}"[:55]
        cid = base_id
        n = 1
        while cid in seen_ids:
            # same title already assigned an id in a previous run — reuse it
            if id_to_title.get(cid, {}).get("title") == title:
                break
            n += 1
            cid = f"{base_id}-{n}"
        seen_ids.add(cid)

        if cid in collected:
            continue  # already successfully collected in an earlier pass

        id_to_title[cid] = {"title": title, "kind": prefix, "season": ep_by_title.get(title, {}).get("season")}

        if is_ep:
            prompt = EPISODE_PROMPT.format(
                title=title, main=truncate(pages["main"]), quotes=truncate(pages.get("quotes"), 4000)
            )
        else:
            prompt = CHARACTER_PROMPT.format(title=title, main=truncate(pages["main"]))

        requests_list.append({
            "custom_id": cid,
            "params": {
                "model": MODEL,
                "max_tokens": 1200,
                "messages": [{"role": "user", "content": prompt}],
            },
        })

    save_json(state_path("id_map.json"), id_to_title)

    batches_dir = state_path("batches", "_")  # ensure dir exists
    batches_dir = os.path.dirname(batches_dir)
    existing = len([f for f in os.listdir(batches_dir) if f.startswith("batch_")])

    chunks = [requests_list[i:i + BATCH_CHUNK] for i in range(0, len(requests_list), BATCH_CHUNK)]
    for i, chunk in enumerate(chunks, start=existing):
        save_json(os.path.join(batches_dir, f"batch_{i:03d}.json"), chunk)

    print(f"Built {len(requests_list)} new requests across {len(chunks)} batch file(s) "
          f"in pipeline_state/batches/ ({BATCH_CHUNK} requests each).")
    if not requests_list:
        print("Nothing new to build — everything cached is either already batched or already collected.")


# ---------------------------------------------------------------- build-toh-batches

def cmd_build_toh_batches(args):
    cache = load_json(state_path("toh_wikitext_cache.json"), {})
    collected = set(load_json(state_path("collected_ids.json"), []))
    id_to_title = load_json(state_path("id_map.json"), {})
    seen_ids = set(id_to_title.keys())

    requests_list = []
    total_segments = 0
    for eid, ep_title, season, ep_num, roman, arabic in TOH_EPISODES:
        pages = cache.get(ep_title, {})
        if not pages.get("main"):
            print(f"  Skipping '{ep_title}' — no cached wikitext (run fetch-toh first).")
            continue
        segments = extract_segments(pages["main"])
        total_segments += len(segments)
        quotes_text = truncate(pages.get("quotes"), 6000)

        for seg_title, seg_body in segments:
            # Anthropic caps custom_id at 64 characters. Some ToH episode ids are
            # already long on their own (e.g. the "Simpsons Wicked This Way Comes"
            # one), so a readable id + segment slug can blow past that -- use a
            # short stable hash instead. The real title/parent/etc. all live in
            # id_map.json keyed by this cid, so the cid itself doesn't need to be
            # human-readable.
            seg_hash = hashlib.sha256(f"{eid}::{seg_title}".encode()).hexdigest()[:20]
            cid = f"tohseg-{seg_hash}"
            if cid in collected:
                continue

            id_to_title[cid] = {
                "title": seg_title, "kind": "tohseg",
                "parent_id": eid, "parent_title": ep_title,
                "season": season, "episode_in_season": ep_num,
                "roman": roman, "arabic": arabic,
            }
            seen_ids.add(cid)

            prompt = TOH_SEGMENT_PROMPT.format(
                segment_title=seg_title, episode_title=ep_title,
                segment_text=truncate(seg_body, 8000), quotes=quotes_text,
            )
            requests_list.append({
                "custom_id": cid,
                "params": {
                    "model": MODEL,
                    "max_tokens": 1000,
                    "messages": [{"role": "user", "content": prompt}],
                },
            })

    save_json(state_path("id_map.json"), id_to_title)

    batches_dir = state_path("batches", "_")
    batches_dir = os.path.dirname(batches_dir)
    existing = len([f for f in os.listdir(batches_dir) if f.startswith("batch_")])

    chunks = [requests_list[i:i + BATCH_CHUNK] for i in range(0, len(requests_list), BATCH_CHUNK)]
    for i, chunk in enumerate(chunks, start=existing):
        save_json(os.path.join(batches_dir, f"batch_{i:03d}.json"), chunk)

    print(f"\nFound {total_segments} segments across {len(TOH_EPISODES)} episodes.")
    print(f"Built {len(requests_list)} new segment requests across {len(chunks)} batch file(s) "
          f"in pipeline_state/batches/. Run submit/status/collect as usual.")


# ---------------------------------------------------------------- submit

def cmd_submit(args):
    headers = anthropic_headers()
    submitted = load_json(state_path("submitted_batches.json"), {})
    batches_dir = state_path("batches", "_")
    batches_dir = os.path.dirname(batches_dir)
    files = sorted(f for f in os.listdir(batches_dir) if f.startswith("batch_") and f.endswith(".json"))

    for fname in files:
        if fname in submitted:
            continue
        chunk = load_json(os.path.join(batches_dir, fname), [])
        if not chunk:
            continue
        resp = requests.post(
            f"{ANTHROPIC_API}/messages/batches",
            headers=headers,
            json={"requests": chunk},
            timeout=60,
        )
        if resp.status_code >= 400:
            print(f"FAILED to submit {fname}: {resp.status_code} {resp.text[:300]}")
            continue
        data = resp.json()
        submitted[fname] = {
            "batch_id": data["id"],
            "processing_status": data.get("processing_status", "in_progress"),
            "collected": False,
        }
        print(f"Submitted {fname} -> batch {data['id']} ({len(chunk)} requests)")
        save_json(state_path("submitted_batches.json"), submitted)
        time.sleep(1)

    if not files:
        print("No batch files found. Run build-batches first.")


# ---------------------------------------------------------------- status

def cmd_status(args):
    headers = anthropic_headers()
    submitted = load_json(state_path("submitted_batches.json"), {})
    if not submitted:
        print("No batches submitted yet.")
        return
    for fname, info in submitted.items():
        resp = requests.get(f"{ANTHROPIC_API}/messages/batches/{info['batch_id']}", headers=headers, timeout=30)
        if resp.status_code >= 400:
            print(f"{fname}: error checking status ({resp.status_code})")
            continue
        data = resp.json()
        info["processing_status"] = data.get("processing_status")
        info["results_url"] = data.get("results_url")
        counts = data.get("request_counts", {})
        print(f"{fname} [{info['batch_id']}]: {info['processing_status']}  "
              f"(succeeded={counts.get('succeeded', 0)} errored={counts.get('errored', 0)} "
              f"processing={counts.get('processing', 0)})")
    save_json(state_path("submitted_batches.json"), submitted)


# ---------------------------------------------------------------- collect

def strip_code_fence(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return text.strip()


def parse_date_guess(s):
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(s.strip(), fmt)
        except Exception:
            continue
    return None


def repair_stray_quotes(text):
    """Best-effort fix for the model leaving an internal double-quote inside a
    string value unescaped (e.g. a quoted line of dialogue within a quote).
    Walks the text tracking whether we're inside a JSON string; a quote is only
    treated as a real string terminator if what follows it (ignoring
    whitespace) looks like JSON structure (:,}]) or end of input — any other
    quote gets escaped instead of closing the string early."""
    out = []
    in_string = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\\" and in_string and i + 1 < n:
            out.append(ch)
            out.append(text[i + 1])
            i += 2
            continue
        if ch == '"':
            if not in_string:
                in_string = True
                out.append(ch)
            else:
                j = i + 1
                while j < n and text[j] in " \t\r\n":
                    j += 1
                next_ch = text[j] if j < n else ""
                if next_ch in (":", ",", "}", "]", "") :
                    in_string = False
                    out.append(ch)
                else:
                    out.append('\\"')
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def robust_json_parse(text):
    """Try increasingly forgiving strategies to parse a model's JSON output.
    Raises the original strict-mode error if nothing works, so the caller's
    error message still points at the real problem."""
    last_error = None
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        last_error = e
    try:
        return json.loads(text, strict=False)  # tolerate literal control chars (raw newlines) in strings
    except json.JSONDecodeError:
        pass
    try:
        return json.loads(repair_stray_quotes(text), strict=False)
    except json.JSONDecodeError:
        pass
    raise last_error


def build_episode_entry(title, season, parsed):
    ep_num = parsed.get("episode_number_in_season")
    summary = parsed.get("summary", "").strip()
    director = parsed.get("director", "") or "unknown director"
    writer = parsed.get("writer", "") or "unknown writer"
    prodcode = parsed.get("prodcode", "")
    airdate = parsed.get("airdate", "")
    guests = parsed.get("guests", "")
    quotes = [q for q in parsed.get("quotes", []) if q][:5]

    ep_label = f"e{ep_num:02d}" if isinstance(ep_num, int) else "e00"
    entry_id = f"s{season}{ep_label}-{slugify(title)}"
    title_field = f"{title} (S{season}{ep_label.upper()})" if isinstance(ep_num, int) else f"{title} (S{season})"

    text = (f'"{title}" is an episode of Season {season}'
            + (f" (production code {prodcode})" if prodcode else "")
            + f", directed by {director} and written by {writer}"
            + (f", originally airing {airdate}" if airdate else "")
            + f". {summary}")
    if guests:
        text += f" Guest starring {guests}."
    if quotes:
        text += " Notable quotes: " + " | ".join(quotes)

    keys = [title.lower(), f"season {season}"]
    if isinstance(ep_num, int):
        keys.append(f"season {season} episode {ep_num}")
        keys.append(f"s{season}e{ep_num:02d}")

    return {
        "id": entry_id,
        "title": title_field,
        "keys": keys,
        "text": text,
        "quotes": quotes,
        "source": "Simpsons Wiki (Wikisimpsons)",
        "url": wiki_url(title),
    }, ep_num is None


def build_character_entry(title, parsed):
    role = parsed.get("role", "").strip()
    voice_actor = parsed.get("voice_actor", "")
    summary = parsed.get("summary", "").strip()
    quotes = [q for q in parsed.get("quotes", []) if q][:3]

    text = f"{title} is {role}." if role else f"{title}."
    text += f" {summary}"
    if voice_actor:
        text += f" Voiced by {voice_actor}."
    if quotes:
        text += " Notable quotes: " + " | ".join(quotes)

    return {
        "id": slugify(title),
        "title": title,
        "keys": [title.lower()],
        "text": text,
        "quotes": quotes,
        "source": "Simpsons Wiki (Wikisimpsons)",
        "url": wiki_url(title),
    }


def build_toh_segment_entry(cid, meta, parsed):
    seg_title = meta["title"]
    parent_id = meta["parent_id"]
    parent_title = meta["parent_title"]
    season, ep_num = meta.get("season"), meta.get("episode_in_season")
    roman, arabic = meta.get("roman"), meta.get("arabic")
    summary = parsed.get("summary", "").strip()
    quotes = [q for q in parsed.get("quotes", []) if q][:4]

    # Mention BOTH the roman-numeral title and the plain arabic number so a user
    # searching "Treehouse of Horror 13" and one searching "Treehouse of Horror XIII"
    # both land close to this entry in embedding space (see the dilution lesson
    # learned earlier this project: broad/vague phrasing hurts specific retrieval).
    numeral_clause = ""
    if roman and arabic:
        numeral_clause = f' (also called "Treehouse of Horror {arabic}")'

    ep_label = f"Season {season}, Episode {ep_num}" if season and ep_num else f"Season {season}"
    text = (f'"{seg_title}" is a segment from "{parent_title}"{numeral_clause}, '
            f'which aired as {ep_label} of The Simpsons. {summary}')
    if quotes:
        text += " Notable quotes: " + " | ".join(quotes)

    keys = [seg_title.lower(), parent_title.lower()]
    if roman:
        keys.append(f"treehouse of horror {roman.lower()}")
    if arabic:
        keys.append(f"treehouse of horror {arabic}")
    keys = list(dict.fromkeys(keys))  # dedupe while preserving order

    entry_id = f"{parent_id}-segment-{slugify(seg_title)}"[:90]
    return {
        "id": entry_id,
        "title": f"{seg_title} ({parent_title} segment)",
        "keys": keys,
        "text": text,
        "quotes": quotes,
        "source": "Simpsons Wiki (Wikisimpsons)",
        "url": wiki_url(parent_title),
    }


def cmd_collect(args):
    headers = anthropic_headers()
    submitted = load_json(state_path("submitted_batches.json"), {})
    id_map = load_json(state_path("id_map.json"), {})
    collected_ids = set(load_json(state_path("collected_ids.json"), []))
    errors = load_json(state_path("errors.json"), [])

    enriched_episodes = load_json(state_path("enriched", "episodes.json"), [])
    enriched_characters = load_json(state_path("enriched", "characters.json"), [])
    enriched_toh_segments = load_json(state_path("enriched", "toh_segments.json"), [])
    unnumbered_warning = []

    any_new = False
    for fname, info in submitted.items():
        if info.get("collected") or info.get("processing_status") != "ended":
            continue
        results_url = info.get("results_url")
        if not results_url:
            print(f"{fname}: marked ended but no results_url yet, run 'status' again.")
            continue

        resp = requests.get(results_url, headers=headers, timeout=120)
        resp.raise_for_status()
        lines = [l for l in resp.text.splitlines() if l.strip()]
        print(f"{fname}: {len(lines)} results")

        for line in lines:
            try:
                row = json.loads(line)
                cid = row["custom_id"]
                result = row.get("result", {})
                meta = id_map.get(cid, {})
                title, kind, season = meta.get("title"), meta.get("kind"), meta.get("season")

                if cid in collected_ids:
                    continue  # already collected in an earlier (interrupted) run

                if result.get("type") != "succeeded":
                    errors.append({"custom_id": cid, "title": title, "error": result})
                    continue

                content_blocks = result.get("message", {}).get("content", [])
                text_block = next((c.get("text") for c in content_blocks if c.get("type") == "text"), None)
                if text_block is None:
                    errors.append({"custom_id": cid, "title": title,
                                    "error": f"No text block in response content: {content_blocks}"})
                    continue

                try:
                    parsed = robust_json_parse(strip_code_fence(text_block))
                except Exception as e:
                    errors.append({"custom_id": cid, "title": title,
                                    "error": f"JSON parse failed: {e}", "raw": text_block[:500]})
                    continue

                if kind == "ep":
                    entry, missing_num = build_episode_entry(title, season, parsed)
                    enriched_episodes.append(entry)
                    if missing_num:
                        unnumbered_warning.append(entry["id"])
                elif kind == "tohseg":
                    entry = build_toh_segment_entry(cid, meta, parsed)
                    enriched_toh_segments.append(entry)
                else:
                    entry = build_character_entry(title, parsed)
                    enriched_characters.append(entry)

                collected_ids.add(cid)
                any_new = True
            except Exception as e:
                errors.append({"custom_id": row.get("custom_id") if isinstance(row, dict) else None,
                                "error": f"Unexpected error processing result: {e}"})

        info["collected"] = True
        # Save after every batch file so an interruption doesn't lose already-collected progress.
        save_json(state_path("enriched", "episodes.json"), enriched_episodes)
        save_json(state_path("enriched", "characters.json"), enriched_characters)
        save_json(state_path("enriched", "toh_segments.json"), enriched_toh_segments)
        save_json(state_path("collected_ids.json"), sorted(collected_ids))
        save_json(state_path("errors.json"), errors)
        save_json(state_path("submitted_batches.json"), submitted)
    save_json(state_path("collected_ids.json"), sorted(collected_ids))
    save_json(state_path("errors.json"), errors)
    save_json(state_path("submitted_batches.json"), submitted)

    if not any_new:
        print("Nothing new to collect. Run 'status' first — batches need processing_status 'ended'.")
    else:
        print(f"Collected so far: {len(enriched_episodes)} episodes, {len(enriched_characters)} characters, "
              f"{len(enriched_toh_segments)} ToH segments.")
    if errors:
        print(f"{len(errors)} requests failed or didn't parse — see pipeline_state/errors.json")
    if unnumbered_warning:
        print(f"{len(unnumbered_warning)} episodes had no detectable in-season number "
              f"(ids ending in e00) — spot check these ids in enriched/episodes.json:")
        for eid in unnumbered_warning[:20]:
            print(" -", eid)


# ---------------------------------------------------------------- merge

EP_ID_PATTERN = re.compile(r"^s(\d+)e(\d+)-")
TITLE_SUFFIX_PATTERN = re.compile(r"^(.*) \(S\d+E\d+\)$")


def normalize_for_match(text):
    """Strip everything but letters/digits and lowercase. Used to reconcile ids
    across inconsistent legacy slugs (the existing S1-15 ids were hand-generated
    over many batches and don't follow one consistent apostrophe/punctuation rule
    — e.g. some use 'bart-s-comet', others 'homers-odyssey' for the same pattern).
    Matching on normalized title text instead of reconstructed slug avoids
    creating duplicate entries for the ~20 titles where that legacy convention
    was inconsistent."""
    return re.sub(r"[^a-z0-9]", "", text.lower())


def build_existing_lookups(data):
    ep_lookup, char_lookup = {}, {}
    for e in data:
        mm = EP_ID_PATTERN.match(e["id"])
        if mm:
            season = int(mm.group(1))
            tm = TITLE_SUFFIX_PATTERN.match(e["title"])
            bare_title = tm.group(1) if tm else e["title"]
            ep_lookup[(season, normalize_for_match(bare_title))] = e["id"]
        else:
            char_lookup[normalize_for_match(e["title"])] = e["id"]
    return ep_lookup, char_lookup


def reconcile_ids(enriched_episodes, enriched_characters, data):
    """Rewrite freshly-computed ids to match existing dataset ids where the
    underlying title clearly refers to the same episode/character, so merge
    replaces instead of duplicating. Returns count of ids rewritten."""
    ep_lookup, char_lookup = build_existing_lookups(data)
    rewritten = 0

    for entry in enriched_episodes:
        mm = EP_ID_PATTERN.match(entry["id"])
        if not mm:
            continue
        season = int(mm.group(1))
        tm = TITLE_SUFFIX_PATTERN.match(entry["title"])
        bare_title = tm.group(1) if tm else entry["title"]
        key = (season, normalize_for_match(bare_title))
        if key in ep_lookup and ep_lookup[key] != entry["id"]:
            entry["id"] = ep_lookup[key]
            rewritten += 1

    for entry in enriched_characters:
        key = normalize_for_match(entry["title"])
        if key in char_lookup and char_lookup[key] != entry["id"]:
            entry["id"] = char_lookup[key]
            rewritten += 1

    return rewritten


def cmd_merge(args):
    with open(args.into) as f:
        data = json.load(f)
    print("Before merge:", len(data))

    enriched_episodes = load_json(state_path("enriched", "episodes.json"), [])
    enriched_characters = load_json(state_path("enriched", "characters.json"), [])
    enriched_toh_segments = load_json(state_path("enriched", "toh_segments.json"), [])

    rewritten = reconcile_ids(enriched_episodes, enriched_characters, data)
    if rewritten:
        print(f"Reconciled {rewritten} ids to match existing entries by title (avoiding duplicates).")
    # ToH segment ids are freshly minted from the already-correct parent episode id
    # (see TOH_EPISODES), so they never need title-based reconciliation.

    enriched = {}
    for e in enriched_episodes + enriched_characters + enriched_toh_segments:
        enriched[e["id"]] = e

    by_id = {e["id"]: idx for idx, e in enumerate(data)}
    replaced = added = 0
    for eid, entry in enriched.items():
        if eid in by_id:
            data[by_id[eid]] = entry
            replaced += 1
        else:
            data.append(entry)
            added += 1

    print(f"Replaced: {replaced}, Added: {added}")
    print("After merge:", len(data))

    ids = [e["id"] for e in data]
    if len(set(ids)) != len(ids):
        print("WARNING: duplicate ids detected after merge — inspect before trusting this file.")
    else:
        print("All ids unique.")

    with open(args.into, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Saved to {args.into}")


# ---------------------------------------------------------------- patch-toh-parents

PATCH_MARKER = "This installment is made up of"


def cmd_patch_toh_parents(args):
    """Deterministic, no-LLM step: append a sentence to each ToH parent episode's
    existing text listing its segments by name and (for the numbered series) both
    the roman-numeral and plain-number forms — e.g. 'also called Treehouse of
    Horror 13' — so a query for either form retrieves the parent episode too, not
    just its segments.

    Always re-derives the segment list fresh from the cached wikitext (via
    extract_segments) rather than from whatever order batch results happened to
    come back in — so this is safe to re-run any time after fixing segment
    titles/ordering/exclusions, and will correct a previously-wrong patch rather
    than skip it (it strips its own old sentence first, matched via PATCH_MARKER)."""
    with open(args.into) as f:
        data = json.load(f)
    by_id = {e["id"]: e for e in data}
    cache = load_json(state_path("toh_wikitext_cache.json"), {})

    patched = skipped_no_segments = missing = 0
    for eid, ep_title, season, ep_num, roman, arabic in TOH_EPISODES:
        entry = by_id.get(eid)
        if not entry:
            print(f"  WARNING: parent id '{eid}' not found in {args.into} — skipping.")
            missing += 1
            continue

        segs = extract_segments(cache.get(ep_title, {}).get("main"))
        if not segs:
            skipped_no_segments += 1
            continue

        base_text = entry.get("text", "")
        if PATCH_MARKER in base_text:
            base_text = base_text.split(PATCH_MARKER)[0].rstrip()

        seg_titles = [f'"{title}"' for title, _ in segs]
        if len(seg_titles) == 1:
            seg_list = seg_titles[0]
        elif len(seg_titles) == 2:
            seg_list = f"{seg_titles[0]} and {seg_titles[1]}"
        else:
            seg_list = ", ".join(seg_titles[:-1]) + f", and {seg_titles[-1]}"

        numeral_clause = f" (also called Treehouse of Horror {arabic})" if roman and arabic else ""
        sentence = (f' {PATCH_MARKER} {len(segs)} segment{"s" if len(segs) != 1 else ""}'
                    f'{numeral_clause}: {seg_list}.')
        entry["text"] = base_text + sentence
        # also fold segment names into keys metadata for good measure
        entry.setdefault("keys", [])
        for title, _ in segs:
            if title.lower() not in entry["keys"]:
                entry["keys"].append(title.lower())
        patched += 1

    with open(args.into, "w") as f:
        json.dump(data, f, indent=2)

    print(f"Patched {patched} parent episodes with segment lists + numeral cross-references.")
    print(f"Skipped (no cached wikitext / no segments detected): {skipped_no_segments}. "
          f"Missing from dataset: {missing}.")
    print(f"Saved to {args.into}")


# ---------------------------------------------------------------- export-toh-delta

# One-time cleanup: the first extract_segments() pass (a) treated bare "Opening
# sequence"/"Closing sequence" wraparound narration as if it were a real skit for
# 22 episodes, and (b) left "Act I:"/"Opening Sequence:"-prefixed titles uncleaned
# for 4 segments. The parser was fixed to exclude/clean these going forward, but
# the old, already-ingested rows under their old ids need to be dropped from the
# master file too, or they'd keep getting re-exported and re-ingested forever.
STALE_TOH_IDS = {
    "s11e04-treehouse-of-horror-x-segment-opening-sequence",
    "s19e05-treehouse-of-horror-xviii-segment-opening-sequence",
    "s18e04-treehouse-of-horror-xvii-segment-opening-sequence",
    "s23e03-treehouse-of-horror-xxii-segment-opening-sequence",
    "s6e06-treehouse-of-horror-v-segment-closing-sequence",
    "s13e01-treehouse-of-horror-xii-segment-opening-sequence",
    "s12e01-treehouse-of-horror-xi-segment-opening-sequence",
    "s6e06-treehouse-of-horror-v-segment-opening-sequence",
    "s17e04-treehouse-of-horror-xvi-segment-opening-sequence",
    "s12e01-treehouse-of-horror-xi-segment-closing-sequence",
    "s10e04-treehouse-of-horror-ix-segment-opening-sequence",
    "s22e04-treehouse-of-horror-xxi-segment-opening-sequence",
    "s15e01-treehouse-of-horror-xiv-segment-opening-sequence",
    "s21e04-treehouse-of-horror-xx-segment-opening-sequence",
    "s30e04-treehouse-of-horror-xxix-segment-opening-sequence",
    "s24e02-treehouse-of-horror-xxiii-segment-opening-sequence",
    "s31e04-treehouse-of-horror-xxx-segment-opening-sequence",
    "s13e01-treehouse-of-horror-xii-segment-closing-sequence",
    "s14e01-treehouse-of-horror-xiii-segment-opening-sequence",
    "s7e06-treehouse-of-horror-vi-segment-opening-sequence",
    "s26e04-treehouse-of-horror-xxv-segment-opening-sequence",
    "s16e01-treehouse-of-horror-xv-segment-opening-sequence",
    "s29e04-treehouse-of-horror-xxviii-segment-opening-sequence-the-sweets-hereafter",
    "s2e03-treehouse-of-horror-segment-act-i-bad-dream-house",
    "s2e03-treehouse-of-horror-segment-act-ii-hungry-are-the-damned",
    "s2e03-treehouse-of-horror-segment-act-iii-the-raven",
    # Treehouse of Horror II uses the same "Act N:" convention as the very first
    # episode -- missed in the initial sweep since it was only found by directly
    # querying D1 for stray "-segment-act-" ids after the first round of fixes.
    "s3e07-treehouse-of-horror-ii-segment-act-i-lisas-nightmare",
    "s3e07-treehouse-of-horror-ii-segment-act-ii-barts-nightmare",
    "s3e07-treehouse-of-horror-ii-segment-act-iii-homers-nightmare",
}


def cmd_export_toh_delta(args):
    """Pull just the 37 ToH parent episodes + their segment entries out of the full
    dataset file, so you can ingest ~184 entries instead of re-embedding the whole
    ~3700-entry dataset when only the ToH content actually changed. Also permanently
    drops the stale pre-fix segment ids (see STALE_TOH_IDS) from the master file."""
    with open(args.into) as f:
        data = json.load(f)

    before = len(data)
    data = [e for e in data if e["id"] not in STALE_TOH_IDS]
    removed = before - len(data)
    if removed:
        with open(args.into, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Pruned {removed} stale pre-fix ToH segment ids from {args.into}.")

    by_id = {e["id"]: e for e in data}

    wanted_ids = {eid for eid, *_ in TOH_EPISODES}
    wanted_ids |= {e["id"] for e in data if "-segment-" in e["id"]}

    delta = [by_id[eid] for eid in wanted_ids if eid in by_id]
    missing = [eid for eid in wanted_ids if eid not in by_id]

    with open(args.out, "w") as f:
        json.dump(delta, f, indent=2)

    print(f"Exported {len(delta)} entries (parent episodes + segments) to {args.out}.")
    if missing:
        print(f"WARNING: {len(missing)} expected ids not found in {args.into}: {missing[:10]}")
    print(f"Next: node scripts/ingest.js {args.out}")
    print(f"IMPORTANT: also delete these {len(STALE_TOH_IDS)} stale ids from the live "
          f"Worker/D1/Vectorize via /api/admin/delete — they were dropped from the local "
          f"file but ingest only upserts, so it can't remove anything remotely.")


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("list-episodes")
    sp.add_argument("--max-season", type=int, default=MAX_SEASON)
    sp.set_defaults(func=cmd_list_episodes)

    sp = sub.add_parser("list-characters")
    sp.add_argument("--target", type=int, default=400, help="how many characters total, incl. core cast (ignored if --all)")
    sp.add_argument("--all", action="store_true", help="take every page in Category:Recurring characters (~2,800), ignoring --target")
    sp.set_defaults(func=cmd_list_characters)

    sp = sub.add_parser("fetch-wikitext")
    sp.set_defaults(func=cmd_fetch_wikitext)

    sp = sub.add_parser("build-batches")
    sp.set_defaults(func=cmd_build_batches)

    sp = sub.add_parser("submit")
    sp.set_defaults(func=cmd_submit)

    sp = sub.add_parser("status")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("collect")
    sp.set_defaults(func=cmd_collect)

    sp = sub.add_parser("merge")
    sp.add_argument("--into", required=True, help="path to simpsons-data.json to merge into")
    sp.set_defaults(func=cmd_merge)

    sp = sub.add_parser("list-toh", help="list all Treehouse of Horror episodes (hardcoded, no wiki call)")
    sp.set_defaults(func=cmd_list_toh)

    sp = sub.add_parser("fetch-toh", help="fetch wikitext for all ToH episodes + detect their segments")
    sp.set_defaults(func=cmd_fetch_toh)

    sp = sub.add_parser("build-toh-batches", help="build one batch request per ToH segment")
    sp.set_defaults(func=cmd_build_toh_batches)

    sp = sub.add_parser("patch-toh-parents",
                         help="no-LLM step: append segment list + roman/arabic cross-refs to each parent episode")
    sp.add_argument("--into", required=True, help="path to simpsons-data.json to patch")
    sp.set_defaults(func=cmd_patch_toh_parents)

    sp = sub.add_parser("export-toh-delta",
                         help="pull just the ToH parents+segments out of the full dataset for a small, fast ingest")
    sp.add_argument("--into", required=True, help="path to the full simpsons-data.json to read from")
    sp.add_argument("--out", required=True, help="path to write the small delta JSON to")
    sp.set_defaults(func=cmd_export_toh_delta)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
