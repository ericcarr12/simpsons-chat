#!/usr/bin/env node
/**
 * Converts data/episode-producers.jsonl and data/episode-characters.jsonl
 * into batched SQL INSERT files for loading into the simpsons-db D1
 * database directly with Wrangler — no chat round-trips required.
 *
 * Skips any episode_id already listed in already-loaded-episode-ids.json
 * (the 230 episodes already confirmed loaded and verified in D1), so you
 * won't create duplicate rows. Neither episode_producers nor
 * episode_characters has a unique constraint, so a duplicate insert would
 * silently double-count that episode rather than error.
 *
 * Usage (run from wherever you put this file):
 *   node generate-d1-batches.js
 *   node generate-d1-batches.js --data-dir ./data --out ./d1-batches --batch-size 300
 *
 * Then run the generated run-d1-batches.sh to push everything to D1.
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = {
    dataDir: path.join(__dirname, "data"),
    out: path.join(__dirname, "d1-batches"),
    batchSize: 300,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir") args.dataDir = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--batch-size") args.batchSize = parseInt(argv[++i], 10);
  }
  return args;
}

function loadJsonl(file) {
  if (!fs.existsSync(file)) {
    console.error(`Missing input file: ${file}`);
    process.exit(1);
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function sqlEscape(str) {
  return String(str).replace(/'/g, "''");
}

function writeBatches({ rows, table, columns, outDir, batchSize, prefix }) {
  if (rows.length === 0) {
    console.log(`No new rows for ${table}.`);
    return [];
  }
  const files = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = chunk
      .map((row) => `(${columns.map((c) => `'${sqlEscape(row[c])}'`).join(",")})`)
      .join(",\n");
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values};\n`;
    const fileName = `${prefix}_${String(Math.floor(i / batchSize)).padStart(3, "0")}.sql`;
    fs.writeFileSync(path.join(outDir, fileName), sql, "utf8");
    files.push(fileName);
  }
  console.log(`Wrote ${files.length} batch file(s) for ${table} (${rows.length} new rows).`);
  return files;
}

function main() {
  const { dataDir, out, batchSize } = parseArgs();

  const alreadyLoaded = new Set(
    JSON.parse(fs.readFileSync(path.join(__dirname, "already-loaded-episode-ids.json"), "utf8"))
  );

  fs.mkdirSync(out, { recursive: true });

  const producers = loadJsonl(path.join(dataDir, "episode-producers.jsonl")).filter(
    (r) => !alreadyLoaded.has(r.episode_id)
  );
  const characters = loadJsonl(path.join(dataDir, "episode-characters.jsonl")).filter(
    (r) => !alreadyLoaded.has(r.episode_id)
  );

  const newProducerEpisodes = new Set(producers.map((r) => r.episode_id));
  const newCharacterEpisodes = new Set(characters.map((r) => r.episode_id));
  console.log(
    `New episodes found — producers: ${newProducerEpisodes.size} episode(s)/${producers.length} row(s), ` +
      `characters: ${newCharacterEpisodes.size} episode(s)/${characters.length} row(s)`
  );

  const producerFiles = writeBatches({
    rows: producers,
    table: "episode_producers",
    columns: ["episode_id", "role", "person"],
    outDir: out,
    batchSize,
    prefix: "producers",
  });

  const characterFiles = writeBatches({
    rows: characters,
    table: "episode_characters",
    columns: ["episode_id", "character", "appearance_type"],
    outDir: out,
    batchSize,
    prefix: "characters",
  });

  const allFiles = [...producerFiles, ...characterFiles];
  if (allFiles.length === 0) {
    console.log("\nNothing new to load — no runner script written.");
    return;
  }

  const runnerPath = path.join(path.dirname(out), "run-d1-batches.sh");
  const batchDirName = path.basename(out);
  const lines = [
    "#!/usr/bin/env bash",
    "set -e",
    'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
    `BATCH_DIR="$SCRIPT_DIR/${batchDirName}"`,
    "",
    ...allFiles.map(
      (f) =>
        `echo "Loading ${f}..." && npx wrangler d1 execute simpsons-db --remote --file="$BATCH_DIR/${f}"`
    ),
    "",
    'echo "All batches loaded. Let Claude know so it can run the final verification pass."',
  ];
  fs.writeFileSync(runnerPath, lines.join("\n") + "\n", { mode: 0o755 });

  console.log(`\nWrote runner script: ${runnerPath}`);
  console.log(`Run it with: bash ${path.relative(process.cwd(), runnerPath)}`);
}

main();
