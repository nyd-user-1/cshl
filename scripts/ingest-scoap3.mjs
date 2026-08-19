// LANE-SCOAP3 — harvest the SCOAP³ repository (repo.scoap3.org) and attach its
// repo-hosted OA PDFs to rows we already have.
//
//   node --env-file=.env.local scripts/ingest-scoap3.mjs harvest
//   node --env-file=.env.local scripts/ingest-scoap3.mjs match
//   node --env-file=.env.local scripts/ingest-scoap3.mjs write     # after LANE-S2 P3
//   node --env-file=.env.local scripts/ingest-scoap3.mjs pdfs
//   node --env-file=.env.local scripts/ingest-scoap3.mjs report
//
// ENRICHMENT ONLY — this lane INSERTs nothing. PLB/NPB are 100% OA under SCOAP³
// but carry heavy particle-physics content that is not NSR corpus material, so
// we only touch DOIs the corpus already has.
//
// Columns written: abstract (only where NULL or a truncated '…' teaser),
// and coalesce-only pdf_url / pdf_stored / arxiv_id. Nothing else.

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

// ---------------------------------------------------------------- config

const API = "https://repo.scoap3.org/api/records/";
const PAGE_SIZE = 100;          // hard server cap (page_size, not size)
const API_GAP_MS = 300;         // ≤4 req/s on a CERN-run public target
const PDF_CONCURRENCY = 4;
const PDF_TIMEOUT_MS = 120_000;

// SCOAP³-funded journals that overlap the NSR corpus. PRC is the hep-tagged
// APS slice (~800 records), PLB/NPB are complete since 2014.
const JOURNALS = ["Physics Letters B", "Nuclear Physics B", "Physical Review C"];

const DATA_DIR = "data/scoap3";
const PDF_DIR = "data/pdfs/scoap3";
const MANIFEST = `${DATA_DIR}/manifest.json`;

