/**
 * Simpsons fan chatbot backend — Cloudflare Worker.
 *
 * Endpoints:
 *   POST /api/chat    { message: string }              -> { answer, sources: [...] }
 *   POST /api/ingest   { entries: [...] }  (protected)  -> { inserted, updated, failed }
 *   GET  /api/health                                    -> { ok: true }
 *
 * Architecture:
 *   1. Embed the incoming text with Workers AI (bge-base-en-v1.5, 768 dims).
 *   2. Store/search those embeddings in Vectorize.
 *   3. For chat: pull the top-K most relevant entries, stuff them into a system
 *      prompt, and ask Claude to answer using ONLY that context.
 *   4. D1 holds the durable copy of every entry (title/text/source/url) so you
 *      can inspect, edit, or re-embed the dataset without touching Vectorize
 *      directly.
 */

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap; swap to claude-sonnet-5 for higher quality
const TOP_K = 3; // caps how many context entries (and displayed sources) a query can pull in
const RATE_LIMIT_PER_HOUR = 30; // requests per IP per hour for /api/chat

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your site's origin once deployed
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-ingest-secret",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function embed(env, text) {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [text] });
  return result.data[0]; // array of floats
}

// Vectorize caps ids at 64 bytes; some episode titles produce longer slugs than
// that. The Vectorize id is never surfaced to users (chat responses only read
// title/source/url out of metadata), so a handful of long ids can safely hash
// down to something short and stable instead of failing the upsert.
async function vectorizeId(realId) {
  if (new TextEncoder().encode(realId).length <= 64) return realId;
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(realId));
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `long-${hashHex.slice(0, 40)}`; // "long-" + 40 hex chars = 45 bytes, well under the limit
}

async function rateLimit(env, request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`; // per-IP, per-hour bucket
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= RATE_LIMIT_PER_HOUR) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
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

  // 1. Embed the question and search Vectorize for relevant entries.
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

  // 2. Ask Claude to answer using only the retrieved context.
  const systemPrompt =
    "You are a friendly fan-site chatbot answering questions about The Simpsons TV show. " +
    "Answer ONLY using the numbered context entries provided below — do not use outside knowledge, " +
    "and do not invent plot details, quotes, or facts that aren't in the context. " +
    "If the context doesn't actually answer the question, say you don't have that information. " +
    "Keep answers conversational and concise (2-4 sentences).\n\nContext:\n" + contextBlock;

  const anthropicHeaders = {
    "Content-Type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };
  // Only needed if ANTHROPIC_API_KEY is an identity-linked key (tied to your
  // Console login rather than a specific workspace) — set the
  // ANTHROPIC_WORKSPACE_ID secret if you see a "workspace-id is required" error.
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

      // Durable record in D1
      await env.DB.prepare(
        `INSERT INTO entries (id, title, keys, text, source, url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, keys=excluded.keys, text=excluded.text,
           source=excluded.source, url=excluded.url, updated_at=datetime('now')`
      )
        .bind(id, title, (keys || []).join(","), text, source || "curated", url || null)
        .run();

      // Embedding + Vectorize upsert
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

// One-off admin cleanup endpoint: removes stale/duplicate entries from D1 + Vectorize
// by id. D1 rows are keyed by the real id; Vectorize rows are keyed by vectorizeId(id)
// (raw id if <=64 bytes, else the SHA-256 hash form) -- pass the REAL ids here and this
// handles the translation, same as handleIngest does on the way in.
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

    if (url.pathname === "/api/ingest" && request.method === "POST") {
      return handleIngest(request, env);
    }

    if (url.pathname === "/api/admin/delete" && request.method === "POST") {
      return handleAdminDelete(request, env);
    }

    return json({ error: "Not found." }, 404);
  },
};
