// src/index.js
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const TOP_K = 3;
const RATE_LIMIT_PER_HOUR = 30;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your site's origin once deployed
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-ingest-secret",
};

// The five characters common to virtually every episode. For these, listing
// "episodes featuring X" isn't useful -- we instead report the count and any
// exceptions (episodes where they're absent), which is the interesting case.
const MAIN_CHARACTERS = new Set([
  "Homer Simpson",
  "Marge Simpson",
  "Bart Simpson",
  "Lisa Simpson",
  "Maggie Simpson",
]);

// A bare first name like "Homer" should resolve straight to the actual
// family member, not to a same-named one-off character. The dataset has
// dozens of minor entries containing these names as a whole word --
// "Evil Homer", "Fake Homer", "Homer (Greek)", "Actor playing Homer", etc.
// -- and the generic word-boundary matcher in findCharacterName can't tell
// those apart from the real deal, so this short-circuits the common case
// before it ever reaches that fuzzier logic.
const MAIN_CHARACTER_FIRST_NAMES = new Map(
  [...MAIN_CHARACTERS].map((full) => [full.split(" ")[0].toLowerCase(), full])
);

const WIKI_BASE = "https://simpsonswiki.com/wiki/";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function embed(env, text) {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  return result.data[0];
}

async function vectorizeId(realId) {
  if (new TextEncoder().encode(realId).length <= 64) return realId;
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(realId));
  const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `long-${hashHex.slice(0, 40)}`;
}

// Per-IP, per-hour rate limits, bucketed by endpoint so a burst of feedback
// clicks can't eat into the chat quota (or vice versa). "chat" keeps the
// original limit; feedback/contact get their own, more generous or
// stricter as appropriate.
const RATE_LIMITS = {
  chat: RATE_LIMIT_PER_HOUR,
  feedback: 60,
  contact: 10,
};

async function rateLimit(env, request, bucket = "chat") {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `rl:${bucket}:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const limit = RATE_LIMITS[bucket] ?? RATE_LIMIT_PER_HOUR;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

// ---------- Shared helpers for the producer / character-appearance lookups ----------

// Episode titles in `entries` are stored like "Husbands and Knives (S19E07)".
// Strip that suffix for display and for matching against a user's phrasing.
function stripEpisodeCode(title) {
  return title.replace(/\s*\(S\d+E\d+\)\s*$/i, "").trim();
}

function stripQuotesAndPunct(s) {
  return s.trim().replace(/^["'“”]+|["'”.,!?]+$/g, "").trim();
}

// ---------- Goal: "who produced <episode>" / "producers of <episode>" ----------

const PRODUCER_QUERY_RE =
  /\b(?:who\s+(?:produced|are\s+the\s+producers?\s+(?:of|for)|was\s+the\s+producer\s+(?:of|for))|producers?\s+(?:of|for)|producer\s+credits\s+(?:of|for))\s+(?:the\s+episode\s+)?(.+?)[\?\.!]*$/i;

async function findEpisodeByTitle(env, rawTitle) {
  const needle = stripQuotesAndPunct(rawTitle).toLowerCase();
  if (!needle) return null;

  const { results } = await env.DB.prepare(`SELECT id, title FROM entries WHERE id LIKE 's%e%-%'`).all();
  const candidates = results || [];

  let exact = null;
  const contains = [];
  for (const row of candidates) {
    const cleanTitle = stripEpisodeCode(row.title).toLowerCase();
    if (cleanTitle === needle) {
      exact = row;
      break;
    }
    if (cleanTitle.includes(needle) || needle.includes(cleanTitle)) contains.push(row);
  }
  if (exact) return exact;
  if (contains.length > 0) {
    // Prefer the shortest matching title as the most specific match.
    contains.sort((a, b) => a.title.length - b.title.length);
    return contains[0];
  }
  return null;
}

async function tryProducerLookup(message, env) {
  const m = message.match(PRODUCER_QUERY_RE);
  if (!m) return null;
  const episodeQuery = m[1] && m[1].trim();
  if (!episodeQuery) return null;

  const episode = await findEpisodeByTitle(env, episodeQuery);
  if (!episode) {
    return {
      answer:
        `D'oh! I couldn't confidently match "${episodeQuery}" to an episode in Springfield's records. ` +
        `Try the exact episode title, or check ${WIKI_BASE}Category:Episodes for the full list.`,
      sources: [],
      noMatch: true,
    };
  }

  const { results } = await env.DB.prepare(
    `SELECT role, person FROM episode_producers WHERE episode_id = ? ORDER BY rowid`
  )
    .bind(episode.id)
    .all();

  const cleanTitle = stripEpisodeCode(episode.title);

  if (!results || results.length === 0) {
    const wikiSlug = cleanTitle.replace(/:/g, "").replace(/\s+/g, "_");
    return {
      answer:
        `D'oh! I found "${cleanTitle}" but don't have producer credits for it yet in our records. ` +
        `Check ${WIKI_BASE}${encodeURIComponent(wikiSlug)}/Credits for the full crew list.`,
      sources: [],
      noMatch: true,
    };
  }

  const byRole = new Map();
  for (const r of results) {
    if (!byRole.has(r.role)) byRole.set(r.role, []);
    byRole.get(r.role).push(r.person);
  }
  const lines = [...byRole.entries()].map(([role, people]) => `${role}: ${people.join(", ")}`);

  return {
    answer: `Producer credits for "${cleanTitle}":\n\n${lines.join("\n")}`,
    sources: [{ title: cleanTitle, source: "episode_producers", url: null }],
  };
}

