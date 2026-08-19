// Load the full NNDC NSR dump (data/nsr/) into Neon.
//
//   node --env-file=.env.local scripts/load-nsr-dump.mjs --rehearse   # 1857-1949 only (~2.5k entries)
//   node --env-file=.env.local scripts/load-nsr-dump.mjs              # everything
//   node --env-file=.env.local scripts/load-nsr-dump.mjs --phase=verify
//
// Design follows the leuk/44b bulk-load laws (see memory: neon-bulk-load-laws):
//  - UNPOOLED host, creds decomposed into PG* env vars (never argv, never ps-visible)
//  - every chunk is one psql invocation = one transaction = the retry unit,
//    so Neon's ~5-min per-statement ceiling is never in play
//  - entries upsert through a TEMP stage (LIKE-free explicit DDL, ON COMMIT DROP)
//    and ON CONFLICT touches ONLY NSR-source columns — embedding and every s2_*
//    enrichment column are structurally untouchable
//  - join tables are TRUNCATE + plain COPY (full replacement, idempotent)
//  - array columns (nuclides/reactions/z_values/subjects/topics) are DERIVED
//    server-side from the join tables — no pg-array-literal CSV, no regex
//  - secondary indexes on nsr are dropped up front and recreated by
//    sql/14-full-corpus-indexes.sql after the load

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DUMP = path.join(ROOT, "data", "nsr");
const REHEARSE = process.argv.includes("--rehearse");
const PHASE = (process.argv.find((a) => a.startsWith("--phase=")) ?? "--phase=all").slice(8);
const CUTOFF = 1949; // rehearsal loads publication years <= this

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "");
if (!url.hostname || url.hostname.includes("-pooler")) {
  console.error("DATABASE_URL_UNPOOLED must be set and must be the UNPOOLED host");
  process.exit(1);
}
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

/** Run one psql session; script + inline COPY data arrive on stdin. */
function psql(stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], {
      env: PG_ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`psql exit ${code}: ${err.slice(0, 2000)}`)),
    );
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

