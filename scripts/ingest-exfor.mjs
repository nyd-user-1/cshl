// Rebuild the EXFOR layer in Neon from the IAEA-NDS/exfor_json clone.
//
//   git clone --depth 1 https://github.com/IAEA-NDS/exfor_json data/exfor_json
//   node --env-file=.env.local scripts/ingest-exfor.mjs
//
// Owns two tables outright — DROP + CREATE + full reload, never incremental:
//   exfor_entries  one row per EXFOR accession (the whole library, ~27k entries)
//   nsr_exfor      (key_number, exfor_id) pairs derived from nsr.exfor_keys
// `nsr` itself is read-only here.
//
// Phases (all run by default; skip with --skip=ddl,entries,links,index):
//   ddl      apply the BEGIN..COMMIT block of sql/17-exfor-entries.sql
//   entries  parse every json/*/*.json and COPY into exfor_entries
//   links    split nsr.exfor_keys on '; ' and COPY pairs into nsr_exfor
//   index    apply the commented index block at the foot of sql/17, then verify

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const JSON_DIR = "data/exfor_json/json";
const DDL_FILE = "sql/17-exfor-entries.sql";
const CHUNK_ROWS = 1000;          // ≤10k per the lane brief; raw jsonb is heavy
const CHUNK_BYTES = 24 * 1024 * 1024;
const CONCURRENCY = 3;            // overlapping COPY streams; Neon is the bottleneck, not us
const RETRIES = 3;

const skip = new Set(
  (process.argv.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean),
);
// Rehearsal knob: stop the entries phase after N files (Neon bulk-load law —
// rehearse ~1% before committing to the full 2 GB pass).
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? Infinity);

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? "");
const PG_ENV = {
  ...process.env,
  PGHOST: url.hostname, PGPORT: url.port || "5432",
  PGDATABASE: url.pathname.slice(1),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: "require",
};