// ---------- Goal: "list all episodes featuring <character>" ----------

const CHARACTER_QUERY_PATTERNS = [
  // "episodes featuring/with X" (character after the keyword)
  // NOTE: \b word boundaries around list/show below are important --
  // without them "show" matches inside "Sideshow", silently truncating
  // "Sideshow Bob" down to "Bob" and mismatching onto e.g. "Bobo".
  /\b(?:list|show)\b\s+(?:all\s+)?(?:the\s+)?episodes?\s+(?:that\s+)?featur\w*\s+(.+?)[\?\.!]*$/i,
  // "feature" as well as "featuring" -- ("Which episodes feature Homer?")
  /episodes?\s+(?:featur\w*|with)\s+(.+?)[\?\.!]*$/i,
  /(?:every|all)\s+episodes?\s+(.+?)\s+(?:appears?|is)\s+in[\?\.!]*$/i,
  // "which/what episodes does/is X (appear/show up) in"
  /(?:which|what)\s+episodes?\s+(?:does|do)\s+(.+?)\s+(?:appear|show\s+up)\s+in[\?\.!]*$/i,
  /(?:which|what)\s+episodes?\s+(?:is|are)\s+(.+?)\s+in[\?\.!]*$/i,
  // "how many episodes has/does/did X been/appear in" -- count-style phrasing
  /how\s+many\s+episodes?\s+(?:has|have|does|did|is|are)\s+(.+?)\s+(?:been\s+in|be\s+in|appear(?:ed)?\s+in|in)[\?\.!]*$/i,
  // "list/show all X episodes" (character BEFORE the keyword "episodes")
  /\b(?:list|show)\b\s+(?:all\s+)?(?:the\s+)?(.+?)\s+episodes?[\?\.!]*$/i,
  // bare fallback: "<character> episodes" with no leading verb at all,
  // anchored to the start of the message so it doesn't fire mid-sentence.
  /^(.+?)\s+episodes?[\?\.!]*$/i,
];

// Generic words that can end up captured by the "X episodes" pattern when
// there's no actual character name in the sentence (e.g. "list all episodes").
// If EVERY word in the capture is one of these, it's junk from the sentence's
// own verbs/articles rather than a character name -- treat it as no match.
const CHARACTER_QUERY_STOPWORDS = new Set([
  "all", "the", "every", "these", "those", "some", "any", "list", "show", "me",
]);