async function psqlRetry(stdinText, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await psql(stdinText);
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error(`  ${label}: attempt ${attempt} failed (${e.message.slice(0, 200)}); retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// CSV discipline: SQL NULL = unquoted empty; empty string = quoted "".
// Text is flattened to one line so a row can never straddle a line boundary
// (and inline COPY's terminating \. can never be shadowed).
function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (fields) => fields.map(csvField).join(",");
const jsonField = (v) =>
  v === null || v === undefined ? null : JSON.stringify(v).replaceAll("\\u0000", "");

function* jsonlRows(file) {
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (line.trim()) yield JSON.parse(line);
  }
}

const inRehearsal = (keyNumber) => Number(String(keyNumber).slice(0, 4)) <= CUTOFF;

async function copyChunk({ label, ddlAndCopy, rows, epilogue }) {
  const t0 = Date.now();
  const body = rows.join("\n");
  await psqlRetry(`${ddlAndCopy}\n${body}\n\\.\n${epilogue}`, label);
  const secs = (Date.now() - t0) / 1000;
  console.log(`  ${label}: ${rows.length.toLocaleString()} rows in ${secs.toFixed(1)}s (${Math.round(rows.length / secs).toLocaleString()}/s)`);
}

/* ── Phase: dictionaries ──────────────────────────────────────────────────── */

async function loadDicts() {
  console.log("phase: dictionaries");
  const jobs = [
    ["journals", "dictionaries/journal-entries.jsonl", "(journal_code, title, min_year, max_year)",
      (r) => [r.journalCode, r.title, r.minYear, r.maxYear]],
    ["nuclide_dict", "dictionaries/nuclide-entries.jsonl", "(nuclide_code, z, n, a, element)",
      (r) => [r.nuclideCode, r.z, r.n, r.a, r.element]],
    ["particle_dict", "dictionaries/particle-entries.jsonl", "(particle_code, z, a)",
      (r) => [r.particleCode, r.z, r.a]],
    ["subject_dict", "dictionaries/subject-entries.jsonl", "(subject_code, description)",
      (r) => [r.subjectCode, r.description]],
    ["authors", "dictionaries/single-author-names.jsonl", "(author_key, initial1, initial2, last_name)",
      (r) => [r.authorKey, r.initial1, r.initial2, r.lastName]],
    ["author_aliases", "dictionaries/single-author-aliases.jsonl", "(initial1, initial2, last_name, author_key)",
      (r) => [r.initial1, r.initial2, r.lastName, r.authorKey]],
    ["reaction_dict", "radioactivity/reactions.jsonl",
      "(reaction_code, incident_particle, outgoing_particles, is_alpha_transfer, is_fission, is_polarized, is_two_nucleon_transfer, is_charge_exchange, is_determinable, delta_z, delta_n, delta_a)",
      (r) => [r.reactionCode, r.incidentParticle, jsonField(r.outgoingParticles), r.isAlphaTransfer, r.isFission, r.isPolarized, r.isTwoNucleonTransfer, r.isChargeExchange, r.isDeterminable, r.deltaZ, r.deltaN, r.deltaA]],
    ["reaction_display", "radioactivity/reaction-aliases.jsonl", "(reaction_code, exchange_codes, latex_codes)",
      (r) => [r.reactionCode, jsonField(r.exchangeCodes), jsonField(r.latexCodes)]],
    ["decay_processes", "radioactivity/decay-processes.jsonl", "(subject_code, delta_z, delta_n, delta_a, latex_code)",
      (r) => [r.subjectCode, r.deltaZ, r.deltaN, r.deltaA, r.latexCode]],
  ];
  for (const [table, file, cols, map] of jobs) {
    const seen = new Set();
    const rows = [];
    for (const r of jsonlRows(path.join(DUMP, file))) {
      const mapped = map(r);
      // dictionaries with a PK: first occurrence wins
      const pk = String(mapped[0]);
      if (["journals", "nuclide_dict", "particle_dict", "subject_dict", "authors", "reaction_dict", "reaction_display", "decay_processes"].includes(table)) {
        if (seen.has(pk)) continue;
        seen.add(pk);
      }
      rows.push(csvRow(mapped));
    }
    await copyChunk({
      label: table,
      ddlAndCopy: `BEGIN;\nTRUNCATE ${table};\nCOPY ${table} ${cols} FROM STDIN WITH (FORMAT csv);`,
      rows,
      epilogue: "COMMIT;",
    });
  }
  // collaborations: names + aliases share one table, flagged
  const collab = [];
  for (const r of jsonlRows(path.join(DUMP, "dictionaries/collaboration-names.jsonl"))) {
    collab.push(csvRow([r.collaborationName, r.authorKey, false]));
  }
  for (const r of jsonlRows(path.join(DUMP, "dictionaries/collaboration-aliases.jsonl"))) {
    collab.push(csvRow([r.collaborationName, r.authorKey, true]));
  }
  await copyChunk({
    label: "collaboration_names",
    ddlAndCopy: `BEGIN;\nTRUNCATE collaboration_names;\nCOPY collaboration_names (collaboration_name, author_key, is_alias) FROM STDIN WITH (FORMAT csv);`,
    rows: collab,
    epilogue: "COMMIT;",
  });
}

/* ── Phase: entries → nsr upsert ──────────────────────────────────────────── */

const STAGE_DDL = `CREATE TEMP TABLE stage_nsr (
  key_number text, pub_year int, reference text, authors text, title text, doi text,
  exfor_keys text, reference_type text, journal_code text, index_information text,
  coden_text text, entry_date date, modification_date date, is_primary boolean,
  pdf_available boolean, xundl_available boolean, collaborations jsonb,
  authors_json jsonb, sentence_groups jsonb, raw jsonb
) ON COMMIT DROP;`;

// ONLY NSR-source columns. embedding / s2_* / abstract / keywords are not named
// anywhere in this statement and therefore cannot be clobbered.
const UPSERT_SQL = `INSERT INTO nsr (key_number, pub_year, reference, authors, title, doi, exfor_keys,
  reference_type, journal_code, index_information, coden_text, entry_date, modification_date,
  is_primary, pdf_available, xundl_available, collaborations, authors_json, sentence_groups, raw)
SELECT DISTINCT ON (key_number) key_number, pub_year, reference, authors, title, doi, exfor_keys,
  reference_type, journal_code, index_information, coden_text, entry_date, modification_date,
  is_primary, pdf_available, xundl_available, collaborations, authors_json, sentence_groups, raw
FROM stage_nsr
ORDER BY key_number
ON CONFLICT (key_number) DO UPDATE SET
  pub_year = EXCLUDED.pub_year, reference = EXCLUDED.reference, authors = EXCLUDED.authors,
  title = EXCLUDED.title, doi = EXCLUDED.doi, exfor_keys = EXCLUDED.exfor_keys,
  reference_type = EXCLUDED.reference_type, journal_code = EXCLUDED.journal_code,
  index_information = EXCLUDED.index_information, coden_text = EXCLUDED.coden_text,
  entry_date = EXCLUDED.entry_date, modification_date = EXCLUDED.modification_date,
  is_primary = EXCLUDED.is_primary, pdf_available = EXCLUDED.pdf_available,
  xundl_available = EXCLUDED.xundl_available, collaborations = EXCLUDED.collaborations,
  authors_json = EXCLUDED.authors_json, sentence_groups = EXCLUDED.sentence_groups,
  raw = EXCLUDED.raw;`;

function flattenAuthors(authors) {
  if (!authors?.length) return null;
  return authors
    .map((a) => (a.initials?.length ? a.initials.join(".") + "." : "") + (a.lastName ?? ""))
    .join("; ") || null;
}

function entryToRow(r) {
  return csvRow([
    r.keyNumber,
    r.publicationYear,
    r.referenceText,
    flattenAuthors(r.authors),
    r.title || null,
    r.doi || null,
    r.exforKeys?.length ? r.exforKeys.join("; ") : null,
    r.referenceType || null,
    r.journalCode || null,
    r.indexInformation || null,
    r.codenText || null,
    r.entryDate || null,
    r.modificationDate || null,
    r.isPrimary ?? null,
    r.pdfAvailable ?? null,
    r.xundlAvailable ?? null,
    r.collaborations?.length ? jsonField(r.collaborations) : null,
    r.authors?.length ? jsonField(r.authors) : null,
    r.sentenceGroups?.length ? jsonField(r.sentenceGroups) : null,
    jsonField(r),
  ]);
}

async function loadEntries() {
  console.log(`phase: entries${REHEARSE ? " (rehearsal <= " + CUTOFF + ")" : ""}`);
  if (!REHEARSE) {
    // secondary indexes off during the big merge; sql/14 recreates them
    await psqlRetry(
      `DROP INDEX IF EXISTS idx_nsr_nuclides; DROP INDEX IF EXISTS idx_nsr_reactions;
       DROP INDEX IF EXISTS idx_nsr_z_values; DROP INDEX IF EXISTS idx_nsr_pub_year;`,
      "drop-secondary-indexes",
    );
  }
  const entriesDir = path.join(DUMP, "entries");
  const yearDirs = readdirSync(entriesDir)
    .filter((d) => /^\d{4}$/.test(d) && (!REHEARSE || Number(d) <= CUTOFF))
    .sort();

  const CHUNK = 10_000;
  let buf = [], total = 0, skipped = 0, chunkNo = 0;
  const flush = async () => {
    if (!buf.length) return;
    chunkNo++;
    const rows = buf;
    buf = [];
    await copyChunk({
      label: `entries chunk ${chunkNo}`,
      ddlAndCopy: `BEGIN;\n${STAGE_DDL}\nCOPY stage_nsr FROM STDIN WITH (FORMAT csv);`,
      rows,
      epilogue: `${UPSERT_SQL}\nCOMMIT;`,
    });
    total += rows.length;
  };

  for (const yd of yearDirs) {
    const dir = path.join(entriesDir, yd);
    for (const fn of readdirSync(dir)) {
      if (!fn.endsWith(".json")) continue;
      const r = JSON.parse(readFileSync(path.join(dir, fn), "utf8"));
      if (!r.keyNumber || !r.publicationYear) { skipped++; continue; }
      if (REHEARSE && r.publicationYear > CUTOFF) { skipped++; continue; }
      buf.push(entryToRow(r));
      if (buf.length >= CHUNK) await flush();
    }
  }
  await flush();
  console.log(`entries done: ${total.toLocaleString()} upserted, ${skipped} skipped (no key/pub_year)`);
}

/* ── Phase: keywords from text-table ──────────────────────────────────────── */

async function loadKeywords() {
  console.log("phase: keywords (text-table)");
  const CHUNK = 50_000;
  let buf = [], chunkNo = 0;
  const flush = async () => {
    if (!buf.length) return;
    chunkNo++;
    const rows = buf;
    buf = [];
    await copyChunk({
      label: `keywords chunk ${chunkNo}`,
      ddlAndCopy: `BEGIN;\nCREATE TEMP TABLE stage_kw (key_number text, title_text text, keyword_text text) ON COMMIT DROP;\nCOPY stage_kw FROM STDIN WITH (FORMAT csv);`,
      rows,
      epilogue: `UPDATE nsr SET keywords = NULLIF(stage_kw.keyword_text, '')
FROM stage_kw WHERE nsr.key_number = stage_kw.key_number;\nCOMMIT;`,
    });
  };
  const rl = createInterface({ input: createReadStream(path.join(DUMP, "tables/text-table.jsonl")) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (REHEARSE && !inRehearsal(r.keyNumber)) continue;
    buf.push(csvRow([r.keyNumber, r.titleText || null, r.keywordText ?? ""]));
    if (buf.length >= CHUNK) await flush();
  }
  await flush();
}

/* ── Phase: join tables ───────────────────────────────────────────────────── */

async function loadJoins() {
  console.log(`phase: join tables${REHEARSE ? " (rehearsal slice)" : ""}`);
  const jobs = [
    ["nsr_authors", "tables/author-table.jsonl", "(key_number, author_key, order_index)",
      (r) => [r.keyNumber, r.authorKey, r.orderIndex]],
    ["nsr_nuclides", "tables/nuclide-table.jsonl", "(key_number, z, n, a, element_symbol, element_name, sub_type, selector_flag, selector_index)",
      (r) => [r.keyNumber, r.z, r.n, r.a, r.elementSymbol, r.elementName, r.nuclideSubType, r.selectorFlag, r.selectorIndex]],
    ["nsr_reactions", "tables/reaction-table.jsonl", "(key_number, reaction_code, selector_flag, selector_index)",
      (r) => [r.keyNumber, r.reactionCode, r.selectorFlag, r.selectorIndex]],
    ["nsr_subjects", "tables/subject-table.jsonl", "(key_number, subject_code, sub_type, selector_flag, selector_index)",
      (r) => [r.keyNumber, r.subjectCode, r.subjectSubType, r.selectorFlag, r.selectorIndex]],
    ["nsr_topics", "tables/topic-table.jsonl", "(key_number, topic)",
      (r) => [r.keyNumber, r.topic]],
    ["nsr_mass_ranges", "tables/atomic-mass-table.jsonl", "(key_number, minimum, maximum, selector_flag, selector_index)",
      (r) => [r.keyNumber, r.minimum, r.maximum, r.selectorFlag, r.selectorIndex]],
    ["nsr_z_ranges", "tables/atomic-number-table.jsonl", "(key_number, minimum, maximum, selector_flag, selector_index)",
      (r) => [r.keyNumber, r.minimum, r.maximum, r.selectorFlag, r.selectorIndex]],
  ];
  const CHUNK = 250_000;
  for (const [table, file, cols, map] of jobs) {
    let buf = [], first = true, chunkNo = 0, total = 0;
    const flush = async () => {
      if (!buf.length && !first) return;
      chunkNo++;
      const rows = buf;
      buf = [];
      const truncate = first ? `TRUNCATE ${table};\n` : "";
      first = false;
      await copyChunk({
        label: `${table} chunk ${chunkNo}`,
        ddlAndCopy: `BEGIN;\n${truncate}COPY ${table} ${cols} FROM STDIN WITH (FORMAT csv);`,
        rows,
        epilogue: "COMMIT;",
      });
      total += rows.length;
    };
    const rl = createInterface({ input: createReadStream(path.join(DUMP, file)) });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (REHEARSE && !inRehearsal(r.keyNumber)) continue;
      buf.push(csvRow(map(r)));
      if (buf.length >= CHUNK) await flush();
    }
    await flush();
    console.log(`  ${table} total: ${total.toLocaleString()}`);
  }
}

/* ── Phase: derived arrays on nsr ─────────────────────────────────────────── */

async function derive() {
  console.log("phase: derive arrays (server-side, from join tables)");
  const t0 = Date.now();
  await psqlRetry(
    `BEGIN;
-- real selector data replaces the old regex-derived arrays
UPDATE nsr n SET nuclides = s.nuclides, z_values = s.z_values
FROM (
  SELECT key_number,
         array_agg(DISTINCT CASE WHEN a IS NULL OR a = 0 THEN element_symbol ELSE a::text || element_symbol END) AS nuclides,
         array_agg(DISTINCT z) FILTER (WHERE z IS NOT NULL) AS z_values
  FROM nsr_nuclides GROUP BY key_number
) s WHERE n.key_number = s.key_number;

UPDATE nsr n SET nuclides = NULL, z_values = NULL
WHERE (n.nuclides IS NOT NULL OR n.z_values IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM nsr_nuclides j WHERE j.key_number = n.key_number);

UPDATE nsr n SET reactions = s.arr
FROM (SELECT key_number, array_agg(DISTINCT reaction_code) AS arr FROM nsr_reactions GROUP BY key_number) s
WHERE n.key_number = s.key_number;

UPDATE nsr n SET reactions = NULL
WHERE n.reactions IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM nsr_reactions j WHERE j.key_number = n.key_number);

UPDATE nsr n SET subjects = s.arr
FROM (SELECT key_number, array_agg(DISTINCT subject_code) AS arr FROM nsr_subjects GROUP BY key_number) s
WHERE n.key_number = s.key_number;

UPDATE nsr n SET topics = s.arr
FROM (SELECT key_number, array_agg(DISTINCT topic) AS arr FROM nsr_topics GROUP BY key_number) s
WHERE n.key_number = s.key_number;
COMMIT;`,
    "derive-arrays",
  );
  console.log(`  derive done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ── Phase: verify ────────────────────────────────────────────────────────── */

async function verify() {
  console.log("phase: verify");
  const out = await psqlRetry(
    `\\pset format unaligned
SELECT 'total', count(*) FROM nsr
UNION ALL SELECT 'embedded', count(embedding) FROM nsr
UNION ALL SELECT 'with_raw', count(raw) FROM nsr
UNION ALL SELECT 'with_title', count(title) FROM nsr
UNION ALL SELECT 'with_doi', count(doi) FROM nsr
UNION ALL SELECT 'pdf_available', count(*) FILTER (WHERE pdf_available) FROM nsr
UNION ALL SELECT 'with_keywords', count(keywords) FROM nsr
UNION ALL SELECT 'with_nuclides', count(nuclides) FROM nsr
UNION ALL SELECT 'is_primary', count(*) FILTER (WHERE is_primary) FROM nsr
UNION ALL SELECT 'min_year', min(pub_year) FROM nsr
UNION ALL SELECT 'max_year', max(pub_year) FROM nsr
UNION ALL SELECT 'nsr_authors', count(*) FROM nsr_authors
UNION ALL SELECT 'nsr_nuclides', count(*) FROM nsr_nuclides
UNION ALL SELECT 'nsr_reactions', count(*) FROM nsr_reactions
UNION ALL SELECT 'nsr_subjects', count(*) FROM nsr_subjects
UNION ALL SELECT 'nsr_topics', count(*) FROM nsr_topics
UNION ALL SELECT 'authors_dict', count(*) FROM authors
UNION ALL SELECT 'journals', count(*) FROM journals;`,
    "verify-counts",
  );
  console.log(out);

  {
    // per-year diff vs the dump inventory (rehearsal compares only <= CUTOFF)
    const inv = JSON.parse(readFileSync(path.join(ROOT, "data", "inventory.json"), "utf8"));
    const dbYears = await psqlRetry(
      `\\pset format unaligned\nSELECT pub_year || ':' || count(*) FROM nsr GROUP BY pub_year ORDER BY pub_year;`,
      "verify-years",
    );
    const db = Object.fromEntries(
      dbYears.trim().split("\n").filter((l) => l.includes(":")).map((l) => l.split(":").map(Number)),
    );
    let mismatches = 0;
    for (const [year, want] of Object.entries(inv.per_year)) {
      if (REHEARSE && Number(year) > CUTOFF) continue;
      const got = db[year] ?? 0;
      if (got !== want) {
        mismatches++;
        if (mismatches <= 15) console.log(`  year ${year}: db=${got} dump=${want}`);
      }
    }
    console.log(mismatches === 0 ? "  per-year counts MATCH the dump exactly" : `  ${mismatches} year(s) differ from the dump`);
  }

  const spot = await psqlRetry(
    `\\pset format unaligned
SELECT key_number, pub_year, reference_type, pdf_available, is_primary,
       (title IS NOT NULL) AS has_title, (raw IS NOT NULL) AS has_raw,
       coalesce(array_length(nuclides,1),0) AS n_nuclides
FROM nsr WHERE key_number IN ('1857DE01','1900BE01','2024BA01','2024AA07') ORDER BY key_number;`,
    "verify-spot",
  );
  console.log(spot);
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const t0 = Date.now();
const phases = { dicts: loadDicts, entries: loadEntries, keywords: loadKeywords, joins: loadJoins, derive, verify };
const order = PHASE === "all" ? ["dicts", "entries", "keywords", "joins", "derive", "verify"] : [PHASE];
for (const p of order) {
  if (!phases[p]) { console.error(`unknown phase: ${p}`); process.exit(1); }
  await phases[p]();
}
console.log(`\nall done in ${((Date.now() - t0) / 60000).toFixed(1)} min${REHEARSE ? " (REHEARSAL)" : ""}`);