function psql(stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], { env: PG_ENV });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`psql exit ${c}: ${err.slice(0, 1500)}`))));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = String(v).replace(/\u{0}/gu, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

async function psqlRetry(sql, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await psql(sql);
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`${label} failed after ${RETRIES}: ${e.message}`);
      console.error(`  ${label} attempt ${attempt} failed: ${e.message.slice(0, 200)} — retrying`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// COPY buffered rows into `table` in chunks bounded by both row count and bytes,
// keeping up to CONCURRENCY streams in flight — Neon, not this process, is the
// bottleneck (psql sits at <1% CPU while a chunk is being ingested).
function makeLoader(table, columns) {
  let rows = [], bytes = 0, total = 0, failure = null;
  const inFlight = new Set();

  const flush = async () => {
    if (failure) throw failure;
    if (!rows.length) return;
    const body = rows.join("\n");
    const n = rows.length;
    rows = []; bytes = 0;
    // Errors are captured rather than left to reject an unawaited promise, then
    // rethrown from the next flush — loud, but never an unhandled rejection.
    const p = psqlRetry(
      `COPY ${table} ${columns} FROM STDIN WITH (FORMAT csv);\n${body}\n\\.\n`,
      `COPY ${table} (${n} rows)`,
    ).then(
      () => { total += n; console.log(`  ${table}: ${total} rows loaded`); },
      (e) => { failure ??= e; },
    ).finally(() => inFlight.delete(p));
    inFlight.add(p);
    // Backpressure: never hold more than CONCURRENCY chunks of payload in memory.
    if (inFlight.size >= CONCURRENCY) await Promise.race(inFlight);
  };

  return {
    async push(row) {
      rows.push(row);
      bytes += row.length;
      if (rows.length >= CHUNK_ROWS || bytes >= CHUNK_BYTES) await flush();
    },
    async flush() {
      await flush();
      await Promise.all(inFlight);
      if (failure) throw failure;
    },
    get total() { return total; },
  };
}

// ---------------------------------------------------------------- DDL

const ddlText = fs.readFileSync(DDL_FILE, "utf8");
const MARKER = "-- INDEXES";
const markerAt = ddlText.indexOf(MARKER);
if (markerAt < 0) throw new Error(`${DDL_FILE}: missing '${MARKER}' marker`);
const createBlock = ddlText.slice(0, markerAt);
const indexBlock = ddlText
  .slice(markerAt)
  .split("\n")
  .map((l) => l.replace(/^--\s*(?=(CREATE|ANALYZE)\b)/, ""))
  .filter((l) => /^(CREATE|ANALYZE)\b/.test(l))
  .join("\n");
if (!indexBlock) throw new Error(`${DDL_FILE}: no index statements under the marker`);

if (!skip.has("ddl")) {
  console.log("P1/DDL: creating exfor_entries + nsr_exfor");
  await psqlRetry(createBlock, "ddl");
}

// ---------------------------------------------------------------- entries

// EXFOR x4 codes arrive parenthesised, e.g. "(2GRCTUA)" / "( 2SPNPCM)".
// Strip the outer parens and outer whitespace only — interior spaces are
// significant padding inside institute codes ("2FR FR").
const x4 = (s) => (typeof s === "string" ? s.trim().replace(/^\((.*)\)$/s, "$1").trim() : null);

function derive(j, fallbackId) {
  const bib = j?.bib_record ?? {};

  const authors = (Array.isArray(bib.authors) ? bib.authors : [])
    .map((a) => (typeof a === "string" ? a : a?.name))
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim())
    .join("; ") || null;

  const institutes = [...new Set(
    (Array.isArray(bib.institutes) ? bib.institutes : [])
      .map((i) => x4(i?.x4_code)).filter(Boolean),
  )];

  // Primary reference first; take the earliest parseable publication year on it.
  let year = null;
  for (const r of Array.isArray(bib.references) ? bib.references : []) {
    const y = parseInt(r?.publication_year, 10);
    if (Number.isFinite(y) && y > 1800 && y < 2200) { year = y; break; }
  }

  // REACTION codes live per subentry, keyed by pointer; children carry the
  // decomposed target/process for compound codes but the x4_code is the
  // canonical string, so collect those.
  const reactions = new Set();
  const rx = j?.reactions;
  if (rx && typeof rx === "object") {
    for (const sub of Object.values(rx)) {
      if (!sub || typeof sub !== "object") continue;
      for (const r of Object.values(sub)) {
        if (!r || typeof r !== "object") continue;
        const code = x4(r.x4_code);
        if (code) reactions.add(code);
      }
    }
  }

  const subs = new Set();
  for (const key of ["reactions", "data_tables", "experimental_conditions"]) {
    const o = j?.[key];
    if (o && typeof o === "object") for (const k of Object.keys(o)) subs.add(k);
  }

  const id = typeof j?.entry === "string" && j.entry.trim() ? j.entry.trim() : fallbackId;

  return {
    exfor_id: id,
    title: typeof bib.title === "string" && bib.title.trim() ? bib.title.trim() : null,
    year,
    authors,
    institutes: institutes.length ? JSON.stringify(institutes) : null,
    reactions: reactions.size ? JSON.stringify([...reactions].sort()) : null,
    num_subentries: subs.size,
  };
}

const stats = {
  files: 0, loaded: 0, parseErrors: [], idMismatch: [], dupes: [],
  bytesRaw: 0, bytesNoTables: 0, bytesSent: 0,
};

if (!skip.has("entries")) {
  console.log("P2: parsing entries");
  const t0 = Date.now();
  const seen = new Set();
  const loader = makeLoader(
    "exfor_entries",
    "(exfor_id, title, year, authors, institutes, reactions, num_subentries, raw)",
  );

  outer:
  for (const sub of fs.readdirSync(JSON_DIR).sort()) {
    const subdir = path.join(JSON_DIR, sub);
    if (!fs.statSync(subdir).isDirectory()) continue;
    for (const file of fs.readdirSync(subdir).sort()) {
      if (!file.endsWith(".json")) continue;
      if (stats.files >= LIMIT) break outer;
      stats.files++;
      const full = path.join(subdir, file);
      const fallbackId = file.slice(0, -5);

      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch (e) {
        stats.parseErrors.push(`${fallbackId}: read ${e.message}`);
        continue;
      }

      let j;
      try {
        j = JSON.parse(text);
      } catch (e) {
        stats.parseErrors.push(`${fallbackId}: ${e.message.slice(0, 80)}`);
        continue;
      }

      const d = derive(j, fallbackId);
      if (d.exfor_id !== fallbackId) stats.idMismatch.push(`${fallbackId} -> ${d.exfor_id}`);
      if (seen.has(d.exfor_id)) { stats.dupes.push(d.exfor_id); continue; }
      seen.add(d.exfor_id);

      // Size accounting so the lead can judge whether raw should keep data_tables.
      stats.bytesRaw += Buffer.byteLength(text);
      const { data_tables: _dt, ...noTables } = j;
      stats.bytesNoTables += Buffer.byteLength(JSON.stringify(noTables));
      text = null;

      // Re-serialise compact. The files are pretty-printed at 2-space indent and
      // jsonb discards insignificant whitespace, so the stored value is identical
      // either way — but this is ~2.5x fewer bytes to push over the wire and to
      // parse server-side, which is essentially the whole cost of this phase.
      //
      // LEAD RULING (2026-08-16): raw EXCLUDES data_tables. The numeric grids are
      // 90% of the bytes, invisible to search/embeddings, and reproducible from
      // the IAEA clone in one command; when cross-section plotting becomes a
      // feature they get ingested as structured columns, not jsonb ballast.
      const compact = JSON.stringify(noTables);
      j = null;
      stats.bytesSent += Buffer.byteLength(compact);

      // jsonb rejects the \u0000 escape; strip it (guarded, 2 GB of text here).
      let raw = compact;
      if (raw.includes("u0000")) raw = raw.replace(/\\u0000/g, "");

      await loader.push(csvRow([
        d.exfor_id, d.title, d.year, d.authors,
        d.institutes, d.reactions, d.num_subentries, raw,
      ]));

      if (stats.files % 2000 === 0) console.log(`  scanned ${stats.files} files`);
    }
  }
  await loader.flush();
  stats.loaded = loader.total;
  console.log(`P2 done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${stats.loaded} loaded / ${stats.files} files`);
  console.log(`  source text ${(stats.bytesRaw / 1e9).toFixed(2)} GB; sent compact ${(stats.bytesSent / 1e9).toFixed(2)} GB; without data_tables ${(stats.bytesNoTables / 1e6).toFixed(0)} MB`);
  if (stats.parseErrors.length) console.log(`  parse errors: ${stats.parseErrors.length} — ${stats.parseErrors.slice(0, 10).join(" | ")}`);
  if (stats.idMismatch.length) console.log(`  id != filename: ${stats.idMismatch.length} — ${stats.idMismatch.slice(0, 10).join(" | ")}`);
  if (stats.dupes.length) console.log(`  duplicate ids skipped: ${stats.dupes.length} — ${stats.dupes.slice(0, 10).join(" | ")}`);
}

// ---------------------------------------------------------------- links

if (!skip.has("links")) {
  console.log("P3: building nsr_exfor");
  const csv = await psqlRetry(
    "COPY (SELECT key_number, exfor_keys FROM nsr WHERE exfor_keys IS NOT NULL) TO STDOUT WITH (FORMAT csv);",
    "read nsr.exfor_keys",
  );
  const loader = makeLoader("nsr_exfor", "(key_number, exfor_id)");
  let nsrRows = 0, pairs = 0, blank = 0;
  const nsrKeys = new Set(), exforIds = new Set();

  for (const line of csv.split("\n")) {
    if (!line.trim()) continue;
    nsrRows++;
    const comma = line.indexOf(",");
    const unq = (s) => s.replace(/^"(.*)"$/s, "$1").replaceAll('""', '"').trim();
    const key = unq(line.slice(0, comma));
    const keysField = unq(line.slice(comma + 1));
    const seenHere = new Set();
    for (const tok of keysField.split(";")) {
      // Accession numbers are 5 chars; nothing in this column carries a
      // subentry suffix (probed), but trim + upper defensively anyway.
      const id = tok.trim().toUpperCase();
      if (!id) { blank++; continue; }
      if (seenHere.has(id)) continue;
      seenHere.add(id);
      nsrKeys.add(key); exforIds.add(id);
      pairs++;
      await loader.push(csvRow([key, id]));
    }
  }
  await loader.flush();
  console.log(`P3 done: ${nsrRows} nsr rows -> ${pairs} pairs, ${nsrKeys.size} distinct nsr keys, ${exforIds.size} distinct exfor ids, ${blank} blank tokens`);
}

// ---------------------------------------------------------------- indexes + verify

if (!skip.has("index")) {
  console.log("P4: indexes + verify");
  await psqlRetry(indexBlock, "indexes");
  const out = await psqlRetry(`SELECT (SELECT count(*) FROM exfor_entries) AS entries,
       (SELECT count(*) FROM nsr_exfor) AS links,
       (SELECT count(DISTINCT key_number) FROM nsr_exfor) AS nsr_with_exfor,
       (SELECT count(*) FROM nsr_exfor x LEFT JOIN exfor_entries e USING (exfor_id) WHERE e.exfor_id IS NULL) AS orphan_links;`, "verify");
  console.log(out.trim());
}

console.log("done");