function isJunkCandidate(candidate) {
  const words = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 || words.every((w) => CHARACTER_QUERY_STOPWORDS.has(w));
}

function extractCharacterQuery(message) {
  for (const re of CHARACTER_QUERY_PATTERNS) {
    const m = message.match(re);
    if (m && m[1]) {
      const candidate = m[1].trim();
      if (isJunkCandidate(candidate)) continue;
      return candidate;
    }
  }
  return null;
}

async function findCharacterName(env, rawName) {
  const needle = stripQuotesAndPunct(rawName)
    .toLowerCase()
    .replace(/\s*\(character\)\s*$/i, "");
  if (!needle) return null;

  // Bare first name of a main character ("Homer", "Marge", ...) -- resolve
  // directly rather than risking a tie-break onto a one-off same-named
  // character like "Evil Homer" or "Homer (Greek)".
  if (MAIN_CHARACTER_FIRST_NAMES.has(needle)) {
    return MAIN_CHARACTER_FIRST_NAMES.get(needle);
  }

  const needleWords = needle.split(/\s+/).filter(Boolean);

  const { results } = await env.DB.prepare(`SELECT DISTINCT character FROM episode_characters`).all();

  let exact = null;
  const wordBoundary = []; // needle aligns with whole word(s) in the name, e.g. "homer" -> "Homer Simpson"
  const substring = []; // needle is merely a substring somewhere in the name, e.g. "homer" -> "Homeroni"

  for (const row of results || []) {
    const c = row.character.toLowerCase().replace(/\s*\(character\)\s*$/i, "");
    if (c === needle) {
      exact = row.character;
      break;
    }
    const cWords = c.split(/\s+/).filter(Boolean);

    // Whole-word match: needle's words line up with a contiguous run of the
    // character's own words (e.g. "homer" matches the first word of
    // "Homer Simpson", "sideshow bob" matches "Sideshow Bob" in full).
    let isWordBoundary = false;
    for (let start = 0; start <= cWords.length - needleWords.length; start++) {
      if (cWords.slice(start, start + needleWords.length).join(" ") === needle) {
        isWordBoundary = true;
        break;
      }
    }
    // Also treat it as whole-word if every one of the character's OWN words
    // is a whole word within the needle (needle is the more specific side),
    // e.g. needle "sideshow bob roberts" against character "Sideshow Bob".
    if (!isWordBoundary && needleWords.length >= cWords.length) {
      for (let start = 0; start <= needleWords.length - cWords.length; start++) {
        if (needleWords.slice(start, start + cWords.length).join(" ") === c) {
          isWordBoundary = true;
          break;
        }
      }
    }

    if (isWordBoundary) wordBoundary.push(row.character);
    else if (c.includes(needle) || needle.includes(c)) substring.push(row.character);
  }

  if (exact) return exact;
  // Prefer real word-boundary matches (Homer Simpson) over incidental
  // substring collisions (Homeroni) -- only fall back to substring matches
  // when nothing lines up on word boundaries at all.
  const candidates = wordBoundary.length > 0 ? wordBoundary : substring;
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0];
  }
  return null;
}

// Homer technically has 4 exceptions in the raw data -- 2 episodes where
// he's credited under an in-story alias ("Homer Serfson" in The Serfsons,
// "Homer Simpsley" in Simpsley), and 2 anthology-style episodes (Women in
// Shorts, Yellow Planet) with no Homer-named credit at all. Per an explicit
// editorial call, the site treats the "every episode" claim as true
// regardless -- this hardcoded answer intentionally overrides the dynamic
// count/exception logic below for Homer specifically.
const HOMER_EVERY_EPISODE_ANSWER = {
  answer:
    `Homer Simpson has appeared in every one of the 809 episodes of The Simpsons! He is the only character to have spoken dialog in every regular broadcast episode of the series. He is the most-featured Simpson with over 350 specific episodes centering directly around his storylines and jobs.\n\n` +
    `The episode "The Road to Cincinnati", which focused entirely on a road trip buddy comedy with Principal Skinner and Superintendent Chalmers driving 800 miles to a convention, almost broke Dan Castellaneta's record of having a speaking line in every episode of the Simpsons. But Homer ultimately appeared in the post-credits scene saying "I went to work. Lenny had a cold, so he wasn't there. Carl was there though.", keeping the record intact.`,
  sources: [{ title: "Homer Simpson", source: "episode_characters", url: null }],
};

