#!/usr/bin/env node
/**
 * load-rxiv.mjs — ndjson from the walk -> stage_preprints -> preprints (+versions).
 *
 * House bulk-load laws: unpooled host, chunked \copy (never one giant COPY), a
 * staging table that names only source-owned columns, then a stage->upsert.
 * Indexes come after, in sql/02.
 *
 * The three normalization traps (LANE-RXIV-MAP.md §2) are fixed HERE, once, so the
 * database never sees a variant:
 *   1. category  'Evolutionary Biology ' / 'evolutionary biology' -> lower + btrim
 *   2. type      'New Results' / 'new results'                    -> lower + btrim
 *   3. server    'bioRxiv' (bio host) / 'biorxiv' (med host)      -> lower
 * plus author-name parsing (v1 raw names vs v2+ 'Last, I.') via lib/names.mjs.
 */
import fs from "node:fs";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { normalizeAuthors } from "./lib/names.mjs";

const CHUNK = Number(process.env.CHUNK ?? 50_000);
// Line window, so staging can overlap a still-running walk: stage what has landed
// so far, then stage the remainder later. The sql/04 upsert is latest-version-wins
// and idempotent, so a window that overlaps a previous one is harmless.
const FROM_LINE = Number(process.env.FROM_LINE ?? 1);
const TO_LINE = Number(process.env.TO_LINE ?? Infinity);
const TMP = "data/rxiv/_chunk.csv";
const EXPECT = "ep-orange-water-aut2eymf";

const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const URL_UNPOOLED = env.DATABASE_URL_UNPOOLED;
if (!new global.URL(URL_UNPOOLED).host.startsWith(EXPECT)) {
  console.error(`FENCE FAIL: ${new global.URL(URL_UNPOOLED).host} is not ${EXPECT} — refusing to write.`);
  process.exit(1);
}

const csv = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function psql(args) {
  const r = spawnSync("psql", [URL_UNPOOLED, "-v", "ON_ERROR_STOP=1", ...args], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); throw new Error("psql failed"); }
  return r.stdout;
}

const COLS = "doi,title,authors,author_corresponding,author_corresponding_institution,date,version,type,license,category,jatsxml,abstract,published,server,funder";

async function loadDetails(file) {
  console.log(`\n=== ${file} ===`);
  const t0 = Date.now();
  let rows = 0, chunks = 0, buf = [], skipped = 0;
  const flush = () => {
    if (!buf.length) return;
    fs.writeFileSync(TMP, buf.join("\n") + "\n");
    psql(["-c", `\\copy stage_preprints (${COLS}) FROM '${TMP}' WITH (FORMAT csv)`]);
    chunks++;
    process.stdout.write(`  chunk ${chunks}: ${rows} rows staged (${((Date.now() - t0) / 1000).toFixed(0)}s)\r`);
    buf = [];
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (lineNo < FROM_LINE) continue;
    if (lineNo > TO_LINE) break;
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { skipped++; continue; }
    if (!r.doi || !r.date || !r.version) { skipped++; continue; }
    buf.push([
      r.doi,
      r.title,
      normalizeAuthors(r.authors).display,                 // trap 4: name formats
      r.author_corresponding,
      r.author_corresponding_institution,
      r.date,
      r.version,
      (r.type ?? "").trim().toLowerCase() || null,         // trap 2
      (r.license ?? "").trim().toLowerCase() || null,
      (r.category ?? "").replace(/\s+/g, " ").trim().toLowerCase() || null, // trap 1
      r.jatsxml,
      r.abstract,
      r.published,
      String(r.server ?? "").trim().toLowerCase(),         // trap 3
      Array.isArray(r.funder) ? JSON.stringify(r.funder) : null,
    ].map(csv).join(","));
    rows++;
    if (buf.length >= CHUNK) flush();
  }
  flush();
  fs.rmSync(TMP, { force: true });
  console.log(`\n  staged ${rows} rows (lines ${FROM_LINE}..${Math.min(lineNo, TO_LINE)}) in ${chunks} chunks, ${skipped} skipped, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return rows;
}

async function loadPubs(file) {
  console.log(`\n=== ${file} ===`);
  let rows = 0, buf = [], chunks = 0;
  const flush = () => {
    if (!buf.length) return;
    fs.writeFileSync(TMP, buf.join("\n") + "\n");
    psql(["-c", `\\copy stage_pubs (preprint_doi,published_doi,published_journal,published_date) FROM '${TMP}' WITH (FORMAT csv)`]);
    chunks++; buf = [];
  };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const pre = r.preprint_doi ?? r.biorxiv_doi;
    if (!pre) continue;
    buf.push([pre, r.published_doi, r.published_journal, r.published_date].map(csv).join(","));
    rows++;
    if (buf.length >= CHUNK) flush();
  }
  flush();
  fs.rmSync(TMP, { force: true });
  console.log(`  staged ${rows} pubs rows in ${chunks} chunks`);
  return rows;
}

// Optional explicit file list: `load-rxiv.mjs details data/rxiv/details-biorxiv.ndjson`
// stages just that file. The upsert in sql/04 is latest-version-wins and keyed on
// key_number, so staging one server at a time is safe and skips re-uploading rows
// already in `preprints` — which matters when a full re-stage is 1.4 GB over the wire.
const which = process.argv[2] ?? "all";
const explicit = process.argv.slice(3).filter((a) => a.endsWith(".ndjson"));

if (which === "details" || which === "all") {
  psql(["-c", "TRUNCATE stage_preprints"]);
  const files = explicit.length ? explicit : ["data/rxiv/details-medrxiv.ndjson", "data/rxiv/details-biorxiv.ndjson"];
  for (const f of files) if (fs.existsSync(f)) await loadDetails(f);
}
if (which === "pubs" || which === "all") {
  psql(["-c", "TRUNCATE stage_pubs"]);
  const files = explicit.length ? explicit : ["data/rxiv/pubs-biorxiv.ndjson", "data/rxiv/pubs-medrxiv.ndjson"];
  for (const f of files) if (fs.existsSync(f)) await loadPubs(f);
}
console.log("\nstaged. next: sql/04-upsert.sql");
