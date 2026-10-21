/**
 * Pushes data/simpsons-data.json into the deployed Worker's /api/ingest endpoint.
 * The Worker embeds each entry and stores it in D1 + Vectorize.
 *
 * Usage:
 *   WORKER_URL=https://simpsons-chatbot.<your-subdomain>.workers.dev \
 *   INGEST_SECRET=<the secret you set with `wrangler secret put INGEST_SECRET`> \
 *   node scripts/ingest.js [path/to/data.json]
 *
 * Run with Node 18+ (built-in fetch). Batches requests so one bad entry
 * doesn't take down the whole run. Network-level failures (timeouts,
 * ECONNRESET, etc. -- as opposed to a normal non-2xx response) are retried
 * with backoff instead of crashing the whole script, and progress is
 * checkpointed to disk so a hard crash can resume instead of starting over.
 */

const WORKER_URL = process.env.WORKER_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const DATA_PATH = process.argv[2] || new URL("../data/simpsons-data.json", import.meta.url);
const BATCH_SIZE = 10;
const MAX_RETRIES = 5;
const PROGRESS_PATH = new URL("../.ingest_progress.json", import.meta.url);

if (!WORKER_URL || !INGEST_SECRET) {
  console.error("Set WORKER_URL and INGEST_SECRET environment variables first.");
  process.exit(1);
}

async function loadEntries(dataPath) {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(dataPath, "utf-8");
  const pathStr = dataPath.toString();

  if (pathStr.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(raw);
}

async function loadProgress() {
  const fs = await import("node:fs/promises");
  try {
    const raw = await fs.readFile(PROGRESS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveProgress(nextBatchIndex, totalInserted, totalFailed) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    PROGRESS_PATH,
    JSON.stringify({ nextBatchIndex, totalInserted, totalFailed, dataPath: DATA_PATH.toString() }, null, 2)
  );
}

async function clearProgress() {
  const fs = await import("node:fs/promises");
  try {
    await fs.unlink(PROGRESS_PATH);
  } catch {
    // already gone, fine
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Posts one batch, retrying on network-level failures (fetch throwing) with
// exponential backoff. A normal non-2xx HTTP response is NOT retried here --
// that's a real server-side answer, not a transient connectivity blip.
async function postBatchWithRetry(batch, batchNumber) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${WORKER_URL}/api/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ingest-secret": INGEST_SECRET,
        },
        body: JSON.stringify({ entries: batch }),
      });
      return res;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`Batch ${batchNumber}: network error after ${MAX_RETRIES} attempts:`, err.message || err);
        return null;
      }
      const wait = 2000 * attempt;
      console.warn(`Batch ${batchNumber}: network error (${err.code || err.message || err}), retrying in ${wait / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(wait);
    }
  }
  return null;
}

async function main() {
  const entries = await loadEntries(DATA_PATH);
  console.log(`Loaded ${entries.length} entries from ${DATA_PATH}`);

  let totalInserted = 0;
  let totalFailed = 0;
  let startIndex = 0;

  const resume = await loadProgress();
  if (resume && resume.dataPath === DATA_PATH.toString()) {
    startIndex = resume.nextBatchIndex;
    totalInserted = resume.totalInserted;
    totalFailed = resume.totalFailed;
    console.log(`Resuming from a previous run: skipping to batch starting at entry ${startIndex} (already inserted/updated: ${totalInserted}, failed: ${totalFailed}).`);
  }

  const totalBatches = Math.ceil(entries.length / BATCH_SIZE);

  for (let i = startIndex; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchNumber = i / BATCH_SIZE + 1;
    console.log(`Ingesting batch ${batchNumber}/${totalBatches} (${batch.length} entries)...`);

    const res = await postBatchWithRetry(batch, batchNumber);

    if (!res) {
      // Network-level failure that survived all retries -- stop here rather
      // than silently marking a whole batch as "failed" content-wise (it was
      // never even accepted by the server). Progress is saved so re-running
      // the same command picks up right here.
      await saveProgress(i, totalInserted, totalFailed);
      console.error(`\nStopped at batch ${batchNumber} after repeated network errors. Progress saved -- `
        + `just re-run the same command to resume from here.`);
      process.exit(1);
    }

    if (!res.ok) {
      console.error(`Batch ${batchNumber} failed with status ${res.status}:`, await res.text());
      totalFailed += batch.length;
    } else {
      const result = await res.json();
      totalInserted += result.inserted;
      totalFailed += result.failed;
      if (result.errors?.length) {
        console.error("Errors in this batch:", result.errors);
      }
    }

    await saveProgress(i + BATCH_SIZE, totalInserted, totalFailed);
  }

  await clearProgress();
  console.log(`\nDone. Inserted/updated: ${totalInserted}, failed: ${totalFailed}`);
}

main().catch(async (err) => {
  console.error("Ingest script failed:", err);
  process.exit(1);
});