// Editorial, curated answers for the five main family members' "how many
// episodes" question. These intentionally override the dynamic count/exception
// logic below -- per an explicit editorial call, the site states these fixed
// narratives regardless of any raw-data nuance found in scraping.
const MARGE_EVERY_EPISODE_ANSWER = {
  answer:
    `Marge Simpson has appeared in every episode of The Simpsons with 148 episodes completed centered on her. She has a dialog in every episode with the notable exception of "Krusty Get Kancelled". Julie Kavner, who voices Marge, boycotted recording lines for this episode because she objected to the overwhelming number of celebrity guest stars. She felt the heavy reliance on Hollywood cameos took away from the core cast and the heart of the show.`,
  sources: [{ title: "Marge Simpson", source: "episode_characters", url: null }],
};

const BART_EVERY_EPISODE_ANSWER = {
  answer:
    `Bart Simpson has appeared in every episode of The Simpsons with a couple exceptions: "Four Great Women and a Manicure", Bart is briefly visible in the opening couch gag, but doesn't appear, speak, or get mentioned at all during this actual episode, and "My Fare Lady", Bart appears on screen but he has no spoken lines. There are 235 episodes centered around Bart, making him the second most featured Simpson after Homer.`,
  sources: [{ title: "Bart Simpson", source: "episode_characters", url: null }],
};

const LISA_EVERY_EPISODE_ANSWER = {
  answer:
    `Lisa Simpson has appeared in every episode of The Simpsons, except for "Carl Carlson Rides Again" in which she is completely absent. Lisa also appears in "Chief of Hearts" but does not have any dialogue. There are 190 episodes centered around Lisa, making her the third most featured Simpson after Homer and Bart.`,
  sources: [{ title: "Lisa Simpson", source: "episode_characters", url: null }],
};

const MAGGIE_EVERY_EPISODE_ANSWER = {
  answer:
    `Maggie Simpson has appeared all but 28 episodes of The Simpsons. There are 26 episodes centered around Maggie, making her by far the least featured Simpson. Although it is worth noting that she is the only member of the Simpson family to star in her own independent, theatrical short films.`,
  sources: [{ title: "Maggie Simpson", source: "episode_characters", url: null }],
};

const MAIN_CHARACTER_EPISODE_ANSWERS = new Map([
  ["Homer Simpson", HOMER_EVERY_EPISODE_ANSWER],
  ["Marge Simpson", MARGE_EVERY_EPISODE_ANSWER],
  ["Bart Simpson", BART_EVERY_EPISODE_ANSWER],
  ["Lisa Simpson", LISA_EVERY_EPISODE_ANSWER],
  ["Maggie Simpson", MAGGIE_EVERY_EPISODE_ANSWER],
]);