// ---------------------------------------------------------------- psql helpers
// copied verbatim from scripts/ingest-aps-feeds.mjs

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
  let s = String(v).replace(/\u0000/g, "").replace(/[\r\n]+/g, " ");
  if (s === "") return '""';
  if (/[",]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}
const csvRow = (f) => f.map(csvField).join(",");

// retry a psql call ×3
async function psqlRetry(sql, label = "") {
  let last;
  for (let i = 1; i <= 3; i++) {
    try { return await psql(sql); } catch (e) {
      last = e;
      console.error(`  psql ${label} attempt ${i}/3 failed: ${e.message.slice(0, 300)}`);
      if (i < 3) await sleep(5000);
    }
  }
  throw last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- record shape

// SCOAP³ metadata quirks this handles:
//  - `dois[]` sometimes carries the arXiv id alongside the real DOI
//  - `arxiv_eprints[].value` is a LIST that repeats the DOI first
//  - Elsevier records (PLB/NPB) usually carry no arXiv id at all
//  - `_files[]` holds repo-hosted pdf + xml; the pdf is what we want
const ARXIV_RE = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)$/;

function parseRecord(hit) {
  const m = hit?.metadata ?? {};
  const doiVals = (m.dois ?? []).map((d) => d?.value).filter((v) => typeof v === "string");
  const doi = doiVals.find((v) => v.startsWith("10.")) ?? null;

  const arxivVals = [];
  for (const e of m.arxiv_eprints ?? []) {
    const v = e?.value;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string") arxivVals.push(x);
  }
  const arxiv = arxivVals.find((v) => ARXIV_RE.test(v)) ?? null;

  const abstract = (m.abstracts ?? [])
    .map((a) => (typeof a?.value === "string" ? a.value.trim() : ""))
    .find((v) => v.length > 0) ?? null;

  // some records carry the same PDF under two layouts (/media/files/<control_number>/…
  // and /media/harvested_files/<doi>/…) and one of the two can 403 — keep both
  const pdfAll = (m._files ?? []).filter((f) => f?.filetype === "pdf" && f?.file).map((f) => f.file);

  const pi = (m.publication_info ?? [])[0] ?? {};
  return {
    doi,
    arxiv,
    abstract,
    pdf: pdfAll[0] ?? null,
    pdfAll,
    journal: pi.journal_title ?? null,
    year: pi.year ?? null,
    control_number: m.control_number ?? null,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const pad = (n) => String(n).padStart(4, "0");
const sanitizeDoi = (d) => d.replace(/[^A-Za-z0-9._-]+/g, "_");

// ---------------------------------------------------------------- P1: harvest

async function harvest() {
  mkdirSync(DATA_DIR, { recursive: true });
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { pages: [] };
  const done = new Set(manifest.pages.map((p) => `${p.journal}#${p.page}`));
  let seq = manifest.pages.reduce((mx, p) => Math.max(mx, p.seq), 0);

  for (const journal of JOURNALS) {
    let page = 1, total = null, got = 0;
    for (;;) {
      const key = `${journal}#${page}`;
      if (done.has(key)) {
        const prev = manifest.pages.find((p) => p.journal === journal && p.page === page);
        got += prev.hits; total = prev.total;
        if (got >= total || prev.hits === 0) break;
        page++;
        continue;
      }
      const u = `${API}?journal=${encodeURIComponent(journal)}&page_size=${PAGE_SIZE}&page=${page}`;
      let body = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const res = await fetch(u, { headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          body = await res.json();
          break;
        } catch (e) {
          console.error(`  ${journal} p${page} attempt ${attempt}/4: ${e.message}`);
          if (attempt === 4) throw e;
          await sleep(5000 * attempt);
        }
      }
      total = body.count;
      const hits = body.hits?.hits ?? [];
      seq++;
      const file = `${DATA_DIR}/page-${pad(seq)}.json`;
      writeFileSync(file, JSON.stringify(body));
      manifest.pages.push({ seq, file, journal, page, hits: hits.length, total });
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
      got += hits.length;
      if (page % 10 === 1 || got >= total) console.log(`  ${journal}: ${got}/${total}`);
      if (hits.length === 0 || got >= total) break;
      page++;
      await sleep(API_GAP_MS);
    }
    console.log(`${journal}: harvested ${got} of ${total}`);
  }
  const bytes = manifest.pages.reduce((s, p) => s + statSync(p.file).size, 0);
  console.log(`pages: ${manifest.pages.length}, ${(bytes / 1e6).toFixed(0)} MB on disk`);
}

// ---------------------------------------------------------------- load parsed records

function loadRecords() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const byDoi = new Map();
  const perJournal = new Map();
  let hits = 0, noDoi = 0, noPdf = 0;
  for (const p of manifest.pages) {
    const body = JSON.parse(readFileSync(p.file, "utf8"));
    for (const h of body.hits?.hits ?? []) {
      hits++;
      const r = parseRecord(h);
      const j = r.journal ?? p.journal;
      perJournal.set(j, (perJournal.get(j) ?? 0) + 1);
      if (!r.doi) { noDoi++; continue; }
      if (!r.pdf) noPdf++;
      const k = r.doi.toLowerCase();
      if (!byDoi.has(k)) byDoi.set(k, r);
    }
  }
  return { byDoi, perJournal, hits, noDoi, noPdf };
}

// ---------------------------------------------------------------- P2: match

async function match() {
  const { byDoi, perJournal, hits, noDoi, noPdf } = loadRecords();
  console.log(`records parsed: ${hits} (unique DOIs ${byDoi.size}, no-DOI ${noDoi}, no-PDF ${noPdf})`);
  for (const [j, n] of [...perJournal].sort((a, b) => b[1] - a[1])) console.log(`  ${j}: ${n}`);

  const rows = [...byDoi.values()].map((r) => csvRow([r.doi, r.pdf, r.arxiv]));
  const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_scoap3_m (doi text, pdf_url text, arxiv_id text) ON COMMIT DROP;
COPY stage_scoap3_m FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
CREATE INDEX ON stage_scoap3_m (lower(doi));
ANALYZE stage_scoap3_m;
SELECT 'scoap3_records: ' || count(*) FROM stage_scoap3_m;
SELECT 'matched_nsr_rows: ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi);
SELECT 'matched_pdf_url_already: ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi) WHERE n.pdf_url IS NOT NULL;
SELECT 'matched_pdf_url_newly_attachable: ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi) WHERE n.pdf_url IS NULL AND s.pdf_url IS NOT NULL;
SELECT 'matched_arxiv_newly_attachable: ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi) WHERE n.arxiv_id IS NULL AND s.arxiv_id IS NOT NULL;
SELECT 'matched_abstract_fillable: ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi) WHERE (n.abstract IS NULL OR n.abstract LIKE '%…');
SELECT 'matched_by_journal: ' || n.journal_code || ' ' || count(*) FROM nsr n JOIN stage_scoap3_m s ON lower(n.doi) = lower(s.doi) GROUP BY n.journal_code ORDER BY count(*) DESC;
COMMIT;`, "match");
  console.log(out.trim());
}

// ---------------------------------------------------------------- P3: write back

const CHUNK = 20_000;

async function write() {
  const { byDoi } = loadRecords();
  const recs = [...byDoi.values()];
  console.log(`staging ${recs.length} records in chunks of ${CHUNK}`);
  const totals = {};
  for (let i = 0; i < recs.length; i += CHUNK) {
    const chunk = recs.slice(i, i + CHUNK);
    const rows = chunk.map((r) => csvRow([r.doi, r.pdf, r.arxiv, r.abstract]));
    const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_scoap3 (doi text, pdf_url text, arxiv_id text, abstract text) ON COMMIT DROP;
COPY stage_scoap3 FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
CREATE INDEX ON stage_scoap3 (lower(doi));
ANALYZE stage_scoap3;

-- pdf_url / arxiv_id: coalesce only (first writer wins; three lanes share them)
WITH u AS (
  UPDATE nsr SET pdf_url = coalesce(nsr.pdf_url, s.pdf_url),
                 arxiv_id = coalesce(nsr.arxiv_id, s.arxiv_id)
  FROM stage_scoap3 s
  WHERE lower(nsr.doi) = lower(s.doi)
    AND ((nsr.pdf_url IS NULL AND s.pdf_url IS NOT NULL)
      OR (nsr.arxiv_id IS NULL AND s.arxiv_id IS NOT NULL))
  RETURNING 1
) SELECT 'links_set: ' || count(*) FROM u;

-- abstract: fill NULLs and replace truncated APS-feed teasers only
WITH a AS (
  UPDATE nsr SET abstract = s.abstract
  FROM stage_scoap3 s
  WHERE lower(nsr.doi) = lower(s.doi)
    AND s.abstract IS NOT NULL AND s.abstract <> ''
    AND (nsr.abstract IS NULL OR nsr.abstract LIKE '%…')
  RETURNING 1
) SELECT 'abstracts_filled: ' || count(*) FROM a;
COMMIT;`, `write chunk ${i / CHUNK + 1}`);
    for (const line of out.trim().split("\n")) {
      const m = line.trim().match(/^(\w+):\s*(\d+)$/);
      if (m) totals[m[1]] = (totals[m[1]] ?? 0) + Number(m[2]);
    }
    console.log(`  chunk ${i / CHUNK + 1}: ${out.trim().replace(/\s+/g, " ")}`);
  }
  console.log("totals:", totals);
}

// ---------------------------------------------------------------- P4: PDFs

async function pdfs() {
  mkdirSync(PDF_DIR, { recursive: true });
  const { byDoi } = loadRecords();

  // which matched rows still need a stored PDF
  const rows = [...byDoi.keys()].map((d) => csvRow([d]));
  const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_scoap3_d (doi text) ON COMMIT DROP;
COPY stage_scoap3_d FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
CREATE INDEX ON stage_scoap3_d (doi);
ANALYZE stage_scoap3_d;
\\copy (SELECT n.key_number, lower(n.doi) FROM nsr n JOIN stage_scoap3_d s ON lower(n.doi) = s.doi WHERE n.pdf_stored IS NULL) TO STDOUT WITH (FORMAT csv)
COMMIT;`, "pdf targets");

  const targets = [];
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const i = line.lastIndexOf(",");
    const key = line.slice(0, i).replace(/^"|"$/g, "").replaceAll('""', '"');
    const doi = line.slice(i + 1);
    const rec = byDoi.get(doi);
    if (rec?.pdf) targets.push({ key, doi, urls: rec.pdfAll, path: `${PDF_DIR}/${sanitizeDoi(doi)}.pdf` });
  }
  console.log(`pdf targets: ${targets.length}`);
  if (!targets.length) return;

  const stored = [];
  let done = 0, failed = 0, skipped = 0, t0 = Date.now(), reported200 = false;

  const worker = async (queue) => {
    for (;;) {
      const t = queue.pop();
      if (!t) return;
      try {
        if (existsSync(t.path) && statSync(t.path).size > 1000) {
          skipped++; stored.push(t);
        } else {
          let buf = null, lastErr = null;
          for (const u of t.urls) {
            try {
              const res = await fetch(u, { signal: AbortSignal.timeout(PDF_TIMEOUT_MS) });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const b = Buffer.from(await res.arrayBuffer());
              if (b.length < 1000 || b.subarray(0, 4).toString() !== "%PDF") throw new Error(`not a pdf (${b.length}b)`);
              buf = b; break;
            } catch (e) { lastErr = e; }
          }
          if (!buf) throw lastErr ?? new Error("no pdf url");
          const fh = await open(t.path, "w");
          await fh.writeFile(buf);
          await fh.close();
          stored.push(t);
        }
      } catch (e) {
        failed++;
        if (failed <= 20) console.error(`  ${t.doi}: ${e.message}`);
      }
      done++;
      if (done === 200 && !reported200) {
        reported200 = true;
        const rate = 200 / ((Date.now() - t0) / 1000);
        console.log(`RATE after 200: ${rate.toFixed(1)} pdf/s → projected ${(targets.length / rate / 60).toFixed(0)} min for ${targets.length}`);
      }
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`  ${done}/${targets.length} (${failed} failed, ${skipped} already on disk) ${rate.toFixed(1)}/s`);
      }
      // flush pdf_stored in 1k batches
      if (stored.length >= 1000) await flushStored(stored.splice(0, stored.length));
    }
  };

  const queue = targets.slice().reverse();
  await Promise.all(Array.from({ length: PDF_CONCURRENCY }, () => worker(queue)));
  if (stored.length) await flushStored(stored);
  const rate = done / ((Date.now() - t0) / 1000);
  console.log(`downloaded ${done - failed}/${targets.length} (${failed} failed, ${skipped} pre-existing) at ${rate.toFixed(1)}/s`);
}

async function flushStored(batch) {
  const rows = batch.map((t) => csvRow([t.key, t.path]));
  const out = await psqlRetry(`BEGIN;
CREATE TEMP TABLE stage_scoap3_s (key_number text, path text) ON COMMIT DROP;
COPY stage_scoap3_s FROM STDIN WITH (FORMAT csv);
${rows.join("\n")}
\\.
WITH u AS (
  UPDATE nsr SET pdf_stored = coalesce(nsr.pdf_stored, s.path)
  FROM stage_scoap3_s s WHERE nsr.key_number = s.key_number AND nsr.pdf_stored IS NULL
  RETURNING 1
) SELECT 'stored_set: ' || count(*) FROM u;
COMMIT;`, "flush pdf_stored");
  console.log(`  ${out.trim().replace(/\s+/g, " ")}`);
}

// ---------------------------------------------------------------- P5: report

async function report() {
  const out = await psqlRetry(`SELECT count(pdf_url) AS pdf_urls, count(pdf_stored) AS pdfs_on_disk,
       count(abstract) AS abstracts FROM nsr;`, "report");
  console.log(out.trim());
}

// ---------------------------------------------------------------- main

const phase = process.argv[2];
const PHASES = { harvest, match, write, pdfs, report };
if (!PHASES[phase]) {
  console.error(`usage: node --env-file=.env.local scripts/ingest-scoap3.mjs <${Object.keys(PHASES).join("|")}>`);
  process.exit(1);
}
const started = Date.now();
await PHASES[phase]();
console.log(`${phase} done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