async function tryCharacterEpisodesLookup(message, env) {
  const rawName = extractCharacterQuery(message);
  if (!rawName) return null;

  const character = await findCharacterName(env, rawName);
  if (!character) {
    return {
      answer:
        `D'oh! I couldn't find "${rawName}" in Springfield's character records. ` +
        `Double-check the spelling, or look them up directly at ${WIKI_BASE}Category:Characters.`,
      sources: [],
      noMatch: true,
    };
  }

  if (MAIN_CHARACTER_EPISODE_ANSWERS.has(character)) {
    return MAIN_CHARACTER_EPISODE_ANSWERS.get(character);
  }

  const { results: allEpisodeRows } = await env.DB.prepare(`SELECT DISTINCT episode_id FROM episode_characters`).all();
  const allEpisodeIds = (allEpisodeRows || []).map((r) => r.episode_id);
  const totalEpisodes = allEpisodeIds.length;

  const { results: appearRows } = await env.DB.prepare(
    `SELECT DISTINCT episode_id FROM episode_characters WHERE character = ?`
  )
    .bind(character)
    .all();
  const appearIds = new Set((appearRows || []).map((r) => r.episode_id));

  if (appearIds.size === 0) {
    return {
      answer:
        `D'oh! I couldn't find any episodes listing "${character}" in our records (out of ${totalEpisodes} episodes tracked). ` +
        `This list may be incomplete -- check ${WIKI_BASE}Category:Characters for the full picture.`,
      sources: [],
      noMatch: true,
    };
  }

  const { results: titleRows } = await env.DB.prepare(`SELECT id, title FROM entries WHERE id LIKE 's%e%-%'`).all();
  const titleMap = new Map((titleRows || []).map((r) => [r.id, stripEpisodeCode(r.title)]));

  // We can only speak to the episodes actually in our records. If a title is
  // missing from the `entries` lookup table, fall back to the raw episode_id
  // rather than silently dropping it -- dropping rows would make a supposedly
  // "complete" list secretly incomplete.
  const titleFor = (id) => titleMap.get(id) || id;

  if (MAIN_CHARACTERS.has(character)) {
    const missingIds = allEpisodeIds.filter((id) => !appearIds.has(id));
    const missingTitles = missingIds.map(titleFor).sort();
    const firstName = character.split(" ")[0];
    const answer =
      missingTitles.length === 0
        ? `${character} appears in all ${totalEpisodes} episodes in our records -- no exceptions found.`
        : `${character} appears in ${appearIds.size} of the ${totalEpisodes} episodes in our records. ` +
          `The only one(s) without ${firstName}: ${missingTitles.join(", ")}.`;
    return {
      answer,
      sources: [{ title: character, source: "episode_characters", url: null }],
    };
  }

  const episodeTitles = [...appearIds].map(titleFor).sort();
  return {
    answer:
      `${character} appears in ${episodeTitles.length} episode(s) out of ${totalEpisodes} tracked:\n\n` +
      episodeTitles.join("\n"),
    sources: [{ title: character, source: "episode_characters", url: null }],
  };
}

// ---------- Existing RAG chat flow ----------

// Curated, verbatim canned answers for specific memorable quotes fans are
// likely to type in directly. Matched by simple substring containment on a
// normalized (lowercased, punctuation-stripped) version of the message, so
// "save me jebus", "Save me, Jebus!", etc. all hit the same entry. These take
// priority over the vector-search + LLM path for the same reason the
// producer/character lookups do: fidelity matters more than approximation
// for a specific, well-known line.
function normalizeForQuoteMatch(text) {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MEMORABLE_QUOTES = [
  {
    title: "Lisa the Skeptic",
    triggers: ["why was i programmed to feel pain"],
    answer:
      `Ha! In the episode "Lisa The Skeptic", the townspeople burn down the Springfield Robotics Laboratory and a robot parody of Robbie The Robot (from Lost In Space) emerges from the burning building covered in flames asking "Why was I programmed to feel pain?"`,
  },
  {
    title: "Eight Misbehavin'",
    triggers: ["i need tungsten to live", "allen wrench"],
    answer:
      `Ha! At the beginning of the episode "Eight Misbehavin'", the Simpsons are shopping at SHOP, a parody of IKEA, when they run into an anthropomorphic hex key or Allen Wrench working as the store greeter.\n` +
      `Bart: "Cool costume!"\n` +
      `Allen Wrench (Robotic voice): "It's not a costume. They found me inside a meteor."\n` +
      `Marge: "Excuse me. Where are your hamper lids?"\n` +
      `Allen Wrench (Normal voice): "Hamper lids? Uh, third floor."\n` +
      `Allen Wrench (Robotic voice, turning back to Bart): "Help. I need tungsten to live. TUNGSTEN!"`,
  },
  {
    title: "Missionary: Impossible",
    triggers: ["save me jebus", "i don't even believe in jesus", "i dont even believe in jesus"],
    answer:
      `Ha! The episode "Missionary: Impossible" starts with Homer ignorantly pledging $10,000 to a PBS pledge drive so they'll return to the interrupted program. Betty White and a mob of PBS personalities demand Homer pay the money, but he doesn't have it. Reverend Lovejoy saves him by sending him to a remote island as a missionary where he proclaims:\n` +
      `"I don't even believe in Jebus! Oh, save me, Jebus!"`,
  },
  {
    title: "Treehouse of Horror III",
    triggers: ["cursed frogurt", "the frogurt is also cursed", "this doll is cursed"],
    answer:
      `Ha! From the "Treehouse of Horror III" segment, "Clown Without Pity". Widely considered one of the absolute greatest and most tightly written comedic back-and-forths in television history. Homer visits the House of Evil to buy Bart a birthday present, and the shopkeeper offers him a talking Krusty doll:\n` +
      `Shopkeeper: "Take this object, but beware it carries a terrible curse!"\n` +
      `Homer: "Ooh, that's bad."\n` +
      `Shopkeeper: "But it comes with a free frogurt!"\n` +
      `Homer: "That's good!"\n` +
      `Shopkeeper: "The frogurt is also cursed."\n` +
      `Homer: "That's bad."\n` +
      `Shopkeeper: "But you get your choice of topping!"\n` +
      `Homer: "That's good!"\n` +
      `Shopkeeper: "The toppings contain potassium benzoate."\n` +
      `(Homer stares blankly)\n` +
      `Shopkeeper: "...That's bad."\n` +
      `Homer: "Can I go now?"`,
  },
  {
    title: "Marge vs. the Monorail",
    // Unlike the other entries, these two phrases are short enough that a
    // loose substring match risks false-triggering inside unrelated
    // sentences ("...didn't I..."), so this entry requires the normalized
    // message to match one of these exactly (trailing "?"/"." already
    // stripped by normalizeForQuoteMatch).
    triggers: ["didn't i", "didnt i", "well my work here is done"],
    exact: true,
    answer:
      `Ha! In the classic episode "Marge vs. the Monorail", Leonard Nimoy appears as a celebrity guest for the inaugural trip for Springfield's new monorail. Things quickly go awry when Homer loses control of the train before ultimately saving the day. In the aftermath, Leonard Nimoy has a brief encounter with Barney Gumble:\n` +
      `Leonard Nimoy: "Well, my work here is done."\n` +
      `Barney Gumble: "What do you mean your work is done? You didn't do anything!"\n` +
      `Leonard Nimoy: [chuckles] "Didn't I?"\n\n` +
      `Leonard Nimoy beams away as in Star Trek.`,
  },
];

function tryMemorableQuoteLookup(message) {
  const normalized = normalizeForQuoteMatch(message);
  for (const entry of MEMORABLE_QUOTES) {
    const matched = entry.exact
      ? entry.triggers.some((t) => normalized === t)
      : entry.triggers.some((t) => normalized.includes(t));
    if (matched) {
      return {
        answer: entry.answer,
        sources: [{ title: entry.title, source: "curated_quote", url: null }],
      };
    }
  }
  return null;
}

async function handleChat(request, env) {
  const allowed = await rateLimit(env, request);
  if (!allowed) {
    return json({ error: "D'oh! Rate limit exceeded. Try again in a bit." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "D'oh! Invalid JSON body." }, 400);
  }

  const message = (body.message || "").trim();
  if (!message) return json({ error: "D'oh! Missing 'message'." }, 400);
  if (message.length > 500) return json({ error: "D'oh! Message too long (max 500 chars)." }, 400);

  // Deterministic, DB-backed answers for producer credits and "which episodes
  // feature X" take priority over the fuzzy vector-search + LLM path below --
  // these need to be complete and grounded, not an approximation from top-K
  // semantic matches.
  const quoteResult = tryMemorableQuoteLookup(message);
  if (quoteResult) return json(quoteResult);

  const producerResult = await tryProducerLookup(message, env);
  if (producerResult) return json(producerResult);

  const characterResult = await tryCharacterEpisodesLookup(message, env);
  if (characterResult) return json(characterResult);

  const vector = await embed(env, message);
  const matches = await env.VECTORIZE_INDEX.query(vector, {
    topK: TOP_K,
    returnMetadata: true,
  });

  const contextEntries = (matches.matches || []).filter((m) => m.score > 0.4);

  if (contextEntries.length === 0) {
    return json({
      answer:
        "D'oh! I couldn't find anything about that in Springfield's records. Try asking about a specific character or episode.",
      sources: [],
      noMatch: true, // tells the frontend to fall through to external lookups instead of treating this as final
    });
  }

  const contextBlock = contextEntries
    .map((m, i) => `[${i + 1}] ${m.metadata.title}: ${m.metadata.text}`)
    .join("\n\n");

  const systemPrompt =
    "You are a friendly fan-site chatbot answering questions about The Simpsons TV show. Answer ONLY using the numbered context entries provided below — do not use outside knowledge, and do not invent plot details, quotes, or facts that aren't in the context. If the context doesn't actually answer the question, say you don't have that information. Keep answers conversational and concise (2-4 sentences).\n\nContext:\n" +
    contextBlock;

  const anthropicHeaders = {
    "Content-Type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  if (env.ANTHROPIC_WORKSPACE_ID) {
    anthropicHeaders["anthropic-workspace-id"] = env.ANTHROPIC_WORKSPACE_ID;
  }

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: anthropicHeaders,
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return json({ error: "D'oh! LLM call failed.", detail: errText }, 502);
  }

  const anthropicJson = await anthropicRes.json();
  const answer = anthropicJson.content?.[0]?.text || "D'oh! I'm not sure how to answer that.";

  return json({
    answer,
    sources: contextEntries.map((m) => ({
      title: m.metadata.title,
      source: m.metadata.source,
      url: m.metadata.url,
    })),
  });
}

// ---------- Feedback (thumbs up/down on chat answers) ----------

async function handleFeedback(request, env) {
  const allowed = await rateLimit(env, request, "feedback");
  if (!allowed) {
    return json({ error: "D'oh! Rate limit exceeded. Try again in a bit." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "D'oh! Invalid JSON body." }, 400);
  }

  const rating = body.rating === "up" || body.rating === "down" ? body.rating : null;
  if (!rating) return json({ error: "D'oh! 'rating' must be 'up' or 'down'." }, 400);

  const message = (body.message || "").toString().trim().slice(0, 500);
  const answer = (body.answer || "").toString().trim().slice(0, 4000);

  const result = await env.DB.prepare(
    `INSERT INTO chat_feedback (message, answer, rating, created_at) VALUES (?, ?, ?, datetime('now'))`
  )
    .bind(message, answer, rating)
    .run();

  return json({ ok: true, id: result.meta?.last_row_id ?? null });
}

// Lets the frontend's "Undo" link remove the vote it just submitted. Scoped
// to rows inserted in the last 10 minutes so a stale/guessed id can't be
// used to delete arbitrary older feedback.
async function handleFeedbackUndo(request, env) {
  const allowed = await rateLimit(env, request, "feedback");
  if (!allowed) {
    return json({ error: "D'oh! Rate limit exceeded. Try again in a bit." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "D'oh! Invalid JSON body." }, 400);
  }

  const id = parseInt(body.id, 10);
  if (!id || Number.isNaN(id)) return json({ error: "D'oh! 'id' is required." }, 400);

  const result = await env.DB.prepare(
    `DELETE FROM chat_feedback WHERE id = ? AND created_at >= datetime('now', '-10 minutes')`
  )
    .bind(id)
    .run();

  return json({ ok: true, deleted: result.meta?.changes ?? 0 });
}

// ---------- Contact form ----------

const CONTACT_REASONS = new Set([
  "incorrect-info",
  "feature-request",
  "bug-report",
  "business-press",
  "other",
]);

async function handleContact(request, env) {
  const allowed = await rateLimit(env, request, "contact");
  if (!allowed) {
    return json({ error: "D'oh! Rate limit exceeded. Try again in a bit." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "D'oh! Invalid JSON body." }, 400);
  }

  const reason = CONTACT_REASONS.has(body.reason) ? body.reason : null;
  if (!reason) return json({ error: "D'oh! Please pick a valid contact reason." }, 400);

  const message = (body.message || "").toString().trim();
  if (!message) return json({ error: "D'oh! Message can't be empty." }, 400);
  if (message.length > 2000) return json({ error: "D'oh! Message too long (max 2000 chars)." }, 400);

  const email = (body.email || "").toString().trim().slice(0, 320);

  await env.DB.prepare(
    `INSERT INTO contact_messages (reason, message, email, created_at) VALUES (?, ?, ?, datetime('now'))`
  )
    .bind(reason, message, email || null)
    .run();

  return json({ ok: true });
}

async function handleIngest(request, env) {
  const secret = request.headers.get("x-ingest-secret");
  if (!secret || secret !== env.INGEST_SECRET) {
    return json({ error: "Unauthorized." }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return json({ error: "'entries' must be a non-empty array." }, 400);
  }

  let inserted = 0;
  let failed = 0;
  const errors = [];

  for (const entry of entries) {
    try {
      const { id, title, text, keys, source, url } = entry;
      if (!id || !title || !text) throw new Error("Each entry needs id, title, and text.");

      await env.DB.prepare(
        `INSERT INTO entries (id, title, keys, text, source, url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, keys=excluded.keys, text=excluded.text,
           source=excluded.source, url=excluded.url, updated_at=datetime('now')`
      )
        .bind(id, title, (keys || []).join(","), text, source || "curated", url || null)
        .run();

      const vector = await embed(env, `${title}: ${text}`);
      await env.VECTORIZE_INDEX.upsert([
        {
          id: await vectorizeId(id),
          values: vector,
          metadata: { title, text, source: source || "curated", url: url || "" },
        },
      ]);

      inserted++;
    } catch (e) {
      failed++;
      errors.push({ id: entry?.id, error: String(e) });
    }
  }

  return json({ inserted, failed, errors });
}

async function handleAdminDelete(request, env) {
  const secret = request.headers.get("x-ingest-secret");
  if (!secret || secret !== env.INGEST_SECRET) {
    return json({ error: "Unauthorized." }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return json({ error: "'ids' must be a non-empty array." }, 400);
  }

  const vectorIds = await Promise.all(ids.map((id) => vectorizeId(id)));

  let d1Deleted = 0;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const res = await env.DB.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();
    d1Deleted = res.meta?.changes ?? 0;
  } catch (e) {
    return json({ error: "D1 delete failed.", detail: String(e) }, 500);
  }

  let vectorizeResult;
  try {
    vectorizeResult = await env.VECTORIZE_INDEX.deleteByIds(vectorIds);
  } catch (e) {
    return json({ error: "Vectorize delete failed.", detail: String(e), d1Deleted }, 500);
  }

  return json({ d1Deleted, vectorizeDeleted: vectorIds.length, vectorIds });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (url.pathname === "/api/feedback" && request.method === "POST") {
      return handleFeedback(request, env);
    }

    if (url.pathname === "/api/feedback/undo" && request.method === "POST") {
      return handleFeedbackUndo(request, env);
    }

    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleContact(request, env);
    }

    if (url.pathname === "/api/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }

    if (url.pathname === "/api/admin/delete" && request.method === "POST") {
      return handleAdminDelete(request, env);
    }

    return json({ error: "Not found." }, 404);
  },
};
